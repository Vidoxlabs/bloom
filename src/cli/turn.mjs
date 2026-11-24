import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { maskWorkspace } from './session-io.mjs';

const usageFields = ['input', 'output', 'total', 'cacheRead', 'cacheWrite'];
const exitCodes = { finished: 0, refused: 3, limit: 4, stopped: 130 };

export function runResult(status, reason, details = {}) {
  return { type: 'run.result', status, reason, usage: null, calls: 0, durationMs: 0, exitCode: exitCodes[status] ?? 1, ...details };
}

export async function runTurn(harness, session, request, renderer, controls, outputFile) {
  const started = performance.now();
  const figures = [];
  let calls = 0;
  let finalMessage = '';
  let complete;
  let promptError;
  const finished = new Promise(resolve => { complete = resolve; });
  const unsubscribe = harness.subscribe(session.id, event => {
    const { type, data } = event;
    renderer.onEvent(maskWorkspace(event, session.workspace));
    switch (type) {
      case 'assistant.delta': finalMessage = data.final ? data.text : finalMessage + data.text; break;
      case 'model.call': calls += 1; figures.push(data.usage); break;
      case 'team.message': finalMessage = data.text; break;
      case 'team.call': calls = data.calls; break;
      case 'team.usage': figures.push(data.usage); break;
      case 'model.usage': figures.push(data); break;
      case 'permission.requested':
        Promise.resolve(renderer.prompt(maskWorkspace(data, session.workspace))).then(selection => {
          const decision = typeof selection === 'string' ? { optionId: selection } : selection;
          if (decision) harness.decide(session.id, data.id, { ...decision, argsDigest: data.argsDigest });
          else if (harness.active.get(session.id)?.permissions.has(data.id)) controls.stop();
        }).catch(error => {
          if (error.code === 'PERMISSION_SETTLED') return;
          promptError = error;
          controls.stop();
        });
        break;
      case 'turn.finished': complete(data); break;
    }
  });
  try {
    const { turnId } = harness.start(session.id, request);
    controls.setActive(() => harness.stop(session.id, { turnId }));
    const ending = await finished;
    if (promptError) throw promptError;
    if (outputFile && ending.status === 'finished') writeFileSync(outputFile, finalMessage, { mode: 0o600 });
    let usage = null;
    if (figures.length && figures.length >= calls) {
      const totals = Object.fromEntries(usageFields.map(field => [field, figures.every(row => Number.isSafeInteger(row?.[field]))
        ? figures.reduce((sum, row) => sum + row[field], 0) : null]));
      if (Object.values(totals).some(value => value !== null)) usage = totals;
    }
    const status = ending.code === 'EGRESS_REFUSED' ? 'refused' : ending.status;
    return {
      result: runResult(status, ending.reason ?? ending.code ?? ending.status,
        { usage, calls, durationMs: Math.round(performance.now() - started) }),
      message: ending.message,
    };
  } finally {
    unsubscribe();
    controls.setActive(null);
  }
}
