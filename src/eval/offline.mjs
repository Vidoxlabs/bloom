import { evaluateAssertions } from './evaluators.mjs';

export async function runOfflineCases(cases) {
  const run = 'smoke';
  const dataset = 'coding-fixture';
  const events = [];
  const emit = (type, data) => events.push({ type, data: { run, dataset, ...data } });
  let passedCount = 0;
  let networkRequests = 0;
  for (const item of cases) {
    emit('eval.case.started', { caseId: item.id, smoke: true });
    const before = networkRequests;
    const request = () => {
      networkRequests += 1;
      throw new Error('Offline evaluation does not allow requests.');
    };
    let result;
    try {
      result = evaluateAssertions(item.assertions, await item.observe({ request }), item.judge);
    } catch {
      result = { passed: false, evaluators: [], judge: null, reason: 'case-failed' };
    }
    if (networkRequests !== before) result = { ...result, passed: false, reason: 'offline-request' };
    if (result.passed) passedCount += 1;
    emit('eval.case.finished', { caseId: item.id, ...result, usage: null, costUSD: null, durationMs: null });
  }
  const failedCount = cases.length - passedCount;
  emit('eval.report.written', { passedCount, failedCount, baselineDiff: null });
  return { passedCount, failedCount, networkRequests, events };
}
