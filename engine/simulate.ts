// The engine's single entry point for a host product such as TurkeyCode.
//
//   sdd simulate --workdir <dir> --target http://localhost:PORT
//                --run <id> --budget-usd <n>
//                [--entry /path] [--runs n] [--concurrency 6]
//                [--outside-requests fail|block]
//
// The work directory holds everything for one app:
//
//   <workdir>/spec.yaml                    the simulation spec
//   <workdir>/personas/working/*.yaml      personas the builder may see
//   <workdir>/personas/holdout/*.yaml      personas held back
//
// The engine writes, under the same directory:
//
//   traces/<experiment>/*.json             one per persona run, never edited
//   shots/...                              screenshots the personas were shown
//   reports/<run>.json                     the result a product renders
//   reports/<run>.md                       the same, for a person to read
//
// Report only. It measures and reports. It changes nothing in the app.
// The target must be an app running on this machine. Every request to any
// other origin is blocked. By default one attempt fails the run. With
// --outside-requests block the run carries on and the report lists what was
// refused, for apps that load fonts or scripts from elsewhere.
//
// Exit codes: 0 report written, 1 some runs failed or the engine hit an error
// (a report is written either way; an error gives verdict "incomplete"),
// 2 bad arguments, 3 budget reached (report covers the runs that finished).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { runBatch } from '../runner/batch-lib.ts';
import { createLLM } from '../runner/llm/index.ts';
import type { LLM } from '../runner/llm/types.ts';
import { loadSpec } from '../runner/spec.ts';
import { summarize, type SetSummary } from '../scorer/summary.ts';

export const USAGE =
  'Usage: sdd simulate --workdir <dir> --target http://localhost:PORT --run <id> --budget-usd <n> ' +
  '[--entry /path] [--runs n] [--concurrency n] [--outside-requests fail|block]';

export interface SimulateDeps {
  /** Swapped in tests. Default: the provider chosen by the environment. */
  llm?: LLM;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

/** Runs one simulation and returns the process exit code. */
export async function simulate(args: string[], deps: SimulateDeps = {}): Promise<number> {
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;

  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        workdir: { type: 'string' },
        target: { type: 'string' },
        entry: { type: 'string', default: '/' },
        run: { type: 'string' },
        runs: { type: 'string' },
        concurrency: { type: 'string', default: '6' },
        'budget-usd': { type: 'string' },
        'outside-requests': { type: 'string', default: 'fail' },
      },
    }));
  } catch (err) {
    logError(err instanceof Error ? err.message : String(err));
    logError(USAGE);
    return 2;
  }
  if (!values.workdir || !values.target || !values.run || !values['budget-usd']) {
    logError(USAGE);
    return 2;
  }
  const outsideRequests = values['outside-requests'];
  if (outsideRequests !== 'fail' && outsideRequests !== 'block') {
    logError('--outside-requests must be "fail" or "block"');
    return 2;
  }

  const run = values.run;
  const target = `${values.target}${values.entry}`;
  const workDir = path.resolve(values.workdir);
  const outDir = path.join(workDir, 'reports');
  const reportFile = path.join(outDir, `${run}.json`);
  const startedAt = new Date().toISOString();

  try {
    const specFile = path.join(workDir, 'spec.yaml');
    const spec = await loadSpec(specFile);
    // Inside a work directory the persona folders are fixed. The spec cannot point elsewhere.
    spec.personas = { ...spec.personas, working: 'personas/working', holdout: 'personas/holdout' };
    const rawPass = (parse(await readFile(specFile, 'utf8')) as { pass?: Record<string, number> }).pass ?? {};
    const thresholds: Record<string, number> = {};
    for (const q of spec.questions) {
      const t = Number(rawPass[`${q.id}_rate`]);
      if (!(t > 0 && t <= 1)) throw new Error(`spec.yaml: pass.${q.id}_rate must be a number between 0 and 1`);
      thresholds[q.id] = t;
    }

    const result = await runBatch({
      repoRoot: workDir,
      spec,
      batch: run,
      targetOrigin: values.target,
      entryPath: values.entry,
      sets: ['working', 'holdout'],
      viewports: spec.entry.viewports,
      runs: Number(values.runs ?? spec.personas.runs_per_persona),
      concurrency: Number(values.concurrency),
      budgetUsd: Number(values['budget-usd']),
      outsideRequests,
      llm: deps.llm ?? createLLM(),
      log,
    });

    const working = summarize(spec, thresholds, result.traces, 'working');
    const holdout = summarize(spec, thresholds, result.traces, 'holdout');
    const complete = result.failed === 0 && !result.budgetHit;
    const costUsd = result.traces.reduce((sum, t) => sum + t.cost.usd, 0);
    const calibrated = result.traces.length > 0 && result.traces.every((t) => t.dials.calibrated);

    // "pass" needs every lower bound to clear on both sets. Anything else is
    // reported as it is: not met, or not enough runs to say.
    const verdict =
      !complete ? 'incomplete'
      : working.met && holdout.met ? 'pass'
      : [...working.questions, ...holdout.questions].some((q) => q.verdict === 'not met') ? 'not met'
      : 'inside the noise';

    /** Holdout detail stays out of anything a builder might read: rates only. */
    const strip = (s: SetSummary) =>
      s.set === 'working'
        ? s
        : { set: s.set, runs: s.runs, questions: s.questions, shortfall: s.shortfall, minMargin: s.minMargin, met: s.met, ratesClear: s.ratesClear };

    const report = {
      schema: 'sdd-report/1',
      run,
      experiment: spec.experiment,
      goal: spec.goal,
      target,
      startedAt,
      finishedAt: new Date().toISOString(),
      verdict,
      calibrated,
      runs: { completed: result.traces.length, failed: result.failed, budgetHit: result.budgetHit },
      costUsd: Math.round(costUsd * 10000) / 10000,
      blockedRequests: result.blocked,
      page: result.traces[0]?.page,
      questions: spec.questions.map((q) => ({ id: q.id, ask: q.ask })),
      working: strip(working),
      holdout: strip(holdout),
    };

    const pct = (x: number) => (Number.isNaN(x) ? 'n/a' : `${Math.round(x * 100)}%`);
    const table = (s: SetSummary) =>
      ['| Question | Passed | 95% interval | Threshold | Verdict |', '|---|---|---|---|---|',
        ...s.questions.map((q) => `| ${q.id} | ${pct(q.interval.rate)} (${q.interval.passed}/${q.interval.n}) | ${pct(q.interval.lower)} to ${pct(q.interval.upper)} | ${pct(q.threshold)} | ${q.verdict} |`)].join('\n');
    const blockedLine = result.blocked.length === 0
      ? ''
      : `- Outside requests refused, so visitors saw the app without them: ${result.blocked.map((b) => `${b.origin} (${b.count})`).join(', ')}\n`;
    const md = `# Simulation report: ${spec.experiment}, run "${run}"

**Verdict: ${verdict}.** A threshold is met only when the low end of its 95% interval clears it, for both the working readers and the held-back readers.
${calibrated ? '' : '\n**Not calibrated.** These are simulated visitors that have not been checked against real ones. The scores compare versions of this page with each other. They are not a prediction about real visitors.\n'}
- Goal: ${spec.goal.trim()}
- Target: ${target}
- Runs: ${result.traces.length} completed, ${result.failed} failed${result.budgetHit ? ', stopped by the budget' : ''}
- Cost at list prices: $${costUsd.toFixed(2)}
${blockedLine}
## Working readers

${table(working)}

## Held-back readers

${table(holdout)}

## What readers missed most

${working.missedElements.map((m) => `- ${m.question}: "${m.element}" missed by ${pct(m.missedRate)}`).join('\n')}

## Where readers were when time ran out

${Object.entries(working.stoppedIn).map(([name, x]) => `- ${name}: ${pct(x)}`).join('\n')}

## A sample of failing answers

${working.failingAnswers.map((f) => `- [${f.question}] ${f.answer}\n  - Judge: ${f.judgeNote}`).join('\n')}
`;

    await mkdir(outDir, { recursive: true });
    await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
    await writeFile(path.join(outDir, `${run}.md`), md);
    log(`Verdict: ${verdict}. Report: ${reportFile}`);
    return result.budgetHit ? 3 : result.failed > 0 ? 1 : 0;
  } catch (err) {
    // Exit 1 always leaves a report, so a host never has to guess what happened.
    const raw = err instanceof Error ? err.message : String(err);
    // Playwright's own advice ("npx playwright install") can fetch a build
    // that does not match this engine. Point at the command that does.
    const error = /Executable doesn't exist/.test(raw)
      ? `The browser the engine drives is not installed. Run: sdd setup\n(${raw.split('\n')[0]})`
      : raw;
    const empty = (set: 'working' | 'holdout') => ({ set, runs: 0, questions: [], met: false });
    const report = {
      schema: 'sdd-report/1',
      run,
      target,
      startedAt,
      finishedAt: new Date().toISOString(),
      verdict: 'incomplete',
      calibrated: false,
      error,
      runs: { completed: 0, failed: 0, budgetHit: false },
      costUsd: 0,
      blockedRequests: [],
      questions: [],
      working: empty('working'),
      holdout: empty('holdout'),
    };
    await mkdir(outDir, { recursive: true });
    await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
    await writeFile(
      path.join(outDir, `${run}.md`),
      `# Simulation report: run "${run}"\n\n**Verdict: incomplete.** The engine stopped before any result could be scored.\n\n    ${error.split('\n').join('\n    ')}\n`,
    );
    logError(`Simulation failed: ${error}`);
    logError(`Report: ${reportFile}`);
    return 1;
  }
}
