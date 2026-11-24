// A scripted coding provider for offline tests and the dev-only scripted run. It replays fixed
// replies, streams each one in pieces, and never reaches a network or reads a config file.
import { setImmediate as nextTurn } from 'node:timers/promises';

export const demoTask = 'Create NOTES.md with one line describing this project. Run the tests, fix the failing test, '
  + 'run the tests again, and finish with a short summary.';

export const testCommand = { command: 'node', args: ['--test', '--test-reporter=./reporter.mjs', 'test/range.test.mjs'] };

export function action(tool, args, note) {
  return (note ? note + '\n\n' : '') + '```json\n' + JSON.stringify({ tool, args }) + '\n```';
}

export const demoReplies = Object.freeze([
  action('workspace.dir.list', {}, 'I will look at the project layout first.'),
  action('workspace.file.read', { path: 'src/range.mjs' }, 'The source file holds the range helper.'),
  action('workspace.text.search', { query: 'range(' }, 'I will find where the helper is used.'),
  action('workspace.file.write', {
    path: 'NOTES.md', content: 'demo-repo is a tiny Node project whose range helper lists the whole numbers between two ends.\n',
  }, 'I will add the project note.'),
  action('workspace.shell.execute', testCommand, 'Now the tests.'),
  action('workspace.file.update', { path: 'src/range.mjs', oldText: 'value < end', newText: 'value <= end' },
    'The loop stops one short of the end value. I will include the end.'),
  action('workspace.shell.execute', testCommand, 'Running the tests again.'),
  action('run.answer.create', {
    text: 'Created NOTES.md and fixed the off-by-one in src/range.mjs, so range now includes its end value. The test passes.',
  }),
]);

function pieces(text) {
  const size = Math.max(1, Math.ceil(text.length / 3));
  const parts = [];
  for (let index = 0; index < text.length; index += size) parts.push(text.slice(index, index + size));
  return parts;
}

// Replies may be strings or functions of the prompt. The first call reports usage and the rest
// leave it unreported, so both trace forms appear.
export function scriptedProvider(replies = demoReplies, { model = 'scripted/coding' } = {}) {
  const prompts = [];
  let index = 0;
  return {
    label: 'Scripted coding provider',
    defaultModel: model,
    prompts,
    async generate({ prompt, signal, onDelta }) {
      signal?.throwIfAborted();
      prompts.push(prompt);
      const next = replies[index];
      index += 1;
      const text = typeof next === 'function' ? next(prompt) : next ?? action('run.answer.create', { text: 'Out of script.' });
      for (const part of pieces(text)) {
        await nextTurn();
        signal?.throwIfAborted();
        onDelta?.(part);
      }
      return {
        text, complete: true, model,
        usage: index === 1 ? { input: 480, output: 24, total: 504, cacheRead: null, cacheWrite: null } : null,
      };
    },
  };
}
