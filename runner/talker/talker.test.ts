// Talker mode with a scripted model and a scripted product, so the tests are
// free and pin down exactly what the engine decides.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { LLM, LLMRequest } from '../llm/types.ts';
import { loadPersona, loadSpec, type Spec } from '../spec.ts';
import { validateTrace } from '../trace.ts';
import { problemWith } from './decide.ts';
import { runTalker } from './run.ts';
import { assertLoopback, type Heard, type World } from './world.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const persona = await loadPersona(path.join(repoRoot, 'examples/waitlist/personas/working/skeptic.yaml'));
const worldFile = path.join(repoRoot, 'runner/talker/world.ts'); // any real file: only its hash is stored

const baseSpec = (success: NonNullable<Spec['task']>['success']): Spec => ({
  experiment: 'talker-test',
  kind: 'conversation',
  goal: 'A person sets a timer by asking',
  entry: { from: 'the kitchen', viewports: ['voice'] },
  task: { goal: 'Set a five minute timer', instruction: 'a five minute timer for the eggs', success },
  talker: { patience_seconds: 120, max_turns: 4, adapter: 'unused.ts' },
  reader: { time_budget_seconds: 120, answers_from: 'what_was_heard', may_scroll_back: false },
  personas: { working: '', holdout: '', runs_per_persona: 1 },
  questions: [{ id: 'task', ask: 'Set a five minute timer', rubric: { required: ['x'] } }],
  budget: { iterations: 0, usd: 1 },
});

/** A model that replies with the next scripted object. Persona and judge calls share the script, in order. */
function scripted(replies: object[]): LLM & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  let i = 0;
  return {
    provider: 'scripted',
    requests,
    async complete(request) {
      requests.push(request);
      const structured = replies[i++];
      if (!structured) throw new Error('script ran out');
      return { provider: 'scripted', model: 'none', text: '', structured, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.001, durationMs: 0, raw: null };
    },
  };
}

function product(replies: Heard[]): World & { heardLines: string[]; closed: boolean } {
  const state = { heardLines: [] as string[], closed: false };
  let i = 0;
  return Object.assign(state, {
    async open() {
      return {
        async say(text: string) { state.heardLines.push(text); return replies[i++] ?? { reply: '', events: [], waitSeconds: 1 }; },
        async close() { state.closed = true; },
      };
    },
  });
}

const run = (spec: Spec, llm: LLM, world: World) => runTalker({ spec, persona, seed: 1, world, worldFile, target: 'http://127.0.0.1:1', llm });

test('the product running the tool completes the task, whatever the person thinks', async () => {
  const world = product([{ reply: 'Done. Five minutes.', events: [{ name: 'timer__set_timer', detail: '{"minutes":5}' }], waitSeconds: 1.5 }]);
  const trace = await run(baseSpec({ tool_called: 'set_timer' }), scripted([{ action: 'say', text: 'set a timer for five minutes', cites: '', reason: 'r' }]), world);
  assert.equal(trace.outcome, 'completed');
  assert.equal(trace.mode, 'talker');
  assert.equal(trace.grades![0]!.pass, true);
  assert.deepEqual(world.heardLines, ['set a timer for five minutes']);
  assert.equal(world.closed, true);
  validateTrace(trace, ['task']);
});

test('a claim without the deed is not completed, even when the person believes it', async () => {
  const world = product([{ reply: 'Sure, your timer is set for five minutes.', events: [], waitSeconds: 1 }]);
  const llm = scripted([
    { action: 'say', text: 'five minute timer please', cites: '', reason: 'r' },
    { action: 'done', cites: 'your timer is set for five minutes', reason: 'He heard it was set.' },
  ]);
  const trace = await run(baseSpec({ tool_called: 'set_timer' }), llm, world);
  assert.equal(trace.outcome, 'thought_done');
  assert.equal(trace.grades![0]!.pass, false);
  assert.match(trace.answers[0]!.answer, /never ran set_timer/);
});

test('with a prose outcome too, the tool is not enough: the judge reads the transcript', async () => {
  const world = product([{ reply: 'Done. Fifty minutes on the clock.', events: [{ name: 'timer__set_timer', detail: '{"minutes":50}' }], waitSeconds: 1 }]);
  const llm = scripted([
    { action: 'say', text: 'five minute timer', cites: '', reason: 'r' },
    { action: 'leave', cites: 'Fifty minutes', reason: 'Wrong length.' },
    { evidence: 'timer__set_timer {"minutes":50}', met: false, note: 'The timer was set for 50 minutes, not 5.' },
  ]);
  const trace = await run(baseSpec({ tool_called: 'set_timer', outcome: 'A timer for five minutes is running.' }), llm, world);
  assert.equal(trace.outcome, 'left');
  assert.match(trace.answers[0]!.answer, /50 minutes/);
  // The judge saw the transcript and the events, not the persona.
  const judge = llm.requests.at(-1)!;
  assert.equal(judge.role, 'judge');
  assert.match(judge.prompt, /timer__set_timer/);
  assert.doesNotMatch(judge.prompt, new RegExp(persona.archetype.slice(0, 20)));
});

test('the persona model is never told what success is, and never sees events', async () => {
  const world = product([{ reply: 'What should I call it?', events: [{ name: 'secret_tool' }], waitSeconds: 1 }]);
  const llm = scripted([
    { action: 'say', text: 'timer five minutes', cites: '', reason: 'r' },
    { action: 'leave', cites: '', reason: 'Did not expect a question.' },
  ]);
  await run(baseSpec({ tool_called: 'set_timer' }), llm, world);
  for (const r of llm.requests) {
    assert.doesNotMatch(r.prompt + r.system, /set_timer|secret_tool/);
  }
});

test('speaking again must quote what was heard; an invented quote is sent back, then counts as leaving', async () => {
  const world = product([{ reply: 'I can do that.', events: [], waitSeconds: 1 }]);
  const llm = scripted([
    { action: 'say', text: 'timer', cites: '', reason: 'r' },
    { action: 'say', text: 'ok do it', cites: 'your timer is ready', reason: 'r' },
    { action: 'done', cites: 'timer has started', reason: 'r' },
  ]);
  const trace = await run(baseSpec({ tool_called: 'set_timer' }), llm, world);
  assert.equal(trace.outcome, 'left');
  assert.equal(world.heardLines.length, 1);
});

test('silence can be answered once more but never believed', () => {
  const input = { persona, wants: 'x', talkingTo: 'y', secondsLeft: 60, now: 'Thursday, 3:00 PM', exchanges: [{ said: 'timer', heard: '' }] };
  assert.equal(problemWith({ action: 'say', text: 'hello?', cites: '', reason: '' }, input), null);
  assert.match(problemWith({ action: 'done', cites: '', reason: '' }, input)!, /heard nothing/);
});

test('the turn limit ends a conversation that goes nowhere', async () => {
  const again = { reply: 'Could you say that again?', events: [], waitSeconds: 1 };
  const world = product([again, again, again, again]);
  const say = { action: 'say', text: 'timer five minutes', cites: 'say that again', reason: 'r' };
  const trace = await run(baseSpec({ tool_called: 'set_timer' }), scripted([{ ...say, cites: '' }, say, say, say]), world);
  assert.equal(trace.outcome, 'gave_up');
  assert.equal(world.heardLines.length, 4);
});

test('the target must be on this machine', () => {
  assert.throws(() => assertLoopback('https://example.com'), /loopback/);
  assert.ok(assertLoopback('http://127.0.0.1:3055'));
});

test('a conversation spec loads, and refuses screen checks', async () => {
  const spec = await loadSpec(path.join(repoRoot, 'test/fixtures/conversation/spec.yaml'));
  assert.equal(spec.kind, 'conversation');
  assert.deepEqual(spec.entry.viewports, ['voice']);
  assert.equal(spec.questions[0]!.id, 'task');
});
