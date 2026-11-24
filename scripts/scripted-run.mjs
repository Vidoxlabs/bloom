// Dev only, not wired into bin: run the coding loop with the scripted provider in a fresh sandbox
// and finish with the sandbox's git diff. It never calls a model, reads no config file, and fails
// if anything reaches for the network.
//
//   node scripts/scripted-run.mjs <sandbox folder> [--yes]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { lineRenderer } from '../src/cli/render/line.mjs';
import { copyDemoRepo, openCodingSession } from '../test/fixtures/coding-session.mjs';
import { demoTask, scriptedProvider } from '../test/fixtures/demo-provider.mjs';

globalThis.fetch = () => { throw new Error('The scripted run reached for the network.'); };

const args = process.argv.slice(2);
const yes = args.includes('--yes');
const [folder] = args.filter(arg => arg !== '--yes');
if (!folder) {
  console.error('Usage: node scripts/scripted-run.mjs <sandbox folder> [--yes]');
  process.exit(2);
}
const sandbox = resolve(folder);
if (existsSync(sandbox) && readdirSync(sandbox).length) {
  console.error('Choose a new or empty sandbox folder.');
  process.exit(2);
}
mkdirSync(sandbox, { recursive: true });
copyDemoRepo(sandbox);
const git = (...gitArgs) => spawnSync('git', gitArgs, {
  cwd: sandbox, encoding: 'utf8',
  env: { ...process.env, GIT_PAGER: 'cat', GIT_AUTHOR_NAME: 'bloom-sandbox', GIT_AUTHOR_EMAIL: 'bloom-sandbox',
    GIT_COMMITTER_NAME: 'bloom-sandbox', GIT_COMMITTER_EMAIL: 'bloom-sandbox' },
});
for (const step of [['init', '-q'], ['add', '-A'], ['commit', '-q', '-m', 'Baseline']]) {
  const result = git(...step);
  if (result.status !== 0) {
    console.error('git ' + step[0] + ' failed in the sandbox.');
    process.exit(1);
  }
}

const dataDirectory = mkdtempSync(join(tmpdir(), 'bloom-scripted-'));
const input = createInterface({ input: process.stdin });
const lines = input[Symbol.asyncIterator]();
const nextLine = async () => (await lines.next()).value ?? null;
const renderer = lineRenderer({ stdout: process.stdout, nextLine });
const opened = openCodingSession({ dataDirectory, workspace: realpathSync(sandbox), provider: scriptedProvider() });
try {
  const choose = async request => {
    if (yes) return 'allow_once';
    const optionId = await renderer.prompt(request);
    return request.options.find(option => option.id === optionId)?.kind;
  };
  const { ending } = await opened.run(demoTask, choose, event => renderer.onEvent(event));
  git('add', '-A', '-N');
  process.stdout.write('\ngit diff in the sandbox:\n' + git('diff').stdout);
  process.exitCode = ending.status === 'finished' ? 0 : 1;
} finally {
  input.close();
  await opened.close();
  rmSync(dataDirectory, { recursive: true, force: true });
}
