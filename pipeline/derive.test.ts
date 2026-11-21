// Step 2 with the agent scripted: what code checks about a derived spec, and
// what happens when the deriver gets it wrong. Offline and free.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentArgs, parseAgentOutput, type AgentRunOptions, type AgentRunner } from './agent.ts';
import { deriveCommand, showCommand } from './cli.ts';
import { buildDerivePrompt, derive, DERIVER_TOOLS, FACTS_DRAFT, SPEC_DRAFT } from './derive.ts';
import { checkCitations, parseLedger } from './facts.ts';
import { isInside, layout, projectId, projectsRoot, readCosts, spentUsd } from './project.ts';
import { emDashProblems, parsePipelineSpec } from './spec.ts';

const RESULT = 'I need a website that wins gardeners to download and try plantminder.';

let tmp = '';
let source = '';
before(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sdd-pipeline-'));
  source = path.join(tmp, 'plantminder');
  await mkdir(source);
  await writeFile(path.join(source, 'README.md'), [
    '# Plant Minder',
    '',
    'A free command-line tracker for house plants.',
    'It is MIT licensed.',
    '',
    '## Install',
    '',
    'Needs Node 20 or later.',
    '',
    '    npx plantminder add "fern" --every 7',
  ].join('\n'));
});
after(async () => { await rm(tmp, { recursive: true, force: true }); });

const person = (id: string, holdout = false) => ({
  id, archetype: `A person called ${id}`, role: 'Home gardener', experience: 'Keeps a dozen house plants',
  alreadyUses: ['a paper calendar'], arrivalSource: 'a search result', arrivalSaw: 'Never forget to water a plant',
  needs: ['know when to water', 'see all plants in one place'], objections: ['apps like this nag', 'setup looks slow'],
  readingWpm: 260, skimRate: 0.5, holdout,
});

const goodSpec = () => ({
  result: RESULT,
  audience: { who: 'People who keep house plants at home and are comfortable in a terminal.', inferredFrom: ['README.md says it is a command-line tracker for house plants'] },
  personas: [person('careful'), person('hurried'), person('skeptic'), person('gift-giver', true)],
  stages: [
    {
      id: 'read', kind: 'read', goal: 'A visitor can say what Plant Minder is after a skim.', entryFrom: 'a search result',
      viewports: ['mobile', 'desktop'], timeBudgetSeconds: 60,
      questions: [
        { id: 'what', ask: 'In your own words, what is this and who is it for?', required: ['it tracks when plants need water'], threshold: 0.8, reason: 'The page fails if most people cannot say what it is.' },
        { id: 'next', ask: 'What would you do first to try it?', required: ['run the command shown'], threshold: 0.6, reason: 'Trying it is the point of the page.' },
      ],
    },
    {
      id: 'decide', kind: 'decide', goal: 'A visitor decides to try it without being asked.', entryFrom: 'a search result', viewports: ['mobile'],
      success: { leavesTo: ['npmjs.com/package/plantminder'], clicks: ['Copy'] }, patienceSeconds: 90, threshold: 0.3, reason: 'Most first visits to any tool page end without action.',
    },
    {
      id: 'try', kind: 'try', goal: 'Someone following the page gets a plant tracked.',
      machine: { image: 'node:22-bookworm', preinstalled: ['Node 22', 'npm'], notPresent: ['plantminder'] },
      given: 'Only the install section of the page, as text.',
      success: { observable: 'A plant named in the command is stored.', check: 'The file plants.json exists and contains the plant name.' },
      timeLimitSeconds: 300, threshold: 0.7, reason: 'One command with no account should work for most people.',
    },
  ],
  assumptions: [
    { id: 'page-load', statement: 'The page finishes loading in this time.', value: 0.4, unit: 'seconds', source: 'measured', how: 'Served the folder locally and timed five loads with curl; median 0.4 s.', sweep: [0.4, 2, 5, 10], affects: ['read', 'decide'] },
    { id: 'has-node', statement: 'The visitor already has Node 20 or later.', value: 'yes', source: 'assumed', how: 'The audience is command-line users; no way to measure visitors yet.', sweep: ['yes', 'no'], affects: ['try'] },
  ],
  openQuestions: ['Should the try stage count a first run that needs a retry?'],
});

const goodFacts = () => ({
  facts: [
    { id: 'what-it-is', claim: 'Plant Minder is a command-line tracker for house plants.', source: { kind: 'file', file: 'README.md', line: 3, quote: 'command-line tracker for house plants' } },
    { id: 'free', claim: 'It is free.', source: { kind: 'file', file: 'README.md', line: 3, quote: 'A free command-line tracker' } },
    { id: 'licence', claim: 'It is MIT licensed.', source: { kind: 'file', file: 'README.md', line: 4, quote: 'It is MIT licensed.' } },
    { id: 'needs-node', claim: 'It needs Node 20 or later.', source: { kind: 'file', file: 'README.md', line: 8, quote: 'Needs Node 20 or later.' } },
    { id: 'published', claim: 'Version 1.2.0 is on npm.', source: { kind: 'measured', how: 'npm view plantminder version', reading: '1.2.0' } },
  ],
  notTrue: [{ claim: 'It sends reminders.', why: 'Nothing in the README or source sends anything.' }],
});

/** An agent that writes whatever each attempt is scripted to write. */
function scripted(attempts: { spec?: unknown; facts?: unknown; costUsd?: number }[]): AgentRunner & { calls: AgentRunOptions[] } {
  const calls: AgentRunOptions[] = [];
  return {
    calls,
    async run(options) {
      const a = attempts[Math.min(calls.length, attempts.length - 1)]!;
      calls.push(options);
      if (a.spec !== undefined) await writeFile(path.join(options.cwd, SPEC_DRAFT), typeof a.spec === 'string' ? a.spec : JSON.stringify(a.spec));
      if (a.facts !== undefined) await writeFile(path.join(options.cwd, FACTS_DRAFT), typeof a.facts === 'string' ? a.facts : JSON.stringify(a.facts));
      return { ok: true, text: 'Read README.md. Timed the page.', costUsd: a.costUsd ?? 0.5, durationMs: 10, turns: 3 };
    },
  };
}

let n = 0;
const projectRoot = () => path.join(tmp, 'projects', `p${n++}`);

// ---- The spec ----

test('a well-formed spec is accepted, with all three kinds of stage', () => {
  const spec = parsePipelineSpec(goodSpec(), RESULT);
  assert.deepEqual(spec.stages.map((s) => s.kind), ['read', 'decide', 'try']);
  assert.equal(spec.personas.filter((p) => p.holdout).length, 1);
});

test('the owner\'s sentence may not be reworded', () => {
  const spec = goodSpec();
  spec.result = 'A site that gets gardeners to install plantminder.';
  assert.throws(() => parsePipelineSpec(spec, RESULT), /word for word/);
});

test('a spec with nobody held back is refused', () => {
  const spec = goodSpec();
  spec.personas.forEach((p) => { p.holdout = false; });
  assert.throws(() => parsePipelineSpec(spec, RESULT), /at least 1 must have holdout: true/);
});

test('every problem is listed at once, by field', () => {
  const spec = goodSpec() as any;
  spec.stages[0].questions[0].threshold = 80;
  spec.stages[1].success = { leavesTo: [], clicks: [] };
  spec.stages[2].success.check = '';
  spec.assumptions[0].affects = ['nowhere'];
  spec.assumptions[1].source = 'guessed';
  let message = '';
  try { parsePipelineSpec(spec, RESULT); } catch (err) { message = (err as Error).message; }
  for (const part of ['stages[0].questions[0].threshold', 'stages[1].success', 'stages[2].success.check', 'assumptions[0].affects[0]', 'assumptions[1].source']) {
    assert.ok(message.includes(part), `expected a problem at ${part} in:\n${message}`);
  }
});

test('a measured assumption has to say how it was measured', () => {
  const spec = goodSpec();
  spec.assumptions[0]!.how = 'measured';
  assert.throws(() => parsePipelineSpec(spec, RESULT), /assumptions\[0\]\.how/);
});

test('em dashes are found anywhere in the copy', () => {
  const spec = goodSpec();
  spec.personas[0]!.needs[0] = 'know when to water — quickly';
  assert.deepEqual(emDashProblems(spec), ['personas[0].needs[0]: contains an em dash']);
});

// ---- The ledger ----

test('a ledger whose quotes are really in the files passes', async () => {
  assert.deepEqual(await checkCitations(parseLedger(goodFacts()), [source]), []);
});

test('a quote that is not in the file, a wrong line, and a missing file are each caught', async () => {
  const facts = goodFacts();
  (facts.facts[0]!.source as any).quote = 'the best plant tracker ever made';
  (facts.facts[2]!.source as any).line = 40;
  (facts.facts[3]!.source as any).file = 'docs/INSTALL.md';
  const problems = await checkCitations(parseLedger(facts), [source]);
  assert.equal(problems.length, 3);
  assert.match(problems[0]!, /"what-it-is": the quote is not at README\.md:3/);
  assert.match(problems[1]!, /"licence"/);
  assert.match(problems[2]!, /docs\/INSTALL\.md is not a file in the sources/);
});

test('a citation cannot point outside the sources', async () => {
  const facts = goodFacts();
  (facts.facts[0]!.source as any).file = '../../etc/hosts';
  assert.match((await checkCitations(parseLedger(facts), [source]))[0]!, /not a file in the sources/);
});

test('a quote may be a few lines off, and spacing does not matter', async () => {
  const facts = goodFacts();
  (facts.facts[3]!.source as any).line = 5;
  (facts.facts[3]!.source as any).quote = 'needs   node 20 or later.';
  assert.deepEqual(await checkCitations(parseLedger(facts), [source]), []);
});

// ---- Deriving ----

test('a good first attempt writes the referee, the brief and the plain-language spec', async () => {
  const root = projectRoot();
  const agent = scripted([{ spec: goodSpec(), facts: goodFacts(), costUsd: 1.25 }]);
  const outcome = await derive({ result: RESULT, sources: [source], projectRoot: root, agent });
  const l = layout(root);

  assert.equal(outcome.attempts, 1);
  assert.equal((await readFile(l.resultFile, 'utf8')).trim(), RESULT);
  assert.deepEqual((await readdir(l.personasWorking)).sort(), ['careful.yaml', 'hurried.yaml', 'skeptic.yaml']);
  assert.deepEqual(await readdir(l.personasHoldout), ['gift-giver.yaml']);
  assert.equal(JSON.parse(await readFile(l.factsFile, 'utf8')).facts.length, 5);
  // The brief is what a designer gets. Held-back people are not in it.
  assert.deepEqual(await readdir(l.brief), ['facts.yaml']);
  assert.ok(!(await readFile(l.factsFile, 'utf8')).includes('gift-giver'));

  const md = await readFile(l.derivedSpec, 'utf8');
  assert.ok(md.includes(`> ${RESULT}`));
  assert.ok(md.includes('**gift-giver** (held back)'));
  assert.ok(md.includes('every score is **not run**'));
  assert.ok(md.includes('Simulated: not run. Built: not run.'));
  assert.ok(md.includes('It sends reminders.'));
  assert.ok(md.includes('$1.25'));
  assert.ok(!md.includes('—'));
});

test('the deriver gets named tools, the sources to read, a cap, and a folder of its own', async () => {
  const root = projectRoot();
  const agent = scripted([{ spec: goodSpec(), facts: goodFacts() }]);
  await derive({ result: RESULT, sources: [source, 'https://example.com/plantminder'], projectRoot: root, budgetUsd: 3, agent });
  const call = agent.calls[0]!;
  assert.deepEqual(call.tools, DERIVER_TOOLS);
  assert.deepEqual(call.addDirs, [source], 'an address is looked up, not mounted');
  assert.equal(call.budgetUsd, 3);
  assert.ok(isInside(layout(root).scratch, call.cwd));
  assert.ok(!isInside(layout(root).referee, call.cwd));
  assert.ok(call.prompt.includes(`<<<RESULT\n${RESULT}\nRESULT>>>`));
  assert.ok(call.prompt.includes('https://example.com/plantminder'));

  const args = agentArgs(call, {});
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep,Bash,WebFetch,Write');
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '3.00');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--add-dir') + 1], source);
});

test('unusable drafts go back once with every problem, and the fix is accepted', async () => {
  const badFacts = goodFacts();
  (badFacts.facts[0]!.source as any).quote = 'trusted by ten thousand gardeners';
  const badSpec = goodSpec();
  badSpec.personas.forEach((p) => { p.holdout = false; });
  const root = projectRoot();
  const agent = scripted([{ spec: badSpec, facts: badFacts, costUsd: 1 }, { spec: goodSpec(), facts: goodFacts(), costUsd: 0.4 }]);
  const outcome = await derive({ result: RESULT, sources: [source], projectRoot: root, budgetUsd: 5, agent });

  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.costUsd, 1.4);
  assert.ok(!agent.calls[0]!.prompt.includes('are not usable yet'));
  assert.ok(agent.calls[1]!.prompt.includes('at least 1 must have holdout: true'));
  assert.ok(agent.calls[1]!.prompt.includes('"what-it-is": the quote is not at README.md:3'));
  assert.equal(agent.calls[1]!.budgetUsd, 4, 'the second attempt gets what is left');

  const costs = await readCosts(layout(root));
  assert.deepEqual(costs.map((c) => [c.step, c.usd]), [['derive', 1], ['derive', 0.4]]);
  assert.equal(await spentUsd(layout(root)), 1.4);
});

test('two unusable attempts fail, and nothing reaches the referee', async () => {
  const root = projectRoot();
  const agent = scripted([{ spec: 'not json' }, { facts: goodFacts() }]);
  await assert.rejects(derive({ result: RESULT, sources: [source], projectRoot: root, agent }), /did not produce a usable spec in two attempts/);
  const l = layout(root);
  assert.deepEqual(await readdir(l.referee), []);
  assert.deepEqual(await readdir(l.brief), []);
  assert.equal((await readCosts(l)).length, 2, 'the cost of a failed attempt is still logged');
});

test('it stops when the budget is spent and says so', async () => {
  const root = projectRoot();
  const agent = scripted([{ spec: 'not json', costUsd: 2 }]);
  await assert.rejects(derive({ result: RESULT, sources: [source], projectRoot: root, budgetUsd: 2, agent }), /budget of \$2\.00 is spent/);
  assert.equal(agent.calls.length, 1);
});

test('an em dash in a draft is a problem to fix, not something to ship', async () => {
  const spec = goodSpec();
  spec.audience.who = 'People who keep house plants — and use a terminal every day.';
  const root = projectRoot();
  const agent = scripted([{ spec, facts: goodFacts() }, { spec: goodSpec(), facts: goodFacts() }]);
  await derive({ result: RESULT, sources: [source], projectRoot: root, agent });
  assert.ok(agent.calls[1]!.prompt.includes('audience.who: contains an em dash'));
});

// ---- The prompt, the CLI, the plumbing ----

test('the prompt keeps the deriver out of design and tells it to find out before assuming', () => {
  const prompt = buildDerivePrompt({ result: RESULT, sources: [source] });
  assert.ok(prompt.includes('You do not design anything and you do not build anything.'));
  assert.ok(prompt.includes('Anything you can find out by looking or measuring, find out.'));
  assert.ok(prompt.includes('Never the agent\'s own claim that it worked.'));
  assert.ok(!prompt.includes('—'));
});

test('sdd derive needs a sentence, and sdd show prints the derived spec', async () => {
  const env = { SDD_HOME: path.join(tmp, 'home') };
  const out: string[] = [];
  const io = { log: (l: string) => out.push(l), logError: (l: string) => out.push(l), env };
  assert.equal(await deriveCommand(['too short'], io), 2);
  assert.equal(await deriveCommand([RESULT, '--budget-usd', '0'], io), 2);

  const agent = scripted([{ spec: goodSpec(), facts: goodFacts() }]);
  assert.equal(await deriveCommand([RESULT, '--source', source, '--budget-usd', '2'], { ...io, agent }), 0);
  const id = projectId(RESULT);
  assert.match(id, /^need-website-that-wins-gardeners-[0-9a-f]{8}$/);
  assert.ok(out.join('\n').includes('3 people and 1 held back, 3 stages, 2 assumptions, 5 facts in the ledger.'));
  assert.ok(out.join('\n').includes('Nothing has been simulated or built.'));

  out.length = 0;
  assert.equal(await showCommand([], io), 0);
  assert.deepEqual(out, [id]);
  assert.equal(await showCommand([id], io), 0);
  assert.ok(out.join('\n').includes('# Derived spec'));
  assert.equal(await showCommand(['nope'], io), 1);
  assert.equal(projectsRoot(env), path.join(tmp, 'home', 'projects'));
});

test('the CLI output of an agent session is read for cost and failure', () => {
  const ok = parseAgentOutput(JSON.stringify({ result: 'done', is_error: false, total_cost_usd: 1.5, num_turns: 9 }), 0, '');
  assert.deepEqual([ok.ok, ok.text, ok.costUsd, ok.turns], [true, 'done', 1.5, 9]);
  const capped = parseAgentOutput(JSON.stringify({ result: '', is_error: true, subtype: 'error_max_budget_usd', total_cost_usd: 5 }), 1, '');
  assert.equal(capped.ok, false);
  assert.equal(capped.costUsd, 5, 'what was spent before the cap is still counted');
  assert.match(capped.error!, /error_max_budget_usd/);
  assert.equal(parseAgentOutput('not json', 1, 'boom').ok, false);
});
