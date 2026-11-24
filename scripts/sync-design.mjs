import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const input = process.argv[2];
if (!input) throw new Error('Pass the path to the CSS emitted by videsign.');
const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const used = [...new Set([...styles.matchAll(/var\((--vi-[\w-]+)\)/g)].map(match => match[1]))].sort();
const source = readFileSync(input, 'utf8');
const declarations = new Map([...source.matchAll(/^\s*(--vi-[\w-]+):\s*([^;]+);/gm)].map(match => [match[1], match[2]]));
const lines = used.map(key => {
  if (!declarations.has(key)) throw new Error('Unresolved design token ' + key);
  return '  ' + key + ': ' + declarations.get(key) + ';';
});
const css = '/* Bloom theme. Generated from the videsign properties used by this application. */\n:root {\n' + lines.join('\n') + '\n}\n';
const target = fileURLToPath(new URL('../public/tokens.css', import.meta.url));
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== css) throw new Error('Bloom’s theme differs from the supplied design definitions.');
} else writeFileSync(target, css);
console.log(used.length + ' videsign properties verified.');
