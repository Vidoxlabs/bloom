import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness } from '../src/harness.mjs';
import { Store } from '../src/store.mjs';
import { demoProvider, createChatProvider, createServerProvider } from '../src/models.mjs';

function setup(t, generate = demoProvider.generate) {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'bloom-team-'));
  const store = new Store(dataDirectory), calls = [];
  const provider = { ...demoProvider, generate: async input => { calls.push(input); return generate(input); } };
  const harness = new Harness({ store, dataDirectory, adapters: [], teamProvider: provider });
  t.after(async () => { await harness.close(); store.close(); rmSync(dataDirectory, { recursive: true, force: true }); });
  return { harness, store, calls, teams: harness.teams, dataDirectory };
}
async function run(h, id, body) {
  const { turnId } = h.start(id, { text: 'Produce a reviewed guide.', ...body });
  await h.active.get(id).task;
  const events = h.store.eventsAfter(id, 0).filter(e => e.turnId === turnId);
  return { events, outcome: events.at(-1).data, posts: events.filter(e => e.type === 'team.message').map(e => e.data) };
}
test('a head creates specialists who exchange durable, hash-linked documents on one shared desktop', async t => {
  const { teams, harness, calls, dataDirectory } = setup(t);
  const a = teams.create({ name: 'Editorial lead' }), b = teams.create({ name: 'Other head' });
  const source = await teams.source(a.id, { title: 'Project notes', text: 'The baseline is 13 units.' });
  const first = await run(harness, a.id, { files: [source.id] });
  assert.equal(first.outcome.status, 'finished');
  assert.deepEqual(first.posts.map(p => p.author), ['Editorial lead','Researcher','Reviewer','Assembler']);
  assert.match(calls[2].prompt, /The source findings are ready for review/);
  assert.equal(first.posts[2].verdict, 'approve');
  const final = teams.store.read(b.id, first.posts[3].file.id);
  assert.equal(final.parents.length, 3);
  assert.deepEqual(teams.detail(b.id).members, []);
  const reopened = new Store(dataDirectory);
  try {
    const next = new Harness({ store: reopened, dataDirectory, adapters: [], teamProvider: demoProvider });
    assert.equal(next.teams.store.read(a.id, final.id).sha256, final.sha256);
    assert.equal(next.teams.detail(a.id).members.length, 3);
    const direct = await run(next, a.id, { text: '@Reviewer: Check the file', files: [final.id] });
    assert.deepEqual(direct.posts.map(p => p.author), ['Reviewer']);
    await next.close();
  } finally { reopened.close(); }
  writeFileSync(join(teams.store.desktop, final.filename), 'changed offline');
  assert.throws(() => teams.store.read(b.id, final.id), { code: 'FILE_CHANGED' });
});

test('a revision request and malformed model plans stop downstream execution', async t => {
  const { teams, harness } = setup(t, async input => {
    const response = await demoProvider.generate(input);
    if (input.agent?.stage === 'review') response.text = JSON.stringify({ ...JSON.parse(response.text), verdict: 'revise' });
    if (input.brief === 'Invalid') response.text = '{"agents":[]}';
    return response;
  });
  const s = teams.create({});
  const { outcome, posts } = await run(harness, s.id);
  assert.equal(outcome.status, 'revision');
  assert.deepEqual(posts.map(x => x.author), ['Head agent','Researcher','Reviewer']);
  const second = await run(harness, s.id, { text: 'Invalid' });
  assert.equal(second.outcome.code, 'TEAM_PROTOCOL');
});

test('consented memory is scoped and forgetting invalidates derived files, history and cached retrieval', async t => {
  const { teams, harness, calls } = setup(t);
  const a = teams.create({}), b = teams.create({});
  const source = await teams.source(a.id, { title: 'Public detail', text: 'Accessible to the whole desktop.' });
  const note = teams.note(a.id, { text: 'private-canary' });
  assert.throws(() => teams.forget(b.id, note.id), { code: 'NOTE_MISSING' });
  const first = await run(harness, a.id, { files: [source.id] });
  const privateFile = first.posts.at(-1).file.id;
  assert.ok(first.events.some(e => e.type === 'team.recall' && e.data.hit));
  assert.ok(calls.slice(1).some(c => c.prompt.includes('private-canary')));
  assert.throws(() => teams.store.read(b.id, privateFile), { code: 'FILE_UNAVAILABLE' });
  teams.forget(a.id, note.id);
  assert.throws(() => teams.store.read(a.id, privateFile), { code: 'FILE_UNAVAILABLE' });
  assert.equal(teams.store.read(b.id, source.id).id, source.id);
  const before = calls.length;
  await run(harness, a.id, { to: 'Researcher', text: 'What do we have?' });
  assert.ok(calls.slice(before).every(c => !c.prompt.includes('private-canary') && !c.prompt.includes(privateFile)));
  assert.deepEqual(teams.detail(a.id).notes, []);
});

test('bounded calls, missing token counts, provider counts and deterministic logical agents', async t => {
  const { teams, harness } = setup(t, async input => {
    const response = await demoProvider.generate(input);
    if (input.brief === 'Verify only' && input.phase === 'plan') response.text = JSON.stringify({ message: 'Verify files.', agents: [
      { name: 'Evidence clerk', stage: 'verify', charter: 'Verify file hashes.', assignment: 'Check attached material.' },
    ] });
    if (input.brief === 'Measured') response.usage = { total: 101, input: 75, output: 26, cacheRead: 64, cacheWrite: 0 };
    return response;
  });
  for (const [options, text, expected] of [[{callLimit:1}, 'Cap', 'limit'], [{tokenLimit:100}, 'Unknown', 'limit'], [{tokenLimit:100}, 'Measured', 'limit'], [{callLimit:1}, 'Verify only','finished']]) {
    const a = teams.create(options);
    const file = await teams.source(a.id, { title:'Evidence', text:'Original' });
    const { outcome, events } = await run(harness, a.id, { text, files: [file.id] });
    assert.equal(outcome.status, expected);
    assert.equal(events.filter(e => e.type === 'team.call').length, 1);
    if (text === 'Measured') assert.equal(events.find(e => e.type === 'team.usage').data.usage.cacheRead,64);
  }
});

test('OpenCode HTTP adapters send the selected model and preserve cache semantics', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, ...options });
    if (url.endsWith('/session')) return Response.json({ id: 'ses_fixture' });
    if (url.endsWith('/message')) return Response.json({ info: { role: 'assistant', finish:'stop', providerID:'local',modelID:'model',tokens:{input:10,output:5,reasoning:0,cache:{read:2,write:0}},cost:0 }, parts:[{type:'text',text:'result'}] });
    return Response.json({ choices:[{finish_reason:'stop',message:{content:'result'}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15,prompt_tokens_details:{cached_tokens:2}} });
  };
  const input = { system:'Role',prompt:'Question',model:'local/model',signal:new AbortController().signal };
  const consoleResult = await createChatProvider({ apiKey:'test-only', fetcher }).generate(input);
  assert.equal(consoleResult.usage.total,15);
  assert.equal(consoleResult.usage.cacheRead,2);
  assert.equal(consoleResult.usage.cacheWrite,null);
  assert.equal(consoleResult.usage.costUSD,null);
  assert.equal(calls[0].url,'https://opencode.ai/inference/openai/v1/chat/completions');
  const server = await createServerProvider({baseURL:'http://127.0.0.1:5555',fetcher}).generate(input);
  assert.equal(server.usage.total,17);
  assert.equal(JSON.parse(calls[1].body).permission[0].action,'deny');
  assert.deepEqual(JSON.parse(calls[2].body).model,{ providerID:'local', modelID:'model' });
  assert.throws(() => createChatProvider({baseURL:'http://remote.example'}));
});

test('forget during a model call prevents a late reply from being handed off', async t => {
  let release, started;
  const wait = new Promise(resolve => { started = resolve; });
  const { teams, harness } = setup(t, async input => {
    if (input.phase === 'work') { started(); await new Promise(resolve => { release = resolve; }); }
    return demoProvider.generate(input);
  });
  const a = teams.create({});
  const note = teams.note(a.id,{text:'private'});
  harness.start(a.id,{text:'Write'});
  const task = harness.active.get(a.id).task;
  await wait;
  teams.forget(a.id,note.id);
  release();
  await task;
  assert.equal(teams.store.files(a.id).length,0);
  assert.equal(harness.store.eventsAfter(a.id,0).at(-1).data.status,'stopped');
});

test('duplicate submissions reuse one turn and one budget even after completion', async t => {
  const { harness, teams, calls } = setup(t);
  const room = teams.create({});
  const request = { text:'Make a guide.',requestId:'fixture-request-0001' };
  const first = harness.start(room.id,request);
  assert.deepEqual(harness.start(room.id,request),first);
  await harness.active.get(room.id).task;
  assert.deepEqual(harness.start(room.id,request),first);
  assert.equal(calls.length,4);
  assert.throws(() => harness.start(room.id,{...request,text:'Different brief'}),{code:'REQUEST_CONFLICT'});
});

test('specialists revise, rename and file supplied desktop files as hash-linked revisions', async t => {
  let script = null;
  const { teams, harness } = setup(t, async input => {
    if (!script || (input.phase === 'plan' && !script.plan)) return demoProvider.generate(input);
    const result = input.phase === 'plan' ? script.plan : script.work(input);
    return { text: JSON.stringify(result), complete: true, model: 'fixture', usage: {} };
  });
  const a = teams.create({ name: 'Desk lead' }), b = teams.create({ name: 'Other head' });
  const source = await teams.source(a.id, { title: 'Project notes', text: 'The baseline is 13 units.' });

  const first = await run(harness, a.id, { files: [source.id] });
  const guide = first.posts[3].file;
  assert.equal(guide.folder, 'Guides');
  assert.equal(first.posts[1].file.folder, 'Research');

  const second = await run(harness, a.id, { files: [guide.id] });
  const revised = second.posts.at(-1).file;
  assert.equal(second.outcome.status, 'finished');
  assert.deepEqual([revised.root, revised.revision, revised.folder], [guide.id, 2, 'Guides']);
  assert.equal(teams.store.read(b.id, revised.id).parents[0], guide.id);
  for (const id of [a.id, b.id]) {
    const listed = teams.detail(id).files.filter(f => f.root === guide.id);
    assert.deepEqual(listed.map(f => [f.id, f.revision]), [[revised.id, 2]]);
  }
  assert.deepEqual(teams.store.history(b.id, guide.id).map(f => [f.id, f.revision]), [[guide.id, 1], [revised.id, 2]]);
  assert.equal(teams.store.read(a.id, guide.id).revision, 1, 'earlier revisions stay readable');

  const plan = { message: 'Filing the desktop.', agents: [{ name: 'Organizer', stage: 'work', charter: 'Keep the desktop tidy.', voice: 'Brief.', assignment: 'File the notes.' }], readFiles: [source.id] };
  const organized = (extra) => ({ message: 'Filed.', title: 'Filing log', document: 'Moved the notes.', ...extra });
  script = { plan, work: () => organized({ moves: [{ file: source.id, folder: 'Sources/Client', title: 'Client notes' }] }) };
  const third = await run(harness, a.id, {});
  assert.equal(third.outcome.status, 'finished');
  const moved = teams.detail(b.id).files.find(f => f.root === source.id);
  assert.deepEqual([moved.title, moved.folder, moved.revision, moved.sha256], ['Client notes', 'Sources/Client', 2, source.sha256]);
  assert.ok(third.events.some(e => e.type === 'tool.updated' && e.data.title === 'Rename Project notes' && e.data.status === 'completed'));

  for (const bad of [{ revises: '00000000-0000-4000-8000-000000000000' }, { folder: '../outside' }, { moves: [{ file: source.id }] }, { moves: [{ file: guide.id, folder: 'X' }] }]) {
    script = { plan: { ...plan, readFiles: [moved.id] }, work: () => organized(bad) };
    assert.equal((await run(harness, a.id, {})).outcome.code, 'TEAM_PROTOCOL', JSON.stringify(bad));
  }

  const note = teams.note(a.id, { text: 'private-canary' });
  script = { plan: { ...plan, readFiles: [revised.id] }, work: () => organized({ title: 'Private guide', revises: revised.id }) };
  const fourth = await run(harness, a.id, {});
  const scoped = fourth.posts.at(-1).file;
  assert.equal(scoped.revision, 3);
  assert.equal(teams.detail(a.id).files.find(f => f.root === guide.id).id, scoped.id);
  assert.equal(teams.detail(b.id).files.find(f => f.root === guide.id).id, revised.id, 'other teams keep the shareable revision');
  teams.forget(a.id, note.id);
  assert.equal(teams.detail(a.id).files.find(f => f.root === guide.id).id, revised.id, 'Forget withdraws the note-derived revision');
});
