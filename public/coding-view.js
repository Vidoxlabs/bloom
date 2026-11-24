// Rendering helpers for trace rows and approvals in the browser.
// A row names paths and commands from the event's summary and never adds anything else.

export function node(tag, text, className, dom = document) {
  const element = dom.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}

export function approvalCard({ title, detail }, dom = document) {
  const card = node('div', null, 'approval', dom);
  card.append(node('strong', 'Approval needed', null, dom), node('p', title, null, dom));
  if (detail) card.append(node('pre', detail, 'approval-detail', dom));
  return card;
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
