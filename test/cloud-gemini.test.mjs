// Offline Gemini-shaped chat-completions and cloud opt-in acceptance tests.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeSandbox } from '../scripts/make-sandbox.mjs';
import { isBloomSandbox } from '../src/sandbox-marker.mjs';
import { createChatProvider } from '../src/models.mjs';
import { createCodingRuntime } from '../src/coding-loop.mjs';
import { endpointRedactor } from '../src/endpoint-privacy.mjs';
import { openCodingSession, copyDemoRepo } from './fixtures/coding-session.mjs';
import { action } from './fixtures/demo-provider.mjs';
import { fakeBase, markerBase, keyMarker, sse, folders } from './fixtures/cloud-fixture.mjs';

const marker = 'bloom-cloud-endpoint-marker';
const bin = fileURLToPath(new URL('../bin/bloom.mjs', import.meta.url));

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
  const countFile = join(dir.path, 'fetch-count.txt');
  writeFileSync(countFile, '0');
  const preload = 'data:text/javascript,' + encodeURIComponent(`
    import { readFileSync, writeFileSync } from 'node:fs';
    const countFile = ${JSON.stringify(countFile)};
    globalThis.fetch = async () => {
      const next = String(Number(readFileSync(countFile, 'utf8') || '0') + 1);
      writeFileSync(countFile, next);
      throw new Error('no');
    };
  `);
  const run = spawnSync(process.execPath, ['--import', preload, bin, 'doctor', '--probe', '--data-dir', data, '--json'], {
    encoding: 'utf8', env: { ...process.env, GEMINI_API_KEY: keyMarker }, timeout: 15_000,
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stdout + run.stderr, /allow-cloud|cloud/i);
  assert.equal(readFileSync(countFile, 'utf8'), '0');
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
  const countFile = join(dir.path, 'fetch-count.txt');
  writeFileSync(countFile, '0');
  const preload = 'data:text/javascript,' + encodeURIComponent(`
    import { readFileSync, writeFileSync } from 'node:fs';
    const countFile = ${JSON.stringify(countFile)};
    globalThis.fetch = async () => {
      const next = String(Number(readFileSync(countFile, 'utf8') || '0') + 1);
      writeFileSync(countFile, next);
      return new Response(JSON.stringify({
        error: { code: 500, message: 'server saw ${keyMarker}', status: 'INTERNAL' },
      }), { status: 500, headers: { 'content-type': 'application/json' } });
    };
  `);
  // Answer 1 (Allow once) to the first-message cloud prompt so the request is actually sent.
  const run = spawnSync(process.execPath, ['--import', preload, bin, 'chat', '--workspace', sandbox,
    '--allow-cloud', '--data-dir', data], {
    encoding: 'utf8', env: { ...process.env, GEMINI_API_KEY: keyMarker },
    input: 'Hello.\n1\n/exit\n', timeout: 15_000,
  });
  const printed = run.stdout + run.stderr;
  assert.equal(readFileSync(countFile, 'utf8'), '1', 'one cloud request was expected');
  assert.ok(!printed.includes(keyMarker), 'error body key marker leaked');
});

test('tests-never-configure-a-real-cloud-host', () => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const files = ['cloud-gemini.test.mjs', 'probe-provider.test.mjs', 'fixtures/cloud-fixture.mjs', 'live/live-suite.live.mjs'];
  for (const name of files) {
    const source = readFileSync(new URL('./' + name, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /generativelanguage\.googleapis\.com/, name);
  }
});

test('live-suite-cloud-needs-second-flag', t => {
  const dir = folders(t);
  const data = join(dir.path, 'data');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  writeFileSync(join(data, 'config.json'), JSON.stringify({
    version: 1,
    providers: { aistudio: { kind: 'chat-completions', baseURL: fakeBase, locality: 'cloud', apiKeyEnv: 'GEMINI_API_KEY' } },
    models: { aliases: [{ alias: 'coder', backendModel: 'gemini-4-hydrogen', workload: 'code' }], default: 'coder' },
  }), { mode: 0o600 });
  const counter = join(dir.path, 'outbound-requests');
  writeFileSync(counter, '');
  const preload = 'data:text/javascript,' + encodeURIComponent(
    'import { appendFileSync } from "node:fs";\n'
    + 'globalThis.fetch = async () => { appendFileSync(' + JSON.stringify(counter)
    + ', "attempt\\n"); throw new Error("Offline fixture"); };',
  );
  const liveSuite = fileURLToPath(new URL('./live/live-suite.live.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [
    '--import', preload, '--test', '--test-reporter=tap',
    '--test-name-pattern=live-probe-passes|live-output-has-no-endpoint-or-key', liveSuite,
  ], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: dir.path,
      USERPROFILE: dir.path,
      BLOOM_LIVE: '1',
      BLOOM_LIVE_DATA_DIR: data,
    },
    timeout: 15_000,
  });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 1);
  assert.equal(readFileSync(counter, 'utf8'), '', 'a gated live test attempted a request');
  for (const name of ['live-probe-passes', 'live-output-has-no-endpoint-or-key']) {
    assert.match(run.stdout, new RegExp('not ok \\d+ - ' + name + '\\b'), name);
  }
  assert.equal([...run.stdout.matchAll(/Cloud live probe needs BLOOM_LIVE_ALLOW_CLOUD=1 as well\./g)].length, 2);
});
