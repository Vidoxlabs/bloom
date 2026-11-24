import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox, sandboxGit } from '../scripts/make-sandbox.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bloom-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('hidden-off-by-default', async t => {
  const { walkWorkspace } = await import('../src/workspace-context-files.mjs');
  const root = fixture(t);
  writeFileSync(join(root, '.hidden'), 'fixture');
  writeFileSync(join(root, 'notes.txt'), 'visible');
  assert.deepEqual(walkWorkspace(root).files.map(file => file.path), ['notes.txt']);
  assert.deepEqual(walkWorkspace(root).omitted, [{ path: '.hidden', reason: 'hidden' }]);
  assert.deepEqual(walkWorkspace(root, { includeHidden: true }).files.map(file => file.path), ['.hidden', 'notes.txt']);
});

test('secret-file-denied-even-when-included', async t => {
  const { walkWorkspace } = await import('../src/workspace-context-files.mjs');
  const root = fixture(t);
  for (const name of ['.env.local', 'sample.pem', 'credentials.json']) writeFileSync(join(root, name), 'inert fixture');
  const found = walkWorkspace(root, { includeHidden: true, include: ['.env.local', 'sample.pem', 'credentials.json'] });
  assert.deepEqual(found.files, []);
  assert.deepEqual(found.omitted, ['.env.local', 'credentials.json', 'sample.pem'].map(path => ({ path, reason: 'denied' })));
});

test('binary-omitted-with-reason', async t => {
  const { walkWorkspace } = await import('../src/workspace-context-files.mjs');
  const root = fixture(t);
  writeFileSync(join(root, 'fixture.bin'), Buffer.from([65, 0, 66]));
  const found = walkWorkspace(root);
  assert.deepEqual(found.files, []);
  assert.deepEqual(found.omitted, [{ path: 'fixture.bin', reason: 'binary' }]);
});

test('absolute-paths-never-rendered', async t => {
  const { walkWorkspace } = await import('../src/workspace-context-files.mjs');
  const root = fixture(t);
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'note.txt'), 'note');
  const found = walkWorkspace(root);
  assert.equal(JSON.stringify(found).includes(root), false);
  assert.deepEqual(found.files, [{
    path: 'docs/note.txt', bytes: 4, sha256: createHash('sha256').update('note').digest('hex'),
  }]);
  assert.throws(() => walkWorkspace(root, { include: [join(root, 'docs')] }), error => !error.message.includes(root));
});

test('symlinked-folder-is-not-walked', async t => {
  const { walkWorkspace } = await import('../src/workspace-context-files.mjs');
  const root = fixture(t);
  const target = join(root, 'target');
  mkdirSync(target);
  writeFileSync(join(target, 'note.txt'), 'note');
  try {
    symlinkSync(target, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EACCES', 'ENOTSUP', 'ENOSYS', 'EPERM'].includes(error.code)) return t.skip('Directory links unavailable');
    throw error;
  }
  const found = walkWorkspace(root);
  assert.deepEqual(found.files.map(file => file.path), ['target/note.txt']);
  assert.deepEqual(found.unknown, [{ path: 'linked', reason: 'symlink' }]);
});

test('workspace-context-holds-file-and-byte-bounds', async t => {
  const { walkWorkspace } = await import('../src/workspace-context-files.mjs');
  const root = fixture(t);
  for (const name of ['a.txt', 'b.txt']) writeFileSync(join(root, name), 'note');
  const found = walkWorkspace(root, { limits: { maxFiles: 1, maxBytes: 5 } });
  assert.equal(found.files.length, 1);
  assert.deepEqual(found.omitted, [{ path: 'b.txt', reason: 'out-of-budget' }]);
});

test('diff-unknown-when-git-absent', async t => {
  const { readGitContext } = await import('../src/workspace-git-context.mjs');
  const root = fixture(t);
  assert.deepEqual(readGitContext(root, { git: join(root, 'absent-git') }), { status: 'unknown', reason: 'git-unavailable' });
  assert.deepEqual(readGitContext(root, { execute: () => ({ status: 128 }) }), { status: 'unknown', reason: 'git-failed' });
});

test('git-context-reports-relative-changes-and-commit-identities', async t => {
  const { readGitContext } = await import('../src/workspace-git-context.mjs');
  const root = join(fixture(t), 'sandbox');
  makeSandbox(root);
  const range = join(root, 'src', 'range.mjs');
  writeFileSync(range, 'fixture change\n');
  const context = readGitContext(root);
  assert.equal(context.status, 'known');
  assert.deepEqual(context.diff, [{ status: 'M', path: 'src/range.mjs' }]);
  assert.deepEqual(context.log, [sandboxGit(root, 'rev-parse', 'HEAD').stdout.trim()]);
  assert.equal(JSON.stringify(context).includes(root), false);
});
