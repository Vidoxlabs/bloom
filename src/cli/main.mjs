import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { dataPath } from '../data-dir.mjs';
import { BloomError } from '../errors.mjs';
import { Harness, workspacePath } from '../harness.mjs';
import { Store } from '../store.mjs';
import { readTerminalProvider, terminalModel } from './config.mjs';
import { doctor } from './doctor.mjs';
import { selectProviders } from './providers.mjs';
import { lineRenderer } from './render/line.mjs';
import { jsonRenderer } from './render/json.mjs';
import { bloomVersion, exportSession, maskWorkspace, replaySession, showSession } from './session-io.mjs';
import { cliControls } from './signals.mjs';
import { runResult, runTurn } from './turn.mjs';

const string = { type: 'string' };
const flag = { type: 'boolean' };
const common = { help: { ...flag, short: 'h' }, version: { ...flag, short: 'v' }, 'data-dir': string };
const sharedRun = { model: string, workspace: string, demo: flag };
const commands = {
  chat: { ...sharedRun, team: string },
  run: { ...sharedRun, headless: flag, json: flag, 'max-calls': string, 'token-limit': string, 'approve-policy': string, 'output-last-message': string },
  doctor: { json: flag },
  sessions: { json: flag, jsonl: flag, out: string },
  replay: { json: flag, step: flag },
  memory: { team: string, text: string, confirm: flag },
};
const help = {
  chat: 'bloom chat [--team NAME] [--model ALIAS] [--workspace PATH] [--demo]  (--workspace without --team runs the coding loop)',
  run: 'bloom run --headless (PROMPT | -) [--json] [--max-calls N] [--token-limit N] [--approve-policy deny|allow-read] [--output-last-message FILE] [--model ALIAS] [--workspace PATH] [--demo]',
  doctor: 'bloom doctor [--json]',
  sessions: 'bloom sessions list [--json] | show ID [--json] | export ID --jsonl [--out FILE]',
  replay: 'bloom replay FILE [--json] [--step]',
  memory: 'bloom memory list --team NAME | keep ID | correct ID --text TEXT | forget ID --confirm',
};
const { stdin, stdout, stderr } = process;
const output = value => stdout.write(JSON.stringify(value) + '\n');
let directory;
let store;
let harness;
let input;
let renderer;
let jsonRun = false;

function closeResources() {
  input?.close();
  renderer?.close();
  const closing = harness?.close();
  return closing;
}
const controls = cliControls(() => {
  void closeResources();
  store?.close();
});

class UsageError extends Error {}
const usage = message => { throw new UsageError(message); };
const need = (condition, message) => { if (!condition) usage(message); };
const noExtras = args => need(args.length === 0, 'Unexpected positional argument.');

function numberFlag(values, name, max) {
  if (values[name] === undefined) return undefined;
  const value = Number(values[name]);
  need(/^\d+$/.test(values[name]) && Number.isSafeInteger(value) && value >= 1 && value <= max,
    'Choose --' + name + ' from 1 to ' + max + '.');
  return value;
}

function attachReader() {
  input = createInterface({ input: stdin, output: stdout.isTTY ? stdout : undefined, terminal: Boolean(stdin.isTTY && stdout.isTTY) });
  input.on('SIGINT', controls.interrupt);
  const iterator = input[Symbol.asyncIterator]();
  return async () => (await iterator.next()).value ?? null;
}

function openStore(redact) {
  store ??= new Store(directory, { redact });
  return store;
}

function openHarness(settings = {}, workspace = '') {
  const { redact, ...providers } = selectProviders(settings);
  harness = new Harness({
    store: openStore(redact), dataDirectory: directory, defaultWorkspace: workspace, ...providers,
  });
  return harness;
}

function teamSession(name, workspace, model, limits) {
  if (name) {
    const matches = store.db.prepare('SELECT id FROM teams WHERE lower(name) = lower(?) ORDER BY id').all(name);
    if (matches.length > 1) usage('Several teams use that name. Choose a unique team name in Bloom.');
    if (matches.length === 1) {
      const session = store.getSession(matches[0].id);
      if (workspace && session.workspace !== workspace) usage('That team belongs to a different workspace. Choose a new team name.');
      return session;
    }
  }
  return harness.teams.create({ name, model, ...limits }, workspace ? { workspace } : undefined);
}

function completion(result, message, json) {
  if (message) stderr.write(message + '\n');
  if (json) renderer.onEvent(result);
  return result.exitCode;
}

function cloudRefusal(provider) {
  if (provider) return 'Cloud access for ' + provider.label + ' is unavailable in the terminal shell.';
  return 'Cloud models are unavailable in the terminal shell.';
}

async function promptText(argument) {
  if (argument !== '-') return argument;
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    size += chunk.length;
    need(size <= 128_000, 'Enter a prompt of 1 to 32,000 characters.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function runCommand(action, args, values) {
  const headless = action === 'run';
  const policy = values['approve-policy'] ?? 'deny';
  const limits = { callLimit: numberFlag(values, 'max-calls', 20), tokenLimit: numberFlag(values, 'token-limit', 10_000_000) };
  let text, nextLine;
  if (headless) {
    need(values.headless && args.length === 1, help.run);
    need(['deny', 'allow-read'].includes(policy), 'Choose --approve-policy deny or allow-read.');
    text = await promptText(args[0]);
    need(text.trim() && text.length <= 32_000, 'Enter a prompt of 1 to 32,000 characters.');
  } else {
    noExtras(args);
  }
  const provider = values.demo ? null : readTerminalProvider(directory);
  const configured = values.demo || provider?.local;
  if (!headless && configured) nextLine = attachReader();
  const streams = { stdout, headless, nextLine, policy };
  renderer = values.json ? jsonRenderer(streams) : lineRenderer(streams);
  if (!configured) {
    return provider
      ? completion(runResult('refused', 'EGRESS_REFUSED'), cloudRefusal(provider), values.json)
      : completion(runResult('failed', 'PROVIDER_UNCONFIGURED'),
        'Set a provider in config.json under --data-dir, or choose --demo.', values.json);
  }
  const model = provider ? terminalModel(provider, values.model) : values.model;
  if (provider && /-cloud$/i.test(model)) {
    return completion(runResult('refused', 'EGRESS_REFUSED'), cloudRefusal(), values.json);
  }
  const workspace = values.workspace ? workspacePath(resolve(values.workspace)) : '';
  openHarness({ ...provider, demo: values.demo, model, terminal: true, headless }, workspace);
  // A workspace without a team name opens the coding loop in that folder.
  const coding = !values.demo && workspace && !values.team;
  const session = values.demo ? harness.createSession({ model })
    : coding ? harness.createSession({ workspace, adapter: 'coding', model })
      : teamSession(values.team, workspace, model, limits);
  const turn = async text => {
    const { result, message } = await runTurn(harness, session, { text, model },
      renderer, controls, values['output-last-message']);
    return completion(result, message, values.json);
  };
  if (headless) return turn(text);
  let code = 0;
  while (true) {
    if (stdout.isTTY) stdout.write('bloom > ');
    const next = await nextLine();
    if (next === null || next === '/exit') return code;
    if (!next.trim()) continue;
    code = await turn(next);
    if (controls.interrupted) return 130;
  }
}

function sessions([action, id, ...args], values) {
  noExtras(args);
  if (action === 'list') {
    need(!id && !values.jsonl && !values.out, help.sessions);
    const rows = existsSync(join(directory, 'vibloom.sqlite')) ? openStore().listSessions() : [];
    if (values.json) output(rows.map(row => maskWorkspace(row, row.workspace)));
    else for (const row of rows) stdout.write(row.id + '  ' + row.title + '  ' + row.adapter + '\n');
    return 0;
  }
  need(id && ((action === 'show' && !values.jsonl && !values.out) || (action === 'export' && values.jsonl && !values.json)), help.sessions);
  const session = openStore().getSession(id);
  if (action === 'show') showSession(store, session, stdout, values.json);
  else exportSession(store, session, stdout, values.out);
  return 0;
}

function memory([action, id, ...args], values) {
  noExtras(args);
  if (action === 'list') {
    need(!id && values.team && !values.text && !values.confirm, help.memory);
    const { teams } = openHarness();
    const matches = store.db.prepare('SELECT id FROM teams WHERE lower(name) = lower(?)').all(values.team);
    need(matches.length === 1, 'Choose a unique existing team name.');
    const { notes, proposals } = teams.detail(matches[0].id);
    output({ notes, proposals });
    return 0;
  }
  need(id && !values.team && (
    (action === 'forget' && values.confirm && !values.text) ||
    (action === 'keep' && !values.confirm && !values.text) ||
    (action === 'correct' && values.text && !values.confirm)
  ), action === 'forget' ? 'Forget needs a note ID and --confirm.' : help.memory);
  const { teams } = openHarness();
  const row = store.db.prepare('SELECT team FROM memories WHERE id = ?').get(id);
  if (!row) throw new BloomError('NOTE_MISSING', 'Team note not found.', 404);
  const team = row.team ?? store.db.prepare('SELECT id FROM teams ORDER BY id LIMIT 1').get()?.id;
  if (!team) throw new BloomError('TEAM_NOT_FOUND', 'No team can manage this note.', 404);
  if (action === 'keep') output(teams.keep(team, id));
  else if (action === 'correct') output(teams.correct(team, id, { text: values.text }));
  else output(teams.forget(team, id));
  return 0;
}

async function main(argv) {
  const [first, ...rest] = argv;
  const action = first?.startsWith('-') ? undefined : first;
  need(!action || Object.hasOwn(commands, action), 'Unknown command. Use bloom --help.');
  let parsed;
  try { parsed = parseArgs({ args: action ? rest : argv, options: { ...common, ...commands[action] }, allowPositionals: Boolean(action) }); }
  catch { usage('Invalid arguments. Use --help for this command.'); }
  const { values, positionals } = parsed;
  jsonRun = action === 'run' && values.json;
  if (values.version) {
    stdout.write(bloomVersion + '\n');
    return 0;
  }
  if (values.help || !action) {
    stdout.write((action ? help[action] : Object.values(help).join('\n')) + '\nOptions: --data-dir PATH, --help, --version\n');
    return 0;
  }
  directory = dataPath(values['data-dir'], values.demo);
  switch (action) {
    case 'chat':
    case 'run': return runCommand(action, positionals, values);
    case 'doctor':
      noExtras(positionals);
      return doctor(directory, values, { stdin, stdout });
    case 'sessions': return sessions(positionals, values);
    case 'replay':
      need(positionals.length === 1, help.replay);
      await replaySession(positionals[0], { stdout, json: values.json, step: values.step, nextLine: values.step ? attachReader() : null });
      return 0;
    case 'memory': return memory(positionals, values);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.exitCode = error instanceof UsageError || (error instanceof BloomError && error.status === 400) ? 2 : 1;
  const message = error instanceof UsageError || error instanceof BloomError ? error.message : 'Bloom could not complete the command.';
  stderr.write(message + '\n');
  if (jsonRun) {
    output(runResult('failed', error instanceof UsageError ? 'USAGE' : (error.code ?? 'COMMAND_FAILED'), { exitCode: process.exitCode }));
  }
} finally {
  try { await closeResources(); }
  finally {
    store?.close();
    controls.close();
  }
}
