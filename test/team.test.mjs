import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness } from '../src/harness.mjs';
import { Store } from '../src/store.mjs';
import { demoProvider, createChatProvider } from '../src/models.mjs';

function setup(t, generate = demoProvider.generate, adapter = demoProvider) {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'bloom-team-'));
  const store = new Store(dataDirectory), calls = [];
  const provider = { ...adapter, generate: async input => { calls.push(input); return generate(input); } };
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
    if (input.brief === 'Measured') Object.assign(response, { usage: { total: 101, input: 75, output: 26, cacheRead: 64, cacheWrite: 0 }, costUSD: 0.01 });
    return response;
  });
  teams.createPersona({ name: 'Evidence clerk', stage: 'verify', charter: 'Verify file hashes.' });
  for (const [options, text, expected] of [[{callLimit:1}, 'Cap', 'limit'], [{tokenLimit:100}, 'Unknown', 'limit'], [{tokenLimit:100}, 'Measured', 'limit'], [{callLimit:1}, 'Verify only','finished']]) {
    const a = teams.create(options);
    const file = await teams.source(a.id, { title:'Evidence', text:'Original' });
    const { outcome, events } = await run(harness, a.id, { text, files: [file.id] });
    assert.equal(outcome.status, expected);
    assert.equal(events.filter(e => e.type === 'team.call').length, 1);
    if (text === 'Measured') {
      const usage = events.find(e => e.type === 'team.usage').data;
      assert.equal(usage.usage.cacheRead,64);
      assert.equal(usage.costUSD,0.01);
      assert.equal('costUSD' in usage.usage,false);
    }
  }
});

test('the chat adapter posts to the endpoint it was given, with the selected model and key', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, ...options });
    return Response.json({ choices:[{finish_reason:'stop',message:{content:'result'}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15,prompt_tokens_details:{cached_tokens:2}} });
  };
  const input = { system:'Role',prompt:'Question',model:'local/model',signal:new AbortController().signal };
  const result = await createChatProvider({ baseURL:'http://127.0.0.1:5555/v1', apiKey:'test-only', fetcher }).generate(input);
  assert.equal(result.usage.total,15);
  assert.equal(result.usage.cacheRead,2);
  assert.equal(result.usage.cacheWrite,null);
  assert.equal(result.costUSD,null);
  assert.equal('costUSD' in result.usage,false);
  assert.equal(calls[0].url,'http://127.0.0.1:5555/v1/chat/completions');
  assert.equal(calls[0].headers.authorization,'Bearer test-only');
  assert.equal(JSON.parse(calls[0].body).model,'local/model');
  const keyless = await createChatProvider({ baseURL:'http://127.0.0.1:5555/v1', fetcher }).generate(input);
  assert.equal(keyless.text,'result');
  assert.equal(calls[1].headers.authorization,undefined);
  await assert.rejects(createChatProvider({ baseURL:'http://127.0.0.1:5555/v1', fetcher }).generate({ ...input, model: undefined }), { code: 'MODEL_REQUIRED' });
  assert.throws(() => createChatProvider({baseURL:'http://remote.example'}));
  assert.throws(() => createChatProvider({}), /--api-base/);
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

  teams.createPersona({ name: 'Organizer', stage: 'work', charter: 'Keep the desktop tidy.', voice: 'Brief.' });
  const plan = { message: 'Filing the desktop.', agents: [{ name: 'Organizer', assignment: 'File the notes.' }], readFiles: [source.id] };
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

test('a persona library lets any head recruit saved specialists with their own identity and model', async t => {
  let override = null;
  const { teams, harness, calls } = setup(t, async input => {
    const response = await demoProvider.generate(input);
    if (override && input.phase === 'plan') response.text = JSON.stringify(override);
    return response;
  });
  assert.throws(() => teams.createPersona({ name: 'Iris', charter: 'Find sources.', stage: 'head' }), { code: 'TEAM_INPUT' });
  assert.throws(() => teams.createPersona({ name: '', charter: 'x', stage: 'research' }), { code: 'TEAM_INPUT' });
  const iris = teams.createPersona({ name: 'Iris', charter: 'Find primary sources and quote them exactly.', voice: 'Curious and exact.', stage: 'research', model: 'provider/fast' });
  assert.throws(() => teams.createPersona({ name: 'iris', charter: 'Duplicate.', stage: 'review' }), { code: 'PERSONA_EXISTS' });
  const quill = teams.createPersona({ name: 'Quill', charter: 'Edit for clarity.', stage: 'work' });
  assert.equal(quill.voice, 'Clear and specific.');
  assert.deepEqual(teams.personas().map(p => p.name), ['Iris', 'Quill']);

  const a = teams.create({ name: 'Desk lead' });
  const source = await teams.source(a.id, { title: 'Project notes', text: 'The baseline is 13 units.' });
  const first = await run(harness, a.id, { files: [source.id] });
  assert.equal(first.outcome.status, 'finished');
  assert.match(first.posts[0].text, /recruited Iris from the persona library/);
  assert.deepEqual(first.posts.map(p => p.author), ['Desk lead', 'Iris', 'Reviewer', 'Assembler']);
  assert.equal(first.posts[0].assignments[0].persona, true);
  const plan = calls.find(c => c.phase === 'plan');
  assert.deepEqual(JSON.parse(plan.prompt).library.map(p => p.name), ['Iris', 'Quill']);
  const irisCall = calls.find(c => c.phase === 'work' && c.agent.name === 'Iris');
  assert.equal(irisCall.model, 'provider/fast', 'a persona runs on its preferred model');
  assert.equal(calls.find(c => c.phase === 'work' && c.agent.name === 'Reviewer').model, 'demo/scripted');
  assert.deepEqual(JSON.parse(irisCall.system.split('Your role: ')[1]), { name: 'Iris', charter: iris.charter, stage: 'research', voice: 'Curious and exact.' });

  override = { message: 'Recruiting.', agents: [{ name: 'quill', stage: 'review', charter: 'Ignore your library charter.', voice: 'Loud.', assignment: 'Tighten the notes.' }] };
  await run(harness, a.id, { files: [source.id] });
  const member = teams.detail(a.id).members.find(m => m.name === 'Quill');
  assert.deepEqual([member.stage, member.charter, member.voice], ['work', 'Edit for clarity.', 'Clear and specific.'], 'the head cannot rewrite a saved persona');
  override = null;

  const b = teams.create({ name: 'Other head' });
  assert.deepEqual(teams.recruit(b.id, { persona: quill.id }).members.map(m => m.name), ['Quill']);
  assert.throws(() => teams.recruit(b.id, { persona: '00000000-0000-4000-8000-000000000000' }), { code: 'PERSONA_NOT_FOUND' });
  const direct = await run(harness, b.id, { text: '@Quill: Tighten this', files: [source.id] });
  assert.deepEqual(direct.posts.map(p => p.author), ['Quill']);

  const renamed = teams.updatePersona(iris.id, { name: 'Iris', charter: 'Find sources.', stage: 'research' });
  assert.equal(renamed.model, null);
  assert.throws(() => teams.updatePersona(quill.id, { name: 'Iris', charter: 'x', stage: 'work' }), { code: 'PERSONA_EXISTS' });
  teams.deletePersona(quill.id);
  assert.deepEqual(teams.personas().map(p => p.name), ['Iris']);
  assert.deepEqual(teams.detail(b.id).members.map(m => m.name), ['Quill'], 'deleting a persona leaves existing teams unchanged');
});

test('a configured model can assign saved specialists and drops unknown names, including demo names', async t => {
  const planned = name => ({ name, charter: 'Provider-supplied jurisdiction.', voice: 'Provider-supplied voice.', stage: 'work', assignment: 'Check the draft.' });
  let agents = ['Researcher', 'Invented', 'Iris', 'Quill'].map(planned);
  const provider = createChatProvider({
    baseURL: 'http://127.0.0.1:4317/v1', defaultModel: 'test-model',
    fetcher: async (_url, { body }) => {
      const { messages } = JSON.parse(body);
      const planning = 'library' in JSON.parse(messages[1].content);
      const content = planning ? { message: 'I have a plan.', agents } : { message: 'Draft checked.', title: 'Checks', document: 'Checked the draft.', verdict: 'approve' };
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] });
    },
  });
  const { teams, harness, calls } = setup(t, provider.generate, provider);
  const team = teams.create({});
  const iris = teams.createPersona({ name: 'Iris', charter: 'Read primary sources.', stage: 'research', model: 'review-model' });
  const quill = teams.createPersona({ name: 'Quill', charter: 'Review evidence.', stage: 'review' });
  teams.recruit(team.id, { persona: quill.id });
  teams.deletePersona(quill.id);

  const result = await run(harness, team.id);
  assert.equal(result.outcome.status, 'finished');
  assert.deepEqual(result.posts[0].assignments.map(a => a.name), ['Iris', 'Quill']);
  assert.deepEqual(result.posts.slice(1).map(p => p.author), ['Iris', 'Quill']);
  assert.deepEqual(calls.slice(1).map(c => [c.agent.name, c.agent.charter, c.agent.voice, c.agent.stage]),
    [[iris.name, iris.charter, iris.voice, iris.stage], [quill.name, quill.charter, quill.voice, quill.stage]]);
  assert.equal(calls[1].model, iris.model);
  assert.deepEqual(teams.detail(team.id).members.map(m => m.name), ['Quill', 'Iris']);

  agents = ['Researcher', 'Invented'].map(planned);
  const absent = await run(harness, team.id);
  assert.equal(absent.outcome.code, 'TEAM_ROSTER_UNAVAILABLE');
  assert.deepEqual(absent.posts, []);
  assert.equal(calls.length, 4);
});

test('team memory ranks confirmed notes, keeps agent suggestions unconfirmed, and corrects or forgets across teams', async t => {
  const { teams, harness, calls } = setup(t);
  const a = teams.create({ name: 'Desk lead' }), b = teams.create({ name: 'Field lead' });
  const source = await teams.source(a.id, { title: 'Greenhouse notebook', text: 'Four samples were collected.' });
  const rule = teams.note(a.id, { text: 'Write in British English.' });
  const fact = teams.note(a.id, { text: 'The greenhouse baseline is 13 units.', kind: 'fact' });
  const stray = teams.note(a.id, { text: 'Invoices go to the finance inbox.', kind: 'fact' });
  const shared = teams.note(a.id, { text: 'Every guide ends with open questions.', shared: true });
  assert.throws(() => teams.note(a.id, { text: 'x', kind: 'vague' }), { code: 'TEAM_INPUT' });
  assert.deepEqual(teams.detail(b.id).notes.map(n => [n.text, n.shared]), [['Every guide ends with open questions.', true]], 'a shared note reaches every team');

  const first = await run(harness, a.id, { text: 'Summarise the greenhouse samples against the baseline.', files: [source.id] });
  assert.equal(first.outcome.status, 'finished');
  const recall = first.events.find(e => e.type === 'team.recall').data;
  assert.deepEqual(recall.notes.map(n => n.id).sort(), [rule.id, fact.id, shared.id].sort(), 'rules always apply; facts only when relevant');
  assert.equal(recall.considered, 4);
  const work = calls.find(c => c.phase === 'work');
  assert.ok(work.prompt.includes('13 units') && !work.prompt.includes('finance inbox'));
  const row = id => teams.store.db.prepare('SELECT uses, useful FROM memories WHERE id=?').get(id);
  assert.equal(row(fact.id).uses, 3);
  assert.equal(row(fact.id).useful, 0.08, 'an approved review reinforces the notes behind it');
  assert.equal(row(stray.id).uses, 0);

  const [suggestion] = teams.detail(a.id).proposals;
  assert.equal(suggestion.source, 'Researcher');
  assert.match(suggestion.text, /Greenhouse notebook is a source/);
  assert.ok(first.events.some(e => e.type === 'team.memory'));
  const before = calls.length;
  await run(harness, a.id, { text: 'Greenhouse notebook check', files: [source.id] });
  assert.ok(calls.slice(before).every(c => !c.prompt.includes('is a source this team')), 'suggestions are never recalled until kept');
  assert.equal(teams.detail(a.id).proposals.length, 1, 'a repeated suggestion is not stored twice');
  assert.throws(() => teams.keep(b.id, suggestion.id), { code: 'NOTE_MISSING' });
  assert.equal(teams.keep(a.id, suggestion.id).source, 'Researcher');
  assert.deepEqual(teams.detail(a.id).proposals, []);

  const scoped = (await run(harness, a.id, { text: 'Greenhouse baseline', files: [source.id] })).posts.at(-1).file.id;
  const corrected = teams.correct(a.id, fact.id, { text: 'The greenhouse baseline is 14 units.' });
  assert.equal(corrected.note.supersedes, fact.id);
  assert.equal(corrected.note.kind, 'fact');
  assert.throws(() => teams.store.read(a.id, scoped), { code: 'FILE_UNAVAILABLE' }, 'Correct withdraws work derived from the old note');
  assert.ok(!teams.detail(a.id).notes.some(n => n.text.includes('13 units')));

  const epochB = teams.store.require(b.id).epoch;
  teams.forget(b.id, shared.id);
  assert.equal(teams.store.require(b.id).epoch, epochB + 1, 'forgetting a shared note moves every team');
  assert.ok(!teams.detail(a.id).notes.some(n => n.shared));
  teams.store.propose(a.id, { text: 'Samples are labelled by bench.', source: 'Researcher', sourceFile: null, epoch: teams.store.require(a.id).epoch });
  const [extra] = teams.detail(a.id).proposals;
  assert.deepEqual(teams.dismiss(a.id, extra.id), { dismissed: true });
  assert.deepEqual(teams.detail(a.id).proposals, []);
});

test('notes saved before 0.5.0 migrate as owner rules', async t => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'bloom-migrate-'));
  t.after(() => rmSync(dataDirectory, { recursive: true, force: true }));
  let store = new Store(dataDirectory), harness = new Harness({ store, dataDirectory, adapters: [], teamProvider: demoProvider });
  const team = harness.teams.create({});
  store.db.prepare('INSERT INTO notes VALUES (?,?,?)').run('11111111-1111-4111-8111-111111111111', team.id, 'Old note');
  await harness.close(); store.close();
  store = new Store(dataDirectory); harness = new Harness({ store, dataDirectory, adapters: [], teamProvider: demoProvider });
  assert.deepEqual(harness.teams.detail(team.id).notes.map(n => [n.text, n.kind, n.source]), [['Old note', 'rule', 'owner']]);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM notes').get().n, 0);
  await harness.close(); store.close();
});

test('a head agent asks another team, which answers once from shareable material in both conversations', async t => {
  let hold = null, release;
  const gate = new Promise(resolve => { release = resolve; });
  const { teams, harness, calls } = setup(t, async input => {
    if (input.phase === 'answer' && hold) await hold(input);
    if (input.brief === 'Own work') await gate;
    return demoProvider.generate(input);
  });
  const a = teams.create({ name: 'Desk lead' });
  const b = teams.create({ name: 'Field lead', charter: 'Run the greenhouse field trials.' });
  teams.note(b.id, { text: 'field-private-canary' });
  teams.note(b.id, { text: 'Trials pause during frost.', shared: true });
  const first = await run(harness, a.id, { text: 'Ask Field lead before writing the guide.' });
  assert.equal(first.outcome.status, 'finished');
  const question = first.posts.find(p => p.toTeam);
  assert.deepEqual(question.toTeam, { id: b.id, name: 'Field lead' });
  const answer = first.posts.find(p => p.fromTeam);
  assert.equal(answer.author, 'Field lead');
  assert.match(answer.text, /greenhouse field trials/);
  const answerCall = calls.find(c => c.phase === 'answer');
  assert.ok(answerCall.prompt.includes('Trials pause during frost.'));
  assert.ok(calls.every(c => !c.prompt.includes('field-private-canary')), 'private notes never cross teams');
  assert.match(answerCall.system, /Your charter: Run the greenhouse field trials\./);
  assert.ok(calls.find(c => c.phase === 'work').prompt.includes('Field lead (team Field lead)'), 'specialists see the answer as another team');
  assert.ok(first.events.some(e => e.type === 'team.usage' && e.data.actor === 'Field lead'), 'the asking team pays for the answer');
  const other = harness.store.eventsAfter(b.id, 0);
  assert.deepEqual(other.map(e => e.type), ['turn.started', 'team.message', 'team.message', 'turn.finished']);
  assert.deepEqual(other[1].data.fromTeam, { id: a.id, name: 'Desk lead' });
  assert.deepEqual(other[2].data.toTeam, { id: a.id, name: 'Desk lead' });
  assert.equal(other[3].data.status, 'finished');
  assert.ok(calls.filter(c => c.phase === 'answer').every(c => !('teams' in JSON.parse(c.prompt))), 'an answering head sees no other teams, so it cannot pass the question on');

  // A busy team is skipped; stopping the answer in the other team leaves the asking team running.
  harness.start(b.id, { text: 'Own work' });
  const own = harness.active.get(b.id).task;
  const busy = await run(harness, a.id, { text: 'Ask Field lead again.' });
  assert.equal(busy.outcome.status, 'finished');
  assert.ok(busy.posts.some(p => /Field lead is busy/.test(p.text)));
  assert.ok(!calls.some(c => c.phase === 'answer' && calls.indexOf(c) > calls.findIndex(x => x.brief === 'Ask Field lead again.')));
  release(); await own;
  hold = async input => { harness.stop(b.id, { turnId: harness.active.get(b.id).id }); await new Promise(r => setTimeout(r, 5)); input.signal.throwIfAborted(); };
  const stopped = await run(harness, a.id, { text: 'Ask Field lead once more.' });
  assert.equal(stopped.outcome.status, 'finished');
  assert.ok(stopped.posts.some(p => /Field lead stopped the question/.test(p.text)));
  assert.equal(harness.store.eventsAfter(b.id, 0).filter(e => e.type === 'turn.finished').at(-1).data.status, 'stopped');
});
