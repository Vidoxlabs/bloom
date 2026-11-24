import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeGeneration, validateProvider } from '@vidoxlabs/seed';

const bin = fileURLToPath(new URL('../bin/bloom.mjs', import.meta.url));

test('smoke-dataset-runs-offline-with-deterministic-evaluators', t => {
  const directory = mkdtempSync(join(tmpdir(), 'bloom-eval-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const counter = join(directory, 'requests');
  const preload = 'data:text/javascript,' + encodeURIComponent(
    'import { appendFileSync } from "node:fs"; globalThis.fetch = () => { appendFileSync('
    + JSON.stringify(counter) + ', "attempt"); throw Error("Unexpected request"); };',
  );
  const run = () => spawnSync(process.execPath, ['--import', preload, bin, 'eval', '--smoke'], {
    encoding: 'utf8', timeout: 20_000,
    env: { PATH: process.env.PATH, HOME: directory, USERPROFILE: directory },
  });
  const first = run();
  assert.equal(first.status, 0);
  const report = JSON.parse(first.stdout);
  assert.equal(report.passedCount, 1);
  assert.equal(report.failedCount, 0);
  assert.equal(report.networkRequests, 0);
  assert.deepEqual(report.events.map(event => event.type), [
    'eval.case.started', 'eval.case.finished', 'eval.report.written',
  ]);
  assert.equal(report.events[1].data.evaluators.length, 6);
  assert.ok(report.events[1].data.evaluators.every(item => item.passed));
  assert.equal(run().stdout, first.stdout);
  assert.throws(() => readFileSync(counter), { code: 'ENOENT' });
});

test('deterministic-evaluators-cover-exact-contains-schema-trajectory-files-tests', async () => {
  const { evaluateAssertions } = await import('../src/eval/evaluators.mjs');
  const observed = {
    text: 'Done.', value: { answer: 'Done.' }, trajectory: ['a', 'b'],
    files: { 'note.md': 'digest' }, testExitCodes: [1, 0],
  };
  for (const [kind, match, mismatch] of [
    ['exact', 'Done.', 'No.'],
    ['contains', 'Done', 'No.'],
    ['schema-valid', { type: 'object' }, { type: 'array' }],
    ['tool-trajectory', { ids: ['a', 'b'] }, { ids: ['b', 'a'] }],
    ['files-changed', { 'note.md': 'digest' }, { 'note.md': 'different' }],
    ['tests-pass', [1, 0], [0, 0]],
  ]) {
    assert.equal(evaluateAssertions([{ kind, expected: match }], observed).passed, true, kind);
    assert.equal(evaluateAssertions([{ kind, expected: mismatch }], observed).passed, false, kind);
  }
  assert.equal(evaluateAssertions([{ kind: 'tool-trajectory', expected: { ids: ['b', 'a'], ordered: false } }], observed).passed, true);
});

test('judge-output-always-labeled-and-never-sole-pass-criterion', async () => {
  const { evaluateAssertions } = await import('../src/eval/evaluators.mjs');
  const judge = { kind: 'misleading', score: 1, passed: true };
  const report = evaluateAssertions([{ kind: 'exact', expected: 'expected' }], { text: 'different' }, judge);
  assert.equal(report.passed, false);
  assert.equal(report.judge.kind, 'judge');
  assert.equal(evaluateAssertions([], { text: 'anything' }, judge).passed, false);
});

test('scripted-and-function-doubles-conform-to-seed-provider-seam', async () => {
  const { scriptedQueue, functionDouble } = await import('./helpers/model-doubles.mjs');
  for (const provider of [scriptedQueue(['Task'], 'fixture'), functionDouble(call => call.prompt, 'fixture')]) {
    assert.equal(validateProvider(provider).ok, true);
    assert.equal(normalizeGeneration(await provider.generate({ prompt: 'Task', model: 'fixture' })).generation.text, 'Task');
  }
});

test('offline-eval-refuses-attempts-before-fetch', async t => {
  const { runOfflineCases } = await import('../src/eval/offline.mjs');
  const transport = t.mock.method(globalThis, 'fetch', () => Promise.resolve('attempted'));
  const report = await runOfflineCases([{
    id: 'blocked-request',
    assertions: [{ kind: 'exact', expected: 'safe' }],
    async observe({ request }) {
      await request('https://example.invalid/fixture');
      return { text: 'safe' };
    },
  }]);
  assert.equal(report.networkRequests, 1);
  assert.equal(report.failedCount, 1);
  assert.equal(transport.mock.callCount(), 0);
});
