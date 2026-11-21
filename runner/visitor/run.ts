// Visitor mode: one persona, one session, one trace.
//
// The visitor lands on the entry page and acts: scroll, click, type, or
// leave. Leaving is the default (see decide.ts). The engine, not the model,
// decides whether the task was completed, from what the browser actually did.
//
// Use this only against a copy of the app that is safe to act on. Visitors
// submit forms. The sandbox still blocks every request to any other origin.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page, Request } from 'playwright';
import { judgeOutcome } from '../../judge/outcome.ts';
import type { LLM, LLMCallRecord, LLMImage } from '../llm/types.ts';
import { captureScreens, extractLayout } from '../reader/extract.ts';
import { VIEWPORTS } from '../reader/run.ts';
import { countWords, splitSentences, UNCALIBRATED_DIALS, type Dials } from '../reader/skim.ts';
import { createRng, deriveSeed, type Rng } from '../rng.ts';
import type { Sandbox } from '../sandbox/sandbox.ts';
import type { Persona, Spec } from '../spec.ts';
import { validateTrace, type Trace, type VisitorStep } from '../trace.ts';
import { decide, type PastStep } from './decide.ts';
import { observe, type Observation, type ScreenElement } from './observe.ts';

export interface VisitorRunOptions {
  repoRoot: string;
  spec: Spec;
  persona: Persona;
  personaSet?: 'working' | 'holdout';
  viewport: string;
  seed: number;
  sandbox: Sandbox;
  llm: LLM;
  batch?: string;
  entryPath?: string;
  dials?: Dials;
}

const CLICK_SECONDS = 1.2;
const LOAD_SECONDS = 1;
const TYPE_SECONDS_PER_CHAR = 0.25;

/**
 * Chance of missing a tap. Small targets are missed more often, in the
 * spirit of Fitts's law: 44 CSS pixels is a comfortable target, and the miss
 * rate grows as the target shrinks below that.
 */
export function missChance(element: Pick<ScreenElement, 'width' | 'height'>, baseRate: number): number {
  const size = Math.max(1, Math.min(element.width, element.height));
  return Math.min(0.5, baseRate * Math.max(1, 44 / size));
}

/** Headings are always taken in. Each body sentence is taken in with the skim probability, once per session. */
function skimScreen(o: Observation, pRead: number, rng: Rng, memo: Map<string, boolean>) {
  const seen: { kind: 'heading' | 'body'; text: string }[] = [];
  let words = 0;
  for (const block of o.text) {
    const parts = block.kind === 'heading' ? [block.text] : splitSentences(block.text);
    for (const text of parts) {
      const key = `${o.url}|${text}`;
      const first = !memo.has(key);
      if (first) memo.set(key, block.kind === 'heading' || rng() < pRead);
      if (!memo.get(key)) continue;
      seen.push({ kind: block.kind, text });
      if (first) words += countWords(text); // reading time is paid once
    }
  }
  return { seen, words };
}

export async function runVisitor(options: VisitorRunOptions): Promise<Trace> {
  const { spec, persona, sandbox, llm, seed } = options;
  if (!spec.task || !spec.visitor) throw new Error('Visitor mode needs a task spec');
  const viewportOptions = VIEWPORTS[options.viewport];
  if (!viewportOptions) throw new Error(`Unknown viewport "${options.viewport}"`);

  const dials: Dials = { ...(options.dials ?? UNCALIBRATED_DIALS), timeBudgetSeconds: spec.visitor.patience_seconds };
  const derivedSeed = deriveSeed(spec.experiment, persona.id, options.viewport, seed);
  const rng = createRng(derivedSeed);
  const startedAt = new Date().toISOString();
  const budget = spec.visitor.patience_seconds;
  const maxSteps = spec.visitor.max_steps ?? 25;
  const pRead = 1 - Math.min(1, Math.max(0, persona.dials.skim_rate * dials.skimScale));
  const missRate = persona.dials.mis_tap_rate ?? 0.03;
  const entry = options.entryPath ?? '/';
  const success = spec.task.success;

  const steps: VisitorStep[] = [];
  const history: PastStep[] = [];
  const calls: LLMCallRecord[] = [];
  const memo = new Map<string, boolean>();
  let t = 0;
  let outcome: Trace['outcome'] | undefined;
  let outcomeNote = '';
  let requestSeen = false;
  let pressedWanted = '';
  let believedDone = false;
  let finalScreen = { url: '', title: '', text: [] as string[] };
  let pageHash = '';
  let pageWords = 0;

  const context = await sandbox.newContext(viewportOptions);
  try {
    if (success.request) {
      const want = success.request;
      context.on('request', (request: Request) => {
        const url = new URL(request.url());
        if (url.origin === sandbox.origin && url.pathname.includes(want.path_includes) && (!want.method || request.method() === want.method.toUpperCase())) {
          requestSeen = true;
        }
      });
    }
    const page = await context.newPage();
    const response = await page.goto(`${sandbox.origin}${entry}`, { waitUntil: 'load' });
    if (response?.status() !== 200) throw new Error(`Entry page returned HTTP ${response?.status()}`);
    pageHash = createHash('sha256').update(await response.body()).digest('hex');
    t += LOAD_SECONDS;

    const completed = async (p: Page): Promise<boolean> => {
      if (success.request && requestSeen) return true;
      if (pressedWanted) return true;
      if (success.url_includes && new URL(p.url()).pathname.includes(success.url_includes)) return true;
      if (success.text_visible && (await p.getByText(success.text_visible, { exact: false }).first().isVisible().catch(() => false))) return true;
      return false;
    };
    const settle = async () => {
      await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    };

    while (!outcome) {
      const start = t;
      const o = await observe(page);
      finalScreen = { url: o.url, title: o.title, text: o.text.map((b) => b.text) };
      if (steps.length === 0) pageWords = countWords(o.text.map((b) => b.text).join(' '));
      const { seen, words } = skimScreen(o, pRead, rng, memo);
      t += (words / persona.dials.reading_wpm) * 60;

      const record = (action: string, cites: string, reason: string, result: string, extra: Partial<VisitorStep> = {}) => {
        steps.push({
          index: steps.length, url: o.url, scrollY: o.scrollY,
          visibleText: o.text, seenText: seen,
          elements: o.elements.map(({ n, kind, label }) => ({ n, kind, label })),
          action, cites, reason, result,
          simulatedSecondsStart: round(start), simulatedSecondsEnd: round(Math.min(t, budget)),
          ...extra,
        });
      };

      if (t >= budget) {
        t = budget;
        record('stop', '', 'patience ran out', 'time up');
        outcome = 'time_up';
        outcomeNote = 'ran out of patience';
        break;
      }
      if (steps.length >= maxSteps) {
        record('stop', '', 'step limit reached', 'gave up');
        outcome = 'gave_up';
        outcomeNote = `still going after ${maxSteps} steps`;
        break;
      }

      let screenshot: LLMImage | undefined;
      if (spec.visitor.screenshots) {
        await extractLayout(page); // marks body text so the screenshot can blur it
        const [screen] = await captureScreens(page, [o.scrollY], viewportOptions.viewport!.width > 600 ? 640 : 300);
        const bytes = Buffer.from(screen!.base64, 'base64');
        const sha = createHash('sha256').update(bytes).digest('hex');
        const ref = path.join('shots', spec.experiment, 'visitor', `${sha.slice(0, 16)}.jpg`);
        await mkdir(path.dirname(path.resolve(options.repoRoot, ref)), { recursive: true });
        await writeFile(path.resolve(options.repoRoot, ref), bytes, { flag: 'wx' }).catch((err) => {
          if (err.code !== 'EEXIST') throw err;
        });
        screenshot = { mediaType: screen!.mediaType, base64: screen!.base64, ref, sha256: sha };
      }

      const decision = await decide(llm, {
        persona, instruction: spec.task.instruction, observation: o, seenText: seen, history, secondsLeft: budget - t, screenshot,
      });
      calls.push(...decision.calls);
      const a = decision.action;
      const element = 'element' in a ? o.elements.find((e) => e.n === a.element) : undefined;
      const describe = element ? `${a.action} ${element.kind} "${element.label}"` : a.action;

      if (a.action === 'done') {
        // They think they finished. Whether they did is checked below, not taken on trust.
        record('done', a.cites, a.reason, 'stopped, believing the task was done');
        believedDone = true;
        outcome = (await completed(page)) ? 'completed' : 'thought_done';
        outcomeNote = outcome === 'completed' ? 'the task was completed' : 'believed the task was done, but the success check did not pass';
        break;
      }
      if (a.action === 'leave') {
        record('leave', a.cites, a.reason, 'left');
        outcome = 'left';
        outcomeNote = a.reason;
        break;
      }

      let result: string;
      if (a.action === 'scroll') {
        const before = o.scrollY;
        await page.evaluate((dy) => window.scrollBy(0, dy), Math.round(o.viewportHeight * dials.scrollFraction));
        t += dials.scrollSeconds;
        const after = await page.evaluate(() => Math.round(window.scrollY));
        result = after > before ? 'scrolled down' : 'nothing more below';
      } else if (element!.kind === 'link' && element!.goesTo === 'outside') {
        // Leaving for another site ends the visit. The request is never made.
        record(a.action, a.cites, a.reason, 'left for another site', { element: element!.n });
        // Some pages exist to send people somewhere. Then leaving for that place is the goal.
        const wanted = (success.leaves_to ?? []).find((part) => (element!.href ?? '').toLowerCase().includes(part.toLowerCase()));
        if (wanted) {
          outcome = 'completed';
          outcomeNote = `followed the link the page is for: "${element!.label}"`;
        } else {
          outcome = 'left';
          outcomeNote = `followed a link off the site: "${element!.label}"`;
        }
        break;
      } else if (rng() < missChance(element!, missRate)) {
        t += CLICK_SECONDS;
        result = 'missed the tap, nothing happened';
      } else if (a.action === 'type') {
        await page.locator(`[data-sdd-el="${element!.n}"]`).fill(a.text);
        t += 1 + a.text.length * TYPE_SECONDS_PER_CHAR;
        result = 'typed it in';
      } else {
        const urlBefore = page.url();
        await page.locator(`[data-sdd-el="${element!.n}"]`).click({ timeout: 5000 }).catch(() => {});
        await settle();
        t += CLICK_SECONDS;
        const moved = page.url() !== urlBefore;
        if (moved) t += LOAD_SECONDS;
        result = moved ? `went to ${new URL(page.url()).pathname}` : 'clicked, stayed on the same page';
        const label = element!.label.toLowerCase();
        if ((success.clicks ?? []).some((part) => label.includes(part.toLowerCase()))) pressedWanted = element!.label;
      }

      record(a.action, a.cites, a.reason, result, { element: element?.n, typed: a.action === 'type' ? a.text : undefined });
      history.push({ action: describe + (a.action === 'type' ? ` with "${a.text}"` : ''), result });
      sandbox.assertClean(); // hard rule 1: an outside request fails the run

      if (await completed(page)) {
        outcome = 'completed';
        outcomeNote = 'the task was completed';
      }
    }
  } finally {
    await context.close();
  }
  sandbox.assertClean();

  // A prose outcome is judged from the final screen, however the session
  // ended. The judge sees the screen and the expected outcome, nothing else.
  if (success.outcome && outcome !== 'completed') {
    const verdict = await judgeOutcome(llm, success.outcome, finalScreen);
    calls.push(...verdict.calls);
    if (verdict.met) {
      outcome = 'completed';
      outcomeNote = `the final screen shows the outcome: ${verdict.note}`;
    } else if (believedDone) {
      outcome = 'thought_done';
      outcomeNote = `believed the task was done, but the final screen does not show it: ${verdict.note}`;
    } else {
      outcomeNote = `${outcomeNote}. Final screen: ${verdict.note}`;
    }
  }

  const size = viewportOptions.viewport!;
  const usd = calls.reduce((sum, c) => sum + c.response.costUsd, 0);
  const done = outcome === 'completed';
  const last = steps.at(-1);
  const trace: Trace = {
    schema: 'sdd-trace/1',
    runId: `${startedAt.replace(/[:.]/g, '-')}_${persona.id}_${options.viewport}_s${seed}`,
    ...(options.batch ? { batch: options.batch } : {}),
    experiment: spec.experiment,
    mode: 'visitor',
    startedAt,
    page: { path: `${sandbox.origin}${entry}`, sha256: pageHash, words: pageWords },
    persona,
    personaSet: options.personaSet ?? 'working',
    viewport: { name: options.viewport, width: size.width, height: size.height },
    seed,
    derivedSeed,
    dials: { ...dials, calibrated: false },
    steps: [],
    visitorSteps: steps,
    recalled: [],
    outcome: outcome!,
    simulatedSeconds: round(Math.min(t, budget)),
    // "Where they stopped": the page they were on when the visit ended.
    deepestSection: last ? last.url : entry,
    answers: [{ id: 'task', ask: spec.task.goal, answer: `${outcome}: ${outcomeNote}` }],
    // Graded by the engine from what the browser did. No judge model is involved.
    grades: [{ questionId: 'task', pass: done, requiredMet: [done], bonusMet: [], note: done ? 'complete' : outcomeNote }],
    llmCalls: calls,
    cost: {
      usd,
      inputTokens: calls.reduce((s, c) => s + c.response.usage.inputTokens + c.response.usage.cacheReadTokens + c.response.usage.cacheWriteTokens, 0),
      outputTokens: calls.reduce((s, c) => s + c.response.usage.outputTokens, 0),
    },
    sandbox: sandbox.record(),
  };
  validateTrace(trace, ['task']);
  return trace;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
