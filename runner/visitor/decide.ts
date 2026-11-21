// The visitor's next move. One model call per screen.
//
// Simulated visitors are agreeable by default: left alone they keep going and
// sign up for anything. Three things push against that here.
//   1. The model predicts what a described person does. It is not asked to
//      play the person or to complete anything.
//   2. Leaving is the default. Any other action must quote text that is on
//      the screen right now, and the engine checks the quote (see citeIsOnScreen).
//   3. The model never learns what counts as success. The engine checks that.

import { storable, type LLM, type LLMCallRecord, type LLMImage, type LLMRequest } from '../llm/types.ts';
import type { Persona } from '../spec.ts';
import type { Observation, ScreenElement } from './observe.ts';

export type Action =
  | { action: 'leave'; cites: string; reason: string }
  | { action: 'scroll'; cites: string; reason: string }
  | { action: 'done'; cites: string; reason: string }
  | { action: 'click'; element: number; cites: string; reason: string }
  | { action: 'type'; element: number; text: string; cites: string; reason: string };

export interface PastStep {
  action: string;
  result: string;
}

export interface DecisionInput {
  persona: Persona;
  /** What the person was asked to try, for a usability task. Absent for an ordinary visit. */
  instruction?: string;
  observation: Observation;
  /** The on-screen text the person took in, after skimming. Headings and element labels are always taken in. */
  seenText: { kind: 'heading' | 'body'; text: string }[];
  history: PastStep[];
  secondsLeft: number;
  screenshot?: LLMImage;
}

const SYSTEM = `You predict what one specific person does next on a web page. You are not that person and you are not trying to help them or the site. You are forecasting behavior, and most real visitors leave.

You get a description of the person, what they did so far, and what is on their screen now: the text they took in and a numbered list of things they could click or type into.

Choose exactly one next action:
- "leave": they close the page or go back. This is the default, and it is what most people do on most screens.
- "scroll": they scroll down to see more.
- "click": they click one numbered element.
- "type": they type into one numbered input.
- "done": only if they were asked to try something, and they now believe they have finished it. They stop here.

Rules:
- To choose anything other than "leave", quote in "cites" the exact words on the screen that make this person take that action: text that speaks to one of their needs, answers one of their doubts, or plainly is the next step of what they are trying to do. Quote one short phrase, copied exactly. If you cannot quote such words, the answer is "leave".
- A doubt the page has not answered still counts against continuing. People do not give their details to a page they do not yet trust.
- People give up when they are confused, when the next step is not obvious, when a form asks for more than the thing is worth to them, or when they have scrolled and found nothing for them.
- People do not read everything. Use only the text listed as taken in.
- When typing, use made-up details that fit this person. Never use a real person's details.
- "reason" is one sentence in the third person saying why this person does this.
- For "done", quote the words on the screen that tell them it worked. People who see no confirmation are not sure they are done.
- For "leave", put in "cites" the words that put them off, or an empty string if nothing on screen held them.`;

const SCREEN_NOTE = `

You also get a picture of the screen. Use it for what the page looks like and what stands out. Body text in it is blurred because the person did not read it. Do not try to read blurred text.`;

function describeElement(e: ScreenElement): string {
  const small = Math.min(e.width, e.height) < 32 ? ', small' : '';
  if (e.kind === 'input') return `[${e.n}] input (${e.inputType}) "${e.label}"${e.value ? `, now contains "${e.value}"` : ', empty'}`;
  if (e.kind === 'link') return `[${e.n}] link "${e.label}"${e.goesTo === 'outside' ? ', leaves this site' : ''}${small}`;
  return `[${e.n}] ${e.kind} "${e.label}"${small}`;
}

export function buildDecisionRequest(input: DecisionInput): LLMRequest {
  const { persona, observation: o } = input;
  const below = o.pageHeight - (o.scrollY + o.viewportHeight);
  const prompt = `THE PERSON
${persona.archetype}
Role: ${persona.profile.role}
Experience: ${persona.profile.experience}
Already uses: ${persona.profile.already_uses.join('; ')}
Came from: ${persona.arrival.source}, after seeing only this: "${persona.arrival.saw}"
Hoping to find: ${persona.needs.join('; ')}
Doubts going in: ${persona.objections.join('; ')}
${input.instruction ? `They were asked to try this, and are willing to give it a fair go: ${input.instruction}` : 'Nobody asked them to do anything here. They are deciding whether this is worth their time.'}
Patience left: about ${Math.max(0, Math.round(input.secondsLeft))} seconds.

WHAT THEY HAVE DONE SO FAR
${input.history.length ? input.history.map((h, i) => `${i + 1}. ${h.action} -> ${h.result}`).join('\n') : 'Nothing yet. They just arrived.'}

THE SCREEN NOW
Page: "${o.title}" at ${o.url}
${below > 40 ? 'There is more page below.' : 'This is the bottom of the page.'}

Text they took in:
${input.seenText.length ? input.seenText.map((t) => `- ${t.kind === 'heading' ? '[heading] ' : ''}${t.text}`).join('\n') : '(none)'}

Things they could act on:
${o.elements.length ? o.elements.map(describeElement).join('\n') : '(nothing to click or type into on this screen)'}

What does this person do next?`;

  return {
    role: 'persona',
    system: input.screenshot ? SYSTEM + SCREEN_NOTE : SYSTEM,
    prompt,
    ...(input.screenshot ? { images: [input.screenshot] } : {}),
    schema: {
      type: 'object',
      properties: {
        cites: { type: 'string' },
        reason: { type: 'string' },
        action: { type: 'string', enum: ['leave', 'scroll', 'click', 'type', 'done'] },
        element: { type: 'integer' },
        text: { type: 'string' },
      },
      required: ['cites', 'reason', 'action'],
    },
  };
}

const normal = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * True when the quoted words really are on the screen: in text the person
 * took in, or in an element's label.
 *
 * Models often quote two or three phrases at once ("Get on the list" ...
 * "Put me on the list"). Each phrase is checked on its own, and every one of
 * them has to be on the screen. One invented phrase fails the whole quote.
 */
export function citeIsOnScreen(cites: string, seenText: { text: string }[], elements: Pick<ScreenElement, 'label'>[]): boolean {
  const haystacks = [...seenText.map((t) => t.text), ...elements.map((e) => e.label)].map(normal);
  const all = normal(haystacks.join(' '));
  const found = (quote: string) => haystacks.some((h) => h.includes(quote)) || all.includes(quote);

  const whole = normal(cites);
  if (whole.length < 3) return false;
  if (found(whole)) return true;
  const pieces = cites
    .split(/\.\.\.|\u2026|[|"\u201c\u201d]|(?<=[.!?])\s+/)
    .map(normal)
    .filter((p) => p.length >= 3);
  return pieces.length > 0 && pieces.every(found);
}

/** Why a proposed action cannot be carried out, or null if it can. */
export function problemWith(action: Action, input: DecisionInput): string | null {
  if (action.action === 'leave') return null;
  if (!citeIsOnScreen(action.cites, input.seenText, input.observation.elements)) {
    return `"cites" must be an exact quote of words on the screen. "${action.cites.slice(0, 80)}" is not there.`;
  }
  if (action.action === 'done') return input.instruction ? null : 'Nobody asked this person to do anything, so "done" is not an option. Choose another action.';
  if (action.action === 'scroll') return null;
  const element = input.observation.elements.find((e) => e.n === action.element);
  if (!element) return `There is no element ${action.element} on the screen.`;
  if (action.action === 'type' && element.kind !== 'input') return `Element ${action.element} is not an input.`;
  if (action.action === 'type' && !action.text) return 'A "type" action needs the text to type.';
  if (action.action === 'click' && element.kind === 'input') return `Element ${action.element} is an input. Use "type" to fill it in.`;
  return null;
}

/**
 * Ask for the next action. An action that cannot be carried out, or that
 * quotes words that are not on the screen, is sent back once. A second
 * failure counts as leaving: no on-screen reason to continue was given.
 */
export async function decide(llm: LLM, input: DecisionInput): Promise<{ action: Action; calls: LLMCallRecord[]; forcedLeave: boolean }> {
  const calls: LLMCallRecord[] = [];
  let request = buildDecisionRequest(input);
  let problem = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await llm.complete(request);
    calls.push({ request: storable(request), response });
    const reply = response.structured as Partial<Action> & { element?: number; text?: string } | undefined;
    if (reply && typeof reply.action === 'string' && ['leave', 'scroll', 'click', 'type', 'done'].includes(reply.action)) {
      const action = { cites: '', reason: '', ...reply } as Action;
      problem = problemWith(action, input) ?? '';
      if (!problem) return { action, calls, forcedLeave: false };
    } else {
      problem = 'The reply had no valid action.';
    }
    request = { ...request, prompt: `${request.prompt}\n\nYOUR LAST ANSWER WAS NOT USABLE\n${problem}\nAnswer again. If there are no words on the screen to quote, the answer is "leave".` };
  }
  return { action: { action: 'leave', cites: '', reason: `No usable action with an on-screen reason was given. ${problem}` }, calls, forcedLeave: true };
}
