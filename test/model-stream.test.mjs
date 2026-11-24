import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createChatProvider } from '../src/models.mjs';
import { adoptProvider } from '../src/provider.mjs';

const marker = 'bloom-stream-endpoint-marker';
const baseURL = 'https://' + marker + '.invalid/v1';
const encoder = new TextEncoder();

function sse(events, { hold = false } = {}) {
  let cancel;
  const body = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event === '[DONE]' ? 'data: [DONE]\n\n' : 'data: ' + JSON.stringify(event) + '\n\n'));
      }
      if (!hold) controller.close();
      cancel = () => controller.error(new DOMException('The operation was aborted.', 'AbortError'));
    },
  });
  return { response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }), cancel: () => cancel() };
}

const delta = (content, extra = {}) => ({ model: 'fixture-backend', choices: [{ index: 0, delta: { content }, finish_reason: null }], ...extra });
const finish = (reason, extra = {}) => ({ model: 'fixture-backend', choices: [{ index: 0, delta: {}, finish_reason: reason }], ...extra });

function provider(fetcher) {
  return adoptProvider(createChatProvider({ baseURL, defaultModel: 'fixture-backend', fetcher, locality: 'local' }));
}

test('stream-delivers-deltas-and-asks-for-a-stream', async () => {
  const requests = [];
  const chat = provider(async (url, init) => {
    requests.push(JSON.parse(init.body));
    return sse([delta('Hel'), delta('lo.'), finish('stop'), '[DONE]']).response;
  });
  const deltas = [];
  const record = await chat.generate({ system: 's', prompt: 'p', model: 'fixture-backend', signal: new AbortController().signal, onDelta: text => deltas.push(text) });
  assert.equal(requests[0].stream, true);
  assert.equal(deltas.join(''), 'Hello.');
  assert.equal(record.text, 'Hello.');
  assert.equal(record.complete, true);
  assert.equal(record.model, 'fixture-backend');
});

test('stream-complete-only-on-stop', async () => {
  for (const [events, complete] of [
    [[delta('Cut'), finish('length'), '[DONE]'], false],
    [[delta('No reason'), '[DONE]'], false],
    [[delta('Closed early')], false],
    [[delta('Tool'), finish('tool_calls'), '[DONE]'], false],
    [[delta('Done'), finish('stop'), '[DONE]'], true],
  ]) {
    const chat = provider(async () => sse(events).response);
    const record = await chat.generate({ system: 's', prompt: 'p', model: 'fixture-backend', signal: new AbortController().signal, onDelta() {} });
    assert.equal(record.complete, complete, JSON.stringify(events));
  }
});

test('stream-usage-null-when-unreported', async () => {
  const unreported = provider(async () => sse([delta('A'), finish('stop'), '[DONE]']).response);
  const signal = new AbortController().signal;
  assert.equal((await unreported.generate({ system: 's', prompt: 'p', model: 'fixture-backend', signal, onDelta() {} })).usage, null);
  const reported = provider(async () => sse([
    delta('A'), finish('stop'), { model: 'fixture-backend', choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }, '[DONE]',
  ]).response);
  assert.deepEqual((await reported.generate({ system: 's', prompt: 'p', model: 'fixture-backend', signal, onDelta() {} })).usage,
    { input: 12, output: 3, total: 15, cacheRead: null, cacheWrite: null });
  // The same rule holds without a stream: no usage object means unreported, never zeros.
  const plain = provider(async (url, init) => {
    assert.equal(JSON.parse(init.body).stream, false);
    return Response.json({ model: 'fixture-backend', choices: [{ finish_reason: 'stop', message: { content: 'A' } }] });
  });
  assert.equal((await plain.generate({ system: 's', prompt: 'p', model: 'fixture-backend', signal })).usage, null);
});

test('abort-returns-no-completed-record', async () => {
  const controller = new AbortController();
  let stream;
  const chat = provider(async (url, init) => {
    stream = sse([delta('Partial ')], { hold: true });
    init.signal.addEventListener('abort', () => stream.cancel(), { once: true });
    return stream.response;
  });
  const deltas = [];
  const pending = chat.generate({
    system: 's', prompt: 'p', model: 'fixture-backend', signal: controller.signal,
    onDelta: text => { deltas.push(text); controller.abort(); },
  });
  await assert.rejects(pending, error => error?.name === 'AbortError');
  assert.deepEqual(deltas, ['Partial ']);
});

test('stream-redacts-endpoint-split-across-chunks', async () => {
  const host = marker + '.invalid';
  const half = Math.floor(host.length / 2);
  const chat = provider(async () => sse([
    delta('Reached ' + host.slice(0, half)), delta(host.slice(half) + ' and ' + host.toUpperCase().slice(0, 4)),
    delta(host.toUpperCase().slice(4) + ' done.'), finish('stop', { model: host }), '[DONE]',
  ]).response);
  const deltas = [];
  const record = await chat.generate({ system: 's', prompt: 'p', model: 'fixture-backend', signal: new AbortController().signal, onDelta: text => deltas.push(text) });
  const streamed = deltas.join('');
  assert.equal(streamed, record.text);
  assert.ok(!streamed.toLowerCase().includes(marker), streamed);
  assert.ok(!JSON.stringify(record).toLowerCase().includes(marker));
  assert.match(record.text, /^Reached \[redacted endpoint\] and \[redacted endpoint\] done\.$/);
});
