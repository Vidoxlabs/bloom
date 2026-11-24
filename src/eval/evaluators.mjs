import { isDeepStrictEqual as equal } from 'node:util';
import { validateValue } from '@vidoxlabs/seed';

const normalize = text => text.normalize('NFC').replace(/\r\n?/g, '\n').trim();
const sorted = values => [...new Set(values)].sort();

const evaluators = new Map([
  ['exact', (expected, { text }) => typeof text === 'string' && typeof expected === 'string'
    && normalize(text) === normalize(expected)],
  ['contains', (expected, { text }) => typeof text === 'string' && (typeof expected === 'string'
    ? text.includes(expected) : expected instanceof RegExp && new RegExp(expected.source, expected.flags).test(text))],
  ['schema-valid', (expected, { value }) => validateValue(expected, value).ok],
  ['tool-trajectory', ({ ids, ordered = true }, { trajectory }) => Array.isArray(ids) && Array.isArray(trajectory)
    && (ordered ? equal(ids, trajectory) : equal(sorted(ids), sorted(trajectory)))],
  ['files-changed', (expected, { files }) => equal(expected, files)],
  ['tests-pass', (expected, { testExitCodes }) => Array.isArray(testExitCodes) && testExitCodes.at(-1) === 0
    && (expected == null || equal(expected, testExitCodes))],
]);

export function evaluateAssertions(assertions, observed, judge = null) {
  const checks = assertions.map(({ kind, expected }) => {
    const evaluate = evaluators.get(kind);
    const passed = evaluate?.(expected, observed) === true;
    return { kind, passed };
  });
  return {
    passed: checks.length > 0 && checks.every(check => check.passed),
    evaluators: checks,
    judge: judge == null ? null : { ...judge, kind: 'judge' },
  };
}
