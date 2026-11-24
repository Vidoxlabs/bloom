import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { test } from 'node:test';

const testCommands = { commands: 'uncontained-test-only' };

async function fixture(t, options) {
  const directory = await mkdtemp(join(tmpdir(), 'bloom-tools-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'workspace');
  const outside = join(directory, 'other');
  await Promise.all([mkdir(root), mkdir(outside)]);
  const { createWorkspaceTools } = await import('../src/workspace-tools.mjs');
  return { root, outside, tools: createWorkspaceTools(root, options), createWorkspaceTools };
}

test('workspace-root-containment-refuses-escape', async t => {
  const { root, outside, tools } = await fixture(t);
  const outsideFile = join(outside, 'note.txt');
  await writeFile(outsideFile, 'outside');
  await symlink(outside, join(root, 'alias'), 'junction');
  for (const path of ['../other/note.txt', 'nested/../note.txt', outsideFile, 'alias/note.txt']) {
    await assert.rejects(tools.execute('workspace.file.read', { path }), { code: 'WORKSPACE_PATH_OUTSIDE' });
  }
  for (const path of ['alias/note.txt', 'alias/new.txt']) {
    await assert.rejects(tools.execute('workspace.file.write', { path, content: 'changed' }), { code: 'WORKSPACE_PATH_OUTSIDE' });
  }
  assert.equal(await readFile(outsideFile, 'utf8'), 'outside');
  await assert.rejects(readFile(join(outside, 'new.txt')), { code: 'ENOENT' });
});

test('workspace-revalidation-uses-one-canonical-path-representation', async t => {
  const { root, outside, createWorkspaceTools } = await fixture(t);
  const alias = join(outside, 'workspace-alias');
  await symlink(root, alias, 'junction');
  await writeFile(join(root, 'note.txt'), 'inside');
  const resolveSync = fs.realpathSync;
  const mock = t.mock.method(fs, 'realpathSync', (path, ...options) => path === root ? alias : resolveSync(path, ...options));
  mock.native = resolveSync.native;
  syncBuiltinESMExports();
  try {
    const result = await createWorkspaceTools(root).execute('workspace.file.read', { path: 'note.txt' });
    assert.equal(result.output, 'inside');
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('per-path-write-serialization', async t => {
  const { root, tools, createWorkspaceTools } = await fixture(t);
  await mkdir(join(root, 'nested'));
  await symlink(join(root, 'nested'), join(root, 'alias'), 'junction');
  await tools.execute('workspace.file.write', { path: 'nested/note.txt', content: 'alpha beta' });
  const other = createWorkspaceTools(root);
  await Promise.all([
    tools.execute('workspace.file.update', { path: 'nested/note.txt', oldText: 'alpha', newText: 'first' }),
    other.execute('workspace.file.update', { path: 'alias/note.txt', oldText: 'beta', newText: 'second' }),
  ]);
  assert.equal(await readFile(join(root, 'nested', 'note.txt'), 'utf8'), 'first second');
});

test('capped-output-reports-truncated-bytes-and-sha256', async t => {
  const { root, tools } = await fixture(t, { ...testCommands, outputLimitBytes: 5 });
  const full = 'abcd\u{1f680}ef';
  await writeFile(join(root, 'note.txt'), full);
  const expected = {
    output: 'abcd',
    truncatedBytes: Buffer.byteLength(full) - 4,
    outputSha256: createHash('sha256').update(full).digest('hex'),
  };
  assert.deepEqual(await tools.execute('workspace.file.read', { path: 'note.txt' }), expected);
  const shell = await tools.execute('workspace.shell.execute', {
    command: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1])', full],
  });
  assert.deepEqual(shell, { ...expected, exitCode: 0, timedOut: false });
});

test('update-requires-unique-match', async t => {
  const { root, tools } = await fixture(t);
  const path = 'note.txt';
  await writeFile(join(root, path), 'aaa');
  for (const oldText of ['absent', 'aa']) {
    await assert.rejects(tools.execute('workspace.file.update', { path, oldText, newText: 'changed' }),
      { code: 'WORKSPACE_MATCH_NOT_UNIQUE' });
    assert.equal(await readFile(join(root, path), 'utf8'), 'aaa');
  }
  await tools.execute('workspace.file.update', { path, oldText: 'aaa', newText: '$&' });
  assert.equal(await readFile(join(root, path), 'utf8'), '$&');
});

test('shell-disabled-by-default', async t => {
  const { root, tools } = await fixture(t);
  const target = 'unexpected.txt';
  await assert.rejects(tools.execute('workspace.shell.execute', {
    command: process.execPath, args: ['-e', "require('node:fs').writeFileSync(process.argv[1], 'fixture')", target],
  }), { code: 'WORKSPACE_COMMAND_DISABLED' });
  await assert.rejects(readFile(join(root, target)), { code: 'ENOENT' });
});

test('shell-mode-is-validated', async t => {
  const { root, createWorkspaceTools } = await fixture(t);
  assert.throws(() => createWorkspaceTools(root, { commands: 'enabled' }),
    { code: 'WORKSPACE_ARGUMENT_INVALID', message: 'Choose a valid command mode.' });
});

test('no-entry-point-enables-uncontained-commands', async () => {
  for (const directory of ['src', 'bin', 'scripts', 'checks']) {
    const files = await readdir(new URL(`../${directory}/`, import.meta.url), { recursive: true, withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.mjs')) continue;
      const source = await readFile(join(file.parentPath, file.name), 'utf8');
      assert.ok(!source.includes(testCommands.commands), file.name);
    }
  }
});

function pathIsOutside(base, candidate) {
  const path = relative(base, candidate);
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}

test('shell-env-drops-secret-like-names', async t => {
  const { root, tools } = await fixture(t, {
    ...testCommands,
    environment: {
      PATH: 'fixture-path', HOME: 'fixture-home', LANG: 'fixture-lang', TERM: 'fixture-term',
      FIXTURE_KEY: 'denied', FIXTURE_TOKEN: 'denied', FIXTURE_SECRET: 'denied', EXTRA: 'denied',
    },
  });
  const program = "process.stdout.write(JSON.stringify([process.cwd(), process.argv[1], process.env, require('node:fs').statSync(process.env.HOME).isDirectory()]))";
  const result = await tools.execute('workspace.shell.execute', {
    command: process.execPath, args: ['-e', program, 'literal; text'],
  });
  const [directory, argument, environment, homeExists] = JSON.parse(result.output);
  assert.equal(await realpath(directory), await realpath(root));
  assert.equal(argument, 'literal; text');
  // Some platforms add locale metadata after launch. Compare the supplied keys.
  const names = ['PATH', 'LANG', 'TERM', 'FIXTURE_KEY', 'FIXTURE_TOKEN', 'FIXTURE_SECRET', 'EXTRA'];
  const forwarded = Object.fromEntries(names.filter(name => Object.hasOwn(environment, name))
    .map(name => [name, environment[name]]));
  assert.deepEqual(forwarded, { PATH: 'fixture-path', LANG: 'fixture-lang', TERM: 'fixture-term' });
  assert.equal(homeExists, true);
  assert.ok(isAbsolute(environment.HOME));
  assert.ok(pathIsOutside(await realpath(root), environment.HOME));
  assert.ok(pathIsOutside(await realpath(homedir()), environment.HOME));
  if (process.platform === 'win32') assert.equal(environment.USERPROFILE, environment.HOME);
  assert.equal((await readdir(root)).length, 0);
  await assert.rejects(readdir(environment.HOME), { code: 'ENOENT' });
  const repeated = await tools.execute('workspace.shell.execute', { command: process.execPath, args: ['-e', program] });
  assert.notEqual(JSON.parse(repeated.output)[2].HOME, environment.HOME);
  assert.equal(result.exitCode, 0);
});

test('shell-timeout-reported', async t => {
  const { tools } = await fixture(t, { ...testCommands, timeoutMs: 120 });
  const result = await tools.execute('workspace.shell.execute', {
    command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
});

test('workspace-list-read-search-and-finish-use-the-declared-faces', async t => {
  const { root, tools } = await fixture(t);
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested', 'note.txt'), 'first\r\nliteral.*\r\nlast');
  assert.equal((await tools.execute('workspace.dir.list', {})).output, 'nested/\n');
  assert.equal((await tools.execute('workspace.file.read', { path: 'nested/note.txt', startLine: 2, endLine: 2 })).output, 'literal.*\r\n');
  assert.equal((await tools.execute('workspace.text.search', { query: 'literal.*' })).output, 'nested/note.txt:2:literal.*\n');
  assert.equal((await tools.execute('run.answer.create', { text: 'Finished.' })).output, 'Finished.');
  await assert.rejects(tools.execute('workspace.file.delete', {}), { code: 'WORKSPACE_TOOL_UNKNOWN' });
});
