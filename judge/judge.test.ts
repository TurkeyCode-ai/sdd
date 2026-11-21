import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { LLM } from '../runner/llm/types.ts';
import { loadSpec } from '../runner/spec.ts';
import { buildJudgeRequest, judgeAnswers } from './judge.ts';

const specFile = path.resolve(import.meta.dirname, '..', 'test/fixtures/sdd-site/specs/sdd-site.spec.yaml');
const answers = [
  { id: 'explain', ask: '', answer: 'It is a method.' },
  { id: 'contrast', ask: '', answer: 'Tests are pass or fail.' },
  { id: 'loop', ask: '', answer: 'Specify, simulate, score.' },
];

test('every rubric element reaches the judge as readable text', async () => {
  const spec = await loadSpec(specFile);
  for (const q of spec.questions) {
    for (const line of [...q.rubric.required, ...(q.rubric.bonus ?? [])]) assert.equal(typeof line, 'string');
  }
  // This line is a one-key map in YAML. It once reached the judge as "[object Object]".
  assert.deepEqual(spec.questions.find((q) => q.id === 'loop')!.rubric.required, [
    'at least 3 of: specify, simulate, score, revise, calibrate',
  ]);
  const { prompt } = buildJudgeRequest(spec.questions, answers);
  assert.ok(!prompt.includes('[object'));
  assert.ok(prompt.includes('at least 3 of: specify, simulate, score, revise, calibrate'));
});

test('the judge request holds questions, answers, and rubric only', async () => {
  const spec = await loadSpec(specFile);
  const request = buildJudgeRequest(spec.questions, answers);
  assert.equal(request.role, 'judge');
  const shown = request.system + request.prompt;
  for (const hidden of ['site/index.html', 'mobile', 'desktop', 'seed', 'persona', 'backend', 'sha256']) {
    assert.ok(!shown.toLowerCase().includes(hidden), `judge prompt mentions "${hidden}"`);
  }
});

test('a pass needs every required element, and a malformed reply is an error', async () => {
  const spec = await loadSpec(specFile);
  let judgeCalls = 0;
  const e = (met: boolean) => ({ evidence: 'quoted words', met });
  const reply = (...replies: unknown[]): LLM => ({
    provider: 'fake',
    complete: async () => ({
      provider: 'fake', model: 'fake', text: '', structured: { grades: replies[Math.min(judgeCalls++, replies.length - 1)] },
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0, durationMs: 0, raw: {},
    }),
  });

  const { grades } = await judgeAnswers(
    reply([
      { id: 'explain', required: [e(true), e(false)], bonus: [e(true)], note: 'x' },
      { id: 'contrast', required: [e(true), e(true)], bonus: [], note: 'x' },
      { id: 'loop', required: [e(true)], bonus: [], note: 'x' },
    ]),
    spec.questions,
    answers,
  );
  assert.deepEqual(grades.map((g) => g.pass), [false, true, true]);

  // An incomplete reply is retried with the same request, and every attempt is kept.
  const complete = [
    { id: 'explain', required: [e(true), e(true)], bonus: [e(false)], note: 'x' },
    { id: 'contrast', required: [e(true), e(true)], bonus: [], note: 'x' },
    { id: 'loop', required: [e(false)], bonus: [], note: 'x' },
  ];
  judgeCalls = 0;
  const retried = await judgeAnswers(reply(complete.slice(0, 1), complete), spec.questions, answers);
  assert.equal(retried.calls.length, 2);
  assert.deepEqual(retried.calls[0]!.request, retried.calls[1]!.request);
  assert.deepEqual(retried.grades.map((g) => g.pass), [true, true, false]);

  // Still incomplete after three attempts is an error, not a guess.
  judgeCalls = 0;
  await assert.rejects(judgeAnswers(reply(complete.slice(0, 1)), spec.questions, answers), /malformed/);
  assert.equal(judgeCalls, 3);
});
