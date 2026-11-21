// Step 4, the design side: a designer that writes cheap static mocks, and the
// guardrails every mock has to clear before it is scored.
//
// The designer is one model call with no tools. It is handed the brief as
// text and returns HTML. It cannot open a file, so it cannot read the
// held-back people or touch the referee, whatever it is told.

import type { LLM } from '../runner/llm/types.ts';
import type { Ledger } from './facts.ts';
import type { PipelineSpec, Stage } from './spec.ts';

/** What a designer may know: the result, the audience, the people it may see, what each stage asks, and the ledger. */
export function buildBrief(spec: PipelineSpec, ledger: Ledger): string {
  const working = spec.personas.filter((p) => !p.holdout);
  const stage = (s: Stage): string => {
    if (s.kind === 'read') {
      return `- Reading: ${s.goal} Visitors skim for ${s.timeBudgetSeconds} seconds on ${s.viewports.join(' and ')}, then answer from memory:\n${s.questions.map((q) => `  - ${q.ask}`).join('\n')}`;
    }
    if (s.kind === 'decide') {
      const actions = [...s.success.leavesTo.map((a) => `a link to an address that includes ${a}`), ...s.success.clicks.map((c) => `a control labelled with "${c}"`)];
      return `- Deciding: ${s.goal} Nobody asks them to act, and leaving is the default. It counts only if they use: ${actions.join('; ')}.`;
    }
    return `- Trying: ${s.goal} A developer at a terminal on a clean machine (${s.machine.preinstalled.join(', ')}; without: ${s.machine.notPresent.join(', ')}) gets only this page's text and follows it. It counts when: ${s.success.observable}`;
  };
  return [
    '# The result wanted',
    '',
    spec.result,
    '',
    '# Who it is for',
    '',
    spec.audience.who,
    '',
    '# Some of the people who will arrive',
    '',
    ...working.map((p) => `- ${p.archetype}. Arrives from ${p.arrivalSource} having seen: "${p.arrivalSaw}". Hopes for: ${p.needs.join('; ')}. Doubts: ${p.objections.join('; ')}. Skips ${Math.round(p.skimRate * 100)}% of body text.`),
    '',
    'Other people will arrive too. You are not told who they are.',
    '',
    '# What the page has to make happen',
    '',
    ...spec.stages.map(stage),
    '',
    '# Everything you may say about the product',
    '',
    'These statements are true and checked. Say nothing about the product that is not here.',
    '',
    ...ledger.facts.map((f) => `- ${f.claim}`),
    '',
    '# Things you must not say, because they are false or not true yet',
    '',
    ...ledger.notTrue.map((n) => `- ${n.claim} (${n.why})`),
    '',
  ].join('\n');
}

const DESIGNER_SYSTEM = `You design one static web page. It is a cheap stand-in used to test an idea before anything real is built.

What you return
- One complete HTML document. All CSS inline in a <style> element. No images, fonts, scripts or stylesheets loaded from anywhere. A few lines of inline script are allowed only for a button that copies a command.
- Links may go only to addresses given in the brief.
- It must work on a phone and on a desktop.

How it is judged
- Simulated visitors skim it. They take in headings and the first words of things, skip much of the body text, and leave when nothing speaks to why they came. Then they are asked questions from memory, or they decide on their own whether to act, or a developer follows the page's instructions at a terminal on a clean machine.
- Put what matters where a skimmer's eye lands. Say the true thing plainly. Do not repeat the same sentence in several places, and do not stuff headings.

Hard rules. Breaking one fails the page whatever it scores.
- Every statement about the product comes from the brief's list of true statements. No invented features, numbers, quotes, customers or comparisons.
- Nothing from the list of things you must not say.
- No em dashes anywhere.
- Commands a visitor is told to run must be ones the brief supports, written exactly.`;

export interface DesignInput {
  brief: string;
  iteration: number;
  /** The page being revised, and what happened when it was tried. Absent for the first design. */
  previous?: { html: string; findings: string };
  /** Why the last attempt was thrown out before scoring, if it was. */
  rejected?: string[];
}

export interface DesignOutput {
  html: string;
  notes: string;
  costUsd: number;
}

export async function designMock(llm: LLM, input: DesignInput): Promise<DesignOutput> {
  const parts = [input.brief];
  if (input.previous) {
    parts.push('# The page as it stands', '', '```html', input.previous.html, '```', '', '# What happened when visitors tried it', '', input.previous.findings, '',
      'Revise the page so that more of these visitors get there. Change what the findings point at. Keep what worked.');
  } else {
    parts.push('Design the first version of the page.');
  }
  if (input.rejected?.length) {
    parts.push('', '# Your last attempt was thrown out before it was scored', '', ...input.rejected.map((r) => `- ${r}`), '', 'Fix every one of these.');
  }
  const response = await llm.complete({
    role: 'reviser',
    system: DESIGNER_SYSTEM,
    prompt: parts.join('\n'),
    schema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'The complete HTML document.' },
        notes: { type: 'string', description: 'Two or three lines: what you did and why.' },
      },
      required: ['html', 'notes'],
      additionalProperties: false,
    },
  });
  const out = response.structured as { html?: string; notes?: string } | undefined;
  if (!out?.html || !/<html[\s>]/i.test(out.html)) throw new Error('The designer did not return an HTML document.');
  return { html: out.html, notes: out.notes ?? '', costUsd: response.costUsd };
}

// ---- Guardrails ----

/** The words a visitor could read: tags, styles and scripts removed. */
export function visibleText(html: string): string {
  return html
    .replace(/<(style|script|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/section|\/tr|\/pre)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .split('\n').map((line) => line.trim()).filter((line) => line.length > 0).join('\n');
}

/** Addresses a mock may link to: the ones the decide stage counts, and any that appear in the ledger. */
export function allowedLinks(spec: PipelineSpec, ledger: Ledger): string[] {
  const fromStages = spec.stages.flatMap((s) => (s.kind === 'decide' ? s.success.leavesTo : []));
  const fromLedger = ledger.facts.flatMap((f) => [...`${f.claim} ${f.source.kind === 'file' ? f.source.quote : f.source.reading}`.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0].replace(/^https?:\/\//, '').replace(/[.,]$/, '')));
  return [...new Set([...fromStages, ...fromLedger])];
}

/** Checks done by code. An empty list means the mock may go on to the claims review. */
export function mechanicalProblems(html: string, allowed: string[]): string[] {
  const problems: string[] = [];
  if (html.includes('—')) problems.push('The page contains an em dash.');
  if (/<link\b[^>]*rel=["']?stylesheet/i.test(html) || /@import/i.test(html)) problems.push('The page loads a stylesheet from elsewhere. All CSS must be inline.');
  if (/<script\b[^>]*\bsrc=/i.test(html)) problems.push('The page loads a script from elsewhere.');
  if (/<(img|video|audio|iframe|source|embed|object)\b[^>]*\b(src|data)=["']?(https?:)?\/\//i.test(html)) problems.push('The page loads media from elsewhere.');
  if (/url\(\s*["']?(https?:)?\/\//i.test(html)) problems.push('The CSS loads a file from elsewhere.');
  for (const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)) {
    const href = m[1]!;
    if (href.startsWith('#') || href.startsWith('/') || href.startsWith('mailto:')) continue;
    const bare = href.replace(/^https?:\/\//, '');
    if (!allowed.some((a) => bare.startsWith(a) || a.startsWith(bare.replace(/\/$/, '')))) problems.push(`The page links to ${href}, which is not an address from the brief.`);
  }
  return [...new Set(problems)];
}

const CLAIMS_SYSTEM = `You check a web page against a ledger of true statements about a product.

Go through what the page says about the product: what it is, what it does, what it needs, what it costs, numbers, comparisons, who uses it, and every command it tells a visitor to run.
- A statement passes if the ledger supports it. Rewording, summarising and leaving things out are fine.
- A statement fails if the ledger does not support it, if it goes further than the ledger does, or if it matches something on the "not true" list.
- Ordinary page furniture is not a claim: headings like "How it works", calls to action, the visitor's own situation.
Report only failures. Quote the page's words exactly.`;

export interface ClaimsReview {
  violations: { statement: string; why: string }[];
  costUsd: number;
}

/** The claims review: does the page say anything about the product that the ledger does not support? */
export async function reviewClaims(llm: LLM, html: string, ledger: Ledger): Promise<ClaimsReview> {
  const response = await llm.complete({
    role: 'judge',
    system: CLAIMS_SYSTEM,
    prompt: [
      '# True statements', '', ...ledger.facts.map((f) => `- ${f.claim}`), '',
      '# Not true', '', ...ledger.notTrue.map((n) => `- ${n.claim} (${n.why})`), '',
      '# The page, as a visitor reads it', '', visibleText(html),
    ].join('\n'),
    schema: {
      type: 'object',
      properties: {
        violations: {
          type: 'array',
          items: { type: 'object', properties: { statement: { type: 'string' }, why: { type: 'string' } }, required: ['statement', 'why'], additionalProperties: false },
        },
      },
      required: ['violations'],
      additionalProperties: false,
    },
  });
  const out = response.structured as { violations?: { statement: string; why: string }[] } | undefined;
  return { violations: out?.violations ?? [], costUsd: response.costUsd };
}
