// The coding runtime: a model picks one workspace tool per reply, Bloom checks the call against the
// admitted tools and the face schemas, asks the owner before any write or command, runs the tool
// inside the workspace, and finishes when the model calls run.answer.create.
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { workspaceToolPack } from '@vidoxlabs/drosera';
import { validateValue } from '@vidoxlabs/seed';
import { BloomError } from './errors.mjs';
import { adoptProvider } from './provider.mjs';
import { createWorkspaceTools, workspaceCommandAccess } from './workspace-tools.mjs';

const FINISH = 'run.answer.create';
const SHELL = 'workspace.shell.execute';
const DENIED = 'denied by owner';
const ACTION_BLOCK = /```json[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;
const DEFAULT_PROMPT_CHARS = 24_000;
const OBSERVATION_CHARS = 6_000;
const SHELL_OUTPUT_CHARS = 4_000;

export const CODING_RUNTIME_ID = 'coding';

function argumentDigest(toolId, args) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return createHash('sha256').update(JSON.stringify([toolId, canonical(args)])).digest('hex');
}

function describeSchema(schema) {
  const required = new Set(schema?.required ?? []);
  return Object.entries(schema?.properties ?? {}).map(([name, field]) => {
    const type = field.type === 'array' ? `array of ${field.items?.type ?? 'value'}` : field.type;
    return `${name}${required.has(name) ? '' : '?'}: ${type}`;
  }).join(', ');
}

function systemPrompt(faces, headless) {
  const tools = faces.map(face => `- ${face.id} (${face.effect}): ${face.summary} Args: { ${describeSchema(face.inputSchema)} }`);
  return [
    'You are a coding agent working inside one workspace folder. You act only through tools.',
    'Each reply holds a short note to the owner, then exactly one fenced json block naming one tool call:',
    '```json',
    '{ "tool": "<tool id>", "args": { } }',
    '```',
    'Rules:',
    '- Use paths relative to the workspace. Never use absolute paths or "..".',
    '- workspace.shell.execute runs only node, npm, or git (status, diff, log, add, commit), with args as a list.',
    headless
      ? '- This run is read-only. Writes and commands are refused.'
      : '- The owner approves every write and every command. If a call is denied, choose another approach.',
    `- When the task is done, call ${FINISH} with a short summary. That ends the run.`,
    'Tools:',
    ...tools,
  ].join('\n');
}

// Strict action parsing: exactly one json block holding exactly { tool, args }.
function parseAction(text) {
  const blocks = [...String(text ?? '').matchAll(ACTION_BLOCK)].map(match => match[1]);
  if (blocks.length !== 1) return { errors: [`Reply with exactly one fenced json block; found ${blocks.length}.`] };
  let value;
  try { value = JSON.parse(blocks[0]); }
  catch { return { errors: ['The json block is not valid JSON.'] }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { errors: ['The json block must be an object.'] };
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'args,tool') return { errors: ['The json block must hold exactly the keys "tool" and "args".'] };
  if (typeof value.tool !== 'string') return { errors: ['"tool" must be a tool id string.'] };
  if (!value.args || typeof value.args !== 'object' || Array.isArray(value.args)) return { errors: ['"args" must be an object.'] };
  return { action: { tool: value.tool, args: value.args } };
}

function schemaErrors(result) {
  return result.errors.map(error => `${error.path || '/'}: ${error.reason}`);
}

const shortText = (value, limit = 48) => {
  const text = String(value).replace(/\s+/g, ' ');
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
};
const quoteArgument = value => /^[\w./=:@%+,-]+$/.test(value) ? value : JSON.stringify(value);

// The trace summary names paths, queries and commands, never file contents.
function summarize(toolId, args) {
  switch (toolId) {
    case 'workspace.dir.list': return 'path=' + (args.path ?? '.');
    case 'workspace.file.read': {
      const lines = args.startLine || args.endLine ? `, lines ${args.startLine ?? 1}-${args.endLine ?? 'end'}` : '';
      return 'path=' + args.path + lines;
    }
    case 'workspace.text.search': return 'query=' + JSON.stringify(shortText(args.query)) + (args.path ? ', path=' + args.path : '');
    case 'workspace.file.write': return `path=${args.path}, ${Buffer.byteLength(args.content ?? '')} bytes`;
    case 'workspace.file.update':
      return `path=${args.path}, -${Buffer.byteLength(args.oldText ?? '')} +${Buffer.byteLength(args.newText ?? '')} bytes`;
    case SHELL: return [args.command, ...(args.args ?? [])].map(quoteArgument).join(' ');
    case FINISH: return `${String(args.text ?? '').length} chars`;
    default: return '';
  }
}

const prefixed = (prefix, text) => text.replace(/\n$/, '').split('\n').map(line => prefix + line).join('\n');

// What the owner sees before approving: the full content, the edit, or the command and every argument.
function approvalDetail(toolId, args) {
  if (toolId === 'workspace.file.write') return `Write ${args.path}:\n${prefixed('+ ', args.content)}`;
  if (toolId === 'workspace.file.update') {
    return `Edit ${args.path}:\n${prefixed('- ', args.oldText)}\n${prefixed('+ ', args.newText)}`;
  }
  if (toolId === SHELL) return `Run in the workspace:\ncommand: ${args.command}\nargs: ${JSON.stringify(args.args ?? [])}`;
  return summarize(toolId, args);
}

const tail = (text, limit) => text.length > limit ? '…' + text.slice(-limit) : text;
const head = (text, limit) => text.length > limit ? text.slice(0, limit) + '…' : text;

function observationText(toolId, result) {
  if (toolId === SHELL) {
    const exit = result.timedOut ? 'timed out' : `exit code ${result.exitCode}`;
    return `${exit}\n${tail(result.output, OBSERVATION_CHARS)}`;
  }
  const note = result.truncatedBytes ? `\n[${result.truncatedBytes} more bytes not shown]` : '';
  return head(result.output, OBSERVATION_CHARS) + note;
}

const known = slot => slot && slot.source !== 'unknown' ? slot : null;

// Pick the loop's prompt settings from a model profile, using only reported or probed values.
// The action format stays the fenced json block (D16) whatever the profile says, and an unknown
// slot falls back to the default rather than a guess.
export function codingConfig(profile) {
  const context = known(profile?.contextLength);
  const streaming = known(profile?.streaming);
  const tools = known(profile?.toolCalling);
  const sized = context && Number.isSafeInteger(context.value);
  return {
    promptStyle: 'fenced-json',
    // About three characters a token, keeping a quarter of the window for the reply.
    promptChars: sized ? Math.max(4_000, Math.floor(context.value * 3 * 0.75)) : DEFAULT_PROMPT_CHARS,
    budgetSource: sized ? context.source : 'default',
    streaming: streaming ? streaming.value !== false : true,
    streamingSource: streaming ? streaming.source : 'unknown',
    constrainedOutput: false,
    toolCalling: tools?.value === true ? tools.source : 'unknown',
  };
}

function buildPrompt(task, earlier, steps, budget) {
  const opening = [
    earlier.length ? 'Earlier in this session:\n' + earlier.map(item => `- Task: ${shortText(item.task, 200)}\n  Answer: ${shortText(item.answer, 400)}`).join('\n') + '\n' : '',
    'Task:\n' + task,
  ].join('\n');
  const rendered = steps.map((step, index) => `Step ${index + 1}, your reply:\n${step.reply}\n\nResult:\n${step.observation}`);
  let kept = rendered.length;
  const closing = '\n\nReply with your next tool call.';
  const size = count => opening.length + closing.length + rendered.slice(rendered.length - count).join('\n\n').length + 64;
  while (kept > 1 && size(kept) > budget) kept -= 1;
  const omitted = rendered.length - kept;
  return [opening, omitted ? `[${omitted} earlier steps omitted to fit the context budget]` : '', ...rendered.slice(rendered.length - kept)]
    .filter(Boolean).join('\n\n') + closing;
}

export function createCodingRuntime({
  provider,
  headless = false,
  cloud = false,
  maxSteps = 40,
  profile = null,
  allowedTools = workspaceToolPack.ids(),
  outputSchemas = {},
  environment = process.env,
  searchPath = environment.PATH,
  toolOptions = {},
  clock = () => performance.now(),
  newId = randomUUID,
  label = 'Coding loop',
} = {}) {
  let adopted = adoptProvider(provider);
  const admitted = new Set(allowedTools);
  const faces = workspaceToolPack.faces.filter(face => admitted.has(face.id));
  const system = systemPrompt(faces, headless);
  const config = Object.freeze(codingConfig(profile));
  const budget = config.promptChars;
  const streaming = config.streaming;
  const sessions = new Map();

  async function run({ workspace, nativeId, model: requested, prompt: task, signal }, hooks) {
    // A session opened without a model, as the web form opens one, uses the provider's default.
    const model = requested ?? adopted.defaultModel;
    const id = nativeId ?? newId();
    hooks.bind({ nativeId: id, model: model ?? null, models: model ? [{ id: model, label: model }] : [], resumed: Boolean(nativeId) });
    const memory = sessions.get(id) ?? { allowances: new Set(), earlier: [] };
    sessions.set(id, memory);
    const tools = createWorkspaceTools(workspace, { commands: workspaceCommandAccess, environment, searchPath, ...toolOptions });
    const steps = [];
    let repairs = 0;
    let messageApproved = !cloud;
    const elapsed = started => Math.max(0, Math.round(clock() - started));

    // One repair turn is shared by argument and output checks; a call that runs resets it.
    const repair = (reply, errors) => {
      if (repairs >= 1) return false;
      repairs += 1;
      steps.push({ reply, observation: 'Your last reply could not run:\n' + errors.map(error => '- ' + error).join('\n') +
        '\nReply again with exactly one fenced json block holding a valid call.' });
      return true;
    };

    for (let call = 1; call <= maxSteps; call += 1) {
      if (signal.aborted) return { stopReason: 'cancelled' };
      if (cloud && !messageApproved) {
        if (headless) return { stopReason: 'refusal' };
        const choice = await hooks.permission({
          title: 'Send this turn to a cloud model', kind: 'egress', effect: 'egress', toolId: 'cloud-message',
          summary: 'first message', detail: 'Cloud model will receive:\n' + head(task, 4_000),
          options: [
            { id: 'allow-once', kind: 'allow_once', label: 'Allow once' },
            { id: 'reject', kind: 'reject_once', label: 'Reject' },
          ],
        });
        if (signal.aborted || choice === null) return { stopReason: 'cancelled' };
        if (choice === 'reject') return { stopReason: 'refusal' };
        messageApproved = true;
      }
      const started = clock();
      let generation;
      try {
        generation = await adopted.generate({
          system, prompt: buildPrompt(task, memory.earlier, steps, budget), model, signal,
          ...(streaming ? { onDelta: text => { if (!signal.aborted) hooks.emit('assistant.delta', { text }); } } : {}),
        });
      } catch (error) {
        if (signal.aborted) return { stopReason: 'cancelled' };
        if (error instanceof BloomError && error.code === 'PROVIDER_RATE_LIMITED') {
          return { stopReason: 'rate_limited' };
        }
        throw error;
      }
      if (signal.aborted) return { stopReason: 'cancelled' };
      if (!streaming && generation.text) hooks.emit('assistant.delta', { text: generation.text });
      hooks.emit('model.call', {
        call, durationMs: elapsed(started), model: generation.model, complete: generation.complete,
        usage: generation.usage, ...(cloud ? { cloud: true } : {}),
      });
      const reply = generation.text;
      const parsed = generation.complete ? parseAction(reply) : { errors: ['The reply was cut off before it finished.'] };
      if (parsed.errors) {
        if (repair(reply, parsed.errors)) continue;
        return { stopReason: 'malformed' };
      }
      const { tool: toolId, args } = parsed.action;
      if (!admitted.has(toolId)) {
        if (repair(reply, [`${toolId} is not an admitted tool. Choose one of: ${[...admitted].join(', ')}.`])) continue;
        return { stopReason: 'malformed' };
      }
      const face = workspaceToolPack.face(toolId);
      const checked = validateValue(face.inputSchema, args);
      if (!checked.ok) {
        if (repair(reply, schemaErrors(checked))) continue;
        return { stopReason: 'malformed' };
      }

      const row = { id: newId(), toolId, effect: face.effect, summary: summarize(toolId, args) };
      const finishRow = (status, details = {}) => hooks.emit('tool.updated', { ...row, status, ...details });
      const toolStarted = clock();
      let approval = 'none';
      // Cloud mode asks before every tool, including reads, because results leave the machine.
      const needsApproval = cloud || face.effect !== 'read';

      if (needsApproval) {
        if (headless) {
          finishRow('refused', { durationMs: elapsed(toolStarted), approval: 'headless' });
          steps.push({ reply, observation: `${DENIED}: this run is headless and cannot write or run commands.` });
          repairs = 0;
          continue;
        }
        if (toolId === SHELL) {
          try {
            await tools.checkCommand(args);
          } catch (error) {
            if (!(error instanceof BloomError)) throw error;
            finishRow('refused', { durationMs: elapsed(toolStarted), reason: error.code });
            steps.push({ reply, observation: 'refused: ' + error.message });
            repairs = 0;
            continue;
          }
        }
        const digest = argumentDigest(toolId, args);
        if (toolId !== SHELL && memory.allowances.has(digest)) {
          approval = 'session';
        } else {
          const options = [
            { id: 'allow-once', kind: 'allow_once', label: 'Allow once' },
            ...(toolId === SHELL ? [] : [{ id: 'allow-session', kind: 'allow_session', label: 'Allow this exact call for the session' }]),
            { id: 'reject', kind: 'reject_once', label: 'Reject' },
          ];
          const choice = await hooks.permission({
            title: `${toolId}  ${row.summary}`, kind: face.effect, effect: face.effect, toolId,
            summary: row.summary, detail: approvalDetail(toolId, args), options,
            ...(toolId === SHELL ? { command: args.command, args: [...(args.args ?? [])] } : {}),
          });
          if (signal.aborted || choice === null) return { stopReason: 'cancelled' };
          if (choice !== 'allow-once' && choice !== 'allow-session') {
            finishRow('denied', { durationMs: elapsed(toolStarted), approval: 'denied' });
            steps.push({ reply, observation: DENIED });
            repairs = 0;
            continue;
          }
          approval = choice === 'allow-session' ? 'session-granted' : 'once';
          if (choice === 'allow-session') memory.allowances.add(digest);
        }
      }

      let result;
      try {
        result = await tools.execute(toolId, args, { signal });
      } catch (error) {
        if (signal.aborted) return { stopReason: 'cancelled' };
        if (!(error instanceof BloomError)) throw error;
        finishRow(error.code === 'WORKSPACE_COMMAND_REFUSED' ? 'refused' : 'failed', { durationMs: elapsed(toolStarted), approval, reason: error.code });
        steps.push({ reply, observation: 'failed: ' + error.message });
        repairs = 0;
        continue;
      }
      const durationMs = elapsed(toolStarted);
      const bytes = Buffer.byteLength(result.output) + result.truncatedBytes;
      const outputSchema = outputSchemas[toolId] ?? face.outputSchema;
      if (outputSchema) {
        const valid = validateValue(outputSchema, result);
        if (!valid.ok) {
          finishRow('invalid-output', { durationMs, approval, bytes });
          if (repair(reply, [`The ${toolId} result did not match its output schema, so it is not shown.`])) continue;
          return { stopReason: 'malformed' };
        }
      }
      repairs = 0;
      const details = {
        durationMs, approval: approval === 'session-granted' ? 'once' : approval, bytes,
        truncatedBytes: result.truncatedBytes, outputSha256: result.outputSha256,
      };
      if (toolId === SHELL) {
        const passed = result.exitCode === 0 && !result.timedOut;
        finishRow(passed ? 'completed' : 'failed', {
          ...details, exitCode: result.exitCode, timedOut: result.timedOut, output: tail(result.output, SHELL_OUTPUT_CHARS),
          ...(result.homeCleanupFailed ? { homeCleanupFailed: true } : {}),
        });
      } else {
        finishRow('completed', details);
      }
      if (toolId === FINISH) {
        hooks.emit('assistant.delta', { text: result.output, final: true });
        memory.earlier.push({ task, answer: result.output });
        return { stopReason: 'end_turn' };
      }
      steps.push({ reply, observation: observationText(toolId, result) });
    }
    return { stopReason: 'max_turn_requests' };
  }

  return {
    id: CODING_RUNTIME_ID,
    label,
    config,
    get provider() { return adopted; },
    set provider(value) { adopted = adoptProvider(value); },
    run,
  };
}
