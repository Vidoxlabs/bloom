import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const demoAdapter = {
  id: 'demo',
  label: 'Demo runtime',
  async run({ nativeId, signal }, hooks) {
    hooks.bind({
      nativeId: nativeId ?? randomUUID(), model: 'demo/scripted',
      models: [{ id: 'demo/scripted', label: 'Scripted demo' }], resumed: Boolean(nativeId),
    });
    hooks.emit('plan.updated', {
      entries: [
        { text: 'Inspect the workspace', status: 'in_progress' },
        { text: 'Summarize the next step', status: 'pending' },
      ],
    });
    const tool = { id: 'demo-read', name: 'read', title: 'Read workspace notes', kind: 'read' };
    hooks.emit('tool.updated', { ...tool, status: 'pending' });
    const choice = await hooks.permission({
      title: tool.title, kind: tool.kind, toolId: tool.id, options: [
        { id: 'yes', kind: 'allow_once', label: 'Allow once' },
        { id: 'no', kind: 'reject_once', label: 'Reject' },
      ],
    });
    if (signal.aborted) return { stopReason: 'cancelled' };
    if (choice !== 'yes') {
      hooks.emit('tool.updated', { ...tool, status: 'failed' });
      hooks.emit('assistant.delta', { text: 'The demo action was declined.' });
      return { stopReason: 'end_turn' };
    }
    hooks.emit('tool.updated', { ...tool, status: 'in_progress' });
    await delay(550, undefined, { signal });
    hooks.emit('tool.updated', { ...tool, status: 'completed' });
    hooks.emit('plan.updated', {
      entries: [
        { text: 'Inspect the workspace', status: 'completed' },
        { text: 'Summarize the next step', status: 'completed' },
      ],
    });
    hooks.emit('assistant.delta', {
      text: 'This demo shows how ViBloom streams activity and handles approvals. No coding runtime ships with Bloom yet, so real workspace tasks are not available.',
    });
    return { stopReason: 'end_turn' };
  },
};
