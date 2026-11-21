// The engine's contract with a host: flags in, exit code and a report out.
// The model is scripted and the app is a few lines of local server, so these
// run offline and cost nothing.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { blockedOrigins } from '../runner/batch-lib.ts';
import type { LLM } from '../runner/llm/types.ts';
import { closeServer, listen } from '../runner/sandbox/server.ts';
import { simulate } from './simulate.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');

const SPEC = `experiment: engine-test
kind: task
goal: A visitor joins the waitlist.
entry:
  from: an ad
  viewports: [mobile]
task:
  goal: Join the waitlist
  success:
    request: { method: POST, path_includes: /api/waitlist }
visitor:
  patience_seconds: 60
  max_steps: 6
personas:
  runs_per_persona: 1
pass:
  task_rate: 0.25
`;

/** Every visitor leaves at once: one call per run, no clicks. */
const leaves: LLM = {
  provider: 'fake',
  async complete() {
    return {
      provider: 'fake', model: 'fake', text: '', structured: { action: 'leave', cites: '', reason: 'not for me' },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.001, durationMs: 1, raw: {},
    };
  },
};

const html = (body: string) => `<!doctype html><html><head><title>Robot</title></head><body>${body}</body></html>`;
const serve = (body: string) => createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(html(body)));

let clean: Server, leaky: Server;
let cleanOrigin = '', leakyOrigin = '';
const scratch: string[] = [];
const quiet = { log: () => {}, logError: () => {} };

async function workdir(spec = SPEC): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sdd-engine-'));
  scratch.push(dir);
  await writeFile(path.join(dir, 'spec.yaml'), spec);
  await cp(path.join(repoRoot, 'examples/waitlist/personas'), path.join(dir, 'personas'), { recursive: true });
  return dir;
}
const report = async (dir: string, run: string) => JSON.parse(await readFile(path.join(dir, 'reports', `${run}.json`), 'utf8'));

before(async () => {
  clean = serve('<h1>The robot sidekick</h1><a href="/join">Get on the waitlist</a>');
  leaky = serve('<h1>The robot sidekick</h1><link rel="stylesheet" href="https://fonts.example.com/css"><img src="https://cdn.example.com/a.png"><img src="https://cdn.example.com/b.png">');
  cleanOrigin = `http://127.0.0.1:${await listen(clean)}`;
  leakyOrigin = `http://127.0.0.1:${await listen(leaky)}`;
});
after(async () => {
  await closeServer(clean);
  await closeServer(leaky);
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

test('missing or wrong flags exit 2 and write nothing', async () => {
  const dir = await workdir();
  assert.equal(await simulate(['--workdir', dir], quiet), 2);
  assert.equal(await simulate(['--workdir', dir, '--target', cleanOrigin, '--run', 'r', '--budget-usd', '1', '--outside-requests', 'allow'], quiet), 2);
  assert.equal(await simulate(['--no-such-flag'], quiet), 2);
  await assert.rejects(readFile(path.join(dir, 'reports', 'r.json')));
});

test('a run writes a report with a verdict, the cost, and holdout rates only', async () => {
  const dir = await workdir();
  const code = await simulate(['--workdir', dir, '--target', cleanOrigin, '--run', 'r1', '--budget-usd', '1'], { ...quiet, llm: leaves });
  assert.equal(code, 0);
  const r = await report(dir, 'r1');
  assert.equal(r.schema, 'sdd-report/1');
  assert.equal(r.verdict, 'inside the noise', 'nobody signed up, but four visits cannot rule out 25%');
  assert.equal(r.working.questions[0].interval.passed, 0);
  assert.equal(r.calibrated, false);
  assert.deepEqual(r.runs, { completed: 4, failed: 0, budgetHit: false });
  assert.ok(r.costUsd > 0);
  assert.deepEqual(r.blockedRequests, []);
  assert.equal(r.working.questions[0].id, 'task');
  assert.equal(r.holdout.failingAnswers, undefined, 'holdout detail is stripped');
  assert.match(await readFile(path.join(dir, 'reports', 'r1.md'), 'utf8'), /Not calibrated/);
});

test('by default an app that asks for another origin fails, and exit 1 still leaves a report', async () => {
  const dir = await workdir();
  const code = await simulate(['--workdir', dir, '--target', leakyOrigin, '--run', 'r2', '--budget-usd', '1'], { ...quiet, llm: leaves });
  assert.equal(code, 1);
  const r = await report(dir, 'r2');
  assert.equal(r.verdict, 'incomplete');
  assert.match(r.error, /Sandbox violation/);
  assert.match(r.error, /fonts\.example\.com/);
});

test('with --outside-requests block the run completes and the report lists what was refused', async () => {
  const dir = await workdir();
  const code = await simulate(
    ['--workdir', dir, '--target', leakyOrigin, '--run', 'r3', '--budget-usd', '1', '--outside-requests', 'block'],
    { ...quiet, llm: leaves },
  );
  assert.equal(code, 0);
  const r = await report(dir, 'r3');
  assert.equal(r.verdict, 'inside the noise');
  assert.equal(r.runs.completed, 4);
  const origins = r.blockedRequests.map((b: { origin: string }) => b.origin);
  assert.deepEqual(origins, ['https://cdn.example.com', 'https://fonts.example.com']);
  assert.ok(r.blockedRequests[0].count >= r.blockedRequests[1].count, 'most frequent first');
  assert.match(await readFile(path.join(dir, 'reports', 'r3.md'), 'utf8'), /Outside requests refused/);
});

test('a broken spec exits 1 with an incomplete report that says why', async () => {
  const dir = await workdir(SPEC.replace('task_rate: 0.25', 'task_rate: 7'));
  const code = await simulate(['--workdir', dir, '--target', cleanOrigin, '--run', 'r4', '--budget-usd', '1'], { ...quiet, llm: leaves });
  assert.equal(code, 1);
  const r = await report(dir, 'r4');
  assert.equal(r.verdict, 'incomplete');
  assert.match(r.error, /pass\.task_rate must be a number between 0 and 1/);
  assert.deepEqual(r.working, { set: 'working', runs: 0, questions: [], met: false });
});

test('a remote target is refused', async () => {
  const dir = await workdir();
  const code = await simulate(['--workdir', dir, '--target', 'https://example.com', '--run', 'r5', '--budget-usd', '1'], { ...quiet, llm: leaves });
  assert.equal(code, 1);
  assert.match((await report(dir, 'r5')).error, /loopback/);
});

test('blockedOrigins groups by origin and keeps what it cannot parse', () => {
  assert.deepEqual(
    blockedOrigins(['https://a.test/x', 'https://a.test/y', 'https://b.test/z', 'b.test:443']),
    [{ origin: 'https://a.test', count: 2 }, { origin: 'b.test:443', count: 1 }, { origin: 'https://b.test', count: 1 }],
  );
});
