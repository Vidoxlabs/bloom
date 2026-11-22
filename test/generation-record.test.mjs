// Every adapter Bloom ships returns a generation record in the shared shape: text is a string, and
// usage holds only input, output, total, cacheRead and cacheWrite, each a non-negative integer or null.
// Bloom adopts the family libraries only once its records pass that rule, so this file restates the rule
// locally instead of importing the library that owns it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createChatProvider, createServerProvider, demoProvider } from '../src/models.mjs';

const USAGE_FIELDS = ['input', 'output', 'total', 'cacheRead', 'cacheWrite'];

function recordIssues(result) {
  const issues = [];
  if (typeof result.text !== 'string') issues.push('text is not a string');
  if (typeof result.complete !== 'boolean') issues.push('complete is not a boolean');
  if (result.model != null && typeof result.model !== 'string') issues.push('model is not a string or null');
  const usage = result.usage ?? null;
  if (usage !== null) {
    for (const key of Object.keys(usage)) if (!USAGE_FIELDS.includes(key)) issues.push('usage.' + key + ' is not a usage field');
    for (const field of USAGE_FIELDS) {
      const value = usage[field] ?? null;
      if (value !== null && !(Number.isSafeInteger(value) && value >= 0)) issues.push('usage.' + field + ' is not a count');
    }
  }
  if (result.costUSD !== null && !(typeof result.costUSD === 'number' && result.costUSD >= 0)) issues.push('costUSD is not an amount or null');
  return issues;
}

const input = () => ({ system: 'Role', prompt: 'Question', model: 'local/model', signal: new AbortController().signal });
const chat = body => createChatProvider({ apiKey: 'test-only', fetcher: async () => Response.json(body) });
const server = reply => createServerProvider({ baseURL: 'http://127.0.0.1:5555',
  fetcher: async url => url.endsWith('/session') ? Response.json({ id: 'ses_fixture' }) : Response.json(reply) });

test('the chat adapter returns a conforming record and keeps cost beside usage', async () => {
  const result = await chat({ choices: [{ finish_reason: 'stop', message: { content: 'result' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 2 }, cost: 0.0004 } }).generate(input());
  assert.deepEqual(recordIssues(result), []);
  assert.deepEqual(result.usage, { input: 10, output: 5, total: 15, cacheRead: 2, cacheWrite: null });
  assert.equal(result.costUSD, 0.0004);
  assert.equal(result.complete, true);
});

test('the server adapter returns a conforming record; reasoning counts only toward its total', async () => {
  const result = await server({ info: { role: 'assistant', finish: 'stop', providerID: 'local', modelID: 'model', cost: 0,
    tokens: { input: 10, output: 5, reasoning: 3, cache: { read: 2, write: 1 } } }, parts: [{ type: 'text', text: 'result' }] }).generate(input());
  assert.deepEqual(recordIssues(result), []);
  assert.deepEqual(result.usage, { input: 10, output: 5, total: 21, cacheRead: 2, cacheWrite: 1 });
  assert.equal(result.costUSD, 0);
  assert.equal(result.model, 'local/model');
});

test('the scripted demo returns a conforming record with every metric unreported', async () => {
  const result = await demoProvider.generate({ phase: 'plan', brief: 'Write a guide', signal: new AbortController().signal });
  assert.deepEqual(recordIssues(result), []);
  assert.deepEqual(result.usage, { input: null, output: null, total: null, cacheRead: null, cacheWrite: null });
  assert.equal(result.costUSD, null);
});

test('a reply with no text body is a string record that is not complete', async () => {
  const noContent = await chat({ choices: [{ finish_reason: 'stop', message: { content: null } }], usage: {} }).generate(input());
  const noParts = await server({ info: { role: 'assistant', finish: 'stop', tokens: {} } }).generate(input());
  const badPart = await server({ info: { role: 'assistant', finish: 'stop', tokens: {} }, parts: [{ type: 'text' }] }).generate(input());
  for (const result of [noContent, noParts, badPart]) {
    assert.deepEqual(recordIssues(result), []);
    assert.equal(result.text, '');
    assert.equal(result.complete, false);
  }
});

test('unreported metrics stay null and are never filled in', async () => {
  const result = await chat({ choices: [{ finish_reason: 'stop', message: { content: 'x' } }] }).generate(input());
  assert.deepEqual(recordIssues(result), []);
  assert.deepEqual(result.usage, { input: null, output: null, total: null, cacheRead: null, cacheWrite: null });
  assert.equal(result.costUSD, null);
  const negative = await chat({ choices: [{ finish_reason: 'stop', message: { content: 'x' } }], usage: { total_tokens: -1, cost: -2 } }).generate(input());
  assert.equal(negative.usage.total, null);
  assert.equal(negative.costUSD, null);
});
