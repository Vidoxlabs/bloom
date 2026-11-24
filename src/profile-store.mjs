// Probed model profiles, kept in profiles.json in Bloom's data directory and keyed by the
// provider's config name and the model alias. The file holds no address. A profile that does
// not validate reads as absent, so a damaged file can only fall back to unknown.
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkModelProfile, modelProfile } from '@vidoxlabs/seed';

const FILE = 'profiles.json';

export const profileKey = (provider, alias) => provider + '/' + alias;

function load(directory) {
  try {
    const stored = JSON.parse(readFileSync(join(directory, FILE), 'utf8'));
    if (stored?.version === 1 && stored.profiles && typeof stored.profiles === 'object' && !Array.isArray(stored.profiles)) return stored;
  } catch {
    // A missing or unreadable file holds no profiles.
  }
  return { version: 1, profiles: {} };
}

export function readProfile(directory, key) {
  const { profiles } = load(directory);
  const entry = Object.hasOwn(profiles, key) ? profiles[key] : null;
  if (!entry || !checkModelProfile(entry.profile).ok) return null;
  return modelProfile(entry.profile);
}

export function writeProfile(directory, key, profile, { probedAt = new Date().toISOString() } = {}) {
  const stored = load(directory);
  stored.profiles[key] = { probedAt, profile: modelProfile(profile) };
  const path = join(directory, FILE);
  const temporary = path + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}
