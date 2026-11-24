function endpointLiterals(baseURL) {
  const url = new URL(baseURL);
  return [...new Set([baseURL, url.href, url.origin, url.host, url.hostname])]
    .sort((left, right) => right.length - left.length);
}

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The configured address can be echoed as a full URL, origin, authority or host.
export function endpointRedactor(baseURL) {
  const literals = endpointLiterals(baseURL);
  const pattern = new RegExp(literals.map(escape).join('|'), 'gi');
  const redact = text => typeof text === 'string' ? text.replace(pattern, '[redacted endpoint]') : text;
  redact.literals = literals;
  return redact;
}

// Streamed text can split an address across chunks. Hold back the longest tail that could
// still begin an address, and release it once the next chunk settles it or the stream ends.
export function streamRedactor(redact) {
  const literals = (redact.literals ?? []).map(value => value.toLowerCase());
  let pending = '';
  const heldLength = () => {
    const lower = pending.toLowerCase();
    for (let size = Math.min(lower.length, Math.max(0, ...literals.map(value => value.length - 1))); size > 0; size -= 1) {
      const tail = lower.slice(-size);
      if (literals.some(value => value.startsWith(tail))) return size;
    }
    return 0;
  };
  return {
    push(text) {
      pending += text;
      const hold = heldLength();
      const ready = pending.slice(0, pending.length - hold);
      pending = pending.slice(pending.length - hold);
      return redact(ready);
    },
    flush() {
      const rest = redact(pending);
      pending = '';
      return rest;
    },
  };
}

export function redactValue(value, redact) {
  if (Array.isArray(value)) return value.map(item => redactValue(item, redact));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactValue(item, redact)]));
  }
  return redact(value);
}
