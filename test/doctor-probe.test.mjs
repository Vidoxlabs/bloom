import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkModelProfile } from '@vidoxlabs/seed';

import { doctor } from '../src/cli/doctor.mjs';
import { codingConfig, createCodingRuntime } from '../src/coding-loop.mjs';
import { PROBE_MESSAGE, probeProvider } from '../src/probe.mjs';
import { profileKey, readProfile, writeProfile } from '../src/profile-store.mjs';

const marker = 'bloom-probe-endpoint-marker';
const base = 'https://' + marker + '.invalid/v1';
const plainStreams = () => {
  let text = '';
  return { stdin: { isTTY: false }, stdout: { isTTY: false, write: chunk => { text += chunk; } }, text: () => text };
};

function setup(t, provider = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'bloom-probe-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'config.json'), JSON.stringify({
    version: 1,
    providers: { lab: { kind: 'chat-completions', baseURL: base, locality: 'local', ...provider } },
    models: { aliases: [{ alias: 'fixture', backendModel: 'fixture-backend', workload: 'code' }], default: 'fixture' },
  }), { mode: 0o600 });
  return directory;
}

const sse = chunks => new Response(new ReadableStream({ start(controller) {
  const encoder = new TextEncoder();
  for (const chunk of chunks) controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk) + '\n\n'));
  controller.enqueue(encoder.encode('data: [DONE]\n\n'));
  controller.close();
} }), { headers: { 'content-type': 'text/event-stream' } });

// A fake server: the models list and one streamed completion. Every request is recorded.
function fakeServer({ models = [{ id: 'fixture-backend' }], list, completion } = {}) {
  const requests = [];
  const fetcher = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null,
      authorization: init.headers?.authorization ?? null });
    if (String(url).endsWith('/models')) return list ? list(init) : Response.json({ object: 'list', data: models });
    if (String(url).endsWith('/chat/completions')) {
      return completion ? completion(init) : sse([{ model: 'fixture-backend', choices: [{ delta: { content: 'OK' }, finish_reason: null }] }]);
    }
    return new Response('missing', { status: 404 });
  };
  return { fetcher, requests };
}

const target = { name: 'lab', base, baseURL: base, local: true, description: 'local, user-marked' };
const probe = (server, options = {}) => probeProvider({ provider: target, alias: 'fixture', backendModel: 'fixture-backend', fetcher: server.fetcher, ...options });
const check = (result, name) => result.checks.find(item => item.check === name);

test('bloom-doctor-probe-drives-prompt-config', async t => {
  const rich = fakeServer({ models: [{ id: 'other' }, { id: 'fixture-backend', context_length: 8192, capabilities: ['tools'] }] });
  const reported = await probe(rich);
  assert.equal(checkModelProfile(reported.profile).ok, true);
  assert.deepEqual(reported.profile.model, { value: 'fixture-backend', source: 'probed' });
  assert.deepEqual(reported.profile.contextLength, { value: 8192, source: 'reported' });
  assert.deepEqual(reported.profile.streaming, { value: true, source: 'probed' });
  assert.deepEqual(reported.profile.toolCalling, { value: true, source: 'reported' });
  assert.deepEqual(reported.profile.constrainedOutput, { value: null, source: 'unknown' });
  // The streaming check sends one fixed message and asks for one token.
  const sent = rich.requests.filter(request => request.method === 'POST');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, { model: 'fixture-backend', messages: [{ role: 'user', content: PROBE_MESSAGE }], max_tokens: 1, stream: true });
  assert.deepEqual(codingConfig(reported.profile), {
    promptStyle: 'fenced-json', promptChars: Math.floor(8192 * 3 * 0.75), budgetSource: 'reported',
    streaming: true, streamingSource: 'probed', constrainedOutput: false, toolCalling: 'reported',
  });

  // A server that answers in one piece and reports nothing else: budgets fall back, streaming is off.
  const plain = fakeServer({ completion: () => Response.json({ choices: [{ message: { content: 'OK' }, finish_reason: 'length' }] }) });
  const bare = await probe(plain);
  assert.deepEqual(bare.profile.streaming, { value: false, source: 'probed' });
  assert.deepEqual(codingConfig(bare.profile), {
    promptStyle: 'fenced-json', promptChars: 24_000, budgetSource: 'default',
    streaming: false, streamingSource: 'probed', constrainedOutput: false, toolCalling: 'unknown',
  });
  assert.deepEqual(codingConfig(null), {
    promptStyle: 'fenced-json', promptChars: 24_000, budgetSource: 'default',
    streaming: true, streamingSource: 'unknown', constrainedOutput: false, toolCalling: 'unknown',
  });

  // The stored profile is what a later coding runtime reads.
  const directory = setup(t);
  const key = profileKey('lab', 'fixture');
  writeProfile(directory, key, reported.profile);
  if (process.platform !== 'win32') assert.equal(statSync(join(directory, 'profiles.json')).mode & 0o777, 0o600);
  const stored = readProfile(directory, key);
  assert.deepEqual(stored, reported.profile);
  assert.equal(readProfile(directory, profileKey('lab', 'other')), null);
  assert.deepEqual(createCodingRuntime({ provider: { label: 'x', generate(_call) {} }, profile: stored }).config, codingConfig(reported.profile));
});

test('probe-unknown-never-pass', async () => {
  const failing = fakeServer({ completion: () => new Response('busy', { status: 503 }) });
  const result = await probe(failing);
  for (const slot of ['contextLength', 'toolCalling', 'constrainedOutput', 'streaming']) {
    assert.equal(result.profile[slot].source, 'unknown', slot);
    assert.equal(result.profile[slot].value, null, slot);
  }
  assert.equal(check(result, 'Context length').status, 'unknown');
  assert.equal(check(result, 'Tool calling').status, 'unknown');
  assert.equal(check(result, 'Constrained output').status, 'unknown');
  assert.equal(check(result, 'Streaming').status, 'unknown');
  assert.match(check(result, 'Streaming').detail, /http-503/);
  // Fields the server does not report never turn into a pass.
  const quiet = await probe(fakeServer({ models: [{ id: 'fixture-backend', owned_by: 'local' }] }));
  for (const name of ['Context length', 'Tool calling', 'Constrained output']) assert.equal(check(quiet, name).status, 'unknown', name);
  for (const item of [...result.checks, ...quiet.checks]) {
    if (/unknown/i.test(item.detail)) assert.notEqual(item.status, 'pass', item.check);
  }
  // A malformed stored profile reads as no profile at all.
  const directory = mkdtempSync(join(tmpdir(), 'bloom-probe-bad-'));
  try {
    writeFileSync(join(directory, 'profiles.json'), JSON.stringify({ version: 1, profiles: {
      'lab/fixture': { profile: { ...quiet.profile, contextLength: { value: 9000, source: 'unknown' } } },
    } }));
    assert.equal(readProfile(directory, 'lab/fixture'), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('probe-failure-reasons-and-exit-codes', async t => {
  const reasons = [
    ['refused', fakeServer({ list: () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); } })],
    ['tls', fakeServer({ list: () => { throw new TypeError('fetch failed', { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }); } })],
    ['http-401', fakeServer({ list: () => new Response('no', { status: 401 }) })],
    ['timeout', fakeServer({ list: init => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))) })],
  ];
  for (const [reason, server] of reasons) {
    const result = await probe(server, { timeouts: { list: 20, stream: 20 } });
    assert.equal(check(result, 'Reachability').status, 'fail', reason);
    assert.match(check(result, 'Reachability').detail, new RegExp('\\b' + reason + '\\b'), reason);
    assert.equal(result.profile.model.source, 'unknown');
    assert.equal(server.requests.filter(request => request.method === 'POST').length, 0, reason);
  }
  // A stream that opens and never sends a chunk times out, and streaming stays unknown.
  const stalled = fakeServer({ completion: init => new Response(new ReadableStream({ start(controller) {
    init.signal.addEventListener('abort', () => controller.error(init.signal.reason));
  } }), { headers: { 'content-type': 'text/event-stream' } }) });
  const slow = await probe(stalled, { timeouts: { list: 1000, stream: 20 } });
  assert.deepEqual(slow.profile.streaming, { value: null, source: 'unknown' });
  assert.match(check(slow, 'Streaming').detail, /\btimeout\b/);
  const missing = await probe(fakeServer({ models: [{ id: 'someone-else' }] }));
  assert.equal(check(missing, 'Model').status, 'fail');
  assert.equal(missing.profile.model.source, 'unknown');

  const directory = setup(t);
  const streams = plainStreams();
  const code = await doctor(directory, { probe: true }, { ...streams, fetcher: fakeServer({ models: [] }).fetcher });
  assert.equal(code, 1);
  assert.match(streams.text(), /fail {2}Model {2}/);
  const healthy = plainStreams();
  assert.equal(await doctor(directory, { probe: true }, { ...healthy, fetcher: fakeServer().fetcher }), 0);
  assert.match(healthy.text(), /unknown {2}Context length/);
  assert.match(healthy.text(), /pass {2}Profile {2}Saved for provider "lab" \(local, user-marked\), alias fixture\./);
});

test('probe-output-never-contains-endpoint-marker', async t => {
  const directory = setup(t);
  const leaky = fakeServer({
    models: [{ id: 'fixture-backend', root: base }, { id: marker + '.invalid-model' }],
    completion: () => sse([{ model: base, choices: [{ delta: { content: base }, finish_reason: null }] }]),
  });
  for (const json of [false, true]) {
    const streams = plainStreams();
    await doctor(directory, { probe: true, json }, { ...streams, fetcher: leaky.fetcher });
    assert.ok(!streams.text().toLowerCase().includes(marker), streams.text());
  }
  const failing = fakeServer({ list: () => { throw new TypeError('fetch failed ' + base, { cause: { code: 'ECONNREFUSED', message: base } }); } });
  const streams = plainStreams();
  await doctor(directory, { probe: true, json: true }, { ...streams, fetcher: failing.fetcher });
  assert.ok(!streams.text().toLowerCase().includes(marker), streams.text());
  assert.ok(!readFileSync(join(directory, 'profiles.json'), 'utf8').toLowerCase().includes(marker));
  // Without --probe, doctor sends nothing.
  const quiet = fakeServer();
  await doctor(directory, {}, { ...plainStreams(), fetcher: quiet.fetcher });
  assert.equal(quiet.requests.length, 0);
});

test('probe-sends-credential-only-when-given', async () => {
  const secret = 'probe-credential-value';
  const keyed = fakeServer();
  const result = await probe(keyed, { credential: secret });
  assert.deepEqual(keyed.requests.map(request => request.authorization), ['Bearer ' + secret, 'Bearer ' + secret]);
  assert.ok(!JSON.stringify(result).includes(secret));
  const open = fakeServer();
  await probe(open);
  assert.deepEqual(open.requests.map(request => request.authorization), [null, null]);
});
