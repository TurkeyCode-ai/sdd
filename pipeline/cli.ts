// The pipeline's commands, called from engine/cli.ts.
//
//   sdd derive "<result>" [--source <folder or address>]... [--budget-usd 5] [--project <id>]
//   sdd show [<project>]

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createClaudeAgent, type AgentRunner } from './agent.ts';
import { approve } from './approve.ts';
import { DEFAULT_DERIVE_BUDGET_USD, derive } from './derive.ts';
import { layout, projectId, projectsRoot } from './project.ts';

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
