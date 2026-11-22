import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dataPath } from '../src/data-dir.mjs';
const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, demo: { type: 'boolean' }, down: { type: 'boolean' } } });
const desktop = join(dataPath(values['data-dir'], values.demo), 'Desktop');
mkdirSync(desktop, { recursive: true, mode: 0o700 });
const result = spawnSync('docker', ['compose', '-p', values.demo ? 'bloom-demo' : 'bloom',
  '-f', fileURLToPath(new URL('../compose.desktop.yaml', import.meta.url)), ...(values.down ? ['down'] : ['up', '-d'])],
  { stdio: 'inherit', env: { ...process.env, BLOOM_DESKTOP_PATH: desktop, BLOOM_DESKTOP_UID: String(process.getuid?.() ?? 1000), BLOOM_DESKTOP_GID: String(process.getgid?.() ?? 1000) } });
if (result.error) console.error('The graphical desktop needs Docker with Compose.');
if (result.status === 0 && !values.down) console.log('Desktop: https://127.0.0.1:4318');
process.exitCode = result.status ?? 1;
