// Probe a configured chat-completions provider and build a model profile from what it shows.
// A value the server reports is "reported", one the probe saw work is "probed", and anything it
// neither reports nor shows is "unknown". An unknown check is never a pass.
import { modelProfile } from '@vidoxlabs/seed';

import { endpointRedactor } from './endpoint-privacy.mjs';
import { providerFailureReason, readErrorBody } from './provider-errors.mjs';

const listedId = id => String(id).replace(/^models\//, '');

export const PROBE_TIMEOUTS = Object.freeze({ list: 5_000, stream: 30_000 });
// The only message the probe sends. It carries nothing from the user.
export const PROBE_MESSAGE = 'Reply with OK.';

const TLS_CODES = /^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO|ERR_CERT)/;
const unknown = { value: null, source: 'unknown' };
const MAX_LISTED = 10;

// The reason a request failed, in words that never carry the address.
function failure(error, signal) {
  if (signal?.aborted) return 'timeout';
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  const code = error?.cause?.code ?? error?.code;
  if (typeof code === 'string' && TLS_CODES.test(code)) return 'tls';
  return 'refused';
}

// Each request gets its own timer, which also bounds reading the reply; `clear` stops it.
async function request(fetcher, url, init, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('The probe timed out.', 'TimeoutError')), timeout);
  const { signal } = controller;
  const clear = () => clearTimeout(timer);
  try {
    const response = await fetcher(url, { redirect: 'error', ...init, signal });
    if (response.ok) return { response, signal, clear };
    const body = await readErrorBody(response);
    clear();
    return { reason: providerFailureReason({ status: response.status, body }) };
  } catch (error) {
    clear();
    return { reason: failure(error, signal) };
  }
}

const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;
function contextLength(entry) {
  for (const field of ['context_length', 'max_model_len', 'max_context_length', 'context_window']) {
    const value = positive(entry?.[field]);
    if (value) return { value, source: 'reported' };
  }
  return unknown;
}

// A capability counts as reported only when the entry names it in a list it publishes.
function listed(entry, names) {
  const lists = [entry?.capabilities, entry?.supported_parameters].filter(Array.isArray);
  if (lists.length === 0) return unknown;
  const found = lists.some(list => list.some(item => typeof item === 'string' && names.includes(item.toLowerCase())));
  return found ? { value: true, source: 'reported' } : unknown;
}

// Read the reply only far enough to see whether it streams, then stop.
// A thinking model may send empty content or finish with length; one SSE data chunk is enough.
async function streams(response) {
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/event-stream') || !response.body) {
    await response.body?.cancel().catch(() => {});
    return false;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return false;
      buffer += decoder.decode(next.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        return true;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

const described = slot => slot.source === 'unknown' ? 'unknown: not reported by the server'
  : (slot.value === true ? 'yes' : slot.value === false ? 'no' : String(slot.value)) + ', ' + slot.source;
const statusOf = slot => slot.source === 'unknown' ? 'unknown' : 'pass';

export async function probeProvider({
  provider, alias, backendModel, credential, fetcher = fetch, timeouts = PROBE_TIMEOUTS,
}) {
  const redact = endpointRedactor(provider.baseURL);
  const headers = credential ? { authorization: 'Bearer ' + credential } : {};
  const checks = [];
  const add = (check, status, detail) => checks.push({ check, status, detail: redact(detail) });
  const slots = { model: unknown, contextLength: unknown, toolCalling: unknown, constrainedOutput: unknown, streaming: unknown };
  const finish = () => ({ checks, profile: modelProfile(slots) });

  const listing = await request(fetcher, provider.base + '/models', { method: 'GET', headers }, timeouts.list);
  let data;
  if (listing.response) {
    try { data = await listing.response.json(); }
    catch { listing.reason = failure(null, listing.signal) === 'timeout' ? 'timeout' : 'unreadable'; }
    finally { listing.clear(); }
  }
  const entries = Array.isArray(data?.data) ? data.data.filter(entry => typeof entry?.id === 'string') : null;
  if (!entries) {
    add('Reachability', 'fail', 'The models list failed: ' + (listing.reason ?? 'unreadable') + '.');
    return finish();
  }
  add('Reachability', 'pass', 'The models list answered with ' + entries.length + ' model' + (entries.length === 1 ? '' : 's') + '.');
  const ids = entries.map(entry => entry.id);
  const shown = ids.slice(0, MAX_LISTED).join(', ') + (ids.length > MAX_LISTED ? ', and ' + (ids.length - MAX_LISTED) + ' more' : '');
  add('Model IDs', ids.length ? 'pass' : 'unknown', ids.length ? shown : 'unknown: the server listed no models');
  const entry = entries.find(item => item.id === backendModel || listedId(item.id) === listedId(backendModel));
  if (!entry) {
    add('Model', 'fail', 'Alias ' + alias + ' is not among the listed models.');
    return finish();
  }
  add('Model', 'pass', 'Alias ' + alias + ' is listed.');
  slots.model = { value: backendModel, source: 'probed' };
  slots.contextLength = contextLength(entry);
  slots.toolCalling = listed(entry, ['tools', 'tool_calling', 'function_calling', 'tool_choice']);
  slots.constrainedOutput = listed(entry, ['response_format', 'structured_outputs', 'json_schema', 'json_mode']);

  const body = JSON.stringify({ model: backendModel, messages: [{ role: 'user', content: PROBE_MESSAGE }], max_tokens: 1, stream: true });
  const streamed = await request(fetcher, provider.base + '/chat/completions',
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }, timeouts.stream);
  if (streamed.response) {
    try { slots.streaming = { value: await streams(streamed.response), source: 'probed' }; }
    catch (error) { streamed.reason = failure(error, streamed.signal); }
    finally { streamed.clear(); }
  }
  add('Context length', statusOf(slots.contextLength), described(slots.contextLength));
  add('Streaming', statusOf(slots.streaming), slots.streaming.source === 'unknown'
    ? 'unknown: the one-token request failed: ' + streamed.reason + '.' : described(slots.streaming));
  add('Tool calling', statusOf(slots.toolCalling), described(slots.toolCalling));
  add('Constrained output', statusOf(slots.constrainedOutput), described(slots.constrainedOutput));
  return finish();
}
