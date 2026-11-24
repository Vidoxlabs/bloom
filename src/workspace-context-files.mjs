import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';

import { isOutside } from './workspace-tool-utils.mjs';

const unavailable = new Set(['.git', '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.npmrc', '.netrc', '.pypirc']);
const privateNames = /^(?:\.env(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|(?:credentials|secrets?|token-cache|keychain)(?:\.|$))|\.(?:pem|key|p12|pfx|jks|crt|cer)$/i;
const caps = Object.freeze({ maxFiles: 1000, maxEntries: 4096, maxBytes: 4_194_304, maxFileBytes: 262_144, maxDepth: 16 });
const decoder = new TextDecoder('utf-8', { fatal: true });

export function contextPath(path) {
  return typeof path === 'string' && path !== '' && !/[\\:\x00-\x1f]/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..');
}

export function deniedContextPath(path) {
  return path.split('/').some(part => unavailable.has(part.toLowerCase()) || privateNames.test(part));
}

function bounds(limits) {
  return Object.fromEntries(Object.entries(caps).map(([name, cap]) => {
    const value = limits[name] ?? cap;
    if (!Number.isSafeInteger(value) || value < 1 || value > cap) throw new RangeError('Invalid workspace context limit.');
    return [name, value];
  }));
}

function directoryEntries(directory, limit) {
  const handle = opendirSync(directory, { bufferSize: 32 });
  const entries = [];
  try {
    while (entries.length <= limit) {
      const entry = handle.readSync();
      if (!entry) break;
      entries.push(entry);
    }
  } finally {
    handle.closeSync();
  }
  const truncated = entries.length > limit;
  entries.length = Math.min(entries.length, limit);
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { entries, truncated };
}

function readBounded(path, original, maxBytes) {
  const posixFlags = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = openSync(path, constants.O_RDONLY | posixFlags);
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile() || stat.ino !== original.ino || stat.dev !== original.dev) throw new Error('Workspace entry changed.');
    if (stat.size > maxBytes) return null;
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(handle, bytes, offset, bytes.length - offset, null);
      if (!count) break;
      offset += count;
    }
    return offset === stat.size ? bytes.subarray(0, offset) : null;
  } finally {
    closeSync(handle);
  }
}

function binary(bytes) {
  if (bytes.includes(0)) return true;
  try { decoder.decode(bytes); return false; }
  catch { return true; }
}

export function walkWorkspace(directory, { includeHidden = false, include = [], limits = {} } = {}) {
  if (!Array.isArray(include) || !include.every(contextPath)) throw new TypeError('Choose workspace-relative includes.');
  const bounded = bounds(limits);
  const result = { files: [], omitted: [], unknown: [] };
  const omit = (path, reason) => result.omitted.push({ path, reason });
  const unknown = (path, reason) => result.unknown.push({ path, reason });
  let entriesLeft = bounded.maxEntries;
  let bytesLeft = bounded.maxBytes;
  let root;
  try { root = realpathSync.native(directory); }
  catch { unknown('.', 'root-unavailable'); return result; }

  function visit(absolute, parent, depth) {
    let listing;
    try { listing = directoryEntries(absolute, entriesLeft); }
    catch { unknown(parent || '.', 'read-failed'); return; }
    entriesLeft -= listing.entries.length;
    if (listing.truncated) unknown(parent || '.', 'entry-limit');
    for (const entry of listing.entries) {
      const path = parent ? parent + '/' + entry.name : entry.name;
      if (!contextPath(path)) { unknown(parent || '.', 'invalid-path'); continue; }
      if (deniedContextPath(path)) { omit(path, 'denied'); continue; }
      if (!includeHidden && entry.name.startsWith('.')) { omit(path, 'hidden'); continue; }
      if (include.length && !include.some(rule => rule === path || rule.startsWith(path + '/') || path.startsWith(rule + '/'))) {
        omit(path, 'excluded'); continue;
      }
      const source = join(absolute, entry.name);
      try {
        const target = realpathSync.native(source);
        if (entry.isSymbolicLink() || relative(source, target) !== '') { unknown(path, 'symlink'); continue; }
        if (isOutside(root, target)) { unknown(path, 'outside-workspace'); continue; }
        const stat = lstatSync(target);
        if (stat.isDirectory()) {
          if (depth >= bounded.maxDepth) omit(path, 'out-of-budget');
          else visit(target, path, depth + 1);
          continue;
        }
        if (!stat.isFile()) { unknown(path, 'unsupported-file'); continue; }
        const left = Math.min(bytesLeft, bounded.maxFileBytes);
        if (result.files.length >= bounded.maxFiles || stat.size > left) { omit(path, 'out-of-budget'); continue; }
        const bytes = readBounded(target, stat, left);
        if (!bytes) { unknown(path, 'file-changed'); continue; }
        bytesLeft -= bytes.length;
        if (binary(bytes)) { omit(path, 'binary'); continue; }
        result.files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      } catch {
        unknown(path, entry.isSymbolicLink() ? 'symlink' : 'read-failed');
      }
    }
  }
  visit(root, '', 0);
  return result;
}
