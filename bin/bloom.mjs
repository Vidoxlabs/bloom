#!/usr/bin/env node
import { dependencyPinChecks } from '../src/cli/dependency-pins.mjs';

const [command, ...args] = process.argv.slice(2);
const pins = command === 'doctor' ? dependencyPinChecks() : [];
if (pins.some(row => row.detail === 'missing')) {
  if (args.includes('--json')) process.stdout.write(JSON.stringify(pins) + '\n');
  else for (const { check, status, detail } of pins) process.stdout.write(status + '  ' + check + '  ' + detail + '\n');
  process.exitCode = 1;
} else {
  await import('../src/cli/main.mjs');
}
