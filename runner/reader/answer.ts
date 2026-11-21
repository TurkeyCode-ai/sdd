// The answering call. The page has been taken away.
//
// This module is the enforcement point for "answers from seen text only".
// Its inputs are the persona, the fragments the persona recalled, the
// questions, and optionally screenshots of the screens the persona scrolled
// past with the body text blurred. It takes no page, no URL, and no browser,
// and it never sees a rubric. Keep it that way.

import { storable, type LLM, type LLMCallRecord, type LLMImage, type LLMRequest } from '../llm/types.ts';
import type { Persona } from '../spec.ts';
import type { Fragment } from './skim.ts';

export interface AskedQuestion {
  id: string;
  ask: string;
}

export interface Answer {
  id: string;
  ask: string;
  answer: string;
}

const SYSTEM = `You are simulating one person's memory of a web page, for a study of how well the page explains itself.

You get a profile of the person and the exact fragments of text they took in during a short skim. The page is gone. They cannot look at it again.

Answer each question the way this person would, in the first person, in one to three plain sentences.

Rules:
- Use only the fragments listed, plus general knowledge this person already had before the visit.
- Do not use anything else you know or can guess about the page or its subject.
- Fragments can be partial and out of context. Do not fill the gaps with confident guesses.
- If the person could not answer, say so plainly, for example "I'm not sure". A partial answer is fine.
- Do not try to be helpful, complete, or flattering. Be faithful to what this person would actually remember.`;

const SCREENS_NOTE = `

You also get screenshots of each screen the person scrolled past, in order. They show what the page looked like: layout, imagery, color, style, and what stood out. Body text in them is blurred on purpose, because the person did not read it. Use the screenshots for visual impressions only. Do not try to read blurred text, and do not treat anything in a screenshot as text the person read unless it is also in the fragments. Answer as the person who saw the page. Never mention screenshots, fragments, or blur in an answer.`;

export function buildAnswerRequest(persona: Persona, recalled: Fragment[], questions: AskedQuestion[], screens: LLMImage[] = []): LLMRequest {
  const fragments = recalled.length
    ? recalled.map((f, i) => `${i + 1}. ${f.kind === 'heading' ? '[heading] ' : ''}${f.text}`).join('\n')
    : '(nothing was taken in)';

  const prompt = `THE PERSON
Role: ${persona.profile.role}
Experience: ${persona.profile.experience}
Already uses: ${persona.profile.already_uses.join('; ')}
Came from: ${persona.arrival.source}, after seeing only this title: "${persona.arrival.saw}"
Was hoping to find: ${persona.needs.join('; ')}
Doubts going in: ${persona.objections.join('; ')}

FRAGMENTS THEY TOOK IN, in order
${fragments}

QUESTIONS
${questions.map((q) => `${q.id}: ${q.ask}`).join('\n')}

Answer every question by its id.`;

  return {
    role: 'persona',
    system: screens.length ? SYSTEM + SCREENS_NOTE : SYSTEM,
    prompt,
    ...(screens.length ? { images: screens } : {}),
    schema: {
      type: 'object',
      properties: {
        answers: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, answer: { type: 'string' } },
            required: ['id', 'answer'],
          },
        },
      },
      required: ['answers'],
    },
  };
}

export async function answerFromMemory(
  llm: LLM,
  persona: Persona,
  recalled: Fragment[],
  questions: AskedQuestion[],
  screens: LLMImage[] = [],
): Promise<{ answers: Answer[]; call: LLMCallRecord }> {
  const request = buildAnswerRequest(persona, recalled, questions, screens);
  const response = await llm.complete(request);
  const reply = response.structured as { answers?: { id: string; answer: string }[] } | undefined;

  const answers = questions.map((q) => {
    const found = reply?.answers?.find((a) => a.id === q.id);
    if (!found || typeof found.answer !== 'string') {
      throw new Error(`Persona reply has no answer for question "${q.id}"`);
    }
    return { id: q.id, ask: q.ask, answer: found.answer };
  });
  return { answers, call: { request: storable(request), response } };
}
