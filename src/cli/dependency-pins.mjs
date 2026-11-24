import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dependencies = [['Seed pin', '@vidoxlabs/seed'], ['Drosera pin', '@vidoxlabs/drosera']];

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function commit(reference) {
  return typeof reference === 'string' ? /#([a-f0-9]{40})$/i.exec(reference)?.[1].toLowerCase() : undefined;
}

export function dependencyPinChecks(directory = root) {
  const expected = readJson(join(directory, 'package.json'))?.dependencies;
  const modules = join(directory, 'node_modules');
  const installed = readJson(join(modules, '.package-lock.json'))?.packages;
  return dependencies.map(([check, name]) => {
    const present = readJson(join(modules, name, 'package.json'))?.name === name;
    const pinned = commit(expected?.[name]);
    const observed = commit(installed?.['node_modules/' + name]?.resolved);
    const detail = !present ? 'missing' : pinned && pinned === observed ? 'installed' : 'mismatch';
    return { check, status: detail === 'installed' ? 'pass' : 'fail', detail };
  });
}
