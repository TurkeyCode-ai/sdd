// Loads specs and personas. Read-only: nothing in the runner writes to them.

import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import type { PersonaDials } from './reader/skim.ts';

export interface Question {
  id: string;
  ask: string;
  /** For the judge only. Never shown to a persona. */
  rubric: { required: string[]; bonus?: string[] };
}

export interface Spec {
  experiment: string;
  kind: string;
  /** A file in the repo, for a static page. Absent when the target is a running app. */
  page?: string;
  goal: string;
  entry: { from: string; viewports: string[] };
  /** For kind "task": what a visitor may try to do, and how the engine knows it happened. */
  task?: {
    goal: string;
    /** If set, the visitor is asked to try this (a usability task). If absent, it is an ordinary visit. */
    instruction?: string;
    /** Checked by the engine. Never shown to the visitor model. Any one that is set and true counts. */
    success: {
      request?: { method?: string; path_includes: string };
      url_includes?: string;
      text_visible?: string;
      /**
       * The visitor follows a link off the site whose address includes one of
       * these, such as "github.com/acme". For pages whose goal is to send people
       * somewhere: a repository, a package, a store. The request is never made.
       */
      leaves_to?: string[];
      /** The visitor presses a button or link whose label includes one of these, such as "Copy". Case does not matter. */
      clicks?: string[];
      /** What the final screen should show, in prose. Checked by the outcome judge, for tasks with no mechanical check. */
      outcome?: string;
      /** Kind "conversation": the product must have run a tool whose name includes this. */
      tool_called?: string;
    };
  };
  visitor?: { patience_seconds: number; max_steps?: number; screenshots?: boolean };
  /** For kind "conversation": a person talking out loud to the product. `adapter` is a file in the work directory. */
  talker?: { patience_seconds: number; max_turns?: number; adapter: string; talking_to?: string };
  reader: {
    time_budget_seconds: number;
    answers_from: string;
    may_scroll_back: boolean;
    /** Show the persona a screenshot of each screen it scrolled past, body text blurred. */
    screenshots?: boolean;
  };
  personas: { working: string; holdout: string; runs_per_persona: number };
  questions: Question[];
  budget: { iterations: number; usd: number | string };
}

export interface Persona {
  id: string;
  archetype: string;
  profile: { role: string; experience: string; tech_comfort: string; already_uses: string[] };
  arrival: { source: string; saw: string };
  needs: string[];
  objections: string[];
  dials: PersonaDials;
  /** Talker mode: how this person talks out loud. */
  speaks?: string;
}

export async function loadSpec(file: string): Promise<Spec> {
  const spec = parse(await readFile(file, 'utf8')) as Spec;
  if (!spec.experiment) throw new Error(`${file}: missing "experiment"`);
  if (spec.kind === 'task') {
    if (!spec.task?.goal || !spec.task.success) throw new Error(`${file}: a task spec needs task.goal and task.success`);
    const s = spec.task.success;
    for (const key of ['leaves_to', 'clicks'] as const) {
      if (s[key] !== undefined && !(Array.isArray(s[key]) && s[key].length > 0 && s[key].every((v) => typeof v === 'string' && v.trim().length > 0))) {
        throw new Error(`${file}: task.success.${key} must be a list of text`);
      }
    }
    if (!s.request?.path_includes && !s.url_includes && !s.text_visible && !s.outcome && !s.leaves_to && !s.clicks) {
      throw new Error(`${file}: task.success needs request, url_includes, text_visible, leaves_to, clicks, or outcome`);
    }
    if (!(spec.visitor && spec.visitor.patience_seconds > 0)) throw new Error(`${file}: a task spec needs visitor.patience_seconds`);
    // One synthetic question, so thresholds (pass.task_rate), scoring, and reports work unchanged.
    spec.questions = [{ id: 'task', ask: spec.task.goal, rubric: { required: [`the visitor completed: ${spec.task.goal}`] } }];
    spec.reader ??= { time_budget_seconds: spec.visitor.patience_seconds, answers_from: 'what_was_seen', may_scroll_back: true };
  }
  if (spec.kind === 'conversation') {
    if (!spec.task?.goal || !spec.task.success) throw new Error(`${file}: a conversation spec needs task.goal and task.success`);
    const s = spec.task.success;
    if (!s.tool_called && !s.outcome) throw new Error(`${file}: task.success needs tool_called, outcome, or both`);
    if (s.request || s.url_includes || s.text_visible || s.leaves_to || s.clicks) throw new Error(`${file}: a conversation has no screen, so task.success takes only tool_called and outcome`);
    if (!(spec.talker && spec.talker.patience_seconds > 0 && spec.talker.adapter)) throw new Error(`${file}: a conversation spec needs talker.patience_seconds and talker.adapter`);
    spec.questions = [{ id: 'task', ask: spec.task.goal, rubric: { required: [`the person got: ${spec.task.goal}`] } }];
    spec.reader ??= { time_budget_seconds: spec.talker.patience_seconds, answers_from: 'what_was_heard', may_scroll_back: false };
    spec.entry = { ...spec.entry, viewports: ['voice'] };
  }
  for (const key of ['questions', 'reader'] as const) {
    if (!spec[key]) throw new Error(`${file}: missing "${key}"`);
  }
  for (const question of spec.questions) {
    question.rubric.required = rubricLines(file, question.id, question.rubric.required);
    if (question.rubric.bonus) question.rubric.bonus = rubricLines(file, question.id, question.rubric.bonus);
    if (question.rubric.required.length === 0) throw new Error(`${file}: question "${question.id}" has no required rubric elements`);
  }
  return spec;
}

/**
 * Every rubric element must reach the judge as plain text. YAML reads a line
 * like "- at least 3 of: a, b, c" as a one-key map, not a string, so that
 * shape is joined back into the line as written. Anything else is an error.
 */
function rubricLines(file: string, questionId: string, items: unknown): string[] {
  if (!Array.isArray(items)) throw new Error(`${file}: rubric for "${questionId}" is not a list`);
  return items.map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const entries = Object.entries(item);
      if (entries.length === 1 && typeof entries[0]![1] === 'string') return `${entries[0]![0]}: ${entries[0]![1]}`;
    }
    throw new Error(`${file}: rubric element for "${questionId}" is not text: ${JSON.stringify(item)}`);
  });
}

export async function loadPersona(file: string): Promise<Persona> {
  const persona = parse(await readFile(file, 'utf8')) as Persona;
  for (const key of ['id', 'profile', 'arrival', 'needs', 'objections', 'dials'] as const) {
    if (!persona[key]) throw new Error(`${file}: missing "${key}"`);
  }
  const { reading_wpm, skim_rate } = persona.dials;
  if (!(reading_wpm > 0)) throw new Error(`${file}: dials.reading_wpm must be positive`);
  if (!(skim_rate >= 0 && skim_rate <= 1)) throw new Error(`${file}: dials.skim_rate must be 0 to 1`);
  return persona;
}
