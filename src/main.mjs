import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { dataPath } from './data-dir.mjs';
import { BloomError } from './errors.mjs';
import { createHandler } from './http.mjs';
import { createWebWorkspace } from './web.mjs';

// The model endpoint is read only from config.json in the data directory.
let values;
try {
  ({ values } = parseArgs({ options: {
    demo: { type: 'boolean' },
    'data-dir': { type: 'string' },
    workspace: { type: 'string' },
    'team-model': { type: 'string' },
    port: { type: 'string', default: '4317' },
    help: { type: 'boolean', short: 'h' },
  } }));
} catch {
  console.error('Unknown option. Use npm start -- --help.');
  process.exit(2);
}
if (values.help) {
  console.log('Usage: npm start -- [--workspace PATH] [--team-model ID] [--data-dir PATH] [--port 4317]\n' +
    'The model provider and its key setting come from config.json in the data directory.\n' +
    'With a provider configured, a workspace session runs the coding loop in that folder.\nDemo: npm run demo');
  process.exit(0);
}
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('Choose a port from 0 to 65535.');
  process.exit(1);
}

const dataDirectory = dataPath(values['data-dir'], values.demo);
let web;
try {
  web = createWebWorkspace({ dataDirectory, workspace: values.workspace, demo: values.demo, teamModel: values['team-model'] });
} catch (error) {
  console.error(error instanceof BloomError ? error.message : 'Bloom could not use the configured model provider.');
  process.exit(error instanceof BloomError && error.status === 400 ? 2 : 1);
}
const { store, harness } = web;
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
