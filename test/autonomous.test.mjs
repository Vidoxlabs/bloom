import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeSandbox } from '../scripts/make-sandbox.mjs';
import { openCodingSession } from './fixtures/coding-session.mjs';
import { action, demoReplies, demoTask, scriptedProvider } from './fixtures/demo-provider.mjs';

const bin = fileURLToPath(new URL('../bin/bloom.mjs', import.meta.url));

function setup(t, { marked = true, locality = 'local' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bloom-autonomous-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  const workspace = join(root, 'workspace');
  mkdirSync(data, { mode: 0o700 });
  if (marked) makeSandbox(workspace);
  else mkdirSync(workspace);
  writeFileSync(join(data, 'config.json'), JSON.stringify({
    version: 1,
    providers: { fixture: { kind: 'chat-completions', baseURL: 'https://local.example.invalid/v1', locality } },
    models: { aliases: [{ alias: 'coder', backendModel: 'fixture-model', workload: 'code' }], default: 'coder' },
  }), { mode: 0o600 });
  return { workspace, data };
}

function cli({ workspace, data }, args, replies = [], input = '/exit\n') {
  const stub = 'data:text/javascript,' + encodeURIComponent(`
    const replies = ${JSON.stringify(replies)};
    let seen = 0;
    globalThis.fetch = async (_url, init) => {
      if (seen >= replies.length) throw Error('Unexpected fixture request');
      const message = JSON.parse(init.body).messages.find(entry => entry.role === 'system')?.content;
      if (!message?.includes('run automatically')) throw Error('Autonomous prompt was not used');
      const chunk = { model: 'fixture-model', choices: [{ delta: { content: replies[seen++] }, finish_reason: 'stop' }] };
      return new Response('data: ' + JSON.stringify(chunk) + '\\n\\ndata: [DONE]\\n\\n',
        { headers: { 'content-type': 'text/event-stream' } });
    };
  `);
  return spawnSync(process.execPath, [
    '--import', stub, bin, ...args, '--workspace', workspace, '--data-dir', data, '--autonomous',
  ], { encoding: 'utf8', input, timeout: 20_000 });
}

const eventsOf = run => run.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
const runArgs = ['run', '--headless', '--json', demoTask];
const finish = action('run.answer.create', { text: 'Done.' });
const read = action('workspace.dir.list', {});

function assertRefused(run) {
  assert.equal(run.error, undefined);
  assert.equal(run.status, 3, run.stderr);
  const events = eventsOf(run);
  assert.equal(events.at(-1).status, 'refused');
  assert.equal(events.at(-1).reason, 'AUTONOMOUS_REFUSED');
  assert.equal(events.some(event => event.type === 'model.call'), false);
}

test('autonomous-refused-outside-sandbox', t => {
  assertRefused(cli(setup(t, { marked: false }), runArgs));
});

test('autonomous-refused-for-cloud', t => {
  assertRefused(cli(setup(t, { locality: 'cloud' }), [...runArgs, '--allow-cloud']));
});

test('autonomous-refused-for-team-sessions', t => {
  const run = cli(setup(t), ['chat', '--team', 'Fixture team']);
  assert.equal(run.error, undefined);
  assert.equal(run.status, 3);
  assert.match(run.stderr, /local coding session/);
});

test('autonomous-runs-fixture-without-prompts', t => {
  const fixture = setup(t);
  const run = cli(fixture, runArgs, demoReplies);
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, run.stderr);
  const events = eventsOf(run);
  assert.equal(events.at(-1).status, 'finished');
  assert.equal(events.some(event => event.type === 'permission.requested'), false);
  const tools = events.filter(event => event.type === 'tool.updated').map(event => event.data);
  const effects = tools.filter(tool => tool.toolId === 'workspace.shell.execute' || tool.toolId.startsWith('workspace.file.') && tool.toolId !== 'workspace.file.read');
  assert.equal(effects.length, 4);
  assert.ok(effects.every(tool => tool.approval === 'auto'));
  assert.deepEqual(tools.filter(tool => tool.toolId === 'workspace.shell.execute').map(tool => tool.exitCode), [1, 0]);
  assert.equal(existsSync(join(fixture.workspace, 'NOTES.md')), true);
  const chat = cli(fixture, ['chat'], [finish], 'Finish the fixture.\n/exit\n');
  assert.equal(chat.status, 0, chat.stderr);
  assert.match(chat.stdout, /Turn finished/);
  assert.doesNotMatch(chat.stdout, /Permission requested/);
});

test('autonomous-stops-at-budget', async t => {
  const fixture = setup(t);
  const run = cli(fixture, [...runArgs, '--max-calls', '1'], [read, finish]);
  assert.equal(run.status, 4, run.stderr);
  assert.equal(eventsOf(run).at(-1).calls, 1);

  for (const [budget, provider] of [
    [{ toolLimit: 1 }, scriptedProvider([read, finish])],
    [{ wallMs: 30 }, { ...scriptedProvider(), generate: _request => new Promise(() => {}) }],
  ]) {
    const session = openCodingSession({
      workspace: fixture.workspace, dataDirectory: join(fixture.data, Object.keys(budget)[0]),
      provider, runtime: { autonomous: budget },
    });
    try {
      const { ending, events } = await session.run(demoTask, () => assert.fail('budget run asked for permission'));
      assert.equal(ending.status, 'limit');
      assert.equal(ending.reason, budget.wallMs ? 'max_wall_time' : 'max_tool_calls');
      assert.equal(events.filter(event => event.type === 'model.call').length, budget.wallMs ? 0 : 1);
    } finally {
      await session.close();
    }
  }
});

test('autonomous-still-applies-shell-gate', t => {
  const run = cli(setup(t), runArgs, [
    action('workspace.shell.execute', { command: 'unsupported-command', args: [] }),
    finish,
  ]);
  assert.equal(run.status, 3, run.stderr);
  const events = eventsOf(run);
  assert.equal(events.some(event => event.type === 'permission.requested'), false);
  const rows = events.filter(event => event.type === 'tool.updated').map(event => event.data);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'refused');
  assert.equal(rows[0].reason, 'WORKSPACE_COMMAND_REFUSED');
  assert.equal(events.at(-1).calls, 1);
});
