// A compact, structured summary of one persona set's results on one page.
// Used by the automated loop to decide, and to brief the revising agent.

import { createRng, deriveSeed } from '../runner/rng.ts';
import type { Spec } from '../runner/spec.ts';
import type { Trace } from '../runner/trace.ts';
import { verdict, wilson, type Interval, type Verdict } from './stats.ts';

export interface QuestionSummary {
  id: string;
  threshold: number;
  interval: Interval;
  verdict: Verdict;
}

export interface SetSummary {
  set: 'working' | 'holdout';
  runs: number;
  questions: QuestionSummary[];
  /** Sum over questions of how far the pass rate sits below its threshold. 0 when all rates clear. */
  shortfall: number;
  /** The smallest gap between a pass rate and its threshold. Negative when a rate is below. */
  minMargin: number;
  /** True when every lower bound clears its threshold. */
  met: boolean;
  /** True when every point estimate clears its threshold. Weaker than met. */
  ratesClear: boolean;
  byViewport: Record<string, Record<string, number>>;
  byPersona: Record<string, Record<string, number>>;
  missedElements: { question: string; element: string; missedRate: number }[];
  /** Share of readers whose deepest section was each one. */
  stoppedIn: Record<string, number>;
  /** A seeded sample of failing answers with the judge's note. */
  failingAnswers: { question: string; answer: string; judgeNote: string }[];
}

export function summarize(
  spec: Spec,
  thresholds: Record<string, number>,
  traces: Trace[],
  set: 'working' | 'holdout',
  maxSeed = Infinity,
): SetSummary {
  const runs = traces.filter((t) => t.personaSet === set && t.seed <= maxSeed);
  const passed = (t: Trace, id: string) => t.grades!.find((g) => g.questionId === id)!.pass;
  const rate = (group: Trace[], id: string) => (group.length ? group.filter((t) => passed(t, id)).length / group.length : NaN);

  const questions = spec.questions.map((q): QuestionSummary => {
    const interval = wilson(runs.filter((t) => passed(t, q.id)).length, runs.length);
    return { id: q.id, threshold: thresholds[q.id]!, interval, verdict: verdict(interval, thresholds[q.id]!) };
  });

  const group = (f: (t: Trace) => string) => {
    const out: Record<string, Record<string, number>> = {};
    for (const name of new Set(runs.map(f))) {
      const members = runs.filter((t) => f(t) === name);
      out[name] = Object.fromEntries(spec.questions.map((q) => [q.id, round(rate(members, q.id))]));
    }
    return out;
  };

  const stoppedIn: Record<string, number> = {};
  for (const t of runs) stoppedIn[t.deepestSection] = (stoppedIn[t.deepestSection] ?? 0) + 1 / runs.length;
  for (const k of Object.keys(stoppedIn)) stoppedIn[k] = round(stoppedIn[k]!);

  const rng = createRng(deriveSeed('failing-sample', spec.experiment, runs[0]?.page.sha256 ?? ''));
  const failingAnswers = spec.questions.flatMap((q) => {
    const failures = runs.filter((t) => !passed(t, q.id));
    return failures
      .map((t) => ({ t, r: rng() }))
      .sort((a, b) => a.r - b.r)
      .slice(0, 6)
      .map(({ t }) => ({
        question: q.id,
        answer: t.answers.find((a) => a.id === q.id)!.answer,
        judgeNote: t.grades!.find((g) => g.questionId === q.id)!.note,
      }));
  });

  return {
    set,
    runs: runs.length,
    questions,
    shortfall: round(questions.reduce((sum, q) => sum + Math.max(0, q.threshold - q.interval.rate), 0)),
    minMargin: round(Math.min(...questions.map((q) => q.interval.rate - q.threshold))),
    met: runs.length > 0 && questions.every((q) => q.verdict === 'met'),
    ratesClear: runs.length > 0 && questions.every((q) => q.interval.rate >= q.threshold),
    byViewport: group((t) => t.viewport.name),
    byPersona: group((t) => t.persona.id),
    missedElements: spec.questions
      .flatMap((q) =>
        q.rubric.required.map((element, i) => ({
          question: q.id,
          element,
          missedRate: round(runs.filter((t) => !t.grades!.find((g) => g.questionId === q.id)!.requiredMet[i]).length / runs.length),
        })),
      )
      .sort((a, b) => b.missedRate - a.missedRate),
    stoppedIn,
    failingAnswers,
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
