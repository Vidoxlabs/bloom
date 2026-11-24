// Opt-in live tests against the owner's configured provider. Never part of npm test or CI.
// Run with: BLOOM_LIVE=1 npm run test:live
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeSandbox, sandboxGit } from '../../scripts/make-sandbox.mjs';
import { dataPath } from '../../src/data-dir.mjs';
import { readTerminalProvider, terminalSelection } from '../../src/cli/config.mjs';
import { selectProviders } from '../../src/cli/providers.mjs';
import { probeProvider } from '../../src/probe.mjs';
import { openCodingSession } from '../fixtures/coding-session.mjs';
import { demoTask } from '../fixtures/demo-provider.mjs';

const live = process.env.BLOOM_LIVE === '1';
const bin = fileURLToPath(new URL('../../bin/bloom.mjs', import.meta.url));
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

test('live-probe-passes', { skip }, async () => {
  const provider = readTerminalProvider(dataDirectory);
  assert.ok(provider, 'Configure a provider in the bloom data directory.');
  assert.ok(provider.local || process.env.BLOOM_LIVE_ALLOW_CLOUD === '1',
    'Cloud live probe needs BLOOM_LIVE_ALLOW_CLOUD=1 as well.');
  const selection = terminalSelection(provider);
  const { credential } = selectProviders({ ...provider, terminal: true });
  const result = await probeProvider({ provider, ...selection, credential });
  for (const row of result.checks) process.stdout.write(row.status + '  ' + row.check + '  ' + row.detail + '\n');
  for (const name of ['Reachability', 'Model', 'Streaming']) {
    assert.equal(result.checks.find(item => item.check === name)?.status, 'pass', name);
  }
  const printed = JSON.stringify(result.checks);
  assert.doesNotMatch(printed, /generativelanguage|googleapis|\/[Uu]sers\/|api[_-]?key|Bearer /i);
});

test('live-loop-fixes-sandbox', { skip }, async () => {
  const provider = readTerminalProvider(dataDirectory);
  assert.ok(provider, 'Configure a provider in the bloom data directory.');
  assert.ok(provider.local, 'live-loop-fixes-sandbox runs against a local provider only.');
  const selection = terminalSelection(provider);
  const { teamProvider } = selectProviders({ ...provider, model: selection.backendModel, terminal: true });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bloom-live-')));
  const sandbox = join(root, 'sandbox');
  const storeDir = join(root, 'data');
  try {
    makeSandbox(sandbox);
    const opened = openCodingSession({
      dataDirectory: storeDir, workspace: sandbox, provider: teamProvider, model: selection.backendModel,
    });
    const trace = capture();
    let calls = 0;
    const { events, ending } = await opened.run(demoTask, request => {
      // Allow only the expected tools inside the sandbox; reject anything else.
      const allowed = new Set([
        'workspace.dir.list', 'workspace.file.read', 'workspace.text.search',
        'workspace.file.write', 'workspace.file.update', 'workspace.shell.execute', 'run.answer.create',
      ]);
      if (!allowed.has(request.toolId)) return 'reject_once';
      return 'allow_once';
    }, event => {
      if (event.type === 'model.call') {
        calls += 1;
        assert.ok(calls <= 20, 'live loop exceeded 20 model calls');
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
    const diff = sandboxGit(sandbox, 'diff').stdout;
    assert.match(diff, /NOTES\.md/);
    assert.match(diff, /value <= end/);
    assert.doesNotMatch(diff, /package\.json/);
    assert.ok(!trace.text().match(/generativelanguage|\/[Uu]sers\/|Bearer /i));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('live-output-has-no-endpoint-or-key', { skip }, async () => {
  const provider = readTerminalProvider(dataDirectory);
  assert.ok(provider);
  const selection = terminalSelection(provider);
  const { credential } = selectProviders({ ...provider, terminal: true });
  const result = await probeProvider({ provider, ...selection, credential });
  const blob = JSON.stringify(result) + String(provider.baseURL) + String(credential ?? '');
  // The probe result must not echo the configured address or key; the comparison below plants markers only in memory.
  const planted = 'live-endpoint-marker-never-print';
  assert.ok(!JSON.stringify(result).includes(planted));
  assert.doesNotMatch(JSON.stringify(result.checks), /generativelanguage\.googleapis|[0-9]{1,3}(\.[0-9]{1,3}){3}|Bearer [A-Za-z0-9]/i);
});
