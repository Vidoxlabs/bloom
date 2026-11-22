import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { dataPath } from './data-dir.mjs';
import { parseArgs } from 'node:util';
import { Store } from './store.mjs';
import { Harness } from './harness.mjs';
import { createHandler } from './http.mjs';
import { createOpenCodeAdapter } from './opencode.mjs';
import { createChatProvider, createServerProvider, demoProvider } from './models.mjs';
import { demoAdapter } from './demo.mjs';

const { values } = parseArgs({ options: {
  demo: { type: 'boolean' },
  'data-dir': { type: 'string' },
  workspace: { type: 'string' },
  'team-model': { type: 'string' },
  'opencode-server': { type: 'string' },
  'api-base': { type: 'string' },
  opencode: { type: 'string' },
  port: { type: 'string', default: '4317' },
  help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
  console.log('Usage: npm start -- [--team-model ID] [--opencode-server URL | --api-base URL] [--workspace PATH] [--data-dir PATH] [--opencode PATH] [--port 4317]\nDemo: npm run demo');
  process.exit(0);
}
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('Choose a port from 0 to 65535.');
  process.exit(1);
}

const dataDirectory = dataPath(values['data-dir'], values.demo);
if (values['opencode-server'] && values['api-base']) throw new Error('Choose one team model endpoint.');
const defaultModel = values['team-model'] ?? process.env.BLOOM_MODEL;
const teamProvider = values.demo ? demoProvider : values['opencode-server']
  ? createServerProvider({ baseURL: values['opencode-server'], defaultModel, username: process.env.OPENCODE_SERVER_USERNAME, password: process.env.OPENCODE_SERVER_PASSWORD })
  : createChatProvider({ baseURL: values['api-base'], defaultModel, apiKey: values['api-base'] ? process.env.BLOOM_API_KEY : process.env.OPENCODE_API_KEY });
const store = new Store(dataDirectory);
const harness = new Harness({
  store, dataDirectory, teamProvider,
  defaultWorkspace: values.workspace ? resolve(values.workspace) : '',
  adapters: [values.demo ? demoAdapter : createOpenCodeAdapter({ command: values.opencode })],
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
