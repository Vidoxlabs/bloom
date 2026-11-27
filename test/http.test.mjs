import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { exportSession } from '../src/cli/session-io.mjs';
import { createCodingRuntime } from '../src/coding-loop.mjs';
import { endpointRedactor } from '../src/endpoint-privacy.mjs';
import { Harness } from '../src/harness.mjs';
import * as http from '../src/http.mjs';
import { Store } from '../src/store.mjs';
import { action, scriptedProvider } from './fixtures/demo-provider.mjs';

const { createHandler } = http;
const host = '127.0.0.1:4317';
const origin = 'http://' + host;
const [loopback, listenPort] = host.split(':');
// The same loopback address on another port: same site, different origin.
const otherOrigin = 'http://' + loopback + ':' + (Number(listenPort) + 1);
// The owner credential travels only in this request header. A cookie with the same value is
// what a browser would also send to every other port on the host, so it must not count.
const ownerHeader = 'x-bloom-owner';
const ownerCookie = 'bloom_owner_4317';
const absentId = '00000000-0000-4000-8000-000000000000';
const writeOptions = [
  { id: 'allow-once', kind: 'allow_once', label: 'Allow once' },
  { id: 'reject', kind: 'reject_once', label: 'Reject' },
];

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

// The owner credential from a launch response's JSON body, or '' when none was returned.
function launchCredential(response) {
  if (response?.status !== 200) return '';
  const body = typeof response.json === 'function' ? response.json() : JSON.parse(response.text);
  return typeof body.credential === 'string' ? body.credential : '';
}

// One request through a handler, as Node's server would deliver it.
async function dispatch(handler, url, { method = 'GET', headers, body, response = new Response() } = {}) {
  const bytes = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const request = Object.assign(Readable.from(bytes), {
    method, url, headers: { host, 'content-type': 'application/json', ...headers },
  });
  await handler(request, response);
  return response;
}

// A fixture adapter that asks one write question before it answers, so a decision has a target.
function askingAdapter(reply) {
  return {
    id: 'fixture', label: 'Fixture',
    async run({ model }, { bind, emit, permission }) {
      bind({ nativeId: 'test-runtime-native', model, models: [{ id: 'plain-model', label: 'Default' }] });
      const choice = await permission({ title: 'workspace.file.write  path=NOTE.txt', kind: 'write', toolId: 'workspace.file.write', options: writeOptions });
      emit('assistant.delta', { text: reply + ' (' + choice + ')' });
      return { stopReason: 'end_turn' };
    },
  };
}

async function setup(t, { redact, reply = 'Hello from the fixture.', ask = false, signedIn = true, owner = http.createOwnerChannel?.() } = {}) {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'vibloom-http-'));
  const store = new Store(dataDirectory, { redact });
  const harness = new Harness({
    dataDirectory, store,
    adapters: [ask ? askingAdapter(reply) : {
      id: 'fixture', label: 'Fixture',
      async run({ model }, { bind, emit }) {
        bind({ nativeId: 'test-runtime-native', model, models: [{ id: 'plain-model', label: 'Default' }] });
        emit('assistant.delta', { text: reply });
        return { stopReason: 'end_turn' };
      },
    }],
  });
  t.after(async () => {
    await harness.close();
    store.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  const handler = createHandler(harness, { owner });
  let credential = '';
  const send = (url, { anonymous = false, headers, ...options } = {}) =>
    dispatch(handler, url, { ...options, headers: { ...(credential && !anonymous ? { [ownerHeader]: credential } : {}), ...headers } });
  // Sign in as the owner's tab does: trade the one-time launch code for the owner credential.
  const code = owner?.launchCode() ?? null;
  const signIn = signedIn ? await send('/api/launch', { method: 'POST', headers: { origin }, body: { code }, anonymous: true }) : null;
  credential = launchCredential(signIn);
  return { send, harness, store, handler, owner, code, credential, signIn, dataDirectory, useCredential: value => { credential = value; } };
}

// Start a turn whose fixture asks one write question, and wait for that question.
async function pendingQuestion(send, harness) {
  const session = (await send('/api/sessions', { method: 'POST', body: {} })).json();
  const asked = new Promise(resolve => {
    const off = harness.subscribe(session.id, event => {
      if (event.type === 'permission.requested') { off(); resolve(event.data); }
    });
  });
  assert.equal((await send('/api/sessions/' + session.id + '/turns', { method: 'POST', body: { text: 'Write the note.' } })).status, 202);
  return { session, question: await asked };
}

function finishedTurn(harness, sessionId) {
  return new Promise(resolve => {
    const off = harness.subscribe(sessionId, event => {
      if (event.type === 'turn.finished') { off(); resolve(event.data); }
    });
  });
}

test('serves the browser assets and validates local API requests', async t => {
  const { send } = await setup(t);
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
  const { send, harness, store } = await setup(t);
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
  const { send } = await setup(t);
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
  const { send, harness } = await setup(t);
  const team = (await send('/api/teams', { method: 'POST', body: { name: 'Desk lead' } })).json();
  const fact = await send('/api/teams/' + team.id + '/notes', { method: 'POST', body: { confirmed: true, text: 'Baseline is 13.', kind: 'fact', shared: true } });
  assert.equal(fact.status, 201);
  assert.deepEqual([fact.json().kind, fact.json().shared], ['fact', true]);
  assert.equal((await send('/api/teams/' + team.id + '/notes', { method: 'POST', body: { confirmed: true, text: 'x', kind: 'odd' } })).json().code, 'TEAM_INPUT');
  const corrected = await send('/api/teams/' + team.id + '/notes/' + fact.json().id, { method: 'PUT', body: { confirmed: true, text: 'Baseline is 14.' } });
  assert.deepEqual([corrected.json().note.text, corrected.json().note.supersedes], ['Baseline is 14.', fact.json().id]);
  const { epoch } = harness.teams.store.require(team.id);
  for (const text of ['Keep me.', 'Drop me.']) harness.teams.store.propose(team.id, { text, source: 'Researcher', sourceFile: null, epoch });
  const [keep, drop] = (await send('/api/teams/' + team.id)).json().proposals;
  assert.equal((await send('/api/teams/' + team.id + '/suggestions/' + keep.id, { method: 'POST', body: { confirmed: true } })).json().text, 'Keep me.');
  assert.deepEqual((await send('/api/teams/' + team.id + '/suggestions/' + drop.id, { method: 'DELETE', body: {} })).json(), { dismissed: true });
  const detail = (await send('/api/teams/' + team.id)).json();
  assert.deepEqual(detail.notes.map(n => n.text), ['Keep me.', 'Baseline is 14.']);
  assert.deepEqual(detail.proposals, []);
});

test('note writes check origin and team presence before requiring literal confirmation', async t => {
  const { send, harness } = await setup(t);
  const absentId = '00000000-0000-4000-8000-000000000000';
  const absent = '/api/teams/' + absentId + '/notes';
  const crossOrigin = await send(absent, { method: 'POST', headers: { origin: 'null' }, body: {} });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.json().code, 'ORIGIN_MISMATCH');
  const missingTeam = await send(absent, { method: 'POST', body: {} });
  assert.equal(missingTeam.status, 404);
  assert.equal(missingTeam.json().code, 'TEAM_NOT_FOUND');
  const missingTurn = await send('/api/sessions/' + absentId + '/turns', { method: 'POST', body: { text: 'Check the draft.' } });
  assert.equal(missingTurn.status, 404);
  assert.equal(missingTurn.json().code, 'SESSION_NOT_FOUND');
  assert.equal(harness.active.size, 0);

  const team = (await send('/api/teams', { method: 'POST', body: {} })).json();
  const prefix = '/api/teams/' + team.id;
  const note = harness.teams.note(team.id, { text: 'Original note.' });
  const { epoch } = harness.teams.store.require(team.id);
  harness.teams.store.propose(team.id, { text: 'Draft note.', source: 'Researcher', sourceFile: null, epoch });
  const before = (await send(prefix)).json();
  const attempts = [
    ['/notes', 'POST', { text: 'New note.' }],
    ['/notes/' + note.id, 'PUT', { text: 'New wording.', confirmed: 'true' }],
    ['/notes/' + note.id, 'DELETE', { confirmed: false }],
    ['/suggestions/' + before.proposals[0].id, 'POST', {}],
  ];
  for (const [path, method, body] of attempts) {
    const response = await send(prefix + path, { method, body });
    assert.equal(response.status, 422, method + ' ' + path);
    assert.equal(response.json().code, 'CONFIRMATION_REQUIRED');
  }
  assert.deepEqual((await send(prefix)).json(), before);
  const forgotten = await send(prefix + '/notes/' + note.id, { method: 'DELETE', body: { confirmed: true } });
  assert.deepEqual(forgotten.json(), { forgotten: true });
  assert.deepEqual((await send(prefix)).json().notes, []);
});

test('configured addresses never reach the browser event stream or session title', async t => {
  const marker = 'bloom-browser-endpoint-canary';
  const address = 'https://' + marker + '.invalid/v1';
  const { send, harness, store } = await setup(t, { redact: endpointRedactor(address), reply: 'Echoed ' + address });
  const created = await send('/api/sessions', { method: 'POST', body: {} });
  const { id } = created.json();
  const url = '/api/sessions/' + id;
  const stream = await send(url + '/events');
  const finished = new Promise(resolve => {
    const unsubscribe = harness.subscribe(id, event => {
      if (event.type === 'turn.finished') {
        unsubscribe();
        resolve();
      }
    });
  });
  const started = await send(url + '/turns', { method: 'POST', body: { text: 'Inspect ' + address } });
  assert.equal(started.status, 202);
  await finished;
  const text = stream.chunks.join('');
  assert.match(text, /redacted endpoint/);
  assert.ok(!text.includes(marker));
  assert.ok(!JSON.stringify(store.eventsAfter(id, 0)).includes(marker));
  assert.ok(!(await send('/api/sessions')).chunks.join('').includes(marker));
  stream.end();
});

// Owner-channel authentication (ADR 0004). Loopback binding and the Host and Origin checks stay,
// but only the per-launch owner credential lets a request read sessions or settle approvals.

test('owner-channel-refuses-requests-without-the-credential', async t => {
  const { send, harness, store, credential } = await setup(t, { ask: true });
  const { session, question } = await pendingQuestion(send, harness);
  const prefix = '/api/sessions/' + session.id;
  const before = store.eventsAfter(session.id, 0).length;
  const refused = [
    ['no credential', {}],
    ['a wrong credential', { [ownerHeader]: 'A'.repeat(43) }],
    ['an empty header', { [ownerHeader]: '' }],
    ['the credential as a cookie', { cookie: ownerCookie + '=' + credential }],
    ['the credential as another port\'s cookie', { cookie: 'bloom_owner_4318=' + credential }],
    ['the credential as a bearer token', { authorization: 'Bearer ' + credential }],
  ];
  for (const [label, headers] of refused) {
    const listing = await send('/api/sessions', { headers, anonymous: true });
    assert.equal(listing.status, 401, 'listing, ' + label);
    assert.equal(listing.json().code, 'OWNER_REQUIRED');
    const events = await send(prefix + '/events', { headers, anonymous: true });
    assert.equal(events.status, 401, 'events, ' + label);
    assert.deepEqual(events.eventIds(), []);
    const decision = await send(prefix + '/permissions/' + question.id, {
      method: 'POST', headers, anonymous: true, body: { optionId: 'allow-once' },
    });
    assert.equal(decision.status, 401, 'decision, ' + label);
    for (const [path, method, body] of [
      ['/api/info', 'GET'], ['/api/sessions', 'POST', {}], [prefix + '/turns', 'POST', { text: 'Again.' }],
      [prefix + '/stop', 'POST', { turnId: absentId }], ['/api/teams', 'POST', {}], ['/api/personas', 'GET'],
    ]) {
      assert.equal((await send(path, { method, body, headers, anonymous: true })).status, 401, method + ' ' + path + ', ' + label);
    }
  }
  assert.equal(store.eventsAfter(session.id, 0).length, before);
  assert.ok(harness.active.get(session.id)?.permissions.has(question.id), 'the question is still pending');
  assert.equal(store.listSessions().length, 1);
  assert.match(credential, /^[\w-]{43}$/);
  const finished = finishedTurn(harness, session.id);
  assert.deepEqual((await send(prefix + '/permissions/' + question.id, { method: 'POST', body: { optionId: 'reject' } })).json(), { accepted: true });
  await finished;
});

test('owner-channel-refuses-credentials-from-an-earlier-launch', async t => {
  const first = await setup(t, { ask: true });
  const { session, question } = await pendingQuestion(first.send, first.harness);
  const prefix = '/api/sessions/' + session.id;
  // A restart makes a new channel over the same saved sessions.
  const nextOwner = http.createOwnerChannel?.();
  const next = createHandler(first.harness, { owner: nextOwner });
  const before = first.store.eventsAfter(session.id, 0).length;
  const stale = { [ownerHeader]: first.credential };
  assert.equal((await dispatch(next, '/api/sessions', { headers: stale })).status, 401);
  assert.equal((await dispatch(next, prefix + '/events', { headers: stale })).status, 401);
  assert.equal((await dispatch(next, prefix + '/permissions/' + question.id, {
    method: 'POST', headers: stale, body: { optionId: 'allow-once' },
  })).status, 401);
  // Neither a used code nor an unused code from another launch signs in.
  const unusedElsewhere = http.createOwnerChannel?.().launchCode();
  for (const code of [first.code, unusedElsewhere]) {
    const exchange = await dispatch(next, '/api/launch', { method: 'POST', headers: { origin }, body: { code } });
    assert.equal(exchange.status, 403);
    assert.equal(exchange.json().code, 'LAUNCH_CODE_INVALID');
    assert.equal(exchange.headers['set-cookie'], undefined);
  }
  assert.equal(first.store.eventsAfter(session.id, 0).length, before);
  assert.ok(first.harness.active.get(session.id)?.permissions.has(question.id));
  // The new launch's own code works, and its credential means nothing to the earlier launch.
  const fresh = await dispatch(next, '/api/launch', { method: 'POST', headers: { origin }, body: { code: nextOwner.launchCode() } });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers['set-cookie'], undefined);
  const nextCredential = launchCredential(fresh);
  assert.match(nextCredential, /^[\w-]{43}$/);
  assert.notEqual(nextCredential, first.credential);
  assert.equal((await dispatch(next, '/api/sessions', { headers: { [ownerHeader]: nextCredential } })).status, 200);
  assert.equal((await dispatch(first.handler, '/api/sessions', { headers: { [ownerHeader]: nextCredential } })).status, 401);
  const finished = finishedTurn(first.harness, session.id);
  assert.equal((await dispatch(next, prefix + '/permissions/' + question.id, {
    method: 'POST', headers: { [ownerHeader]: nextCredential }, body: { optionId: 'reject' },
  })).status, 200);
  await finished;
});

test('owner-channel-refuses-cross-origin-and-malformed-requests', async t => {
  const { send, harness, store, code, useCredential } = await setup(t, { ask: true, signedIn: false });
  const exchange = (headers, body = { code }, method = 'POST') => send('/api/launch', { method, headers, body, anonymous: true });
  const refusedExchanges = [
    ['no origin', {}],
    ['another port', { origin: otherOrigin }],
    ['opaque origin', { origin: 'null' }],
    ['cross-site fetch', { origin, 'sec-fetch-site': 'cross-site' }],
    ['same-site fetch', { origin, 'sec-fetch-site': 'same-site' }],
    ['text body', { origin, 'content-type': 'text/plain' }],
    ['malformed body', { origin }, '{'],
    ['array body', { origin }, [code]],
    ['numeric code', { origin }, { code: 123 }],
    ['missing code', { origin }, {}],
    ['longer code', { origin }, { code: code + 'x' }],
    ['shorter code', { origin }, { code: String(code).slice(1) }],
  ];
  for (const [label, headers, body] of refusedExchanges) {
    const response = await exchange(headers, body);
    assert.ok(response.status >= 400 && response.status < 500, label + ': ' + response.status);
    assert.equal(response.headers['set-cookie'], undefined, label);
  }
  const wrongMethod = await exchange({ origin }, undefined, 'GET');
  assert.ok(wrongMethod.status >= 400, 'GET exchange: ' + wrongMethod.status);
  assert.equal(wrongMethod.headers['set-cookie'], undefined);
  // None of those spent the code: the owner's tab still signs in with it, once.
  const signIn = await exchange({ origin, 'sec-fetch-site': 'same-origin' });
  assert.equal(signIn.status, 200);
  assert.equal(signIn.headers['set-cookie'], undefined);
  const credential = launchCredential(signIn);
  assert.match(credential, /^[\w-]{43}$/);
  useCredential(credential);
  assert.equal((await exchange({ origin })).status, 403);

  const { session, question } = await pendingQuestion(send, harness);
  const prefix = '/api/sessions/' + session.id;
  const decision = prefix + '/permissions/' + question.id;
  const before = store.eventsAfter(session.id, 0).length;
  const crossOrigin = [
    [decision, 'POST', { origin: otherOrigin }],
    [decision, 'POST', { origin: 'null' }],
    [decision, 'POST', { 'sec-fetch-site': 'same-site' }],
    ['/api/sessions', 'GET', { 'sec-fetch-site': 'cross-site' }],
    [prefix + '/events', 'GET', { 'sec-fetch-site': 'same-site' }],
  ];
  for (const [path, method, headers] of crossOrigin) {
    const response = await send(path, { method, headers, body: method === 'POST' ? { optionId: 'allow-once' } : undefined });
    assert.equal(response.status, 403, method + ' ' + path + ' ' + JSON.stringify(headers));
    assert.equal(response.json().code, 'ORIGIN_MISMATCH');
  }
  // A malformed header value is refused, and so is a valid credential that is not in the header.
  const malformed = [
    { [ownerHeader]: 'garbage' }, { [ownerHeader]: credential + 'x' }, { [ownerHeader]: credential.slice(0, -1) },
    { [ownerHeader]: credential.toUpperCase() }, { [ownerHeader]: 'Bearer ' + credential }, { [ownerHeader]: credential + ', ' + credential },
    { [ownerHeader]: '', cookie: ownerCookie + '=' + credential }, { [ownerHeader]: '', 'x-bloom-owner-credential': credential },
  ];
  for (const headers of malformed) {
    const response = await send(decision, { method: 'POST', headers, body: { optionId: 'allow-once' } });
    assert.equal(response.status, 401, 'headers ' + JSON.stringify(headers).replaceAll(credential, '<credential>'));
  }
  assert.equal((await send(decision, { method: 'POST', body: '{' })).status, 400);
  assert.equal((await send(decision, { method: 'POST', body: { optionId: 'allow-everything' } })).json().code, 'PERMISSION_UNKNOWN');
  assert.equal(store.eventsAfter(session.id, 0).length, before);
  assert.ok(harness.active.get(session.id)?.permissions.has(question.id), 'the question is still pending');
  const finished = finishedTurn(harness, session.id);
  assert.equal((await send(decision, { method: 'POST', body: { optionId: 'reject' } })).status, 200);
  await finished;
});

// A real loopback listener over the coding loop with a scripted model, for the reproduced chain.
async function liveChannel(t, replies) {
  const base = mkdtempSync(join(tmpdir(), 'vibloom-owner-'));
  const workspace = join(base, 'workspace');
  const dataDirectory = join(base, 'data');
  mkdirSync(workspace);
  mkdirSync(dataDirectory);
  const store = new Store(dataDirectory);
  const provider = scriptedProvider(replies);
  const runtime = createCodingRuntime({ provider, environment: { PATH: process.env.PATH } });
  const harness = new Harness({ store, dataDirectory, adapters: [runtime] });
  const owner = http.createOwnerChannel?.();
  const server = createServer(createHandler(harness, { owner }));
  await new Promise(resolve => server.listen(0, loopback, resolve));
  const { port } = server.address();
  const address = loopback + ':' + port;
  const streams = new Set();
  t.after(async () => {
    for (const stream of streams) stream.destroy();
    await harness.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(base, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  function call(method, path, { credential, headers = {}, body } = {}) {
    // Node sends a DELETE body without a length unless one is given, so always give one.
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = httpRequest({ host: loopback, port, method, path, headers: {
        host: address, 'content-type': 'application/json', ...(payload === undefined ? {} : { 'content-length': Buffer.byteLength(payload) }),
        ...(credential ? { [ownerHeader]: credential } : {}), ...headers,
      } }, response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text, json: () => JSON.parse(text) }));
      });
      request.on('error', reject);
      request.end(payload);
    });
  }
  async function signIn() {
    const response = await call('POST', '/api/launch', { headers: { origin: 'http://' + address }, body: { code: owner?.launchCode() ?? null } });
    return launchCredential(response);
  }
  function events(credential, sessionId, onEvent, { headers = {}, query = '' } = {}) {
    return new Promise((resolve, reject) => {
      const request = httpRequest({ host: loopback, port, path: '/api/sessions/' + sessionId + '/events' + query,
        headers: { host: address, ...(credential ? { [ownerHeader]: credential } : {}), ...headers } }, response => {
        streams.add(response);
        let buffer = '';
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          text += chunk;
          buffer += chunk;
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop();
          for (const block of blocks) {
            const data = block.split('\n').find(line => line.startsWith('data: '));
            if (data) onEvent(JSON.parse(data.slice(6)));
          }
        });
        resolve({ status: response.statusCode, text: () => text });
      });
      request.on('error', reject);
      request.end();
    });
  }
  return { base, workspace, dataDirectory, store, harness, provider, owner, port, address, call, signIn, events };
}

async function waitForFile(path, timeoutMs = 10_000) {
  const started = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for ' + path);
    await delay(25);
  }
  await delay(25);
  return readFileSync(path, 'utf8');
}

// Untrusted repository content: a build helper that records its environment and leaves a
// detached process behind, which then tries the owner's channel with no credential.
const helperSource = `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
writeFileSync('../child-env.json', JSON.stringify(process.env));
if (process.argv[2]) spawn(process.execPath, ['approver.mjs', ...process.argv.slice(2)], { detached: true, stdio: 'ignore' }).unref();
console.log('build ok');
`;
const approverSource = `import http from 'node:http';
import { writeFileSync } from 'node:fs';
const [address, session] = process.argv.slice(2);
const [hostname, port] = address.split(':');
setTimeout(() => process.exit(0), 8000).unref();
const call = (method, path, headers = {}, body) => new Promise(resolve => {
  const request = http.request({ host: hostname, port: Number(port), method, path,
    headers: { host: address, 'content-type': 'application/json', ...headers } }, response => {
    if (String(response.headers['content-type']).startsWith('text/event-stream')) { response.destroy(); resolve(response.statusCode); return; }
    response.resume();
    response.on('end', () => resolve(response.statusCode));
  });
  request.on('error', () => resolve(0));
  request.end(body === undefined ? undefined : JSON.stringify(body));
});
const report = {
  listing: await call('GET', '/api/sessions'),
  events: await call('GET', '/api/sessions/' + session + '/events'),
  decision: await call('POST', '/api/sessions/' + session + '/permissions/00000000-0000-4000-8000-000000000000', {}, { optionId: 'allow-once' }),
  launch: await call('POST', '/api/launch', { origin: 'http://' + address }, { code: 'guessed-launch-code' }),
};
writeFileSync('../approver.json', JSON.stringify(report));
process.exit(0);
`;

test('owner-channel-replays-the-reproduced-self-approval-chain', async t => {
  let channel;
  let sessionId;
  const target = 'NOT-APPROVED-BY-OWNER.txt';
  channel = await liveChannel(t, [
    () => action('workspace.shell.execute', { command: 'node', args: ['helper.mjs', channel.address, sessionId] }, 'I will run the build helper.'),
    () => action('workspace.file.write', { path: target, content: 'written after a non-owner approval\n' }, 'Now a note.'),
    () => action('run.answer.create', { text: 'done' }),
  ]);
  writeFileSync(join(channel.workspace, 'helper.mjs'), helperSource);
  writeFileSync(join(channel.workspace, 'approver.mjs'), approverSource);
  const credential = await channel.signIn();
  const decide = (id, optionId, value = credential, headers = {}) =>
    channel.call('POST', '/api/sessions/' + sessionId + '/permissions/' + id, { credential: value, headers, body: { optionId } });
  sessionId = (await channel.call('POST', '/api/sessions', { credential, body: { workspace: channel.workspace } })).json().id;
  const ownerAnswered = [];
  const nonOwner = {};
  const failures = [];
  let finished;
  const done = new Promise(resolve => { finished = resolve; });
  const stream = await channel.events(credential, sessionId, event => {
    if (event.type === 'turn.finished') finished(event.data);
    if (event.type !== 'permission.requested') return;
    void (async () => {
      if (event.data.toolId === 'workspace.shell.execute') {
        ownerAnswered.push(event.data.toolId);
        await decide(event.data.id, 'allow-once');
        return;
      }
      // The owner never answers the write. A non-owner who learned its id tries first.
      nonOwner.report = JSON.parse(await waitForFile(join(channel.base, 'approver.json')));
      nonOwner.direct = (await decide(event.data.id, 'allow-once', '')).status;
      nonOwner.forged = (await decide(event.data.id, 'allow-once', 'A'.repeat(43))).status;
      // The real credential, captured elsewhere and replayed as a cookie, as a browser would send it to any port.
      nonOwner.cookieReplay = (await decide(event.data.id, 'allow-once', '', { cookie: 'bloom_owner_' + channel.port + '=' + credential })).status;
      nonOwner.crossOrigin = (await decide(event.data.id, 'allow-once', credential, { origin: 'http://' + loopback + ':' + (channel.port + 1) })).status;
      nonOwner.ownerReject = (await decide(event.data.id, 'reject')).status;
    })().catch(error => failures.push(error));
  });
  assert.equal(stream.status, 200);
  assert.equal((await channel.call('POST', '/api/sessions/' + sessionId + '/turns', { credential, body: { text: 'Build the project and add a note.' } })).status, 202);
  const ending = await Promise.race([done, delay(20_000).then(() => ({ status: 'test-timeout' }))]);
  assert.deepEqual(failures, []);
  assert.equal(ending.status, 'finished');
  assert.deepEqual(ownerAnswered, ['workspace.shell.execute']);
  assert.equal(existsSync(join(channel.workspace, target)), false, 'fileWritten');
  assert.deepEqual(nonOwner.report, { listing: 401, events: 401, decision: 401, launch: 403 });
  assert.deepEqual([nonOwner.direct, nonOwner.forged, nonOwner.cookieReplay, nonOwner.crossOrigin, nonOwner.ownerReject], [401, 401, 401, 403, 200]);
  const history = channel.store.eventsAfter(sessionId, 0);
  const writeQuestion = history.find(event => event.type === 'permission.requested' && event.data.toolId === 'workspace.file.write');
  assert.deepEqual(history.filter(event => event.type === 'permission.resolved' && event.data.id === writeQuestion.data.id).map(event => event.data.kind),
    ['reject_once'], 'only the owner resolved the write');
  assert.equal(history.filter(event => event.type === 'permission.resolved').length, 2);
});

test('owner-channel-owner-completes-the-flow', async t => {
  const channel = await liveChannel(t, [
    action('workspace.file.write', { path: 'NOTES.md', content: 'Owner approved.\n' }, 'I will add the note.'),
    action('run.answer.create', { text: 'Added NOTES.md.' }),
  ]);
  const code = channel.owner?.launchCode();
  const exchange = () => channel.call('POST', '/api/launch', { headers: { origin: 'http://' + channel.address, 'sec-fetch-site': 'same-origin' }, body: { code } });
  const signIn = await exchange();
  assert.equal(signIn.status, 200);
  assert.equal(signIn.headers['set-cookie'], undefined);
  const credential = launchCredential(signIn);
  assert.match(credential, /^[\w-]{43}$/);
  const again = await exchange();
  assert.equal(again.status, 403);
  assert.equal(again.json().code, 'LAUNCH_CODE_INVALID');
  assert.deepEqual((await channel.call('GET', '/api/sessions', { credential })).json(), []);
  const session = (await channel.call('POST', '/api/sessions', { credential, body: { workspace: channel.workspace } })).json();
  assert.deepEqual((await channel.call('GET', '/api/sessions', { credential })).json().map(item => item.id), [session.id]);
  let finished;
  const done = new Promise(resolve => { finished = resolve; });
  const decisions = [];
  const stream = await channel.events(credential, session.id, event => {
    if (event.type === 'turn.finished') finished(event.data);
    if (event.type === 'permission.requested') {
      channel.call('POST', '/api/sessions/' + session.id + '/permissions/' + event.data.id, {
        credential, headers: { origin: 'http://' + channel.address, 'sec-fetch-site': 'same-origin' }, body: { optionId: 'allow-once' },
      }).then(response => decisions.push(response.json()), error => decisions.push(String(error)));
    }
  });
  assert.equal(stream.status, 200);
  assert.equal((await channel.call('POST', '/api/sessions/' + session.id + '/turns', { credential, body: { text: 'Add a note.' } })).status, 202);
  const ending = await Promise.race([done, delay(20_000).then(() => ({ status: 'test-timeout' }))]);
  assert.equal(ending.status, 'finished');
  assert.deepEqual(decisions, [{ accepted: true }]);
  assert.equal(readFileSync(join(channel.workspace, 'NOTES.md'), 'utf8'), 'Owner approved.\n');
  const resolved = channel.store.eventsAfter(session.id, 0).filter(event => event.type === 'permission.resolved');
  assert.deepEqual(resolved.map(event => event.data.kind), ['allow_once']);
  assert.match(stream.text(), /permission\.resolved/);
});

test('owner-channel-launch-returns-the-credential-and-sets-no-cookie', async t => {
  const { send, owner, code } = await setup(t, { signedIn: false });
  const signIn = await send('/api/launch', { method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin' }, body: { code }, anonymous: true });
  assert.equal(signIn.status, 200);
  // A cookie would also reach every other port on this host, so the launch sets none.
  assert.equal(signIn.headers['set-cookie'], undefined);
  assert.ok(!Object.keys(signIn.headers).some(name => name.toLowerCase() === 'set-cookie'));
  const body = signIn.json();
  assert.deepEqual(Object.keys(body).sort(), ['credential', 'owner']);
  assert.equal(body.owner, true);
  assert.match(body.credential, /^[\w-]{43}$/);
  assert.ok(owner.verify(body.credential));
  assert.equal((await send('/api/info', { anonymous: true, headers: { [ownerHeader]: body.credential } })).status, 200);
});

test('owner-channel-accepts-the-credential-only-from-its-header', async t => {
  const channel = await liveChannel(t, [action('run.answer.create', { text: 'done' })]);
  const exchange = await channel.call('POST', '/api/launch', { headers: { origin: 'http://' + channel.address }, body: { code: channel.owner?.launchCode() ?? null } });
  assert.equal(exchange.status, 200);
  // A head that still issues a cookie hands the credential there; read it so the replays below are real.
  const credential = launchCredential(exchange) || (String(exchange.headers['set-cookie']?.[0] ?? '').split(';')[0].split('=')[1] ?? '');
  assert.match(credential, /^[\w-]{43}$/);
  // Fixtures come straight from the harness, so this test does not depend on the credential's carrier.
  const session = channel.harness.createSession({ workspace: channel.workspace });
  const team = channel.harness.teams.create({ name: 'Desk lead' });
  const before = { sessions: channel.store.listSessions().length, events: channel.store.eventsAfter(session.id, 0).length };
  const s = '/api/sessions/' + session.id;
  const tm = '/api/teams/' + team.id;
  const routes = [
    ['GET', '/api/info'], ['GET', '/api/sessions'], ['POST', '/api/sessions', {}],
    ['POST', s + '/turns', { text: 'Again.' }], ['POST', s + '/stop', { turnId: absentId }],
    ['POST', s + '/permissions/' + absentId, { optionId: 'allow-once' }],
    ['POST', '/api/teams', { name: 'Other' }], ['GET', '/api/personas'], ['POST', '/api/personas', { name: 'Iris', charter: 'Find sources.' }],
    ['PUT', '/api/personas/' + absentId, { name: 'Iris' }], ['DELETE', '/api/personas/' + absentId, {}],
    ['GET', tm], ['POST', tm + '/sources', { text: 'A source.' }], ['POST', tm + '/notes', { confirmed: true, text: 'x' }],
    ['POST', tm + '/members', { personaId: absentId }], ['PUT', tm + '/notes/' + absentId, { confirmed: true, text: 'y' }],
    ['POST', tm + '/suggestions/' + absentId, { confirmed: true }], ['DELETE', tm + '/suggestions/' + absentId, {}],
    ['DELETE', tm + '/notes/' + absentId, { confirmed: true }], ['GET', tm + '/files/' + absentId], ['GET', tm + '/files/' + absentId + '?download'],
    ['GET', '/api/not-a-route'],
  ];
  const port = channel.port;
  const elsewhere = [
    ['a cookie named for this port', path => [path, { cookie: 'bloom_owner_' + port + '=' + credential }]],
    ['a cookie named for another port', path => [path, { cookie: 'bloom_owner_' + (port + 1) + '=' + credential }]],
    ['a plain cookie', path => [path, { cookie: ownerHeader + '=' + credential }]],
    ['a query parameter', path => [path + (path.includes('?') ? '&' : '?') + ownerHeader + '=' + credential, {}]],
    ['an owner query parameter', path => [path + (path.includes('?') ? '&' : '?') + 'owner=' + credential + '&credential=' + credential, {}]],
  ];
  const accepted = [];
  const attempt = (method, target, options) => channel.call(method, target, options).catch(error => ({ status: 'error ' + error.code, text: '{}' }));
  for (const [method, path, body] of routes) {
    for (const [label, place] of elsewhere) {
      const [target, headers] = place(path);
      const response = await attempt(method, target, { headers, body });
      if (response.status !== 401 || JSON.parse(response.text).code !== 'OWNER_REQUIRED') accepted.push(method + ' ' + path + ' with ' + label + ': ' + response.status);
    }
    if (body !== undefined) {
      const response = await attempt(method, path, { body: { ...body, credential, owner: credential, [ownerHeader]: credential } });
      if (response.status !== 401) accepted.push(method + ' ' + path + ' with body fields: ' + response.status);
    }
  }
  // The event stream, the route a captured cookie would most want, is refused on every carrier too.
  for (const [label, headers, query] of [
    ['a cookie named for this port', { cookie: 'bloom_owner_' + port + '=' + credential }, ''],
    ['a cookie named for another port', { cookie: 'bloom_owner_' + (port + 1) + '=' + credential }, ''],
    ['a plain cookie', { cookie: ownerHeader + '=' + credential }, ''],
    ['a cookie and a cursor', { cookie: 'bloom_owner_' + port + '=' + credential }, '?after=0'],
    ['a cookie and last-event-id', { cookie: 'bloom_owner_' + port + '=' + credential, 'last-event-id': '0' }, ''],
    ['a query parameter', {}, '?after=0&' + ownerHeader + '=' + credential],
    ['an owner query parameter', {}, '?owner=' + credential + '&credential=' + credential],
  ]) {
    const stream = await channel.events('', session.id, () => {}, { headers, query });
    if (stream.status !== 401) accepted.push('event stream with ' + label + ': ' + stream.status);
  }
  assert.deepEqual(accepted, []);
  assert.equal(channel.store.listSessions().length, before.sessions);
  assert.equal(channel.store.eventsAfter(session.id, 0).length, before.events);
  // The same credential in the header opens the same routes.
  assert.equal((await channel.call('GET', '/api/info', { credential })).status, 200);
  assert.equal((await channel.call('GET', '/api/sessions', { credential })).status, 200);
  assert.equal((await channel.call('GET', tm, { credential })).status, 200);
  const stream = await channel.events(credential, session.id, () => {}, { query: '?after=0' });
  assert.equal(stream.status, 200);
});

function filesUnder(directory) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

test('owner-channel-keeps-the-credential-out-of-records', async t => {
  const logged = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const originals = methods.map(name => console[name]);
  methods.forEach(name => { console[name] = (...args) => { logged.push(args.map(String).join(' ')); }; });
  t.after(() => methods.forEach((name, index) => { console[name] = originals[index]; }));
  const channel = await liveChannel(t, [
    action('workspace.shell.execute', { command: 'node', args: ['helper.mjs'] }, 'I will run the build helper.'),
    action('workspace.file.write', { path: 'NOTES.md', content: 'Owner approved.\n' }, 'I will add the note.'),
    action('run.answer.create', { text: 'Ran the helper and added NOTES.md.' }),
  ]);
  writeFileSync(join(channel.workspace, 'helper.mjs'), helperSource);
  const code = channel.owner?.launchCode() ?? 'no-launch-code';
  const signIn = await channel.call('POST', '/api/launch', { headers: { origin: 'http://' + channel.address }, body: { code } });
  const credential = launchCredential(signIn);
  assert.match(credential, /^[\w-]{43}$/);
  const session = (await channel.call('POST', '/api/sessions', { credential, body: { workspace: channel.workspace } })).json();
  let finished;
  const done = new Promise(resolve => { finished = resolve; });
  const stream = await channel.events(credential, session.id, event => {
    if (event.type === 'turn.finished') finished(event.data);
    if (event.type === 'permission.requested') {
      void channel.call('POST', '/api/sessions/' + session.id + '/permissions/' + event.data.id, { credential, body: { optionId: 'allow-once' } });
    }
  });
  await channel.call('POST', '/api/sessions/' + session.id + '/turns', { credential, body: { text: 'Build and add a note.' } });
  const ending = await Promise.race([done, delay(20_000).then(() => ({ status: 'test-timeout' }))]);
  assert.equal(ending.status, 'finished');
  let exported = '';
  exportSession(channel.store, channel.store.getSession(session.id), { write: text => { exported += text; } }, null, { exportedAt: 'fixed' });
  const childEnvironment = readFileSync(join(channel.base, 'child-env.json'), 'utf8');
  assert.ok(JSON.parse(childEnvironment).PATH, 'the command environment was captured');
  assert.ok(channel.provider.prompts.length >= 3, 'the model prompts were captured');
  const records = {
    events: JSON.stringify(channel.store.eventsAfter(session.id, 0)),
    traces: JSON.stringify(channel.store.eventsAfter(session.id, 0).filter(event => event.type === 'tool.updated' || event.type === 'model.call')),
    stream: stream.text(),
    logs: logged.join('\n'),
    exported,
    prompts: JSON.stringify(channel.provider.prompts),
    childEnvironment,
    listing: (await channel.call('GET', '/api/sessions', { credential })).text,
    info: (await channel.call('GET', '/api/info', { credential })).text,
  };
  for (const [name, text] of Object.entries(records)) {
    if (name !== 'logs') assert.ok(text.length > 0, name + ' is empty');
    assert.ok(!text.includes(credential), 'credential in ' + name);
    assert.ok(!text.includes(code), 'launch code in ' + name);
  }
  const files = filesUnder(channel.dataDirectory);
  assert.ok(files.length > 0);
  for (const file of files) {
    const bytes = readFileSync(file);
    assert.ok(!bytes.includes(credential), 'credential in data file ' + file.slice(channel.dataDirectory.length));
    assert.ok(!bytes.includes(code), 'launch code in data file ' + file.slice(channel.dataDirectory.length));
  }
  assert.equal(JSON.stringify(channel.owner ?? {}), '{}', 'the channel object exposes no fields');
});

// Ask the real launcher, over its own listener, the way the owner's tab does.
function loopbackCall(address, method, path, { credential, headers = {}, body } = {}) {
  const [hostname, port] = address.split(':');
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: hostname, port: Number(port), method, path, headers: {
      host: address, 'content-type': 'application/json', ...(credential ? { [ownerHeader]: credential } : {}), ...headers,
    } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('owner-channel-launch-link-signs-in-and-the-credential-is-never-printed', async t => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'vibloom-launch-'));
  const main = fileURLToPath(new URL('../src/main.mjs', import.meta.url));
  const child = spawn(process.execPath, [main, '--demo', '--port', '0', '--data-dir', dataDirectory], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const closed = new Promise(resolve => child.on('close', resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    rmSync(dataDirectory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  const started = Date.now();
  let link;
  while (!(link = /http:\/\/([^/\s]+)\/#launch=([\w-]+)/.exec(output))) {
    if (Date.now() - started > 10_000 || child.exitCode !== null) throw new Error('The launcher printed no launch link.');
    await delay(25);
  }
  const [, address, code] = link;
  assert.match(code, /^[\w-]{43}$/);
  // Without the code nothing opens; the printed code signs in once.
  assert.equal((await loopbackCall(address, 'GET', '/api/sessions')).status, 401);
  const signIn = await loopbackCall(address, 'POST', '/api/launch', { headers: { origin: 'http://' + address }, body: { code } });
  assert.equal(signIn.status, 200);
  assert.equal(signIn.headers['set-cookie'], undefined);
  const credential = launchCredential(signIn);
  assert.match(credential, /^[\w-]{43}$/);
  assert.equal((await loopbackCall(address, 'GET', '/api/sessions', { credential })).status, 200);
  assert.equal((await loopbackCall(address, 'GET', '/api/sessions', { headers: { cookie: 'bloom_owner_' + address.split(':')[1] + '=' + credential } })).status, 401);
  assert.equal((await loopbackCall(address, 'POST', '/api/launch', { headers: { origin: 'http://' + address }, body: { code } })).status, 403);
  child.kill();
  await closed;
  assert.ok(!output.includes(credential), 'the launcher printed the credential');
  assert.equal(output.split(code).length - 1, 1, 'the launcher printed the code once, in the link');
  const files = filesUnder(dataDirectory);
  assert.ok(files.length > 0);
  for (const file of files) {
    const bytes = readFileSync(file);
    assert.ok(!bytes.includes(credential), 'credential in data file ' + file.slice(dataDirectory.length));
    assert.ok(!bytes.includes(code), 'launch code in data file ' + file.slice(dataDirectory.length));
  }
});
