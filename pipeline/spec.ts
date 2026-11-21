// The pipeline spec: what a result means, made measurable.
//
// Derived from one sentence by the deriver, approved by the owner, and then
// fixed. It names who the result is for, the stages a person goes through to
// get there, what counts as success at each, the share who must succeed, and
// the assumptions the simulation runs under.

export interface SpecPersona {
  id: string;
  /** One line: who this is. */
  archetype: string;
  role: string;
  experience: string;
  alreadyUses: string[];
  /** Where they came from and the only thing they saw before landing. */
  arrivalSource: string;
  arrivalSaw: string;
  needs: string[];
  objections: string[];
  readingWpm: number;
  /** Share of body text this person skips, 0 to 1. */
  skimRate: number;
  /** Held back: never shown to whoever designs or builds. */
  holdout: boolean;
}

export interface SpecQuestion {
  id: string;
  ask: string;
  /** What a passing answer must state. One checkable claim each. */
  required: string[];
  threshold: number;
  /** Why this share, in one line. */
  reason: string;
}

/** Skim, then answer from memory with the page gone. */
export interface ReadStage {
  id: string;
  kind: 'read';
  goal: string;
  entryFrom: string;
  viewports: ('mobile' | 'desktop')[];
  timeBudgetSeconds: number;
  questions: SpecQuestion[];
}

/** Nobody asks them to do anything. They act or they leave. */
export interface DecideStage {
  id: string;
  kind: 'decide';
  goal: string;
  entryFrom: string;
  viewports: ('mobile' | 'desktop')[];
  /** Any one counts: leaving for an address that includes one of these, or pressing a control whose label includes one of these. */
  success: { leavesTo: string[]; clicks: string[] };
  patienceSeconds: number;
  threshold: number;
  reason: string;
}

/** A terminal stage: an agent on a clean machine, handed only what the site says. */
export interface TryStage {
  id: string;
  kind: 'try';
  goal: string;
  /** The clean machine, exactly. */
  machine: { image: string; preinstalled: string[]; notPresent: string[] };
  /** The only thing the agent is given to go on. */
  given: string;
  /** What must be observed for it to count, and how the engine observes it. Never the agent's own say-so. */
  success: { observable: string; check: string };
  timeLimitSeconds: number;
  threshold: number;
  reason: string;
}

export type Stage = ReadStage | DecideStage | TryStage;

export interface Assumption {
  id: string;
  /** What is assumed, in plain words. */
  statement: string;
  value: number | string;
  unit?: string;
  /** "measured": the deriver looked. "assumed": it could not, and says why. */
  source: 'measured' | 'assumed';
  /** Measured: how, and the reading. Assumed: why this value. */
  how: string;
  /** Values to try in the sweep, to find where scores break. */
  sweep: (number | string)[];
  /** Ids of the stages this changes. */
  affects: string[];
}

export interface PipelineSpec {
  schema: 'sdd-pipeline-spec/1';
  /** The owner's sentence, verbatim. */
  result: string;
  audience: { who: string; inferredFrom: string[] };
  personas: SpecPersona[];
  stages: Stage[];
  assumptions: Assumption[];
  /** Only what the deriver could not find out by looking or measuring. */
  openQuestions: string[];
}

// ---- Validation ----

const SLUG = /^[a-z][a-z0-9-]{1,39}$/;

export class Issues {
  list: string[] = [];
  add(where: string, message: string): void {
    this.list.push(`${where}: ${message}`);
  }
  throwIfAny(what: string): void {
    if (this.list.length > 0) throw new Error(`${what} is not usable:\n${this.list.map((i) => `  - ${i}`).join('\n')}`);
  }
}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function text(issues: Issues, where: string, value: unknown, min: number, max: number): string {
  if (typeof value !== 'string') { issues.add(where, 'must be text'); return ''; }
  const t = value.trim();
  if (t.length < min || t.length > max) issues.add(where, `must be ${min} to ${max} characters`);
  return t;
}

function slug(issues: Issues, where: string, value: unknown): string {
  if (typeof value !== 'string' || !SLUG.test(value)) {
    issues.add(where, 'must be lowercase letters, digits and dashes, starting with a letter');
    return '';
  }
  return value;
}

function num(issues: Issues, where: string, value: unknown, min: number, max: number, whole = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (whole && !Number.isInteger(value))) {
    issues.add(where, `must be ${whole ? 'a whole number' : 'a number'} from ${min} to ${max}`);
    return min;
  }
  return value;
}

export function list<T>(issues: Issues, where: string, value: unknown, min: number, max: number, each: (item: unknown, where: string) => T): T[] {
  if (!Array.isArray(value)) { issues.add(where, 'must be a list'); return []; }
  if (value.length < min || value.length > max) issues.add(where, `must have ${min} to ${max} items`);
  return value.map((item, i) => each(item, `${where}[${i}]`));
}

function viewports(issues: Issues, where: string, value: unknown): ('mobile' | 'desktop')[] {
  const out = list(issues, where, value, 1, 2, (v, w) => {
    if (v !== 'mobile' && v !== 'desktop') issues.add(w, 'must be "mobile" or "desktop"');
    return v as 'mobile' | 'desktop';
  });
  return [...new Set(out)];
}

function unique(issues: Issues, where: string, ids: string[]): void {
  if (new Set(ids).size !== ids.length) issues.add(where, 'ids must be unique');
}

function parseStage(issues: Issues, item: unknown, where: string): Stage {
  const s = isObject(item) ? item : {};
  if (!isObject(item)) issues.add(where, 'must be an object');
  const id = slug(issues, `${where}.id`, s.id);
  const goal = text(issues, `${where}.goal`, s.goal, 10, 400);

  if (s.kind === 'read') {
    return {
      id, kind: 'read', goal,
      entryFrom: text(issues, `${where}.entryFrom`, s.entryFrom, 3, 200),
      viewports: viewports(issues, `${where}.viewports`, s.viewports),
      timeBudgetSeconds: num(issues, `${where}.timeBudgetSeconds`, s.timeBudgetSeconds, 15, 180, true),
      questions: list(issues, `${where}.questions`, s.questions, 2, 4, (q, w): SpecQuestion => {
        const o = isObject(q) ? q : {};
        if (!isObject(q)) issues.add(w, 'must be an object');
        return {
          id: slug(issues, `${w}.id`, o.id),
          ask: text(issues, `${w}.ask`, o.ask, 10, 300),
          required: list(issues, `${w}.required`, o.required, 1, 3, (v, x) => text(issues, x, v, 5, 300)),
          threshold: num(issues, `${w}.threshold`, o.threshold, 0.05, 0.95),
          reason: text(issues, `${w}.reason`, o.reason, 10, 300),
        };
      }),
    };
  }
  if (s.kind === 'decide') {
    const success = isObject(s.success) ? s.success : {};
    const leavesTo = list(issues, `${where}.success.leavesTo`, success.leavesTo ?? [], 0, 6, (v, w) => text(issues, w, v, 3, 200));
    const clicks = list(issues, `${where}.success.clicks`, success.clicks ?? [], 0, 6, (v, w) => text(issues, w, v, 2, 80));
    if (leavesTo.length + clicks.length === 0) issues.add(`${where}.success`, 'needs at least one leavesTo or clicks entry');
    return {
      id, kind: 'decide', goal,
      entryFrom: text(issues, `${where}.entryFrom`, s.entryFrom, 3, 200),
      viewports: viewports(issues, `${where}.viewports`, s.viewports),
      success: { leavesTo, clicks },
      patienceSeconds: num(issues, `${where}.patienceSeconds`, s.patienceSeconds, 20, 300, true),
      threshold: num(issues, `${where}.threshold`, s.threshold, 0.05, 0.95),
      reason: text(issues, `${where}.reason`, s.reason, 10, 300),
    };
  }
  if (s.kind === 'try') {
    const machine = isObject(s.machine) ? s.machine : {};
    const success = isObject(s.success) ? s.success : {};
    return {
      id, kind: 'try', goal,
      machine: {
        image: text(issues, `${where}.machine.image`, machine.image, 3, 120),
        preinstalled: list(issues, `${where}.machine.preinstalled`, machine.preinstalled, 0, 12, (v, w) => text(issues, w, v, 2, 120)),
        notPresent: list(issues, `${where}.machine.notPresent`, machine.notPresent, 0, 12, (v, w) => text(issues, w, v, 2, 160)),
      },
      given: text(issues, `${where}.given`, s.given, 10, 400),
      success: {
        observable: text(issues, `${where}.success.observable`, success.observable, 10, 400),
        check: text(issues, `${where}.success.check`, success.check, 10, 400),
      },
      timeLimitSeconds: num(issues, `${where}.timeLimitSeconds`, s.timeLimitSeconds, 30, 3600, true),
      threshold: num(issues, `${where}.threshold`, s.threshold, 0.05, 0.95),
      reason: text(issues, `${where}.reason`, s.reason, 10, 300),
    };
  }
  issues.add(`${where}.kind`, 'must be "read", "decide" or "try"');
  return { id, kind: 'read', goal, entryFrom: '', viewports: [], timeBudgetSeconds: 15, questions: [] };
}

/** Checks a derived spec. Throws one error that lists every problem. */
export function parsePipelineSpec(input: unknown, result?: string): PipelineSpec {
  const issues = new Issues();
  if (!isObject(input)) throw new Error('The spec must be a JSON object.');

  const audience = isObject(input.audience) ? input.audience : {};
  if (!isObject(input.audience)) issues.add('audience', 'must be an object');

  const personas = list(issues, 'personas', input.personas, 4, 8, (item, where): SpecPersona => {
    const p = isObject(item) ? item : {};
    if (!isObject(item)) issues.add(where, 'must be an object');
    if (typeof p.holdout !== 'boolean') issues.add(`${where}.holdout`, 'must be true or false');
    return {
      id: slug(issues, `${where}.id`, p.id),
      archetype: text(issues, `${where}.archetype`, p.archetype, 5, 200),
      role: text(issues, `${where}.role`, p.role, 2, 200),
      experience: text(issues, `${where}.experience`, p.experience, 2, 200),
      alreadyUses: list(issues, `${where}.alreadyUses`, p.alreadyUses, 1, 5, (v, w) => text(issues, w, v, 1, 200)),
      arrivalSource: text(issues, `${where}.arrivalSource`, p.arrivalSource, 2, 100),
      arrivalSaw: text(issues, `${where}.arrivalSaw`, p.arrivalSaw, 2, 300),
      needs: list(issues, `${where}.needs`, p.needs, 2, 3, (v, w) => text(issues, w, v, 3, 300)),
      objections: list(issues, `${where}.objections`, p.objections, 2, 3, (v, w) => text(issues, w, v, 3, 300)),
      readingWpm: num(issues, `${where}.readingWpm`, p.readingWpm, 150, 400, true),
      skimRate: num(issues, `${where}.skimRate`, p.skimRate, 0.2, 0.85),
      holdout: p.holdout === true,
    };
  });

  const stages = list(issues, 'stages', input.stages, 1, 6, (item, where) => parseStage(issues, item, where));
  const stageIds = stages.map((s) => s.id);

  const assumptions = list(issues, 'assumptions', input.assumptions, 1, 12, (item, where): Assumption => {
    const a = isObject(item) ? item : {};
    if (!isObject(item)) issues.add(where, 'must be an object');
    if (a.source !== 'measured' && a.source !== 'assumed') issues.add(`${where}.source`, 'must be "measured" or "assumed"');
    if (typeof a.value !== 'number' && typeof a.value !== 'string') issues.add(`${where}.value`, 'must be a number or text');
    const sweep = list(issues, `${where}.sweep`, a.sweep, 2, 8, (v, w) => {
      if (typeof v !== 'number' && typeof v !== 'string') issues.add(w, 'must be a number or text');
      return v as number | string;
    });
    const affects = list(issues, `${where}.affects`, a.affects, 1, 6, (v, w) => {
      if (typeof v !== 'string' || !stageIds.includes(v)) issues.add(w, `must be the id of a stage (${stageIds.join(', ')})`);
      return String(v);
    });
    return {
      id: slug(issues, `${where}.id`, a.id),
      statement: text(issues, `${where}.statement`, a.statement, 10, 300),
      value: a.value as number | string,
      unit: typeof a.unit === 'string' && a.unit.trim() ? a.unit.trim() : undefined,
      source: a.source === 'measured' ? 'measured' : 'assumed',
      // "Measured" has to say how and what was read. "Assumed" has to say why.
      how: text(issues, `${where}.how`, a.how, 15, 500),
      sweep,
      affects,
    };
  });

  const spec: PipelineSpec = {
    schema: 'sdd-pipeline-spec/1',
    result: text(issues, 'result', input.result, 10, 500),
    audience: {
      who: text(issues, 'audience.who', audience.who, 20, 600),
      inferredFrom: list(issues, 'audience.inferredFrom', audience.inferredFrom, 1, 8, (v, w) => text(issues, w, v, 5, 300)),
    },
    personas,
    stages,
    assumptions,
    openQuestions: list(issues, 'openQuestions', input.openQuestions ?? [], 0, 8, (v, w) => text(issues, w, v, 10, 500)),
  };

  // The owner's sentence is not the deriver's to reword.
  if (result !== undefined && spec.result !== result.trim()) issues.add('result', 'must be the owner\'s sentence, word for word');

  const working = personas.filter((p) => !p.holdout).length;
  if (working < 3) issues.add('personas', 'at least 3 must have holdout: false');
  if (personas.length - working < 1) issues.add('personas', 'at least 1 must have holdout: true');
  unique(issues, 'personas', personas.map((p) => p.id));
  unique(issues, 'stages', stageIds);
  unique(issues, 'assumptions', assumptions.map((a) => a.id));
  for (const s of stages) if (s.kind === 'read') unique(issues, `stage ${s.id} questions`, s.questions.map((q) => q.id));

  issues.throwIfAny('The spec');
  return spec;
}

/** Every piece of text in a value, with where it sits. For checks that apply to all copy. */
export function allText(value: unknown, where = ''): { where: string; text: string }[] {
  if (typeof value === 'string') return [{ where, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => allText(v, `${where}[${i}]`));
  if (isObject(value)) return Object.entries(value).flatMap(([k, v]) => allText(v, where ? `${where}.${k}` : k));
  return [];
}

/** The house rule: no em dashes in any copy or docs. */
export function emDashProblems(value: unknown): string[] {
  return allText(value).filter((t) => t.text.includes('—')).map((t) => `${t.where}: contains an em dash`);
}

/** A persona in the engine's file format. */
export function enginePersona(p: SpecPersona) {
  return {
    id: p.id,
    archetype: p.archetype,
    profile: { role: p.role, experience: p.experience, tech_comfort: 'not stated', already_uses: p.alreadyUses },
    arrival: { source: p.arrivalSource, saw: p.arrivalSaw },
    needs: p.needs,
    objections: p.objections,
    dials: { reading_wpm: p.readingWpm, skim_rate: p.skimRate },
  };
}
