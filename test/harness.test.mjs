import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Harness } from '../src/harness.mjs';
import { Store } from '../src/store.mjs';

// A coding session runs on a pluggable runtime: run(input, hooks) streams events, asks for
// approvals and returns a stop reason. This scripted runtime stands in for a real one, so the
// harness is tested on its own contract rather than on any vendor's protocol.
function scriptedRuntime() {
  const seen = [];
  return {
    seen,
    id: 'scripted',
    label: 'Scripted runtime',
    async run(input, hooks) {
      seen.push({ nativeId: input.nativeId, model: input.model, prompt: input.prompt });
      if (input.prompt === 'Exit early') throw new Error('runtime exited');
      hooks.bind({ nativeId: input.nativeId ?? 'native-1', model: input.model ?? 'scripted/default',
        models: [{ id: 'scripted/default', label: 'Default' }], resumed: Boolean(input.nativeId) });
      hooks.emit('assistant.delta', { text: 'I will inspect the workspace.' });
      hooks.emit('plan.updated', { entries: [{ text: 'Read the README', status: 'in_progress' }] });
      const tool = { id: 'read-1', title: 'Read README', kind: 'read' };
      hooks.emit('tool.updated', { ...tool, status: 'pending' });
      const choice = await hooks.permission({ title: tool.title, kind: tool.kind, toolId: tool.id, options: [
        { id: 'yes', kind: 'allow_once', label: 'Allow once' },
        { id: 'no', kind: 'reject_once', label: 'Reject' },
        { id: 'always', kind: 'allow_always', label: 'Always allow' },
      ] });
      if (input.signal.aborted) return { stopReason: 'cancelled' };
      if (choice !== 'yes' && choice !== 'always') {
        hooks.emit('tool.updated', { ...tool, status: 'failed' });
        hooks.emit('assistant.delta', { text: ' The action was declined.' });
        return { stopReason: 'end_turn' };
      }
      hooks.emit('tool.updated', { ...tool, status: 'in_progress' });
      hooks.emit('tool.updated', { ...tool, status: 'completed' });
      hooks.emit('assistant.delta', { text: ' Done using ' + (input.model ?? 'scripted/default') + '.' });
      return { stopReason: 'end_turn' };
    },
  };
}

function setup(t) {
  const dataDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'vibloom-test-')));
  const runtime = scriptedRuntime();
  const runtimes = [];
  function open(adapters = [runtime]) {
    const store = new Store(dataDirectory);
    const harness = new Harness({ store, adapters, dataDirectory });
    const opened = { store, harness, async close() {
      await harness.close();
      store.close();
      this.closed = true;
    } };
    runtimes.push(opened);
    return opened;
  }
  t.after(async () => {
    for (const opened of runtimes.reverse()) if (!opened.closed) await opened.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  return { open, runtime };
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

test('streams plan and tools, binds approval to one pending request, and persists the turn', async t => {
  const { open } = setup(t);
  const { harness, store } = open();
  const session = harness.createSession({});
  const other = harness.createSession({});
  const { request, turnId } = await turnAwaitingApproval(harness, session.id, 'Read the README', 'scripted/second');

  const during = store.eventsAfter(session.id, 0);
  assert.equal(during.find(event => event.type === 'assistant.delta').data.text, 'I will inspect the workspace.');
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
  assert.equal(events.filter(event => event.type === 'assistant.delta').at(-1).data.text, ' Done using scripted/second.');
  assert.equal(store.getSession(session.id).native_id, 'native-1');
  assert.equal(store.getSession(session.id).model, 'scripted/second');
  assert.deepEqual(store.eventsAfter(other.id, 0), []);
});

test('hands the saved runtime session back after a restart and keeps the history', async t => {
  const { open, runtime } = setup(t);
  const original = open();
  const session = original.harness.createSession({ model: 'scripted/second' });
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
  assert.equal(runtime.seen.at(-1).nativeId, 'native-1');
  assert.equal(runtime.seen.at(-1).model, 'scripted/second');
  const tail = reopened.store.eventsAfter(session.id, cursor);
  assert.equal(tail.find(event => event.type === 'agent.connected').data.resumed, true);
  assert.equal(tail.filter(event => event.type === 'assistant.delta').at(-1).data.text, ' The action was declined.');
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

test('a runtime that throws ends the turn as failed with a generic message', async t => {
  const { open } = setup(t);
  const { harness } = open();
  const session = harness.createSession({});
  const done = eventual(harness, session.id, 'turn.finished');
  harness.start(session.id, { text: 'Exit early' });
  assert.deepEqual((await done).data, { status: 'failed', code: 'AGENT_ERROR', message: 'The agent could not finish this turn.' });
});

test('without a coding runtime, a coding session cannot be created and a saved one cannot run', async t => {
  const { open } = setup(t);
  const first = open();
  const session = first.harness.createSession({});
  await first.close();
  const bare = open([]);
  assert.deepEqual(bare.harness.info().adapters, []);
  assert.throws(() => bare.harness.createSession({}), { code: 'ADAPTER_UNKNOWN' });
  assert.throws(() => bare.harness.start(session.id, { text: 'Continue' }), { code: 'ADAPTER_UNAVAILABLE' });
});

test('records an orphaned turn as interrupted without retrying work', async t => {
  const { open, runtime } = setup(t);
  const opened = open();
  const session = opened.harness.createSession({});
  const { id } = opened.store.startTurn(session.id, 'Last prompt', null);
  opened.store.db.prepare('UPDATE turns SET owner_pid = 2147483647 WHERE id = ?').run(id);
  await opened.close();
  const reopened = open();
  const events = reopened.store.eventsAfter(session.id, 0);
  assert.deepEqual(events.map(event => event.type), ['user.message', 'turn.started', 'turn.finished']);
  assert.deepEqual(events.at(-1).data, { status: 'interrupted' });
  assert.equal(reopened.store.listSessions()[0].active, 0);
  assert.equal(reopened.harness.active.size, 0);
  assert.equal(runtime.seen.length, 0);
});
