import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createWorkspaceTools, workspaceCommandAccess } from '../src/workspace-tools.mjs';

const nodeDirectory = dirname(process.execPath);
const refused = { code: 'WORKSPACE_COMMAND_REFUSED' };
// A probe that leaves a marker file when it runs, so a refusal can prove nothing ran.
const probe = "import { writeFileSync } from 'node:fs'; writeFileSync('ran.txt', JSON.stringify(process.argv.slice(2)));\n";

async function fixture(t, options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'bloom-gate-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'workspace');
  const outside = join(directory, 'other');
  await Promise.all([mkdir(root), mkdir(outside)]);
  await writeFile(join(root, 'probe.mjs'), probe);
  await writeFile(join(outside, 'secret.txt'), 'outside');
  const tools = createWorkspaceTools(root, { commands: workspaceCommandAccess, searchPath: nodeDirectory, ...options });
  return { root, outside, tools };
}

async function assertNothingRan(root) {
  await assert.rejects(readFile(join(root, 'ran.txt')), { code: 'ENOENT' });
}

function pathIsOutside(base, candidate) {
  const path = relative(base, candidate);
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}

test('shell-runs-allowlisted-command', async t => {
  const { root, tools } = await fixture(t);
  const result = await tools.execute('workspace.shell.execute', { command: 'node', args: ['probe.mjs', 'one', 'two words'] });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'ran.txt'), 'utf8')), ['one', 'two words']);
  assert.equal(Object.hasOwn(result, 'homeCleanupFailed'), false);
  const checked = await tools.checkCommand({ command: 'node', args: ['probe.mjs'] });
  assert.deepEqual(checked, { command: 'node', args: ['probe.mjs'] });
});

test('shell-refuses-unlisted-command', async t => {
  const { root, tools } = await fixture(t);
  const commands = [
    'sh', 'bash', 'cmd', 'powershell', 'npx', 'python3', 'curl', 'ls', 'Node', 'node.exe',
    '/bin/sh', './node', '..\\node', 'C:node', 'bin/node', 'node/..', '..', process.execPath, '',
  ];
  for (const command of commands) {
    await assert.rejects(tools.execute('workspace.shell.execute', { command, args: ['probe.mjs'] }), refused, command);
    await assert.rejects(tools.checkCommand({ command, args: ['probe.mjs'] }), refused, command);
  }
  await assertNothingRan(root);
});

test('shell-resolves-commands-against-a-fixed-path', async t => {
  // A workspace entry and relative entries in the search path are ignored, so a planted
  // executable named like an allowed command never runs in its place.
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'bloom-gate-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'workspace');
  await mkdir(root);
  await writeFile(join(root, 'probe.mjs'), probe);
  const planted = join(root, process.platform === 'win32' ? 'node.exe' : 'node');
  await writeFile(planted, '#!/bin/sh\necho planted > planted.txt\n');
  await chmod(planted, 0o755);
  const tools = createWorkspaceTools(root, {
    commands: workspaceCommandAccess, searchPath: [root, '.', 'bin', nodeDirectory].join(delimiter),
  });
  const result = await tools.execute('workspace.shell.execute', { command: 'node', args: ['probe.mjs'] });
  assert.equal(result.exitCode, 0);
  await assert.rejects(readFile(join(root, 'planted.txt')), { code: 'ENOENT' });
  const empty = createWorkspaceTools(root, { commands: workspaceCommandAccess, searchPath: [root, '.'].join(delimiter) });
  await assert.rejects(empty.execute('workspace.shell.execute', { command: 'node', args: ['probe.mjs'] }), refused);
});

test('shell-refuses-absolute-and-parent-args', async t => {
  const { root, outside, tools } = await fixture(t);
  const values = [
    join(outside, 'secret.txt'), '/etc/hosts', '~', '~/notes', '~user', '..', '../other', 'a/../b', 'a\\..\\b',
    'C:\\temp', 'C:temp', 'c:/temp', '\\\\server\\share', '//server/share', 'file:///tmp/x', 'file:notes',
    'FILE:notes', 'with\0nul',
  ];
  for (const value of values) {
    for (const args of [['probe.mjs', value], ['probe.mjs', `--input=${value}`]]) {
      await assert.rejects(tools.execute('workspace.shell.execute', { command: 'node', args }), refused, args.join(' '));
    }
  }
  await assertNothingRan(root);
  // Relative names, flags and plain words stay usable.
  const result = await tools.execute('workspace.shell.execute', {
    command: 'node', args: ['probe.mjs', 'src/range.mjs', '--name=value', 'two words', '-x', 'a..b'],
  });
  assert.equal(result.exitCode, 0);
});

test('shell-refuses-symlinked-outside-arg', async t => {
  const { root, outside, tools } = await fixture(t);
  await symlink(outside, join(root, 'away'), 'junction');
  await mkdir(join(root, 'inside'));
  await symlink(join(root, 'inside'), join(root, 'near'), 'junction');
  for (const args of [['probe.mjs', 'away'], ['probe.mjs', 'away/secret.txt'], ['probe.mjs', '--input=away/secret.txt'], ['away/secret.txt']]) {
    await assert.rejects(tools.execute('workspace.shell.execute', { command: 'node', args }), refused, args.join(' '));
  }
  await assertNothingRan(root);
  const result = await tools.execute('workspace.shell.execute', { command: 'node', args: ['probe.mjs', 'near'] });
  assert.equal(result.exitCode, 0);
});

test('shell-refuses-eval-flags', async t => {
  const { root, tools } = await fixture(t);
  const cases = {
    node: [
      ['-e', '1'], ['--eval', '1'], ['--eval=1'], ['-p', '1'], ['--print', '1'], ['--print=1'], ['-pe', '1'],
      ['-r', 'probe.mjs'], ['--require', 'probe.mjs'], ['--require=probe.mjs'], ['--import', 'probe.mjs'],
      ['--import=probe.mjs'], ['--input-type=module'], ['--input-type', 'module'], ['--loader=probe.mjs'],
      ['--experimental-loader', 'probe.mjs'], ['probe.mjs', '--eval', '1'],
    ],
    npm: [
      ['exec', 'probe'], ['x', 'probe'], ['explore', 'probe'], ['--prefix', 'sub', 'test'], ['--prefix=sub', 'test'],
      ['-C', 'sub', 'test'], ['test', '--prefix', 'sub'], ['install', '-g', 'probe'], ['install', '--global', 'probe'],
      ['test', '--script-shell=probe'], ['test', '--node-options=--require=probe.mjs'],
    ],
    git: [
      ['-C', 'sub', 'status'], ['--git-dir=sub', 'status'], ['--git-dir', 'sub', 'status'], ['--work-tree=sub', 'status'],
      ['-c', 'core.pager=probe', 'log'], ['--exec-path=sub', 'status'], ['status', '-c', 'core.pager=probe'],
      ['push'], ['fetch'], ['clone', 'source'], ['config', 'core.pager', 'probe'], ['checkout', 'main'], [],
    ],
  };
  for (const [command, list] of Object.entries(cases)) {
    for (const args of list) {
      await assert.rejects(tools.execute('workspace.shell.execute', { command, args }), refused, `${command} ${args.join(' ')}`);
    }
  }
  await assertNothingRan(root);
  // git is found on the inherited search path, like a person's own terminal.
  const withGit = createWorkspaceTools(root, { commands: workspaceCommandAccess, searchPath: process.env.PATH });
  for (const args of [['status'], ['diff'], ['log', '--oneline'], ['add', 'probe.mjs'], ['commit', '-m', 'Fix the range']]) {
    assert.deepEqual(await withGit.checkCommand({ command: 'git', args }), { command: 'git', args });
  }
});

test('shell-home-is-isolated', async t => {
  const { root, tools } = await fixture(t, {
    environment: { PATH: 'fixture-path', HOME: 'fixture-home', LANG: 'fixture-lang', FIXTURE_TOKEN: 'denied' },
  });
  await writeFile(join(root, 'env.mjs'), 'process.stdout.write(JSON.stringify(process.env));\n');
  const result = await tools.execute('workspace.shell.execute', { command: 'node', args: ['env.mjs'] });
  const environment = JSON.parse(result.output);
  assert.equal(environment.PATH, 'fixture-path');
  assert.equal(environment.LANG, 'fixture-lang');
  assert.equal(environment.FIXTURE_TOKEN, undefined);
  assert.equal(environment.npm_config_offline, 'true');
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, '1');
  assert.ok(isAbsolute(environment.HOME));
  assert.ok(pathIsOutside(root, environment.HOME));
  assert.ok(pathIsOutside(await realpath(homedir()), environment.HOME));
  if (process.platform === 'win32') assert.equal(environment.USERPROFILE, environment.HOME);
  await assert.rejects(readdir(environment.HOME), { code: 'ENOENT' });
  const again = JSON.parse((await tools.execute('workspace.shell.execute', { command: 'node', args: ['env.mjs'] })).output);
  assert.notEqual(again.HOME, environment.HOME);
});

test('shell-home-cleanup-failure-flagged', { skip: process.platform === 'win32' && 'POSIX directory modes' }, async t => {
  const { root, tools } = await fixture(t);
  await writeFile(join(root, 'lock.mjs'), [
    "import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const locked = join(process.env.HOME, 'locked');",
    "mkdirSync(locked); writeFileSync(join(locked, 'kept.txt'), 'kept'); chmodSync(locked, 0o500);",
    'process.stdout.write(process.env.HOME);',
  ].join('\n'));
  const result = await tools.execute('workspace.shell.execute', { command: 'node', args: ['lock.mjs'] });
  t.after(async () => {
    await chmod(join(result.output, 'locked'), 0o700).catch(() => {});
    await rm(result.output, { recursive: true, force: true });
  });
  assert.equal(result.exitCode, 0, 'the command result is kept');
  assert.equal(result.homeCleanupFailed, true);
});

test('command-access-has-one-production-caller', async () => {
  const name = 'workspaceCommandAccess';
  const callers = [];
  for (const directory of ['src', 'bin', 'scripts', 'checks']) {
    const files = await readdir(new URL(`../${directory}/`, import.meta.url), { recursive: true, withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !/\.(mjs|cjs|js)$/.test(file.name)) continue;
      const path = join(file.parentPath, file.name);
      const source = await readFile(path, 'utf8');
      const where = relative(fileURLToPath(new URL('..', import.meta.url)), path).split(sep).join('/');
      const uses = source.split('\n').filter(line => line.includes(name) && !line.startsWith(`export const ${name} =`));
      if (where === 'src/workspace-tools.mjs') {
        // The where module only compares against the seam; it never passes it on.
        for (const use of uses) assert.match(use, new RegExp(`commands !== ${name}\\b`), use);
        continue;
      }
      if (uses.length) callers.push(where);
    }
  }
  // The coding loop's own entry point is the only production caller of the command seam.
  assert.deepEqual(callers, ['src/coding-loop.mjs']);
  const source = await readFile(new URL('../src/workspace-tools.mjs', import.meta.url), 'utf8');
  assert.match(source, /^export const workspaceCommandAccess = Symbol\(/m);
  assert.doesNotMatch(source, /uncontained/);
});
