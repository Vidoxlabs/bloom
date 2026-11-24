import { createCodingRuntime } from '../coding-loop.mjs';
import { createChatProvider, demoProvider, unconfiguredProvider } from '../models.mjs';
import { demoAdapter } from '../demo.mjs';
import { endpointRedactor } from '../endpoint-privacy.mjs';

export function selectProviders({ demo, model, env = process.env, headless = false, profile = null, ...configured }) {
  const defaultModel = model ?? env.BLOOM_MODEL;
  const redact = !demo && configured.baseURL ? endpointRedactor(configured.baseURL) : undefined;
  const keyName = configured.apiKeyEnv ?? (configured.terminal ? undefined : 'BLOOM_API_KEY');
  // The same credential rule serves the provider probe.
  const credential = keyName ? env[keyName] : undefined;
  const teamProvider = demo ? demoProvider : configured.baseURL
    ? createChatProvider({ ...configured, defaultModel, apiKey: keyName ? env[keyName] : undefined, redact })
    : unconfiguredProvider;
  // A configured endpoint also drives the coding runtime, which a workspace session uses.
  const coding = !demo && configured.baseURL
    ? [createCodingRuntime({ provider: teamProvider, headless, profile })] : [];
  return { teamProvider, adapters: demo ? [demoAdapter] : coding, redact, credential };
}
