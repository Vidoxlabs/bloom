// Opens a coding session on a store and harness for offline tests and the dev-only scripted run.
// With `stable`, ids, event times and durations come from counters so an export is byte-stable.
import { cpSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCodingRuntime } from '../../src/coding-loop.mjs';
import { Harness } from '../../src/harness.mjs';
import { Store } from '../../src/store.mjs';

export const demoRepo = fileURLToPath(new URL('./demo-repo/', import.meta.url));

export function copyDemoRepo(target) {
  cpSync(demoRepo, target, { recursive: true });
  return target;
}

export function stableCounters() {
  let ids = 0;
  let seconds = 0;
  let ticks = 0;
  return {
    newId: () => '00000000-0000-4000-8000-' + String(++ids).padStart(12, '0'),
    now: () => new Date(Date.UTC(2026, 0, 1) + 1000 * seconds++).toISOString(),
    clock: () => 5 * ticks++,
  };
}

export function openCodingSession({
  dataDirectory, workspace, provider, headless = false, stable = false, redact, model = 'scripted/coding', runtime: options = {},
}) {
  const counters = stable ? stableCounters() : {};
  const store = new Store(dataDirectory, { redact, clock: counters.now, newId: counters.newId });
  const runtime = createCodingRuntime({
    provider, headless, searchPath: dirname(process.execPath), clock: counters.clock, newId: counters.newId, ...options,
  });
  const harness = new Harness({ store, adapters: [runtime], dataDirectory, newId: counters.newId });
  const session = harness.createSession({ workspace, adapter: runtime.id, model });

  async function run(text, choose = () => 'allow_once', onEvent = () => {}) {
    const events = [];
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    const unsubscribe = harness.subscribe(session.id, event => {
      events.push(event);
      onEvent(event);
      if (event.type === 'permission.requested') {
        Promise.resolve(choose(event.data)).then(kind => {
          const option = event.data.options.find(item => item.kind === kind);
          if (option) harness.decide(session.id, event.data.id, { optionId: option.id });
          else harness.stop(session.id, { turnId: event.turnId });
        });
      }
      if (event.type === 'turn.finished') finish(event.data);
    });
    try {
      harness.start(session.id, { text });
      const ending = await finished;
      return { events, ending };
    } finally {
      unsubscribe();
    }
  }

  async function close() {
    await harness.close();
    store.close();
  }

  return { store, harness, runtime, session, run, close };
}
