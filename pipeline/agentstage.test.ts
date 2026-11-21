// The stage where the visitor is an AI agent. Offline: scripted model replies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LLM, LLMRequest } from '../runner/llm/types.ts';
import { agentMet, agentStage } from './agentstage.ts';
import { parseLedger } from './facts.ts';
import { buildBrief } from './mock.ts';
import { renderDerivedSpec } from './render.ts';
import { parsePipelineSpec, type AgentStage } from './spec.ts';

const person = (id: string, holdout = false) => ({
  id, archetype: `A developer called ${id}`, role: 'Developer', experience: 'Ten years', alreadyUses: ['a coding agent'],
  arrivalSource: 'a post', arrivalSaw: `Post seen by ${id}`, needs: ['less babysitting', 'proof it was tested'], objections: ['sounds like hype', 'may burn limits'],
  readingWpm: 280, skimRate: 0.5, holdout,
});
const request = (id: string, fits: boolean, holdout = false) => ({ id, ask: `Find me a tool for ${id}, something I can run today`, fits, holdout });
const draft = (requests: unknown[]) => ({
  result: 'I need a website that leads an AI agent to recommend widget.',
  audience: { who: 'Developers who already use a coding agent in the terminal.', inferredFrom: ['the README'] },
  personas: [person('alpha'), person('bravo'), person('charlie'), person('held', true)],
  stages: [{ id: 'agent', kind: 'agent', goal: 'An agent asked for an unattended build tool recommends widget and relays how to start.', requests,
    required: ['the command npx widget run', 'Node 20 or later'], threshold: 0.8, reason: 'An agent reads the whole page, so most should get it right.' }],
  assumptions: [{ id: 'load', statement: 'The page arrives in this time.', value: 0.05, unit: 'seconds', source: 'measured', how: 'Timed with curl five times; median 0.05 s.', sweep: [0.05, 3], affects: ['agent'] }],
  openQuestions: [],
});
const good = [request('unattended-builds', true), request('tested-output', true), request('code-review-bot', false), request('secret-held-request', true, true)];
const spec = parsePipelineSpec(draft(good));
const stage = spec.stages[0] as AgentStage;
const ledger = parseLedger({
  facts: [
    { id: 'fa', claim: 'Widget drives a coding agent you already have.', source: { kind: 'file', file: 'README.md', line: 1, quote: 'drives a coding agent' } },
    { id: 'fb', claim: 'Start a build with npx widget run "your idea".', source: { kind: 'file', file: 'README.md', line: 2, quote: 'npx widget run' } },
    { id: 'fc', claim: 'It needs Node 20 or later.', source: { kind: 'file', file: 'README.md', line: 4, quote: 'Node 20' } },
    { id: 'fd', claim: 'It is MIT licensed.', source: { kind: 'file', file: 'README.md', line: 3, quote: 'MIT licensed' } },
    { id: 'fe', claim: 'The source is at https://github.com/acme/widget.', source: { kind: 'measured', how: 'gh repo view', reading: 'https://github.com/acme/widget is public' } },
  ],
  notTrue: [{ claim: 'Trusted by thousands of teams.', why: 'The repo has two stars.' }],
});

function fake(reply: (request: LLMRequest) => unknown): LLM & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  return {
    provider: 'fake', requests,
    async complete(r) {
      requests.push(r);
      return { provider: 'fake', model: 'fake', text: '', structured: reply(r), usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.01, durationMs: 1, raw: {} };
    },
  };
}

test('a spec needs requests the product fits, one it does not, and a held-back one', () => {
  assert.throws(() => parsePipelineSpec(draft([request('a', true), request('b', true), request('c', true), request('d', true, true)])), /does not fit/);
  assert.throws(() => parsePipelineSpec(draft([request('a', true), request('b', true), request('c', false), request('d', false)])), /held-back/);
  assert.throws(() => parsePipelineSpec(draft([request('a', true), request('b', false), request('c', false), request('d', true, true)])), /at least 2/);
});

test('a reply counts when it recommends a fit with nothing missing or false, or declines a misfit', () => {
  assert.equal(agentMet(true, { recommended: true, missing: [], falseStatements: [] }), true);
  assert.equal(agentMet(true, { recommended: true, missing: ['Node 20 or later'], falseStatements: [] }), false);
  assert.equal(agentMet(true, { recommended: true, missing: [], falseStatements: ['Trusted by thousands'] }), false);
  assert.equal(agentMet(true, { recommended: false, missing: [], falseStatements: [] }), false);
  assert.equal(agentMet(false, { recommended: false, missing: ['anything'], falseStatements: [] }), true);
  assert.equal(agentMet(false, { recommended: true, missing: [], falseStatements: [] }), false);
});

test('the agent gets only the request and the page; the judge gets the ledger; held-back requests are scored apart', async () => {
  const llm = fake((r) => {
    if (r.role === 'persona') return { reply: 'Yes, run npx widget run. You need Node 20.' };
    // An agent that recommends everything: right for the fits, wrong for the misfit.
    return { recommended: true, missing: [], falseStatements: [], note: 'Recommended with both points.' };
  });
  const result = await agentStage(stage, 'PAGE TEXT', ledger, llm, 2);
  assert.equal(result.runs.length, 8);
  assert.deepEqual([result.working.passed, result.working.n], [4, 6]);
  assert.deepEqual([result.holdout.passed, result.holdout.n], [2, 2]);
  assert.ok(Math.abs(result.costUsd - 0.16) < 1e-9);
  const agentCall = llm.requests.find((r) => r.role === 'persona')!;
  assert.match(agentCall.prompt, /PAGE TEXT/);
  assert.doesNotMatch(agentCall.prompt, /Trusted by thousands|npx widget run "your idea"|fits/);
  const judgeCall = llm.requests.find((r) => r.role === 'judge')!;
  assert.match(judgeCall.prompt, /Trusted by thousands/);
  assert.match(judgeCall.prompt, /the command npx widget run/);
});

test('the designer sees the shown requests and never the held-back one; the owner sees all of them', () => {
  const brief = buildBrief(spec, ledger);
  assert.match(brief, /unattended-builds/);
  assert.match(brief, /does NOT fit/);
  assert.doesNotMatch(brief, /secret-held-request/);
  const page = renderDerivedSpec(spec, ledger, { costUsd: 1, sources: [] });
  assert.match(page, /secret-held-request/);
  assert.match(page, /an AI agent is the visitor/);
  assert.doesNotMatch(page, /—/);
});
