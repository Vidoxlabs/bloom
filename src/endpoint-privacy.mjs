// The configured address can be echoed as a full URL, origin, authority or host.
export function endpointRedactor(baseURL) {
  const url = new URL(baseURL);
  const values = new Set([baseURL, url.href, url.origin, url.host, url.hostname]);
  const literals = [...values].sort((left, right) => right.length - left.length)
    .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(literals.join('|'), 'gi');
  return text => typeof text === 'string' ? text.replace(pattern, '[redacted endpoint]') : text;
}

export function redactValue(value, redact) {
  if (Array.isArray(value)) return value.map(item => redactValue(item, redact));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactValue(item, redact)]));
  }
  return redact(value);
}
