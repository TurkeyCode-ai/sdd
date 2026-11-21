import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdict, wilson } from './stats.ts';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 0.0015, `${a} is not near ${b}`);

test('wilson matches published values', () => {
  // 81 of 263 is a standard worked example: 0.2553 to 0.3662.
  const a = wilson(81, 263);
  near(a.lower, 0.2553);
  near(a.upper, 0.3662);
  // Edges stay inside 0 to 1 and are not degenerate.
  const none = wilson(0, 10);
  assert.equal(none.lower, 0);
  near(none.upper, 0.2775);
  const all = wilson(10, 10);
  near(all.lower, 0.7225);
  assert.equal(all.upper, 1);
});

test('a threshold is met only when the lower bound clears it', () => {
  // 9 of 10 looks like 90% but the lower bound is about 60%.
  assert.equal(verdict(wilson(9, 10), 0.8), 'inside the noise');
  assert.equal(verdict(wilson(180, 200), 0.8), 'met');
  assert.equal(verdict(wilson(100, 200), 0.8), 'not met');
  assert.equal(verdict(wilson(160, 200), 0.8), 'inside the noise');
});

test('pairedDifference: interval and exact McNemar p', async () => {
  const { pairedDifference } = await import('./stats.ts');
  // No flips: no difference, p of 1.
  assert.deepEqual(pairedDifference(0, 0, 100), { difference: 0, lower: 0, upper: 0, p: 1 });
  // 10 gained, 0 lost: p = 2 * 0.5^10.
  const clear = pairedDifference(10, 0, 100);
  near(clear.p, 2 * 0.5 ** 10);
  assert.ok(clear.lower > 0);
  // 6 gained, 4 lost of 100: p = 0.754, interval spans zero.
  const noisy = pairedDifference(6, 4, 100);
  near(noisy.p, 0.7539);
  assert.ok(noisy.lower < 0 && noisy.upper > 0);
  near(noisy.difference, 0.02);
});
