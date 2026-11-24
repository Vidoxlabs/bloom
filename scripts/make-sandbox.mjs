// Make a throwaway sandbox for a live coding run: copy the demo repository into a new or empty
// folder, start a git repository there, and commit a baseline so the run's changes show as a diff.
// It refuses a folder that already holds files and any folder inside an existing git clone.
//
//   node scripts/make-sandbox.mjs <sandbox folder>
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const demoRepo = fileURLToPath(new URL('../test/fixtures/demo-repo/', import.meta.url));
const identity = { GIT_AUTHOR_NAME: 'bloom-sandbox', GIT_AUTHOR_EMAIL: 'bloom-sandbox',
  GIT_COMMITTER_NAME: 'bloom-sandbox', GIT_COMMITTER_EMAIL: 'bloom-sandbox' };

export class SandboxError extends Error {}

// The nearest folder at or above `path` that holds a .git entry, if any.
function enclosingClone(path) {
  for (let current = path; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return current;
    if (dirname(current) === current) return null;
  }
}

export function sandboxGit(sandbox, ...args) {
  return spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], {
    cwd: sandbox, encoding: 'utf8', env: { ...process.env, ...identity, GIT_PAGER: 'cat' },
  });
}

export function makeSandbox(folder) {
  const sandbox = resolve(folder);
  if (existsSync(sandbox) && readdirSync(sandbox).length) throw new SandboxError('Choose a new or empty sandbox folder.');
  if (enclosingClone(sandbox)) throw new SandboxError('Choose a sandbox folder that is not inside a git clone.');
  mkdirSync(sandbox, { recursive: true });
  cpSync(demoRepo, sandbox, { recursive: true });
  for (const step of [['init', '-q'], ['add', '-A'], ['commit', '-q', '--no-verify', '-m', 'Baseline']]) {
    if (sandboxGit(sandbox, ...step).status !== 0) throw new Error('git ' + step[0] + ' failed in the sandbox.');
  }
  return { sandbox, commit: sandboxGit(sandbox, 'rev-parse', '--short', 'HEAD').stdout.trim() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [folder, ...extra] = process.argv.slice(2);
  if (!folder || extra.length) {
    console.error('Usage: node scripts/make-sandbox.mjs <sandbox folder>');
    process.exit(2);
  }
  try {
    const { commit } = makeSandbox(folder);
    console.log('Sandbox ready: the demo project with a baseline commit ' + commit + '.');
  } catch (error) {
    console.error(error instanceof SandboxError ? error.message : 'Bloom could not make the sandbox.');
    process.exitCode = error instanceof SandboxError ? 2 : 1;
  }
}
