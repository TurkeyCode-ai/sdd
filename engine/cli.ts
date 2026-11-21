#!/usr/bin/env node
// The `sdd` command.
//
//   sdd simulate ...   run simulated visitors against a local app and write a report
//   sdd --version
//   sdd --help

import { readFile } from 'node:fs/promises';
import { simulate, USAGE } from './simulate.ts';

const HELP = `sdd: Simulation Driven Development engine

  sdd simulate --workdir <dir> --target http://localhost:PORT --run <id> --budget-usd <n>
               [--entry /path] [--runs n] [--concurrency n] [--outside-requests fail|block]
  sdd --version

The work directory holds spec.yaml, personas/working/*.yaml and
personas/holdout/*.yaml. The report is written to <workdir>/reports/<run>.json
and .md. The target must be an app running on this machine; nothing outside it
is ever reached.

Exit codes: 0 report written, 1 runs failed or the engine hit an error (the
report says which), 2 bad arguments, 3 budget reached.

Needs: Node 24 or later, Playwright's Chromium (npx playwright install chromium),
and the claude CLI logged in.`;

async function version(): Promise<string> {
  // package.json sits one level above this file in the source tree and two
  // levels above it once built into dist/engine.
  for (const up of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(await readFile(new URL(up, import.meta.url), 'utf8')) as { name?: string; version?: string };
      if (pkg.version) return pkg.version;
    } catch { /* try the next location */ }
  }
  return 'unknown';
}

const [command, ...rest] = process.argv.slice(2);

if (command === '--version' || command === '-v') {
  console.log(await version());
} else if (command === 'simulate') {
  // exit() and not exitCode: a browser or child process that is slow to close must not hold the command open.
  process.exit(await simulate(rest));
} else if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
  console.log(HELP);
} else {
  console.error(`Unknown command: ${command}`);
  console.error(USAGE);
  process.exitCode = 2;
}
