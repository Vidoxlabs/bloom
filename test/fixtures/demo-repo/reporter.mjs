// A short, stable test report: one line per test, then the totals.
export default async function* reporter(source) {
  let passed = 0;
  let failed = 0;
  for await (const { type, data } of source) {
    if (data?.nesting !== 0 || data.details?.type === 'suite') continue;
    if (type === 'test:pass') {
      passed += 1;
      yield `ok ${data.name}\n`;
    } else if (type === 'test:fail') {
      failed += 1;
      const error = data.details?.error?.cause ?? data.details?.error;
      yield `not ok ${data.name}\n`;
      if (error && 'expected' in error) {
        yield `  expected ${JSON.stringify(error.expected)}, got ${JSON.stringify(error.actual)}\n`;
      }
    }
  }
  yield `pass ${passed} fail ${failed}\n`;
}
