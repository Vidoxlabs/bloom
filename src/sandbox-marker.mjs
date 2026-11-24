// Marker a make-sandbox folder carries so cloud runs can confirm the workspace is throwaway.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SANDBOX_MARKER = '.bloom-sandbox';
export const SANDBOX_MARKER_BODY = 'bloom-sandbox-v1\n';

export function writeSandboxMarker(sandbox) {
  writeFileSync(join(sandbox, SANDBOX_MARKER), SANDBOX_MARKER_BODY, { mode: 0o600 });
}

export function isBloomSandbox(workspace) {
  try {
    const path = join(workspace, SANDBOX_MARKER);
    if (!existsSync(path)) return false;
    return readFileSync(path, 'utf8') === SANDBOX_MARKER_BODY;
  } catch {
    return false;
  }
}
