// The talker's next line. One model call per turn.
//
// Same stance as the visitor (see ../visitor/decide.ts): the model predicts
// what a described person does, it is not asked to succeed, and it never
// learns what counts as success. After the first line, anything other than
// giving up must quote words the product actually said, and the engine
// checks the quote. A person who heard nothing usable has no reason to stay.

import { citeIsOnScreen } from '../visitor/decide.ts';
import type { LLM, LLMCallRecord, LLMRequest } from '../llm/types.ts';
import type { Persona } from '../spec.ts';

export type TalkerAction =
  | { action: 'say'; text: string; cites: string; reason: string }
  | { action: 'done'; cites: string; reason: string }
  | { action: 'leave'; cites: string; reason: string };

export interface Exchange {
  said: string;
  heard: string;
}

export interface TalkerInput {
  persona: Persona;
  /** What the person came to get done, in their own head. */
  wants: string;
  /** Who or what they are talking to, as they would know it. */
  talkingTo: string;
  exchanges: Exchange[];
  secondsLeft: number;
  /** The local date and time, in words. A person knows what time it is; without this they ask for "this afternoon" at midnight. */
  now: string;
}

const SYSTEM = `You predict what one specific person says next while talking out loud to a voice assistant or robot. You are not that person and you are not trying to help them or the product. You are forecasting behavior.

You get a description of the person, what they want, and the conversation so far: what they said and what they heard back.

Choose exactly one next action:
- "say": they say something. Put their exact spoken words in "text".
- "done": they believe they got what they came for, and stop talking.
- "leave": they give up and walk away.

Rules:
- Write "text" the way this person actually talks out loud: short, informal, sometimes vague or incomplete, in their own words. No stage directions, no quotation marks, nothing they would not say aloud.
- They do not know what the product can do or how it wants to be asked. They ask the way they would ask a person.
- People give up when they are misunderstood twice, when they get a speech where they wanted an action, when they are asked questions they did not expect and cannot be bothered to answer, or when the reply does not match what they asked.
- People do not repeat themselves more than once or twice. A third try is rare.
- After the first line, to choose "say" or "done" you must quote in "cites" the exact words they heard that they are responding to. For "done", quote the words that tell them it worked. People who hear no confirmation are not sure it worked.
- For "leave", put in "cites" the words that put them off, or an empty string if they heard nothing useful.
- "reason" is one sentence in the third person saying why this person does this.`;

export function buildTalkerRequest(input: TalkerInput): LLMRequest {
  const { persona } = input;
  const first = input.exchanges.length === 0;
  const prompt = `THE PERSON
${persona.archetype}
Role: ${persona.profile.role}
Experience: ${persona.profile.experience}
Already uses: ${persona.profile.already_uses.join('; ')}
${persona.speaks ? `How they talk: ${persona.speaks}\n` : ''}Hoping for: ${persona.needs.join('; ')}
Doubts going in: ${persona.objections.join('; ')}

WHAT THEY ARE DOING
It is ${input.now}, and they know that.
They are talking to ${input.talkingTo}. They want: ${input.wants}
Patience left: about ${Math.max(0, Math.round(input.secondsLeft))} seconds.

THE CONVERSATION SO FAR
${first ? 'Nothing yet. They are about to speak for the first time.' : input.exchanges.map((e, i) => `${i + 1}. They said: "${e.said}"\n   They heard: ${e.heard ? `"${e.heard}"` : '(nothing came back)'}`).join('\n')}

${first ? 'What is the first thing this person says? The action is "say".' : 'What does this person do next?'}`;

  return {
    role: 'persona',
    system: SYSTEM,
    prompt,
    schema: {
      type: 'object',
      properties: {
        cites: { type: 'string' },
        reason: { type: 'string' },
        action: { type: 'string', enum: ['say', 'done', 'leave'] },
        text: { type: 'string' },
      },
      required: ['cites', 'reason', 'action'],
    },
  };
}

/** Why a proposed action cannot be used, or null if it can. */
export function problemWith(action: TalkerAction, input: TalkerInput): string | null {
  const first = input.exchanges.length === 0;
  if (first) {
    if (action.action !== 'say') return 'They have not spoken yet. The first action is "say".';
    return action.text?.trim() ? null : 'A "say" action needs the words they say.';
  }
  if (action.action === 'leave') return null;
  if (action.action === 'say' && !action.text?.trim()) return 'A "say" action needs the words they say.';
  const lastHeard = input.exchanges.at(-1)!.heard;
  // Nothing came back: there is nothing to quote. They may try once more, but cannot claim it worked.
  if (!lastHeard.trim()) return action.action === 'done' ? 'They heard nothing back, so they cannot believe it worked.' : null;
  if (!citeIsOnScreen(action.cites, [{ text: lastHeard }], [])) {
    return `"cites" must be an exact quote of words they just heard. "${action.cites.slice(0, 80)}" was not said.`;
  }
  return null;
}

/**
 * Ask for the next action. An unusable one is sent back once. A second
 * failure counts as leaving, except on the first line, where it is an error:
 * a conversation nobody started measures nothing.
 */
export async function decideTalker(llm: LLM, input: TalkerInput): Promise<{ action: TalkerAction; calls: LLMCallRecord[]; forcedLeave: boolean }> {
  const calls: LLMCallRecord[] = [];
  let request = buildTalkerRequest(input);
  let problem = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await llm.complete(request);
    calls.push({ request, response });
    const reply = response.structured as Partial<TalkerAction> & { text?: string } | undefined;
    if (reply && typeof reply.action === 'string' && ['say', 'done', 'leave'].includes(reply.action)) {
      const action = { cites: '', reason: '', ...reply } as TalkerAction;
      problem = problemWith(action, input) ?? '';
      if (!problem) return { action, calls, forcedLeave: false };
    } else {
      problem = 'The reply had no valid action.';
    }
    request = { ...request, prompt: `${request.prompt}\n\nYOUR LAST ANSWER WAS NOT USABLE\n${problem}\nAnswer again.` };
  }
  if (input.exchanges.length === 0) throw new Error(`The persona model gave no opening line. ${problem}`);
  return { action: { action: 'leave', cites: '', reason: `No usable next line grounded in what was heard. ${problem}` }, calls, forcedLeave: true };
}
