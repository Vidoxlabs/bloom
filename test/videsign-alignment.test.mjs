import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const publicFiles = new URL('../public/', import.meta.url);
const rawColor = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![\w-])|\b(?:rgba?|hsla?|oklch)\s*\(/i;

test('web-consumers-use-videsign-token-colors', () => {
  const files = ['styles.css', ...readdirSync(publicFiles).filter(name => name.endsWith('.js'))];
  for (const file of files) assert.doesNotMatch(readFileSync(new URL(file, publicFiles), 'utf8'), rawColor, file);
  const css = readFileSync(new URL('styles.css', publicFiles), 'utf8');
  const tokens = readFileSync(new URL('tokens.css', publicFiles), 'utf8');
  for (const [, token] of css.matchAll(/var\((--[\w-]+)/g)) {
    assert.ok(token.startsWith('--vi-') && tokens.includes(token + ':'), token);
  }
});

test('terminal-renderer-does-not-name-ansi-colors', () => {
  const source = readFileSync(new URL('../src/cli/render/line.mjs', import.meta.url), 'utf8');
  const colors = /['"](?:black|red|green|yellow|blue|magenta|cyan|white|gray|grey)(?:Bright)?['"]|\bstyleText\b/;
  assert.doesNotMatch(source, colors);
});

// A class name the page adds needs a rule. Without one the markup renders unstyled
// while every assertion here still passes, which is how a half-finished alignment
// looks green. Adding a class to the client means adding a line to this list.
test('client-class-names-have-a-stylesheet-rule', () => {
  const css = readFileSync(new URL('styles.css', publicFiles), 'utf8');
  const classes = [
    'message', 'approval', 'plan', 'tools', 'hint',
    'tool-title', 'tool-name', 'step-state', 'tool-output',
    'tool-call-trace-card', 'output-viewer',
    'usage-budget-meter', 'usage-metric', 'usage-progress',
  ];
  for (const name of classes) assert.match(css, new RegExp('\\.' + name + '(?![\\w-])'), name);
  for (const state of ['running', 'stopping', 'failed', 'completed']) {
    assert.ok(css.includes(`.turn-state[data-state="${state}"]`), state);
  }
});

test('terminal-theme-keeps-labels-in-plain-and-ansi-modes', async () => {
  const { paintRole } = await import('../src/cli/render/theme.mjs');
  const status = paintRole('status-indicator-success-base', 'Completed', { isTTY: true }, {});
  assert.match(status, /\x1b\[[0-9;]+mCompleted/);
  assert.equal(paintRole('status-indicator-success-base', 'Completed', { isTTY: true }, { NO_COLOR: '' }), 'Completed');
  assert.equal(paintRole('status-indicator-warning-base', 'Stopping', { isTTY: true }, { TERM: 'dumb' }), 'Stopping');
  assert.equal(paintRole('surface-accent-violet-base', 'You', { isTTY: false }, {}), 'You');
});

test('web-usage-counts-and-diff-output-have-readable-roles', async () => {
  const { usageBudget, outputViewer } = await import('../public/coding-view.js');
  const dom = {
    createElement(tag) {
      return {
        tag, attributes: {}, children: [],
        setAttribute(key, value) { this.attributes[key] = value; },
        append(...child) { this.children.push(...child); },
        set innerHTML(_value) { assert.fail('Workspace output must remain text.'); },
      };
    },
  };
  const usage = usageBudget({ modelCalls: 2, modelLimit: 4, toolCalls: 1 }, dom);
  assert.equal(usage.attributes.role, 'region');
  assert.equal(usage.children.find(node => node.tag === 'progress').value, 2);
  const output = outputViewer('git diff', '<b>unchanged markup</b>', dom);
  assert.equal(output.attributes['aria-label'], 'Diff');
  assert.equal(output.children[1].children[0].textContent, '<b>unchanged markup</b>');
});
