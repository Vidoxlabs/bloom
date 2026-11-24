import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { lineRenderer } from '../src/cli/render/line.mjs';
import { approvalCard, approvalPayload } from '../public/coding-view.js';
import { copyDemoRepo, openCodingSession } from './fixtures/coding-session.mjs';
import { action, scriptedProvider } from './fixtures/demo-provider.mjs';

const finish = action('run.answer.create', { text: 'Done.' });
const proposed = action('workspace.file.write', { path: 'NOTES.md', content: 'Model text' });

function session(t, reply = proposed) {
  const root = mkdtempSync(join(tmpdir(), 'bloom-approval-'));
  const provider = scriptedProvider([reply, finish]);
  const opened = openCodingSession({
    workspace: copyDemoRepo(join(root, 'workspace')),
    dataDirectory: join(root, 'data'), provider, runtime: { interactiveDecisions: true },
  });
  t.after(async () => {
    await opened.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { ...opened, provider };
}

test('terminal-and-browser-approval-baseline', async () => {
  let output = '';
  const stdout = { write(text) { output += text; } };
  const renderer = lineRenderer({ stdout, nextLine: async () => '1' });
  const options = [{ id: 'allow-once', kind: 'allow_once', label: 'Allow once' }, { id: 'reject', kind: 'reject_once', label: 'Reject' }];
  assert.equal(await renderer.prompt({ options }), 'allow-once');
  assert.match(output, /1  Allow once/);
  const dom = { createElement(tag) { return {
    tag, children: [], append(...items) { this.children.push(...items); },
    setAttribute() {}, set innerHTML(_text) { assert.fail('Approval detail must be text.'); },
  }; } };
  const card = approvalCard({ title: 'Approve write', detail: '<strong>Complete detail</strong>' }, dom);
  assert.equal(card.children[2].textContent, '<strong>Complete detail</strong>');
});

test('edit-revalidates-and-informs-model', async t => {
  const first = session(t);
  const revised = { path: 'NOTES.md', content: 'Owner text' };
  const result = await first.run('Edit the note.', request => {
    assert.throws(() => first.harness.decide(first.session.id, request.id, {
      optionId: 'edit', argsDigest: request.argsDigest, editedArgs: { path: 'NOTES.md' },
    }), { code: 'PERMISSION_EDIT_INVALID' });
    return { kind: 'edit', editedArgs: revised };
  });
  assert.equal(result.ending.status, 'finished');
  assert.equal(readFileSync(join(first.session.workspace, 'NOTES.md'), 'utf8'), 'Owner text');
  assert.match(first.provider.prompts[1], /Owner-edited arguments ran/);
  const receipt = result.events.find(event => event.type === 'permission.resolved').data;
  assert.equal(receipt.decision, 'edit');
  assert.match(receipt.editedArgsDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(receipt.editedArgsDigest, receipt.argsDigest);
});

test('terminal-and-web-decision-input-stays-bound-to-the-request', async () => {
  const answers = ['1', '{"path":"NOTES.md","content":"Edited"}', '2', 'Owner input'];
  const renderer = lineRenderer({ stdout: { write() {} }, nextLine: async () => answers.shift() });
  const edit = { id: 'edit', kind: 'edit', label: 'Edit arguments' };
  const respond = { id: 'respond', kind: 'respond', label: 'Respond as owner' };
  const options = [edit, respond];
  const selected = await renderer.prompt({ options });
  assert.deepEqual(selected, { optionId: 'edit', editedArgs: { path: 'NOTES.md', content: 'Edited' } });
  assert.deepEqual(await renderer.prompt({ options }), { optionId: 'respond', text: 'Owner input' });
  assert.deepEqual(approvalPayload(edit, 'binding', JSON.stringify(selected.editedArgs)), { ...selected, argsDigest: 'binding' });
  assert.deepEqual(approvalPayload(respond, 'binding', 'Owner input'), { optionId: 'respond', argsDigest: 'binding', text: 'Owner input' });
});

test('respond-marks-owner-input', async t => {
  const opened = session(t);
  const report = await opened.run('Ask the owner.', () => ({ kind: 'respond', text: 'Owner answer' }));
  assert.equal(report.ending.status, 'finished');
  assert.equal(existsSync(join(opened.session.workspace, 'NOTES.md')), false);
  assert.match(opened.provider.prompts[1], /Owner input:\n"Owner answer"/);
  assert.doesNotMatch(opened.provider.prompts[1], /Result:\nOwner answer/);
});

test('destructive-and-credential-disallow-respond', async () => {
  const { permissionDecision } = await import('../src/permission-decision.mjs');
  for (const effect of ['destructive', 'credential', 'execute']) {
    assert.throws(() => permissionDecision({ effect, argsDigest: 'digest' }, { id: 'respond', kind: 'respond' },
      { argsDigest: 'digest', text: 'fixture' }), { code: 'PERMISSION_RESPONSE_REFUSED' });
  }
});

test('digest-mismatch-voids-approval', async t => {
  const opened = session(t);
  await opened.run('Write a note.', request => {
    assert.throws(() => opened.harness.decide(opened.session.id, request.id, {
      optionId: 'allow-once', argsDigest: 'different',
    }), { code: 'PERMISSION_DIGEST_MISMATCH' });
    return 'reject_once';
  });
  assert.equal(existsSync(join(opened.session.workspace, 'NOTES.md')), false);
});

test('bloom-emits-permission-events', async t => {
  const opened = session(t);
  const { events } = await opened.run('Ask the owner.', () => ({ kind: 'respond', text: 'Private to the fixture model' }));
  const pending = events.find(event => event.type === 'permission.requested').data;
  const resolved = events.find(event => event.type === 'permission.resolved').data;
  assert.match(pending.argsDigest, /^[0-9a-f]{64}$/);
  assert.equal(resolved.id, pending.id);
  assert.equal(resolved.callId, pending.callId);
  assert.equal(resolved.argsDigest, pending.argsDigest);
  assert.equal(resolved.decision, 'respond');
  assert.equal(JSON.stringify(resolved).includes('Private to the fixture model'), false);
});
