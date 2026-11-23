import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../src/store.mjs';
import { Harness } from '../src/harness.mjs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const bin = fileURLToPath(new URL('../bin/bloom.mjs', import.meta.url));
function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'bloom-cli-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function command(directory, args, extra = {}) {
  return spawnSync(process.execPath, [...(extra.preload ? ['--import', extra.preload] : []), bin, ...args, '--data-dir', directory],
    { encoding: 'utf8', timeout: 5000, input: extra.input });
}
const parse = stdout => stdout.trim().split('\n').map(line => JSON.parse(line));
const result = stdout => parse(stdout).at(-1);
const preload = source => 'data:text/javascript,' + encodeURIComponent(source);
const localAddress = Object.values(networkInterfaces()).flat().find(address => address.internal && address.family === 'IPv4').address;
const base = 'http://' + localAddress;
const model = ['--api-base', base, '--model', 'fixture'];
const draft = { message: 'I assigned the fixture.', agents: [{ name: 'Researcher', assignment: 'Read the supplied fixture.' }] };
const noUsage = preload(`
  globalThis.fetch = async () => Response.json({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(${JSON.stringify(draft)}) } }]
  });
`);

function addSpecialist(directory) {
  const store = new Store(directory);
  try {
    const { teams } = new Harness({ store, dataDirectory: directory, adapters: [] });
    teams.createPersona({ name: 'Researcher', charter: 'Read the fixture.', voice: 'Clear.', stage: 'research' });
  } finally {
    store.close();
  }
}

test('demo reports a denied permission and finishes with a JSON result', t => {
  const directory = fixture(t);
  const run = command(directory, ['run', '--headless', '--demo', '--json', '-'], { input: 'Try it' });
  assert.equal(run.status, 0, run.stderr);
  const events = parse(run.stdout);
  assert.equal(events.find(event => event.type === 'permission.resolved')?.data.kind, 'reject_once');
  assert.equal(events.at(-1).type, 'run.result');
  assert.equal(events.at(-1).exitCode, 0);
  assert.equal(events.at(-1).usage, null);
});

test('allow-read admits only a read request', async () => {
  const { headlessChoice } = await import('../src/cli/render/json.mjs');
  const options = [{ id: 'yes', kind: 'allow_once' }, { id: 'no', kind: 'reject_once' }];
  for (const effect of ['read', 'write', 'destructive', 'credential', undefined]) {
    assert.equal(headlessChoice({ effect, options }, 'allow-read'), effect === 'read' ? 'yes' : 'no');
    assert.equal(headlessChoice({ effect, options }, 'deny'), 'no');
  }
});

test('headless run reports missing provider and missing counts truthfully', t => {
  const directory = fixture(t);
  const absent = command(directory, ['run', '--headless', '--json', 'Task']);
  assert.equal(absent.status, 1, absent.stderr);
  assert.match(absent.stderr, /--api-base/);
  assert.equal(result(absent.stdout).exitCode, 1);
  addSpecialist(directory);
  const run = command(directory, ['run', '--headless', '--json', '--token-limit', '10', ...model, 'Task'], { preload: noUsage });
  assert.equal(run.status, 4, run.stderr);
  assert.equal(result(run.stdout).usage, null);
  const plain = command(directory, ['run', '--headless', '--token-limit', '10', ...model, 'Task'], { preload: noUsage });
  assert.equal(plain.status, 4, plain.stderr);
  assert.match(plain.stdout, /unreported/);
});

test('call and measured token limits exit 4 after only one provider call', t => {
  const directory = fixture(t);
  addSpecialist(directory);
  const fake = preload(`
    let calls = 0;
    globalThis.fetch = async () => {
      if (++calls > 1) throw Error('Unexpected second call');
      return Response.json({
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(${JSON.stringify(draft)}) } }]
      });
    };
  `);
  for (const limits of [['--max-calls', '1'], ['--token-limit', '7']]) {
    const run = command(directory, ['run', '--headless', '--json', ...model, ...limits, 'Task'], { preload: fake });
    assert.equal(run.status, 4, run.stderr);
    assert.equal(result(run.stdout).status, 'limit');
    assert.equal(result(run.stdout).usage.total, 9);
    assert.equal(result(run.stdout).calls, 1);
  }
});

test('export masks workspace paths and JSON replay preserves bytes without opening a store', t => {
  const directory = fixture(t);
  const output = join(directory, 'record.jsonl');
  const run = command(directory, ['run', '--headless', '--demo', '--json', '--workspace', directory, 'Read ' + join(directory, 'fixture.txt')]);
  assert.equal(run.status, 0, run.stderr);
  const list = command(directory, ['sessions', 'list', '--json']);
  const [session] = JSON.parse(list.stdout);
  const exported = command(directory, ['sessions', 'export', session.id, '--jsonl', '--out', output]);
  assert.equal(exported.status, 0, exported.stderr);
  const raw = readFileSync(output, 'utf8');
  assert.equal(parse(raw)[0].type, 'session.header');
  assert.ok(raw.includes('$WORKSPACE/fixture.txt'));
  assert.ok(!raw.includes(directory));
  const open = () => {
    const store = new Store(directory);
    try { return store.eventsAfter(session.id, 0).length; }
    finally { store.close(); }
  };
  const before = open();
  const replayed = command(join(directory, 'never-created'), ['replay', output, '--json'], {
    preload: preload("globalThis.fetch = () => { throw Error('Unexpected fetch'); };"),
  });
  assert.equal(replayed.status, 0, replayed.stderr);
  assert.equal(replayed.stdout, raw);
  assert.equal(open(), before);
});

test('Forget without explicit confirmation leaves the note and epoch intact', t => {
  const directory = fixture(t);
  const store = new Store(directory);
  const harness = new Harness({ store, dataDirectory: directory, adapters: [] });
  const team = harness.teams.create({ name: 'Fixture' });
  const note = harness.teams.note(team.id, { text: 'Keep this fixture' });
  const denied = command(directory, ['memory', 'forget', note.id]);
  assert.equal(denied.status, 2, denied.stderr);
  assert.equal(harness.teams.detail(team.id).team.epoch, 0);
  assert.equal(harness.teams.detail(team.id).notes[0].id, note.id);
  store.close();
});

test('interrupt during interactive demo cancels the pending permission', { skip: process.platform === 'win32', timeout: 5000 }, async t => {
  const directory = fixture(t);
  const child = spawn(process.execPath, [bin, 'chat', '--demo', '--data-dir', directory], { stdio: 'pipe' });
  t.after(() => child.kill());
  let stdout = '';
  let signalled = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (!signalled && stdout.includes('Permission requested  Read workspace notes')) {
      signalled = true;
      child.kill('SIGINT');
    }
  });
  child.stdin.write('Inspect the fixture\n');
  assert.deepEqual(await once(child, 'exit'), [130, null]);
  const store = new Store(directory);
  try {
    const [session] = store.listSessions();
    const events = store.eventsAfter(session.id, 0);
    assert.equal(events.find(event => event.type === 'permission.resolved').data.kind, 'cancelled');
    assert.equal(events.at(-1).data.status, 'stopped');
  } finally { store.close(); }
});

test('doctor distinguishes unchecked items and uses the injected model catalog', t => {
  const directory = fixture(t);
  const unconfigured = command(directory, ['doctor', '--json']);
  assert.equal(unconfigured.status, 0, unconfigured.stderr);
  assert.equal(JSON.parse(unconfigured.stdout).find(row => row.check === 'Endpoint rule').status, 'unknown');
  const fake = preload(`
    globalThis.fetch = async (url, request) => {
      if (!url.endsWith('/models') || request.redirect !== 'error' || !request.signal) throw Error('Wrong request');
      return Response.json({ data: [] });
    };
  `);
  const checked = command(directory, ['doctor', '--json', '--probe', '--api-base', base], { preload: fake });
  assert.equal(checked.status, 0, checked.stderr);
  const checks = JSON.parse(checked.stdout);
  assert.equal(checks.find(row => row.check === 'SQLite').status, 'pass');
  assert.equal(checks.find(row => row.check === 'Model catalog').status, 'pass');
  assert.equal(checks.find(row => row.check === 'TTY').status, 'unknown');
});

test('help and version work for every subcommand without opening a store', t => {
  const directory = fixture(t);
  for (const commandName of ['chat', 'run', 'doctor', 'sessions', 'replay', 'memory']) {
    const help = command(directory, [commandName, '--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.ok(help.stdout.includes('bloom ' + commandName));
    const reported = command(directory, [commandName, '--version']);
    assert.equal(reported.status, 0, reported.stderr);
    assert.equal(reported.stdout.trim(), version);
  }
});
