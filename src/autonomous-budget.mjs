const defaults = Object.freeze({ callLimit: 20, toolLimit: 20, wallMs: 120_000 });

export function autonomousLimits(limits) {
  const bounded = {};
  for (const [name, cap] of Object.entries(defaults)) {
    const value = limits[name] ?? cap;
    if (!Number.isSafeInteger(value) || value < 1 || value > cap) {
      throw new RangeError('Invalid autonomous run limit.');
    }
    bounded[name] = value;
  }
  return Object.freeze(bounded);
}

export function startAutonomousDeadline(parent, wallMs) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), wallMs);
  return {
    signal: AbortSignal.any([parent, deadline.signal]),
    get expired() { return deadline.signal.aborted && !parent.aborted; },
    close() { clearTimeout(timer); },
  };
}

export function beforeAbort(operation, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
