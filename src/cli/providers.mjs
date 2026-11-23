import { createChatProvider, demoProvider, unconfiguredProvider } from '../models.mjs';
import { demoAdapter } from '../demo.mjs';
import { endpointRedactor } from '../endpoint-privacy.mjs';

export function selectProviders({ demo, model, env = process.env, ...configured }) {
  const defaultModel = model ?? env.BLOOM_MODEL;
  const redact = !demo && configured.baseURL ? endpointRedactor(configured.baseURL) : undefined;
  const keyName = configured.apiKeyEnv ?? (configured.terminal ? undefined : 'BLOOM_API_KEY');
  const teamProvider = demo ? demoProvider : configured.baseURL
    ? createChatProvider({ ...configured, defaultModel, apiKey: keyName ? env[keyName] : undefined, redact })
    : unconfiguredProvider;
  return { teamProvider, adapters: demo ? [demoAdapter] : [], redact };
}
