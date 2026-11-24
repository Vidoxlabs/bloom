import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { modelRow, toolRow } from '../public/coding-view.js';
import { createWebWorkspace } from '../src/web.mjs';
import { copyDemoRepo } from './fixtures/coding-session.mjs';
import { demoReplies, demoTask } from './fixtures/demo-provider.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const makeSandbox = join(root, 'scripts', 'make-sandbox.mjs');
const marker = 'bloom-web-endpoint-marker';
const base = 'https://' + marker + '.invalid/v1';
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

function scratch(t, prefix) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('make-sandbox-creates-baseline-commit', t => {
  const target = join(scratch(t, 'bloom-sandbox-'), 'fresh');
  const run = spawnSync(process.execPath, [makeSandbox, target], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync(join(target, 'src', 'range.mjs')));
  assert.equal(git(target, 'log', '--format=%s').stdout.trim(), 'Baseline');
  assert.equal(git(target, 'status', '--porcelain').stdout, '');
  assert.doesNotMatch(run.stdout, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // An existing empty folder works too.
  const empty = join(scratch(t, 'bloom-sandbox-empty-'), 'empty');
  mkdirSync(empty);
  assert.equal(spawnSync(process.execPath, [makeSandbox, empty], { encoding: 'utf8' }).status, 0);
});

test('make-sandbox-refuses-non-empty-or-inside-clone', t => {
  const busy = scratch(t, 'bloom-sandbox-busy-');
  writeFileSync(join(busy, 'keep.txt'), 'mine\n');
  const refusedBusy = spawnSync(process.execPath, [makeSandbox, busy], { encoding: 'utf8' });
  assert.equal(refusedBusy.status, 2);
  assert.deepEqual(readdirSync(busy), ['keep.txt']);
  const clone = scratch(t, 'bloom-sandbox-clone-');
  assert.equal(git(clone, 'init', '-q').status, 0);
  for (const target of [join(clone, 'nested', 'sandbox'), join(root, 'sandbox-inside-bloom')]) {
    const refused = spawnSync(process.execPath, [makeSandbox, target], { encoding: 'utf8' });
    assert.equal(refused.status, 2, target);
    assert.match(refused.stderr, /inside a git clone/);
    assert.equal(existsSync(target), false, target);
  }
  assert.equal(spawnSync(process.execPath, [makeSandbox], { encoding: 'utf8' }).status, 2);
});

// A fake fetch that streams one scripted reply per completion call.
function streamingFetcher(replies) {
  let index = 0;
  return async (url, init) => {
    assert.ok(String(url).endsWith('/chat/completions'));
    assert.equal(JSON.parse(init.body).stream, true);
    const text = replies[index++] ?? replies.at(-1);
    const encoder = new TextEncoder();
    const chunks = [
      { model: 'fixture-backend', choices: [{ delta: { content: text.slice(0, 30) }, finish_reason: null }] },
      { model: marker + '.invalid', choices: [{ delta: { content: text.slice(30) }, finish_reason: 'stop' }] },
    ];
    return new Response(new ReadableStream({ start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk) + '\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  };
}

function writeConfig(directory, provider = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, 'config.json'), JSON.stringify({
    version: 1,
    providers: { lab: { kind: 'chat-completions', baseURL: base, locality: 'local', ...provider } },
    models: { aliases: [{ alias: 'fixture', backendModel: 'fixture-backend', workload: 'code' }], default: 'fixture' },
  }), { mode: 0o600 });
}

test('web-workspace-runs-coding-loop-from-private-config', async t => {
  // One after-hook: close the store before deleting the temp tree (Windows EBUSY).
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'bloom-web-')));
  const data = join(directory, 'data');
  writeConfig(data);
  const workspace = copyDemoRepo(join(directory, 'workspace'));
  const web = createWebWorkspace({ dataDirectory: data, workspace, fetcher: streamingFetcher(demoReplies) });
  t.after(async () => {
    await web.harness.close();
    web.store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const info = web.harness.info();
  assert.deepEqual(info.adapters.map(adapter => adapter.id), ['coding']);
  assert.ok(!JSON.stringify(info).toLowerCase().includes(marker));
  // The browser creates a session with just the workspace, as its form does.
  const session = web.harness.createSession({ workspace });
  assert.equal(session.adapter, 'coding');
  const events = [];
  const finished = new Promise(resolve => web.harness.subscribe(session.id, event => {
    events.push(event);
    if (event.type === 'permission.requested') web.harness.decide(session.id, event.data.id, { optionId: 'allow-once' });
    if (event.type === 'turn.finished') resolve(event.data);
  }));
  web.harness.start(session.id, { text: demoTask });
  assert.equal((await finished).status, 'finished');
  assert.equal(readFileSync(join(workspace, 'src', 'range.mjs'), 'utf8').includes('value <= end'), true);
  const types = new Set(events.map(event => event.type));
  for (const type of ['model.call', 'tool.updated', 'permission.requested', 'assistant.delta']) assert.ok(types.has(type), type);
  assert.equal(events.find(event => event.type === 'agent.connected')?.data.model, 'fixture-backend');
  assert.ok(events.some(event => event.type === 'assistant.delta' && event.data.final));
  assert.ok(!JSON.stringify(events).toLowerCase().includes(marker));
});

test('web-workspace-refuses-cloud-and-has-no-endpoint-option', t => {
  const data = join(scratch(t, 'bloom-web-cloud-'), 'data');
  writeConfig(data, { locality: 'cloud' });
  assert.throws(() => createWebWorkspace({ dataDirectory: data, fetcher: () => { throw new Error('no network'); } }),
    error => error.code === 'EGRESS_REFUSED' && !error.message.includes(marker));
  const main = join(root, 'src', 'main.mjs');
  const refused = spawnSync(process.execPath, [main, '--api-base', base, '--data-dir', data], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /Unknown option/);
  assert.ok(!refused.stderr.includes(marker));
  const help = spawnSync(process.execPath, [main, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  // No endpoint option and no key variable name in the help.
  assert.doesNotMatch(help.stdout, /api-base|[A-Z]+_KEY\b/);
  assert.match(help.stdout, /config\.json/);
});

test('web-coding-view-formats-rows', () => {
  assert.equal(modelRow({ call: 1, durationMs: 12, usage: { input: 480, output: 24 } }), 'Model call 1 · 12 ms · in 480, out 24');
  assert.equal(modelRow({ call: 2, durationMs: 5, usage: null }), 'Model call 2 · 5 ms · usage unreported');
  assert.deepEqual(toolRow({ id: 'a', toolId: 'workspace.shell.execute', summary: 'node --test', status: 'failed', durationMs: 7,
    exitCode: 1, output: 'not ok\n' }), {
    title: 'node --test', name: 'workspace.shell.execute', phase: 'failed', meta: '7 ms · exit 1', output: 'not ok\n',
  });
  assert.deepEqual(toolRow({ id: 'b', toolId: 'workspace.file.read', summary: 'path=src/range.mjs', status: 'completed', durationMs: 3, bytes: 215 }),
    { title: 'path=src/range.mjs', name: 'workspace.file.read', phase: 'completed', meta: '3 ms · 215 B', output: '' });
  // Rows from the team runtime keep their own title.
  assert.deepEqual(toolRow({ id: 'c', title: 'Search sources', status: 'in_progress' }),
    { title: 'Search sources', name: '', phase: 'in_progress', meta: '', output: '' });
});

const runbook = readFileSync(join(root, 'docs', 'live-test.md'), 'utf8');
// Accept LF or CRLF so a Windows checkout still finds the bash blocks.
const commands = [...runbook.matchAll(/```bash\r?\n([\s\S]*?)```/g)].flatMap(match => match[1].split(/\r?\n/))
  .map(line => line.trim()).filter(line => line && !line.startsWith('#'));

test('live-test-runbook-commands-exist', () => {
  assert.ok(commands.length >= 6, 'the runbook names its commands in bash blocks');
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
  const help = spawnSync(process.execPath, [join(root, 'bin', 'bloom.mjs'), '--help'], { encoding: 'utf8' }).stdout;
  for (const line of commands) {
    for (const part of line.split(/&&|;/).map(piece => piece.trim()).filter(Boolean)) {
      // Opt-in live tests set BLOOM_LIVE=1 before npm; strip that assignment only.
      // Sandbox inspection may wrap git with env -u GEMINI_API_KEY.
      const words = part.replace(/^BLOOM_LIVE=1\s+/, '').replace(/^env -u GEMINI_API_KEY\s+/, '').split(/\s+/);
      if (words[0] === 'cd' || words[0] === 'git') continue;
      if (words[0] === 'npm') {
        const name = words[1] === 'run' ? words[2] : words[1];
        if (name === 'install') continue;
        assert.ok(Object.hasOwn(scripts, name), part);
      } else if (words[0] === 'node' && words[1] === 'bin/bloom.mjs') {
        assert.ok(help.includes('bloom ' + words[2]), part);
        for (const flag of words.filter(word => word.startsWith('--'))) assert.ok(help.includes(flag), part + ' ' + flag);
      } else if (words[0] === 'node') {
        assert.ok(existsSync(join(root, words[1])), part);
      } else {
        assert.fail('unexpected command in the runbook: ' + part);
      }
    }
  }
});

test('live-test-runbook-keeps-endpoint-private', () => {
  assert.match(runbook, /<your-endpoint>/);
  assert.match(runbook, /<sandbox folder>/);
  for (const line of commands) {
    // BLOOM_LIVE=1 is the opt-in flag, not an endpoint or key assignment.
    assert.doesNotMatch(line.replace(/\bBLOOM_LIVE=1\b/g, ''), /api-base|<your-endpoint>|[A-Z_]+=/, line);
  }
  // GEMINI_API_KEY is the documented example variable name, never a secret value.
  assert.doesNotMatch(runbook, /export [A-Z_]+=/);
  assert.doesNotMatch(runbook.replaceAll('GEMINI_API_KEY', ''), /[A-Z]+_KEY\b/);
  for (const section of ['Offline rehearsal', 'Config', 'Probe', 'Live run', 'Web view', 'Troubleshooting', 'Google AI Studio', 'Opt-in live tests', 'Residual risk']) {
    assert.match(runbook, new RegExp('^## ' + section, 'm'), section);
  }
});
