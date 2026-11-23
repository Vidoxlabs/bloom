import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { dataPath } from './data-dir.mjs';
import { parseArgs } from 'node:util';
import { Store } from './store.mjs';
import { Harness } from './harness.mjs';
import { createHandler } from './http.mjs';
import { selectProviders } from './cli/providers.mjs';

const { values } = parseArgs({ options: {
  demo: { type: 'boolean' },
  'data-dir': { type: 'string' },
  workspace: { type: 'string' },
  'team-model': { type: 'string' },
  'api-base': { type: 'string' },
  port: { type: 'string', default: '4317' },
  help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
  console.log('Usage: npm start -- [--api-base URL] [--team-model ID] [--workspace PATH] [--data-dir PATH] [--port 4317]\nThe endpoint key is read from BLOOM_API_KEY.\nDemo: npm run demo');
  process.exit(0);
}
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('Choose a port from 0 to 65535.');
  process.exit(1);
}

const dataDirectory = dataPath(values['data-dir'], values.demo);
let selection;
try {
  selection = selectProviders({ demo: values.demo, baseURL: values['api-base'], model: values['team-model'] });
} catch {
  console.error('Bloom could not use the configured model provider.');
  process.exit(1);
}
const { redact, ...providers } = selection;
const store = new Store(dataDirectory, { redact });
const harness = new Harness({
  store, dataDirectory, ...providers,
  defaultWorkspace: values.workspace ? resolve(values.workspace) : '',
});
const server = createServer(createHandler(harness));
server.on('error', error => {
  console.error('Bloom could not open its local listener (' + (error.code ?? 'unknown') + ').');
  store.close();
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log('Bloom is open at http://127.0.0.1:' + server.address().port);
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  await harness.close();
  server.closeAllConnections();
  store.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
