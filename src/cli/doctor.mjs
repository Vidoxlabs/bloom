import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as seed from '@vidoxlabs/seed';
import { inspectEndpoint } from '../models.mjs';
import { configuredKey } from './providers.mjs';
import { hasColor } from './render/line.mjs';

export async function doctor(directory, values, { stdout, stdin }) {
  const checks = [];
  const add = (check, status, detail) => checks.push({ check, status, detail });
  const [major, minor] = process.versions.node.split('.').map(Number);
  add('Node', major > 22 || (major === 22 && minor >= 13) ? 'pass' : 'fail', process.versions.node);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const mode = statSync(directory).mode & 0o777;
    if (process.platform === 'win32') add('Data directory', 'unknown', 'POSIX mode is unavailable.');
    else add('Data directory', mode === 0o700 ? 'pass' : 'fail', 'Mode ' + mode.toString(8) + ' (required 700).');
  } catch {
    add('Data directory', 'fail', 'The directory could not be opened.');
  }
  let scratch;
  let database;
  try {
    scratch = mkdtempSync(join(directory, '.doctor-'));
    database = new DatabaseSync(join(scratch, 'probe.sqlite'));
    database.exec('CREATE TABLE probe (value INTEGER)');
    database.close();
    database = null;
    add('SQLite', 'pass', 'A disposable database opened and accepted a write.');
  } catch {
    add('SQLite', 'fail', 'Could not open and write a disposable database.');
  } finally {
    database?.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
  const exports = ['validateProvider', 'normalizeGeneration'];
  add('Seed exports', exports.every(name => typeof seed[name] === 'function') ? 'pass' : 'fail', exports.join(', '));
  let endpoint;
  if (values['api-base']) {
    try {
      endpoint = inspectEndpoint(values['api-base']);
      add('Endpoint rule', 'pass', endpoint.local ? 'Loopback.' : 'HTTPS. Terminal cloud approval is unavailable.');
    } catch {
      add('Endpoint rule', 'fail', 'Use HTTPS, or HTTP on loopback. Supply credentials through the environment.');
    }
  } else {
    add('Endpoint rule', 'unknown', 'Set a model endpoint with --api-base.');
  }
  if (!values.probe || !endpoint?.local) {
    add('Model catalog', 'unknown', 'Use --probe with a loopback endpoint to check the model catalog.');
  } else {
    try {
      const key = configuredKey();
      const response = await fetch(endpoint.base + '/models', {
        headers: key ? { authorization: 'Bearer ' + key } : {}, redirect: 'error', signal: AbortSignal.timeout(3000),
      });
      const ok = response.ok && Array.isArray((await response.json())?.data);
      add('Model catalog', ok ? 'pass' : 'fail', ok ? 'The model catalog responded.' : 'The model catalog returned an invalid response.');
    } catch {
      add('Model catalog', 'fail', 'The model catalog could not be reached or read.');
    }
  }
  add('TTY', stdin.isTTY && stdout.isTTY ? 'pass' : 'unknown', stdin.isTTY && stdout.isTTY ? 'Interactive TTY.' : 'Plain streams.');
  add('Colour', hasColor(stdout) ? 'pass' : 'unknown', hasColor(stdout) ? 'Enabled.' : 'Disabled.');
  if (values.json) stdout.write(JSON.stringify(checks) + '\n');
  else for (const { check, status, detail } of checks) stdout.write(status + '  ' + check + '  ' + detail + '\n');
  return checks.some(check => check.status === 'fail') ? 1 : 0;
}
