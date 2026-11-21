// Trace format: one JSON file per run, written once and never edited.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LLMCallRecord } from './llm/types.ts';
import type { Answer } from './reader/answer.ts';
import { splitSentences, type Dials, type Fragment, type Step } from './reader/skim.ts';
import { citeIsOnScreen } from './visitor/decide.ts';
import type { Persona } from './spec.ts';

export interface Grade {
  questionId: string;
  pass: boolean;
  requiredMet: boolean[];
  bonusMet: boolean[];
  /** The answer's words the judge quoted for each required element. Judge v2 on. */
  evidence?: string[];
  note: string;
}

export interface VisitorStep {
  index: number;
  url: string;
  scrollY: number;
  /** Everything on screen. */
  visibleText: { kind: 'heading' | 'body'; text: string }[];
  /** What the visitor took in, after skimming. */
  seenText: { kind: 'heading' | 'body'; text: string }[];
  elements: { n: number; kind: string; label: string }[];
  action: string;
  element?: number;
  typed?: string;
  /** The on-screen words the action was based on. Checked against the screen. */
  cites: string;
  reason: string;
  /** What happened: moved on, missed the tap, and so on. */
  result: string;
  simulatedSecondsStart: number;
  simulatedSecondsEnd: number;
}

/** Talker mode: one entry per line the person spoke, plus the step that ended the conversation. */
export interface TalkerTurn {
  index: number;
  action: 'say' | 'done' | 'leave' | 'stop';
  said: string;
  /** The words the person was responding to. Checked against what they heard on the turn before. */
  cites: string;
  reason: string;
  /** What the product's ears made of `said`, when the line went in as sound. Never shown to the persona or the judge. */
  heardAs?: string;
  /** What the product said back. */
  heard: string;
  /** What the product did. Never shown to the persona. */
  events: { name: string; detail?: string }[];
  /** Real seconds waited for the reply. */
  waitSeconds: number;
  simulatedSecondsStart: number;
  simulatedSecondsEnd: number;
}

export interface Trace {
  schema: 'sdd-trace/1';
  runId: string;
  /** Set for runs made as part of a batch. The scorer aggregates by this. */
  batch?: string;
  experiment: string;
  mode: 'reader' | 'visitor' | 'talker';
  startedAt: string;
  page: { path: string; sha256: string; words: number };
  persona: Persona;
  personaSet: 'working' | 'holdout';
  viewport: { name: string; width: number; height: number };
  /** The seed given on the command line. */
  seed: number;
  /** What the RNG was actually seeded with: experiment, persona, viewport, seed. */
  derivedSeed: number;
  dials: Dials & { calibrated: boolean };
  steps: Step[];
  /** Visitor mode: one entry per screen and action. `steps` is empty in that mode. */
  visitorSteps?: VisitorStep[];
  /** Talker mode: the conversation. `steps` is empty in that mode. */
  talkerTurns?: TalkerTurn[];
  /** What survived recall decay. The only page text the answering call got. */
  recalled: Fragment[];
  outcome: 'time_up' | 'end_of_page' | 'completed' | 'left' | 'gave_up' | 'thought_done';
  simulatedSeconds: number;
  deepestSection: string;
  answers: Answer[];
  /** Filled by the judge. Null until the judge exists (milestone 3). */
  grades: Grade[] | null;
  /** Every prompt and model response behind this run. */
  llmCalls: LLMCallRecord[];
  cost: { usd: number; inputTokens: number; outputTokens: number };
  /**
   * `violations` is outside requests that should have failed the run, so a
   * stored trace always has 0. `blocked` is outside requests that were refused
   * while the run carried on (--outside-requests block), across the batch so far.
   */
  sandbox: { origin: string; violations: number; blocked?: number };
}

/** Throws with every problem found. Checks shape and the rules a trace must obey. */
export function validateTrace(trace: Trace, questionIds: string[]): void {
  const problems: string[] = [];
  const check = (ok: boolean, message: string) => {
    if (!ok) problems.push(message);
  };

  check(trace.schema === 'sdd-trace/1', 'schema is not sdd-trace/1');
  check(Boolean(trace.runId && trace.experiment && trace.persona?.id), 'missing run, experiment, or persona id');
  check(Number.isInteger(trace.seed), 'seed is not an integer');
  check(/^[0-9a-f]{64}$/.test(trace.page?.sha256 ?? ''), 'page hash missing');
  if (trace.mode === 'talker') {
    validateTalker(trace, check);
    if (problems.length > 0) throw new Error(`Invalid trace ${trace.runId}:\n  ${problems.join('\n  ')}`);
    return;
  }
  if (trace.mode === 'visitor') {
    validateVisitor(trace, check);
    if (problems.length > 0) throw new Error(`Invalid trace ${trace.runId}:\n  ${problems.join('\n  ')}`);
    return;
  }
  check(trace.steps.length > 0, 'no steps');
  check(trace.sandbox.violations === 0, 'sandbox violations in a stored trace');

  // Time moves forward and stays inside the budget.
  let clock = 0;
  for (const step of trace.steps) {
    check(step.simulatedSecondsStart >= clock - 1e-9, `step ${step.index} starts before the previous one ended`);
    check(step.simulatedSecondsEnd >= step.simulatedSecondsStart, `step ${step.index} ends before it starts`);
    clock = step.simulatedSecondsEnd;
    // Seen is a subset of visible.
    for (const fragment of step.seen) {
      const block = step.visible.find((b) => b.id === fragment.blockId);
      check(Boolean(block?.text.includes(fragment.text)), `step ${step.index}: seen text not in a visible block`);
    }
  }
  check(clock <= trace.dials.timeBudgetSeconds + 1e-9, 'simulated time exceeds the budget');
  check(Math.abs(clock - trace.simulatedSeconds) < 1e-6, 'simulatedSeconds does not match the last step');
  check(trace.steps.at(-1)?.action === 'stop', 'last step is not a stop');

  // Recalled is a subset of seen.
  const seen = trace.steps.flatMap((s) => s.seen);
  for (const fragment of trace.recalled) {
    check(
      seen.some((s) => s.blockId === fragment.blockId && s.text === fragment.text && s.t === fragment.t),
      `recalled fragment was never seen: "${fragment.text.slice(0, 40)}"`,
    );
  }

  // One answer per question.
  for (const id of questionIds) {
    check(trace.answers.some((a) => a.id === id && typeof a.answer === 'string'), `no answer for "${id}"`);
  }

  // The answering prompt carries recalled text only. Any sentence that was on
  // screen but not recalled must be absent from every persona prompt.
  const recalledText = trace.recalled.map((f) => f.text);
  const withheld = trace.steps
    .flatMap((s) => s.visible)
    .flatMap((b) => (b.kind === 'heading' ? [b.text] : splitSentences(b.text)))
    .filter((text) => text.length >= 25 && !recalledText.some((r) => r.includes(text)));
  const personaCalls = trace.llmCalls.filter((c) => c.request.role === 'persona');
  check(personaCalls.length > 0, 'no persona call recorded');
  for (const call of personaCalls) {
    for (const text of withheld) {
      check(!call.request.prompt.includes(text), `persona prompt leaks unseen text: "${text.slice(0, 40)}"`);
    }
  }

  const usd = trace.llmCalls.reduce((sum, c) => sum + c.response.costUsd, 0);
  check(Math.abs(usd - trace.cost.usd) < 1e-9, 'cost does not match the recorded calls');

  if (problems.length > 0) throw new Error(`Invalid trace ${trace.runId}:\n  ${problems.join('\n  ')}`);
}

function validateVisitor(trace: Trace, check: (ok: boolean, message: string) => void): void {
  const steps = trace.visitorSteps ?? [];
  check(steps.length > 0, 'no visitor steps');
  check(trace.sandbox.violations === 0, 'sandbox violations in a stored trace');
  let clock = 0;
  for (const step of steps) {
    check(step.simulatedSecondsStart >= clock - 1e-9 && step.simulatedSecondsEnd >= step.simulatedSecondsStart, `step ${step.index}: time goes backwards`);
    clock = step.simulatedSecondsEnd;
    // Seen is a subset of visible.
    for (const seen of step.seenText) check(step.visibleText.some((v) => v.text.includes(seen.text)), `step ${step.index}: seen text not on screen`);
    // Anything but leaving rests on words that were on the screen.
    if (!['leave', 'stop'].includes(step.action)) { // 'done' needs a quote too
      check(citeIsOnScreen(step.cites, step.seenText, step.elements), `step ${step.index}: action "${step.action}" cites words that were not on screen`);
    }
  }
  check(['completed', 'left', 'gave_up', 'time_up', 'thought_done'].includes(trace.outcome), 'visitor outcome missing');
  check(trace.grades?.length === 1 && trace.grades[0]!.questionId === 'task', 'visitor trace needs one task grade');
  check(trace.grades?.[0]?.pass === (trace.outcome === 'completed'), 'task grade does not match the outcome');
  const usd = trace.llmCalls.reduce((sum, c) => sum + c.response.costUsd, 0);
  check(Math.abs(usd - trace.cost.usd) < 1e-9, 'cost does not match the recorded calls');
}

function validateTalker(trace: Trace, check: (ok: boolean, message: string) => void): void {
  const turns = trace.talkerTurns ?? [];
  check(turns.length > 0, 'no talker turns');
  check(turns[0]?.action === 'say', 'the conversation did not open with the person speaking');
  let clock = 0;
  let lastHeard: string | null = null;
  for (const turn of turns) {
    check(turn.simulatedSecondsStart >= clock - 1e-9 && turn.simulatedSecondsEnd >= turn.simulatedSecondsStart, `turn ${turn.index}: time goes backwards`);
    clock = turn.simulatedSecondsEnd;
    if (turn.action === 'say') check(turn.said.trim().length > 0, `turn ${turn.index}: a spoken turn with no words`);
    // After the first line, speaking again or claiming it worked rests on words that were heard.
    if (lastHeard !== null && lastHeard.trim() && (turn.action === 'say' || turn.action === 'done')) {
      check(citeIsOnScreen(turn.cites, [{ text: lastHeard }], []), `turn ${turn.index}: "${turn.action}" cites words that were not heard`);
    }
    if (lastHeard !== null && !lastHeard.trim()) check(turn.action !== 'done', `turn ${turn.index}: "done" after hearing nothing`);
    if (turn.action === 'say') lastHeard = turn.heard;
  }
  check(clock <= trace.dials.timeBudgetSeconds + 1e-9, 'simulated time exceeds the budget');
  check(['completed', 'left', 'gave_up', 'time_up', 'thought_done'].includes(trace.outcome), 'talker outcome missing');
  check(trace.grades?.length === 1 && trace.grades[0]!.questionId === 'task', 'talker trace needs one task grade');
  check(trace.grades?.[0]?.pass === (trace.outcome === 'completed'), 'task grade does not match the outcome');
  const usd = trace.llmCalls.reduce((sum, c) => sum + c.response.costUsd, 0);
  check(Math.abs(usd - trace.cost.usd) < 1e-9, 'cost does not match the recorded calls');
}

/** Writes traces/<experiment>/<runId>.json. Fails if the file already exists. */
export async function writeTrace(tracesDir: string, trace: Trace): Promise<string> {
  const dir = path.join(tracesDir, trace.experiment);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${trace.runId}.json`);
  await writeFile(file, JSON.stringify(trace, null, 2) + '\n', { flag: 'wx' });
  return file;
}
