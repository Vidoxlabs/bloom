import { modelRow, outputViewer, toolRow, usageBudget } from './coding-view.js';
import { teamView } from './team.js';
const $ = id => document.getElementById(id);
const drafts = new Map();
const pendingSends = new Map();
const labels = {
  idle: 'Idle', running: 'Running', stopping: 'Stopping', finished: 'Turn ended',
  stopped: 'Stopped', refused: 'Refused', failed: 'Failed', limit: 'Limit reached',
  interrupted: 'Interrupted', pending: 'Pending', in_progress: 'Running', completed: 'Completed',
  unknown: 'Outcome unavailable', revision: 'Changes requested',
  denied: 'Declined', 'invalid-output': 'Invalid output',
};
const state = {
  sessions: [], session: null, stream: null, currentTurn: null, turnState: 'idle',
  submitting: false, starting: false, connected: false, tools: new Map(),
  approvals: new Map(), messages: new Map(), adapterLabels: new Map(), usage: {},
};

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}

// The owner credential for this launch lives in this tab's session storage. That storage belongs
// to this origin (scheme, host and port), so a page on another port cannot read it, and it ends
// when the tab closes. The credential goes out only as a request header, never as a cookie.
const ownerKey = 'vibloom.owner';
function ownerCredential() {
  try { return sessionStorage.getItem(ownerKey); } catch { return null; }
}
function keepCredential(value) {
  try {
    if (value) sessionStorage.setItem(ownerKey, value);
    else sessionStorage.removeItem(ownerKey);
  } catch {
    // Storage is unavailable; this tab then stays signed out.
  }
}
function ownerHeaders(headers = {}) {
  const credential = ownerCredential();
  return credential ? { ...headers, 'x-bloom-owner': credential } : headers;
}
// A refused credential (for example after a restart) is not worth keeping.
function checkSignedIn(response) {
  if (response.status === 401) keepCredential(null);
}

async function request(path, body, method = 'POST') {
  const response = await fetch(path, body === undefined ? { headers: ownerHeaders() } : {
    method,
    headers: ownerHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
  checkSignedIn(response);
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? 'The request failed.');
  return data;
}

// The launch link carries a one-time code in its fragment. Remove it from the address bar and
// this history entry before using it, then trade it for the launch's owner credential.
async function claimLaunch() {
  const code = /^#launch=([\w-]{1,128})$/.exec(location.hash)?.[1];
  if (!code) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const { credential } = await request('/api/launch', { code });
    keepCredential(credential);
  } catch {
    // A used or stale code: the next request reports whether this tab is still signed in.
  }
}
// Opening the link again in a tab that already shows Bloom changes only the fragment.
window.addEventListener('hashchange', () => void claimLaunch());

function error(message = '') {
  $('error').textContent = message;
  $('error').hidden = !message;
}

const team = teamView({ $, node, request, error, state });

function sessionEndpoint(id, suffix) { return '/api/sessions/' + id + '/' + suffix; }

// The session's event stream, read with fetch because EventSource cannot send the owner header.
// It resumes after the last event id it saw, retries a dropped connection, and stops when the
// server refuses it. Handlers: onopen(), onerror(closed), onmessage({ data }).
function eventStream(id, handlers) {
  const controller = new AbortController();
  let after = 0;
  let retry = 1000;
  async function read() {
    const response = await fetch(sessionEndpoint(id, 'events') + '?after=' + after, {
      headers: ownerHeaders({ accept: 'text/event-stream' }), cache: 'no-store', signal: controller.signal,
    });
    checkSignedIn(response);
    if (!response.ok || !response.body) return response.status >= 400 && response.status < 500;
    retry = 1000;
    handlers.onopen?.();
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return false;
      buffer += value;
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop();
      for (const block of blocks) {
        let data = null;
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('id:')) {
            const seq = Number(line.slice(3).trim());
            if (Number.isSafeInteger(seq) && seq >= 0) after = seq;
          } else if (line.startsWith('data:')) {
            data = (data === null ? '' : data + '\n') + line.slice(5).replace(/^ /, '');
          }
        }
        if (data !== null && !controller.signal.aborted) handlers.onmessage?.({ data });
      }
    }
  }
  void (async () => {
    while (!controller.signal.aborted) {
      let closed = false;
      try { closed = await read(); } catch { /* a dropped connection; retry below */ }
      if (controller.signal.aborted) return;
      handlers.onerror?.(closed);
      if (closed) return;
      await new Promise(resolve => setTimeout(resolve, retry));
      retry = Math.min(retry * 2, 15000);
    }
  })();
  return { close: () => controller.abort() };
}

function showForm(open) {
  $('session-form').hidden = !open;
  $('new-session').setAttribute('aria-expanded', String(open));
  if (open) { team.configure(); $('kind').focus(); }
}

function renderSessionList() {
  $('session-list').replaceChildren(...state.sessions.map(session => {
    const button = node('button', session.title, 'session-button');
    button.type = 'button';
    button.title = session.workspace;
    button.setAttribute('aria-current', String(session.id === state.session?.id));
    button.onclick = () => selectSession(session);
    return button;
  }));
}

async function refreshSessions() {
  state.sessions = await request('/api/sessions');
  const selected = state.sessions.find(session => session.id === state.session?.id);
  if (selected) {
    state.session = selected;
    $('session-title').textContent = selected.title;
  }
  renderSessionList();
}

function showTurnState(status) {
  state.turnState = status;
  $('turn-state').textContent = labels[status] ?? status;
  $('turn-state').dataset.state = status;
}

function updateComposer() {
  const active = Boolean(state.currentTurn) || state.starting;
  $('send').disabled = !state.connected || active || state.submitting;
  $('model').disabled = active;
  $('stop').hidden = !state.currentTurn;
  $('stop').disabled = state.turnState === 'stopping';
}

function clearActivity() {
  state.tools.clear();
  state.approvals.clear();
  $('plan').replaceChildren();
  $('tools').replaceChildren();
  $('approvals').replaceChildren();
  state.usage = {};
  $('usage').replaceChildren();
  $('activity-empty').hidden = false;
}

function renderUsage() {
  // A team session renders its own usage summary, per actor, into the same region.
  if (state.session?.adapter === 'team') return;
  $('usage').replaceChildren(usageBudget(state.usage));
}

function selectSession(session) {
  if (session.id === state.session?.id) return;
  if (state.session) drafts.set(state.session.id, $('prompt').value);
  state.stream?.close();
  state.session = session;
  team.reset();
  void team.refresh().catch(e => error(e.message));
  state.currentTurn = null;
  state.connected = false;
  state.starting = Boolean(session.active);
  state.messages.clear();
  clearActivity();
  $('transcript').replaceChildren();
  const waiting = node('p', session.adapter === 'team' ? 'Give the head agent a task. Check the shared desktop when the team needs evidence.' : 'Start a turn in this workspace.', 'empty');
  waiting.id = 'conversation-placeholder';
  $('transcript').append(waiting);
  $('session-title').textContent = session.title;
  const showPath = session.adapter !== 'team';
  $('session-path').textContent = showPath ? session.workspace : '';
  $('session-path').title = showPath ? session.workspace : '';
  $('session-path').hidden = !showPath;
  $('model').value = session.model ?? '';
  $('models').replaceChildren();
  $('prompt').value = drafts.get(session.id) ?? '';
  $('composer').hidden = false;
  $('connection').textContent = 'Connecting';
  showTurnState('idle');
  updateComposer();
  error();
  localStorage.setItem('vibloom.session', session.id);
  renderSessionList();

  const stream = eventStream(session.id, {
    onopen() {
      if (state.stream !== stream) return;
      state.connected = true;
      $('connection').textContent = '';
      updateComposer();
    },
    onerror(closed) {
      if (state.stream !== stream) return;
      state.connected = false;
      // A refused stream (for example after a restart) closes instead of retrying.
      $('connection').textContent = closed ? 'Disconnected' : 'Reconnecting';
      if (closed) error('The workspace stream closed. If Bloom restarted, open the new launch link it printed.');
      updateComposer();
    },
    onmessage(message) {
      if (state.stream === stream) apply(JSON.parse(message.data));
    },
  });
  state.stream = stream;
}

function message(turnId, role, text, speaker, file, assignments, verdict, extra = {}) {
  $('conversation-placeholder')?.remove();
  const transcript = $('transcript');
  const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 90;
  const key = extra.key ?? turnId + '/' + role + '/' + (speaker ?? '');
  let content = state.messages.get(key);
  if (!content) {
    const article = node('article', null, 'message is-' + role);
    article.dataset.role = role;
    const author = speaker ?? (role === 'user' ? 'You' : state.adapterLabels.get(state.session.adapter) ?? 'Agent');
    content = node('p');
    article.append(node('header', author), content);
    // Team-to-team messages say which team they came from or went to.
    if (extra.toTeam) { article.classList.add('is-crossteam'); article.insertBefore(node('p', 'Question for ' + extra.toTeam.name, 'hint'), content); }
    if (extra.fromTeam) { article.classList.add('is-crossteam'); article.insertBefore(node('p', 'From team ' + extra.fromTeam.name, 'hint'), content); }
    if (assignments) {
      const list = node('ul');
      for (const a of assignments) list.append(node('li', a.name + ' — ' + a.assignment));
      article.append(list);
    }
    if (verdict) article.append(node('p', verdict === 'approve' ? 'Review approved' : 'Changes requested', 'hint'));
    if (file) {
      const button = node('button', 'Open ' + file.title, 'file-button');
      button.onclick = () => team.read(file.id).catch(e => error(e.message));
      article.append(button);
    }
    transcript.append(article);
    state.messages.set(key, content);
  }
  content.append(document.createTextNode(text));
  if (atBottom || role === 'user') transcript.scrollTop = transcript.scrollHeight;
}

function renderPlan(entries) {
  $('plan').replaceChildren(...entries.map(({ text, status }) => {
    const step = node('li');
    step.dataset.phase = status;
    step.append(node('span', text), node('span', labels[status] ?? labels.pending, 'step-state'));
    return step;
  }));
  if (entries.length) $('activity-empty').hidden = true;
}

function renderTool(update) {
  const current = state.tools.get(update.id);
  const row = current?.row ?? node('li', null, 'tool-call-trace-card');
  const tool = { ...current?.tool, ...update };
  if (!current) $('tools').append(row);
  state.tools.set(tool.id, { tool, row });
  const view = toolRow(tool);
  const detail = node('div', view.title, 'tool-title');
  if (view.name) detail.append(node('code', view.name, 'tool-name'));
  if (view.meta) detail.append(node('span', view.meta, 'hint'));
  row.dataset.phase = view.phase;
  row.replaceChildren(detail, node('span', labels[view.phase] ?? labels.pending, 'step-state'));
  if (view.output) row.append(outputViewer(view.title, view.output));
  state.usage.toolCalls = state.tools.size;
  renderUsage();
  $('activity-empty').hidden = true;
}

// One row per model call, beside the tool rows, in call order.
function renderModelCall(data) {
  const row = node('li', null, 'tool-call-trace-card');
  row.dataset.phase = data.complete ? 'completed' : 'failed';
  row.append(node('div', modelRow(data), 'tool-title'), node('span', data.complete ? 'Complete' : 'Incomplete', 'step-state'));
  $('tools').append(row);
  state.usage.modelCalls = data.call;
  renderUsage();
  $('activity-empty').hidden = true;
}

function renderApproval({ id, title, detail, options }) {
  const card = node('div', null, 'approval');
  card.append(node('strong', 'Approval needed'), node('p', title));
  if (detail) card.append(node('pre', detail, 'approval-detail'));
  const actions = node('div', null, 'form-actions');
  const sessionId = state.session.id;
  for (const option of options) {
    const button = node('button', option.label, option.kind === 'allow_once' ? 'primary' : 'quiet');
    button.type = 'button';
    button.onclick = async () => {
      for (const item of actions.children) item.disabled = true;
      try {
        await request(sessionEndpoint(sessionId, 'permissions/' + id), { optionId: option.id });
      } catch (failure) {
        if (state.session?.id === sessionId) error(failure.message);
        for (const item of actions.children) item.disabled = false;
      }
    };
    actions.append(button);
  }
  card.append(actions);
  state.approvals.set(id, { card });
  $('approvals').prepend(card);
  $('activity-empty').hidden = true;
}

function resolveApproval(id, kind) {
  const item = state.approvals.get(id);
  if (!item) return;
  const label = { allow_once: 'Allowed once', allow_always: 'Allowed always', reject_once: 'Declined', cancelled: 'Request closed' }[kind];
  item.card.querySelector('strong').textContent = label;
  item.card.querySelector('.form-actions')?.remove();
  state.approvals.delete(id);
}

function apply({ seq, turnId, type, data }) {
  team.activity(type, data);
  switch (type) {
    case 'user.message':
      message(turnId, 'user', data.text);
      break;
    case 'turn.started':
      state.currentTurn = turnId;
      state.starting = false;
      if (typeof data.title === 'string' && state.session.title !== data.title) {
        state.session.title = data.title;
        $('session-title').textContent = data.title;
        renderSessionList();
      }
      clearActivity();
      showTurnState('running');
      updateComposer();
      break;
    case 'agent.connected':
      if (typeof data.model === 'string') $('model').value = data.model;
      if (data.models?.length) {
        $('models').replaceChildren(...data.models.map(model => {
          const option = node('option');
          option.value = model.id;
          option.label = model.label;
          return option;
        }));
      }
      break;
    case 'model.usage':
      Object.assign(state.usage, { ...data, usage: true });
      renderUsage();
      break;
    // A team turn nests its figures under `usage`, beside the actor and the call count.
    case 'team.usage':
      Object.assign(state.usage, { ...data, ...(data.usage ?? {}), usage: true });
      renderUsage();
      break;
    case 'team.call':
      Object.assign(state.usage, { modelCalls: data.calls, modelLimit: data.limit });
      renderUsage();
      break;
    case 'team.message':
      message(turnId, 'assistant', data.text, data.author, data.file, data.assignments, data.verdict,
        { key: 'event/' + seq, toTeam: data.toTeam, fromTeam: data.fromTeam });
      void team.refresh().catch(e => error(e.message));
      break;
    case 'assistant.delta':
      // The coding loop's answer arrives whole and marked final, after the streamed replies.
      if (data.final) message(turnId, 'assistant', data.text, 'Answer', null, null, null, { key: turnId + '/answer' });
      else message(turnId, 'assistant', data.text);
      break;
    case 'model.call': renderModelCall(data); break;
    case 'plan.updated': renderPlan(data.entries); break;
    case 'tool.updated': renderTool(data); break;
    case 'permission.requested': renderApproval(data); break;
    case 'permission.resolved': resolveApproval(data.id, data.kind); break;
    case 'turn.stopping':
      showTurnState('stopping');
      updateComposer();
      break;
    case 'turn.finished':
      if (state.currentTurn !== turnId) break;
      state.currentTurn = null;
      state.starting = false;
      for (const id of state.approvals.keys()) resolveApproval(id, 'cancelled');
      for (const { tool } of state.tools.values()) {
        if (tool.status !== 'completed' && tool.status !== 'failed') renderTool({ id: tool.id, status: 'unknown' });
      }
      showTurnState(data.status);
      if (data.message) error(data.message);
      updateComposer();
      void refreshSessions().catch(() => {});
      break;
  }
}

$('new-session').onclick = () => showForm($('session-form').hidden);
$('dismiss-session').onclick = () => showForm(false);
$('empty-start').onclick = () => { $('kind').value = 'team'; showForm(true); };
$('empty-direct').onclick = () => { $('kind').value = 'direct'; showForm(true); };
$('session-form').onsubmit = async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type=submit]');
  button.disabled = true;
  try {
    const session = $('kind').value === 'team' ? await team.create() : await request('/api/sessions', { workspace: $('workspace').value.trim() });
    state.sessions.unshift(session);
    showForm(false);
    selectSession(session);
    $('prompt').focus();
  } catch (failure) {
    error(failure.message);
  } finally {
    button.disabled = false;
  }
};

$('composer').onsubmit = async event => {
  event.preventDefault();
  if ($('send').disabled) return;
  const sessionId = state.session.id;
  const text = $('prompt').value;
  const model = $('model').value.trim();
  state.submitting = true;
  error();
  updateComposer();
  try {
    const body = { text, model: model || undefined, ...(state.session.adapter === 'team' ? team.target() : {}) };
    const fingerprint = JSON.stringify(body);
    const previous = pendingSends.get(sessionId);
    const requestId = previous?.fingerprint === fingerprint ? previous.requestId : crypto.randomUUID();
    pendingSends.set(sessionId, { requestId, fingerprint });
    await request(sessionEndpoint(sessionId, 'turns'), { ...body, requestId });
    pendingSends.delete(sessionId);
    drafts.delete(sessionId);
    if (state.session.id === sessionId && $('prompt').value === text) $('prompt').value = '';
  } catch (failure) {
    if (state.session.id === sessionId) error(failure.message);
  } finally {
    state.submitting = false;
    updateComposer();
  }
};

$('prompt').onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
};

$('stop').onclick = async () => {
  const { session, currentTurn } = state;
  if (!currentTurn) return;
  try { await request(sessionEndpoint(session.id, 'stop'), { turnId: currentTurn }); }
  catch (failure) { if (state.session.id === session.id) error(failure.message); }
};

// A plain link cannot send the owner header, so the reader's download is fetched with it and
// saved from a local object URL.
$('download').addEventListener('click', async event => {
  event.preventDefault();
  try {
    const response = await fetch(event.currentTarget.href, { headers: ownerHeaders() });
    checkSignedIn(response);
    if (!response.ok) throw new Error((await response.json()).message ?? 'The download failed.');
    const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'file.md';
    const url = URL.createObjectURL(await response.blob());
    const save = Object.assign(document.createElement('a'), { href: url, download: name, hidden: true });
    document.body.append(save);
    save.click();
    save.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (failure) {
    error(failure.message);
  }
});

try {
  await claimLaunch();
  const info = await request('/api/info');
  state.adapterLabels = new Map(info.adapters.map(({ id, label }) => [id, label]));
  // A coding session needs a runtime. Without one, offer teams only.
  if (!info.adapters.length) {
    $('kind').querySelector('option[value="direct"]')?.remove();
    $('empty-direct').hidden = true;
  }
  $('runtime').textContent = info.teamProvider.label;
  $('team-model').value = info.teamProvider.model;
  $('workspace').value = info.defaultWorkspace ?? '';
  await Promise.all([refreshSessions(), team.loadPersonas()]);
  const last = state.sessions.find(session => session.id === localStorage.getItem('vibloom.session'));
  if (last ?? state.sessions[0]) selectSession(last ?? state.sessions[0]);
} catch (failure) {
  $('runtime').textContent = 'Unavailable';
  error(failure.message);
}
