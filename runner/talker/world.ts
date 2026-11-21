// The world a talker speaks into. The engine knows nothing about the product
// on the other end: a work directory supplies an adapter that opens one
// conversation and passes lines back and forth.
//
// An adapter is part of the referee. It decides what counts as "what the
// product said" and "what the product did", so a revising agent may not edit it.
//
// Hard rule 1 holds here too: the target must be on this machine. The engine
// checks the address. The adapter must talk to nothing else.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Persona } from '../spec.ts';

/** Something the product did during a turn, such as a tool it ran. Checked by the engine, never shown to the persona. */
export interface WorldEvent {
  name: string;
  detail?: string;
}

export interface Heard {
  /** What the product said back, as the person would hear it. Empty when it said nothing. */
  reply: string;
  events: WorldEvent[];
  /** What the product's ears made of the line, when the adapter puts sound in front of them. Absent when the words arrive as text. */
  heardAs?: string;
  /** Real seconds from the end of the person's line to the end of the reply text arriving. */
  waitSeconds: number;
}

export interface Conversation {
  say(text: string): Promise<Heard>;
  close(): Promise<void>;
}

export interface World {
  open(context: { target: string; persona: Persona; seed: number }): Promise<Conversation>;
}

export function assertLoopback(target: string): URL {
  const url = new URL(target);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !/^(https?|wss?):$/.test(url.protocol)) {
    throw new Error(`A conversation target must be a loopback address, got ${target}`);
  }
  return url;
}

/** Loads <workdir>/<adapter>. The module's default export is the World. */
export async function loadWorld(repoRoot: string, adapter: string): Promise<{ world: World; file: string }> {
  const file = path.resolve(repoRoot, adapter);
  if (!file.startsWith(path.resolve(repoRoot) + path.sep)) throw new Error(`The adapter must live inside the work directory: ${adapter}`);
  const module = (await import(pathToFileURL(file).href)) as { default?: World };
  if (!module.default || typeof module.default.open !== 'function') throw new Error(`${adapter}: the default export must have an open() function`);
  return { world: module.default, file };
}
