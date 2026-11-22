import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const legacy = args[0] === 'legacy';
if (legacy) args.shift();
assert.deepEqual(args, ['acp', '--cwd', process.cwd()]);

const nativeId = 'fixture-native-session';
const firstModel = 'fixture/first';
const secondModel = 'fixture/second';
let model = firstModel;
let promptId;
const catalog = () => legacy ? {
  models: {
    currentModelId: model,
    availableModels: [firstModel, secondModel].map(modelId => ({ modelId, name: modelId })),
  },
} : {
  configOptions: [{
    id: 'model', type: 'select', category: 'model', currentValue: model,
    options: [firstModel, secondModel].map(value => ({ value, name: value })),
  }],
};

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}

function update(sessionUpdate, data, sessionId = nativeId) {
  send({ method: 'session/update', params: { sessionId, update: { sessionUpdate, ...data } } });
}

const reply = (id, result) => send({ id, result });
const content = text => ({ content: { type: 'text', text } });
const tool = { toolCallId: 'read-1', kind: 'read', title: 'Read README.md', name: 'read' };
const options = [
  { optionId: 'yes', kind: 'allow_once', name: 'Allow once' },
  { optionId: 'no', kind: 'reject_once', name: 'Reject' },
  { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
];

function permission(id, sessionId) {
  send({ id, method: 'session/request_permission', params: { sessionId, toolCall: tool, options } });
}

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result } = JSON.parse(line);
  switch (method) {
    case 'initialize':
      assert.equal(params.protocolVersion, 1);
      reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      break;
    case 'session/new':
      assert.deepEqual(params, { cwd: process.cwd(), mcpServers: [] });
      reply(id, { sessionId: nativeId, ...catalog() });
      break;
    case 'session/load':
      assert.deepEqual(params, { cwd: process.cwd(), mcpServers: [], sessionId: nativeId });
      update('agent_message_chunk', content('NATIVE_HISTORY_SENTINEL'));
      reply(id, catalog());
      break;
    case 'session/set_config_option':
      assert.equal(params.sessionId, nativeId);
      assert.equal(params.configId, 'model');
      if (params.value === secondModel) model = secondModel;
      reply(id, catalog());
      break;
    case 'unstable/session/set_model':
      assert.deepEqual(params, { sessionId: nativeId, modelId: secondModel });
      model = secondModel;
      reply(id, {});
      break;
    case 'session/prompt':
      assert.equal(params.sessionId, nativeId);
      if (params.prompt[0].text === 'Exit early') process.exit(42);
      promptId = id;
      update('agent_message_chunk', content('FOREIGN_SESSION_SENTINEL'), 'other-native-session');
      update('agent_thought_chunk', content('PRIVATE_ACTIVITY_SENTINEL'));
      update('agent_message_chunk', content('I’ll inspect the workspace.'));
      update('plan', { entries: [{ content: 'Read the README', status: 'in_progress', priority: 'high' }] });
      update('tool_call', { ...tool, status: 'pending', rawInput: { credential: 'RAW_INPUT_SENTINEL' } });
      permission('foreign-gate', 'other-native-session');
      break;
    case 'session/cancel':
      assert.equal(params.sessionId, nativeId);
      reply(promptId, { stopReason: 'cancelled' });
      break;
    case undefined:
      if (id === 'foreign-gate') {
        assert.deepEqual(result, { outcome: { outcome: 'cancelled' } });
        permission('gate', nativeId);
      }
      if (id === 'gate' && result.outcome.outcome === 'selected') {
        if (result.outcome.optionId === 'yes') {
          update('tool_call_update', { toolCallId: tool.toolCallId, status: 'in_progress' });
          update('tool_call_update', { toolCallId: tool.toolCallId, status: 'completed', rawOutput: 'RAW_OUTPUT_SENTINEL' });
          update('agent_message_chunk', content(' Done using ' + model + '.'));
        } else {
          assert.equal(result.outcome.optionId, 'no');
          update('tool_call_update', { toolCallId: tool.toolCallId, status: 'failed' });
          update('agent_message_chunk', content(' The action was declined.'));
        }
        reply(promptId, { stopReason: 'end_turn' });
      }
      break;
    default:
      throw new Error('Unexpected ACP method ' + method);
  }
}
