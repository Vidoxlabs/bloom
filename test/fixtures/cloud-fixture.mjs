import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const marker = 'bloom-cloud-endpoint-marker';
export const keyMarker = 'bloom-cloud-key-marker-value';
export const fakeBase = 'https://cloud.example.invalid/v1beta/openai';
export const markerBase = 'https://' + marker + '.invalid/v1beta/openai';

export const sse = (chunks) => new Response(new ReadableStream({ start(controller) {
  const encoder = new TextEncoder();
  for (const chunk of chunks) controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk) + '\n\n'));
  controller.enqueue(encoder.encode('data: [DONE]\n\n'));
  controller.close();
} }), { headers: { 'content-type': 'text/event-stream' } });

export function googleError(status, message, statusName) {
  return Response.json({ error: { code: status, message, status: statusName } }, { status });
}

export function folders(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'bloom-cloud-')));
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    path: directory,
    closeLater(fn) { closers.push(fn); },
  };
}
