// Judges whether a spoken conversation ended with the expected outcome.
// Part of the referee.
//
// The judge sees the expected outcome and the transcript: what the person
// said, what the product said back, and what the product did (its events).
// It does not see the persona, the persona model's reasoning, or whether the
// person believed it worked.

import type { LLM, LLMCallRecord, LLMRequest } from '../runner/llm/types.ts';

export interface TranscriptTurn {
  said: string;
  heard: string;
  events: { name: string; detail?: string }[];
}

const SYSTEM = `You check whether a conversation between a person and a voice assistant ended with the expected outcome. You are strict.

You get the expected outcome and the transcript. Each turn has what the person said, what the assistant said back, and a list of what the assistant actually did (tools it ran). Decide whether the transcript shows the expected outcome.

Rules:
- Evidence first. Quote the exact words or name the exact action in the transcript that show the outcome. If there are none, write "none". Decide only after quoting.
- Saying is not doing. If the outcome needs an action and the assistant only said it did it, with no matching entry under what it did, the outcome is not met.
- A promise to do it later, a question back to the person, or an offer is not the outcome.
- A wrong name, wrong amount, or wrong thing is not the outcome, even if the assistant sounds confident.
- Do not give credit for what probably happened. Judge only what the transcript shows.
- The note is one short sentence: what shows the outcome, or what is missing.`;

export function buildConversationRequest(expected: string, when: string, turns: TranscriptTurn[]): LLMRequest {
  const transcript = turns
    .map((t, i) => `Turn ${i + 1}\n  Person: "${t.said}"\n  Assistant: ${t.heard ? `"${t.heard}"` : '(said nothing)'}\n  Assistant did: ${t.events.length ? t.events.map((e) => (e.detail ? `${e.name} ${e.detail}` : e.name)).join('; ') : '(nothing)'}`)
    .join('\n');
  return {
    role: 'judge',
    system: SYSTEM,
    prompt: `EXPECTED OUTCOME\n${expected}\n\nWHEN\nThe conversation took place on ${when}, local time. Times in the assistant's actions may be written in UTC.\n\nTRANSCRIPT\n${transcript || '(no turns)'}\n\nDoes the transcript show the expected outcome?`,
    schema: {
      type: 'object',
      properties: { evidence: { type: 'string' }, met: { type: 'boolean' }, note: { type: 'string' } },
      required: ['evidence', 'met', 'note'],
    },
  };
}

export async function judgeConversation(llm: LLM, expected: string, when: string, turns: TranscriptTurn[]): Promise<{ met: boolean; evidence: string; note: string; calls: LLMCallRecord[] }> {
  const request = buildConversationRequest(expected, when, turns);
  const calls: LLMCallRecord[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await llm.complete(request);
    calls.push({ request, response });
    const reply = response.structured as { evidence?: string; met?: boolean; note?: string } | undefined;
    if (reply && typeof reply.met === 'boolean') return { met: reply.met, evidence: reply.evidence ?? '', note: reply.note ?? '', calls };
  }
  throw new Error('The conversation judge gave no verdict');
}
