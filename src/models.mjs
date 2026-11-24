import { BloomError } from './errors.mjs';
import { endpointRedactor, streamRedactor } from './endpoint-privacy.mjs';
import { providerFailureReason, readErrorBody } from './provider-errors.mjs';

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
// A generation record is { text, complete, model, usage, costUSD }. Usage holds token counts only, in five
// fields, each a non-negative integer or null. Money is a separate field because it is not a token count.
export function chatUsage(raw = {}) {
  return { input: count(raw.prompt_tokens), output: count(raw.completion_tokens), total: count(raw.total_tokens),
    cacheRead: count(raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens),
    cacheWrite: count(raw.cache_creation_input_tokens) };
}

// A reply without a text body is not a finished response, so it is never complete.
const record = ({ text, finished, model, usage, costUSD }) => typeof text === 'string'
  ? { text, complete: finished, model, usage, costUSD }
  : { text: '', complete: false, model, usage, costUSD };

async function send(url, body, { headers, signal, fetcher, label }) {
  let response;
  try {
    response = await fetcher(url, { method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new BloomError('PROVIDER_OFFLINE', 'Could not connect to ' + label + '.');
  }
  if (!response.ok) {
    const errorBody = await readErrorBody(response);
    const reason = providerFailureReason({ status: response.status, body: errorBody });
    if (reason === 'rate-limited') {
      throw new BloomError('PROVIDER_RATE_LIMITED', label + ' is rate-limited. The turn ends without retrying.');
    }
    throw new BloomError('PROVIDER_REJECTED', label + ' returned ' + reason + '. Check the model, server version and credentials.');
  }
  return response;
}

async function post(url, body, options) {
  const response = await send(url, body, options);
  try { return await response.json(); }
  catch {
    if (options.signal.aborted) throw options.signal.reason;
    throw new BloomError('PROVIDER_RESPONSE', options.label + ' returned an unreadable response.');
  }
}

// Read a chat-completions event stream. Each delta goes to onDelta as it arrives, and the reply
// comes back in the non-streamed shape: complete only when a choice reports finish_reason "stop",
// usage only when a chunk carries it. An abort rejects, so no completed record exists.
async function stream(url, body, options, onDelta, redact) {
  const response = await send(url, body, options);
  const { signal, label } = options;
  if (!response.body) throw new BloomError('PROVIDER_RESPONSE', label + ' returned an unreadable response.');
  const decoder = new TextDecoder();
  const redactor = streamRedactor(redact);
  const reader = response.body.getReader();
  let buffer = '';
  let text = '';
  let finishReason = null;
  let model = null;
  let usage = null;
  const emit = piece => {
    if (piece) {
      text += piece;
      onDelta(piece);
    }
  };
  const handle = line => {
    if (!line.startsWith('data:')) return false;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return true;
    let chunk;
    try { chunk = JSON.parse(payload); }
    catch { throw new BloomError('PROVIDER_RESPONSE', label + ' returned an unreadable response.'); }
    if (typeof chunk?.model === 'string') model = chunk.model;
    if (chunk?.usage && typeof chunk.usage === 'object') usage = chunk.usage;
    const choice = chunk?.choices?.[0];
    if (typeof choice?.delta?.content === 'string') emit(redactor.push(choice.delta.content));
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    return false;
  };
  try {
    let done = false;
    while (!done) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) if (handle(line)) { done = true; break; }
    }
    if (!done && buffer) handle(buffer);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error instanceof BloomError ? error : new BloomError('PROVIDER_RESPONSE', label + ' stopped streaming before it finished.');
  } finally {
    reader.releaseLock?.();
  }
  if (signal.aborted) throw signal.reason;
  emit(redactor.flush());
  // The same shape as a non-streamed reply, so one path builds the record.
  return { model, choices: [{ message: { content: text }, finish_reason: finishReason }], usage };
}

export function inspectEndpoint(value, { locality, allowInsecureHttp = false } = {}) {
  const rule = 'Use HTTPS, or opt in to HTTP for a user-marked local provider.';
  let url;
  try { url = new URL(value); }
  catch { throw new Error(rule); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const localProvider = locality === undefined ? local : locality === 'local';
  const http = url.protocol === 'http:';
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(http && (local || (localProvider && allowInsecureHttp))))) {
    throw new Error(rule);
  }
  const description = !localProvider ? 'cloud' : locality === 'local' ? 'local, user-marked' : 'local, loopback';
  return { base: url.href.replace(/\/$/, ''), local: localProvider, description, unencrypted: http && !local };
}

// A chat-completions endpoint is one provider behind seed's provider seam. Any service that speaks
// POST {base}/chat/completions works; Bloom names no default service and sends no key it was not given.
export function createChatProvider({
  baseURL, apiKey, defaultModel, fetcher = fetch, locality, allowInsecureHttp, terminal = false,
  label = 'the configured model endpoint', redact,
} = {}) {
  if (!baseURL) throw new Error('Choose a model endpoint in config.json.');
  const { base } = inspectEndpoint(baseURL, { locality, allowInsecureHttp });
  redact ??= endpointRedactor(baseURL);
  return {
    label: terminal ? label : 'Chat completions API', defaultModel,
    async generate({ system, prompt, model, signal, onDelta }) {
      if (!model) throw new BloomError('MODEL_REQUIRED', 'Choose a model ID for the team.', 400);
      if (terminal && /-cloud$/i.test(model)) {
        throw new BloomError('EGRESS_REFUSED', 'Cloud models are unavailable in the terminal shell.');
      }
      // With a delta callback the request streams, and the reply is read into the same shape.
      const request = typeof onDelta === 'function'
        ? (url, body, options) => stream(url, { ...body, stream: true }, options, onDelta, redact) : post;
      const data = await request(base + '/chat/completions', { model, messages: [
        { role: 'system', content: system }, { role: 'user', content: prompt },
      ], stream: false }, { signal, fetcher, label, headers: apiKey ? { authorization: 'Bearer ' + apiKey } : {} });
      const selected = data?.choices?.[0];
      return record({ text: redact(selected?.message?.content), finished: selected?.finish_reason === 'stop',
        model: redact(data?.model ?? model), usage: data?.usage ? chatUsage(data.usage) : null, costUSD: amount(data?.usage?.cost) });
    },
  };
}

// Without an endpoint the workspace still opens: files, notes and history stay usable, and a team turn
// stops with this message instead of reaching a service nobody chose.
export const unconfiguredProvider = {
  label: 'No model endpoint', defaultModel: undefined,
  async generate(_call) {
    throw new BloomError('PROVIDER_UNCONFIGURED', 'Set a provider in config.json under the data directory to give teams a model.', 409);
  },
};

const demoTeam = [
  { name: 'Researcher', stage: 'research', title: 'Source findings', folder: 'Research', charter: 'Extract claims and cite the supplied sources.', message: 'The source findings are ready for review.' },
  { name: 'Reviewer', stage: 'review', title: 'Evidence review', folder: 'Research', charter: 'Check each finding against its source and flag gaps.', message: 'The evidence review is ready for the assembler.' },
  { name: 'Assembler', stage: 'assemble', title: 'Reviewed guide', folder: 'Guides', charter: 'Turn the reviewed findings into a guide.', message: 'The guide is ready to open.' },
];
export const demoProvider = {
  label: 'Scripted demo', defaultModel: 'demo/scripted',
  fixtureMembers: Object.freeze(demoTeam.map(({ name, charter, stage }) =>
    Object.freeze({ name, charter, stage, voice: 'Plain and specific.', model: null }))),
  async generate({ phase, agent, brief, documents, library = [], teams = [], signal }) {
    signal.throwIfAborted();
    let result;
    if (phase === 'plan') {
      // The scripted head recruits a saved persona for any step whose stage it covers.
      const recruited = [];
      const agents = demoTeam.map(({ name, stage, charter }) => {
        const saved = library.find(persona => persona.stage === stage);
        if (saved) recruited.push(saved.name);
        return { name: saved?.name ?? name, assignment: charter };
      });
      result = { message: recruited.length ? 'I assigned three steps and recruited ' + recruited.join(' and ') + ' from the persona library.' : 'I assigned three steps for this brief.', agents };
      // The scripted head asks another team when the brief names it after "ask".
      const asked = /\bask\b/i.test(brief) && teams.find(name => brief.toLowerCase().includes(name.toLowerCase()));
      if (asked) result.ask = { team: asked, question: 'What should we know before we start on this brief?' };
    } else if (phase === 'answer') {
      result = { message: 'From our side: ' + agent.charter.replace(/\.$/, '') + '. We have nothing else on record that we can share for this.' };
    } else {
      const role = demoTeam.find(member => member.stage === agent.stage);
      const title = role?.title ?? 'Work notes';
      const sources = documents.map(file => '- ' + file.title).join('\n') || 'No sources attached.';
      const briefText = brief.length > 2000 ? brief.slice(0, 2000).trimEnd() + '…' : brief;
      // The scripted assembler revises its earlier guide when that guide is supplied again.
      const previous = documents.find(file => file.title === agent.name + ' · ' + title && agent.stage === 'assemble');
      result = { title: agent.name + ' · ' + title, message: previous ? 'I revised the guide; the earlier version stays in its history.' : role?.message ?? 'The work notes are ready.',
        document: '# ' + title + '\n\nScripted example for this brief.\n\n' + briefText + '\n\n## Inputs\n\n' + sources,
        verdict: agent.stage === 'review' ? 'approve' : undefined, folder: role?.folder, revises: previous?.id,
        remember: agent.stage === 'research' && documents.length ? [documents[0].title.slice(0, 120) + ' is a source this team has worked from.'] : undefined };
    }
    return { text: JSON.stringify(result), complete: true, model: 'demo/scripted', usage: chatUsage(), costUSD: null };
  },
};
