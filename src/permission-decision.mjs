import { createHash } from 'node:crypto';
import { validateValue } from '@vidoxlabs/seed';
import { BloomError } from './errors.mjs';

export function argumentDigest(toolId, args) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return createHash('sha256').update(JSON.stringify([toolId, canonical(args)])).digest('hex');
}

export function canRespond(effect) {
  return effect === 'write';
}

export function permissionDecision(request, option, input) {
  const { callId, argsDigest, toolId } = request;
  if (argsDigest && input.argsDigest !== argsDigest) {
    throw new BloomError('PERMISSION_DIGEST_MISMATCH', 'The pending action changed. Review it before deciding.', 409);
  }
  const bound = argsDigest ? { callId, argsDigest, toolId, digestMatched: true } : null;
  if (option.kind === 'respond') {
    if (!bound || !canRespond(request.effect)) {
      throw new BloomError('PERMISSION_RESPONSE_REFUSED', 'Owner text cannot replace this action.', 403);
    }
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 32_000) {
      throw new BloomError('PERMISSION_RESPONSE_INVALID', 'Enter owner text from 1 to 32,000 characters.', 400);
    }
    return { value: { kind: 'respond', text: input.text }, receipt: { ...bound, decision: 'respond' } };
  }
  if (option.kind === 'edit') {
    const args = input.editedArgs;
    if (!bound || !request.editSchema || !validateValue(request.editSchema, args).ok) {
      throw new BloomError('PERMISSION_EDIT_INVALID', 'Replacement arguments do not match the tool schema.', 400);
    }
    const editedArgsDigest = argumentDigest(toolId, args);
    return {
      value: { kind: 'edit', args, editedArgsDigest },
      receipt: { ...bound, decision: 'edit', editedArgsDigest },
    };
  }
  return { value: option.id, receipt: bound && { ...bound, decision: option.kind === 'reject_once' ? 'reject' : 'approve' } };
}
