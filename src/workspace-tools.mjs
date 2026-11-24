import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, realpathSync } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { workspaceToolPack } from '@vidoxlabs/drosera';
import { BloomError } from './errors.mjs';
import { workspacePath } from './harness.mjs';

const writes = new Map();
const temporaryPrefix = '.bloom-write-';

// The one way to turn on workspace commands. Only the coding loop passes it; a guard test holds that.
export const workspaceCommandAccess = Symbol('bloom.workspace-command-access');

// The commands the owner approved, by exact name. Each one runs as a resolved executable, never
// through a shell, with interpreter evaluation and directory redirection refused.
export const ALLOWED_COMMANDS = Object.freeze(['node', 'npm', 'git']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'cmd', 'powershell', 'pwsh']);
const GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'add', 'commit']);
const REFUSED_FLAGS = {
  node: new Set([
    '-e', '--eval', '-p', '--print', '-r', '--require', '--import', '--input-type', '--loader',
    '--experimental-loader', '--run',
    '--inspect', '--inspect-brk', '--inspect-port', '--inspect-wait',
  ]),
  npm: new Set([
    '--prefix', '-C', '-g', '--global', '--location', '--script-shell', '--node-options',
    '--offline', '--no-offline', '--prefer-online', '--registry', '--userconfig', '--globalconfig',
    '--cache', '--proxy', '--https-proxy',
  ]),
  git: new Set(['-C', '--git-dir', '--work-tree', '-c', '--exec-path']),
};
const REFUSED_NPM_COMMANDS = new Set(['exec', 'x', 'explore', 'edit']);
const REFUSED_FLAG_REASON = {
  node: 'That node option evaluates code or loads modules.',
  npm: 'That npm option changes the registry, cache or online mode.',
  git: 'That git option redirects the repository or sets config.',
};
// npm's non-network redirect flags keep a separate reason from the network-flag set above.
const NPM_REDIRECT_FLAGS = new Set(['--prefix', '-C', '-g', '--global', '--location', '--script-shell', '--node-options']);
const NPM_REDIRECT_REASON = 'That npm option redirects the install or evaluates code.';

function invalidArgument(message) {
  return new BloomError('WORKSPACE_ARGUMENT_INVALID', message, 400);
}

function outsideWorkspace() {
  return new BloomError('WORKSPACE_PATH_OUTSIDE', 'The tool path must stay inside the workspace.', 400);
}

function cancelled() {
  return new BloomError('WORKSPACE_TOOL_CANCELLED', 'The workspace tool was cancelled.', 409);
}

function textArgument(value, name, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw invalidArgument(`Provide a valid ${name} argument.`);
  }
  return value;
}

function isOutside(root, target) {
  const suffix = relative(root, target);
  return suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix);
}

function requireInside(root, target) {
  if (isOutside(root, target)) throw outsideWorkspace();
  return target;
}

function requestedPath(root, value) {
  textArgument(value, 'path');
  if (isAbsolute(value) || win32.parse(value).root || value.split(/[\\/]/).includes('..') || value.includes('\0')) {
    throw outsideWorkspace();
  }
  return requireInside(root, resolve(root, value));
}

async function canonicalTarget(root, target, allowMissing = false) {
  try {
    return requireInside(root, await realpath(target));
  } catch (error) {
    if (!allowMissing || error.code !== 'ENOENT') throw error;
    const parent = requireInside(root, await realpath(dirname(target)));
    const candidate = join(parent, basename(target));
    try {
      await lstat(candidate);
    } catch (cause) {
      if (cause.code === 'ENOENT') return candidate;
      throw cause;
    }
    // A dangling link still occupies the path and may point outside the root.
    throw outsideWorkspace();
  }
}

async function fileInfo(target, allowMissing = false) {
  try {
    const info = await lstat(target);
    if (!info.isFile()) throw invalidArgument('Choose a regular workspace file.');
    return info;
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw error;
  }
}

function serializeWrite(target, operation) {
  const previous = writes.get(target) ?? Promise.resolve();
  const pending = previous.then(operation, operation);
  writes.set(target, pending);
  return pending.finally(() => {
    if (writes.get(target) === pending) writes.delete(target);
  });
}

async function replaceFile(root, target, contents, previousMode) {
  const temporary = join(dirname(target), temporaryPrefix + randomUUID());
  if (await canonicalTarget(root, target, true) !== target) throw outsideWorkspace();
  const handle = await open(temporary, 'wx');
  try {
    try {
      await handle.writeFile(contents, 'utf8');
      if (previousMode !== undefined) await handle.chmod(previousMode & 0o777);
    } finally {
      await handle.close();
    }
    if (await canonicalTarget(root, target, true) !== target) throw outsideWorkspace();
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

function captureOutput(limit) {
  const digest = createHash('sha256');
  const chunks = [];
  let kept = 0;
  let total = 0;
  return {
    append(text) {
      const bytes = Buffer.from(text);
      digest.update(bytes);
      total += bytes.length;
      const take = Math.min(bytes.length, limit - kept);
      if (take > 0) {
        chunks.push(Buffer.from(bytes.subarray(0, take)));
        kept += take;
      }
    },
    finish() {
      const output = new StringDecoder('utf8').write(Buffer.concat(chunks, kept));
      return {
        output,
        truncatedBytes: total - Buffer.byteLength(output),
        outputSha256: digest.digest('hex'),
      };
    },
  };
}

async function readLines(target, { startLine = 1, endLine }, capture) {
  if (!Number.isSafeInteger(startLine) || startLine < 1 ||
      (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < startLine))) {
    throw invalidArgument('Choose an inclusive range of positive line numbers.');
  }
  await fileInfo(target);
  let line = 1;
  for await (const chunk of createReadStream(target, { encoding: 'utf8' })) {
    if (startLine === 1 && endLine === undefined) {
      capture.append(chunk);
      continue;
    }
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf('\n', offset);
      const next = newline === -1 ? chunk.length : newline + 1;
      if (line >= startLine) capture.append(chunk.slice(offset, next));
      if (newline === -1) break;
      line += 1;
      if (endLine !== undefined && line > endLine) return;
      offset = next;
    }
  }
}

async function directoryEntries(target) {
  const entries = await readdir(target, { withFileTypes: true });
  return entries.filter(entry => !entry.name.startsWith(temporaryPrefix))
    .sort((left, right) => left.name < right.name ? -1 : Number(left.name > right.name));
}

async function* textLines(target) {
  let remainder = '';
  for await (const chunk of createReadStream(target, { encoding: 'utf8' })) {
    const parts = chunk.split('\n');
    parts[0] = remainder + parts[0];
    remainder = parts.pop();
    for (const part of parts) yield part.replace(/\r$/, '');
  }
  if (remainder) yield remainder;
}

async function searchText(root, target, query, capture) {
  const info = await lstat(target);
  if (info.isDirectory()) {
    for (const entry of await directoryEntries(target)) {
      if (!entry.isDirectory() && !entry.isFile()) continue;
      const path = join(target, entry.name);
      // Search linked paths only when explicitly named, so directory walks cannot loop.
      if (await canonicalTarget(root, path) === path) await searchText(root, path, query, capture);
    }
    return;
  }
  if (!info.isFile()) throw invalidArgument('Choose a workspace file or directory to search.');
  const path = relative(root, target).split(sep).join('/');
  let number = 0;
  for await (const line of textLines(target)) {
    number += 1;
    if (line.includes(query)) capture.append(`${path}:${number}:${line}\n`);
  }
}

function refuseCommand(message) {
  return new BloomError('WORKSPACE_COMMAND_REFUSED', message, 403);
}

// A path-like value: absolute, home-relative, parent-relative, drive or UNC rooted, or a file URL.
function escapesWorkspace(value) {
  return value.includes('\0') || isAbsolute(value) || Boolean(win32.parse(value).root) || /^[a-z]:/i.test(value) ||
    value.startsWith('~') || /^file:/i.test(value) || value.split(/[\\/]/).includes('..');
}

function flagParts(argument) {
  if (!argument.startsWith('-')) return { flag: null, value: argument };
  const split = argument.indexOf('=');
  if (split !== -1) return { flag: argument.slice(0, split), value: argument.slice(split + 1) };
  // Attached short-option values such as -O<path>, -C<path> or -r<path>.
  if (!argument.startsWith('--') && /^-[A-Za-z].+/.test(argument) && argument.length > 2) {
    return { flag: argument.slice(0, 2), value: argument.slice(2) };
  }
  return { flag: argument, value: null };
}

function refusedFlag(command, flag) {
  if (!flag) return false;
  if (REFUSED_FLAGS[command].has(flag)) return true;
  // npm expands unambiguous option prefixes; refuse any prefix of a refused long option.
  if (command === 'npm' && npmFlagMatchesRefused(flag)) return true;
  // Node accepts clustered short options such as -pe, so any cluster with e, p or r is refused.
  return command === 'node' && /^-[a-z]{2,}$/i.test(flag) && /[epr]/.test(flag.slice(1));
}

function npmFlagMatchesRefused(flag) {
  const lower = flag.toLowerCase();
  if (REFUSED_FLAGS.npm.has(lower) || NPM_REDIRECT_FLAGS.has(lower)) return true;
  if (!lower.startsWith('--') || lower.length < 3) return false;
  for (const refused of REFUSED_FLAGS.npm) {
    const name = refused.toLowerCase();
    if (name.startsWith('--') && name.startsWith(lower)) return true;
  }
  return false;
}

function refusedFlagReason(command, flag) {
  if (command === 'npm') {
    const lower = flag.toLowerCase();
    for (const refused of NPM_REDIRECT_FLAGS) {
      const name = refused.toLowerCase();
      if (lower === name || (lower.startsWith('--') && name.startsWith(lower))) return NPM_REDIRECT_REASON;
    }
  }
  return REFUSED_FLAG_REASON[command];
}

async function containedArgument(root, value) {
  if (escapesWorkspace(value)) throw refuseCommand('Command arguments must stay inside the workspace.');
  if (!value) return;
  // Resolve the nearest existing ancestor, so a new file under a linked folder is checked too.
  for (let probe = resolve(root, value); ; probe = dirname(probe)) {
    let resolved;
    try { resolved = await realpath(probe); }
    catch { if (dirname(probe) === probe) return; continue; }
    if (isOutside(root, resolved)) throw refuseCommand('Command arguments must stay inside the workspace.');
    return;
  }
}

// Plain path-segment check before any existence or realpath lookup, so .GIT and .Git
// refuse with the same reason on every filesystem.
function underDotGit(path) {
  if (typeof path !== 'string' || !path) return false;
  return path.split(/[\\/]/).some(part => part.toLowerCase() === '.git');
}

// After realpath: refuse when a resolved segment is .git (case-insensitive), a Windows
// trailing-dot/space variant, or an 8.3 short name such as GIT~1.
function normalizePathSegment(part) {
  return part.replace(/[.\s]+$/g, '').toLowerCase();
}

function underDotGitTarget(root, target) {
  const rel = relative(root, target);
  if (!rel || rel === '.') return false;
  return rel.split(/[\\/]/).some(part => {
    if (!part || part === '.') return false;
    if (normalizePathSegment(part) === '.git') return true;
    return /^git~\d+$/i.test(part);
  });
}

function refuseDotGit() {
  return new BloomError('WORKSPACE_DOT_GIT_REFUSED', 'Files under .git cannot be written.', 403);
}

async function checkCommandRequest(root, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw invalidArgument('Provide tool arguments as an object.');
  const command = textArgument(args.command, 'command', true);
  const argv = args.args === undefined ? [] : args.args;
  if (!Array.isArray(argv) || !Array.from(argv).every(item => typeof item === 'string')) {
    throw invalidArgument('Provide command arguments as an array of strings.');
  }
  if (/[\\/]/.test(command) || command.includes('..') || /^[a-z]:/i.test(command) || isAbsolute(command)) {
    throw refuseCommand('Name an allowed command without a path.');
  }
  if (SHELLS.has(command.toLowerCase())) throw refuseCommand('Shells are not allowed commands.');
  if (!ALLOWED_COMMANDS.includes(command)) throw refuseCommand('Only node, npm and git are allowed commands.');
  for (const argument of argv) {
    const { flag, value } = flagParts(argument);
    if (refusedFlag(command, flag)) throw refuseCommand(refusedFlagReason(command, flag));
    if (value !== null) await containedArgument(root, value);
  }
  if (command === 'npm' && REFUSED_NPM_COMMANDS.has(argv.find(item => !item.startsWith('-')))) {
    throw refuseCommand('npm exec, x, explore and edit are not allowed.');
  }
  if (command === 'git' && !GIT_SUBCOMMANDS.has(argv[0])) {
    throw refuseCommand('git is limited to status, diff, log, add and commit.');
  }
  const forwarded = [...argv];
  // Empty diff.external via GIT_CONFIG still invokes a blank program; force the builtin instead.
  if (command === 'git' && (forwarded[0] === 'diff' || forwarded[0] === 'log') && !forwarded.includes('--no-ext-diff')) {
    forwarded.splice(1, 0, '--no-ext-diff');
  }
  return { command, args: forwarded };
}

// Resolve an allowed name against the search path fixed when the tools were created. Relative
// entries and entries inside the workspace are skipped, so a planted file never runs instead.
async function resolveCommand(root, searchPath, command) {
  const names = process.platform === 'win32' ? [command + '.exe', command + '.cmd', command + '.bat'] : [command];
  for (const entry of String(searchPath ?? '').split(delimiter)) {
    if (!entry || !isAbsolute(entry)) continue;
    let directory;
    try { directory = await realpath(entry); }
    catch { continue; }
    if (!isOutside(root, directory)) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(candidate, constants.X_OK);
      } catch {
        continue;
      }
      if (process.platform === 'win32' && extname(name).toLowerCase() !== '.exe') {
        throw refuseCommand('That command needs a shell on this platform, so Bloom does not run it.');
      }
      return candidate;
    }
  }
  throw refuseCommand('The allowed command was not found on the fixed search path.');
}

async function commandHome(workspace) {
  const userHome = await realpath(homedir()).catch(() => null);
  if (userHome === null) throw commandFailed();
  const systemTemp = process.platform === 'win32'
    ? process.env.SystemRoot && join(process.env.SystemRoot, 'Temp')
    : join(sep, 'tmp');
  for (const candidate of new Set([tmpdir(), process.env.RUNNER_TEMP, systemTemp])) {
    if (!candidate || !isAbsolute(candidate)) continue;
    try {
      const root = await realpath(candidate);
      if (isOutside(workspace, root) && isOutside(userHome, root)) {
        return await mkdtemp(join(root, 'bloom-command-'));
      }
    } catch {
      // Try the next system scratch directory.
    }
  }
  throw commandFailed();
}

function commandEnvironment(environment, home, { hooksPath } = {}) {
  const env = { HOME: home };
  if (process.platform === 'win32') env.USERPROFILE = home;
  for (const name of ['PATH', 'LANG', 'TERM']) {
    if (typeof environment[name] === 'string') env[name] = environment[name];
  }
  // npm stays offline and quiet; git reads no system configuration and never prompts or pages.
  Object.assign(env, {
    npm_config_offline: 'true', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false',
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat',
  });
  if (hooksPath) {
    Object.assign(env, {
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'core.hooksPath',
      GIT_CONFIG_VALUE_1: hooksPath,
      GIT_CONFIG_KEY_2: 'core.pager',
      GIT_CONFIG_VALUE_2: 'cat',
    });
  }
  return env;
}

function commandFailed() {
  return new BloomError('WORKSPACE_COMMAND_FAILED', 'The workspace command could not run.', 400);
}

function runCommand(root, command, args, env, timeoutMs, capture, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    const grouped = process.platform !== 'win32';
    let child;
    try {
      child = spawn(command, args, {
        cwd: root, env, shell: false, detached: grouped, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      reject(commandFailed());
      return;
    }
    let settled = false;
    const finish = handle => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      handle();
    };
    function interrupt(timedOut) {
      finish(() => {
        try {
          if (child.pid) {
            if (grouped) process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          }
        } catch (error) {
          if (error.code !== 'ESRCH') {
            reject(commandFailed());
            return;
          }
        } finally {
          child.stdout.destroy();
          child.stderr.destroy();
        }
        if (timedOut) resolve({ ...capture.finish(), exitCode: null, timedOut: true });
        else reject(cancelled());
      });
    }
    const abort = () => interrupt(false);
    const timer = setTimeout(() => interrupt(true), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', capture.append);
    child.once('error', () => finish(() => reject(commandFailed())));
    child.once('close', exitCode => finish(() => resolve({ ...capture.finish(), exitCode, timedOut: false })));
  });
}

export function createWorkspaceTools(workspace, {
  outputLimitBytes = 32_768, timeoutMs = 15_000, environment = process.env, commands = 'disabled',
  searchPath = environment.PATH,
} = {}) {
  if (commands !== 'disabled' && commands !== workspaceCommandAccess) {
    throw invalidArgument('Choose a valid command mode.');
  }
  const validated = workspacePath(workspace);
  let root;
  try {
    // Match the native resolver used by node:fs/promises for tool paths.
    root = realpathSync.native(validated);
  } catch {
    throw new BloomError('WORKSPACE_UNAVAILABLE', 'Choose an accessible workspace directory.', 400);
  }
  if (!Number.isSafeInteger(outputLimitBytes) || outputLimitBytes < 0 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 0x7fffffff) {
    throw invalidArgument('Choose valid output and timeout limits.');
  }

  async function execute(id, args = {}, { signal } = {}) {
    if (!workspaceToolPack.has(id)) {
      throw new BloomError('WORKSPACE_TOOL_UNKNOWN', 'Choose a registered workspace tool.', 400);
    }
    if (signal?.aborted) throw cancelled();
    if (args === null || typeof args !== 'object' || Array.isArray(args)) throw invalidArgument('Provide tool arguments as an object.');
    const capture = captureOutput(outputLimitBytes);
    try {
      if (await realpath(root) !== root) throw new BloomError('WORKSPACE_CHANGED', 'The workspace directory changed.', 409);
      if (id === 'workspace.shell.execute') {
        if (commands !== workspaceCommandAccess) {
          throw new BloomError('WORKSPACE_COMMAND_DISABLED', 'Workspace commands are disabled outside the coding loop.', 403);
        }
        const request = await checkCommandRequest(root, args);
        const executable = await resolveCommand(root, searchPath, request.command);
        const home = await commandHome(root);
        let hooksPath;
        if (request.command === 'git') {
          hooksPath = join(home, 'bloom-git-hooks');
          await mkdir(hooksPath);
        }
        let result;
        try {
          result = await runCommand(
            root, executable, request.args, commandEnvironment(environment, home, { hooksPath }), timeoutMs, capture, signal,
          );
        } finally {
          try {
            await rm(home, { recursive: true, force: true, maxRetries: 3 });
          } catch {
            // Keep the command result and say the temporary home was left behind.
            if (result) result.homeCleanupFailed = true;
          }
        }
        return result;
      }
      if (id === 'run.answer.create') {
        capture.append(textArgument(args.text, 'text', true));
        return capture.finish();
      }

      const requested = args.path === undefined && (id === 'workspace.dir.list' || id === 'workspace.text.search') ? '.' : args.path;
      const writing = id === 'workspace.file.write' || id === 'workspace.file.update';
      if (writing && underDotGit(requested)) {
        throw refuseDotGit();
      }
      const target = await canonicalTarget(root, requestedPath(root, requested), id === 'workspace.file.write');
      if (writing && underDotGitTarget(root, target)) {
        throw refuseDotGit();
      }
      if (id === 'workspace.file.write' || id === 'workspace.file.update') {
        const update = id === 'workspace.file.update';
        await serializeWrite(target, async () => {
          if (signal?.aborted) throw cancelled();
          if (await canonicalTarget(root, target, !update) !== target) throw outsideWorkspace();
          const info = await fileInfo(target, !update);
          let contents;
          if (update) {
            const oldText = textArgument(args.oldText, 'oldText');
            const newText = textArgument(args.newText, 'newText', true);
            const source = await readFile(target, 'utf8');
            const index = source.indexOf(oldText);
            if (index === -1 || source.indexOf(oldText, index + 1) !== -1) {
              throw new BloomError('WORKSPACE_MATCH_NOT_UNIQUE', 'The existing text must match exactly once.', 409);
            }
            contents = source.slice(0, index) + newText + source.slice(index + oldText.length);
          } else {
            contents = textArgument(args.content, 'content', true);
          }
          if (signal?.aborted) throw cancelled();
          await replaceFile(root, target, contents, info?.mode);
        });
        capture.append(update ? 'File updated.\n' : 'File written.\n');
      } else if (id === 'workspace.dir.list') {
        for (const entry of await directoryEntries(target)) capture.append(entry.name + (entry.isDirectory() ? '/\n' : '\n'));
      } else if (id === 'workspace.text.search') {
        await searchText(root, target, textArgument(args.query, 'query'), capture);
      } else if (id === 'workspace.file.read') {
        await readLines(target, args, capture);
      } else {
        throw new BloomError('WORKSPACE_TOOL_UNKNOWN', 'Choose an implemented workspace tool.', 400);
      }
      return capture.finish();
    } catch (error) {
      if (error instanceof BloomError) throw error;
      if (error.code === 'ENOENT') throw new BloomError('WORKSPACE_PATH_MISSING', 'The workspace path does not exist.', 404);
      throw new BloomError('WORKSPACE_IO_FAILED', 'The workspace tool could not access the requested path.', 400);
    }
  }

  // Run the command gate without running anything, so a refusal comes before an approval prompt.
  async function checkCommand(args) {
    if (commands !== workspaceCommandAccess) {
      throw new BloomError('WORKSPACE_COMMAND_DISABLED', 'Workspace commands are disabled outside the coding loop.', 403);
    }
    const request = await checkCommandRequest(root, args);
    await resolveCommand(root, searchPath, request.command);
    return request;
  }

  return Object.freeze({ pack: workspaceToolPack, execute, checkCommand });
}
