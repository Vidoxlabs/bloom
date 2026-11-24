import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as seed from '@vidoxlabs/seed';
import { probeProvider } from '../probe.mjs';
import { profileKey, writeProfile } from '../profile-store.mjs';
import { readTerminalProvider, terminalSelection } from './config.mjs';
import { hasColor } from './render/line.mjs';

// With --probe, doctor also asks the configured provider what it supports and saves the profile.
// Only the provider's config name and locality are printed, never its address.
export async function doctor(directory, values, { stdout, stdin, fetcher = fetch, env = process.env, timeouts } = {}) {
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
  let provider = null;
  try {
    provider = readTerminalProvider(directory);
    if (provider) {
      const detail = provider.unencrypted ? ' Traffic is unencrypted.' : '';
      add('Endpoint rule', 'pass', provider.label + '.' + detail);
    } else {
      add('Endpoint rule', 'unknown', 'Set a provider in config.json under --data-dir.');
    }
  } catch (error) {
    add('Endpoint rule', 'fail', error.message);
  }
  add('TTY', stdin.isTTY && stdout.isTTY ? 'pass' : 'unknown', stdin.isTTY && stdout.isTTY ? 'Interactive TTY.' : 'Plain streams.');
  add('Colour', hasColor(stdout) ? 'pass' : 'unknown', hasColor(stdout) ? 'Enabled.' : 'Disabled.');
  if (values.probe) await probe(directory, provider, { add, fetcher, env, timeouts });
  if (values.json) stdout.write(JSON.stringify(checks) + '\n');
  else for (const { check, status, detail } of checks) stdout.write(status + '  ' + check + '  ' + detail + '\n');
  return checks.some(check => check.status === 'fail') ? 1 : 0;
}

async function probe(directory, provider, { add, fetcher, env, timeouts }) {
  if (!provider) {
    add('Probe', 'fail', 'Set a provider in config.json under --data-dir before probing.');
    return;
  }
  let selection;
  try { selection = terminalSelection(provider); }
  catch (error) {
    add('Probe', 'fail', error.message);
    return;
  }
  const apiKey = provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined;
  const result = await probeProvider({ provider, ...selection, apiKey, fetcher, ...(timeouts ? { timeouts } : {}) });
  for (const { check, status, detail } of result.checks) add(check, status, detail);
  try {
    writeProfile(directory, profileKey(provider.name, selection.alias), result.profile);
    add('Profile', 'pass', 'Saved for ' + provider.label + ', alias ' + selection.alias + '.');
  } catch {
    add('Profile', 'fail', 'The profile could not be saved in the data directory.');
  }
}
