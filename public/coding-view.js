// Text for the coding loop's trace rows in the browser. Pure functions, so they run in tests too.
// A row names paths and commands from the event's summary and never adds anything else.

export function node(tag, text, className, dom = document) {
  const element = dom.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}

export function usageBudget(data, dom = document) {
  const region = node('section', null, 'usage-budget-meter', dom);
  region.setAttribute('role', 'region');
  region.setAttribute('aria-label', 'Usage and limits');
  const rows = [
    ['Model calls', data.modelCalls, data.modelLimit],
    ['Tool calls', data.toolCalls, data.toolLimit],
    ['Tokens', data.total, data.tokenLimit],
  ];
  for (const [title, used, maximum] of rows) {
    if (!Number.isFinite(used)) continue;
    const bounded = Number.isFinite(maximum) && maximum > 0;
    region.append(node('p', title + ': ' + used + (bounded ? ' of ' + maximum : ''), 'usage-metric', dom));
    if (bounded) {
      const progress = node('progress', null, 'usage-progress', dom);
      progress.setAttribute('aria-label', title + ' budget');
      progress.max = maximum;
      progress.value = Math.min(used, maximum);
      region.append(progress);
    }
  }
  if (data.usage) {
    const fields = [['Input', data.input], ['Output', data.output], ['Cache read', data.cacheRead], ['Cache write', data.cacheWrite]];
    region.append(node('p', fields.map(([label, amount]) => label + ': ' + (amount ?? 'unreported')).join(' · '), 'hint', dom));
  }
  return region;
}

export function outputViewer(command, output, dom = document) {
  const label = /^git diff(?: |$)/.test(command) ? 'Diff' : 'Command output';
  const viewer = node('details', null, 'output-viewer', dom);
  viewer.setAttribute('aria-label', label);
  viewer.open = true;
  const content = node('pre', null, 'tool-output', dom);
  content.append(node('code', output, null, dom));
  viewer.append(node('summary', label, null, dom), content);
  return viewer;
}

export function modelRow({ call, durationMs, usage }) {
  const tokens = usage && (usage.input != null || usage.output != null)
    ? 'in ' + (usage.input ?? 'unreported') + ', out ' + (usage.output ?? 'unreported')
    : 'usage unreported';
  return 'Model call ' + call + ' · ' + durationMs + ' ms · ' + tokens;
}

export function toolRow(update) {
  const meta = [];
  if (Number.isFinite(update.durationMs)) meta.push(update.durationMs + ' ms');
  if (Number.isInteger(update.exitCode)) meta.push('exit ' + update.exitCode);
  else if (Number.isInteger(update.bytes)) meta.push(update.bytes + ' B');
  if (update.timedOut) meta.push('timed out');
  return {
    title: update.summary ?? update.title ?? update.name ?? 'Tool call',
    name: update.toolId ?? (update.name && update.name !== update.title ? update.name : ''),
    phase: update.status ?? 'pending',
    meta: meta.join(' · '),
    output: typeof update.output === 'string' ? update.output : '',
  };
}
