// Step 4: design on cheap mocks, score them, revise, and keep what improved.
//
// One iteration: the designer writes a static page, the guardrails check it,
// the engine sends the people through it (reading, then deciding), and a
// developer on a clean machine follows its instructions. A revision is kept
// only when the people the designer may see did better. The held-back people
// only ever decide whether a pass is real.

import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simulate } from '../engine/simulate.ts';
import type { LLM } from '../runner/llm/types.ts';
import { startStaticServer } from '../runner/sandbox/server.ts';
import { verdict as intervalVerdict, wilson, type Interval } from '../scorer/stats.ts';
import { requireApproval } from './approve.ts';
import type { Ledger } from './facts.ts';
import type { AgentRunner } from './agent.ts';
import { buildBrief, checkAgainstRepo, designMock, mechanicalProblems, ownPlaces, reviewClaims, visibleText } from './mock.ts';
import { freshScratch, logCost, readCosts, type ProjectLayout } from './project.ts';
import { agentStage } from './agentstage.ts';
import type { AgentStage, DecideStage, PipelineSpec, ReadStage, TryStage } from './spec.ts';
import { startContainer, tryStage, type Machine, type TryResult } from './try.ts';

// ---- Turning a stage into what the engine runs ----

/** Time spent waiting for the page is time not spent on it. */
const after = (seconds: number, loadSeconds: number, floor: number) => Math.max(floor, Math.round(seconds - loadSeconds));

export function engineReadSpec(stage: ReadStage, runs: number, loadSeconds = 0) {
  return {
    experiment: stage.id,
    kind: 'comprehension',
    goal: stage.goal,
    entry: { from: stage.entryFrom, viewports: stage.viewports },
    reader: { time_budget_seconds: after(stage.timeBudgetSeconds, loadSeconds, 5), answers_from: 'what_was_seen', may_scroll_back: false, screenshots: true },
    personas: { runs_per_persona: runs },
    questions: stage.questions.map((q) => ({ id: q.id, ask: q.ask, rubric: { required: q.required } })),
    pass: Object.fromEntries(stage.questions.map((q) => [`${q.id}_rate`, q.threshold])),
    budget: { iterations: 0 },
  };
}

export function engineDecideSpec(stage: DecideStage, runs: number, loadSeconds = 0) {
  const success: Record<string, string[]> = {};
  if (stage.success.leavesTo.length > 0) success.leaves_to = stage.success.leavesTo;
  if (stage.success.clicks.length > 0) success.clicks = stage.success.clicks;
  return {
    experiment: stage.id,
    kind: 'task',
    goal: stage.goal,
    entry: { from: stage.entryFrom, viewports: stage.viewports },
    // No instruction: nobody asked these visitors to do anything.
    task: { goal: stage.goal, success },
    visitor: { patience_seconds: after(stage.patienceSeconds, loadSeconds, 5), max_steps: 15, screenshots: true },
    personas: { runs_per_persona: runs },
    pass: { task_rate: stage.threshold },
    budget: { iterations: 0 },
  };
}

// ---- Scores ----

export interface QuestionScore {
  stage: string;
  id: string;
  ask: string;
  threshold: number;
  working: Interval;
  /** Rates only. Nothing else about the held-back people leaves the referee. */
  holdout: Interval;
  /** Working-set rate by screen size, for the phone-share sweep. */
  byViewport?: Record<string, number>;
}

export interface MockScore {
  questions: QuestionScore[];
  /** The try stage: how many developers got there. */
  tried?: { stage: string; threshold: number; interval: Interval; result: TryResult };
  /** Working-set detail per engine stage, for the designer's findings. */
  findings: string;
  costUsd: number;
  /** Stages that could not be scored, with why. A score with anything here is incomplete. */
  notRun: { stage: string; why: string }[];
}

interface EngineSet { questions: { id: string; threshold: number; interval: Interval }[]; byViewport?: Record<string, Record<string, number>>; missedElements?: { question: string; element: string; missedRate: number }[]; stoppedIn?: Record<string, number>; failingAnswers?: { question: string; answer: string; judgeNote: string }[] }
interface EngineReport { verdict: string; error?: string; costUsd: number; working: EngineSet; holdout: EngineSet }

const pct = (x: number) => (Number.isNaN(x) ? 'n/a' : `${Math.round(x * 100)}%`);

/** How far the people the designer may see fall short. Lower is better. Held-back people are not in it. */
export function shortfall(score: MockScore): { rate: number; lower: number } {
  let rate = 0;
  let lower = 0;
  for (const q of score.questions) {
    rate += Math.max(0, q.threshold - (Number.isNaN(q.working.rate) ? 0 : q.working.rate));
    lower += Math.max(0, q.threshold - q.working.lower);
  }
  if (score.tried) {
    rate += Math.max(0, score.tried.threshold - (Number.isNaN(score.tried.interval.rate) ? 0 : score.tried.interval.rate));
    lower += Math.max(0, score.tried.threshold - score.tried.interval.lower);
  }
  return { rate, lower };
}

/** Better only on the pass rates. The interval tie-break is left out on purpose: at screening sizes it is noise. */
export function improved(candidate: MockScore, best: MockScore): boolean {
  if (candidate.notRun.length > best.notRun.length) return false;
  return shortfall(candidate).rate < shortfall(best).rate - 0.02;
}

export type MockVerdict = 'pass' | 'not met' | 'inside the noise' | 'incomplete';

/** A pass needs every low end to clear its threshold, for the seen and the held-back people, and for the try stage. */
export function mockVerdict(score: MockScore): MockVerdict {
  if (score.notRun.length > 0) return 'incomplete';
  const all = [
    ...score.questions.flatMap((q) => [intervalVerdict(q.working, q.threshold), intervalVerdict(q.holdout, q.threshold)]),
    ...(score.tried ? [intervalVerdict(score.tried.interval, score.tried.threshold)] : []),
  ];
  if (all.every((v) => v === 'met')) return 'pass';
  return all.includes('not met') ? 'not met' : 'inside the noise';
}

export const workingMet = (score: MockScore): boolean =>
  score.questions.every((q) => intervalVerdict(q.working, q.threshold) === 'met') &&
  (!score.tried || intervalVerdict(score.tried.interval, score.tried.threshold) === 'met');

// ---- Scoring one mock ----

export interface ScoreOptions {
  layout: ProjectLayout;
  spec: PipelineSpec;
  /** Folder holding the mock's index.html. Not used when a running build is given instead. */
  mockDir: string;
  /** A build already running on this machine, for the verify step: its origin, and the path of the page. */
  running?: { origin: string; entry: string };
  /** Where this scoring's engine folders and transcripts go. */
  evidenceDir: string;
  runs: number;
  tryCount: number;
  budgetUsd: number;
  llm: LLM;
  loadSeconds?: number;
  /** Stage kinds to score. Default: all. */
  only?: ('read' | 'decide' | 'try' | 'agent')[];
  /** Needed for the agent stage, whose judge checks replies against it. */
  ledger?: Ledger;
  startMachine?: (stage: TryStage, n: number) => Promise<Machine>;
  log?: (line: string) => void;
}

async function leaveReasons(workdir: string, experiment: string, run: string): Promise<string[]> {
  const dir = path.join(workdir, 'traces', experiment);
  const reasons: string[] = [];
  for (const file of await readdir(dir).catch(() => [] as string[])) {
    const t = JSON.parse(await readFile(path.join(dir, file), 'utf8')) as { batch: string; personaSet: string; outcome: string; visitorSteps?: { action: string; reason?: string }[] };
    // Working people only. What the held-back people said never reaches the designer.
    if (t.batch !== run || t.personaSet !== 'working' || t.outcome === 'completed') continue;
    const last = t.visitorSteps?.at(-1);
    if (last?.reason) reasons.push(last.reason);
  }
  return reasons;
}

export async function scoreMock(options: ScoreOptions): Promise<MockScore> {
  const { layout: l, spec, llm } = options;
  const log = options.log ?? (() => {});
  const only = options.only ?? ['read', 'decide', 'try', 'agent'];
  const score: MockScore = { questions: [], findings: '', costUsd: 0, notRun: [] };
  const findings: string[] = [];
  const run = 'score';
  await mkdir(options.evidenceDir, { recursive: true });

  const server = options.running ? { origin: options.running.origin, close: async () => {} } : await startStaticServer(options.mockDir);
  const entry = options.running?.entry ?? '/';
  // What the terminal and agent stages read: the page's text, from the file or from the running build.
  const pageHtml = async (): Promise<string> => {
    if (!options.running) return readFile(path.join(options.mockDir, 'index.html'), 'utf8');
    const response = await fetch(options.running.origin + entry);
    if (!response.ok) throw new Error(`The running build answered ${response.status} for ${entry}`);
    return response.text();
  };
  try {
    for (const stage of spec.stages) {
      if (stage.kind === 'try' || stage.kind === 'agent' || !only.includes(stage.kind)) continue;
      const workdir = path.join(options.evidenceDir, stage.id);
      await rm(workdir, { recursive: true, force: true });
      await mkdir(workdir, { recursive: true });
      await cp(path.join(l.referee, 'personas'), path.join(workdir, 'personas'), { recursive: true });
      const engineSpec = stage.kind === 'read' ? engineReadSpec(stage, options.runs, options.loadSeconds) : engineDecideSpec(stage, options.runs, options.loadSeconds);
      await writeFile(path.join(workdir, 'spec.yaml'), JSON.stringify(engineSpec, null, 2) + '\n');

      log(`  ${stage.id}: ${spec.personas.length} people x ${stage.viewports.length} screens x ${options.runs} visits`);
      // The owner's rule: local copies only, with outside requests blocked. A blocked request is recorded, not a failure.
      await simulate(
        ['--workdir', workdir, '--target', server.origin, '--entry', entry, '--run', run, '--runs', String(options.runs), '--budget-usd', Math.max(0.05, options.budgetUsd - score.costUsd).toFixed(2), '--outside-requests', 'block'],
        { llm, log: () => {}, logError: () => {} },
      );
      const report = JSON.parse(await readFile(path.join(workdir, 'reports', `${run}.json`), 'utf8')) as EngineReport;
      score.costUsd += report.costUsd;
      if (report.verdict === 'incomplete') {
        score.notRun.push({ stage: stage.id, why: report.error ?? 'some visits failed or the budget ran out' });
        if (report.working.questions.length === 0) continue;
      }

      const asks = stage.kind === 'read' ? Object.fromEntries(stage.questions.map((q) => [q.id, q.ask])) : { task: stage.goal };
      for (const q of report.working.questions) {
        const held = report.holdout.questions.find((h) => h.id === q.id);
        score.questions.push({
          stage: stage.id, id: q.id, ask: asks[q.id] ?? q.id, threshold: q.threshold, working: q.interval,
          holdout: held?.interval ?? wilson(0, 0),
          byViewport: Object.fromEntries(Object.entries(report.working.byViewport ?? {}).map(([vp, rates]) => [vp, rates[q.id] ?? NaN])),
        });
      }

      const w = report.working;
      findings.push(`## ${stage.kind === 'read' ? 'Reading' : 'Deciding'} (${stage.id})`, '');
      findings.push(...w.questions.map((q) => `- ${asks[q.id] ?? q.id}: ${pct(q.interval.rate)} (${q.interval.passed}/${q.interval.n}), needs ${pct(q.threshold)}`));
      if (w.missedElements?.length) findings.push('', 'Missed most:', ...w.missedElements.filter((m) => m.missedRate > 0).map((m) => `- "${m.element}" missed by ${pct(m.missedRate)}`));
      if (w.stoppedIn && Object.keys(w.stoppedIn).length > 0) findings.push('', 'Where they were when they stopped:', ...Object.entries(w.stoppedIn).map(([name, x]) => `- ${name}: ${pct(x)}`));
      if (w.failingAnswers?.length) findings.push('', 'A sample of failing answers:', ...w.failingAnswers.slice(0, 8).map((f) => `- [${asks[f.question] ?? f.question}] ${f.answer.slice(0, 300)}\n  - Judge: ${f.judgeNote}`));
      if (stage.kind === 'decide') {
        const reasons = await leaveReasons(workdir, stage.id, run);
        if (reasons.length > 0) findings.push('', 'Why some of them left without acting:', ...reasons.slice(0, 10).map((r) => `- ${r.slice(0, 300)}`));
      }
      findings.push('');
    }
  } finally {
    await server.close();
  }

  const tryDef = spec.stages.find((s): s is TryStage => s.kind === 'try');
  if (tryDef && only.includes('try') && options.tryCount > 0) {
    log(`  ${tryDef.id}: ${options.tryCount} developers on clean machines`);
    const html = await pageHtml();
    const stamp = Date.now().toString(36);
    const start = options.startMachine ?? ((stage: TryStage, n: number) => startContainer(stage, `sdd-try-${stamp}-${n}`));
    try {
      const result = await tryStage(tryDef, visibleText(html), llm, options.tryCount, (n) => start(tryDef, n));
      score.costUsd += result.costUsd;
      score.tried = { stage: tryDef.id, threshold: tryDef.threshold, interval: wilson(result.passed, result.n), result };
      await writeFile(path.join(options.evidenceDir, `${tryDef.id}.json`), JSON.stringify(result, null, 2) + '\n');
      findings.push(`## Trying, at a terminal (${tryDef.id})`, '', `- ${result.passed} of ${result.n} got there, needs ${pct(tryDef.threshold)}`);
      const failed = result.runs.filter((r) => !r.met);
      if (failed.length > 0) {
        findings.push('', 'What the ones who did not get there ran:');
        for (const r of failed.slice(0, 4)) {
          findings.push(`- ${r.steps.map((s) => `\`${s.command.slice(0, 160)}\` (exit ${s.exitCode})`).join(' then ') || 'nothing'}. ${r.note.slice(0, 240)}`);
        }
      }
      findings.push('');
    } catch (err) {
      score.notRun.push({ stage: tryDef.id, why: (err as Error).message });
    }
  }

  const agentDef = spec.stages.find((s): s is AgentStage => s.kind === 'agent');
  if (agentDef && only.includes('agent') && options.runs > 0) {
    if (!options.ledger) {
      score.notRun.push({ stage: agentDef.id, why: 'no ledger was given to check replies against' });
    } else {
      log(`  ${agentDef.id}: ${agentDef.requests.length} requests x ${options.runs} agents`);
      const html = await pageHtml();
      const result = await agentStage(agentDef, visibleText(html), options.ledger, llm, options.runs);
      score.costUsd += result.costUsd;
      await writeFile(path.join(options.evidenceDir, `${agentDef.id}.json`), JSON.stringify(result, null, 2) + '\n');
      score.questions.push({ stage: agentDef.id, id: 'agent', ask: agentDef.goal, threshold: agentDef.threshold, working: result.working, holdout: result.holdout });
      const errored = result.runs.filter((r) => r.note.startsWith('error:')).length;
      if (errored > 0) score.notRun.push({ stage: agentDef.id, why: `${errored} agent replies failed to run` });
      // Only the requests the designer may see. What held-back requests produced stays with the referee.
      const shown = result.runs.filter((r) => !r.holdout);
      findings.push(`## AI agents asked by their developer (${agentDef.id})`, '', `- ${result.working.passed} of ${result.working.n} replies counted, needs ${pct(agentDef.threshold)}`);
      const failed = shown.filter((r) => !r.met);
      if (failed.length > 0) {
        findings.push('', 'Replies that did not count:');
        for (const r of failed.slice(0, 8)) {
          const ask = agentDef.requests.find((q) => q.id === r.request)?.ask ?? r.request;
          const why = !r.fits ? 'the product does not fit this and the agent recommended it anyway'
            : [!r.recommended ? 'the agent did not recommend it' : '', r.missing.length ? `left out: ${r.missing.join('; ')}` : '', r.falseStatements.length ? `said something untrue: ${r.falseStatements.join('; ')}` : ''].filter(Boolean).join('. ');
          findings.push(`- Asked "${ask.slice(0, 160)}": ${why}. The agent said: ${r.reply.slice(0, 300)}`);
        }
      }
      findings.push('');
    }
  }

  score.findings = findings.join('\n');
  score.costUsd = Math.round(score.costUsd * 10000) / 10000;
  return score;
}

// ---- The loop ----

export interface LoopOptions {
  layout: ProjectLayout;
  spec: PipelineSpec;
  ledger: Ledger;
  llm: LLM;
  maxIterations?: number;
  /** Visits per person and screen while iterating. */
  runs?: number;
  /** Developers per iteration in the try stage. */
  tryCount?: number;
  startMachine?: (stage: TryStage, n: number) => Promise<Machine>;
  log?: (line: string) => void;
  /** A session that can read the repository, to check statements the ledger does not cover. Without it, the ledger is the limit. */
  agent?: AgentRunner;
  /** The repository folders the product's truth comes from. */
  sourceDirs?: string[];
  /** Places the owner named as their own, which a page may link to. */
  ownPlaces?: string[];
  /** Carry on from this earlier design instead of starting again. */
  resumeFrom?: number;
  /** Score the resumed design again before carrying on, because the referee has changed since. */
  rescoreFirst?: boolean;
  /** The number of the first new design when carrying on. Default: one after resumeFrom. */
  startAt?: number;
}

export interface IterationRecord {
  iteration: number;
  outcome: 'first' | 'kept' | 'reverted: no improvement' | 'thrown out by guardrails';
  verdict?: MockVerdict;
  shortfall?: number;
  rejected?: string[];
  notes?: string;
  costUsd: number;
}

export interface LoopResult {
  stop: 'pass' | 'budget' | 'iterations' | 'plateau' | 'no usable design';
  iterations: IterationRecord[];
  best?: { iteration: number; score: MockScore; verdict: MockVerdict; dir: string };
  spentUsd: number;
}

const GUARDRAIL_TRIES = 3;

/**
 * What the designer hears about the people it is not shown: which questions they
 * fall short on, and nothing else. No rates, no words of theirs, nothing about who they are.
 * Without this a page can keep improving for the seen people while it loses everyone else.
 */
export function unseenNote(score: MockScore): string {
  const short = score.questions.filter((q) => q.holdout.n > 0 && q.holdout.rate < q.threshold);
  if (short.length === 0) return '';
  return [
    '',
    '## Visitors you are not shown',
    '',
    'Other kinds of visitor in this audience also came. They fell short of what is needed on:',
    ...short.map((q) => `- ${q.ask}`),
    '',
    'You are not told who they are. Do not guess at them and do not aim anything at one kind of visitor. Make the page work for someone in this audience who arrives from somewhere else, knowing less or wanting something slightly different from the people you were shown.',
    '',
  ].join('\n');
}

/** A design scored earlier, read back so the loop can carry on from it. */
export async function loadScored(l: ProjectLayout, iteration: number): Promise<NonNullable<LoopResult['best']>> {
  const dir = path.join(l.design, `iter-${iteration}`);
  const saved = JSON.parse(await readFile(path.join(dir, 'score.json'), 'utf8')) as MockScore & { verdict: MockVerdict };
  await readFile(path.join(dir, 'index.html'), 'utf8');
  return { iteration, score: saved, verdict: saved.verdict, dir };
}

/** What step 4 has spent so far, from the log. The log is the only source. */
export async function designSpend(l: ProjectLayout): Promise<number> {
  return (await readCosts(l)).filter((c) => c.step === 'design').reduce((s, c) => s + c.usd, 0);
}

export async function runDesignLoop(options: LoopOptions): Promise<LoopResult> {
  const { layout: l, spec, ledger, llm } = options;
  const log = options.log ?? (() => {});
  const approval = await requireApproval(l);
  const maxIterations = options.maxIterations ?? 6;
  const runs = options.runs ?? 4;
  const tryCount = options.tryCount ?? 5;
  const places = ownPlaces(spec, ledger, options.ownPlaces ?? []);
  const baseBrief = buildBrief(spec, ledger, places);
  await writeFile(path.join(l.brief, 'brief.md'), baseBrief);
  // Statements beyond the ledger that were checked against the repository during this run.
  const verifiedFile = path.join(l.evidence, 'verified-claims.json');
  const verified: { claim: string; file: string; line: number; quote: string }[] = await readFile(verifiedFile, 'utf8').then((t) => JSON.parse(t), () => []);
  const briefNow = () => (verified.length === 0 ? baseBrief : `${baseBrief}\n# Also checked against the repository during this run\n\n${verified.map((v) => `- ${v.claim}`).join('\n')}\n`);

  const iterations: IterationRecord[] = [];
  // Carrying on from an earlier design: it is the one to beat, and new designs are numbered after the last one made.
  let best: LoopResult['best'] = options.resumeFrom === undefined ? undefined : await loadScored(l, options.resumeFrom);
  const first = options.resumeFrom === undefined ? 0 : (options.startAt ?? options.resumeFrom + 1);
  let stale = 0;
  if (best && options.rescoreFirst) {
    // The referee changed since this design was scored (new held-back people, say). Score it again so new designs are compared like for like.
    log(`--- Design ${best.iteration}, scored again ---`);
    const again = await scoreMock({
      layout: l, spec, mockDir: best.dir, evidenceDir: path.join(l.evidence, 'design', `iter-${best.iteration}-rescored`),
      runs, tryCount, budgetUsd: Math.max(0.5, approval.budgetUsd - (await designSpend(l))), llm, ledger, startMachine: options.startMachine, log,
    });
    await logCost(l, { step: 'design', what: `simulation, design ${best.iteration} scored again`, usd: again.costUsd, durationMs: 0, detail: { runs, tryCount } });
    const v = mockVerdict(again);
    const s = shortfall(again).rate;
    await writeFile(path.join(best.dir, 'score-rescored.json'), JSON.stringify({ verdict: v, shortfall: s, ...again, tried: again.tried && { ...again.tried, result: undefined, passed: again.tried.result.passed, n: again.tried.result.n } }, null, 2) + '\n');
    log(`  verdict: ${v}, shortfall ${s.toFixed(2)}`);
    best = { ...best, score: again, verdict: v };
  }
  const left = async () => approval.budgetUsd - (await designSpend(l));
  const finish = async (stop: LoopResult['stop']): Promise<LoopResult> => ({ stop, iterations, best, spentUsd: Math.round((await designSpend(l)) * 100) / 100 });

  for (let iteration = first; iteration < first + maxIterations; iteration++) {
    if (best?.verdict === 'pass') return finish('pass');
    if ((await left()) <= 0.5) return finish('budget');
    if (stale >= 2) return finish('plateau');

    log(`--- Design ${iteration} ---`);
    const dir = path.join(l.design, `iter-${iteration}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    let cost = 0;

    // Design, then guardrails. A page that fails them is sent back, not scored.
    let html: string | undefined;
    let notes = '';
    let rejected: string[] | undefined;
    for (let attempt = 1; attempt <= GUARDRAIL_TRIES && !html; attempt++) {
      const previous = best ? { html: await readFile(path.join(best.dir, 'index.html'), 'utf8'), findings: best.score.findings + unseenNote(best.score) } : undefined;
      const design = await designMock(llm, { brief: briefNow(), iteration, previous, rejected });
      cost += design.costUsd;
      await logCost(l, { step: 'design', what: `designer, design ${iteration} attempt ${attempt}`, usd: design.costUsd, durationMs: 0 });

      const problems = mechanicalProblems(design.html, places);
      if (problems.length === 0) {
        const review = await reviewClaims(llm, design.html, ledger, verified.map((v) => v.claim));
        cost += review.costUsd;
        await logCost(l, { step: 'design', what: `claims review, design ${iteration} attempt ${attempt}`, usd: review.costUsd, durationMs: 0 });
        let violations = review.violations;
        // "True" means the repository supports it, not that it is on a list. Look up what the ledger does not cover.
        if (violations.length > 0 && options.agent && (options.sourceDirs?.length ?? 0) > 0) {
          const check = await checkAgainstRepo(options.agent, violations, ledger, options.sourceDirs!, await freshScratch(l, 'claims-check'), Math.min(1.5, Math.max(0.2, await left())));
          cost += check.costUsd;
          await logCost(l, { step: 'design', what: `repository check of ${violations.length} statement(s), design ${iteration} attempt ${attempt}`, usd: check.costUsd, durationMs: 0, detail: { supported: check.supported.length } });
          if (check.supported.length > 0) {
            verified.push(...check.supported.map(({ claim, file, line, quote }) => ({ claim, file, line, quote })));
            await writeFile(verifiedFile, JSON.stringify(verified, null, 2) + '\n');
            log(`  ${check.supported.length} statement(s) beyond the ledger checked out against the repository`);
          }
          violations = check.unsupported;
        }
        problems.push(...violations.map((v) => `The page says "${v.statement}". ${v.why}`));
      }
      if (problems.length === 0) {
        html = design.html;
        notes = design.notes;
      } else {
        rejected = problems;
        await writeFile(path.join(dir, `rejected-${attempt}.html`), design.html);
        await writeFile(path.join(dir, `rejected-${attempt}.txt`), problems.join('\n') + '\n');
        log(`  thrown out by guardrails (${problems.length}): ${problems[0]!.slice(0, 140)}`);
      }
    }
    if (!html) {
      iterations.push({ iteration, outcome: 'thrown out by guardrails', rejected, costUsd: cost });
      stale++;
      continue;
    }
    await writeFile(path.join(dir, 'index.html'), html);
    await writeFile(path.join(dir, 'notes.md'), notes + '\n');

    const score = await scoreMock({
      layout: l, spec, mockDir: dir, evidenceDir: path.join(l.evidence, 'design', `iter-${iteration}`),
      runs, tryCount, budgetUsd: Math.max(0.5, await left()), llm, ledger, startMachine: options.startMachine, log,
    });
    cost += score.costUsd;
    await logCost(l, { step: 'design', what: `simulation, design ${iteration}`, usd: score.costUsd, durationMs: 0, detail: { runs, tryCount } });
    const v = mockVerdict(score);
    const s = shortfall(score).rate;
    await writeFile(path.join(dir, 'score.json'), JSON.stringify({ verdict: v, shortfall: s, ...score, tried: score.tried && { ...score.tried, result: undefined, passed: score.tried.result.passed, n: score.tried.result.n } }, null, 2) + '\n');
    log(`  verdict: ${v}, shortfall ${s.toFixed(2)}, $${cost.toFixed(2)}`);

    if (!best) {
      best = { iteration, score, verdict: v, dir };
      iterations.push({ iteration, outcome: 'first', verdict: v, shortfall: s, notes, costUsd: cost });
    } else if (improved(score, best.score)) {
      best = { iteration, score, verdict: v, dir };
      stale = 0;
      iterations.push({ iteration, outcome: 'kept', verdict: v, shortfall: s, notes, costUsd: cost });
    } else {
      stale++;
      iterations.push({ iteration, outcome: 'reverted: no improvement', verdict: v, shortfall: s, notes, costUsd: cost });
    }
  }

  if (!best) return finish('no usable design');
  if (best.verdict === 'pass') return finish('pass');
  return finish(stale >= 2 ? 'plateau' : 'iterations');
}
