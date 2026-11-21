// Step 4, the design side: a designer that writes cheap static mocks, and the
// guardrails every mock has to clear before it is scored.
//
// The designer is one model call with no tools. It is handed the brief as
// text and returns HTML. It cannot open a file, so it cannot read the
// held-back people or touch the referee, whatever it is told.
//
// The guardrails are the owner's rules and nothing more: true claims only,
// each one from the repository; no em dashes; links stay in the owner's own
// places. Outside requests are blocked when visitors see the page.

import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { LLM } from '../runner/llm/types.ts';
import type { AgentRunner } from './agent.ts';
import { checkCitations, type Ledger } from './facts.ts';
import type { PipelineSpec, Stage } from './spec.ts';

/** What a designer may know: the result, the audience, the people it may see, what each stage asks, and the ledger. */
export function buildBrief(spec: PipelineSpec, ledger: Ledger, places: string[] = ownPlaces(spec, ledger)): string {
  const working = spec.personas.filter((p) => !p.holdout);
  const stage = (s: Stage): string => {
    if (s.kind === 'read') {
      return `- Reading: ${s.goal} Visitors skim for ${s.timeBudgetSeconds} seconds on ${s.viewports.join(' and ')}, then answer from memory:\n${s.questions.map((q) => `  - ${q.ask}`).join('\n')}`;
    }
    if (s.kind === 'decide') {
      const actions = [...s.success.leavesTo.map((a) => `a link to an address that includes ${a}`), ...s.success.clicks.map((c) => `a control labelled with "${c}"`)];
      return `- Deciding: ${s.goal} Nobody asks them to act, and leaving is the default. It counts only if they use: ${actions.join('; ')}.`;
    }
    if (s.kind === 'agent') {
      const shown = s.requests.filter((r) => !r.holdout);
      return [
        `- AI agents as visitors: ${s.goal} A developer asks their coding agent for something. The agent reads this page's whole text, with no layout or images, and replies to its developer. Developers ask things like:`,
        ...shown.map((r) => `  - "${r.ask}" (${r.fits ? 'the product fits this' : 'the product does NOT fit this'})`),
        `  When the product fits, it counts if the agent recommends it, says nothing false, and gets these right: ${s.required.join('; ')}.`,
        '  When the product does not fit, it counts only if the agent does not recommend it. So say plainly what the product is not for. Other requests you are not shown are tried too.',
      ].join('\n');
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
    '# What has been checked as true about the product',
    '',
    'Each of these is cited to the repository. Prefer them. Anything else you say is checked against the repository before the page is scored.',
    '',
    ...ledger.facts.map((f) => `- ${f.claim}`),
    '',
    '# The owner\'s own places, the only ones you may link to',
    '',
    ...places.map((a) => `- ${a}`),
    '',
    '# Things you must not say, because they are false or not true yet',
    '',
    ...ledger.notTrue.map((n) => `- ${n.claim} (${n.why})`),
    '',
  ].join('\n');
}

const DESIGNER_SYSTEM = `You design one static web page. It is a cheap stand-in used to test an idea before anything real is built.

What you return
- One complete HTML document, with its CSS in a <style> element.
- It must work on a phone and on a desktop.
- When visitors see the page, every request to anywhere outside it is blocked. Anything you load from elsewhere (a font, an image, a script) will simply not appear, so the page has to stand without it.

How it is judged
- Simulated visitors skim it. They take in headings and the first words of things, skip much of the body text, and leave when nothing speaks to why they came. Then they are asked questions from memory, or they decide on their own whether to act, or a developer follows the page's instructions at a terminal on a clean machine, or an AI agent reads the whole text for its developer.
- Put what matters where a skimmer's eye lands. Say the true thing plainly. Do not repeat the same sentence in several places, and do not stuff headings.

The owner's rules. Breaking one fails the page whatever it scores.
- True claims only. Every statement about the product comes from its repository. The brief lists what has been checked so far; anything you say beyond it is checked against the repository, and the page is thrown out if the repository does not support it. No invented features, numbers, quotes or users.
- Nothing from the list of things you must not say.
- No em dashes anywhere.
- Links stay in the owner's own places, which the brief lists. Do not link anywhere else.`;

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
      'Revise the page so that more of these visitors get there.',
      'Change as little as you can. For every question that already meets what it needs, keep the words that answer it exactly as they are and where they are: do not reword them, shorten them or move them further down. Change only what the findings point at for the questions that fall short. A skimmer holds only a few things, so do not win one answer by burying another.');
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

/**
 * The owner's own places, which a page may link to: any they named, the addresses
 * the decide stage counts, and addresses that appear in the ledger.
 */
export function ownPlaces(spec: PipelineSpec, ledger: Ledger, named: string[] = []): string[] {
  const fromStages = spec.stages.flatMap((s) => (s.kind === 'decide' ? s.success.leavesTo : []));
  const fromLedger = ledger.facts.flatMap((f) => [...`${f.claim} ${f.source.kind === 'file' ? f.source.quote : f.source.reading}`.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0].replace(/^https?:\/\//, '').replace(/[.,]$/, '')));
  return [...new Set([...named, ...fromStages, ...fromLedger])];
}

/**
 * The owner's rules that plain code can check: no em dashes, and links stay in
 * the owner's own places. An empty list means the page goes on to the claims review.
 * Outside files are not a failure here. They are blocked when visitors see the page.
 */
export function mechanicalProblems(html: string, places: string[]): string[] {
  const problems: string[] = [];
  if (html.includes('—')) problems.push('The page contains an em dash.');
  for (const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)) {
    const href = m[1]!;
    if (!/^https?:\/\//i.test(href)) continue;
    // "www." is not a different place, and a path under one of the owner's places is still theirs.
    const bare = href.replace(/^https?:\/\//i, '').replace(/^www\./i, '').toLowerCase();
    if (!places.some((a) => bare.startsWith(a.replace(/^https?:\/\//i, '').replace(/^www\./i, '').toLowerCase()))) problems.push(`The page links to ${href}, which is outside the owner's own places (${places.join(', ')}).`);
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
export async function reviewClaims(llm: LLM, html: string, ledger: Ledger, alsoTrue: string[] = []): Promise<ClaimsReview> {
  const response = await llm.complete({
    role: 'judge',
    system: CLAIMS_SYSTEM,
    prompt: [
      '# True statements', '', ...ledger.facts.map((f) => `- ${f.claim}`), ...alsoTrue.map((c) => `- ${c}`), '',
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

// ---- Checking a statement against the repository itself ----

const VERIFY_TOOLS = ['Read', 'Glob', 'Grep', 'Write'];
export const VERIFIED_FILE = 'verified.json';

export interface RepoCheck {
  /** Statements the repository supports, each with where. These stop being violations. */
  supported: { statement: string; claim: string; file: string; line: number; quote: string }[];
  /** Statements that stay violations. */
  unsupported: { statement: string; why: string }[];
  costUsd: number;
}

/**
 * The owner's rule is that every statement comes from the repository, not that it
 * appears on a list someone wrote earlier. So a statement the ledger does not cover
 * gets looked up in the repository by a session that can read it. A statement
 * counts as supported only if it comes back with a file, a line and a quote, and
 * code then finds that quote at that place. Anything on the "not true" list stays out.
 */
export async function checkAgainstRepo(
  agent: AgentRunner, violations: { statement: string; why: string }[], ledger: Ledger, sourceDirs: string[], scratch: string, budgetUsd: number,
): Promise<RepoCheck> {
  if (violations.length === 0 || sourceDirs.length === 0) return { supported: [], unsupported: violations, costUsd: 0 };
  await rm(path.join(scratch, VERIFIED_FILE), { force: true });
  const run = await agent.run({
    name: 'claims checker',
    cwd: scratch,
    addDirs: sourceDirs,
    tools: VERIFY_TOOLS,
    budgetUsd,
    prompt: [
      'A web page about a product makes the statements below. A first review could not match them to a list of checked facts. Your job is to find out, from the product\'s own repository, whether each one is true.',
      '',
      `The repository is at: ${sourceDirs.join(', ')}. Read the code and the docs. Code wins over docs when they disagree.`,
      '',
      'For each statement decide:',
      '- supported: the repository shows it is true, with no stretch. Give the file (relative to the repository), the line number, and an exact quote of 8 or more characters copied from that line or the lines right next to it, and a one-sentence plain claim that says only what that code or text shows.',
      '- not supported: the repository does not show it, shows only part of it, or shows the opposite. Say why in one line.',
      'A number, a quote from a person, a customer or a comparison with another product is supported only if the repository itself contains it. Be strict: when unsure, it is not supported.',
      '',
      'These are known to be false or not true yet. Any statement that says one of them is not supported, whatever else you find:',
      ...ledger.notTrue.map((n) => `- ${n.claim} (${n.why})`),
      '',
      '# The statements',
      '',
      ...violations.map((v, i) => `${i + 1}. "${v.statement}" (first review: ${v.why})`),
      '',
      `Write your answer to the file ${VERIFIED_FILE} in the current folder, as JSON in this shape, one entry per statement in the same order:`,
      '[ { "n": 1, "supported": true, "claim": "...", "file": "src/x.ts", "line": 12, "quote": "..." }, { "n": 2, "supported": false, "why": "..." } ]',
    ].join('\n'),
  });
  let answers: { n?: number; supported?: boolean; claim?: string; file?: string; line?: number; quote?: string; why?: string }[] = [];
  try { answers = JSON.parse(await readFile(path.join(scratch, VERIFIED_FILE), 'utf8')); } catch { /* no usable answer: everything stays a violation */ }
  const supported: RepoCheck['supported'] = [];
  const unsupported: RepoCheck['unsupported'] = [];
  for (const [i, v] of violations.entries()) {
    const a = Array.isArray(answers) ? answers.find((x) => x?.n === i + 1) : undefined;
    if (a?.supported === true && typeof a.file === 'string' && typeof a.line === 'number' && typeof a.quote === 'string' && a.quote.trim().length >= 8 && typeof a.claim === 'string') {
      // The session's word is not enough. Code looks for the quote where it says it is.
      const problems = await checkCitations({ schema: ledger.schema, facts: [{ id: `checked-${i + 1}`, claim: a.claim, source: { kind: 'file', file: a.file, line: a.line, quote: a.quote } }], notTrue: [] }, sourceDirs);
      if (problems.length === 0) { supported.push({ statement: v.statement, claim: a.claim, file: a.file, line: a.line, quote: a.quote }); continue; }
      unsupported.push({ statement: v.statement, why: `${v.why} A citation was offered but did not check out: ${problems[0]}` });
      continue;
    }
    unsupported.push({ statement: v.statement, why: a?.why ? `${v.why} Checked against the repository: ${a.why}` : v.why });
  }
  return { supported, unsupported, costUsd: run.costUsd };
}
