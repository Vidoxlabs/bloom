import { isAbsolute, relative, sep } from 'node:path';

import { BloomError } from './errors.mjs';

export function invalidArgument(message) {
  return new BloomError('WORKSPACE_ARGUMENT_INVALID', message, 400);
}

export function cancelled() {
  return new BloomError('WORKSPACE_TOOL_CANCELLED', 'The workspace tool was cancelled.', 409);
}

export function textArgument(value, name, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw invalidArgument(`Provide a valid ${name} argument.`);
  }
  return value;
}

export function isOutside(root, target) {
  const suffix = relative(root, target);
  return suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix);
}
