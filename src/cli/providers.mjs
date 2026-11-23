import { createChatProvider, demoProvider, unconfiguredProvider } from '../models.mjs';
import { demoAdapter } from '../demo.mjs';

export function selectProviders({ demo, baseURL, model, env = process.env }) {
  const defaultModel = model ?? env.BLOOM_MODEL;
  const teamProvider = demo ? demoProvider : baseURL
    ? createChatProvider({ baseURL, defaultModel, apiKey: configuredKey(env) })
    : unconfiguredProvider;
  return { teamProvider, adapters: demo ? [demoAdapter] : [] };
}

export function configuredKey(env = process.env) {
  return env.BLOOM_API_KEY;
}
