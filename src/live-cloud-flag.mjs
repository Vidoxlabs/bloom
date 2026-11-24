import assert from 'node:assert/strict';

// Shared by the opt-in live suite. Cloud providers need a second explicit flag.
export function requireCloudFlag(provider) {
  assert.ok(provider.local || process.env.BLOOM_LIVE_ALLOW_CLOUD === '1',
    'Cloud live probe needs BLOOM_LIVE_ALLOW_CLOUD=1 as well.');
}
