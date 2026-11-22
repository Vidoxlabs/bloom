import { BloomError } from './errors.mjs';

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

async function post(url, body, { headers, signal, fetcher }) {
  let response;
  try {
    response = await fetcher(url, { method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new BloomError('PROVIDER_OFFLINE', 'Could not connect to the configured model endpoint.');
  }
  if (!response.ok) throw new BloomError('PROVIDER_REJECTED', 'The model endpoint returned HTTP ' + response.status + '. Check the model, server version and credentials.');
  try { return await response.json(); }
  catch { throw new BloomError('PROVIDER_RESPONSE', 'The model endpoint returned an unreadable response.'); }
}

function endpoint(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
    throw new Error('Use an HTTPS model URL, or HTTP on loopback. Supply credentials through the environment.');
  }
  return url.href.replace(/\/$/, '');
}

// The coordinator only needs text and metering. Alternate model providers implement generate().
export function createChatProvider({ baseURL = 'https://opencode.ai/inference/openai/v1', apiKey, defaultModel, fetcher = fetch } = {}) {
  const base = endpoint(baseURL);
  return {
    label: new URL(base).hostname === 'opencode.ai' ? 'OpenCode API' : 'Compatible API', defaultModel,
    async generate({ system, prompt, model, signal }) {
      if (!model) throw new BloomError('MODEL_REQUIRED', 'Choose a model ID for the team.', 400);
      if (new URL(base).hostname === 'opencode.ai' && !apiKey) throw new BloomError('KEY_REQUIRED', 'Set OPENCODE_API_KEY before starting Bloom, or connect a local OpenCode server.', 400);
      const data = await post(base + '/chat/completions', { model, messages: [
        { role: 'system', content: system }, { role: 'user', content: prompt },
      ], stream: false }, { signal, fetcher, headers: apiKey ? { authorization: 'Bearer ' + apiKey } : {} });
      const selected = data?.choices?.[0];
      return record({ text: selected?.message?.content, finished: selected?.finish_reason === 'stop',
        model: data?.model ?? model, usage: chatUsage(data?.usage ?? {}), costUSD: amount(data?.usage?.cost) });
    },
  };
}

export function createServerProvider({ baseURL, defaultModel, username = 'opencode', password, fetcher = fetch } = {}) {
  const base = endpoint(baseURL);
  const headers = password ? { authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64') } : {};
  return {
    label: 'OpenCode Server (v1)', defaultModel,
    async generate({ system, prompt, model, signal }) {
      const slash = model?.indexOf('/') ?? -1;
      if (model && (slash < 1 || slash === model.length - 1)) throw new BloomError('MODEL_INVALID', 'Use provider/model for an OpenCode server.', 400);
      const options = { headers, signal, fetcher };
      const session = await post(base + '/session', { title: 'Bloom team turn',
        permission: [{ permission: '*', pattern: '*', action: 'deny' }] }, options);
      if (typeof session?.id !== 'string' || !/^ses_[\w-]+$/.test(session.id)) throw new BloomError('PROVIDER_VERSION', 'Expected an OpenCode 1.x session. Check the server URL and API version.');
      const path = base + '/session/' + encodeURIComponent(session.id);
      const abort = () => { void fetcher(path + '/abort', { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(2000) }).catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (signal.aborted) { abort(); throw signal.reason; }
        const selection = model ? { model: { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } } : {};
        const reply = await post(path + '/message', { ...selection, system, parts: [{ type: 'text', text: prompt }] }, options);
        const info = reply?.info ?? {};
        const t = info.tokens ?? {};
        const breakdown = [t.input, t.output, t.reasoning, t.cache?.read, t.cache?.write];
        const total = count(t.total) ?? (breakdown.every(n => count(n) !== null) ? breakdown.reduce((a,b) => a+b,0) : null);
        const texts = Array.isArray(reply?.parts) ? reply.parts.filter(part => part?.type === 'text').map(part => part.text) : null;
        return record({ text: texts?.every(part => typeof part === 'string') ? texts.join('') : null,
          finished: info.role === 'assistant' && !info.error && info.finish === 'stop',
          model: info.modelID ? info.providerID + '/' + info.modelID : model,
          usage: { input: count(t.input), output: count(t.output), total,
            cacheRead: count(t.cache?.read), cacheWrite: count(t.cache?.write) }, costUSD: amount(info.cost) });
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
  };
}

const demoTeam = [
  { name: 'Researcher', stage: 'research', title: 'Source findings', folder: 'Research', charter: 'Extract claims and cite the supplied sources.', message: 'The source findings are ready for review.' },
  { name: 'Reviewer', stage: 'review', title: 'Evidence review', folder: 'Research', charter: 'Check each finding against its source and flag gaps.', message: 'The evidence review is ready for the assembler.' },
  { name: 'Assembler', stage: 'assemble', title: 'Reviewed guide', folder: 'Guides', charter: 'Turn the reviewed findings into a guide.', message: 'The guide is ready to open.' },
];

export const demoProvider = {
  label: 'Scripted demo', defaultModel: 'demo/scripted',
  async generate({ phase, agent, brief, documents, library = [], teams = [], signal }) {
    signal.throwIfAborted();
    let result;
    if (phase === 'plan') {
      // The scripted head recruits a saved persona for any step whose stage it covers.
      const recruited = [];
      const agents = demoTeam.map(({ name, stage, charter }) => {
        const saved = library.find(persona => persona.stage === stage);
        if (saved) recruited.push(saved.name);
        return { name: saved?.name ?? name, stage, charter, voice: 'Plain and specific.', assignment: charter };
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
