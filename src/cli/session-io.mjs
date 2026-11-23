import { readFileSync, writeFileSync } from 'node:fs';
import { lineRenderer } from './render/line.mjs';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));
export const bloomVersion = manifest.version;
const seedPin = Object.values(manifest.dependencies).find(pin => pin.includes('/seed#')).split('#').at(-1);
const jsonLine = value => JSON.stringify(value) + '\n';

export function maskWorkspace(value, workspace) {
  if (!workspace) return value;
  if (typeof value === 'string') {
    const escape = part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const root = escape(workspace.replace(/[/\\]+$/, ''));
    const paths = new RegExp((root || '^') + '([/\\\\]|(?=$|[\\s"\x27,;)\\]]))', 'g');
    return value.replace(paths, (_, separator) => '$WORKSPACE' + (separator ? '/' : ''));
  }
  if (Array.isArray(value)) return value.map(item => maskWorkspace(item, workspace));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      maskWorkspace(key, workspace), maskWorkspace(item, workspace),
    ]));
  }
  return value;
}

function* sessionEvents(store, session) {
  let sequence = 0;
  for (;;) {
    const page = store.eventsAfter(session.id, sequence);
    if (!page.length) return;
    for (const event of page) yield maskWorkspace(event, session.workspace);
    sequence = page.at(-1).seq;
  }
}

export function showSession(store, session, stdout, json) {
  if (json) stdout.write(jsonLine(maskWorkspace(session, session.workspace)));
  else {
    const renderer = lineRenderer({ stdout });
    stdout.write(session.title + '  ' + session.id + '\n');
    for (const event of sessionEvents(store, session)) renderer.onEvent(event);
    renderer.close();
  }
}

export function exportSession(store, session, stdout, file) {
  const header = { v: 1, type: 'session.header', bloomVersion, seedPin, sessionId: session.id, exportedAt: new Date().toISOString() };
  const text = jsonLine(header) + Array.from(sessionEvents(store, session), jsonLine).join('');
  if (file) writeFileSync(file, text, { mode: 0o600 });
  else stdout.write(text);
}

export async function replaySession(file, { stdout, json, step, nextLine }) {
  const raw = readFileSync(file, 'utf8');
  const records = raw.trimEnd().split('\n').map(line => JSON.parse(line));
  const header = records[0];
  if (header?.v !== 1 || header.type !== 'session.header') throw new Error('Choose a version 1 session export.');
  let previous = 0;
  for (const event of records.slice(1)) {
    if (!Number.isSafeInteger(event?.seq) || event.seq <= previous || typeof event.type !== 'string') {
      throw new Error('The session event sequence is invalid.');
    }
    previous = event.seq;
  }
  if (json && !step) {
    stdout.write(raw);
    return;
  }
  const renderer = lineRenderer({ stdout });
  try {
    for (const [index, event] of records.entries()) {
      if (step && index > 0 && await nextLine() === null) return;
      if (json) stdout.write(jsonLine(event));
      else renderer.onEvent(event);
    }
  } finally {
    renderer.close();
  }
}
