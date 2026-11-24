import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { modelAlias, modelAliasTable, resolveModel } from '@vidoxlabs/seed';
import { BloomError } from '../errors.mjs';
import { inspectEndpoint } from '../models.mjs';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const invalid = message => new BloomError('CONFIG_INVALID', message, 400);

export function readTerminalProvider(directory) {
  let config;
  try {
    config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw invalid('Bloom could not read a valid config.json.');
  }
  if (!record(config) || config.version !== 1 || !record(config.providers)) {
    throw invalid('Use version 1 and a providers object in config.json.');
  }
  const entries = Object.entries(config.providers);
  if (entries.length === 0) return null;
  if (entries.length !== 1) throw invalid('Configure one terminal provider for the team shell.');
  const [[name, provider]] = entries;
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(name) || !record(provider) ||
      provider.kind !== 'chat-completions' || typeof provider.baseURL !== 'string' ||
      (provider.locality !== undefined && !['local', 'cloud'].includes(provider.locality)) ||
      (provider.allowInsecureHttp !== undefined && typeof provider.allowInsecureHttp !== 'boolean') ||
      (provider.apiKeyEnv !== undefined &&
        (typeof provider.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(provider.apiKeyEnv)))) {
    throw invalid('Check the provider fields in config.json.');
  }
  let endpoint;
  try { endpoint = inspectEndpoint(provider.baseURL, provider); }
  catch { throw invalid('The provider URL does not meet the endpoint rule.'); }
  const label = 'provider "' + name + '" (' + endpoint.description + ')';
  const { baseURL, locality, allowInsecureHttp, apiKeyEnv } = provider;
  return { name, baseURL, locality, allowInsecureHttp, apiKeyEnv, ...endpoint, label, models: config.models };
}

// The alias a run uses and the backend model it names.
export function terminalSelection(provider, requested) {
  if (!record(provider.models) || !Array.isArray(provider.models.aliases)) {
    throw invalid('Configure model aliases in config.json.');
  }
  let table;
  try { table = modelAliasTable(provider.models.aliases.map(entry => modelAlias(entry))); }
  catch { throw invalid('Check the model aliases in config.json.'); }
  const selected = resolveModel(table, requested ?? provider.models.default);
  if (!selected.resolved) throw invalid('Choose a configured model alias with --model or models.default.');
  return { alias: requested ?? provider.models.default, backendModel: selected.backendModel };
}
