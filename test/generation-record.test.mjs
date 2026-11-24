// Bloom runs every team provider behind seed's provider seam. These tests hold both halves:
// the adapters Bloom ships return records seed accepts, and the adopted seam refuses a record
// that does not fit, before the team loop reads it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeGeneration, validateProvider } from '@vidoxlabs/seed';
import { createChatProvider, demoProvider, unconfiguredProvider } from '../src/models.mjs';
import { adoptProvider } from '../src/provider.mjs';

const input = () => ({ system: 'Role', prompt: 'Question', model: 'local/model', signal: new AbortController().signal });
const chat = body => createChatProvider({ baseURL: 'http://127.0.0.1:5555/v1', fetcher: async () => Response.json(body) });
const accepted = result => {
  const normalized = normalizeGeneration(result);
  assert.deepEqual(normalized.errors, []);
  return normalized.generation;
};

test('every shipped adapter fits the seam seed checks', () => {
  for (const provider of [chat({}), demoProvider, unconfiguredProvider]) {
    assert.deepEqual(validateProvider(provider), { ok: true, errors: [] });
  }
});

test('the chat adapter returns a record seed accepts, with cost beside usage', async () => {
  const result = await chat({ choices: [{ finish_reason: 'stop', message: { content: 'result' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 2 }, cost: 0.0004 } }).generate(input());
  assert.deepEqual(accepted(result).usage, { input: 10, output: 5, total: 15, cacheRead: 2, cacheWrite: null });
  assert.equal(result.costUSD, 0.0004);
});

test('the scripted demo returns a record seed accepts, with every metric unreported', async () => {
  const result = await demoProvider.generate({ phase: 'plan', brief: 'Write a guide', signal: new AbortController().signal });
  assert.deepEqual(accepted(result).usage, { input: null, output: null, total: null, cacheRead: null, cacheWrite: null });
  assert.equal(result.costUSD, null);
});

test('a reply with no text body is a string record seed accepts, and it is not complete', async () => {
  const result = await chat({ choices: [{ finish_reason: 'stop', message: { content: null } }], usage: {} }).generate(input());
  const generation = accepted(result);
  assert.equal(generation.text, '');
  assert.equal(generation.complete, false);
});

test('unreported and negative metrics stay null', async () => {
  const result = await chat({ choices: [{ finish_reason: 'stop', message: { content: 'x' } }], usage: { total_tokens: -1, cost: -2 } }).generate(input());
  assert.equal(accepted(result).usage.total, null);
  assert.equal(result.costUSD, null);
});

test('the adopted seam passes a conforming record through seed and keeps the reported cost', async () => {
  const adopted = adoptProvider({ label: 'Fixture', defaultModel: 'm', async generate(_call) {
    return { text: 'ok', complete: true, model: 'm', usage: { input: 1, output: 2, total: 3 }, costUSD: 0.5 };
  } });
  assert.equal(adopted.label, 'Fixture');
  assert.equal(adopted.defaultModel, 'm');
  assert.deepEqual(await adopted.generate(input()), {
    text: 'ok', complete: true, model: 'm', usage: { input: 1, output: 2, total: 3, cacheRead: null, cacheWrite: null }, costUSD: 0.5,
  });
});

test('the adopted seam refuses a record outside the contract', async () => {
  const records = [
    { text: 'ok', complete: true, model: 'm', usage: { total: 3, costUSD: 0.1 } },
    { text: undefined, complete: true, model: 'm', usage: null },
    { text: 'ok', complete: 'yes', model: 'm', usage: null },
    { text: 'ok', complete: true, model: 'm', usage: { total: -1 } },
    null,
  ];
  for (const record of records) {
    const adopted = adoptProvider({ label: 'Fixture', async generate(_call) { return record; } });
    await assert.rejects(adopted.generate(input()), { code: 'PROVIDER_CONTRACT' });
  }
});

test('the seam refuses an adapter that cannot generate, when Bloom starts', () => {
  assert.throws(() => adoptProvider({ label: 'Broken' }), /provider seam: generate must be a function/);
  assert.throws(() => adoptProvider(null), /provider seam/);
});

test('without an endpoint, a team call stops with a message that names the config file', async () => {
  await assert.rejects(adoptProvider(unconfiguredProvider).generate(input()), { code: 'PROVIDER_UNCONFIGURED', message: /config\.json/ });
});

test('package.json pins seed to one full commit, and the installed seed is the release at that commit', async () => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.dependencies['@vidoxlabs/seed'], /^github:Vidoxlabs\/seed#[0-9a-f]{40}$/);
  assert.equal(pkg.dependencies['@vidoxlabs/seed'], 'github:Vidoxlabs/seed#41009c336a904b0a2d7390a409bfc1bd16162498');
  const { VERSION } = await import('@vidoxlabs/seed');
  assert.equal(VERSION, '0.10.0');
});
