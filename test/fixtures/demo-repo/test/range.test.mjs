import assert from 'node:assert/strict';
import { test } from 'node:test';
import { range } from '../src/range.mjs';

test('range includes both ends', () => {
  assert.deepEqual(range(1, 3), [1, 2, 3]);
});
