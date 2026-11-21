// Regrades the stored answers of a batch with the current judge.
//
//   node judge/regrade.ts --batch <id> --label <name> --budget-usd <n> [--concurrency 6]
//
// Traces are never edited. Each regrade is written next to them, to
// grades/<experiment>/<batch>/<label>/<runId>.json, with the judge's full
// prompts and replies. The scorer reads them with --grades <label>.
// Safe to rerun: runs already regraded under the label are skipped.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createLLM } from '../runner/llm/index.ts';
import { loadSpec } from '../runner/spec.ts';
import type { Trace } from '../runner/trace.ts';
import { JUDGE_VERSION, judgeAnswers } from './judge.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const { values } = parseArgs({
  options: {
    spec: { type: 'string', default: 'specs/sdd-site.spec.yaml' },
    batch: { type: 'string' },
    label: { type: 'string' },
    concurrency: { type: 'string', default: '6' },
    'budget-usd': { type: 'string' },
  },
});
if (!values.batch || !values.label || !values['budget-usd']) {
  console.error('Usage: node judge/regrade.ts --batch <id> --label <name> --budget-usd <n> [--concurrency n]');
  process.exit(2);
}
const budgetUsd = Number(values['budget-usd']);
const spec = await loadSpec(path.resolve(repoRoot, values.spec));
const tracesDir = path.join(repoRoot, 'traces', spec.experiment);
const outDir = path.join(repoRoot, 'grades', spec.experiment, values.batch, values.label);
await mkdir(outDir, { recursive: true });
const done = new Set(await readdir(outDir));

const todo: Trace[] = [];
for (const file of (await readdir(tracesDir)).sort()) {
  if (!file.endsWith('.json') || done.has(file)) continue;
  const trace = JSON.parse(await readFile(path.join(tracesDir, file), 'utf8')) as Trace;
  if (trace.batch === values.batch) todo.push(trace);
}
console.log(`Regrade "${values.label}" of batch "${values.batch}" with judge ${JUDGE_VERSION}: ${done.size} done, ${todo.length} to do`);

const llm = createLLM();
let next = 0, finished = 0, failed = 0, spent = 0, budgetHit = false;
async function worker() {
  while (next < todo.length) {
    if (spent >= budgetUsd) { budgetHit = true; return; }
    const trace = todo[next++]!;
    try {
      const { grades, calls } = await judgeAnswers(llm, spec.questions, trace.answers);
      const costUsd = calls.reduce((s, c) => s + c.response.costUsd, 0);
      spent += costUsd;
      await writeFile(
        path.join(outDir, `${trace.runId}.json`),
        JSON.stringify({ runId: trace.runId, batch: trace.batch, label: values.label, judgeVersion: JUDGE_VERSION, grades, llmCalls: calls, costUsd }, null, 2) + '\n',
        { flag: 'wx' },
      );
    } catch (err) {
      failed++;
      console.error(`FAILED ${trace.runId}: ${String(err).slice(0, 500)}`);
    }
    if (++finished % 40 === 0 || finished === todo.length) console.log(`  ${finished}/${todo.length}, ${failed} failed, $${spent.toFixed(2)}`);
  }
}
await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));
console.log(`Done: ${finished - failed} regraded, ${failed} failed, $${spent.toFixed(2)} spent`);
if (budgetHit) { console.error(`STOPPED: budget of $${budgetUsd.toFixed(2)} reached.`); process.exit(3); }
if (failed > 0) process.exit(1);
