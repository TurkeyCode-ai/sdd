// Talker mode: one persona, one spoken conversation, one trace.
//
// This is the brain-only layer. The person's words reach the product as
// clean text, so nothing here tests hearing: no microphone, no room, no
// speech recognition. It tests what the product does once it has understood
// the words.
//
// The engine, not the persona model, decides whether the person got what
// they came for: from what the product did (its events) and, for a prose
// outcome, from a judge that reads the transcript.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { judgeConversation } from '../../judge/conversation.ts';
import type { LLM, LLMCallRecord } from '../llm/types.ts';
import { countWords, UNCALIBRATED_DIALS, type Dials } from '../reader/skim.ts';
import { deriveSeed } from '../rng.ts';
import type { Persona, Spec } from '../spec.ts';
import { validateTrace, type TalkerTurn, type Trace } from '../trace.ts';
import { decideTalker, type Exchange } from './decide.ts';
import { assertLoopback, type World, type WorldEvent } from './world.ts';

export interface TalkerRunOptions {
  spec: Spec;
  persona: Persona;
  personaSet?: 'working' | 'holdout';
  seed: number;
  world: World;
  /** The adapter file, hashed into the trace so a change of referee is visible. */
  worldFile: string;
  target: string;
  llm: LLM;
  batch?: string;
  dials?: Dials;
}

/** Ordinary conversational pace. Uncalibrated. */
const SPEAK_WPM = 150;
const LISTEN_WPM = 160;

export async function runTalker(options: TalkerRunOptions): Promise<Trace> {
  const { spec, persona, world, llm, seed } = options;
  if (!spec.task || !spec.talker) throw new Error('Talker mode needs a conversation spec');
  assertLoopback(options.target);

  const success = spec.task.success;
  const budget = spec.talker.patience_seconds;
  const maxTurns = spec.talker.max_turns ?? 6;
  const dials: Dials = { ...(options.dials ?? UNCALIBRATED_DIALS), timeBudgetSeconds: budget };
  const startedAt = new Date().toISOString();
  // Local wall-clock time, for the person and for the judge: "tonight" means something only against a clock.
  const now = new Date().toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  const turns: TalkerTurn[] = [];
  const exchanges: Exchange[] = [];
  const calls: LLMCallRecord[] = [];
  const allEvents: WorldEvent[] = [];
  let t = 0;
  let outcome: Trace['outcome'] | undefined;
  let outcomeNote = '';
  let believedDone = false;

  const toolSeen = () => !success.tool_called || allEvents.some((e) => e.name.includes(success.tool_called!));

  const conversation = await world.open({ target: options.target, persona, seed });
  try {
    while (!outcome) {
      const start = t;
      if (t >= budget) {
        turns.push({ index: turns.length, action: 'stop', said: '', cites: '', reason: 'patience ran out', heard: '', events: [], waitSeconds: 0, simulatedSecondsStart: round(budget), simulatedSecondsEnd: round(budget) });
        t = budget;
        outcome = 'time_up';
        outcomeNote = 'ran out of patience';
        break;
      }
      if (exchanges.length >= maxTurns) {
        turns.push({ index: turns.length, action: 'stop', said: '', cites: '', reason: 'turn limit reached', heard: '', events: [], waitSeconds: 0, simulatedSecondsStart: round(t), simulatedSecondsEnd: round(t) });
        outcome = 'gave_up';
        outcomeNote = `still going after ${maxTurns} turns`;
        break;
      }

      const decision = await decideTalker(llm, {
        persona, wants: spec.task.instruction ?? spec.task.goal, talkingTo: spec.talker.talking_to ?? 'a voice assistant', exchanges, secondsLeft: budget - t, now,
      });
      calls.push(...decision.calls);
      const a = decision.action;

      if (a.action === 'done' || a.action === 'leave') {
        turns.push({ index: turns.length, action: a.action, said: '', cites: a.cites, reason: a.reason, heard: '', events: [], waitSeconds: 0, simulatedSecondsStart: round(start), simulatedSecondsEnd: round(start) });
        believedDone = a.action === 'done';
        outcome = a.action === 'done' ? 'thought_done' : 'left'; // settled below, once the success checks have run
        outcomeNote = a.reason;
        break;
      }

      t += (countWords(a.text) / SPEAK_WPM) * 60;
      const heard = await conversation.say(a.text);
      allEvents.push(...heard.events);
      t += heard.waitSeconds + (countWords(heard.reply) / LISTEN_WPM) * 60;
      turns.push({
        index: turns.length, action: 'say', said: a.text, cites: a.cites, reason: a.reason,
        ...(heard.heardAs !== undefined ? { heardAs: heard.heardAs } : {}),
        heard: heard.reply, events: heard.events, waitSeconds: round(heard.waitSeconds),
        simulatedSecondsStart: round(start), simulatedSecondsEnd: round(Math.min(t, budget)),
      });
      exchanges.push({ said: a.text, heard: heard.reply });

      // With only a mechanical check, the moment the product does it the task is complete.
      if (success.tool_called && !success.outcome && toolSeen()) {
        outcome = 'completed';
        outcomeNote = `the product ran ${success.tool_called}`;
      }
    }
  } finally {
    await conversation.close();
  }

  // Settle the outcome. Every check that the spec sets has to hold: the
  // product did the thing, and the transcript shows the outcome.
  if (outcome !== 'completed') {
    const how = outcomeNote;
    let met = toolSeen();
    let why = met ? '' : `the product never ran ${success.tool_called}`;
    if (met && success.outcome) {
      const verdict = await judgeConversation(llm, success.outcome, now, turns.filter((x) => x.action === 'say').map((x) => ({ said: x.said, heard: x.heard, events: x.events })));
      calls.push(...verdict.calls);
      met = verdict.met;
      why = verdict.note;
    } else if (met && !success.tool_called) {
      met = false; // nothing to check against: the spec loader refuses this, kept as a guard
    }
    if (met) {
      outcome = 'completed';
      outcomeNote = success.outcome ? `the transcript shows the outcome: ${why}` : `the product ran ${success.tool_called}`;
    } else if (believedDone) {
      outcome = 'thought_done';
      outcomeNote = `believed it worked, but it did not: ${why}`;
    } else {
      outcomeNote = `${how}. Check: ${why}`;
    }
  }

  const usd = calls.reduce((sum, c) => sum + c.response.costUsd, 0);
  const done = outcome === 'completed';
  const spoken = turns.filter((x) => x.action === 'say').length;
  const trace: Trace = {
    schema: 'sdd-trace/1',
    runId: `${startedAt.replace(/[:.]/g, '-')}_${persona.id}_voice_s${seed}`,
    ...(options.batch ? { batch: options.batch } : {}),
    experiment: spec.experiment,
    mode: 'talker',
    startedAt,
    page: { path: `${options.target} (conversation)`, sha256: createHash('sha256').update(await readFile(options.worldFile)).digest('hex'), words: 0 },
    persona,
    personaSet: options.personaSet ?? 'working',
    viewport: { name: 'voice', width: 0, height: 0 },
    seed,
    derivedSeed: deriveSeed(spec.experiment, persona.id, 'voice', seed),
    dials: { ...dials, calibrated: false },
    steps: [],
    talkerTurns: turns,
    recalled: [],
    outcome: outcome!,
    simulatedSeconds: round(Math.min(t, budget)),
    // "Where they stopped": how many lines they had spoken when it ended.
    deepestSection: `after ${spoken} ${spoken === 1 ? 'line' : 'lines'}`,
    answers: [{ id: 'task', ask: spec.task.goal, answer: `${outcome}: ${outcomeNote}` }],
    grades: [{ questionId: 'task', pass: done, requiredMet: [done], bonusMet: [], note: done ? 'complete' : outcomeNote }],
    llmCalls: calls,
    cost: {
      usd,
      inputTokens: calls.reduce((s, c) => s + c.response.usage.inputTokens + c.response.usage.cacheReadTokens + c.response.usage.cacheWriteTokens, 0),
      outputTokens: calls.reduce((s, c) => s + c.response.usage.outputTokens, 0),
    },
    sandbox: { origin: options.target, violations: 0 },
  };
  validateTrace(trace, ['task']);
  return trace;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
