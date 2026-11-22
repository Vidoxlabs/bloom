import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
export function dataPath(override, demo = false) {
  if (override) return resolve(override);
  const suffix = demo ? ['demo'] : [];
  const previous = join(homedir(), '.vibloom', ...suffix);
  const current = join(homedir(), '.bloom', ...suffix);
  return existsSync(join(previous, 'vibloom.sqlite')) && !existsSync(join(current, 'vibloom.sqlite')) ? previous : current;
}
