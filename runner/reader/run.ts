// Reader mode: one persona, one session, one trace.
//
//   1. Load the page in the guarded browser at the persona's viewport.
//   2. Skim it for the time budget (skim.ts). Optionally screenshot each
//      screen the reader reached, with body text blurred.
//   3. Take the page away. Apply recall decay.
//   4. Ask the spec's questions, giving the model only what was recalled.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { devices, type BrowserContextOptions } from 'playwright';
import type { LLM, LLMImage } from '../llm/types.ts';
import { createRng, deriveSeed } from '../rng.ts';
import type { Sandbox } from '../sandbox/sandbox.ts';
import type { Persona, Spec } from '../spec.ts';
import { validateTrace, type Trace } from '../trace.ts';
import { answerFromMemory } from './answer.ts';
import { captureScreens, extractLayout, type Screen } from './extract.ts';
import { countWords, recall, skim, UNCALIBRATED_DIALS, type Dials } from './skim.ts';

export const VIEWPORTS: Record<string, BrowserContextOptions> = {
  mobile: devices['iPhone 13']!,
  desktop: { viewport: { width: 1280, height: 800 } },
};

export interface ReaderRunOptions {
  /** Repo root. spec.page is resolved against it. */
  repoRoot: string;
  spec: Spec;
  persona: Persona;
  personaSet?: 'working' | 'holdout';
  viewport: string;
  seed: number;
  /** Label for the page under test in the trace. Default: spec.page, or the URL. */
  pagePath?: string;
  /** Path to open on the sandbox origin. Default: /. */
  entryPath?: string;
  /** A sandbox that serves the page under test at /. */
  sandbox: Sandbox;
  llm: LLM;
  dials?: Dials;
  batch?: string;
  calibrated?: boolean;
}

export async function runReader(options: ReaderRunOptions): Promise<Trace> {
  const { spec, persona, sandbox, llm, seed } = options;
  const viewportOptions = VIEWPORTS[options.viewport];
  if (!viewportOptions) throw new Error(`Unknown viewport "${options.viewport}"`);

  const dials: Dials = { ...(options.dials ?? UNCALIBRATED_DIALS), timeBudgetSeconds: spec.reader.time_budget_seconds };
  const derivedSeed = deriveSeed(spec.experiment, persona.id, options.viewport, seed);
  const rng = createRng(derivedSeed);
  const startedAt = new Date().toISOString();
  const pagePath = options.pagePath ?? spec.page ?? `${sandbox.origin}${options.entryPath ?? '/'}`;

  // 1. The page, as rendered for this viewport. Everything that needs the
  // browser happens here: layout, the skim (which is pure), and screenshots
  // of the screens the reader got to.
  const context = await sandbox.newContext(viewportOptions);
  let layout, skimmed, pageSource: Buffer;
  let screens: Screen[] = [];
  try {
    const page = await context.newPage();
    const response = await page.goto(`${sandbox.origin}${options.entryPath ?? '/'}`, { waitUntil: 'load' });
    if (response?.status() !== 200) throw new Error(`Page under test returned HTTP ${response?.status()}`);
    pageSource = await response.body();
    await page.evaluate(() => document.fonts.ready);
    layout = await extractLayout(page);
    // 2. Skim. Seeded, and independent of the screenshots.
    skimmed = skim(layout.blocks, layout.viewportHeight, layout.pageHeight, persona.dials, dials, rng);
    if (spec.reader.screenshots) {
      const width = viewportOptions.viewport!.width;
      screens = await captureScreens(page, skimmed.steps.map((s) => s.scrollY), width > 600 ? 640 : 300);
    }
  } finally {
    await context.close();
  }
  sandbox.assertClean(); // hard rule 1: an outside request fails the run

  // 3. Forget a little. The browser is closed.
  const recalled = recall(skimmed.seen, skimmed.simulatedSeconds, dials, rng);

  // Screenshots are stored once per page, viewport, and scroll position, and
  // referred to from the trace.
  const pageHash = createHash('sha256').update(pageSource).digest('hex');
  const images: LLMImage[] = [];
  for (const screen of screens) {
    const ref = path.join('shots', spec.experiment, pageHash.slice(0, 12), options.viewport, `y${screen.scrollY}.jpg`);
    const bytes = Buffer.from(screen.base64, 'base64');
    await mkdir(path.dirname(path.resolve(options.repoRoot, ref)), { recursive: true });
    await writeFile(path.resolve(options.repoRoot, ref), bytes, { flag: 'wx' }).catch((err) => {
      if (err.code !== 'EEXIST') throw err;
    });
    images.push({ mediaType: screen.mediaType, base64: screen.base64, ref, sha256: createHash('sha256').update(bytes).digest('hex') });
  }

  // 4. Questions, from memory. The rubric stays behind.
  const questions = spec.questions.map(({ id, ask }) => ({ id, ask }));
  const { answers, call } = await answerFromMemory(llm, persona, recalled, questions, images);

  const size = viewportOptions.viewport!;
  const trace: Trace = {
    schema: 'sdd-trace/1',
    runId: `${startedAt.replace(/[:.]/g, '-')}_${persona.id}_${options.viewport}_s${seed}`,
    ...(options.batch ? { batch: options.batch } : {}),
    experiment: spec.experiment,
    mode: 'reader',
    startedAt,
    page: {
      path: pagePath,
      sha256: pageHash,
      words: countWords(layout.blocks.map((b) => b.text).join(' ')),
    },
    persona,
    personaSet: options.personaSet ?? 'working',
    viewport: { name: options.viewport, width: size.width, height: size.height },
    seed,
    derivedSeed,
    dials: { ...dials, calibrated: options.calibrated ?? false },
    steps: skimmed.steps,
    recalled,
    outcome: skimmed.outcome,
    simulatedSeconds: skimmed.simulatedSeconds,
    deepestSection: skimmed.deepestSection,
    answers,
    grades: null,
    llmCalls: [call],
    cost: {
      usd: call.response.costUsd,
      inputTokens: call.response.usage.inputTokens + call.response.usage.cacheReadTokens + call.response.usage.cacheWriteTokens,
      outputTokens: call.response.usage.outputTokens,
    },
    sandbox: sandbox.record(),
  };
  validateTrace(trace, spec.questions.map((q) => q.id));
  return trace;
}
