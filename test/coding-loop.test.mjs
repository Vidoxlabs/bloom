import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';

import { exportSession } from '../src/cli/session-io.mjs';
import { lineRenderer } from '../src/cli/render/line.mjs';
import { createCodingRuntime } from '../src/coding-loop.mjs';
import { endpointRedactor } from '../src/endpoint-privacy.mjs';
import { createChatProvider } from '../src/models.mjs';
import { copyDemoRepo, openCodingSession } from './fixtures/coding-session.mjs';
import { action, demoReplies, demoTask, scriptedProvider, testCommand } from './fixtures/demo-provider.mjs';

const fixtureFile = new URL('./fixtures/demo-session.jsonl', import.meta.url);

function folders() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'bloom-loop-')));
  const workspace = copyDemoRepo(join(directory, 'workspace'));
  return { directory, dataDirectory: join(directory, 'data'), workspace };
}

async function withoutNetwork(t) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (...args) => { calls.push(args); throw new Error('The coding loop reached the network.'); };
  t.after(() => { globalThis.fetch = realFetch; });
  return calls;
}

async function session(t, options) {
  // Close the store before deleting the temp tree. After hooks run in registration
  // order; registering rm first left vibloom.sqlite open on Windows (EBUSY).
  const { directory, dataDirectory, workspace } = folders();
  const opened = openCodingSession({ dataDirectory, workspace, ...options });
  t.after(async () => {
    await opened.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return opened;
}

const rows = events => events.filter(event => event.type === 'tool.updated').map(event => event.data);
const exportText = (store, session) => {
  let text = '';
  const sink = { write: chunk => { text += chunk; } };
  exportSession(store, session, sink, undefined, { exportedAt: '2026-01-01T00:00:00.000Z' });
  return text;
};

test('coding-loop-fixes-fixture-offline', async t => {
  const network = await withoutNetwork(t);
  const provider = scriptedProvider();
  const opened = await session(t, { provider, stable: true });
  const asked = [];
  const { events, ending } = await opened.run(demoTask, request => { asked.push(request.toolId); return 'allow_once'; });
  assert.equal(ending.status, 'finished');
  assert.deepEqual(rows(events).map(row => [row.toolId, row.status]), [
    ['workspace.dir.list', 'completed'],
    ['workspace.file.read', 'completed'],
    ['workspace.text.search', 'completed'],
    ['workspace.file.write', 'completed'],
    ['workspace.shell.execute', 'failed'],
    ['workspace.file.update', 'completed'],
    ['workspace.shell.execute', 'completed'],
    ['run.answer.create', 'completed'],
  ]);
  assert.deepEqual(asked, ['workspace.file.write', 'workspace.shell.execute', 'workspace.file.update', 'workspace.shell.execute']);
  const shells = rows(events).filter(row => row.toolId === 'workspace.shell.execute');
  assert.deepEqual(shells.map(row => row.exitCode), [1, 0]);
  assert.match(shells[0].output, /not ok range includes both ends/);
  assert.match(shells[1].output, /pass 1 fail 0/);
  const types = events.map(event => event.type);
  assert.equal(types.at(-1), 'turn.finished');
  assert.ok(types.indexOf('assistant.delta') < types.indexOf('tool.updated'));
  assert.equal(events.filter(event => event.type === 'model.call').length, demoReplies.length);
  const final = events.filter(event => event.type === 'assistant.delta' && event.data.final);
  assert.equal(final.length, 1);
  assert.match(final[0].data.text, /fixed the off-by-one/);
  const { workspace } = opened.session;
  assert.match(readFileSync(join(workspace, 'src/range.mjs'), 'utf8'), /value <= end/);
  assert.match(readFileSync(join(workspace, 'NOTES.md'), 'utf8'), /^demo-repo is a tiny Node project/);
  assert.equal(network.length, 0);
});

test('demo-session-fixture-is-lf', () => {
  const bytes = readFileSync(fixtureFile);
  assert.equal(bytes.includes(0x0d), false, 'the recorded session must stay LF so Windows matches Unix');
});

test('demo-session-export-is-byte-stable', async t => {
  await withoutNetwork(t);
  const texts = [];
  for (let round = 0; round < 2; round += 1) {
    const opened = await session(t, { provider: scriptedProvider(), stable: true });
    await opened.run(demoTask);
    texts.push(exportText(opened.store, opened.session));
  }
  assert.equal(texts[0], texts[1]);
  assert.doesNotMatch(texts[0], /bloom-loop-|[/\\]tmp[/\\]|[/\\]var[/\\]folders/);
  if (process.env.BLOOM_UPDATE_FIXTURES === '1') writeFileSync(fixtureFile, texts[0]);
  assert.equal(texts[0], readFileSync(fixtureFile, 'utf8'));
});

test('coding-loop-finishes-via-run-answer-create', async t => {
  await withoutNetwork(t);
  const opened = await session(t, { provider: scriptedProvider([action('run.answer.create', { text: 'Nothing to change.' })]) });
  const { events, ending } = await opened.run('Say hello.');
  assert.equal(ending.status, 'finished');
  assert.deepEqual(rows(events).map(row => row.toolId), ['run.answer.create']);
  assert.equal(events.filter(event => event.type === 'assistant.delta' && event.data.final)[0].data.text, 'Nothing to change.');
  // Every generation passes seed's provider seam: a record outside the contract stops the turn.
  const broken = await session(t, { provider: { label: 'Broken', async generate(_call) { return { text: 'x', complete: 'yes', model: null, usage: null }; } } });
  const result = await broken.run('Say hello.');
  assert.equal(result.ending.status, 'failed');
  assert.equal(result.ending.code, 'PROVIDER_CONTRACT');
});

test('unadmitted-tool-rejected-before-execution', async t => {
  await withoutNetwork(t);
  const write = action('workspace.file.write', { path: 'NOTES.md', content: 'x' });
  const provider = scriptedProvider([write, write]);
  const opened = await session(t, { provider, runtime: { allowedTools: ['workspace.file.read', 'run.answer.create'] } });
  const { events, ending } = await opened.run('Write a note.', () => assert.fail('an unadmitted tool asked for approval'));
  assert.equal(ending.status, 'malformed');
  assert.equal(existsSync(join(opened.session.workspace, 'NOTES.md')), false);
  assert.equal(events.some(event => event.type === 'permission.requested'), false);
  assert.match(provider.prompts[1], /workspace\.file\.write is not an admitted tool/);
});

test('bloom-single-repair-turn-then-malformed', async t => {
  await withoutNetwork(t);
  const bad = action('workspace.file.update', { path: 'src/range.mjs', oldText: 'value < end' });
  const provider = scriptedProvider([bad, bad]);
  const opened = await session(t, { provider });
  const before = readFileSync(join(opened.session.workspace, 'src/range.mjs'), 'utf8');
  const { events, ending } = await opened.run('Fix the range.', () => assert.fail('an invalid call asked for approval'));
  assert.equal(ending.status, 'malformed');
  assert.equal(provider.prompts.length, 2, 'one repair turn, then stop');
  assert.match(provider.prompts[1], /\/newText/);
  assert.equal(readFileSync(join(opened.session.workspace, 'src/range.mjs'), 'utf8'), before);
  assert.deepEqual(rows(events), []);

  // Malformed replies share the same rule: no block, two blocks, unknown keys, bad JSON.
  for (const reply of ['No action here.', action('workspace.dir.list', {}) + '\n' + action('workspace.dir.list', {}),
    '```json\n{"tool":"workspace.dir.list","args":{},"extra":1}\n```', '```json\n{"tool":\n```']) {
    const replay = await session(t, { provider: scriptedProvider([reply, reply]) });
    assert.equal((await replay.run('List.')).ending.status, 'malformed', reply);
  }

  // A repaired reply runs, and the budget resets after a call that runs.
  const recovering = await session(t, { provider: scriptedProvider([
    bad, action('workspace.dir.list', {}), bad, action('run.answer.create', { text: 'Done.' }),
  ]) });
  assert.equal((await recovering.run('List.')).ending.status, 'finished');
});

test('output-validation-shares-repair-budget', async t => {
  await withoutNetwork(t);
  const provider = scriptedProvider([
    action('workspace.file.read', { path: 'src/range.mjs' }),
    action('workspace.file.update', { path: 'src/range.mjs' }),
  ]);
  const outputSchema = {
    type: 'object', additionalProperties: false, required: ['output'],
    properties: { output: { type: 'string', maxLength: 3 }, truncatedBytes: { type: 'integer' }, outputSha256: { type: 'string' } },
  };
  const opened = await session(t, { provider, runtime: { outputSchemas: { 'workspace.file.read': outputSchema } } });
  const { events, ending } = await opened.run('Read the source.');
  assert.equal(ending.status, 'malformed');
  assert.equal(provider.prompts.length, 2);
  assert.match(provider.prompts[1], /did not match its output schema/);
  assert.doesNotMatch(provider.prompts[1], /values\.push/, 'unvalidated output never reaches the model');
  assert.deepEqual(rows(events).map(row => [row.toolId, row.status]), [['workspace.file.read', 'invalid-output']]);
});

test('reject-is-never-executed', async t => {
  await withoutNetwork(t);
  const provider = scriptedProvider([
    action('workspace.file.write', { path: 'NOTES.md', content: 'note' }),
    action('workspace.shell.execute', { command: 'node', args: ['probe.mjs'] }),
    action('workspace.file.update', { path: 'src/range.mjs', oldText: 'value < end', newText: 'value <= end' }),
    action('run.answer.create', { text: 'Stopped.' }),
  ]);
  const opened = await session(t, { provider });
  const { workspace } = opened.session;
  writeFileSync(join(workspace, 'probe.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('ran.txt', 'ran');\n");
  const requests = [];
  const { events, ending } = await opened.run('Try writes.', request => { requests.push(request); return 'reject_once'; });
  assert.equal(ending.status, 'finished');
  assert.equal(existsSync(join(workspace, 'NOTES.md')), false);
  assert.equal(existsSync(join(workspace, 'ran.txt')), false);
  assert.match(readFileSync(join(workspace, 'src/range.mjs'), 'utf8'), /value < end/);
  assert.deepEqual(rows(events).map(row => row.status), ['denied', 'denied', 'denied', 'completed']);
  assert.ok(provider.prompts.slice(1).every(prompt => prompt.includes('denied by owner')));
  const shell = requests.find(request => request.toolId === 'workspace.shell.execute');
  assert.equal(shell.command, 'node');
  assert.deepEqual(shell.args, ['probe.mjs']);
  assert.match(shell.detail, /node\n.*"probe\.mjs"/s);
  assert.equal(shell.options.some(option => option.kind === 'allow_session'), false);
  const update = requests.find(request => request.toolId === 'workspace.file.update');
  assert.match(update.detail, /- value < end\n\+ value <= end/);
});

test('allow-session-binds-args-digest', async t => {
  await withoutNetwork(t);
  const same = action('workspace.file.write', { path: 'NOTES.md', content: 'one\n' });
  const provider = scriptedProvider([
    same, same, action('workspace.file.write', { path: 'NOTES.md', content: 'two\n' }),
    action('workspace.shell.execute', testCommand), action('workspace.shell.execute', testCommand),
    action('run.answer.create', { text: 'Done.' }),
  ]);
  const opened = await session(t, { provider });
  const asked = [];
  const { events } = await opened.run('Write notes.', request => {
    asked.push(request.toolId);
    return request.options.some(option => option.kind === 'allow_session') ? 'allow_session' : 'allow_once';
  });
  // The identical call runs on the session allowance; a changed argument asks again; commands always ask.
  assert.deepEqual(asked, ['workspace.file.write', 'workspace.file.write', 'workspace.shell.execute', 'workspace.shell.execute']);
  assert.equal(readFileSync(join(opened.session.workspace, 'NOTES.md'), 'utf8'), 'two\n');
  assert.equal(rows(events).filter(row => row.approval === 'session').length, 1);
  // The allowance lasts for the session, into the next turn, and binds the same digest.
  const next = scriptedProvider([same, action('run.answer.create', { text: 'Done.' })]);
  opened.runtime.provider = next;
  const later = [];
  await opened.run('Again.', request => { later.push(request.toolId); return 'allow_once'; });
  assert.deepEqual(later, []);
});

test('headless-never-writes', async t => {
  await withoutNetwork(t);
  const provider = scriptedProvider([
    action('workspace.file.read', { path: 'src/range.mjs' }),
    action('workspace.file.write', { path: 'NOTES.md', content: 'x' }),
    action('workspace.file.update', { path: 'src/range.mjs', oldText: 'value < end', newText: 'value <= end' }),
    action('workspace.shell.execute', testCommand),
    action('run.answer.create', { text: 'Read only.' }),
  ]);
  const opened = await session(t, { provider, headless: true });
  const { events, ending } = await opened.run('Fix it.', () => 'allow_once');
  assert.equal(ending.status, 'finished');
  assert.equal(events.some(event => event.type === 'permission.requested'), false);
  assert.deepEqual(rows(events).map(row => row.status), ['completed', 'refused', 'refused', 'refused', 'completed']);
  assert.equal(existsSync(join(opened.session.workspace, 'NOTES.md')), false);
  assert.match(readFileSync(join(opened.session.workspace, 'src/range.mjs'), 'utf8'), /value < end/);
});

test('trace-row-per-call-without-file-contents', async t => {
  await withoutNetwork(t);
  const opened = await session(t, { provider: scriptedProvider(), stable: true });
  const { events } = await opened.run(demoTask);
  const tools = rows(events);
  assert.equal(tools.length, demoReplies.length, 'one row per call');
  for (const row of tools) {
    assert.equal(typeof row.toolId, 'string');
    assert.equal(typeof row.summary, 'string');
    assert.ok(Number.isSafeInteger(row.durationMs) && row.durationMs >= 0, row.toolId);
    assert.ok(Number.isSafeInteger(row.bytes) || row.status !== 'completed', row.toolId);
    assert.doesNotMatch(row.summary, /values\.push|whole numbers between|value <= end/, row.toolId);
  }
  const summaries = Object.fromEntries(tools.map(row => [row.toolId, row.summary]));
  assert.equal(summaries['workspace.file.read'], 'path=src/range.mjs');
  assert.match(summaries['workspace.file.write'], /^path=NOTES\.md, \d+ bytes$/);
  assert.equal(summaries['workspace.shell.execute'], 'node --test --test-reporter=./reporter.mjs test/range.test.mjs');
  const calls = events.filter(event => event.type === 'model.call').map(event => event.data);
  assert.deepEqual(calls.map(call => call.call), demoReplies.map((_, index) => index + 1));
  assert.deepEqual(calls[0].usage, { input: 480, output: 24, total: 504, cacheRead: null, cacheWrite: null });
  assert.equal(calls[1].usage, null);

  let printed = '';
  const stdout = new Writable({ write(chunk, encoding, done) { printed += chunk; done(); } });
  const renderer = lineRenderer({ stdout });
  for (const event of events) renderer.onEvent(event);
  const lines = printed.split('\n');
  for (const toolId of ['workspace.dir.list', 'workspace.file.read', 'workspace.text.search', 'run.answer.create']) {
    assert.ok(lines.some(line => /^\d\d:\d\d:\d\d  /.test(line) && line.includes(toolId) && / \d+ ms$/.test(line)), toolId);
  }
  assert.ok(lines.some(line => line.includes('workspace.shell.execute') && line.includes('exit 1')));
  assert.ok(lines.some(line => / model  call 1 .* in 480, out 24$/.test(line)));
  assert.ok(lines.some(line => / model  call 2 .* usage unreported$/.test(line)));
  assert.doesNotMatch(printed, /values\.push/);
});

test('endpoint-marker-never-in-events-or-export', async t => {
  const marker = 'bloom-loop-endpoint-marker';
  const host = marker + '.invalid';
  const baseURL = 'https://' + host + '/v1';
  const replies = [
    action('workspace.file.write', { path: 'NOTES.md', content: 'Served from ' + host + '\n' }, 'I am talking to ' + host.toUpperCase() + '.'),
    action('run.answer.create', { text: 'Answered by https://' + host + '/v1 for you.' }),
  ];
  let index = 0;
  const encoder = new TextEncoder();
  const fetcher = async () => {
    const text = replies[index++];
    const half = Math.floor(text.length / 2);
    const chunks = [text.slice(0, half), text.slice(half)].map(content => ({ model: host, choices: [{ delta: { content }, finish_reason: null }] }));
    chunks.push({ model: host, choices: [{ delta: {}, finish_reason: 'stop' }] });
    return new Response(new ReadableStream({ start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk) + '\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const provider = createChatProvider({ baseURL, defaultModel: 'fixture-backend', fetcher, locality: 'local' });
  const opened = await session(t, { provider, redact: endpointRedactor(baseURL), model: 'fixture-backend' });
  const { events, ending } = await opened.run('Note where you run.');
  assert.equal(ending.status, 'finished');
  const everything = JSON.stringify(events) + exportText(opened.store, opened.session);
  assert.ok(!everything.toLowerCase().includes(marker), 'the endpoint marker reached an event or the export');
});

test('approval-runs-only-on-allow-choices', async t => {
  await withoutNetwork(t);
  const { directory, dataDirectory, workspace } = folders();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(workspace, 'NOTES.md'), 'before\n');
  const provider = scriptedProvider([
    action('workspace.file.write', { path: 'NOTES.md', content: 'after\n' }),
    action('run.answer.create', { text: 'Done.' }),
  ]);
  const runtime = createCodingRuntime({ provider, searchPath: join(process.execPath, '..') });
  const toolRows = [];
  const ending = await runtime.run(
    { workspace, model: 'scripted/coding', prompt: 'Write.', signal: AbortSignal.timeout(15_000) },
    {
      bind() {},
      emit(type, data) { if (type === 'tool.updated') toolRows.push(data); },
      permission: async () => 'always',
    },
  );
  assert.equal(ending.stopReason, 'end_turn');
  assert.equal(readFileSync(join(workspace, 'NOTES.md'), 'utf8'), 'before\n');
  assert.equal(toolRows[0]?.status, 'denied');
  assert.ok(!existsSync(join(dataDirectory, 'unused')));
});
