import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { SANDBOX_MARKER } from '../src/sandbox-marker.mjs';
import { probeProvider, PROBE_MESSAGE } from '../src/probe.mjs';
import { createChatProvider } from '../src/models.mjs';
import { providerFailureReason } from '../src/provider-errors.mjs';
import { openCodingSession, copyDemoRepo } from './fixtures/coding-session.mjs';
import { fakeBase, markerBase, sse, folders, googleError } from './fixtures/cloud-fixture.mjs';

test('probe-matches-models-prefixed-ids', async () => {
  const backend = 'gemini-4-hydrogen';
  const fetcher = async (url) => {
    if (String(url).endsWith('/models')) {
      return Response.json({ data: [{ id: 'models/' + backend }] });
    }
    return sse([{ model: backend, choices: [{ delta: { content: 'OK' }, finish_reason: null }] }]);
  };
  const result = await probeProvider({
    provider: { base: fakeBase, baseURL: fakeBase },
    alias: 'coder', backendModel: backend, fetcher,
  });
  const model = result.checks.find(item => item.check === 'Model');
  assert.equal(model.status, 'pass');
  assert.deepEqual(result.profile.model, { value: backend, source: 'probed' });
});

test('probe-accepts-thinking-model-stream', async () => {
  // Gemini 4 may stream with no content and finish length; one SSE chunk is enough.
  const fetcher = async (url) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'models/gemini-4-hydrogen' }] });
    return sse([{ model: 'gemini-4-hydrogen', choices: [{ delta: {}, finish_reason: 'length' }] }]);
  };
  const result = await probeProvider({
    provider: { base: fakeBase, baseURL: fakeBase },
    alias: 'coder', backendModel: 'gemini-4-hydrogen', fetcher,
  });
  assert.equal(result.checks.find(item => item.check === 'Streaming').status, 'pass');
  assert.deepEqual(result.profile.streaming, { value: true, source: 'probed' });
});

test('probe-refuses-redirects-without-following-them', async () => {
  const requests = [];
  const result = await probeProvider({
    provider: { base: fakeBase, baseURL: fakeBase },
    alias: 'coder',
    backendModel: 'fixture-backend',
    fetcher: async (url, options) => {
      requests.push(String(url));
      const redirect = Response.redirect(new URL('redirected-models', fakeBase), 302);
      if (options.redirect === 'error') throw new TypeError('Redirect refused by fetch');
      if (options.redirect === 'manual') return redirect;
      requests.push(redirect.headers.get('location'));
      return Response.json({ data: [] });
    },
  });
  assert.deepEqual(requests, [fakeBase + '/models']);
  assert.equal(result.checks[0].check, 'Reachability');
  assert.equal(result.checks[0].status, 'fail');
  assert.match(result.checks[0].detail, /refused/);
});

test('probe-and-loop-report-rate-limit', async t => {
  const dir = folders(t);
  const fetcher = async (url) => {
    if (String(url).endsWith('/models')) return googleError(429, 'Resource exhausted', 'RESOURCE_EXHAUSTED');
    return googleError(429, 'Resource exhausted', 'RESOURCE_EXHAUSTED');
  };
  const probed = await probeProvider({
    provider: { base: fakeBase, baseURL: fakeBase },
    alias: 'coder', backendModel: 'gemini-4-hydrogen', fetcher,
  });
  assert.equal(probed.checks.find(item => item.check === 'Reachability').status, 'fail');
  assert.match(probed.checks.find(item => item.check === 'Reachability').detail, /rate-limited/);

  const provider = createChatProvider({
    baseURL: markerBase, locality: 'cloud', defaultModel: 'gemini-4-hydrogen',
    fetcher: async () => googleError(429, 'Resource exhausted', 'RESOURCE_EXHAUSTED'),
  });
  const workspace = copyDemoRepo(join(dir.path, 'workspace'));
  writeFileSync(join(workspace, SANDBOX_MARKER), 'bloom-sandbox-v1\n');
  const opened = openCodingSession({
    dataDirectory: join(dir.path, 'data'), workspace, provider, model: 'gemini-4-hydrogen',
    runtime: { cloud: true },
  });
  dir.closeLater(() => opened.close());
  const { ending, events } = await opened.run('List files.', () => 'allow_once');
  assert.equal(ending.status, 'rate-limited');
  assert.equal(events.filter(event => event.type === 'model.call').length, 0);
});

test('google-error-shape-maps-to-reasons', () => {
  for (const [status, error, reason] of [
    [429, null, 'rate-limited'],
    [503, { status: 'RESOURCE_EXHAUSTED' }, 'rate-limited'],
    [503, { code: 429 }, 'rate-limited'],
    [400, { status: 'UNAUTHENTICATED' }, 'http-401'],
    [400, { status: 'PERMISSION_DENIED' }, 'http-403'],
    [500, { message: 'boom' }, 'http-500'],
    [undefined, { message: 'boom' }, 'refused'],
  ]) {
    assert.equal(providerFailureReason({ status, body: { error } }), reason, error?.status);
  }
});
