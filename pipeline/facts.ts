// The claims ledger: every statement a designer or builder may make about the
// product, each tied to where it comes from.
//
// This is how "true claims only" is enforced. The deriver reads the sources
// and writes the ledger. Code then checks every citation: the file exists and
// the quoted words are really there, near the line given. Later, anything a
// mock says about the product has to be in the ledger.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Issues, isObject, list, text } from './spec.ts';

export type FactSource =
  /** Words in a file under one of the source folders. */
  | { kind: 'file'; file: string; line: number; quote: string }
  /** Something the deriver measured or looked up: how, and what came back. */
  | { kind: 'measured'; how: string; reading: string };

export interface Fact {
  id: string;
  /** The statement, in words a page could use. */
  claim: string;
  source: FactSource;
}

/** Something that looks true, or that a page might be tempted to say, and is not. */
export interface NotTrue {
  claim: string;
  why: string;
}

export interface Ledger {
  schema: 'sdd-facts/1';
  facts: Fact[];
  notTrue: NotTrue[];
}

const SLUG = /^[a-z][a-z0-9-]{1,59}$/;

export function parseLedger(input: unknown): Ledger {
  const issues = new Issues();
  if (!isObject(input)) throw new Error('The ledger must be a JSON object.');

  const facts = list(issues, 'facts', input.facts, 5, 120, (item, where): Fact => {
    const f = isObject(item) ? item : {};
    if (!isObject(item)) issues.add(where, 'must be an object');
    const id = typeof f.id === 'string' && SLUG.test(f.id) ? f.id : '';
    if (!id) issues.add(`${where}.id`, 'must be lowercase letters, digits and dashes, starting with a letter');
    const claim = text(issues, `${where}.claim`, f.claim, 8, 400);
    const s = isObject(f.source) ? f.source : {};
    let source: FactSource;
    if (s.kind === 'file') {
      if (typeof s.line !== 'number' || !Number.isInteger(s.line) || s.line < 1) issues.add(`${where}.source.line`, 'must be a line number');
      source = {
        kind: 'file',
        file: text(issues, `${where}.source.file`, s.file, 1, 400),
        line: typeof s.line === 'number' ? s.line : 1,
        quote: text(issues, `${where}.source.quote`, s.quote, 4, 400),
      };
    } else if (s.kind === 'measured') {
      source = {
        kind: 'measured',
        how: text(issues, `${where}.source.how`, s.how, 8, 400),
        reading: text(issues, `${where}.source.reading`, s.reading, 1, 400),
      };
    } else {
      issues.add(`${where}.source.kind`, 'must be "file" or "measured"');
      source = { kind: 'measured', how: '', reading: '' };
    }
    return { id, claim, source };
  });

  const notTrue = list(issues, 'notTrue', input.notTrue ?? [], 0, 40, (item, where): NotTrue => {
    const n = isObject(item) ? item : {};
    if (!isObject(item)) issues.add(where, 'must be an object');
    return { claim: text(issues, `${where}.claim`, n.claim, 8, 400), why: text(issues, `${where}.why`, n.why, 8, 500) };
  });

  const ids = facts.map((f) => f.id);
  if (new Set(ids).size !== ids.length) issues.add('facts', 'ids must be unique');
  issues.throwIfAny('The ledger');
  return { schema: 'sdd-facts/1', facts, notTrue };
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** How far from the cited line the quote may sit. Line numbers drift by a little; this is not a search. */
const LINE_SLACK = 6;

/**
 * Checks every file citation against the real files. Returns the problems;
 * an empty list means every quote was found where the ledger says it is.
 * `file` may be absolute, or relative to any of the source folders.
 */
export async function checkCitations(ledger: Ledger, sourceDirs: string[]): Promise<string[]> {
  const problems: string[] = [];
  const cache = new Map<string, string[] | null>();

  const load = async (file: string): Promise<string[] | null> => {
    const candidates = path.isAbsolute(file) ? [file] : sourceDirs.map((dir) => path.resolve(dir, file));
    for (const candidate of candidates) {
      // A citation may only point inside a source folder.
      const inside = sourceDirs.some((dir) => {
        const rel = path.relative(path.resolve(dir), candidate);
        return !rel.startsWith('..') && !path.isAbsolute(rel);
      });
      if (!inside) continue;
      if (!cache.has(candidate)) {
        cache.set(candidate, await readFile(candidate, 'utf8').then((t) => t.split('\n'), () => null));
      }
      const lines = cache.get(candidate);
      if (lines) return lines;
    }
    return null;
  };

  for (const fact of ledger.facts) {
    if (fact.source.kind !== 'file') continue;
    const { file, line, quote } = fact.source;
    const lines = await load(file);
    if (!lines) {
      problems.push(`facts "${fact.id}": ${file} is not a file in the sources`);
      continue;
    }
    const from = Math.max(0, line - 1 - LINE_SLACK);
    const to = Math.min(lines.length, line + LINE_SLACK);
    const near = squash(lines.slice(from, to).join(' '));
    if (!near.includes(squash(quote))) {
      problems.push(`facts "${fact.id}": the quote is not at ${file}:${line} (looked ${LINE_SLACK} lines either side)`);
    }
  }
  return problems;
}
