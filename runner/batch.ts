// Batch command line: every persona, working and holdout, N seeds per
// viewport, each run graded by the judge.
//
//   node runner/batch.ts --batch <id> --budget-usd <n> [--page file | --target http://localhost:PORT [--entry /path]] [--runs 40]
//                        [--viewports mobile,desktop] [--personas all|id,id]
//                        [--sets working,holdout] [--concurrency 6] [--spec file]

import path from 'node:path';
import { parseArgs } from 'node:util';
import { runBatch } from './batch-lib.ts';
import { createLLM } from './llm/index.ts';
import { loadSpec } from './spec.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const { values } = parseArgs({
  options: {
    spec: { type: 'string', default: 'specs/sdd-site.spec.yaml' },
    batch: { type: 'string' },
    page: { type: 'string' },
    target: { type: 'string' },
    entry: { type: 'string' },
    runs: { type: 'string' },
    viewports: { type: 'string' },
    personas: { type: 'string', default: 'all' },
    sets: { type: 'string', default: 'working,holdout' },
    concurrency: { type: 'string', default: '6' },
    'budget-usd': { type: 'string' },
  },
});
if (!values.batch || !values['budget-usd']) {
  console.error('Usage: node runner/batch.ts --batch <id> --budget-usd <n> [--page file] [--runs n] [--viewports a,b] [--personas all|id,id] [--sets working,holdout] [--concurrency n]');
  process.exit(2);
}

const spec = await loadSpec(path.resolve(repoRoot, values.spec));
const result = await runBatch({
  repoRoot,
  spec,
  batch: values.batch,
  pagePath: values.page,
  targetOrigin: values.target,
  entryPath: values.entry,
  sets: values.sets.split(',') as ('working' | 'holdout')[],
  personaIds: values.personas === 'all' ? undefined : values.personas.split(','),
  viewports: (values.viewports ?? spec.entry.viewports.join(',')).split(','),
  runs: Number(values.runs ?? spec.personas.runs_per_persona),
  concurrency: Number(values.concurrency),
  budgetUsd: Number(values['budget-usd']),
  llm: createLLM(),
});

console.log(`Done: ${result.newRuns} new traces, ${result.failed} failed, $${result.spentUsd.toFixed(2)} spent on new runs`);
if (result.budgetHit) {
  console.error('STOPPED: budget reached. Some runs were not started.');
  process.exit(3);
}
if (result.failed > 0) {
  console.error('Some runs failed. Rerun the same command to retry only those.');
  process.exit(1);
}
