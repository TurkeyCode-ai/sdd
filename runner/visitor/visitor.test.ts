// Visitor mode against a small real app: a landing page, a signup form, and
// an endpoint that records what was posted. The model is scripted, so the
// tests are free and can pin down exactly what the engine does.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LLM, LLMRequest } from '../llm/types.ts';
import { closeServer, listen } from '../sandbox/server.ts';
import { startSandbox, SandboxViolationError, type Sandbox } from '../sandbox/sandbox.ts';
import { loadPersona, type Persona, type Spec } from '../spec.ts';
import { validateTrace } from '../trace.ts';
import { citeIsOnScreen } from './decide.ts';
import { missChance, runVisitor } from './run.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="font: 16px sans-serif; margin: 24px">${body}</body></html>`;

let posts: string[] = [];
const app = createServer((req, res) => {
  const send = (html: string) => res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  if (req.method === 'POST' && req.url === '/api/waitlist') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      posts.push(body);
      res.writeHead(303, { location: '/thanks' }).end();
    });
  } else if (req.url === '/signup') {
    send(page('Join', `<h1>Join the waitlist</h1><p>We only email you when it ships.</p>
      <form method="post" action="/api/waitlist">
        <label for="n">Your name</label><input id="n" name="name" style="display:block; height:44px; width:260px">
        <label for="e">Email address</label><input id="e" name="email" type="email" style="display:block; height:44px; width:260px">
        <button type="submit" style="height:48px; width:260px">Add me to the list</button>
      </form>`));
  } else if (req.url === '/thanks') {
    send(page('Thanks', '<h1>You are on the list</h1>'));
  } else {
    send(page('Robot sidekick', `<h1>The robot sidekick you were promised</h1>
      <p>It follows you around the workshop and hands you tools. It ships as a kit you assemble in a weekend.</p>
      <a href="/signup" style="display:inline-block; padding:14px 24px; background:#fc0">Get on the waitlist</a>
      <a id="tiny" href="/signup" style="display:inline-block; font-size:8px">fine print</a>
      <p><a href="https://example.com/press">Read the press coverage</a></p>`));
  }
});

let origin = '';
let sandbox: Sandbox;
let persona: Persona;
let scratch = '';
const spec = {
  experiment: 'visitor-test',
  kind: 'task',
  goal: 'A visitor joins the waitlist',
  entry: { from: 'an ad', viewports: ['mobile'] },
  task: { goal: 'Join the waitlist', success: { request: { method: 'POST', path_includes: '/api/waitlist' } } },
  visitor: { patience_seconds: 90, max_steps: 12 },
  reader: { time_budget_seconds: 90, answers_from: 'what_was_seen', may_scroll_back: true },
  personas: { working: '', holdout: '', runs_per_persona: 1 },
  questions: [{ id: 'task', ask: 'Join the waitlist', rubric: { required: ['done'] } }],
  budget: { iterations: 0, usd: 1 },
} as Spec;

/** A scripted model. `policy` sees the element labels on screen and returns an action. */
function scripted(policy: (labels: Map<string, number>, prompt: string, call: number) => Record<string, unknown>): LLM & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  return {
    provider: 'fake',
    requests,
    async complete(request) {
      requests.push(request);
      const labels = new Map([...request.prompt.matchAll(/^\[(\d+)\] \w+(?: \(\w+\))? "([^"]+)"/gm)].map((m) => [m[2]!, Number(m[1])]));
      return {
        provider: 'fake', model: 'fake', text: '', structured: policy(labels, request.prompt, requests.length),
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.001, durationMs: 1, raw: {},
      };
    },
  };
}

/** Follows the signup path, quoting the label it acts on. */
const signsUp = scripted((labels) => {
  const cta = labels.get('Get on the waitlist');
  if (cta) return { action: 'click', element: cta, cites: 'Get on the waitlist', reason: 'wants one' };
  const prompt = signsUp.requests.at(-1)!.prompt;
  if (prompt.includes('"Your name", empty')) return { action: 'type', element: labels.get('Your name'), text: 'Pat Example', cites: 'Your name', reason: 'filling the form' };
  if (prompt.includes('"Email address", empty')) return { action: 'type', element: labels.get('Email address'), text: 'pat@example.test', cites: 'Email address', reason: 'filling the form' };
  return { action: 'click', element: labels.get('Add me to the list'), cites: 'Add me to the list', reason: 'submitting' };
});

before(async () => {
  origin = `http://127.0.0.1:${await listen(app)}`;
  sandbox = await startSandbox({ targetOrigin: origin });
  persona = await loadPersona(path.join(repoRoot, 'test/fixtures/sdd-site/personas/sdd-site/backend-tdd.yaml'));
  persona.dials.mis_tap_rate = 0; // taps land unless a test says otherwise
  scratch = await mkdtemp(path.join(tmpdir(), 'sdd-visitor-'));
});
after(async () => {
  await sandbox.close();
  await closeServer(app);
  await rm(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  posts = [];
  signsUp.requests.length = 0;
});

const run = (llm: LLM, overrides: Partial<Parameters<typeof runVisitor>[0]> = {}) =>
  runVisitor({ repoRoot: scratch, spec, persona, viewport: 'mobile', seed: 1, sandbox, llm, ...overrides });

test('a visitor who finds a reason at every step completes the task, and the engine sees it happen', async () => {
  const trace = await run(signsUp);
  validateTrace(trace, ['task']);
  assert.equal(trace.outcome, 'completed');
  assert.equal(trace.grades![0]!.pass, true);
  assert.deepEqual(trace.visitorSteps!.map((s) => s.action), ['click', 'type', 'type', 'click']);
  assert.equal(trace.visitorSteps![0]!.result, 'went to /signup');
  // The form really was submitted, once, with what the visitor typed.
  assert.equal(posts.length, 1);
  assert.match(posts[0]!, /name=Pat\+Example&email=pat%40example\.test/);
  assert.equal(trace.llmCalls.length, 4);
  assert.equal(sandbox.violations.length, 0);
});

test('the model is never told what counts as success', async () => {
  await run(signsUp);
  for (const request of signsUp.requests) {
    const shown = request.system + request.prompt;
    assert.ok(!shown.includes('/api/waitlist'), 'the success endpoint is in the prompt');
    assert.ok(!shown.includes('path_includes'));
  }
});

test('leaving is the default: an action that quotes words not on the screen is refused, then counted as leaving', async () => {
  const eager = scripted((labels) => ({ action: 'click', element: labels.get('Get on the waitlist'), cites: 'Limited time offer, 50% off today', reason: 'sounds great' }));
  const trace = await run(eager);
  assert.equal(trace.outcome, 'left');
  assert.equal(trace.grades![0]!.pass, false);
  assert.equal(eager.requests.length, 2, 'asked once more, then stopped');
  assert.match(eager.requests[1]!.prompt, /YOUR LAST ANSWER WAS NOT USABLE/);
  assert.equal(posts.length, 0);
  assert.equal(trace.visitorSteps!.length, 1);
  assert.equal(trace.visitorSteps![0]!.action, 'leave');
});

test('a visitor who chooses to leave is recorded with their reason', async () => {
  const trace = await run(scripted(() => ({ action: 'leave', cites: 'ships as a kit you assemble', reason: 'He wanted a finished robot, not a kit.' })));
  assert.equal(trace.outcome, 'left');
  assert.match(trace.answers[0]!.answer, /not a kit/);
  assert.equal(posts.length, 0);
});

test('following a link off the site ends the visit without the request being made', async () => {
  const trace = await run(scripted((labels) => ({ action: 'click', element: labels.get('Read the press coverage'), cites: 'Read the press coverage', reason: 'wants proof' })));
  assert.equal(trace.outcome, 'left');
  assert.match(trace.grades![0]!.note, /off the site/);
  assert.equal(sandbox.violations.length, 0, 'no outside request was attempted');
});

test('small targets are missed more often, and a missed tap changes nothing', async () => {
  assert.equal(missChance({ width: 200, height: 48 }, 0.03), 0.03);
  assert.ok(Math.abs(missChance({ width: 60, height: 11 }, 0.03) - 0.12) < 1e-9);
  assert.equal(missChance({ width: 4, height: 4 }, 0.2), 0.5, 'capped');

  const clumsy = { ...persona, dials: { ...persona.dials, mis_tap_rate: 1 } };
  let calls = 0;
  const trace = await run(
    scripted((labels) => (++calls > 2 ? { action: 'leave', cites: '', reason: 'gave up tapping' } : { action: 'click', element: labels.get('fine print'), cites: 'fine print', reason: 'curious' })),
    { persona: clumsy },
  );
  assert.deepEqual(trace.visitorSteps!.slice(0, 2).map((s) => s.result), ['missed the tap, nothing happened', 'missed the tap, nothing happened']);
  assert.ok(trace.visitorSteps!.every((s) => s.url === '/'), 'never left the landing page');
});

test('patience runs out', async () => {
  const short = { ...spec, visitor: { patience_seconds: 3, max_steps: 12 } } as Spec;
  const trace = await run(scripted(() => ({ action: 'scroll', cites: 'robot sidekick', reason: 'looking' })), { spec: short });
  assert.equal(trace.outcome, 'time_up');
  assert.ok(trace.simulatedSeconds <= 3);
});

test('a quote must really be on the screen', () => {
  const seen = [{ text: 'It ships as a kit you assemble in a weekend.' }];
  const elements = [{ n: 1, kind: 'link' as const, label: 'Get on the waitlist', width: 100, height: 44 }];
  assert.equal(citeIsOnScreen('ships as a kit', seen, elements), true);
  assert.equal(citeIsOnScreen('GET ON THE WAITLIST!', seen, elements), true, 'case and punctuation do not matter');
  assert.equal(citeIsOnScreen('free shipping', seen, elements), false);
  assert.equal(citeIsOnScreen('', seen, elements), false);
  // Several phrases at once: each is checked, and all must be there.
  assert.equal(citeIsOnScreen('"ships as a kit" ... "Get on the waitlist"', seen, elements), true);
  assert.equal(citeIsOnScreen('It ships as a kit you assemble in a weekend. Get on the waitlist', seen, elements), true);
  assert.equal(citeIsOnScreen('"ships as a kit" ... "50% off today"', seen, elements), false, 'one invented phrase fails the quote');
});

test('an app that calls out to another origin still fails the run', async () => {
  const leaky = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(page('Leaky', '<h1>Hello</h1><img src="https://tracker.example.com/p.gif">')));
  const leakyOrigin = `http://127.0.0.1:${await listen(leaky)}`;
  const guarded = await startSandbox({ targetOrigin: leakyOrigin });
  try {
    await assert.rejects(runVisitor({ repoRoot: scratch, spec, persona, viewport: 'mobile', seed: 1, sandbox: guarded, llm: signsUp }), SandboxViolationError);
  } finally {
    await guarded.close();
    await closeServer(leaky);
  }
});

// ---- Asked tasks, "done", and the judged outcome ----

const askedSpec = {
  ...spec,
  task: {
    goal: 'Join the waitlist',
    instruction: 'Put yourself on the waitlist for this robot.',
    success: { outcome: 'A confirmation that the visitor is on the waitlist' },
  },
} as Spec;

/** Persona calls go to `policy`. Judge calls pass only if the final screen says so. */
function scriptedWithJudge(policy: Parameters<typeof scripted>[0]) {
  const visitor = scripted(policy);
  const judgeRequests: LLMRequest[] = [];
  const llm: LLM = {
    provider: 'fake',
    async complete(request) {
      if (request.role !== 'judge') return visitor.complete(request);
      judgeRequests.push(request);
      const met = request.prompt.includes('You are on the list');
      return {
        provider: 'fake', model: 'fake-judge', text: '', structured: { evidence: met ? 'You are on the list' : 'none', met, note: met ? 'confirmation shown' : 'no confirmation on screen' },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.002, durationMs: 1, raw: {},
      };
    },
  };
  return { llm, visitor, judgeRequests };
}

test('an asked task: the visitor says done, and a separate judge confirms it from the final screen', async () => {
  const { llm, visitor, judgeRequests } = scriptedWithJudge((labels, prompt) => {
    if (prompt.includes('Page: "Thanks"')) return { action: 'done', cites: 'You are on the list', reason: 'He sees the confirmation.' };
    const cta = labels.get('Get on the waitlist');
    if (cta) return { action: 'click', element: cta, cites: 'Get on the waitlist', reason: 'next step' };
    if (prompt.includes('"Your name", empty')) return { action: 'type', element: labels.get('Your name'), text: 'Pat Example', cites: 'Your name', reason: 'form' };
    if (prompt.includes('"Email address", empty')) return { action: 'type', element: labels.get('Email address'), text: 'pat@example.test', cites: 'Email address', reason: 'form' };
    return { action: 'click', element: labels.get('Add me to the list'), cites: 'Add me to the list', reason: 'submit' };
  });
  const trace = await run(llm, { spec: askedSpec });
  validateTrace(trace, ['task']);
  assert.equal(trace.outcome, 'completed');
  assert.equal(trace.visitorSteps!.at(-1)!.action, 'done');
  assert.equal(posts.length, 1);
  // The visitor was told the task. The judge was told the expected outcome. Neither saw the other's.
  assert.match(visitor.requests[0]!.prompt, /Put yourself on the waitlist/);
  assert.ok(visitor.requests.every((r) => !r.prompt.includes('A confirmation that the visitor is on the waitlist')));
  assert.equal(judgeRequests.length, 1);
  assert.ok(!judgeRequests[0]!.prompt.includes('Put yourself on the waitlist'));
  assert.ok(!judgeRequests[0]!.prompt.includes(persona.profile.role), 'the judge does not see the persona');
  // Both kinds of call are stored and paid for.
  assert.equal(trace.llmCalls.filter((c) => c.request.role === 'judge').length, 1);
  assert.ok(Math.abs(trace.cost.usd - (visitor.requests.length * 0.001 + 0.002)) < 1e-9);
});

test('a visitor who thinks they are done but are not is caught', async () => {
  const { llm } = scriptedWithJudge(() => ({ action: 'done', cites: 'Get on the waitlist', reason: 'He thinks seeing the button is enough.' }));
  const trace = await run(llm, { spec: askedSpec });
  assert.equal(trace.outcome, 'thought_done');
  assert.equal(trace.grades![0]!.pass, false);
  assert.match(trace.grades![0]!.note, /believed the task was done/);
  assert.equal(posts.length, 0);
});

test('a visitor who leaves partway is judged on the screen they left from', async () => {
  const { llm, judgeRequests } = scriptedWithJudge((labels) => {
    const cta = labels.get('Get on the waitlist');
    return cta ? { action: 'click', element: cta, cites: 'Get on the waitlist', reason: 'next step' } : { action: 'leave', cites: 'Email address', reason: 'He will not give his email.' };
  });
  const trace = await run(llm, { spec: askedSpec });
  assert.equal(trace.outcome, 'left');
  assert.match(judgeRequests[0]!.prompt, /Page: "Join" at \/signup/);
  assert.match(trace.grades![0]!.note, /will not give his email.*no confirmation on screen/);
});

test('"done" is not available to a visitor nobody asked to do anything', async () => {
  let n = 0;
  const llm = scripted(() => (++n === 1 ? { action: 'done', cites: 'robot sidekick', reason: 'finished' } : { action: 'leave', cites: '', reason: 'nothing here for him' }));
  const trace = await run(llm);
  assert.match(llm.requests[1]!.prompt, /"done" is not an option/);
  assert.equal(trace.outcome, 'left');
});

// ---- Pages whose goal is to send people somewhere, or to get a button pressed ----

test('leaving for the place the page is for counts as done, and the request is still never made', async () => {
  const sendsAway = { ...spec, task: { goal: 'Go to the press page', success: { leaves_to: ['example.com/press'] } } } as Spec;
  const follows = scripted((labels) => ({ action: 'click', element: labels.get('Read the press coverage'), cites: 'Read the press coverage', reason: 'wants proof' }));
  const trace = await run(follows, { spec: sendsAway });
  assert.equal(trace.outcome, 'completed');
  assert.equal(sandbox.violations.length, 0, 'no outside request was attempted');

  // Any other outside link is still just leaving.
  const elsewhere = { ...spec, task: { goal: 'Go to the docs', success: { leaves_to: ['docs.example.org'] } } } as Spec;
  assert.equal((await run(follows, { spec: elsewhere })).outcome, 'left');
});

test('pressing a named control counts as done, whatever its case, and other controls do not', async () => {
  const wantsClick = { ...spec, task: { goal: 'Start signing up', success: { clicks: ['get on the WAITLIST'] } } } as Spec;
  const presses = scripted((labels) => ({ action: 'click', element: labels.get('Get on the waitlist'), cites: 'Get on the waitlist', reason: 'wants one' }));
  assert.equal((await run(presses, { spec: wantsClick })).outcome, 'completed');

  let calls = 0;
  const pressesOther = scripted((labels) => (++calls > 1 ? { action: 'leave', cites: '', reason: 'done looking' } : { action: 'click', element: labels.get('fine print'), cites: 'fine print', reason: 'curious' }));
  assert.equal((await run(pressesOther, { spec: wantsClick })).outcome, 'left');
});

test('the visitor is never shown where an outside link goes or what the engine is waiting for', async () => {
  const sendsAway = { ...spec, task: { goal: 'Go to the press page', success: { leaves_to: ['example.com/press'], clicks: ['waitlist-secret-label'] } } } as Spec;
  const leaves = scripted(() => ({ action: 'leave', cites: '', reason: 'not for me' }));
  await run(leaves, { spec: sendsAway });
  const shown = leaves.requests.map((r) => r.system + '\n' + r.prompt).join('\n');
  assert.ok(!shown.includes('example.com/press'));
  assert.ok(!shown.includes('waitlist-secret-label'));
  assert.ok(!shown.includes('leaves_to'));
});
