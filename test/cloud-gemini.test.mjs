// Offline Gemini-shaped chat-completions and cloud opt-in acceptance tests.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeSandbox } from '../scripts/make-sandbox.mjs';
import { isBloomSandbox, SANDBOX_MARKER } from '../src/sandbox-marker.mjs';
import { probeProvider, PROBE_MESSAGE } from '../src/probe.mjs';
import { createChatProvider } from '../src/models.mjs';
import { providerFailureReason } from '../src/provider-errors.mjs';
import { createCodingRuntime } from '../src/coding-loop.mjs';
import { endpointRedactor } from '../src/endpoint-privacy.mjs';
import { openCodingSession, copyDemoRepo } from './fixtures/coding-session.mjs';
import { action } from './fixtures/demo-provider.mjs';

const marker = 'bloom-cloud-endpoint-marker';
const keyMarker = 'bloom-cloud-key-marker-value';
const fakeBase = 'https://cloud.example.invalid/v1beta/openai';
const markerBase = 'https://' + marker + '.invalid/v1beta/openai';
const bin = fileURLToPath(new URL('../bin/bloom.mjs', import.meta.url));

const sse = (chunks) => new Response(new ReadableStream({ start(controller) {
  const encoder = new TextEncoder();
  for (const chunk of chunks) controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk) + '\n\n'));
  controller.enqueue(encoder.encode('data: [DONE]\n\n'));
  controller.close();
} }), { headers: { 'content-type': 'text/event-stream' } });

function googleError(status, message, statusName) {
  return Response.json({ error: { code: status, message, status: statusName } }, { status });
}

function folders(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'bloom-cloud-')));
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    path: directory,
    closeLater(fn) { closers.push(fn); },
  };
}

test('probe-matches-models-prefixed-ids', async () => {
  const backend = 'gemini-4-hydrogen';
  const fetcher = async (url) => {
    if (String(url).endsWith('/models')) {
      return Response.json({ data: [{ id: 'models/' + backend }] });
    }
    return sse([{ model: backend, choices: [{ delta: { content: 'OK' }, finish_reason: null }] }]);
  };
  const result = await probeProvider({
    provider: { base: fakeBase, baseURL: fakeBase },
    alias: 'coder', backendModel: backend, fetcher,
  });
  const model = result.checks.find(item => item.check === 'Model');
  assert.equal(model.status, 'pass');
  assert.deepEqual(result.profile.model, { value: backend, source: 'probed' });
});

test('probe-accepts-thinking-model-stream', async () => {
  // Gemini 4 may stream with no content and finish length; one SSE chunk is enough.
  const fetcher = async (url) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'models/gemini-4-hydrogen' }] });
    return sse([{ model: 'gemini-4-hydrogen', choices: [{ delta: {}, finish_reason: 'length' }] }]);
  };
  const result = await probeProvider({
    provider: { base: fakeBase, baseURL: fakeBase },
    alias: 'coder', backendModel: 'gemini-4-hydrogen', fetcher,
  });
  assert.equal(result.checks.find(item => item.check === 'Streaming').status, 'pass');
  assert.deepEqual(result.profile.streaming, { value: true, source: 'probed' });
});

test('probe-and-loop-report-rate-limit', async t => {
  const dir = folders(t);
  const fetcher = async (url) => {
    if (String(url).endsWith('/models')) return googleError(429, 'Resource exhausted', 'RESOURCE_EXHAUSTED');
    return googleError(429, 'Resource exhausted', 'RESOURCE_EXHAUSTED');
  };
  const probed = await probeProvider({
    provider: { base: fakeBase, baseURL: fakeBase },
    alias: 'coder', backendModel: 'gemini-4-hydrogen', fetcher,
  });
  assert.equal(probed.checks.find(item => item.check === 'Reachability').status, 'fail');
  assert.match(probed.checks.find(item => item.check === 'Reachability').detail, /rate-limited/);

  const provider = createChatProvider({
    baseURL: markerBase, locality: 'cloud', defaultModel: 'gemini-4-hydrogen',
    fetcher: async () => googleError(429, 'Resource exhausted', 'RESOURCE_EXHAUSTED'),
  });
  const workspace = copyDemoRepo(join(dir.path, 'workspace'));
  writeFileSync(join(workspace, SANDBOX_MARKER), 'bloom-sandbox-v1\n');
  const opened = openCodingSession({
    dataDirectory: join(dir.path, 'data'), workspace, provider, model: 'gemini-4-hydrogen',
    runtime: { cloud: true },
  });
  dir.closeLater(() => opened.close());
  const { ending, events } = await opened.run('List files.', () => 'allow_once');
  assert.equal(ending.status, 'rate-limited');
  assert.equal(events.filter(event => event.type === 'model.call').length, 0);
});

test('google-error-shape-maps-to-reasons', () => {
  assert.equal(providerFailureReason({ status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } } }), 'rate-limited');
  assert.equal(providerFailureReason({ status: 401, body: { error: { code: 401, status: 'UNAUTHENTICATED', message: 'key' } } }), 'http-401');
  assert.equal(providerFailureReason({ status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'denied' } } }), 'http-403');
  assert.equal(providerFailureReason({ status: 500, body: { error: { message: 'boom' } } }), 'http-500');
});

test('cloud-refused-without-flag-and-config', t => {
  const dir = folders(t);
  const data = join(dir.path, 'data');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  writeFileSync(join(data, 'config.json'), JSON.stringify({
    version: 1,
    providers: { aistudio: { kind: 'chat-completions', baseURL: fakeBase, locality: 'cloud', apiKeyEnv: 'GEMINI_API_KEY' } },
    models: { aliases: [{ alias: 'coder', backendModel: 'gemini-4-hydrogen', workload: 'code' }], default: 'coder' },
  }), { mode: 0o600 });
  const sandbox = join(dir.path, 'sandbox');
  makeSandbox(sandbox);
  const env = { ...process.env, GEMINI_API_KEY: keyMarker };
  const noFlag = spawnSync(process.execPath, [bin, 'chat', '--workspace', sandbox, '--data-dir', data], {
    encoding: 'utf8', env, input: '/exit\n', timeout: 15_000,
  });
  assert.notEqual(noFlag.status, 0);
  assert.match(noFlag.stderr + noFlag.stdout, /cloud|EGRESS|allow-cloud/i);
  assert.ok(!(noFlag.stderr + noFlag.stdout).includes(keyMarker));
  assert.ok(!(noFlag.stderr + noFlag.stdout).toLowerCase().includes(marker));
});

test('cloud-refused-outside-sandbox', t => {
  const dir = folders(t);
  const data = join(dir.path, 'data');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  writeFileSync(join(data, 'config.json'), JSON.stringify({
    version: 1,
    providers: { aistudio: { kind: 'chat-completions', baseURL: fakeBase, locality: 'cloud', apiKeyEnv: 'GEMINI_API_KEY' } },
    models: { aliases: [{ alias: 'coder', backendModel: 'gemini-4-hydrogen', workload: 'code' }], default: 'coder' },
  }), { mode: 0o600 });
  const workspace = copyDemoRepo(join(dir.path, 'not-sandbox'));
  assert.equal(isBloomSandbox(workspace), false);
  const run = spawnSync(process.execPath, [bin, 'run', '--headless', 'Hello.', '--workspace', workspace,
    '--allow-cloud', '--approve-policy', 'allow-read', '--data-dir', data, '--json'], {
    encoding: 'utf8', env: { ...process.env, GEMINI_API_KEY: keyMarker }, timeout: 15_000,
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr + run.stdout, /sandbox/i);
  assert.ok(!(run.stderr + run.stdout).includes(keyMarker));
});

test('cloud-reads-ask-first', async t => {
  const dir = folders(t);
  const sandbox = join(dir.path, 'sandbox');
  makeSandbox(sandbox);
  assert.equal(isBloomSandbox(sandbox), true);
  const replies = [
    action('workspace.dir.list', {}),
    action('workspace.file.read', { path: 'src/range.mjs' }),
    action('run.answer.create', { text: 'Listed and read.' }),
  ];
  let index = 0;
  const provider = createChatProvider({
    baseURL: markerBase, locality: 'cloud', defaultModel: 'fixture-backend',
    fetcher: async () => {
      const text = replies[index++] ?? replies.at(-1);
      return sse([
        { model: 'fixture-backend', choices: [{ delta: { content: text }, finish_reason: null }] },
        { model: 'fixture-backend', choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]);
    },
    redact: endpointRedactor(markerBase),
  });
  const opened = openCodingSession({
    dataDirectory: join(dir.path, 'data'), workspace: sandbox, provider, model: 'fixture-backend',
    runtime: { cloud: true },
  });
  dir.closeLater(() => opened.close());
  const asked = [];
  const { events, ending } = await opened.run('Look around.', request => {
    asked.push(request.toolId ?? request.kind);
    return 'allow_once';
  });
  assert.equal(ending.status, 'finished');
  assert.ok(asked.includes('cloud-message') || asked.includes('egress'), 'first message must ask before it is sent');
  assert.ok(asked.includes('workspace.dir.list'), 'reads ask first in cloud mode');
  assert.ok(asked.includes('workspace.file.read'), 'file reads ask first in cloud mode');
  const models = events.filter(event => event.type === 'model.call');
  assert.ok(models.length >= 1);
  assert.ok(models.every(event => event.data.cloud === true));
  const everything = JSON.stringify(events);
  assert.ok(!everything.toLowerCase().includes(marker));
});

test('key-and-endpoint-markers-never-printed', async t => {
  const dir = folders(t);
  const data = join(dir.path, 'data');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  writeFileSync(join(data, 'config.json'), JSON.stringify({
    version: 1,
    providers: { aistudio: { kind: 'chat-completions', baseURL: markerBase, locality: 'cloud', apiKeyEnv: 'GEMINI_API_KEY' } },
    models: { aliases: [{ alias: 'coder', backendModel: 'fixture-backend', workload: 'code' }], default: 'coder' },
  }), { mode: 0o600 });
  const preload = 'data:text/javascript,' + encodeURIComponent(`
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { code: 401, message: 'bad key ${keyMarker}', status: 'UNAUTHENTICATED' },
    }), { status: 401, headers: { 'content-type': 'application/json' } });
  `);
  const run = spawnSync(process.execPath, ['--import', preload, bin, 'doctor', '--probe', '--data-dir', data, '--allow-cloud'], {
    encoding: 'utf8', env: { ...process.env, GEMINI_API_KEY: keyMarker }, timeout: 15_000,
  });
  const printed = run.stdout + run.stderr;
  assert.ok(!printed.includes(keyMarker), 'key marker leaked');
  assert.ok(!printed.toLowerCase().includes(marker), 'endpoint marker leaked');
  assert.match(printed, /cloud|http-401|fail/i);
});

test('npm-test-does-not-load-live-tests', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.test, /test\/\*\.test\.mjs/);
  assert.doesNotMatch(pkg.scripts.test, /live/);
  assert.equal(pkg.scripts['test:live'], 'node --test "test/live/*.live.mjs"');
  assert.ok(existsSync(fileURLToPath(new URL('./live/live-suite.live.mjs', import.meta.url))));
});

test('cloud-refused-for-team-sessions', t => {
  const dir = folders(t);
  const data = join(dir.path, 'data');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  writeFileSync(join(data, 'config.json'), JSON.stringify({
    version: 1,
    providers: { aistudio: { kind: 'chat-completions', baseURL: fakeBase, locality: 'cloud', apiKeyEnv: 'GEMINI_API_KEY' } },
    models: { aliases: [{ alias: 'coder', backendModel: 'gemini-4-hydrogen', workload: 'code' }], default: 'coder' },
  }), { mode: 0o600 });
  const sandbox = join(dir.path, 'sandbox');
  makeSandbox(sandbox);
  let fetches = 0;
  const preload = 'data:text/javascript,' + encodeURIComponent(`
    const real = globalThis.fetch;
    globalThis.fetch = async (...args) => { globalThis.__bloomFetches = (globalThis.__bloomFetches || 0) + 1; throw new Error('no network'); };
  `);
  const run = spawnSync(process.execPath, ['--import', preload, bin, 'chat', '--team', 't', '--workspace', sandbox,
    '--allow-cloud', '--data-dir', data], {
    encoding: 'utf8', env: { ...process.env, GEMINI_API_KEY: keyMarker }, input: '/exit\n', timeout: 15_000,
  });
  assert.equal(run.status, 3);
  assert.match(run.stderr + run.stdout, /coding loop|no --team|sandbox/i);
  assert.ok(!(run.stderr + run.stdout).includes(keyMarker));
});

test('cloud-never-offers-session-allow', async t => {
  const dir = folders(t);
  const sandbox = join(dir.path, 'sandbox');
  makeSandbox(sandbox);
  const same = action('workspace.file.write', { path: 'NOTES.md', content: 'one\n' });
  const replies = [same, same, action('run.answer.create', { text: 'Done.' })];
  let index = 0;
  const provider = createChatProvider({
    baseURL: markerBase, locality: 'cloud', defaultModel: 'fixture-backend',
    fetcher: async () => {
      const text = replies[index++] ?? replies.at(-1);
      return sse([
        { model: 'fixture-backend', choices: [{ delta: { content: text }, finish_reason: null }] },
        { model: 'fixture-backend', choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]);
    },
  });
  const opened = openCodingSession({
    dataDirectory: join(dir.path, 'data'), workspace: sandbox, provider, model: 'fixture-backend',
    runtime: { cloud: true },
  });
  dir.closeLater(() => opened.close());
  const permissions = [];
  await opened.run('Write twice.', request => {
    permissions.push(request);
    return 'allow_once';
  });
  const writes = permissions.filter(request => request.toolId === 'workspace.file.write');
  assert.equal(writes.length, 2, 'each write asks again in cloud mode');
  assert.ok(writes.every(request => !request.options.some(option => option.kind === 'allow_session')));
});

test('cloud-first-message-shows-full-prompt', async t => {
  const dir = folders(t);
  const sandbox = join(dir.path, 'sandbox');
  makeSandbox(sandbox);
  const task = 'Create NOTES.md with one line describing this unique-task-marker project.';
  const provider = createChatProvider({
    baseURL: markerBase, locality: 'cloud', defaultModel: 'fixture-backend',
    fetcher: async () => sse([
      { model: 'fixture-backend', choices: [{ delta: { content: action('run.answer.create', { text: 'Done.' }) }, finish_reason: null }] },
      { model: 'fixture-backend', choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]),
  });
  const opened = openCodingSession({
    dataDirectory: join(dir.path, 'data'), workspace: sandbox, provider, model: 'fixture-backend',
    runtime: { cloud: true },
  });
  dir.closeLater(() => opened.close());
  let detail = '';
  await opened.run(task, request => {
    if (request.toolId === 'cloud-message' || request.kind === 'egress') detail = request.detail;
    return 'allow_once';
  });
  assert.match(detail, /fixed tool instructions/);
  assert.match(detail, /unique-task-marker/);
  assert.match(detail, /Task:\nCreate NOTES\.md/);
});

test('doctor-probe-refuses-cloud-without-allow-cloud', t => {
  const dir = folders(t);
  const data = join(dir.path, 'data');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  writeFileSync(join(data, 'config.json'), JSON.stringify({
    version: 1,
    providers: { aistudio: { kind: 'chat-completions', baseURL: fakeBase, locality: 'cloud', apiKeyEnv: 'GEMINI_API_KEY' } },
    models: { aliases: [{ alias: 'coder', backendModel: 'gemini-4-hydrogen', workload: 'code' }], default: 'coder' },
  }), { mode: 0o600 });
  let fetches = 0;
  const preload = 'data:text/javascript,' + encodeURIComponent(`
    globalThis.fetch = async () => { globalThis.__fetches = (globalThis.__fetches || 0) + 1; throw new Error('no'); };
  `);
  const run = spawnSync(process.execPath, ['--import', preload, bin, 'doctor', '--probe', '--data-dir', data, '--json'], {
    encoding: 'utf8', env: { ...process.env, GEMINI_API_KEY: keyMarker }, timeout: 15_000,
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stdout + run.stderr, /allow-cloud|cloud/i);
  assert.ok(!(run.stdout + run.stderr).includes(keyMarker));
});

test('headless-cloud-makes-no-requests', t => {
  const dir = folders(t);
  const data = join(dir.path, 'data');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  writeFileSync(join(data, 'config.json'), JSON.stringify({
    version: 1,
    providers: { aistudio: { kind: 'chat-completions', baseURL: fakeBase, locality: 'cloud', apiKeyEnv: 'GEMINI_API_KEY' } },
    models: { aliases: [{ alias: 'coder', backendModel: 'gemini-4-hydrogen', workload: 'code' }], default: 'coder' },
  }), { mode: 0o600 });
  const sandbox = join(dir.path, 'sandbox');
  makeSandbox(sandbox);
  const preload = 'data:text/javascript,' + encodeURIComponent(`
    globalThis.fetch = async () => { globalThis.__fetches = (globalThis.__fetches || 0) + 1; throw new Error('no'); };
  `);
  const run = spawnSync(process.execPath, ['--import', preload, bin, 'run', '--headless', 'Hello.', '--workspace', sandbox,
    '--allow-cloud', '--approve-policy', 'allow-read', '--data-dir', data, '--json'], {
    encoding: 'utf8', env: { ...process.env, GEMINI_API_KEY: keyMarker }, timeout: 15_000,
  });
  // Headless cloud still opens the loop but refusals before egress / tools; assert no success and no key leak.
  assert.ok(!(run.stdout + run.stderr).includes(keyMarker));
  assert.notEqual(run.status, 0);
});

test('chat-error-body-is-not-echoed', t => {
  const dir = folders(t);
  const data = join(dir.path, 'data');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  writeFileSync(join(data, 'config.json'), JSON.stringify({
    version: 1,
    providers: { aistudio: { kind: 'chat-completions', baseURL: markerBase, locality: 'cloud', apiKeyEnv: 'GEMINI_API_KEY' } },
    models: { aliases: [{ alias: 'coder', backendModel: 'fixture-backend', workload: 'code' }], default: 'coder' },
  }), { mode: 0o600 });
  const sandbox = join(dir.path, 'sandbox');
  makeSandbox(sandbox);
  const preload = 'data:text/javascript,' + encodeURIComponent(`
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { code: 500, message: 'server saw ${keyMarker}', status: 'INTERNAL' },
    }), { status: 500, headers: { 'content-type': 'application/json' } });
  `);
  const run = spawnSync(process.execPath, ['--import', preload, bin, 'chat', '--workspace', sandbox,
    '--allow-cloud', '--data-dir', data], {
    encoding: 'utf8', env: { ...process.env, GEMINI_API_KEY: keyMarker }, input: 'Hello.\n/exit\n', timeout: 15_000,
  });
  const printed = run.stdout + run.stderr;
  assert.ok(!printed.includes(keyMarker), 'error body key marker leaked');
});

test('tests-never-configure-a-real-cloud-host', () => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const files = ['cloud-gemini.test.mjs', 'live/live-suite.live.mjs'];
  for (const name of files) {
    const source = readFileSync(new URL('./' + name, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /generativelanguage\.googleapis\.com/, name);
  }
});

test('live-suite-cloud-needs-second-flag', async t => {
  // Nested `node --test` is skipped by the runner, so exercise the same gate the live suite uses.
  const { readTerminalProvider } = await import('../src/cli/config.mjs');
  const dir = folders(t);
  const data = join(dir.path, 'data');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  writeFileSync(join(data, 'config.json'), JSON.stringify({
    version: 1,
    providers: { aistudio: { kind: 'chat-completions', baseURL: fakeBase, locality: 'cloud', apiKeyEnv: 'GEMINI_API_KEY' } },
    models: { aliases: [{ alias: 'coder', backendModel: 'gemini-4-hydrogen', workload: 'code' }], default: 'coder' },
  }), { mode: 0o600 });
  let fetches = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { fetches += 1; throw new Error('no network'); };
  const previousAllow = process.env.BLOOM_LIVE_ALLOW_CLOUD;
  delete process.env.BLOOM_LIVE_ALLOW_CLOUD;
  t.after(() => {
    globalThis.fetch = previous;
    if (previousAllow === undefined) delete process.env.BLOOM_LIVE_ALLOW_CLOUD;
    else process.env.BLOOM_LIVE_ALLOW_CLOUD = previousAllow;
  });
  const provider = readTerminalProvider(data);
  assert.ok(provider);
  assert.equal(provider.local, false);
  assert.throws(
    () => assert.ok(provider.local || process.env.BLOOM_LIVE_ALLOW_CLOUD === '1',
      'Cloud live probe needs BLOOM_LIVE_ALLOW_CLOUD=1 as well.'),
    /BLOOM_LIVE_ALLOW_CLOUD/,
  );
  assert.equal(fetches, 0);
});
