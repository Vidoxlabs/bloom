// Dev only, not wired into bin: run the coding loop with the scripted provider in a fresh sandbox
// and finish with the sandbox's git diff. It never calls a model, reads no config file, and fails
// if anything reaches for the network.
//
//   node scripts/scripted-run.mjs <sandbox folder> [--yes]
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { lineRenderer } from '../src/cli/render/line.mjs';
import { openCodingSession } from '../test/fixtures/coding-session.mjs';
import { demoTask, scriptedProvider } from '../test/fixtures/demo-provider.mjs';
import { SandboxError, makeSandbox, sandboxGit } from './make-sandbox.mjs';

globalThis.fetch = () => { throw new Error('The scripted run reached for the network.'); };

const args = process.argv.slice(2);
const yes = args.includes('--yes');
const [folder] = args.filter(arg => arg !== '--yes');
if (!folder) {
  console.error('Usage: node scripts/scripted-run.mjs <sandbox folder> [--yes]');
  process.exit(2);
}
let sandbox;
try {
  ({ sandbox } = makeSandbox(folder));
} catch (error) {
  console.error(error instanceof SandboxError ? error.message : 'Bloom could not make the sandbox.');
  process.exit(error instanceof SandboxError ? 2 : 1);
}
const git = (...gitArgs) => sandboxGit(sandbox, ...gitArgs);

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
