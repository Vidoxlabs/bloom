import { styleText } from 'node:util';
import { headlessChoice } from './json.mjs';

export function hasColor(stdout, env = process.env) {
  return Boolean(stdout.isTTY) && env.NO_COLOR === undefined && env.TERM !== 'dumb';
}

const unreported = value => value ?? 'unreported';
const plain = value => String(value).replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '');
const clockTime = at => typeof at === 'string' && /T\d\d:\d\d:\d\d/.test(at) ? at.slice(11, 19) : '--:--:--';
const finalStatuses = new Set(['completed', 'failed', 'denied', 'refused', 'invalid-output']);

// One trace row per call: time, tool ID, a short argument summary, the result, and the duration.
function traceRow(at, data) {
  const parts = [clockTime(at), data.toolId, data.summary, data.status];
  if (data.approval === 'session') parts.push('allowed for session');
  if (data.approval === 'auto') parts.push('auto');
  if (data.timedOut) parts.push('timed out');
  else if (data.exitCode !== undefined && data.exitCode !== null) parts.push('exit ' + data.exitCode);
  if (Number.isSafeInteger(data.bytes)) parts.push(data.bytes + ' B');
  if (data.reason) parts.push(data.reason);
  if (data.homeCleanupFailed) parts.push('home cleanup failed');
  parts.push(data.durationMs + ' ms');
  return parts.filter(part => part !== undefined && part !== '').join('  ');
}

function modelRow(at, data) {
  const usage = data.usage ? 'in ' + unreported(data.usage.input) + ', out ' + unreported(data.usage.output) : 'usage unreported';
  const parts = [clockTime(at), 'model', 'call ' + data.call, data.durationMs + ' ms', usage];
  if (data.cloud) parts.push('cloud');
  return parts.join('  ');
}

export function lineRenderer({ stdout, nextLine, headless = false, policy = 'deny' }) {
  const paint = (color, value) => hasColor(stdout) ? styleText(color, value, { validateStream: false }) : value;
  let midLine = false;
  const write = value => {
    if (!value) return;
    stdout.write(value);
    midLine = !value.endsWith('\n');
  };
  const line = value => {
    write((midLine ? '\n' : '') + plain(value) + '\n');
  };
  return {
    onEvent({ type, data = {}, ...result }) {
      switch (type) {
        case 'session.header': line('Session ' + result.sessionId); break;
        case 'user.message': write((midLine ? '\n' : '') + paint('cyan', 'You') + '  ' + plain(data.text) + '\n'); break;
        case 'team.message': line(data.author + '  ' + data.text); break;
        case 'assistant.delta':
          if (data.final) line('\nAnswer  ' + data.text);
          else write(plain(data.text).replace(/\r/g, ''));
          break;
        case 'model.call': line(modelRow(result.at, data)); break;
        case 'agent.connected': line('Model ' + unreported(data.model)); break;
        case 'team.call': line(data.actor + '  ' + data.phase + ' (' + data.calls + '/' + data.limit + ')'); break;
        case 'team.recall': line(data.actor + ' recalled ' + data.count + ' notes'); break;
        case 'team.memory': line(data.actor + ' suggested ' + data.suggested + ' notes'); break;
        case 'team.usage':
        case 'model.usage': {
          const usage = type === 'model.usage' ? data : data.usage;
          line('Tokens in ' + unreported(usage?.input) + ', out ' + unreported(usage?.output) +
            ', total ' + unreported(usage?.total) + ', cost ' + (data.costUSD ?? 'n/a'));
          break;
        }
        case 'plan.updated': for (const entry of data.entries) line(entry.status + '  ' + entry.text); break;
        case 'tool.updated':
          if (data.toolId && finalStatuses.has(data.status) && data.durationMs !== undefined) {
            line(traceRow(result.at, data));
            if (typeof data.output === 'string' && data.output) {
              for (const text of data.output.replace(/\n$/, '').split('\n')) line('    | ' + text);
            }
          } else {
            line(data.status + '  ' + (data.title ?? data.name ?? data.id));
          }
          break;
        case 'permission.requested':
          line('Permission requested  ' + data.title);
          if (data.detail) for (const text of String(data.detail).split('\n')) line('    ' + text);
          break;
        case 'permission.resolved': line('Permission ' + data.kind); break;
        case 'turn.finished': line('\nTurn ' + data.status); break;
        case 'turn.stopping': line('Stopping turn'); break;
      }
    },
    async prompt(request) {
      if (headless) return headlessChoice(request, policy);
      for (const [index, option] of request.options.entries()) line((index + 1) + '  ' + option.label);
      stdout.write('Choose a response (Enter rejects) > ');
      const answer = await nextLine();
      const index = /^\d+$/.test(answer ?? '') ? Number(answer) - 1 : -1;
      return request.options[index]?.id ?? headlessChoice(request, 'deny');
    },
    close() {},
  };
}
