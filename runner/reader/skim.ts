// Skim and time mechanics. Pure functions: blocks in, steps out. No browser,
// no LLM. This is the "human messiness" half of the hybrid design.
//
//   Skimming: headings are always taken in. Each sentence of body text is
//             taken in with a probability set by the skim rate.
//   Time:     reading costs words / reading speed. Glancing past a skipped
//             sentence and scrolling cost a little too. When the budget is
//             spent the session ends.
//   Recall:   each fragment taken in survives to answer time with a
//             probability that decays with how long ago it was read.

import type { Rng } from '../rng.ts';

export interface Block {
  id: number;
  kind: 'heading' | 'body';
  /** Page section the block sits in, for "where did readers stop". */
  section: string;
  text: string;
  /** Document coordinates in CSS pixels. */
  top: number;
  bottom: number;
  left: number;
}

/** Global dials. Calibration (milestone 4) tunes these and then freezes them. */
export interface Dials {
  timeBudgetSeconds: number;
  /** Multiplies each persona's skim rate. */
  skimScale: number;
  /** Per simulated second. 0 means perfect recall. */
  recallDecayPerSecond: number;
  /** Cost of glancing past a skipped sentence. */
  glanceSeconds: number;
  /** Cost of one scroll. */
  scrollSeconds: number;
  /** Fraction of the viewport height covered by one scroll. */
  scrollFraction: number;
}

/** Starting values, not yet calibrated against real readers. */
export const UNCALIBRATED_DIALS: Dials = {
  timeBudgetSeconds: 60,
  skimScale: 1,
  recallDecayPerSecond: 0.005,
  glanceSeconds: 0.2,
  scrollSeconds: 0.6,
  scrollFraction: 0.8,
};

export interface PersonaDials {
  reading_wpm: number;
  /** Share of body sentences skipped, 0 to 1. */
  skim_rate: number;
  /** Visitor mode: chance of missing a comfortably sized tap target. Default 0.03. */
  mis_tap_rate?: number;
}

export interface Fragment {
  blockId: number;
  kind: 'heading' | 'body';
  section: string;
  text: string;
  /** Simulated second at which reading this fragment finished. */
  t: number;
}

export interface Step {
  index: number;
  scrollY: number;
  /** Blocks newly on screen at this step. */
  visible: Pick<Block, 'id' | 'kind' | 'section' | 'text'>[];
  /** What the reader took in, after skimming. */
  seen: Fragment[];
  action: 'scroll' | 'stop';
  reason: string;
  simulatedSecondsStart: number;
  simulatedSecondsEnd: number;
}

export interface SkimResult {
  steps: Step[];
  seen: Fragment[];
  outcome: 'time_up' | 'end_of_page';
  simulatedSeconds: number;
  deepestSection: string;
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function skim(
  blocks: Block[],
  viewportHeight: number,
  pageHeight: number,
  persona: PersonaDials,
  dials: Dials,
  rng: Rng,
): SkimResult {
  const ordered = [...blocks].sort((a, b) => a.top - b.top || a.left - b.left || a.id - b.id);
  const pRead = 1 - Math.min(1, Math.max(0, persona.skim_rate * dials.skimScale));
  const budget = dials.timeBudgetSeconds;
  const maxScroll = Math.max(0, pageHeight - viewportHeight);

  const steps: Step[] = [];
  const allSeen: Fragment[] = [];
  let t = 0;
  let scrollY = 0;
  let cursor = 0;
  let deepestSection = ordered[0]?.section ?? '';
  let outcome: SkimResult['outcome'] | undefined;

  while (!outcome) {
    const start = t;
    const viewBottom = scrollY + viewportHeight;
    const visible: Block[] = [];
    const seen: Fragment[] = [];
    let timeUp = false;

    // No scrolling back: each block is offered once, in reading order, when
    // its middle comes on screen.
    while (cursor < ordered.length && (ordered[cursor]!.top + ordered[cursor]!.bottom) / 2 < viewBottom) {
      const block = ordered[cursor++]!;
      visible.push(block);
      if (timeUp) continue; // on screen, but the clock already ran out
      deepestSection = block.section;
      const fragments = block.kind === 'heading' ? [block.text] : splitSentences(block.text);
      for (const text of fragments) {
        const reads = block.kind === 'heading' || rng() < pRead;
        const cost = reads ? (countWords(text) / persona.reading_wpm) * 60 : dials.glanceSeconds;
        if (t + cost > budget) {
          t = budget;
          timeUp = true;
          break;
        }
        t += cost;
        if (reads) seen.push({ blockId: block.id, kind: block.kind, section: block.section, text, t: round(t) });
      }
    }

    let action: Step['action'] = 'scroll';
    let reason = 'time remains and there is more page below';
    if (timeUp) {
      action = 'stop';
      reason = 'time budget spent';
      outcome = 'time_up';
    } else if (scrollY >= maxScroll && cursor >= ordered.length) {
      action = 'stop';
      reason = 'reached the end of the page';
      outcome = 'end_of_page';
    } else if (t + dials.scrollSeconds > budget) {
      t = budget;
      action = 'stop';
      reason = 'time budget spent';
      outcome = 'time_up';
    } else {
      t += dials.scrollSeconds;
    }

    steps.push({
      index: steps.length,
      scrollY: Math.round(scrollY),
      visible: visible.map(({ id, kind, section, text }) => ({ id, kind, section, text })),
      seen,
      action,
      reason,
      simulatedSecondsStart: round(start),
      simulatedSecondsEnd: round(t),
    });
    allSeen.push(...seen);

    if (!outcome) {
      // At the bottom with blocks still unread (their middle never crossed
      // the fold): jump far enough that the loop always makes progress.
      scrollY = scrollY >= maxScroll ? scrollY + viewportHeight : Math.min(maxScroll, scrollY + viewportHeight * dials.scrollFraction);
    }
  }

  return { steps, seen: allSeen, outcome, simulatedSeconds: round(t), deepestSection };
}

/** What survives to answer time. Always a subset of what was seen. */
export function recall(seen: Fragment[], endSeconds: number, dials: Dials, rng: Rng): Fragment[] {
  return seen.filter((f) => rng() < Math.exp(-dials.recallDecayPerSecond * (endSeconds - f.t)));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
