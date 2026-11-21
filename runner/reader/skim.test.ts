import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../rng.ts';
import { recall, skim, splitSentences, UNCALIBRATED_DIALS, type Block } from './skim.ts';

// A tall fake page: 30 sections, each a heading and a three sentence paragraph.
const blocks: Block[] = [];
for (let i = 0; i < 30; i++) {
  const top = i * 300;
  blocks.push({ id: blocks.length, kind: 'heading', section: `s${i}`, text: `Heading ${i}`, top, bottom: top + 40, left: 0 });
  blocks.push({
    id: blocks.length,
    kind: 'body',
    section: `s${i}`,
    text: `First sentence of part ${i} runs to about ten words here. Second sentence of part ${i} is also ten words long. Third one for part ${i} closes the paragraph out.`,
    top: top + 60,
    bottom: top + 260,
    left: 0,
  });
}
const pageHeight = 30 * 300;
const persona = { reading_wpm: 250, skim_rate: 0.5 };
const run = (seed: number, dials = UNCALIBRATED_DIALS, p = persona) => skim(blocks, 700, pageHeight, p, dials, createRng(seed));

test('splitSentences splits on sentence ends, not on decimals', () => {
  assert.deepEqual(splitSentences('Clears 7.5 inches. Carries 20 lbs! Done?'), ['Clears 7.5 inches.', 'Carries 20 lbs!', 'Done?']);
});

test('same seed gives the same skim, a different seed a different one', () => {
  assert.deepEqual(run(7), run(7));
  assert.notDeepEqual(run(7).seen, run(8).seen);
});

test('every heading that was reached is seen, body text only in part', () => {
  const result = run(3);
  for (const step of result.steps.slice(0, -1)) {
    for (const block of step.visible.filter((b) => b.kind === 'heading')) {
      assert.ok(step.seen.some((f) => f.blockId === block.id), `heading ${block.id} was skipped`);
    }
  }
  const offered = result.steps.slice(0, -1).flatMap((s) => s.visible).filter((b) => b.kind === 'body').length * 3;
  const read = result.steps.slice(0, -1).flatMap((s) => s.seen).filter((f) => f.kind === 'body').length;
  assert.ok(read > 0 && read < offered, `read ${read} of ${offered} body sentences`);
});

test('the session ends when the time budget is spent', () => {
  const result = run(1);
  assert.equal(result.outcome, 'time_up');
  assert.equal(result.simulatedSeconds, 60);
  assert.ok(result.seen.every((f) => f.t <= 60));
  assert.equal(result.steps.at(-1)!.action, 'stop');
  assert.notEqual(result.deepestSection, 's29', 'a 60 second skim should not finish this page');
});

test('a bigger budget reaches the end of the page', () => {
  const result = run(1, { ...UNCALIBRATED_DIALS, timeBudgetSeconds: 3600 });
  assert.equal(result.outcome, 'end_of_page');
  assert.equal(result.deepestSection, 's29');
});

test('skim rate 0 reads everything, skim rate 1 reads headings only', () => {
  const all = run(1, { ...UNCALIBRATED_DIALS, timeBudgetSeconds: 3600 }, { reading_wpm: 250, skim_rate: 0 });
  assert.equal(all.seen.length, 30 + 90);
  const none = run(1, { ...UNCALIBRATED_DIALS, timeBudgetSeconds: 3600 }, { reading_wpm: 250, skim_rate: 1 });
  assert.ok(none.seen.every((f) => f.kind === 'heading'));
  assert.equal(none.seen.length, 30);
});

test('recall returns a subset of what was seen, and all of it with no decay', () => {
  const result = run(5);
  const kept = recall(result.seen, 60, { ...UNCALIBRATED_DIALS, recallDecayPerSecond: 0.05 }, createRng(1));
  assert.ok(kept.length < result.seen.length);
  assert.ok(kept.every((f) => result.seen.includes(f)));
  const perfect = recall(result.seen, 60, { ...UNCALIBRATED_DIALS, recallDecayPerSecond: 0 }, createRng(1));
  assert.equal(perfect.length, result.seen.length);
});
