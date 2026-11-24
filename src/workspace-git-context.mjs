import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextPath, deniedContextPath } from './workspace-context-files.mjs';

const unknown = reason => ({ status: 'unknown', reason });
const oid = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const refName = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._/-]{0,127}$/i.test(value) && !value.includes('..');

export function readGitContext(workspace, { git = 'git', execute = spawnSync, from, to } = {}) {
  const refs = from === undefined && to === undefined ? [] : [from, to];
  if (refs.some(ref => !refName(ref))) return unknown('invalid-ref');
  const config = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];
  let profile;
  const environment = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' };
  if (process.platform === 'win32') environment.SystemRoot = process.env.SystemRoot;
  const call = args => execute(git, [...config, ...args], {
    cwd: workspace, env: environment, encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 131_072,
  });
  const errorReason = result => {
    if (result.error?.code === 'ENOENT') return 'git-unavailable';
    if (result.error?.code === 'ETIMEDOUT') return 'git-timeout';
    if (result.error?.code === 'ENOBUFS') return 'git-output-limit';
    if (result.status !== 0 || typeof result.stdout !== 'string') return 'git-failed';
    return null;
  };
  try {
    profile = mkdtempSync(join(tmpdir(), 'bloom-git-context-'));
    environment.HOME = profile;
    environment.USERPROFILE = profile;
    environment.GIT_CONFIG_GLOBAL = join(profile, 'config');
    writeFileSync(environment.GIT_CONFIG_GLOBAL, '');
    const prefix = call(['rev-parse', '--show-prefix']);
    const prefixError = errorReason(prefix);
    if (prefixError) return unknown(prefixError);
    if (prefix.stdout.trim()) return unknown('not-repository-root');

    const changes = call(['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', ...refs, '--']);
    const changeError = errorReason(changes);
    if (changeError) return unknown(changeError);
    const history = call(['log', '-n', '20', '--format=%H', ...(refs.length ? [from + '..' + to] : []), '--']);
    const historyError = errorReason(history);
    if (historyError) return unknown(historyError);

    const fields = changes.stdout ? changes.stdout.replace(/\0$/, '').split('\0') : [];
    const log = history.stdout.trim().split(/\r?\n/).filter(Boolean);
    if (fields.length % 2 || log.some(id => !oid.test(id))) return unknown('invalid-output');
    const diff = [];
    for (let index = 0; index < fields.length; index += 2) {
      const [status, path] = fields.slice(index, index + 2);
      if (!/^[ADMTUXB]$/.test(status) || !contextPath(path)) return unknown('invalid-output');
      if (!deniedContextPath(path)) diff.push({ status, path });
    }
    return { status: 'known', diff, log };
  } catch {
    return unknown('git-failed');
  } finally {
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}
