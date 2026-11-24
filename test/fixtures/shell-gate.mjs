import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

import { createWorkspaceTools, workspaceCommandAccess } from '../../src/workspace-tools.mjs';

export const nodeDirectory = dirname(process.execPath);
export const refused = { code: 'WORKSPACE_COMMAND_REFUSED' };
// Absolute PATH entries so node, npm and git resolve; refusals must be by rule, not "not found".
export function resolvedSearchPath() {
  return String(process.env.PATH ?? '').split(delimiter).filter(entry => entry && isAbsolute(entry)).join(delimiter);
}
export const NOT_FOUND = 'The allowed command was not found on the fixed search path.';
// A probe that leaves a marker file when it runs, so a refusal can prove nothing ran.
export const probe = "import { writeFileSync } from 'node:fs'; writeFileSync('ran.txt', JSON.stringify(process.argv.slice(2)));\n";

export async function fixture(t, options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'bloom-gate-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'workspace');
  const outside = join(directory, 'other');
  await Promise.all([mkdir(root), mkdir(outside)]);
  await writeFile(join(root, 'probe.mjs'), probe);
  await writeFile(join(outside, 'secret.txt'), 'outside');
  const tools = createWorkspaceTools(root, { commands: workspaceCommandAccess, searchPath: resolvedSearchPath(), ...options });
  return { root, outside, tools };
}
