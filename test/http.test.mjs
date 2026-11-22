import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { Harness } from '../src/harness.mjs';
import { createHandler } from '../src/http.mjs';
import { Store } from '../src/store.mjs';

const host = '127.0.0.1:4317';

class Response extends EventEmitter {
  headers = {};
  chunks = [];
  headersSent = false;
  writableEnded = false;
  backpressure = false;
  setHeader(key, value) { this.headers[key] = value; }
  writeHead(status, headers) {
    this.status = status;
    Object.assign(this.headers, headers);
    this.headersSent = true;
  }
  write(chunk) {
    this.chunks.push(String(chunk));
    return !this.backpressure;
  }
  end(chunk) {
    if (chunk != null) this.write(chunk);
    this.writableEnded = true;
    this.emit('close');
  }
  json() { return JSON.parse(this.chunks.join('')); }
  eventIds() { return this.chunks.flatMap(chunk => chunk.startsWith('id: ') ? [Number(chunk.split('\n')[0].slice(4))] : []); }
}

function setup(t) {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'vibloom-http-'));
  const store = new Store(dataDirectory);
  const harness = new Harness({
    dataDirectory, store,
    adapters: [{
      id: 'fixture', label: 'Fixture',
      async run({ model }, { bind, emit }) {
        bind({ nativeId: 'test-runtime-native', model, models: [{ id: 'plain-model', label: 'Default' }] });
        emit('assistant.delta', { text: 'Hello from the fixture.' });
        return { stopReason: 'end_turn' };
      },
    }],
  });
  t.after(async () => {
    await harness.close();
    store.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  const handler = createHandler(harness);
  async function send(url, { method = 'GET', headers, body, response = new Response() } = {}) {
    const bytes = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const request = Object.assign(Readable.from(bytes), {
      method, url, headers: {
        host, 'content-type': 'application/json', ...headers,
      },
    });
    await handler(request, response);
    return response;
  }
  return { send, harness, store };
}

test('serves the browser assets and validates local API requests', async t => {
  const { send } = setup(t);
  const page = await send('/');
  assert.equal(page.status, 200);
  assert.match(page.chunks.join(''), /<title>Bloom<\/title>/);
  assert.equal((await send('/app.js')).headers['content-type'], 'text/javascript; charset=utf-8');
  const metadata = await send('/api/info');
  assert.deepEqual(metadata.json().adapters, [{ id: 'fixture', label: 'Fixture' }]);
  const forbiddenHost = await send('/api/sessions', { headers: { host: 'other.example' } });
  assert.equal(forbiddenHost.json().code, 'LOCAL_HOST_REQUIRED');

  const forbiddenOrigin = await send('/api/sessions', {
    method: 'POST', body: {}, headers: { origin: 'https://other.example' },
  });
  assert.equal(forbiddenOrigin.json().code, 'ORIGIN_MISMATCH');
  const wrongType = await send('/api/sessions', {
    method: 'POST', body: {}, headers: { 'content-type': 'text/plain' },
  });
  assert.equal(wrongType.json().code, 'JSON_REQUIRED');
  const badWorkspace = await send('/api/sessions', { method: 'POST', body: { workspace: './relative' } });
  assert.equal(badWorkspace.json().code, 'WORKSPACE_INVALID');
  assert.deepEqual((await send('/api/sessions')).json(), []);
});

test('streams persisted events in order, resumes from Last-Event-ID, and keeps a slow client connected', async t => {
  const { send, harness, store } = setup(t);
  const created = await send('/api/sessions', { method: 'POST', body: { model: 'plain-model' } });
  assert.equal(created.status, 201);
  const session = created.json();
  const prefix = '/api/sessions/' + session.id;
  const response = new Response();
  const write = response.write.bind(response);
  // Apply backpressure to the first event while preserving the underlying connection.
  response.write = chunk => {
    if (String(chunk).startsWith('id: ') && response.eventIds().length === 0) response.backpressure = true;
    return write(chunk);
  };
  const stream = await send(prefix + '/events', { response });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers['content-type'], 'text/event-stream');
  assert.deepEqual(stream.eventIds(), []);

  const finished = new Promise(resolve => {
    const off = harness.subscribe(session.id, event => {
      if (event.type === 'turn.finished') {
        off();
        resolve(event);
      }
    });
  });
  assert.equal((await send(prefix + '/turns', { method: 'POST', body: { text: 'Hello' } })).status, 202);
  await finished;
  const history = store.eventsAfter(session.id, 0);
  assert.equal(history.find(event => event.type === 'agent.connected').data.model, 'plain-model');
  assert.deepEqual(stream.eventIds(), [history[0].seq]);
  assert.equal(stream.writableEnded, false);
  response.backpressure = false;
  response.emit('drain');
  assert.deepEqual(stream.eventIds(), history.map(event => event.seq));
  stream.end();
  assert.equal(harness.listeners.has(session.id), false);

  const resumed = await send(prefix + '/events', { headers: { 'last-event-id': String(history[1].seq) } });
  assert.deepEqual(resumed.eventIds(), history.slice(2).map(event => event.seq));
  resumed.end();
});

test('serves the persona library and recruits a persona onto a team', async t => {
  const { send } = setup(t);
  assert.deepEqual((await send('/api/personas')).json(), []);
  const created = await send('/api/personas', { method: 'POST', body: { name: 'Iris', charter: 'Find sources.', stage: 'research' } });
  assert.equal(created.status, 201);
  const iris = created.json();
  assert.equal((await send('/api/personas', { method: 'POST', body: { name: 'IRIS', charter: 'x', stage: 'review' } })).json().code, 'PERSONA_EXISTS');
  assert.equal((await send('/api/personas/' + iris.id, { method: 'PUT', body: { name: 'Iris', charter: 'Find primary sources.', stage: 'research', model: 'provider/fast' } })).json().model, 'provider/fast');
  const team = (await send('/api/teams', { method: 'POST', body: { name: 'Desk lead' } })).json();
  const recruited = await send('/api/teams/' + team.id + '/members', { method: 'POST', body: { persona: iris.id } });
  assert.equal(recruited.status, 200);
  assert.deepEqual(recruited.json().members.map(m => [m.name, m.charter, m.model]), [['Iris', 'Find primary sources.', 'provider/fast']]);
  assert.deepEqual((await send('/api/personas/' + iris.id, { method: 'DELETE', body: {} })).json(), { deleted: true });
  assert.equal((await send('/api/personas/' + iris.id, { method: 'DELETE', body: {} })).json().code, 'PERSONA_NOT_FOUND');
  assert.equal((await send('/api/teams/' + team.id)).json().members.length, 1);
});

test('serves note kinds, shared notes, Correct, and suggestion Keep and Dismiss', async t => {
  const { send, harness } = setup(t);
  const team = (await send('/api/teams', { method: 'POST', body: { name: 'Desk lead' } })).json();
  const fact = await send('/api/teams/' + team.id + '/notes', { method: 'POST', body: { text: 'Baseline is 13.', kind: 'fact', shared: true } });
  assert.equal(fact.status, 201);
  assert.deepEqual([fact.json().kind, fact.json().shared], ['fact', true]);
  assert.equal((await send('/api/teams/' + team.id + '/notes', { method: 'POST', body: { text: 'x', kind: 'odd' } })).json().code, 'TEAM_INPUT');
  const corrected = await send('/api/teams/' + team.id + '/notes/' + fact.json().id, { method: 'PUT', body: { text: 'Baseline is 14.' } });
  assert.deepEqual([corrected.json().note.text, corrected.json().note.supersedes], ['Baseline is 14.', fact.json().id]);
  const { epoch } = harness.teams.store.require(team.id);
  for (const text of ['Keep me.', 'Drop me.']) harness.teams.store.propose(team.id, { text, source: 'Researcher', sourceFile: null, epoch });
  const [keep, drop] = (await send('/api/teams/' + team.id)).json().proposals;
  assert.equal((await send('/api/teams/' + team.id + '/suggestions/' + keep.id, { method: 'POST', body: {} })).json().text, 'Keep me.');
  assert.deepEqual((await send('/api/teams/' + team.id + '/suggestions/' + drop.id, { method: 'DELETE', body: {} })).json(), { dismissed: true });
  const detail = (await send('/api/teams/' + team.id)).json();
  assert.deepEqual(detail.notes.map(n => n.text), ['Keep me.', 'Baseline is 14.']);
  assert.deepEqual(detail.proposals, []);
});
