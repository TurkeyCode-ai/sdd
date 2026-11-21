// The "agent" stage: the visitor is an AI coding agent, not a person.
//
// A developer asks their agent for something. The agent fetches the page, reads
// all of its text (no layout, no images, no time limit) and replies to its
// developer. A judge then reads the reply: did it recommend the product for
// this request, did it state what a recommendation has to get right, and did
// it say anything the ledger does not support.
//
// Some requests are ones the product does not fit. For those the right reply
// is not to recommend it, so a page that oversells scores worse, not better.

import type { LLM } from '../runner/llm/types.ts';
import { wilson, type Interval } from '../scorer/stats.ts';
import type { Ledger } from './facts.ts';
import type { AgentStage } from './spec.ts';

const AGENT_SYSTEM = `You are an AI coding agent working for a developer in their terminal. Your developer asked you for something. You searched and fetched one web page. Its text is below.

Reply to your developer the way you would in the session, in a few sentences:
- Say whether this is what they asked for.
- If it is, say whether they should try it, exactly what to run, and what they need in place first.
- If it is not a fit for what they asked, say so plainly and do not recommend it for that.
Use only what the page says about the product. Do not add anything from memory, and do not guess at what the page leaves out: if something they need to know is missing, say it is not stated.`;

const JUDGE_SYSTEM = `You grade one reply an AI coding agent gave its developer after reading a product's web page.

You get what the developer asked, the agent's reply, the points a recommendation has to get right, and a ledger of true statements about the product with a list of statements that are not true.
- recommended: true only if the reply tells the developer to try or use the product for what they asked. "It could work but I would not use it for this" is false.
- missing: each required point the reply does not state. Rewording is fine. A command must be given as written.
- falseStatements: anything the reply says about the product that the ledger does not support or that matches the "not true" list. Quote the reply. Saying that something is not stated on the page is not a false statement.
Grade the reply only. Do not reward or punish style.`;

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    recommended: { type: 'boolean' },
    missing: { type: 'array', items: { type: 'string' } },
    falseStatements: { type: 'array', items: { type: 'string' } },
    note: { type: 'string', description: 'One line on why.' },
  },
  required: ['recommended', 'missing', 'falseStatements', 'note'],
  additionalProperties: false,
};

export interface AgentRun {
  request: string;
  holdout: boolean;
  fits: boolean;
  n: number;
  reply: string;
  recommended: boolean;
  missing: string[];
  falseStatements: string[];
  /** Fits: recommended, nothing required missing, nothing false. Does not fit: not recommended. */
  met: boolean;
  note: string;
  costUsd: number;
}

export interface AgentResult {
  runs: AgentRun[];
  working: Interval;
  holdout: Interval;
  costUsd: number;
}

/** Whether one graded reply counts. Decided by code from what the judge reported. */
export function agentMet(fits: boolean, graded: { recommended: boolean; missing: string[]; falseStatements: string[] }): boolean {
  if (!fits) return !graded.recommended;
  return graded.recommended && graded.missing.length === 0 && graded.falseStatements.length === 0;
}

async function once(stage: AgentStage, request: AgentStage['requests'][number], n: number, pageText: string, ledger: Ledger, llm: LLM): Promise<AgentRun> {
  const base = { request: request.id, holdout: request.holdout, fits: request.fits, n };
  try {
    const answer = await llm.complete({
      role: 'persona',
      system: AGENT_SYSTEM,
      prompt: [`# What your developer asked`, '', request.ask, '', '# The page you fetched', '', pageText].join('\n'),
      schema: { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false },
    });
    const reply = (answer.structured as { reply?: string } | undefined)?.reply ?? answer.text;
    const graded = await llm.complete({
      role: 'judge',
      system: JUDGE_SYSTEM,
      prompt: [
        '# What the developer asked', '', request.ask, '',
        '# The agent\'s reply', '', reply, '',
        '# A recommendation has to get these right', '', ...stage.required.map((r) => `- ${r}`), '',
        '# True statements', '', ...ledger.facts.map((f) => `- ${f.claim}`), '',
        '# Not true', '', ...ledger.notTrue.map((x) => `- ${x.claim}`),
      ].join('\n'),
      schema: JUDGE_SCHEMA,
    });
    const g = (graded.structured ?? {}) as { recommended?: boolean; missing?: string[]; falseStatements?: string[]; note?: string };
    const clean = { recommended: g.recommended === true, missing: g.missing ?? [], falseStatements: g.falseStatements ?? [] };
    return { ...base, reply, ...clean, met: agentMet(request.fits, clean), note: g.note ?? '', costUsd: answer.costUsd + graded.costUsd };
  } catch (err) {
    return { ...base, reply: '', recommended: false, missing: [], falseStatements: [], met: false, note: `error: ${(err as Error).message.slice(0, 200)}`, costUsd: 0 };
  }
}

/** Every request, several times each. Held-back requests are scored the same way and reported as a rate only. */
export async function agentStage(stage: AgentStage, pageText: string, ledger: Ledger, llm: LLM, runsPerRequest: number, concurrency = 4): Promise<AgentResult> {
  const jobs = stage.requests.flatMap((r) => Array.from({ length: runsPerRequest }, (_, i) => ({ r, n: i + 1 })));
  const runs: AgentRun[] = [];
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      runs.push(await once(stage, job.r, job.n, pageText, ledger, llm));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  runs.sort((a, b) => a.request.localeCompare(b.request) || a.n - b.n);
  const rate = (set: AgentRun[]) => wilson(set.filter((r) => r.met).length, set.length);
  return { runs, working: rate(runs.filter((r) => !r.holdout)), holdout: rate(runs.filter((r) => r.holdout)), costUsd: runs.reduce((s, r) => s + r.costUsd, 0) };
}
