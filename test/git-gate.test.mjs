import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { fixture } from './fixtures/shell-gate.mjs';

test('file-tools-refuse-writes-under-dot-git', async t => {
  const { root, tools } = await fixture(t);
  await mkdir(join(root, '.git', 'hooks'), { recursive: true });
  await mkdir(join(root, 'nested', '.git'), { recursive: true });
  await writeFile(join(root, '.git', 'config'), '[core]\n');
  await writeFile(join(root, 'nested', '.git', 'config'), '[core]\n');
  for (const path of ['.git/config', '.git/hooks/pre-commit', '.GIT/HEAD', 'nested/.git/config']) {
    await assert.rejects(
      tools.execute('workspace.file.write', { path, content: 'bad\n' }),
      { code: 'WORKSPACE_DOT_GIT_REFUSED' },
      path,
    );
  }
  // A .GIT path that does not exist yet must still refuse before any lookup.
  await assert.rejects(
    tools.execute('workspace.file.write', { path: '.GIT/objects/pack/new', content: 'bad\n' }),
    { code: 'WORKSPACE_DOT_GIT_REFUSED' },
  );
  await assert.rejects(
    tools.execute('workspace.file.update', { path: '.git/config', oldText: '[core]', newText: '[core]\nfsmonitor = true' }),
    { code: 'WORKSPACE_DOT_GIT_REFUSED' },
  );

  // Resolved-path check: an in-workspace symlink into .git must still refuse.
  try {
    await symlink(join(root, '.git'), join(root, 'gitlink'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (!['EACCES', 'ENOSYS', 'ENOTSUP', 'EPERM'].includes(error.code)) throw error;
    t.skip(`Directory links unavailable: ${error.code}`);
    return;
  }
  const before = await readFile(join(root, '.git', 'config'), 'utf8');
  for (const id of ['workspace.file.write', 'workspace.file.update']) {
    const args = id === 'workspace.file.write'
      ? { path: 'gitlink/config', content: 'bad\n' }
      : { path: 'gitlink/config', oldText: '[core]', newText: '[core]\nhacked = true' };
    await assert.rejects(tools.execute(id, args), { code: 'WORKSPACE_DOT_GIT_REFUSED' }, id);
  }
  assert.equal(await readFile(join(root, '.git', 'config'), 'utf8'), before);
});

test('file-tools-allow-ordinary-git-short-name-directories', async t => {
  const { root, tools } = await fixture(t);
  await mkdir(join(root, 'GIT~1'));
  await mkdir(join(root, '.git'));
  const path = 'GIT~1/notes.txt';
  await tools.execute('workspace.file.write', { path, content: 'original\n' });
  await tools.execute('workspace.file.update', { path, oldText: 'original', newText: 'updated' });
  assert.equal(await readFile(join(root, path), 'utf8'), 'updated\n');
});

test('git-runs-with-fsmonitor-and-hooks-disabled', async t => {
  const { root, tools } = await fixture(t);
  const marker = join(root, 'hook-ran.txt');
  const plant = "import { writeFileSync } from 'node:fs'; writeFileSync('hook-ran.txt', 'ran');\n";
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'empty-git-config'), GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => {
    const run = spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
    assert.equal(run.status, 0, run.error?.message ?? run.stderr);
    return run.stdout;
  };
  git('init', '--quiet', '--template=');
  await mkdir(join(root, '.git', 'hooks'));
  await writeFile(join(root, 'fsmonitor.mjs'), plant);
  await writeFile(join(root, 'diff-external.mjs'), plant);
  await writeFile(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexec node fsmonitor.mjs\n');
  if (process.platform !== 'win32') await chmod(join(root, '.git', 'hooks', 'pre-commit'), 0o755);
  for (const [key, value] of [
    ['core.fsmonitor', 'node fsmonitor.mjs'],
    ['core.hooksPath', '.git/hooks'],
    ['diff.external', 'node diff-external.mjs'],
    ['user.name', 'Bloom Test'],
    ['user.email', 'test@example.invalid'],
  ]) {
    git('config', '--local', key, value);
    assert.equal(git('config', '--local', '--get', key).trimEnd(), value);
  }
  await writeFile(join(root, 'tracked.txt'), 'one\n');
  const status = await tools.execute('workspace.shell.execute', { command: 'git', args: ['status'] });
  assert.equal(status.exitCode, 0, status.output);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  const add = await tools.execute('workspace.shell.execute', { command: 'git', args: ['add', 'tracked.txt'] });
  assert.equal(add.exitCode, 0, add.output);
  const commit = await tools.execute('workspace.shell.execute', {
    command: 'git', args: ['commit', '-m', 'Add tracked'],
  });
  assert.equal(commit.exitCode, 0, commit.output);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  const diff = await tools.execute('workspace.shell.execute', { command: 'git', args: ['diff'] });
  assert.equal(diff.exitCode, 0, `diff output: ${diff.output ?? ''}`);
  assert.match(diff.output, /two/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  for (const args of [['diff', '--ext-diff'], ['log', '-p', '--ext-diff']]) {
    const request = { command: 'git', args };
    const refused = { code: 'WORKSPACE_COMMAND_REFUSED' };
    await assert.rejects(tools.checkCommand(request), refused);
    await assert.rejects(tools.execute('workspace.shell.execute', request), refused);
  }
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});
