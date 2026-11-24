import { styleText } from 'node:util';

const ansi = Object.freeze({
  'text-content-primary-base': 'white',
  'text-content-secondary-base': 'gray',
  'surface-accent-violet-base': 'magenta',
  'status-indicator-success-base': 'green',
  'status-indicator-warning-base': 'yellow',
  'status-indicator-error-base': 'red',
  'status-indicator-info-base': 'cyan',
});

export function hasColor(stdout, env = process.env) {
  return Boolean(stdout.isTTY) && env.NO_COLOR === undefined && env.TERM !== 'dumb';
}

export function paintRole(role, text, stdout, env = process.env) {
  return hasColor(stdout, env) && Object.hasOwn(ansi, role)
    ? styleText(ansi[role], text, { validateStream: false }) : text;
}

export function statusRole(status) {
  if (['completed', 'finished'].includes(status)) return 'status-indicator-success-base';
  if (['failed', 'invalid-output'].includes(status)) return 'status-indicator-error-base';
  if (['refused', 'denied', 'limit', 'stopping'].includes(status)) return 'status-indicator-warning-base';
  return 'status-indicator-info-base';
}
