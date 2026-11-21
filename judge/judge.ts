// The judge. Part of the referee: the revising agent may never edit this.
//
// It sees the questions, the answers, and the rubric. Nothing else. It does
// not get the page, the persona, the viewport, the seed, or anything that
// says which page variant produced the answers.
//
// Version 2. Version 1 gave a verdict first and a note after, and a blind
// second review agreed with it on only 64% of contrast answers. Its notes
// sometimes contradicted its own verdicts. Version 2 must quote the evidence
// for each element before it decides.

import type { LLM, LLMCallRecord, LLMRequest } from '../runner/llm/types.ts';
import type { Answer } from '../runner/reader/answer.ts';
import type { Question } from '../runner/spec.ts';
import type { Grade, Trace } from '../runner/trace.ts';

export const JUDGE_VERSION = 'v2';

const SYSTEM = `You grade short written answers against a rubric. You are careful and consistent.

For each question you get the question, one person's answer, and a list of rubric elements. For each element, first quote the words from the answer that bear on it, then decide whether the answer meets it.

Rules:
- Evidence first. Copy the relevant words from the answer exactly. If there are none, write "none". Decide only after quoting.
- Grade the meaning, not the wording. A clear paraphrase meets an element.
- An element with several parts is met only if every part is stated. For example "a test checks whether code is correct, pass or fail" needs both that a test checks the code or its correctness, and that the result is binary (pass or fail, passing or failing, or the like). An example assertion on its own does not state a binary result.
- A part can be stated by contrast. "A score against a threshold rather than a pass or fail" states that the other side is pass or fail.
- Do not give credit for what the person probably meant, and do not use your own knowledge of the subject to fill gaps.
- People hedge. A claim counts if the person states it, even if they add that they are unsure about other details or about how the page framed it. A claim does not count if the person says they do not know it or cannot remember it.
- An element that asks for "at least N of" a list is met if at least N of the listed items are named, in any wording or letter case. Being unsure of their order does not matter.
- Grade each question on its own answer only. Do not carry information from one answer to another.
- The note is one short sentence saying what was missing, or "complete". It must agree with your decisions.`;

export function buildJudgeRequest(questions: Question[], answers: Answer[]): LLMRequest {
  const body = questions
    .map((q) => {
      const answer = answers.find((a) => a.id === q.id);
      if (!answer) throw new Error(`No answer to grade for question "${q.id}"`);
      const required = q.rubric.required.map((r, i) => `  required ${i + 1}: ${r}`).join('\n');
      const bonus = (q.rubric.bonus ?? []).map((r, i) => `  bonus ${i + 1}: ${r}`).join('\n');
      return `QUESTION ${q.id}: ${q.ask}\nANSWER: ${answer.answer}\nRUBRIC:\n${required}${bonus ? `\n${bonus}` : ''}`;
    })
    .join('\n\n');

  const element = {
    type: 'object',
    properties: { evidence: { type: 'string' }, met: { type: 'boolean' } },
    required: ['evidence', 'met'],
  };
  return {
    role: 'judge',
    system: SYSTEM,
    prompt: `${body}\n\nGrade every question by its id: ${questions.map((q) => q.id).join(', ')}. Return exactly ${questions.length} grades. For each, give one entry per rubric element, in the order listed.`,
    schema: {
      type: 'object',
      properties: {
        grades: {
          type: 'array',
          minItems: questions.length,
          maxItems: questions.length,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              required: { type: 'array', items: element },
              bonus: { type: 'array', items: element },
              note: { type: 'string' },
            },
            required: ['id', 'required', 'bonus', 'note'],
          },
        },
      },
      required: ['grades'],
    },
  };
}

interface ElementReply { evidence: string; met: boolean }
interface GradeReply { id: string; required: ElementReply[]; bonus: ElementReply[]; note: string }

export async function judgeAnswers(
  llm: LLM,
  questions: Question[],
  answers: Answer[],
): Promise<{ grades: Grade[]; calls: LLMCallRecord[] }> {
  const request = buildJudgeRequest(questions, answers);
  const calls: LLMCallRecord[] = [];
  let problem = '';

  // The judge sometimes returns grades for only some of the questions. Ask
  // again with the same request, never a changed one. Every attempt is kept
  // and paid for.
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await llm.complete(request);
    calls.push({ request, response });
    const reply = response.structured as { grades?: GradeReply[] } | undefined;

    const grades: Grade[] = [];
    problem = '';
    for (const q of questions) {
      const g = reply?.grades?.find((x) => x.id === q.id);
      const bonusCount = q.rubric.bonus?.length ?? 0;
      const wellFormed =
        g &&
        g.required?.length === q.rubric.required.length &&
        (g.bonus?.length ?? 0) >= bonusCount &&
        [...g.required, ...g.bonus].every((e) => typeof e?.met === 'boolean');
      if (!g || !wellFormed) {
        problem = `Judge reply is missing or malformed for question "${q.id}". Full reply: ${JSON.stringify(reply).slice(0, 600)}`;
        break;
      }
      grades.push({
        questionId: q.id,
        pass: g.required.every((e) => e.met), // a pass needs every required element
        requiredMet: g.required.map((e) => e.met),
        bonusMet: g.bonus.slice(0, bonusCount).map((e) => e.met),
        evidence: g.required.map((e) => e.evidence),
        note: g.note,
      });
    }
    if (!problem) return { grades, calls };
  }
  throw new Error(problem);
}

/** Returns a graded copy of a not yet stored trace, with the judge calls and their cost added. */
export async function gradeTrace(llm: LLM, questions: Question[], trace: Trace): Promise<Trace> {
  const { grades, calls } = await judgeAnswers(llm, questions, trace.answers);
  const llmCalls = [...trace.llmCalls, ...calls];
  const tokens = (c: LLMCallRecord) => c.response.usage.inputTokens + c.response.usage.cacheReadTokens + c.response.usage.cacheWriteTokens;
  return {
    ...trace,
    grades,
    llmCalls,
    cost: {
      usd: llmCalls.reduce((sum, c) => sum + c.response.costUsd, 0),
      inputTokens: llmCalls.reduce((sum, c) => sum + tokens(c), 0),
      outputTokens: llmCalls.reduce((sum, c) => sum + c.response.usage.outputTokens, 0),
    },
  };
}
