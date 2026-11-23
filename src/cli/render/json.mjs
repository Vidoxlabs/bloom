export function headlessChoice(request, policy) {
  const kind = policy === 'allow-read' && (request.effect ?? request.kind) === 'read' ? 'allow_once' : 'reject_once';
  return request.options.find(option => option.kind === kind)?.id ?? null;
}

export function jsonRenderer({ stdout, policy = 'deny' }) {
  return {
    onEvent(event) { stdout.write(JSON.stringify(event) + '\n'); },
    async prompt(request) { return headlessChoice(request, policy); },
    close() {},
  };
}
