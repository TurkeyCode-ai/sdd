#!/usr/bin/env node
// The `sdd` command.
//
//   sdd simulate ...   run simulated visitors against a local app and write a report
//   sdd setup          download the browser the engine drives
//   sdd --version
//   sdd --help

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { approveCommand, deriveCommand, reviseCommand, showCommand } from '../pipeline/cli.ts';
import { simulate, USAGE } from './simulate.ts';

const HELP = `sdd: Simulation Driven Development engine

  sdd simulate --workdir <dir> --target http://localhost:PORT --run <id> --budget-usd <n>
               [--entry /path] [--runs n] [--concurrency n] [--outside-requests fail|block]
  sdd setup        download the browser the engine drives (once, after installing)
  sdd --version

  sdd derive "<the result you want>" [--source <folder or address>]... [--budget-usd 5]
                   turn one sentence into a spec: who it is for, what counts as
                   success, thresholds, held-back people, assumptions, and a
                   ledger of true claims. Nothing is simulated or built.
  sdd revise <project> "<what to change>"   the owner's corrections, applied by the deriver
  sdd approve <project> --budget-usd <n>    the owner approves this exact spec
  sdd show [<project>]   list projects, or print one project's derived spec

The work directory holds spec.yaml, personas/working/*.yaml and
personas/holdout/*.yaml. The report is written to <workdir>/reports/<run>.json
and .md. The target must be an app running on this machine; nothing outside it
is ever reached.

Exit codes: 0 report written, 1 runs failed or the engine hit an error (the
report says which), 2 bad arguments, 3 budget reached.

Needs: Node 24 or later, the browser from "sdd setup", and the claude CLI
logged in.`;

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
} else if (command === 'setup') {
  // Download the browser build this engine's own Playwright expects. Running
  // "npx playwright install" from somewhere else can fetch a different build.
  const playwrightCli = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
  const result = spawnSync(process.execPath, [playwrightCli, 'install', 'chromium'], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
} else if (command === 'simulate') {
  // exit() and not exitCode: a browser or child process that is slow to close must not hold the command open.
  process.exit(await simulate(rest));
} else if (command === 'derive') {
  process.exit(await deriveCommand(rest));
} else if (command === 'revise') {
  process.exit(await reviseCommand(rest));
} else if (command === 'approve') {
  process.exit(await approveCommand(rest));
} else if (command === 'show') {
  process.exit(await showCommand(rest));
} else if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
  console.log(HELP);
} else {
  console.error(`Unknown command: ${command}`);
  console.error(USAGE);
  process.exitCode = 2;
}
