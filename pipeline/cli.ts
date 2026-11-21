// The pipeline's commands, called from engine/cli.ts.
//
//   sdd derive "<result>" [--source <folder or address>]... [--budget-usd 5] [--project <id>]
//   sdd show [<project>]

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createClaudeAgent, type AgentRunner } from './agent.ts';
import { approve, requireApproval } from './approve.ts';
import { DEFAULT_DERIVE_BUDGET_USD, derive } from './derive.ts';
import { designSpend, mockVerdict, runDesignLoop, scoreMock } from './designloop.ts';
import { parseLedger } from './facts.ts';
import { parsePipelineSpec } from './spec.ts';
import { createLLM } from '../runner/llm/index.ts';
import type { LLM } from '../runner/llm/types.ts';
import { layout, logCost, projectId, projectsRoot } from './project.ts';

export const DERIVE_USAGE = 'Usage: sdd derive "<the result you want, in one sentence>" [--source <folder or address>]... [--budget-usd 5] [--project <id>]';

export interface PipelineCliDeps {
  agent?: AgentRunner;
  log?: (line: string) => void;
  logError?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

export async function deriveCommand(args: string[], deps: PipelineCliDeps = {}): Promise<number> {
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        source: { type: 'string', multiple: true },
        'budget-usd': { type: 'string', default: String(DEFAULT_DERIVE_BUDGET_USD) },
        project: { type: 'string' },
      },
    });
  } catch (err) {
    logError((err as Error).message);
    logError(DERIVE_USAGE);
    return 2;
  }
  const result = parsed.positionals.join(' ').trim();
  const budgetUsd = Number(parsed.values['budget-usd']);
  if (result.length < 10 || !(budgetUsd > 0)) {
    logError(DERIVE_USAGE);
    return 2;
  }
  // A folder is given to the deriver to read. Anything else is passed as it is, an address to look up.
  const sources = (parsed.values.source ?? []).map((s) => (/^[a-z]+:\/\//i.test(s) ? s : path.resolve(s)));
  const id = parsed.values.project ?? projectId(result);
  const projectRoot = path.join(projectsRoot(deps.env), id);

  log(`Project: ${id}`);
  log(`Result:  ${result}`);
  try {
    const outcome = await derive({ result, sources, projectRoot, budgetUsd, agent: deps.agent ?? createClaudeAgent(), log });
    const working = outcome.spec.personas.filter((p) => !p.holdout).length;
    log('');
    log(`Derived: ${working} people and ${outcome.spec.personas.length - working} held back, ${outcome.spec.stages.length} stages, ${outcome.spec.assumptions.length} assumptions, ${outcome.ledger.facts.length} facts in the ledger.`);
    log(`Cost at list prices: $${outcome.costUsd.toFixed(2)} (${outcome.attempts} attempt${outcome.attempts === 1 ? '' : 's'})`);
    log(`Read it: ${outcome.layout.derivedSpec}`);
    log('Nothing has been simulated or built. Approve the spec before anything else runs.');
    return 0;
  } catch (err) {
    logError(`Deriving failed: ${(err as Error).message}`);
    return 1;
  }
}

/** sdd revise <project> "<what the owner wants changed>" */
export async function reviseCommand(args: string[], deps: PipelineCliDeps = {}): Promise<number> {
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { 'budget-usd': { type: 'string', default: String(DEFAULT_DERIVE_BUDGET_USD) }, file: { type: 'string' } } });
  } catch (err) {
    logError((err as Error).message);
    return 2;
  }
  const [id, ...rest] = parsed.positionals;
  const corrections = parsed.values.file ? await readFile(parsed.values.file, 'utf8').catch(() => '') : rest.join(' ');
  const budgetUsd = Number(parsed.values['budget-usd']);
  if (!id || corrections.trim().length < 10 || !(budgetUsd > 0)) {
    logError('Usage: sdd revise <project> "<what to change>" [--file <corrections.md>] [--budget-usd 5]');
    return 2;
  }
  const projectRoot = path.join(projectsRoot(deps.env), id);
  const l = layout(projectRoot);
  try {
    const result = (await readFile(l.resultFile, 'utf8')).trim();
    const sources = JSON.parse(await readFile(path.join(l.evidence, 'sources.json'), 'utf8').catch(() => '[]')) as string[];
    const outcome = await derive({ result, sources, projectRoot, budgetUsd, corrections, agent: deps.agent ?? createClaudeAgent(), log });
    log(`Revised. Cost at list prices: $${outcome.costUsd.toFixed(2)}. Any earlier approval no longer applies.`);
    log(`Read it: ${outcome.layout.derivedSpec}`);
    return 0;
  } catch (err) {
    logError(`Revising failed: ${(err as Error).message}`);
    return 1;
  }
}

/** sdd approve <project> --budget-usd <n> [--note "..."]. Run by the owner, or on the owner's word. */
export async function approveCommand(args: string[], deps: PipelineCliDeps = {}): Promise<number> {
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { 'budget-usd': { type: 'string' }, note: { type: 'string' } } });
  } catch (err) {
    logError((err as Error).message);
    return 2;
  }
  const id = parsed.positionals[0];
  const budgetUsd = Number(parsed.values['budget-usd']);
  if (!id || !(budgetUsd > 0)) {
    logError('Usage: sdd approve <project> --budget-usd <cap on simulation spend> [--note "..."]');
    return 2;
  }
  try {
    const approval = await approve(layout(path.join(projectsRoot(deps.env), id)), { budgetUsd, note: parsed.values.note });
    log(`Approved ${approval.hash.slice(0, 12)} with a simulation budget of $${approval.budgetUsd.toFixed(2)}.`);
    log('If the spec, the personas or the ledger change, this approval stops applying.');
    return 0;
  } catch (err) {
    logError((err as Error).message);
    return 1;
  }
}

/** sdd design <project> [--iterations 6] [--runs 4] [--try 5] */
export async function designCommand(args: string[], deps: PipelineCliDeps & { llm?: LLM } = {}): Promise<number> {
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { iterations: { type: 'string', default: '6' }, runs: { type: 'string', default: '4' }, try: { type: 'string', default: '5' }, from: { type: 'string' }, rescore: { type: 'boolean', default: false } } });
  } catch (err) {
    logError((err as Error).message);
    return 2;
  }
  const id = parsed.positionals[0];
  if (!id) {
    logError('Usage: sdd design <project> [--iterations 6] [--runs 4] [--try 5] [--from <design number> [--rescore]]');
    return 2;
  }
  const l = layout(path.join(projectsRoot(deps.env), id));
  try {
    const spec = parsePipelineSpec(JSON.parse(await readFile(l.specFile, 'utf8')));
    const ledger = parseLedger(JSON.parse(await readFile(l.factsFile, 'utf8')));
    // --from <n>: carry on from design n. New designs are numbered after the last one already made.
    const resumeFrom = parsed.values.from === undefined ? undefined : Number(parsed.values.from);
    const made = (await readdir(l.design).catch(() => [] as string[])).map((d) => Number(d.match(/^iter-(\d+)$/)?.[1])).filter((n) => !Number.isNaN(n));
    const startAt = made.length > 0 ? Math.max(...made) + 1 : 0;
    // The owner's own places and the repository folders, for the guardrails.
    const rules = await readFile(path.join(path.dirname(l.referee), 'rules.json'), 'utf8').then((t) => JSON.parse(t) as { ownPlaces?: string[] }, () => ({} as { ownPlaces?: string[] }));
    const sources = await readFile(path.join(l.evidence, 'sources.json'), 'utf8').then((t) => JSON.parse(t) as string[], () => [] as string[]);
    const sourceDirs = sources.filter((x) => !/^https?:/.test(x)).map((x) => path.resolve(x.replace(/^~(?=\/)/, process.env.HOME ?? '~')));
    const result = await runDesignLoop({
      agent: deps.agent ?? createClaudeAgent(), sourceDirs, ownPlaces: rules.ownPlaces ?? [],
      layout: l, spec, ledger, llm: deps.llm ?? createLLM(), log,
      maxIterations: Number(parsed.values.iterations), runs: Number(parsed.values.runs), tryCount: Number(parsed.values.try),
      ...(resumeFrom === undefined ? {} : { resumeFrom, startAt, rescoreFirst: parsed.values.rescore }),
    });
    await writeFile(path.join(l.evidence, resumeFrom === undefined ? 'design-loop.json' : `design-loop-from-${resumeFrom}.json`), JSON.stringify({ ...result, best: result.best && { iteration: result.best.iteration, verdict: result.best.verdict, dir: result.best.dir } }, null, 2) + '\n');
    log('');
    log(`Stopped: ${result.stop}. Spent $${result.spentUsd.toFixed(2)} at list prices.`);
    for (const it of result.iterations) log(`  design ${it.iteration}: ${it.outcome}${it.verdict ? `, ${it.verdict}, shortfall ${it.shortfall?.toFixed(2)}` : ''}`);
    if (result.best) log(`Best: design ${result.best.iteration} (${result.best.verdict}) at ${result.best.dir}`);
    return 0;
  } catch (err) {
    logError(`Design failed: ${(err as Error).message}`);
    return 1;
  }
}

/**
 * Score a page that the pipeline did not design, such as the site as it stands
 * today, with the same people, questions and clean machines. The page is
 * served from a local folder. It is a reference point and never feeds the designer.
 */
export async function scoreCommand(args: string[], deps: PipelineCliDeps & { llm?: LLM } = {}): Promise<number> {
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  const usage = 'Usage: sdd score <project> --page <folder with index.html> --name <label> [--runs 4] [--try 5]';
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { page: { type: 'string' }, name: { type: 'string' }, runs: { type: 'string', default: '4' }, try: { type: 'string', default: '5' } } });
  } catch (err) {
    logError((err as Error).message);
    return 2;
  }
  const id = parsed.positionals[0];
  const { page, name } = parsed.values;
  if (!id || !page || !name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    logError(usage);
    return 2;
  }
  const l = layout(path.join(projectsRoot(deps.env), id));
  try {
    const approval = await requireApproval(l);
    const spec = parsePipelineSpec(JSON.parse(await readFile(l.specFile, 'utf8')));
    const left = approval.budgetUsd - (await designSpend(l));
    if (left <= 0.5) {
      logError('The approved budget is spent.');
      return 3;
    }
    const runs = Number(parsed.values.runs);
    const tryCount = Number(parsed.values.try);
    const evidenceDir = path.join(l.evidence, 'score', name);
    const ledger = parseLedger(JSON.parse(await readFile(l.factsFile, 'utf8')));
    const score = await scoreMock({ layout: l, spec, mockDir: path.resolve(page), evidenceDir, runs, tryCount, budgetUsd: left, llm: deps.llm ?? createLLM(), ledger, log });
    await logCost(l, { step: 'design', what: `simulation, page "${name}"`, usd: score.costUsd, durationMs: 0, detail: { runs, tryCount } });
    const verdict = mockVerdict(score);
    await writeFile(path.join(evidenceDir, 'score.json'), JSON.stringify({ name, page: path.resolve(page), runs, tryCount, verdict, score }, null, 2) + '\n');
    log('');
    log(`${name}: ${verdict}. Cost $${score.costUsd.toFixed(2)} at list prices.`);
    for (const q of score.questions) log(`  ${q.stage}/${q.id}: seen ${q.working.passed}/${q.working.n}, held back ${q.holdout.passed}/${q.holdout.n}, needs ${Math.round(q.threshold * 100)}%`);
    if (score.tried) log(`  ${score.tried.stage}: ${score.tried.interval.passed}/${score.tried.interval.n}, needs ${Math.round(score.tried.threshold * 100)}%`);
    for (const n of score.notRun) log(`  ${n.stage}: not run (${n.why})`);
    return 0;
  } catch (err) {
    logError(`Scoring failed: ${(err as Error).message}`);
    return 1;
  }
}

export async function showCommand(args: string[], deps: PipelineCliDeps = {}): Promise<number> {
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  const root = projectsRoot(deps.env);
  const id = args[0];
  if (!id) {
    const ids = (await readdir(root).catch(() => [] as string[])).sort();
    if (ids.length === 0) log('No projects yet. Start one with: sdd derive "<the result you want>"');
    for (const name of ids) log(name);
    return 0;
  }
  try {
    log(await readFile(layout(path.join(root, id)).derivedSpec, 'utf8'));
    return 0;
  } catch {
    logError(`No derived spec for project "${id}" under ${root}`);
    return 1;
  }
}
