// The web workspace's providers come from the private config file in the data directory, never
// from a command-line option or an environment variable. The same rules as the terminal apply:
// a local provider only, its configured key setting, and the saved model profile for its alias.
import { resolve } from 'node:path';

import { readTerminalProvider, terminalSelection } from './cli/config.mjs';
import { selectProviders } from './cli/providers.mjs';
import { BloomError } from './errors.mjs';
import { Harness } from './harness.mjs';
import { profileKey, readProfile } from './profile-store.mjs';
import { Store } from './store.mjs';

export function createWebWorkspace({ dataDirectory, workspace, demo = false, teamModel, env = process.env, fetcher } = {}) {
  let settings = { demo, model: teamModel, env };
  if (!demo) {
    const provider = readTerminalProvider(dataDirectory);
    if (provider && !provider.local) {
      throw new BloomError('EGRESS_REFUSED', 'The configured provider is marked cloud, and the web workspace runs local providers only.');
    }
    if (provider) {
      const selection = terminalSelection(provider);
      const profile = readProfile(dataDirectory, profileKey(provider.name, selection.alias));
      settings = { ...provider, model: teamModel ?? selection.backendModel, env, terminal: true, profile,
        ...(fetcher ? { fetcher } : {}) };
    }
  }
  const { redact, credential: _credential, ...providers } = selectProviders(settings);
  const store = new Store(dataDirectory, { redact });
  const harness = new Harness({ store, dataDirectory, ...providers, defaultWorkspace: workspace ? resolve(workspace) : '' });
  return { store, harness };
}
