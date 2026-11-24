// Local fixture doubles until Seed owns the reusable versions.
export function functionDouble(reply, defaultModel) {
  return {
    label: 'Offline fixture provider',
    defaultModel,
    async generate(call) {
      call.signal?.throwIfAborted();
      return { text: reply(call), complete: true, model: call.model ?? defaultModel, usage: null };
    },
  };
}

export function scriptedQueue(replies, model) {
  const queue = [...replies];
  return functionDouble(() => {
    if (!queue.length) throw new Error('Offline fixture replies exhausted.');
    return queue.shift();
  }, model);
}
