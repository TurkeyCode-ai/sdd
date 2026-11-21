// Step 4 with the model and the machine scripted: the guardrails, the
// clean-machine stage, and the rules for keeping a revision.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LLM, LLMRequest } from '../runner/llm/types.ts';
import { wilson } from '../scorer/stats.ts';
import { engineDecideSpec, engineReadSpec, improved, mockVerdict, shortfall, workingMet, type MockScore } from './designloop.ts';
import { parseLedger } from './facts.ts';
import { buildBrief, checkAgainstRepo, mechanicalProblems, ownPlaces, reviewClaims, visibleText } from './mock.ts';
import { parsePipelineSpec, type TryStage } from './spec.ts';
import { imageOf, taskSentence, tryOnce, tryStage, type Machine } from './try.ts';

const person = (id: string, holdout = false) => ({
  id, archetype: `A developer called ${id}`, role: 'Developer', experience: 'Ten years', alreadyUses: ['a coding agent'],
  arrivalSource: 'a post', arrivalSaw: `Post seen by ${id}`, needs: ['less babysitting', 'proof it was tested'], objections: ['sounds like hype', 'may burn limits'],
  readingWpm: 280, skimRate: 0.5, holdout,
});
const spec = parsePipelineSpec({
  result: 'I need a website that wins developers to download and try widget.',
  audience: { who: 'Developers who already use a coding agent in the terminal.', inferredFrom: ['the README'] },
  personas: [person('alpha'), person('bravo'), person('charlie'), person('secret-holdout', true)],
  stages: [
    { id: 'read', kind: 'read', goal: 'A visitor can say what widget is.', entryFrom: 'a post', viewports: ['mobile', 'desktop'], timeBudgetSeconds: 60,
      questions: [
        { id: 'what', ask: 'What is widget and who is it for?', required: ['HIDDEN-RUBRIC-LINE about agents'], threshold: 0.8, reason: 'The core point of the page.' },
        { id: 'start', ask: 'What would you type to start?', required: ['npx widget run'], threshold: 0.6, reason: 'Needed to try it.' },
      ] },
    { id: 'decide', kind: 'decide', goal: 'A visitor moves toward installing.', entryFrom: 'a post', viewports: ['mobile'],
      success: { leavesTo: ['github.com/acme/widget'], clicks: ['Copy'] }, patienceSeconds: 90, threshold: 0.3, reason: 'A minority of visitors act.' },
    { id: 'try', kind: 'try', goal: 'Following the page, widget gets as far as its login check.',
      machine: { image: 'node:20-bookworm (Debian 12), run as the non-root user node', preinstalled: ['Node 20', 'git'], notPresent: ['any agent CLI'] },
      given: "The page's text, plus the sentence 'Try widget on a small todo app in an empty folder.' Nothing else.",
      success: { observable: 'widget reports that the agent CLI is missing.', check: 'Output contains "not found" and the process exits with code 1.' },
      timeLimitSeconds: 300, threshold: 0.8, reason: 'A correct command almost always gets there.' },
  ],
  assumptions: [{ id: 'load', statement: 'The page arrives in this time.', value: 0.05, unit: 'seconds', source: 'measured', how: 'Timed with curl five times; median 0.05 s.', sweep: [0.05, 3], affects: ['read'] }],
  openQuestions: [],
});
const ledger = parseLedger({
  facts: [
    { id: 'fa', claim: 'Widget drives a coding agent you already have.', source: { kind: 'file', file: 'README.md', line: 1, quote: 'drives a coding agent' } },
    { id: 'fb', claim: 'Start a build with npx widget run "your idea".', source: { kind: 'file', file: 'README.md', line: 2, quote: 'npx widget run' } },
    { id: 'fc', claim: 'It is MIT licensed.', source: { kind: 'file', file: 'README.md', line: 3, quote: 'MIT licensed' } },
    { id: 'fd', claim: 'The source is at https://github.com/acme/widget.', source: { kind: 'measured', how: 'gh repo view', reading: 'https://github.com/acme/widget is public' } },
    { id: 'fe', claim: 'It needs Node 20 or later.', source: { kind: 'file', file: 'README.md', line: 4, quote: 'Node 20' } },
  ],
  notTrue: [{ claim: 'Trusted by thousands of teams.', why: 'The repo has two stars.' }],
});
const tryDef = spec.stages[2] as TryStage;

function fake(reply: (request: LLMRequest, call: number) => unknown): LLM & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  return {
    provider: 'fake', requests,
    async complete(request) {
      requests.push(request);
      return { provider: 'fake', model: 'fake', text: '', structured: reply(request, requests.length), usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.01, durationMs: 1, raw: {} };
    },
  };
}

// ---- What the designer is and is not told ----

test('the brief has the people the designer may see, and nothing of the held-back ones or the rubrics', () => {
  const brief = buildBrief(spec, ledger);
  assert.ok(brief.includes('A developer called alpha'));
  assert.ok(!brief.includes('secret-holdout'));
  assert.ok(!brief.includes('HIDDEN-RUBRIC-LINE'), 'questions are shown, what a passing answer must state is not');
  assert.ok(brief.includes('What is widget and who is it for?'));
  assert.ok(brief.includes('Widget drives a coding agent you already have.'));
  assert.ok(brief.includes('Trusted by thousands of teams.'));
  assert.ok(brief.includes('You are not told who they are.'));
});

// ---- Guardrails ----

const page = (body: string, head = '') => `<!doctype html><html><head><style>body{font:16px sans-serif}</style>${head}</head><body>${body}</body></html>`;

test('links stay in the owner\'s own places', () => {
  const places = ownPlaces(spec, ledger, ['widget.dev']);
  assert.ok(places.includes('github.com/acme/widget'));
  assert.deepEqual(mechanicalProblems(page('<h1>Widget</h1><a href="https://github.com/acme/widget">GitHub</a><a href="#start">Start</a><a href="/docs">Docs</a>'), places), []);
  // "www." and a path under one of the owner's places are still the owner's.
  assert.deepEqual(mechanicalProblems(page('<a href="https://www.github.com/acme/widget#readme">GitHub</a><a href="https://widget.dev/docs">Docs</a>'), places), []);
  assert.equal(mechanicalProblems(page('<a href="https://github.com/acme/other">Other</a>'), places).length, 1);
  assert.equal(mechanicalProblems(page('<a href="https://twitter.com/acme">Follow</a>'), places).length, 1);
});

test('an em dash fails a page; files from elsewhere do not, since they are blocked when visitors see it', () => {
  const places = ownPlaces(spec, ledger);
  const outside = page('<h1>Widget</h1><img src="https://cdn.example.com/a.png">', '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"><script src="https://cdn.example.com/x.js"></script>');
  assert.deepEqual(mechanicalProblems(outside, places), []);
  const problems = mechanicalProblems(page('<h1>Widget — fast</h1>'), places);
  assert.equal(problems.length, 1);
  assert.ok(problems[0]!.includes('em dash'));
});

test('the text a visitor reads leaves out styles, scripts and tags', () => {
  const text = visibleText(page('<h1>Widget</h1><p>Run <code>npx widget run &quot;idea&quot;</code></p><script>var secret = 1;</script>'));
  assert.equal(text, 'Widget\nRun npx widget run "idea"');
});

test('the claims review is given the ledger and the page text, and its failures come back', async () => {
  const llm = fake(() => ({ violations: [{ statement: 'Trusted by thousands of teams', why: 'On the not-true list.' }] }));
  const review = await reviewClaims(llm, page('<h1>Widget</h1><p>Trusted by thousands of teams</p>'), ledger);
  assert.equal(review.violations.length, 1);
  assert.ok(llm.requests[0]!.prompt.includes('It is MIT licensed.'));
  assert.ok(llm.requests[0]!.prompt.includes('Trusted by thousands of teams. (The repo has two stars.)'));
  assert.ok(!llm.requests[0]!.prompt.includes('<style>'));
});

// ---- The engine specs ----

test('stages compile to what the engine runs, and a slow page takes time away from the visit', () => {
  const read = engineReadSpec(spec.stages[0] as any, 4);
  assert.equal(read.kind, 'comprehension');
  assert.deepEqual(read.pass, { what_rate: 0.8, start_rate: 0.6 });
  assert.equal(engineReadSpec(spec.stages[0] as any, 4, 6).reader.time_budget_seconds, 54);

  const decide = engineDecideSpec(spec.stages[1] as any, 4, 3);
  assert.deepEqual(decide.task.success, { leaves_to: ['github.com/acme/widget'], clicks: ['Copy'] });
  assert.equal((decide.task as any).instruction, undefined, 'nobody asks them to act');
  assert.equal(decide.visitor.patience_seconds, 87);
});

// ---- The clean machine ----

function machine(outputs: Record<string, { exitCode: number; output: string }>): Machine & { ran: string[]; destroyed: boolean } {
  return {
    ran: [], destroyed: false,
    async exec(command) {
      this.ran.push(command);
      const hit = Object.entries(outputs).find(([part]) => command.includes(part));
      return { ...(hit?.[1] ?? { exitCode: 127, output: 'bash: command not found' }), seconds: 1 };
    },
    async destroy() { this.destroyed = true; },
  };
}

test('the developer is handed only the page text and the task, and the verdict comes from captured output', async () => {
  assert.equal(imageOf(tryDef), 'node:20-bookworm');
  assert.equal(taskSentence(tryDef), 'Try widget on a small todo app in an empty folder.');

  const m = machine({ 'npx widget run': { exitCode: 1, output: "❌ Claude Code not found ('claude')." } });
  const llm = fake((request, call) => {
    if (request.system.startsWith('You decide whether')) return { met: request.prompt.includes('not found') && request.prompt.includes('exit code 1'), note: 'Command 1 printed the not-found line and exited 1.' };
    return call === 1 ? { action: 'run', command: 'mkdir -p todo && cd todo && npx widget run "a todo app"', why: 'The page says to run npx widget run.' } : { action: 'stop', command: '', why: 'It needs an agent the page says I must install.' };
  });
  const run = await tryOnce({ stage: tryDef, pageText: 'Widget. Run: npx widget run "your idea"', llm, machine: m, n: 1 });

  assert.equal(run.met, true);
  assert.equal(run.ended, 'check met');
  assert.deepEqual(m.ran, ['mkdir -p todo && cd todo && npx widget run "a todo app"']);
  const developer = llm.requests[0]!;
  assert.ok(developer.prompt.includes('Widget. Run: npx widget run "your idea"'));
  assert.ok(developer.prompt.includes('Try widget on a small todo app in an empty folder.'));
  assert.ok(!developer.prompt.includes(tryDef.success.check), 'the developer is never told what the test is looking for');
  assert.ok(!developer.prompt.includes('not found'));
  const judge = llm.requests.at(-1)!;
  assert.ok(judge.prompt.includes("❌ Claude Code not found ('claude')."));
  assert.ok(judge.prompt.includes(tryDef.success.check));
});

test('a developer who claims success without the output to show it does not pass', async () => {
  const m = machine({ echo: { exitCode: 0, output: 'done' } });
  const llm = fake((request, call) => {
    if (request.system.startsWith('You decide whether')) return { met: false, note: 'No command printed the message or exited 1.' };
    return call === 1 ? { action: 'run', command: 'echo done', why: 'It worked.' } : { action: 'stop', command: '', why: 'Finished, it works.' };
  });
  const run = await tryOnce({ stage: tryDef, pageText: 'Widget.', llm, machine: m, n: 1 });
  assert.equal(run.met, false);
  assert.equal(run.ended, 'stopped');
});

test('a page with no command leaves nothing to judge, and every machine is destroyed', async () => {
  const machines: ReturnType<typeof machine>[] = [];
  const llm = fake(() => ({ action: 'stop', command: '', why: 'The page gives no command.' }));
  const result = await tryStage(tryDef, 'Widget is great.', llm, 3, async () => { const m = machine({}); machines.push(m); return m; });
  assert.deepEqual([result.passed, result.n], [0, 3]);
  assert.ok(result.runs.every((r) => r.note === 'No command was run.'));
  assert.ok(machines.every((m) => m.destroyed));
});

// ---- Keep or revert ----

function score(rates: { what: number; start: number; task: number; tried?: [number, number] }, holdoutRate = 0.9): MockScore {
  const q = (stage: string, id: string, rate: number, threshold: number) => ({ stage, id, ask: id, threshold, working: wilson(Math.round(rate * 40), 40), holdout: wilson(Math.round(holdoutRate * 16), 16) });
  return {
    questions: [q('read', 'what', rates.what, 0.8), q('read', 'start', rates.start, 0.6), q('decide', 'task', rates.task, 0.3)],
    tried: rates.tried && { stage: 'try', threshold: 0.8, interval: wilson(rates.tried[0], rates.tried[1]), result: { runs: [], passed: rates.tried[0], n: rates.tried[1], costUsd: 0 } },
    findings: '', costUsd: 1, notRun: [],
  };
}

test('the score is how far the seen people fall short, and the held-back people are not in it', () => {
  assert.ok(Math.abs(shortfall(score({ what: 0.5, start: 0.6, task: 0.2 })).rate - 0.4) < 1e-9);
  assert.equal(shortfall(score({ what: 0.5, start: 0.6, task: 0.2 }, 0.1)).rate, shortfall(score({ what: 0.5, start: 0.6, task: 0.2 }, 0.9)).rate);
  assert.ok(Math.abs(shortfall(score({ what: 0.9, start: 0.9, task: 0.9, tried: [2, 5] })).rate - 0.4) < 1e-9, 'the try stage counts');
});

test('a revision is kept only for a real gain in pass rates', () => {
  const base = score({ what: 0.5, start: 0.6, task: 0.2 });
  assert.equal(improved(score({ what: 0.7, start: 0.6, task: 0.2 }), base), true);
  assert.equal(improved(score({ what: 0.5, start: 0.6, task: 0.2 }), base), false);
  assert.equal(improved(score({ what: 0.51, start: 0.6, task: 0.2 }), base), false, 'a change inside the noise is not a gain');
  assert.equal(improved({ ...score({ what: 0.9, start: 0.9, task: 0.9 }), notRun: [{ stage: 'try', why: 'docker is not running' }] }, base), false, 'a stage that did not run is not a gain');
});

test('a pass needs the seen people, the held-back people and the try stage all clear', () => {
  assert.equal(mockVerdict(score({ what: 0.98, start: 0.98, task: 0.9, tried: [20, 20] }, 1)), 'pass');
  assert.equal(mockVerdict(score({ what: 0.98, start: 0.98, task: 0.9, tried: [20, 20] }, 0.3)), 'not met', 'the held-back people disagree');
  assert.equal(mockVerdict(score({ what: 0.98, start: 0.98, task: 0.9, tried: [5, 5] }, 1)), 'inside the noise', 'five developers cannot show 80%');
  assert.equal(mockVerdict({ ...score({ what: 0.98, start: 0.98, task: 0.9 }, 1), notRun: [{ stage: 'try', why: 'x' }] }), 'incomplete');
  assert.equal(workingMet(score({ what: 0.98, start: 0.98, task: 0.9 }, 0.3)), true);
});

// ---- True means the repository supports it ----

test('a statement beyond the ledger is kept only if its citation is really in the repository', async () => {
  const { mkdtemp, mkdir: mk, writeFile: wf } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const pathMod = await import('node:path');
  const repo = await mkdtemp(pathMod.join(tmpdir(), 'sdd-repo-'));
  const scratch = await mkdtemp(pathMod.join(tmpdir(), 'sdd-scratch-'));
  await mk(pathMod.join(repo, 'src'), { recursive: true });
  await wf(pathMod.join(repo, 'src', 'cli.ts'), 'const a = 1;\nconsole.log("WIDGET ORCHESTRATOR banner");\n');
  const violations = [
    { statement: 'Widget prints a banner when it starts.', why: 'Not in the ledger.' },
    { statement: 'Widget is used by 4,000 teams.', why: 'Not in the ledger.' },
    { statement: 'Widget resumes after a crash.', why: 'Not in the ledger.' },
  ];
  let asked = '';
  const agent = {
    async run(options: { prompt: string; cwd: string }) {
      asked = options.prompt;
      await wf(pathMod.join(options.cwd, 'verified.json'), JSON.stringify([
        { n: 1, supported: true, claim: 'The CLI prints a banner.', file: 'src/cli.ts', line: 2, quote: 'WIDGET ORCHESTRATOR banner' },
        { n: 2, supported: false, why: 'No such number anywhere in the repository.' },
        // Claims support, but the quote is not in the file: code must refuse it.
        { n: 3, supported: true, claim: 'It resumes.', file: 'src/cli.ts', line: 1, quote: 'resumeAfterCrash()' },
      ]));
      return { ok: true, text: '', costUsd: 0.2, durationMs: 1 };
    },
  };
  const check = await checkAgainstRepo(agent, violations, ledger, [repo], scratch, 1);
  assert.deepEqual(check.supported.map((s) => s.statement), ['Widget prints a banner when it starts.']);
  assert.equal(check.unsupported.length, 2);
  assert.match(check.unsupported[0]!.why, /No such number/);
  assert.match(check.unsupported[1]!.why, /did not check out/);
  assert.match(asked, /Trusted by thousands of teams/);
  assert.equal(check.costUsd, 0.2);
  // With no repository to read, the ledger stays the limit.
  assert.equal((await checkAgainstRepo(agent, violations, ledger, [], scratch, 1)).unsupported.length, 3);
});
