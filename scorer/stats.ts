// Statistics for the scorer.

export interface Interval {
  passed: number;
  n: number;
  rate: number;
  lower: number;
  upper: number;
}

/** Wilson score interval for a proportion. z = 1.96 gives 95%. */
export function wilson(passed: number, n: number, z = 1.96): Interval {
  if (n === 0) return { passed, n, rate: NaN, lower: 0, upper: 1 };
  const p = passed / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { passed, n, rate: p, lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

export type Verdict = 'met' | 'not met' | 'inside the noise';

/**
 * A threshold is met only when the lower bound clears it. When the interval
 * straddles the threshold the honest answer is that the data cannot say.
 */
export function verdict(interval: Interval, threshold: number): Verdict {
  if (interval.lower >= threshold) return 'met';
  if (interval.upper < threshold) return 'not met';
  return 'inside the noise';
}

export interface PairedDifference {
  /** B minus A, as a proportion of all pairs. */
  difference: number;
  lower: number;
  upper: number;
  /** Exact two-sided McNemar p value on the discordant pairs. */
  p: number;
}

/**
 * Paired comparison of two binary outcomes over n pairs.
 * gained: pairs where A failed and B passed. lost: the reverse.
 */
export function pairedDifference(gained: number, lost: number, n: number, z = 1.96): PairedDifference {
  const difference = (gained - lost) / n;
  const se = Math.sqrt(gained + lost - (gained - lost) ** 2 / n) / n;
  // Exact binomial test: under no difference, each flip is a coin toss.
  const flips = gained + lost;
  let p = 1;
  if (flips > 0) {
    const k = Math.min(gained, lost);
    let tail = 0;
    let term = 0.5 ** flips; // C(flips, 0) / 2^flips
    for (let i = 0; i <= k; i++) {
      tail += term;
      term = (term * (flips - i)) / (i + 1);
    }
    p = Math.min(1, 2 * tail);
  }
  return { difference, lower: difference - z * se, upper: difference + z * se, p };
}
