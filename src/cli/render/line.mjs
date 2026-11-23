import { styleText } from 'node:util';
import { headlessChoice } from './json.mjs';

export function hasColor(stdout, env = process.env) {
  return Boolean(stdout.isTTY) && env.NO_COLOR === undefined && env.TERM !== 'dumb';
}

const unreported = value => value ?? 'unreported';
const plain = value => String(value).replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '');

export function lineRenderer({ stdout, nextLine, headless = false, policy = 'deny' }) {
  const paint = (color, value) => hasColor(stdout) ? styleText(color, value, { validateStream: false }) : value;
  const line = value => stdout.write(plain(value) + '\n');
  return {
    onEvent({ type, data = {}, ...result }) {
      switch (type) {
        case 'session.header': line('Session ' + result.sessionId); break;
        case 'user.message': stdout.write(paint('cyan', 'You') + '  ' + plain(data.text) + '\n'); break;
        case 'team.message': line(data.author + '  ' + data.text); break;
        case 'assistant.delta': stdout.write(plain(data.text)); break;
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
        case 'tool.updated': line(data.status + '  ' + (data.title ?? data.name ?? data.id)); break;
        case 'permission.requested': line('Permission requested  ' + data.title); break;
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
