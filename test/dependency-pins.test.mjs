import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const seed = '@vidoxlabs/seed';
const drosera = '@vidoxlabs/drosera';
const first = 'a'.repeat(40);
const second = 'b'.repeat(40);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bloom-pins-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dependencies = { [seed]: 'github:Vidoxlabs/seed#' + first, [drosera]: 'github:Vidoxlabs/drosera#' + second };
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies }));
  return root;
}

test('doctor-pin-status-is-installed-mismatch-or-missing', async t => {
  const { dependencyPinChecks } = await import('../src/cli/dependency-pins.mjs');
  const root = fixture(t);
  const packages = join(root, 'node_modules');
  for (const name of [seed, drosera]) {
    mkdirSync(join(packages, name), { recursive: true });
    writeFileSync(join(packages, name, 'package.json'), JSON.stringify({ name }));
  }
  writeFileSync(join(packages, '.package-lock.json'), JSON.stringify({
    packages: {
      ['node_modules/' + seed]: { resolved: 'github:Vidoxlabs/seed#' + first },
      ['node_modules/' + drosera]: { resolved: 'github:Vidoxlabs/drosera#' + first },
    },
  }));
  assert.deepEqual(dependencyPinChecks(root), [
    { check: 'Seed pin', status: 'pass', detail: 'installed' },
    { check: 'Drosera pin', status: 'fail', detail: 'mismatch' },
  ]);
  rmSync(join(packages, seed), { recursive: true });
  assert.deepEqual(dependencyPinChecks(root)[0], { check: 'Seed pin', status: 'fail', detail: 'missing' });
});

test('doctor-reports-missing-pins-before-loading-the-runtime', t => {
  const root = fixture(t);
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'src', 'cli'), { recursive: true });
  cpSync(new URL('../bin/bloom.mjs', import.meta.url), join(root, 'bin', 'bloom.mjs'));
  const pinChecks = new URL('../src/cli/dependency-pins.mjs', import.meta.url);
  if (existsSync(pinChecks)) cpSync(pinChecks, join(root, 'src', 'cli', 'dependency-pins.mjs'));
  writeFileSync(join(root, 'src', 'cli', 'main.mjs'), 'throw new Error("Runtime was loaded");');
  const result = spawnSync(process.execPath, [join(root, 'bin', 'bloom.mjs'), 'doctor', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), [
    { check: 'Seed pin', status: 'fail', detail: 'missing' },
    { check: 'Drosera pin', status: 'fail', detail: 'missing' },
  ]);
  assert.equal(result.stderr, '');
});
