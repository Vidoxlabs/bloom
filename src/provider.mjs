import { validateProvider, normalizeGeneration, ProviderContractError } from '@vidoxlabs/seed';
import { BloomError } from './errors.mjs';

const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

// Every team provider runs behind seed's provider seam. The adapter is checked once when Bloom
// starts, and every generation is normalized by seed before the team loop reads it, so a record
// outside the contract stops the turn instead of reaching a handoff. Seed's record has no money
// field; Bloom carries a reported cost beside it, never inside usage.
export function adoptProvider(provider) {
  const { ok, errors } = validateProvider(provider);
  if (!ok) throw new Error('The team provider does not fit the provider seam: ' + errors.join(' '));
  return {
    label: provider.label,
    defaultModel: provider.defaultModel,
    async generate(input) {
      const result = await provider.generate(input);
      let normalized;
      try { normalized = normalizeGeneration(result); }
      catch (error) {
        if (!(error instanceof ProviderContractError)) throw error;
        normalized = { ok: false, errors: [error.message] };
      }
      if (!normalized.ok) {
        throw new BloomError('PROVIDER_CONTRACT', 'The model adapter returned a record outside the provider contract: ' + normalized.errors.join(' '));
      }
      return { ...normalized.generation, costUSD: amount(result.costUSD) };
    },
  };
}
