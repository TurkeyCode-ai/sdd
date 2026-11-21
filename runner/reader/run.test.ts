// Reader mode end to end against the real page, with a fake LLM so the test
// is free, offline, and can inspect exactly what the model was shown.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { LLM, LLMRequest } from '../llm/types.ts';
import { startSandbox, type Sandbox } from '../sandbox/sandbox.ts';
import { loadPersona, loadSpec, type Persona, type Spec } from '../spec.ts';
import { validateTrace } from '../trace.ts';
import { runReader } from './run.ts';
import { splitSentences } from './skim.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', 'test/fixtures/sdd-site');
let spec: Spec;
let persona: Persona;
let sandbox: Sandbox;

function fakeLLM(): LLM & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  return {
    provider: 'fake',
    requests,
    async complete(request) {
      requests.push(request);
      const ids = [...request.prompt.matchAll(/^(\w+): /gm)].map((m) => m[1]!).filter((id) => ['explain', 'contrast', 'loop'].includes(id));
      return {
        provider: 'fake',
        model: 'fake-model',
        text: '',
        structured: { answers: ids.map((id) => ({ id, answer: `answer to ${id}` })) },
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.001,
        durationMs: 1,
        raw: {},
      };
    },
  };
}

before(async () => {
  spec = await loadSpec(path.join(repoRoot, 'specs/sdd-site.spec.yaml'));
  persona = await loadPersona(path.join(repoRoot, spec.personas.working, 'backend-tdd.yaml'));
  sandbox = await startSandbox({ rootDir: path.join(repoRoot, 'site') });
});

after(async () => {
  await sandbox.finish();
});

for (const viewport of ['mobile', 'desktop']) {
  test(`reader mode produces a valid trace on ${viewport}`, async () => {
    const llm = fakeLLM();
    const trace = await runReader({ repoRoot, spec, persona, viewport, seed: 1, sandbox, llm });

    validateTrace(trace, ['explain', 'contrast', 'loop']);
    assert.equal(trace.simulatedSeconds <= 60, true);
    assert.equal(trace.answers.length, 3);
    assert.equal(trace.grades, null);
    assert.equal(trace.cost.usd, 0.001);
    assert.equal(trace.sandbox.violations, 0);
    assert.equal(trace.llmCalls.length, 1);
    assert.deepEqual(trace.llmCalls[0]!.request, llm.requests[0]);
  });
}

test('the model is shown recalled text only: no unseen page text, no rubric', async () => {
  const llm = fakeLLM();
  const trace = await runReader({ repoRoot, spec, persona, viewport: 'mobile', seed: 2, sandbox, llm });
  const shown = llm.requests[0]!.system + '\n' + llm.requests[0]!.prompt;

  // Every recalled fragment is in the prompt.
  for (const fragment of trace.recalled) assert.ok(shown.includes(fragment.text));

  // Every sentence on the page that was not recalled is absent. That covers
  // text skipped while skimming, text forgotten, and text never reached.
  const recalled = new Set(trace.recalled.map((f) => f.text));
  const pageSentences = trace.steps.flatMap((s) => s.visible).flatMap((b) => splitSentences(b.text));
  const withheld = pageSentences.filter((s) => s.length >= 25 && ![...recalled].some((r) => r.includes(s)));
  assert.ok(withheld.length > 5, 'expected the skim to leave text unread');
  for (const sentence of withheld) assert.ok(!shown.includes(sentence), `leaked: ${sentence}`);

  // A 60 second skim does not reach the end of this page, and nothing from
  // below the stopping point is in the prompt.
  assert.equal(trace.outcome, 'time_up');
  assert.ok(!shown.includes('What it builds on'));

  // The rubric is for the judge.
  for (const question of spec.questions) {
    for (const line of [...question.rubric.required, ...(question.rubric.bonus ?? [])]) {
      assert.ok(!shown.includes(line), `rubric leaked: ${line}`);
    }
  }
});

test('same seed, same skim; the trace records what the RNG was seeded with', async () => {
  const a = await runReader({ repoRoot, spec, persona, viewport: 'mobile', seed: 5, sandbox, llm: fakeLLM() });
  const b = await runReader({ repoRoot, spec, persona, viewport: 'mobile', seed: 5, sandbox, llm: fakeLLM() });
  const c = await runReader({ repoRoot, spec, persona, viewport: 'mobile', seed: 6, sandbox, llm: fakeLLM() });
  assert.deepEqual(a.steps, b.steps);
  assert.deepEqual(a.recalled, b.recalled);
  assert.equal(a.derivedSeed, b.derivedSeed);
  assert.notDeepEqual(a.recalled, c.recalled);
});

test('validateTrace rejects a trace whose prompt contains unseen text', async () => {
  const trace = await runReader({ repoRoot, spec, persona, viewport: 'mobile', seed: 3, sandbox, llm: fakeLLM() });
  const lastBlock = trace.steps.at(-1)!.visible.findLast((b) => b.text.length >= 25)!;
  const tampered = structuredClone(trace);
  tampered.recalled = [];
  tampered.llmCalls[0]!.request.prompt += `\n${lastBlock.text}`;
  assert.throws(() => validateTrace(tampered, ['explain', 'contrast', 'loop']), /leaks unseen text/);
});

test('with screenshots on, the model gets one blurred screen per step, and the trace keeps references, not bytes', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { createHash } = await import('node:crypto');
  const scratch = await mkdtemp(path.join(tmpdir(), 'sdd-shots-'));
  try {
    const llm = fakeLLM();
    const withScreens = { ...spec, reader: { ...spec.reader, screenshots: true } };
    const trace = await runReader({ repoRoot: scratch, spec: withScreens, persona, viewport: 'mobile', seed: 1, sandbox, llm, pagePath: 'site/index.html' });
    validateTrace(trace, ['explain', 'contrast', 'loop']);

    const sent = llm.requests[0]!.images!;
    assert.equal(sent.length, trace.steps.length, 'one screenshot per screen the reader reached');
    assert.ok(sent.every((image) => image.base64 && image.base64.length > 1000));
    assert.match(llm.requests[0]!.system, /Body text in them is blurred/);

    const stored = trace.llmCalls[0]!.request.images!;
    assert.equal(stored.length, sent.length);
    for (const image of stored) {
      assert.equal(image.base64, undefined, 'image bytes are not stored in the trace');
      const bytes = await readFile(path.join(scratch, image.ref!));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), image.sha256);
    }
    // The skim does not depend on the screenshots.
    const without = await runReader({ repoRoot, spec, persona, viewport: 'mobile', seed: 1, sandbox, llm: fakeLLM() });
    assert.deepEqual(trace.steps, without.steps);
    assert.deepEqual(trace.recalled, without.recalled);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
