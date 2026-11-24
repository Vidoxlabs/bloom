import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCodingRuntime } from '../coding-loop.mjs';
import { demoReplies, demoTask } from '../../test/fixtures/demo-provider.mjs';
import { scriptedQueue } from '../../test/helpers/model-doubles.mjs';
import { runOfflineCases } from './offline.mjs';

const fixture = fileURLToPath(new URL('../../test/fixtures/demo-repo/', import.meta.url));
const note = 'demo-repo is a tiny Node project whose range helper lists the whole numbers between two ends.\n';
const answer = 'Created NOTES.md and fixed the off-by-one in src/range.mjs, so range now includes its end value. The test passes.';
const trajectory = ['workspace.dir.list', 'workspace.file.read', 'workspace.text.search',
  'workspace.file.write', 'workspace.shell.execute', 'workspace.file.update',
  'workspace.shell.execute', 'run.answer.create'];
const digest = value => createHash('sha256').update(value).digest('hex');

function snapshot(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...Object.entries(snapshot(path, name + '/')));
    if (entry.isFile()) files.push([name, digest(readFileSync(path))]);
  }
  return Object.fromEntries(files);
}

async function observe() {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'bloom-smoke-')));
  try {
    cpSync(fixture, workspace, { recursive: true });
    const before = snapshot(workspace);
    const observed = { text: '', value: null, trajectory: [], files: {}, testExitCodes: [] };
    const runtime = createCodingRuntime({
      provider: scriptedQueue(demoReplies, 'fixture-model'), searchPath: dirname(process.execPath),
      maxSteps: demoReplies.length,
    });
    await runtime.run({ workspace, prompt: demoTask, signal: new AbortController().signal }, {
      bind() {},
      permission: () => 'allow-once',
      emit(type, data) {
        if (type === 'tool.updated') {
          observed.trajectory.push(data.toolId);
          if (data.toolId === 'workspace.shell.execute') observed.testExitCodes.push(data.exitCode);
        }
        if (type === 'assistant.delta' && data.final) {
          observed.text = data.text;
          observed.value = { answer: data.text };
        }
      },
    });
    const after = snapshot(workspace);
    for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[path] !== after[path]) observed.files[path] = after[path] ?? null;
    }
    return observed;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

export function runSmoke() {
  const expectedRange = readFileSync(join(fixture, 'src', 'range.mjs'), 'utf8').replace('value < end', 'value <= end');
  return runOfflineCases([{
    id: 'inclusive-range',
    observe,
    assertions: [
      { kind: 'exact', expected: answer },
      { kind: 'contains', expected: 'The test passes.' },
      { kind: 'schema-valid', expected: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } },
      { kind: 'tool-trajectory', expected: { ids: trajectory } },
      { kind: 'files-changed', expected: { 'NOTES.md': digest(note), 'src/range.mjs': digest(expectedRange) } },
      { kind: 'tests-pass', expected: [1, 0] },
    ],
  }]);
}
