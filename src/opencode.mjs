import { AcpClient } from './acp-client.mjs';
import { BloomError } from './errors.mjs';

const statuses = new Set(['pending', 'in_progress', 'completed', 'failed']);
const optionKinds = new Set(['allow_once', 'allow_always', 'reject_once']);
const cancelled = () => ({ outcome: { outcome: 'cancelled' } });
const bounded = (value, size) => typeof value === 'string' ? value.slice(0, size) : undefined;
const array = value => Array.isArray(value) ? value : [];

function modelCatalog(info) {
  const config = array(info?.configOptions).find(option => option?.category === 'model' || option?.id === 'model');
  const options = config
    ? array(config.options).flatMap(option => Array.isArray(option.options) ? option.options : [option])
    : array(info?.models?.availableModels);
  const models = options.flatMap(option => {
    const id = bounded(option?.value ?? option?.modelId, 200);
    return id ? [{ id, label: bounded(option?.name, 130) ?? id }] : [];
  }).slice(0, 300);
  return {
    configId: config?.id,
    model: bounded(config?.currentValue ?? info?.models?.currentModelId, 200),
    legacy: Boolean(info?.models),
    models,
  };
}

function projectUpdate(update) {
  switch (update?.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = update.content?.type === 'text' ? bounded(update.content.text, 100_000) : undefined;
      return text ? ['assistant.delta', { text }] : null;
    }
    case 'plan': {
      const entries = array(update.entries).slice(0, 40).flatMap(item => {
        const text = bounded(item?.content, 500);
        if (!text) return [];
        return [{ text, status: statuses.has(item.status) ? item.status : 'pending' }];
      });
      return ['plan.updated', { entries }];
    }
    case 'tool_call':
    case 'tool_call_update': {
      const id = bounded(update.toolCallId, 160);
      if (!id) return null;
      return ['tool.updated', {
        id, title: bounded(update.title, 200), name: bounded(update.name, 120),
        kind: bounded(update.kind, 40),
        status: statuses.has(update.status) ? update.status : undefined,
      }];
    }
    default: return null;
  }
}

export function createOpenCodeAdapter({ command = 'opencode', prefixArgs = [] } = {}) {
  return {
    id: 'opencode',
    label: 'OpenCode',
    async run(input, hooks) {
      const { workspace, nativeId: savedId, model, prompt, signal } = input;
      if (signal.aborted) return { stopReason: 'cancelled' };
      let nativeId;
      let prompting = false;
      let cancellationTimer;
      const client = new AcpClient({
        command, args: [...prefixArgs, 'acp', '--cwd', workspace], cwd: workspace,
        onNotification(method, params) {
          if (method !== 'session/update' || !prompting || params?.sessionId !== nativeId) return;
          const update = projectUpdate(params.update);
          if (update) hooks.emit(...update);
        },
        async onRequest(method, params) {
          if (method !== 'session/request_permission') return undefined;
          if (!prompting || signal.aborted || params?.sessionId !== nativeId) return cancelled();
          const toolCall = params.toolCall ?? {};
          const options = array(params.options).slice(0, 16).flatMap(option => {
            if (!optionKinds.has(option?.kind) || typeof option.optionId !== 'string' || option.optionId.length > 160) return [];
            return [{ id: option.optionId, label: bounded(option.name, 60) ?? option.kind, kind: option.kind }];
          });
          if (!options.length) return cancelled();
          const selected = await hooks.permission({
            title: bounded(toolCall.title, 200) || bounded(toolCall.name, 120) || 'Tool action',
            kind: bounded(toolCall.kind, 40), toolId: bounded(toolCall.toolCallId, 160), options,
          });
          return selected && !signal.aborted
            ? { outcome: { outcome: 'selected', optionId: selected } }
            : cancelled();
        },
      });
      const cancel = () => {
        if (!prompting || !nativeId) {
          client.close();
          return;
        }
        try {
          client.notify('session/cancel', { sessionId: nativeId });
          cancellationTimer = setTimeout(() => client.close(), 1500);
        } catch {
          client.close();
        }
      };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const init = await client.request('initialize', {
          protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'bloom', version: '0.5.0' },
        });
        if (init?.protocolVersion !== 1) throw new BloomError('ACP_VERSION', 'OpenCode did not negotiate ACP v1.');
        const request = { cwd: workspace, mcpServers: [] };
        let info;
        if (savedId) {
          if (init.agentCapabilities?.loadSession !== true) {
            throw new BloomError('RESUME_UNAVAILABLE', 'This runtime cannot load the saved OpenCode session.');
          }
          info = await client.request('session/load', { ...request, sessionId: savedId });
          nativeId = savedId;
        } else {
          info = await client.request('session/new', request);
          nativeId = info?.sessionId;
        }
        if (typeof nativeId !== 'string' || !nativeId || nativeId.length > 240) {
          throw new BloomError('AGENT_PROTOCOL', 'OpenCode did not return a usable session ID.');
        }
        let catalog = modelCatalog(info);
        hooks.bind({ nativeId, model: catalog.model, models: catalog.models, resumed: Boolean(savedId) });
        if (model && model !== catalog.model) {
          if (catalog.configId) {
            const updated = await client.request('session/set_config_option', {
              sessionId: nativeId, configId: catalog.configId, value: model,
            });
            catalog = modelCatalog(updated);
            if (catalog.model !== model) {
              throw new BloomError('MODEL_MISMATCH', 'OpenCode could not confirm the selected model.');
            }
          } else if (catalog.legacy) {
            await client.request('unstable/session/set_model', { sessionId: nativeId, modelId: model });
          } else {
            throw new BloomError('MODEL_UNAVAILABLE', 'This OpenCode version did not expose model selection for the session.');
          }
          hooks.bind({ nativeId, model, models: catalog.models, resumed: Boolean(savedId) });
        }
        if (signal.aborted) return { stopReason: 'cancelled' };
        prompting = true;
        const result = await client.request('session/prompt', {
          sessionId: nativeId, prompt: [{ type: 'text', text: prompt }],
        }, 0);
        if (typeof result?.stopReason !== 'string') {
          throw new BloomError('AGENT_PROTOCOL', 'OpenCode ended the prompt without a stop reason.');
        }
        if (result.usage) {
          const measured = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
          hooks.emit('model.usage', { input: measured(result.usage.inputTokens), output: measured(result.usage.outputTokens),
            total: measured(result.usage.totalTokens), cacheRead: measured(result.usage.cachedReadTokens),
            cacheWrite: measured(result.usage.cachedWriteTokens) });
        }
        return { stopReason: bounded(result.stopReason, 80) };
      } finally {
        prompting = false;
        clearTimeout(cancellationTimer);
        signal.removeEventListener('abort', cancel);
        client.close();
      }
    },
  };
}
