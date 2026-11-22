import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { digest } from './team-store.mjs';
import { Teams } from './teams.mjs';
import { demoProvider } from './models.mjs';
import { BloomError } from './errors.mjs';

function workspacePath(path) {
  try {
    const resolved = realpathSync(path);
    if (!statSync(resolved).isDirectory()) throw new Error('Expected a directory');
    return resolved;
  } catch {
    throw new BloomError('WORKSPACE_UNAVAILABLE', 'Choose an accessible workspace directory.', 400);
  }
}

function modelId(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 200 || /\s/.test(value)) {
    throw new BloomError('MODEL_INVALID', 'Enter a runtime model ID without spaces.', 400);
  }
  return value;
}

const endStates = new Map([
  ['end_turn', 'finished'], ['cancelled', 'stopped'], ['refusal', 'refused'],
  ['max_tokens', 'limit'], ['max_turn_requests', 'limit'],
]);

export class Harness {
  constructor({ store, adapters, dataDirectory, defaultWorkspace = '', teamProvider = demoProvider }) {
    this.store = store;
    this.adapters = new Map(adapters.map(adapter => [adapter.id, adapter]));
    this.dataDirectory = dataDirectory;
    this.defaultWorkspace = defaultWorkspace;
    this.active = new Map();
    this.listeners = new Map();
    this.closing = false;
    this.teams = new Teams(this, teamProvider);
    this.store.recover();
  }

  info() {
    return {
      adapters: [...this.adapters.values()].map(({ id, label }) => ({ id, label })),
      defaultWorkspace: this.defaultWorkspace,
      teamProvider: { label: this.teams.provider.label, model: this.teams.provider.defaultModel ?? '' },
    };
  }

  createSession({ workspace = this.defaultWorkspace, adapter = this.info().adapters[0]?.id, model }) {
    if (!this.adapters.has(adapter)) throw new BloomError('ADAPTER_UNKNOWN', 'Choose an available agent runtime.', 400);
    if (typeof workspace !== 'string' || (workspace && !isAbsolute(workspace))) {
      throw new BloomError('WORKSPACE_INVALID', 'Enter an absolute workspace path or leave it blank for Scratch.', 400);
    }
    const id = randomUUID();
    const path = workspace || join(this.dataDirectory, 'scratch', id);
    if (!workspace) mkdirSync(path, { recursive: true, mode: 0o700 });
    return this.store.createSession({ id, workspace: workspacePath(path), adapter, model: modelId(model) });
  }

  subscribe(sessionId, listener) {
    const subscribers = this.listeners.get(sessionId) ?? new Set();
    subscribers.add(listener);
    this.listeners.set(sessionId, subscribers);
    return () => {
      subscribers.delete(listener);
      if (!subscribers.size) this.listeners.delete(sessionId);
    };
  }

  publish(sessionId, event) {
    if (!event) return;
    for (const listener of this.listeners.get(sessionId) ?? []) {
      try { listener(event); } catch { /* A disconnected renderer does not own the turn. */ }
    }
  }

  event(sessionId, turnId, type, data) {
    this.publish(sessionId, this.store.event(sessionId, turnId, type, data));
  }

  start(sessionId, request) {
    const { text, model } = request;
    if (this.closing) throw new BloomError('HARNESS_CLOSING', 'Bloom is closing.', 503);
    if (typeof text !== 'string' || !text.trim() || text.length > 32_000) {
      throw new BloomError('PROMPT_INVALID', 'Enter a prompt of 1 to 32,000 characters.', 400);
    }
    let key;
    if (request.requestId !== undefined) {
      if (typeof request.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(request.requestId)) throw new BloomError('REQUEST_ID', 'Choose a valid request ID.', 400);
      key = { id: request.requestId, fingerprint: digest(JSON.stringify([text,model ?? null,request.to ?? null,request.files ?? []])) };
      const replay = this.store.replay(sessionId,key);
      if (replay) return { turnId: replay };
    }
    const session = this.store.getSession(sessionId);
    if (workspacePath(session.workspace) !== session.workspace) {
      throw new BloomError('WORKSPACE_CHANGED', 'The session workspace changed. Create a session for its new location.', 409);
    }
    const adapter = this.adapters.get(session.adapter);
    const context = session.adapter === 'team' ? this.teams.input(sessionId, request) : null;
    if (!adapter && !context) throw new BloomError('ADAPTER_UNAVAILABLE', 'The session runtime is unavailable.', 409);
    const selectedModel = model === undefined ? session.model : modelId(model);
    const { id, events, replay } = this.store.startTurn(sessionId, text, selectedModel, key);
    if (replay) return { turnId: id };
    const state = { id, controller: new AbortController(), permissions: new Map() };
    this.active.set(sessionId, state);
    for (const event of events) this.publish(sessionId, event);
    state.task = Promise.resolve().then(() => this.execute({ session, adapter, state, text, selectedModel, context }));
    return { turnId: id };
  }

  // Open a turn in another session for a team-to-team question. Stop in that session aborts only this answer.
  borrow(sessionId) {
    const { id, events } = this.store.openTurn(sessionId);
    let settle;
    const state = { id, controller: new AbortController(), permissions: new Map(), task: new Promise(resolve => { settle = resolve; }) };
    this.active.set(sessionId, state);
    for (const event of events) this.publish(sessionId, event);
    return { state, finish: (status, details) => {
      if (this.active.get(sessionId) === state) this.active.delete(sessionId);
      this.publish(sessionId, this.store.finishTurn(sessionId, id, state.controller.signal.aborted ? 'stopped' : status, details));
      settle();
    } };
  }

  async execute({ session, adapter, state, text, selectedModel, context }) {
    const sessionId = session.id;
    const signal = state.controller.signal;
    let status = 'finished';
    let details;
    try {
      if (context) {
        const result = await this.teams.run({ session, state, text, selectedModel, context });
        status = signal.aborted ? 'stopped' : result.status;
        details = { reason: result.reason };
        return;
      }
      const { stopReason } = await adapter.run({
        workspace: session.workspace, nativeId: session.native_id, model: selectedModel, prompt: text, signal,
      }, {
        emit: (type, data) => {
          if (!signal.aborted) this.event(sessionId, state.id, type, data);
        },
        bind: ({ nativeId, model, models, resumed }) => {
          this.store.bindSession(sessionId, nativeId, model ?? null);
          this.event(sessionId, state.id, 'agent.connected', { nativeId, model, models, resumed });
        },
        permission: request => this.requestPermission(sessionId, state, request),
      });
      status = signal.aborted ? 'stopped' : (endStates.get(stopReason) ?? 'interrupted');
      details = { reason: stopReason };
    } catch (error) {
      status = signal.aborted ? 'stopped' : (error.code === 'BUDGET_LIMIT' ? 'limit' : 'failed');
      if (!signal.aborted) {
        details = error instanceof BloomError
          ? { code: error.code, message: error.message }
          : { code: 'AGENT_ERROR', message: 'The agent could not finish this turn.' };
      }
    } finally {
      for (const requestId of state.permissions.keys()) this.settlePermission(sessionId, state, requestId, null);
      this.active.delete(sessionId);
      this.publish(sessionId, this.store.finishTurn(sessionId, state.id, status, details));
    }
  }

  requestPermission(sessionId, state, request) {
    if (state.controller.signal.aborted) return null;
    const id = randomUUID();
    return new Promise(resolve => {
      state.permissions.set(id, { options: request.options, resolve });
      this.event(sessionId, state.id, 'permission.requested', { id, ...request });
    });
  }

  settlePermission(sessionId, state, requestId, option) {
    const pending = state.permissions.get(requestId);
    this.event(sessionId, state.id, 'permission.resolved', { id: requestId, kind: option?.kind ?? 'cancelled' });
    state.permissions.delete(requestId);
    pending.resolve(option?.id ?? null);
  }

  decide(sessionId, requestId, { optionId }) {
    const state = this.active.get(sessionId);
    const request = state?.permissions.get(requestId);
    if (!request) throw new BloomError('PERMISSION_SETTLED', 'This permission request is no longer pending.', 409);
    const option = request.options.find(item => item.id === optionId);
    if (!option) throw new BloomError('PERMISSION_UNKNOWN', 'Choose one of the offered responses.', 400);
    this.settlePermission(sessionId, state, requestId, option);
    return { accepted: true };
  }

  stop(sessionId, { turnId }) {
    const state = this.active.get(sessionId);
    if (!state || state.id !== turnId) throw new BloomError('TURN_NOT_ACTIVE', 'This turn is no longer active.', 409);
    if (state.controller.signal.aborted) return { stopping: true };
    state.controller.abort();
    for (const id of state.permissions.keys()) this.settlePermission(sessionId, state, id, null);
    this.event(sessionId, state.id, 'turn.stopping', {});
    return { stopping: true };
  }

  async close() {
    this.closing = true;
    const tasks = [];
    for (const [sessionId, state] of this.active) {
      this.stop(sessionId, { turnId: state.id });
      tasks.push(state.task);
    }
    await Promise.allSettled(tasks);
  }
}
