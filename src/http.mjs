import { readFileSync } from 'node:fs';
import { BloomError } from './errors.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/team.js', ['team.js', 'text/javascript; charset=utf-8']],
  ['/tokens.css', ['tokens.css', 'text/css; charset=utf-8']],
  ...['geist-400','geist-600','geist-mono-400'].map(name => ['/fonts/' + name + '.woff2', ['fonts/' + name + '.woff2', 'font/woff2']]),
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const pathRule = /^\/api\/sessions\/([0-9a-f-]{36})\/(events|turns|stop|permissions\/([0-9a-f-]{36}))$/;
const maxBody = 256 * 1024;

async function readBody(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new BloomError('JSON_REQUIRED', 'Use application/json for this request.', 415);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBody) throw new BloomError('BODY_TOO_LARGE', 'Request is too large.', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new BloomError('JSON_INVALID', 'Expected a JSON object.', 400);
  }
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function stream(request, response, url, harness, sessionId) {
  const cursor = Number(request.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new BloomError('CURSOR_INVALID', 'Invalid history cursor.', 400);
  }
  harness.store.getSession(sessionId);
  response.writeHead(200, { 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' });
  response.write(': Bloom\n\n');
  let sequence = cursor;
  let blocked = false;
  function pump() {
    while (!blocked && !response.writableEnded && !response.destroyed) {
      const page = harness.store.eventsAfter(sessionId, sequence);
      if (!page.length) return;
      for (const event of page) {
        sequence = event.seq;
        if (response.write('id: ' + sequence + '\ndata: ' + JSON.stringify(event) + '\n\n')) continue;
        blocked = true;
        response.once('drain', () => {
          blocked = false;
          pump();
        });
        return;
      }
    }
  }
  response.once('close', harness.subscribe(sessionId, pump));
  pump();
}

export function createHandler(harness) {
  return async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'");
    try {
      const host = request.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host)) {
        throw new BloomError('LOCAL_HOST_REQUIRED', 'Open Bloom through its local address.', 403);
      }
      const origin = 'http://' + host;
      const url = new URL(request.url, origin);
      if (url.origin !== origin || (request.headers.origin && request.headers.origin !== origin)) {
        throw new BloomError('ORIGIN_MISMATCH', 'Open the workspace from the Bloom tab.', 403);
      }
      const { pathname } = url;
      const method = request.method;
      if (method === 'GET' && assets.has(pathname)) {
        const [name, contentType] = assets.get(pathname);
        response.writeHead(200, { 'content-type': contentType });
        response.end(readFileSync(new URL('../public/' + name, import.meta.url)));
        return;
      }
      if (method === 'GET' && pathname === '/api/info') return json(response, 200, harness.info());
      if (method === 'POST' && pathname === '/api/teams') return json(response, 201, harness.teams.create(await readBody(request)));
      if (pathname === '/api/personas') {
        if (method === 'GET') return json(response, 200, harness.teams.personas());
        if (method === 'POST') return json(response, 201, harness.teams.createPersona(await readBody(request)));
      }
      const personaPath = /^\/api\/personas\/([0-9a-f-]{36})$/.exec(pathname);
      if (personaPath && method === 'PUT') return json(response, 200, harness.teams.updatePersona(personaPath[1], await readBody(request)));
      if (personaPath && method === 'DELETE') {
        await readBody(request);
        return json(response, 200, harness.teams.deletePersona(personaPath[1]));
      }
      const teamPath = /^\/api\/teams\/([0-9a-f-]{36})(?:\/(sources|notes|files|members)(?:\/([0-9a-f-]{36}))?)?$/.exec(pathname);
      if (teamPath) {
        const [, id, kind, item] = teamPath;
        if (method === 'GET' && !kind) return json(response, 200, harness.teams.detail(id));
        if (method === 'POST' && kind === 'sources' && !item) return json(response, 201, await harness.teams.source(id, await readBody(request)));
        if (method === 'POST' && kind === 'notes' && !item) return json(response, 201, harness.teams.note(id, await readBody(request)));
        if (method === 'POST' && kind === 'members' && !item) return json(response, 200, harness.teams.recruit(id, await readBody(request)));
        if (method === 'DELETE' && kind === 'notes' && item) {
          await readBody(request);
          return json(response, 200, harness.teams.forget(id, item));
        }
        if (method === 'GET' && kind === 'files' && item) {
          const file = harness.teams.store.read(id, item);
          if (url.searchParams.has('download')) {
            response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': 'attachment; filename="' + file.filename + '"' });
            return response.end(file.text);
          }
          return json(response, 200, { ...file, history: harness.teams.store.history(id, item) });
        }
      }
      if (pathname === '/api/sessions') {
        if (method === 'GET') return json(response, 200, harness.store.listSessions());
        if (method === 'POST') return json(response, 201, harness.createSession(await readBody(request)));
      }
      const match = pathRule.exec(pathname);
      if (match) {
        const [, sessionId, action, permissionId] = match;
        if (method === 'GET' && action === 'events') return stream(request, response, url, harness, sessionId);
        if (method === 'POST') {
          const body = await readBody(request);
          if (action === 'turns') return json(response, 202, harness.start(sessionId, body));
          if (action === 'stop') return json(response, 202, harness.stop(sessionId, body));
          if (permissionId) return json(response, 200, harness.decide(sessionId, permissionId, body));
        }
      }
      throw new BloomError('NOT_FOUND', 'Route not found.', 404);
    } catch (error) {
      if (response.headersSent) return response.end();
      if (error instanceof BloomError) return json(response, error.status, { code: error.code, message: error.message });
      return json(response, 500, { code: 'REQUEST_FAILED', message: 'Bloom could not complete the request.' });
    }
  };
}
