import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { dataPath } from './data-dir.mjs';
import { BloomError } from './errors.mjs';
import { createHandler, createOwnerChannel } from './http.mjs';
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
// One owner credential per launch, held only in this process's memory (ADR 0004).
const owner = createOwnerChannel();
const server = createServer(createHandler(harness, { owner }));
server.on('error', error => {
  console.error('Bloom could not open its local listener (' + (error.code ?? 'unknown') + ').');
  store.close();
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  const { address, port: listening } = server.address();
  // The one-time code rides in the fragment, which the browser never sends to a server. The page
  // removes it from the address bar and trades it for this launch's owner credential.
  console.log('Bloom is open at http://' + address + ':' + listening + '/#launch=' + owner.launchCode());
  console.log('Open that link once in your browser. It signs that browser in until Bloom stops.');
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
