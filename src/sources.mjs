import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { BloomError } from './errors.mjs';

const invalid = () => new BloomError('SOURCE_URL', 'Choose a public HTTPS page or GitHub repository.', 400);
function publicIPv4(address) {
  const [a,b,c] = address.split('.').map(Number);
  return isIP(address) === 4 && a > 0 && a < 224 && ![10,127].includes(a) &&
    !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) && !(a === 203 && b === 0 && c === 113);
}

async function page(url, signal, depth = 0) {
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw invalid();
  const addresses = await lookup(url.hostname, { family: 4, all: true });
  if (!addresses.length || !addresses.every(item => publicIPv4(item.address))) throw invalid();
  signal.throwIfAborted();
  const response = await new Promise((resolve, reject) => {
    const req = request(url, { signal, agent: false, family: 4,
      lookup: (_host, opts, cb) => opts.all ? cb(null, [addresses[0]]) : cb(null, addresses[0].address, 4),
      headers: { 'user-agent': 'Bloom research reader', accept: url.hostname === 'api.github.com' ? 'application/vnd.github.raw+json' : 'text/html, text/plain, text/markdown' } }, resolve);
    req.on('error', reject);
    req.end();
  });
  if ([301,302,303,307,308].includes(response.statusCode) && response.headers.location && depth < 3) {
    response.destroy();
    return page(new URL(response.headers.location, url), signal, depth + 1);
  }
  const type = response.headers['content-type'] ?? '';
  if (response.statusCode !== 200 || !/^(?:text\/(?:plain|markdown|html)|application\/(?:vnd\.github\.raw\+json|octet-stream))/i.test(type)) {
    response.destroy();
    throw new BloomError('SOURCE_UNREADABLE', 'This URL did not return a readable document.', 422);
  }
  const parts = [];
  let size = 0;
  for await (const part of response) {
    size += part.length;
    if (size > 1024 * 1024) { response.destroy(); throw new BloomError('SOURCE_TOO_LARGE', 'Import an excerpt from this source.', 413); }
    parts.push(part);
  }
  let body = Buffer.concat(parts).toString('utf8');
  if (type.includes('html')) body = body.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const excerpt = body.trim().slice(0, 16_000);
  if (!excerpt || excerpt.includes('\0')) throw new BloomError('SOURCE_EMPTY', 'This source has no readable text.', 422);
  return excerpt;
}

// Only an explicit user import may initiate a fetch. Model output never supplies this URL.
export async function importURL(value, parentSignal) {
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw invalid();
  const repo = /^\/([\w.-]+)\/([\w.-]+)\/?$/.exec(url.pathname);
  const target = url.hostname === 'github.com' && repo ? new URL('https://api.github.com/repos/' + repo[1] + '/' + repo[2] + '/readme') : url;
  const timeout = AbortSignal.timeout(12_000);
  try { return await page(target, parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout); }
  catch (error) {
    if (error instanceof BloomError) throw error;
    throw new BloomError('SOURCE_OFFLINE', 'Bloom could not retrieve this source. You can also paste an excerpt.', 422);
  }
}
