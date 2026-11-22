import { teamView } from './team.js';
const $ = id => document.getElementById(id);
const drafts = new Map();
const pendingSends = new Map();
const labels = {
  idle: 'Idle', running: 'Running', stopping: 'Stopping', finished: 'Turn ended',
  stopped: 'Stopped', refused: 'Refused', failed: 'Failed', limit: 'Limit reached',
  interrupted: 'Interrupted', pending: 'Pending', in_progress: 'Running', completed: 'Completed',
  unknown: 'Outcome unavailable', revision: 'Changes requested',
};
const state = {
  sessions: [], session: null, stream: null, currentTurn: null, turnState: 'idle',
  submitting: false, starting: false, connected: false, tools: new Map(),
  approvals: new Map(), messages: new Map(), adapterLabels: new Map(),
};

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}

async function request(path, body, method = 'POST') {
  const response = await fetch(path, body === undefined ? {} : {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? 'The request failed.');
  return data;
}

function error(message = '') {
  $('error').textContent = message;
  $('error').hidden = !message;
}

const team = teamView({ $, node, request, error, state });

function sessionEndpoint(id, suffix) { return '/api/sessions/' + id + '/' + suffix; }

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
  $('activity-empty').hidden = false;
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

  const stream = new EventSource(sessionEndpoint(session.id, 'events'));
  state.stream = stream;
  stream.onopen = () => {
    if (state.stream !== stream) return;
    state.connected = true;
    $('connection').textContent = '';
    updateComposer();
  };
  stream.onerror = () => {
    if (state.stream !== stream) return;
    state.connected = false;
    $('connection').textContent = 'Reconnecting';
    updateComposer();
  };
  stream.onmessage = message => {
    if (state.stream === stream) apply(JSON.parse(message.data));
  };
}

function message(turnId, role, text, speaker, file, assignments, verdict) {
  $('conversation-placeholder')?.remove();
  const transcript = $('transcript');
  const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 90;
  const key = turnId + '/' + role + '/' + (speaker ?? '');
  let content = state.messages.get(key);
  if (!content) {
    const article = node('article', null, 'message is-' + role);
    article.dataset.role = role;
    const author = speaker ?? (role === 'user' ? 'You' : state.adapterLabels.get(state.session.adapter) ?? 'Agent');
    content = node('p');
    article.append(node('header', author), content);
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
  const row = current?.row ?? node('li');
  const tool = { ...current?.tool, ...update };
  if (!current) $('tools').append(row);
  state.tools.set(tool.id, { tool, row });
  const detail = node('div', tool.title || tool.name || 'Tool call', 'tool-title');
  if (tool.name && tool.name !== tool.title) detail.append(node('code', tool.name, 'tool-name'));
  row.dataset.phase = tool.status ?? 'pending';
  row.replaceChildren(detail, node('span', labels[row.dataset.phase] ?? labels.pending, 'step-state'));
  $('activity-empty').hidden = true;
}

function renderApproval({ id, title, options }) {
  const card = node('div', null, 'approval');
  card.append(node('strong', 'Approval needed'), node('p', title));
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

function apply({ turnId, type, data }) {
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
      $('usage').textContent = 'Tokens: ' + (data.total ?? 'unreported') + ' · Input: ' + (data.input ?? 'unreported') + ' · Output: ' + (data.output ?? 'unreported') + ' · Cache read: ' + (data.cacheRead ?? 'unreported') + ' · Cache write: ' + (data.cacheWrite ?? 'unreported');
      break;
    case 'team.message':
      message(turnId, 'assistant', data.text, data.author, data.file, data.assignments, data.verdict);
      void team.refresh().catch(e => error(e.message));
      break;
    case 'assistant.delta': message(turnId, 'assistant', data.text); break;
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

try {
  const info = await request('/api/info');
  state.adapterLabels = new Map(info.adapters.map(({ id, label }) => [id, label]));
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
