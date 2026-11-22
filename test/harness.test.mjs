import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Harness } from '../src/harness.mjs';
import { createOpenCodeAdapter } from '../src/opencode.mjs';
import { Store } from '../src/store.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url));

function setup(t, variant) {
  const dataDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'vibloom-test-')));
  const runtimes = [];
  const adapter = createOpenCodeAdapter({
    command: process.execPath, prefixArgs: variant ? [fixturePath, variant] : [fixturePath],
  });
  function open() {
    const store = new Store(dataDirectory);
    const harness = new Harness({ store, adapters: [adapter], dataDirectory });
    const runtime = { store, harness, async close() {
      await harness.close();
      store.close();
      this.closed = true;
    } };
    runtimes.push(runtime);
    return runtime;
  }
  t.after(async () => {
    for (const runtime of runtimes.reverse()) if (!runtime.closed) await runtime.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  return { open, dataDirectory };
}

function eventual(harness, sessionId, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('No ' + type + ' event'));
    }, 3000);
    const unsubscribe = harness.subscribe(sessionId, event => {
      if (event.type !== type) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

async function turnAwaitingApproval(harness, sessionId, text, model) {
  const approval = eventual(harness, sessionId, 'permission.requested');
  const { turnId } = harness.start(sessionId, { text, model });
  const event = await approval;
  assert.equal(event.turnId, turnId);
  return { turnId, request: event.data };
}

test('streams ACP plan and tools, binds approval to one pending request, and persists the turn', async t => {
  const { open } = setup(t);
  const { harness, store } = open();
  const session = harness.createSession({});
  const other = harness.createSession({});
  const { request, turnId } = await turnAwaitingApproval(harness, session.id, 'Read the README', 'fixture/second');

  const during = store.eventsAfter(session.id, 0);
  assert.equal(during.find(event => event.type === 'assistant.delta').data.text, 'I’ll inspect the workspace.');
  assert.equal(during.find(event => event.type === 'plan.updated').data.entries[0].status, 'in_progress');
  assert.equal(during.find(event => event.type === 'tool.updated').data.status, 'pending');
  assert.equal(during.some(event => event.type === 'turn.finished'), false);
  assert.equal(during.filter(event => event.type === 'permission.requested').length, 1);
  assert.equal(request.toolId, 'read-1');
  assert.deepEqual(request.options.map(option => [option.id, option.kind, option.label]), [
    ['yes', 'allow_once', 'Allow once'], ['no', 'reject_once', 'Reject'], ['always', 'allow_always', 'Always allow'],
  ]);
  assert.throws(() => harness.start(session.id, { text: 'Try again' }), { code: 'TURN_ACTIVE' });
  assert.throws(() => harness.decide(other.id, request.id, { optionId: 'yes' }), { code: 'PERMISSION_SETTLED' });
  assert.throws(() => harness.decide(session.id, request.id, { optionId: 'sometimes' }), { code: 'PERMISSION_UNKNOWN' });

  const done = eventual(harness, session.id, 'turn.finished');
  assert.deepEqual(harness.decide(session.id, request.id, { optionId: 'yes' }), { accepted: true });
  assert.throws(() => harness.decide(session.id, request.id, { optionId: 'yes' }), { code: 'PERMISSION_SETTLED' });
  assert.deepEqual((await done).data, { status: 'finished', reason: 'end_turn' });

  const events = store.eventsAfter(session.id, 0);
  assert.ok(events.every(event => event.turnId === turnId));
  assert.ok(events.every((event, index) => index === 0 || event.seq > events[index - 1].seq));
  assert.deepEqual(events.filter(event => event.type === 'tool.updated').map(event => event.data.status),
    ['pending', 'in_progress', 'completed']);
  assert.equal(events.filter(event => event.type === 'assistant.delta').at(-1).data.text, ' Done using fixture/second.');
  assert.doesNotMatch(JSON.stringify(events), /SENTINEL/);
  assert.equal(store.getSession(session.id).native_id, 'fixture-native-session');
  assert.equal(store.getSession(session.id).model, 'fixture/second');
  assert.deepEqual(store.eventsAfter(other.id, 0), []);
});

test('loads the existing ACP session in the same directory after restart and ignores replayed native messages', async t => {
  const { open } = setup(t);
  const original = open();
  const session = original.harness.createSession({ model: 'fixture/second' });
  const first = await turnAwaitingApproval(original.harness, session.id, 'Inspect the README');
  const firstDone = eventual(original.harness, session.id, 'turn.finished');
  original.harness.decide(session.id, first.request.id, { optionId: 'yes' });
  const cursor = (await firstDone).seq;
  await original.close();

  const reopened = open();
  const next = await turnAwaitingApproval(reopened.harness, session.id, 'Continue inspecting');
  const nextDone = eventual(reopened.harness, session.id, 'turn.finished');
  reopened.harness.decide(session.id, next.request.id, { optionId: 'no' });
  assert.equal((await nextDone).data.status, 'finished');
  assert.equal(reopened.store.getSession(session.id).workspace, session.workspace);
  const tail = reopened.store.eventsAfter(session.id, cursor);
  assert.equal(tail.find(event => event.type === 'agent.connected').data.resumed, true);
  assert.equal(tail.filter(event => event.type === 'assistant.delta').at(-1).data.text, ' The action was declined.');
  assert.doesNotMatch(JSON.stringify(tail), /NATIVE_HISTORY_SENTINEL/);
  assert.equal(reopened.store.eventsAfter(session.id, 0).filter(event => event.type === 'user.message').length, 2);
});

test('cancels the active prompt and closes its outstanding permission', async t => {
  const { open } = setup(t);
  const { harness, store } = open();
  const session = harness.createSession({});
  const { request, turnId } = await turnAwaitingApproval(harness, session.id, 'Inspect the README');
  assert.throws(() => harness.stop(session.id, { turnId: 'different-turn' }), { code: 'TURN_NOT_ACTIVE' });
  const done = eventual(harness, session.id, 'turn.finished');
  assert.deepEqual(harness.stop(session.id, { turnId }), { stopping: true });
  assert.deepEqual((await done).data, { status: 'stopped', reason: 'cancelled' });
  assert.throws(() => harness.decide(session.id, request.id, { optionId: 'yes' }), { code: 'PERMISSION_SETTLED' });
  const events = store.eventsAfter(session.id, 0);
  assert.ok(events.some(event => event.type === 'permission.resolved' && event.data.kind === 'cancelled'));
  assert.ok(events.some(event => event.type === 'turn.stopping'));
  assert.ok(!events.some(event => event.type === 'tool.updated' && event.data.status === 'completed'));
});

test('reports native agent exit and a model mismatch as distinct failed turns', async t => {
  const { open } = setup(t);
  const { harness, store } = open();
  const session = harness.createSession({});
  let done = eventual(harness, session.id, 'turn.finished');
  harness.start(session.id, { text: 'Exit early' });
  assert.equal((await done).data.code, 'AGENT_EXITED');

  done = eventual(harness, session.id, 'turn.finished');
  const { turnId } = harness.start(session.id, { text: 'Inspect the README', model: 'fixture/missing' });
  assert.equal((await done).data.code, 'MODEL_MISMATCH');
  const types = store.eventsAfter(session.id, 0).filter(event => event.turnId === turnId).map(event => event.type);
  assert.deepEqual(types, ['user.message', 'turn.started', 'agent.connected', 'turn.finished']);
});

test('selects a model through the legacy ACP method when only the legacy list is advertised', async t => {
  const { open } = setup(t, 'legacy');
  const { harness, store } = open();
  const session = harness.createSession({});
  const { request } = await turnAwaitingApproval(harness, session.id, 'Inspect the README', 'fixture/second');
  const done = eventual(harness, session.id, 'turn.finished');
  harness.decide(session.id, request.id, { optionId: 'yes' });
  assert.equal((await done).data.status, 'finished');
  const output = store.eventsAfter(session.id, 0).filter(event => event.type === 'assistant.delta').at(-1);
  assert.equal(output.data.text, ' Done using fixture/second.');
  assert.equal(store.getSession(session.id).model, 'fixture/second');
});

test('records an orphaned turn as interrupted without retrying work', async t => {
  const { open } = setup(t);
  const runtime = open();
  const session = runtime.harness.createSession({});
  const { id } = runtime.store.startTurn(session.id, 'Last prompt', null);
  runtime.store.db.prepare('UPDATE turns SET owner_pid = 2147483647 WHERE id = ?').run(id);
  await runtime.close();
  const reopened = open();
  const events = reopened.store.eventsAfter(session.id, 0);
  assert.deepEqual(events.map(event => event.type), ['user.message', 'turn.started', 'turn.finished']);
  assert.deepEqual(events.at(-1).data, { status: 'interrupted' });
  assert.equal(reopened.store.listSessions()[0].active, 0);
  assert.equal(reopened.harness.active.size, 0);
});
