import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { lstat, mkdtemp, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { workspaceToolPack } from '@vidoxlabs/drosera';
import { BloomError } from './errors.mjs';
import { workspacePath } from './harness.mjs';

const writes = new Map();
const temporaryPrefix = '.bloom-write-';
const testCommandMode = ['uncontained', 'test', 'only'].join('-');

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

function commandEnvironment(environment, home) {
  const env = { HOME: home };
  if (process.platform === 'win32') env.USERPROFILE = home;
  for (const name of ['PATH', 'LANG', 'TERM']) {
    if (typeof environment[name] === 'string') env[name] = environment[name];
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
} = {}) {
  if (commands !== 'disabled' && commands !== testCommandMode) {
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
        if (commands !== testCommandMode) {
          throw new BloomError('WORKSPACE_COMMAND_DISABLED',
            'Workspace commands stay disabled until command allowlisting and argument containment land.', 403);
        }
        const command = textArgument(args.command, 'command');
        const argv = args.args === undefined ? [] : args.args;
        if (!Array.isArray(argv) || !Array.from(argv).every(item => typeof item === 'string')) {
          throw invalidArgument('Provide command arguments as an array of strings.');
        }
        const home = await commandHome(root);
        try {
          return await runCommand(root, command, argv, commandEnvironment(environment, home), timeoutMs, capture, signal);
        } finally {
          await rm(home, { recursive: true, force: true, maxRetries: 3 });
        }
      }
      if (id === 'run.answer.create') {
        capture.append(textArgument(args.text, 'text', true));
        return capture.finish();
      }

      const requested = args.path === undefined && (id === 'workspace.dir.list' || id === 'workspace.text.search') ? '.' : args.path;
      const target = await canonicalTarget(root, requestedPath(root, requested), id === 'workspace.file.write');
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

  return Object.freeze({ pack: workspaceToolPack, execute });
}
