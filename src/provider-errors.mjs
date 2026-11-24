// Map HTTP failures from OpenAI-compatible and Google error shapes into short reasons.
// Reasons never carry the endpoint, the key, or the raw body.

export function providerFailureReason({ status, body } = {}) {
  const code = Number(status);
  const google = body && typeof body === 'object' ? body.error : null;
  const googleStatus = typeof google?.status === 'string' ? google.status.toUpperCase() : '';
  if (code === 429 || googleStatus === 'RESOURCE_EXHAUSTED' || google?.code === 429) return 'rate-limited';
  if (Number.isSafeInteger(code) && code >= 400) return 'http-' + code;
  if (googleStatus === 'UNAUTHENTICATED') return 'http-401';
  if (googleStatus === 'PERMISSION_DENIED') return 'http-403';
  return 'refused';
}

export async function readErrorBody(response) {
  try {
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('application/json')) return await response.json();
    await response.text();
  } catch { /* Ignore an unreadable body; the status still names the reason. */ }
  return null;
}
