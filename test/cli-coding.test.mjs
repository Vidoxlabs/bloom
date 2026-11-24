import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { copyDemoRepo } from './fixtures/coding-session.mjs';
import { action } from './fixtures/demo-provider.mjs';

const bin = fileURLToPath(new URL('../bin/bloom.mjs', import.meta.url));
const marker = 'bloom-cli-coding-endpoint-marker';
const base = 'https://' + marker + '.invalid/v1';

// A preloaded fetch that streams scripted replies, one per call, and counts its calls.
function streamingFetch(replies) {
  return 'data:text/javascript,' + encodeURIComponent(`
    const replies = ${JSON.stringify(replies)};
    let index = 0;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.stream !== true) throw new Error('expected a streamed request');
      const text = replies[index++] ?? replies.at(-1);
      const encoder = new TextEncoder();
      const chunks = [
        { model: 'fixture-backend', choices: [{ delta: { content: text.slice(0, 20) }, finish_reason: null }] },
        { model: '${marker}.invalid', choices: [{ delta: { content: text.slice(20) }, finish_reason: 'stop' }] },
      ];
      return new Response(new ReadableStream({ start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk) + '\\n\\n'));
        controller.enqueue(encoder.encode('data: [DONE]\\n\\n'));
        controller.close();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    };
  `);
}

function setup(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'bloom-cli-coding-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const data = join(directory, 'data');
  const workspace = copyDemoRepo(join(directory, 'workspace'));
  spawnSync(process.execPath, [bin, 'doctor', '--data-dir', data], { encoding: 'utf8' });
  writeFileSync(join(data, 'config.json'), JSON.stringify({
    version: 1,
    providers: { lab: { kind: 'chat-completions', baseURL: base, locality: 'local' } },
    models: { aliases: [{ alias: 'fixture', backendModel: 'fixture-backend', workload: 'code' }], default: 'fixture' },
  }), { mode: 0o600 });
  return { data, workspace };
}

test('cli-run-workspace-uses-coding-loop-and-never-writes', async t => {
  const { data, workspace } = setup(t);
  const replies = [
    action('workspace.file.read', { path: 'src/range.mjs' }, 'Reading the source.'),
    action('workspace.file.write', { path: 'NOTES.md', content: 'x\n' }),
    action('run.answer.create', { text: 'Read only, as asked.' }),
  ];
  const run = spawnSync(process.execPath, ['--import', streamingFetch(replies), bin, 'run', '--headless', 'Look around.',
    '--workspace', workspace, '--json', '--approve-policy', 'allow-read', '--data-dir', data], { encoding: 'utf8', timeout: 20_000 });
  const events = run.stdout.trim().split('\n').map(line => JSON.parse(line));
  const result = events.at(-1);
  assert.equal(result.type, 'run.result', run.stderr);
  assert.equal(result.status, 'finished');
  assert.equal(result.calls, 3);
  const rows = events.filter(event => event.type === 'tool.updated').map(event => [event.data.toolId, event.data.status]);
  assert.deepEqual(rows, [['workspace.file.read', 'completed'], ['workspace.file.write', 'refused'], ['run.answer.create', 'completed']]);
  assert.equal(existsSync(join(workspace, 'NOTES.md')), false);
  assert.ok(!run.stdout.toLowerCase().includes(marker));
  assert.ok(!run.stderr.toLowerCase().includes(marker));
  assert.doesNotMatch(run.stdout, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const last = join(data, 'last.txt');
  const again = spawnSync(process.execPath, ['--import', streamingFetch([action('run.answer.create', { text: 'Final words.' })]), bin, 'run',
    '--headless', 'Finish.', '--workspace', workspace, '--output-last-message', last, '--data-dir', data], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(last, 'utf8'), 'Final words.');
});

// A preloaded server that lists the model and answers completions in one piece, never streamed.
function plainFetch(replies) {
  return 'data:text/javascript,' + encodeURIComponent(`
    const replies = ${JSON.stringify(replies)};
    let index = 0;
    const seen = [];
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'fixture-backend', context_length: 4096 }] });
      const body = JSON.parse(init.body);
      seen.push(body.stream);
      if (body.max_tokens === 1) return Response.json({ choices: [{ message: { content: 'OK' }, finish_reason: 'length' }] });
      if (body.stream !== false) throw new Error('expected an unstreamed request after the probe');
      return Response.json({ model: 'fixture-backend', choices: [{ message: { content: replies[index++] ?? replies.at(-1) }, finish_reason: 'stop' }] });
    };
  `);
}

test('cli-doctor-probe-profile-drives-run', async t => {
  const { data, workspace } = setup(t);
  const probe = spawnSync(process.execPath, ['--import', plainFetch([]), bin, 'doctor', '--probe', '--json', '--data-dir', data],
    { encoding: 'utf8', timeout: 20_000 });
  assert.equal(probe.status, 0, probe.stderr + probe.stdout);
  const checks = Object.fromEntries(JSON.parse(probe.stdout).map(item => [item.check, item]));
  assert.equal(checks.Streaming.detail, 'no, probed');
  assert.equal(checks['Context length'].detail, '4096, reported');
  assert.ok(!probe.stdout.toLowerCase().includes(marker));
  const stored = JSON.parse(readFileSync(join(data, 'profiles.json'), 'utf8'));
  assert.deepEqual(Object.keys(stored.profiles), ['lab/fixture']);
  // The run reads the saved profile, so it asks for whole replies instead of a stream.
  const run = spawnSync(process.execPath, ['--import', plainFetch([action('run.answer.create', { text: 'Done.' })]), bin, 'run',
    '--headless', 'Finish.', '--workspace', workspace, '--json', '--data-dir', data], { encoding: 'utf8', timeout: 20_000 });
  const result = run.stdout.trim().split('\n').map(line => JSON.parse(line)).at(-1);
  assert.equal(result.status, 'finished', run.stderr);
});
