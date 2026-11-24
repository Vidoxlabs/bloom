import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import * as gate from '../src/command-gate.mjs';
import { requireCloudFlag } from '../src/live-cloud-flag.mjs';
import { fixture } from './fixtures/shell-gate.mjs';

async function refuse(t, command, args, reason) {
  const { root } = await fixture(t);
  if (!args[0].startsWith('-')) await writeFile(join(root, args[0]), '');
  return assert.rejects(gate.checkCommandRequest(root, { command, args }),
    error => error.code === 'WORKSPACE_COMMAND_REFUSED' && reason.test(error.message));
}

for (const flag of ['-offline=false', '-offl=false', '-no-offl', '-reg=https://example.invalid/',
  '-node-options=', '-Node-Options=', '-script-shell=', '-prefix=']) {
  test('refuses npm option ' + flag, async t => {
    const redirect = /node-options|script-shell|prefix/i.test(flag);
    await refuse(t, 'npm', ['test', flag], redirect ? /redirects the install/ : /registry, cache or online mode/);
  });
}

test('refuses external diff before approving git diff or log', async t => {
  for (const args of [['diff', '--ext-diff'], ['log', '-p', '--ext-diff']]) {
    await refuse(t, 'git', args, /external diff/);
  }
});

test('refuses additional node debugging options', async t => {
  for (const flag of ['--debug-port', '--debug-port=1', '--inspect-publish-uid', '--inspect-publish-uid=stderr']) {
    await refuse(t, 'node', [flag], /evaluates code or loads modules/);
  }
});

test('documents every refused flag from the command gate', () => {
  const doc = readFileSync(new URL('../docs/command-gate.md', import.meta.url), 'utf8');
  for (const [command, flags] of Object.entries(gate.REFUSED_FLAGS)) {
    const line = doc.split(/\r?\n/).find(value => value.startsWith('- ' + command + ' refuses '));
    assert.ok(line, command);
    assert.deepEqual([...line.matchAll(/`([^`]+)`/g)].map(match => match[1]).sort(), [...flags].sort(), command);
  }
});

test('cloud live flag admits local providers and requires the separate cloud opt-in', t => {
  const names = ['BLOOM_LIVE', 'BLOOM_LIVE_ALLOW_CLOUD'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
  process.env.BLOOM_LIVE = '1';
  delete process.env.BLOOM_LIVE_ALLOW_CLOUD;
  assert.doesNotThrow(() => requireCloudFlag({ local: true }));
  assert.throws(() => requireCloudFlag({ local: false }), /BLOOM_LIVE_ALLOW_CLOUD/);
  process.env.BLOOM_LIVE_ALLOW_CLOUD = '1';
  assert.doesNotThrow(() => requireCloudFlag({ local: false }));
});
