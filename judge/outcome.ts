// Judges whether a visitor's session ended with the expected outcome on
// screen. Part of the referee.
//
// Used when a task's success cannot be checked mechanically (no known
// endpoint, URL, or exact text), which is the usual case for an app built
// from a prose spec: "the new plant appears in the list with its next
// watering date". The judge sees the expected outcome and the final screen.
// It does not see the persona, the visitor's reasoning, or the steps taken.

import type { LLM, LLMCallRecord, LLMRequest } from '../runner/llm/types.ts';

export interface FinalScreen {
  url: string;
  title: string;
  /** All text on the final screen, not only what the visitor took in. */
  text: string[];
}

const SYSTEM = `You check whether a web app's screen shows that a task was actually completed. You are strict.

You get the expected outcome and the text on the screen where a visitor's session ended. Decide whether the screen shows the expected outcome.

Rules:
- Evidence first. Quote the exact words on the screen that show the outcome. If there are none, write "none". Decide only after quoting.
- The outcome must be visible on this screen. A form that is filled in but not submitted is not the outcome. A button that would produce the outcome is not the outcome.
- An error message, a validation message, or a login wall means the outcome is not met.
- Do not give credit for what probably happened. Judge only what the screen shows.
- The note is one short sentence: what shows the outcome, or what is missing.`;

export function buildOutcomeRequest(expected: string, screen: FinalScreen): LLMRequest {
  return {
    role: 'judge',
    system: SYSTEM,
    prompt: `EXPECTED OUTCOME\n${expected}\n\nFINAL SCREEN\nPage: "${screen.title}" at ${screen.url}\n${screen.text.length ? screen.text.map((t) => `- ${t}`).join('\n') : '(no text on screen)'}\n\nDoes the final screen show the expected outcome?`,
    schema: {
      type: 'object',
      properties: { evidence: { type: 'string' }, met: { type: 'boolean' }, note: { type: 'string' } },
      required: ['evidence', 'met', 'note'],
    },
  };
}

export async function judgeOutcome(llm: LLM, expected: string, screen: FinalScreen): Promise<{ met: boolean; evidence: string; note: string; calls: LLMCallRecord[] }> {
  const request = buildOutcomeRequest(expected, screen);
  const calls: LLMCallRecord[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await llm.complete(request);
    calls.push({ request, response });
    const reply = response.structured as { evidence?: string; met?: boolean; note?: string } | undefined;
    if (reply && typeof reply.met === 'boolean') return { met: reply.met, evidence: reply.evidence ?? '', note: reply.note ?? '', calls };
  }
  throw new Error('The outcome judge gave no verdict');
}
