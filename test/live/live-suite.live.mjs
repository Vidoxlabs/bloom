// Opt-in live tests against the owner's configured provider. Never part of npm test or CI.
// Run with: BLOOM_LIVE=1 npm run test:live
// Cloud providers also need BLOOM_LIVE_ALLOW_CLOUD=1.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { makeSandbox, sandboxGit } from '../../scripts/make-sandbox.mjs';
import { dataPath } from '../../src/data-dir.mjs';
import { readTerminalProvider, terminalSelection } from '../../src/cli/config.mjs';
import { selectProviders } from '../../src/cli/providers.mjs';
import { requireCloudFlag } from '../../src/live-cloud-flag.mjs';
import { probeProvider } from '../../src/probe.mjs';
import { openCodingSession } from '../fixtures/coding-session.mjs';
import { demoTask } from '../fixtures/demo-provider.mjs';

const live = process.env.BLOOM_LIVE === '1';
const dataDirectory = process.env.BLOOM_LIVE_DATA_DIR
  ? realpathSync(process.env.BLOOM_LIVE_DATA_DIR)
  : dataPath();

const skip = live ? undefined : 'Set BLOOM_LIVE=1 to run against your configured provider.';

function capture() {
  const lines = [];
  return {
    log(row) { lines.push(row); process.stdout.write(JSON.stringify(row) + '\n'); },
    text: () => lines.map(line => JSON.stringify(line)).join('\n'),
  };
}

function leakCheck(blob, provider, credential) {
  const host = (() => {
    try { return new URL(provider.baseURL).host; }
    catch { return provider.baseURL; }
  })();
  assert.ok(!blob.includes(provider.baseURL), 'configured base URL leaked');
  if (host) assert.ok(!blob.includes(host), 'configured host leaked');
  if (credential) assert.ok(!blob.includes(credential), 'configured credential leaked');
}

test('live-probe-passes', { skip }, async () => {
  const provider = readTerminalProvider(dataDirectory);
  assert.ok(provider, 'Configure a provider in the bloom data directory.');
  requireCloudFlag(provider);
  const selection = terminalSelection(provider);
  const { credential } = selectProviders({ ...provider, terminal: true });
  const result = await probeProvider({ provider, ...selection, credential });
  for (const row of result.checks) process.stdout.write(row.status + '  ' + row.check + '  ' + row.detail + '\n');
  for (const name of ['Reachability', 'Model', 'Streaming']) {
    assert.equal(result.checks.find(item => item.check === name)?.status, 'pass', name);
  }
  leakCheck(JSON.stringify(result.checks), provider, credential);
});

test('live-loop-fixes-sandbox', { skip }, async () => {
  const provider = readTerminalProvider(dataDirectory);
  assert.ok(provider, 'Configure a provider in the bloom data directory.');
  assert.ok(provider.local, 'live-loop-fixes-sandbox runs against a local provider only.');
  const selection = terminalSelection(provider);
  const { teamProvider, credential } = selectProviders({ ...provider, model: selection.backendModel, terminal: true });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bloom-live-')));
  const sandbox = join(root, 'sandbox');
  const storeDir = join(root, 'data');
  try {
    makeSandbox(sandbox);
    const opened = openCodingSession({
      dataDirectory: storeDir, workspace: sandbox, provider: teamProvider, model: selection.backendModel,
      runtime: { maxSteps: 18 },
    });
    const trace = capture();
    let calls = 0;
    const { events, ending } = await opened.run(demoTask, request => {
      const allowed = new Set([
        'workspace.dir.list', 'workspace.file.read', 'workspace.text.search',
        'workspace.file.write', 'workspace.file.update', 'workspace.shell.execute', 'run.answer.create',
      ]);
      if (!allowed.has(request.toolId)) return 'reject_once';
      return 'allow_once';
    }, event => {
      if (event.type === 'model.call') {
        calls += 1;
        assert.ok(calls <= 18, 'live loop exceeded the coding-session call budget');
      }
      if (event.type === 'model.call' || event.type === 'tool.updated' || event.type === 'turn.finished') {
        trace.log({ type: event.type, data: event.data });
      }
    });
    await opened.close();
    assert.equal(ending.status, 'finished');
    assert.ok(events.some(event => event.type === 'assistant.delta' && event.data.text));
    const types = events.map(event => event.type);
    assert.ok(types.includes('run.answer.create') || events.some(e => e.type === 'tool.updated' && e.data.toolId === 'run.answer.create'));
    assert.equal(types.at(-1), 'turn.finished');
    assert.ok(events.some(event => event.type === 'assistant.delta' && event.data.final));
    const status = sandboxGit(sandbox, 'status', '--porcelain', '--untracked-files=all');
    assert.equal(status.status, 0);
    assert.deepEqual(status.stdout.trimEnd().split(/\r?\n/).map(line => line.slice(3)).sort(),
      ['NOTES.md', 'src/range.mjs']);
    assert.equal(sandboxGit(sandbox, 'add', '--intent-to-add', '--', 'NOTES.md').status, 0);
    const diff = sandboxGit(sandbox, 'diff').stdout;
    assert.match(diff, /NOTES\.md/);
    assert.match(diff, /value <= end/);
    assert.doesNotMatch(diff, /package\.json/);
    leakCheck(trace.text() + diff, provider, credential);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('live-output-has-no-endpoint-or-key', { skip }, async () => {
  const provider = readTerminalProvider(dataDirectory);
  assert.ok(provider);
  requireCloudFlag(provider);
  const selection = terminalSelection(provider);
  const { credential } = selectProviders({ ...provider, terminal: true });
  const result = await probeProvider({ provider, ...selection, credential });
  leakCheck(JSON.stringify(result.checks) + JSON.stringify(result.profile ?? {}), provider, credential);
});
