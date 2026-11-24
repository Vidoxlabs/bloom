import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, extname, isAbsolute, join, resolve, sep, win32 } from 'node:path';

import { BloomError } from './errors.mjs';
import { cancelled, invalidArgument, isOutside, textArgument } from './workspace-tool-utils.mjs';

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

export async function checkCommandRequest(root, args) {
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
export async function resolveCommand(root, searchPath, command) {
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

export async function executeWorkspaceCommand(root, args, { searchPath, environment, timeoutMs, capture, signal }) {
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
