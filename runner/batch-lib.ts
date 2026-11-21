// Runs a batch of graded reader runs. Used by the batch command line and by
// the automated loop.
//
// Safe to call again with the same batch id: runs that already have a trace
// are skipped. Stops starting new runs when the budget is spent (hard rule 6).

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gradeTrace } from '../judge/judge.ts';
import type { LLM } from './llm/types.ts';
import { runReader } from './reader/run.ts';
import { runVisitor } from './visitor/run.ts';
import { runTalker } from './talker/run.ts';
import { assertLoopback, loadWorld } from './talker/world.ts';
import { startSandbox } from './sandbox/sandbox.ts';
import { loadPersona, type Persona, type Spec } from './spec.ts';
import { validateTrace, writeTrace, type Trace } from './trace.ts';

export interface BatchOptions {
  repoRoot: string;
  spec: Spec;
  batch: string;
  /** Page under test, relative to the repo root. Default: spec.page. */
  pagePath?: string;
  /** Test an app already running on this machine in place of a file, e.g. http://localhost:5123. */
  targetOrigin?: string;
  /** Path to open on the target. Default: /. */
  entryPath?: string;
  sets: ('working' | 'holdout')[];
  /** Restrict to these persona ids. Default: all in the chosen sets. */
  personaIds?: string[];
  viewports: string[];
  /** Seeds 1..runs for every persona and viewport. */
  runs: number;
  concurrency: number;
  budgetUsd: number;
  /** "block" stops and lists outside requests without failing the batch. Default: "fail". */
  outsideRequests?: 'fail' | 'block';
  llm: LLM;
  log?: (line: string) => void;
}

export interface BatchResult {
  /** Every trace in the batch for the chosen sets, old and new. */
  traces: Trace[];
  newRuns: number;
  failed: number;
  /** Cost of the new runs only, including failed attempts. */
  spentUsd: number;
  budgetHit: boolean;
  /** Outside origins the app asked for and was refused, with how often. Empty unless outsideRequests is "block". */
  blocked: { origin: string; count: number }[];
}

/** Collapse refused URLs to their origins, most frequent first. */
export function blockedOrigins(urls: string[]): { origin: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const url of urls) {
    let origin = url;
    try {
      const parsed = new URL(url).origin;
      if (parsed !== 'null') origin = parsed;
    } catch { /* keep the raw value, such as a CONNECT host:port */ }
    counts.set(origin, (counts.get(origin) ?? 0) + 1);
  }
  return [...counts]
    .map(([origin, count]) => ({ origin, count }))
    .sort((a, b) => b.count - a.count || a.origin.localeCompare(b.origin));
}

export async function loadPersonaSet(repoRoot: string, dir: string): Promise<Persona[]> {
  const files = (await readdir(path.resolve(repoRoot, dir))).filter((f) => f.endsWith('.yaml')).sort();
  return Promise.all(files.map((f) => loadPersona(path.resolve(repoRoot, dir, f))));
}

export async function loadBatchTraces(repoRoot: string, experiment: string, batch: string): Promise<Trace[]> {
  const dir = path.join(repoRoot, 'traces', experiment);
  const traces: Trace[] = [];
  for (const file of (await readdir(dir).catch(() => [] as string[])).sort()) {
    if (!file.endsWith('.json')) continue;
    const trace = JSON.parse(await readFile(path.join(dir, file), 'utf8')) as Trace;
    if (trace.batch === batch) traces.push(trace);
  }
  return traces;
}

export async function runBatch(options: BatchOptions): Promise<BatchResult> {
  const { repoRoot, spec, batch, llm } = options;
  const log = options.log ?? console.log;
  const pagePath = options.targetOrigin ? undefined : (options.pagePath ?? spec.page);
  if (!options.targetOrigin && !pagePath) throw new Error('The spec names no page and no target was given');
  const label = options.targetOrigin ? `${options.targetOrigin}${options.entryPath ?? '/'}` : pagePath!;
  const questionIds = spec.questions.map((q) => q.id);
  const tracesDir = path.join(repoRoot, 'traces');

  let personas: { set: 'working' | 'holdout'; persona: Persona }[] = [];
  for (const set of options.sets) {
    const loaded = await loadPersonaSet(repoRoot, set === 'working' ? spec.personas.working : spec.personas.holdout);
    personas.push(...loaded.map((persona) => ({ set, persona })));
  }
  if (options.personaIds) personas = personas.filter((p) => options.personaIds!.includes(p.persona.id));

  const key = (personaId: string, viewport: string, seed: number) => `${personaId}|${viewport}|${seed}`;
  const existing = (await loadBatchTraces(repoRoot, spec.experiment, batch)).filter((t) => options.sets.includes(t.personaSet));
  const done = new Set(existing.map((t) => key(t.persona.id, t.viewport.name, t.seed)));

  interface Task { set: 'working' | 'holdout'; persona: Persona; viewport: string; seed: number }
  const tasks: Task[] = [];
  for (const { set, persona } of personas) {
    for (const viewport of options.viewports) {
      for (let seed = 1; seed <= options.runs; seed++) {
        if (!done.has(key(persona.id, viewport, seed))) tasks.push({ set, persona, viewport, seed });
      }
    }
  }
  log(`Batch "${batch}" on ${label}: ${personas.length} personas x ${options.viewports.length} viewports x ${options.runs} seeds`);
  log(`  ${done.size} already done, ${tasks.length} to run, budget $${options.budgetUsd.toFixed(2)}`);

  const traces = [...existing];
  let spent = 0, completed = 0, failed = 0, budgetHit = false, next = 0;
  if (tasks.length === 0) return { traces, newRuns: 0, failed: 0, spentUsd: 0, budgetHit: false, blocked: [] };

  // A conversation has no browser, so no sandbox: the adapter talks to the
  // target, and the target must be on this machine.
  const talking = spec.kind === 'conversation';
  if (talking && !options.targetOrigin) throw new Error('A conversation spec needs a running target');
  if (talking) assertLoopback(options.targetOrigin!);
  const loaded = talking ? await loadWorld(repoRoot, spec.talker!.adapter) : undefined;

  // A variant page is served at / with the site's own assets (fonts) around it.
  const sandbox = talking ? undefined : options.targetOrigin
    ? await startSandbox({ targetOrigin: options.targetOrigin, outsideRequests: options.outsideRequests })
    : await startSandbox({
        rootDir: path.dirname(path.resolve(repoRoot, spec.page ?? pagePath!)),
        indexFile: path.resolve(repoRoot, pagePath!),
        outsideRequests: options.outsideRequests,
      });

  async function worker() {
    while (next < tasks.length) {
      if (spent >= options.budgetUsd) { budgetHit = true; return; }
      const task = tasks[next++]!;
      try {
        let trace: Trace;
        if (talking) {
          // The engine grades the outcome from what the product did and, for a prose outcome, its own judge call.
          trace = await runTalker({
            spec, persona: task.persona, personaSet: task.set, seed: task.seed,
            world: loaded!.world, worldFile: loaded!.file, target: options.targetOrigin!, llm, batch,
          });
          spent += trace.cost.usd;
        } else if (spec.kind === 'task') {
          // Visitors act on the app. The engine grades the outcome itself, so no judge call.
          trace = await runVisitor({
            repoRoot, spec, persona: task.persona, personaSet: task.set,
            viewport: task.viewport, seed: task.seed, sandbox: sandbox!, llm, batch, entryPath: options.entryPath,
          });
          spent += trace.cost.usd;
        } else {
          const ungraded = await runReader({
            repoRoot, spec, persona: task.persona, personaSet: task.set,
            viewport: task.viewport, seed: task.seed, sandbox: sandbox!, llm, batch, pagePath, entryPath: options.entryPath,
          });
          spent += ungraded.cost.usd; // count the persona call even if judging fails
          trace = await gradeTrace(llm, spec.questions, ungraded);
          spent += trace.cost.usd - ungraded.cost.usd;
        }
        validateTrace(trace, questionIds);
        await writeTrace(tracesDir, trace);
        traces.push(trace);
        completed++;
      } catch (err) {
        failed++;
        log(`FAILED ${task.persona.id} ${task.viewport} seed ${task.seed}: ${String(err).slice(0, 900)}`);
      }
      const finished = completed + failed;
      if (finished % 40 === 0 || finished === tasks.length) log(`  ${finished}/${tasks.length} finished, ${failed} failed, $${spent.toFixed(2)} spent`);
    }
  }

  try {
    await Promise.all(Array.from({ length: options.concurrency }, worker));
  } finally {
    await sandbox?.finish(); // throws if any outside request was attempted
  }
  const blocked = options.outsideRequests === 'block'
    ? blockedOrigins((sandbox?.violations ?? []).map((v) => v.url))
    : [];
  return { traces, newRuns: completed, failed, spentUsd: spent, budgetHit, blocked };
}
