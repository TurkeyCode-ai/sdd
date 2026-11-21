// A pipeline project: one result, and everything derived from it.
//
// The folder is split by who may touch what. The split is the rule that keeps
// the simulation honest: whoever designs or builds must never be able to edit
// the referee or read the held-back personas.
//
//   <project>/
//     referee/    result.txt, spec.yaml, personas/working, personas/holdout
//                 Written only by the deriver. Never shown to a designer or builder.
//     brief/      facts.yaml (the claims ledger) and, later, working-set results.
//                 The only thing a designer or builder is given.
//     design/     mocks, one folder per iteration.
//     evidence/   traces, reports and the cost log. Written by the engine and the pipeline.
//     scratch/    where an agent session runs. Emptied before each session.
//     derived-spec.md   the spec in plain language, for the owner to approve.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export interface ProjectLayout {
  root: string;
  referee: string;
  brief: string;
  design: string;
  evidence: string;
  scratch: string;
  resultFile: string;
  specFile: string;
  personasWorking: string;
  personasHoldout: string;
  factsFile: string;
  costLog: string;
  derivedSpec: string;
}

/** Where projects live: outside any repository. Override with SDD_HOME. */
export function projectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.SDD_HOME?.trim() || path.join(homedir(), '.sdd'), 'projects');
}

/** A readable, stable id: the first words of the result, plus a hash of all of it. */
export function projectId(result: string): string {
  const words = result.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w.length > 2).slice(0, 5).join('-');
  const hash = createHash('sha256').update(result.trim()).digest('hex').slice(0, 8);
  return `${words || 'project'}-${hash}`.slice(0, 60);
}

export function layout(root: string): ProjectLayout {
  const referee = path.join(root, 'referee');
  const brief = path.join(root, 'brief');
  const evidence = path.join(root, 'evidence');
  return {
    root,
    referee,
    brief,
    design: path.join(root, 'design'),
    evidence,
    scratch: path.join(root, 'scratch'),
    resultFile: path.join(referee, 'result.txt'),
    specFile: path.join(referee, 'spec.yaml'),
    personasWorking: path.join(referee, 'personas', 'working'),
    personasHoldout: path.join(referee, 'personas', 'holdout'),
    factsFile: path.join(brief, 'facts.yaml'),
    costLog: path.join(evidence, 'cost.jsonl'),
    derivedSpec: path.join(root, 'derived-spec.md'),
  };
}

export async function createProject(root: string): Promise<ProjectLayout> {
  const l = layout(root);
  for (const dir of [l.referee, l.brief, l.design, l.evidence, l.scratch]) await mkdir(dir, { recursive: true });
  return l;
}

/** A fresh, empty folder for one agent session. */
export async function freshScratch(l: ProjectLayout, name: string): Promise<string> {
  const dir = path.join(l.scratch, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

export interface CostEntry {
  at: string;
  step: string;
  /** Which agent or engine run this was. */
  what: string;
  usd: number;
  durationMs: number;
  detail?: Record<string, unknown>;
}

/** Every run's cost is appended here. Nothing is ever rewritten. */
export async function logCost(l: ProjectLayout, entry: Omit<CostEntry, 'at'>): Promise<void> {
  await mkdir(l.evidence, { recursive: true });
  await writeFile(l.costLog, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { flag: 'a' });
}

export async function readCosts(l: ProjectLayout): Promise<CostEntry[]> {
  const text = await readFile(l.costLog, 'utf8').catch(() => '');
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as CostEntry);
}

export async function spentUsd(l: ProjectLayout): Promise<number> {
  return (await readCosts(l)).reduce((sum, e) => sum + e.usd, 0);
}

/** True when `file` is inside `dir`. Used to refuse writes that cross the split. */
export function isInside(dir: string, file: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
