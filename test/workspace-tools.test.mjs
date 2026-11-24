import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { test } from 'node:test';

import { workspaceCommandAccess } from '../src/workspace-tools.mjs';

// Commands run only through the allowlisted gate, with node resolved from its own directory.
const testCommands = { commands: workspaceCommandAccess, searchPath: dirname(process.execPath) };

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
  await writeFile(join(root, 'echo.mjs'), 'process.stdout.write(process.argv[2]);\n');
  const shell = await tools.execute('workspace.shell.execute', { command: 'node', args: ['echo.mjs', full] });
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
  await writeFile(join(root, 'touch.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], 'fixture');\n");
  await assert.rejects(tools.execute('workspace.shell.execute', { command: 'node', args: ['touch.mjs', target] }),
    { code: 'WORKSPACE_COMMAND_DISABLED' });
  await assert.rejects(readFile(join(root, target)), { code: 'ENOENT' });
});

test('shell-mode-is-validated', async t => {
  const { root, createWorkspaceTools } = await fixture(t);
  for (const commands of ['enabled', 'uncontained-test-only', Symbol('workspace commands'), true]) {
    assert.throws(() => createWorkspaceTools(root, { commands }),
      { code: 'WORKSPACE_ARGUMENT_INVALID', message: 'Choose a valid command mode.' });
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
  await writeFile(join(root, 'env.mjs'), "import { statSync } from 'node:fs'; process.stdout.write(JSON.stringify([process.cwd(), process.argv[2], process.env, statSync(process.env.HOME).isDirectory()]));\n");
  const result = await tools.execute('workspace.shell.execute', { command: 'node', args: ['env.mjs', 'literal; text'] });
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
  assert.deepEqual(await readdir(root), ['env.mjs']);
  await assert.rejects(readdir(environment.HOME), { code: 'ENOENT' });
  const repeated = await tools.execute('workspace.shell.execute', { command: 'node', args: ['env.mjs'] });
  assert.notEqual(JSON.parse(repeated.output)[2].HOME, environment.HOME);
  assert.equal(result.exitCode, 0);
});

test('shell-timeout-reported', async t => {
  const { root, tools } = await fixture(t, { ...testCommands, timeoutMs: 400 });
  await writeFile(join(root, 'spin.mjs'), 'setInterval(() => {}, 1000);\n');
  const result = await tools.execute('workspace.shell.execute', { command: 'node', args: ['spin.mjs'] });
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
