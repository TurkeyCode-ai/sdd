// Paired comparison of two page variants.
//
//   node scorer/compare.ts --a <batch>[:<grades label>] --b <batch>[:<grades label>]
//
// A is the baseline, B the candidate. Runs are paired on persona, viewport,
// and seed. Writes reports/<experiment>/compare-<a>-vs-<b>.md.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { loadSpec, type Spec } from '../runner/spec.ts';
import type { Trace } from '../runner/trace.ts';
import { pairedDifference, verdict, wilson } from './stats.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const { values } = parseArgs({
  options: { spec: { type: 'string', default: 'specs/sdd-site.spec.yaml' }, a: { type: 'string' }, b: { type: 'string' } },
});
if (!values.a || !values.b) {
  console.error('Usage: node scorer/compare.ts --a <batch>[:<grades label>] --b <batch>[:<grades label>]');
  process.exit(2);
}
const specFile = path.resolve(repoRoot, values.spec);
const spec = await loadSpec(specFile);
const pass = (parse(await readFile(specFile, 'utf8')) as { pass: Record<string, number> }).pass;

async function loadBatch(spec: Spec, ref: string): Promise<Trace[]> {
  const [batch, label] = ref.split(':') as [string, string?];
  const dir = path.join(repoRoot, 'traces', spec.experiment);
  const traces: Trace[] = [];
  for (const file of (await readdir(dir)).sort()) {
    if (!file.endsWith('.json')) continue;
    const trace = JSON.parse(await readFile(path.join(dir, file), 'utf8')) as Trace;
    if (trace.batch !== batch) continue;
    if (label) {
      const regrade = JSON.parse(await readFile(path.join(repoRoot, 'grades', spec.experiment, batch, label, file), 'utf8')) as { grades: Trace['grades'] };
      trace.grades = regrade.grades;
    }
    if (!trace.grades) throw new Error(`${file} is not graded`);
    traces.push(trace);
  }
  if (traces.length === 0) throw new Error(`No traces for batch "${batch}"`);
  if (new Set(traces.map((t) => t.page.sha256)).size !== 1) throw new Error(`Batch "${batch}" mixes page variants`);
  return traces;
}

const A = await loadBatch(spec, values.a);
const B = await loadBatch(spec, values.b);
if (A[0]!.page.sha256 === B[0]!.page.sha256) throw new Error('Both batches ran the same page. Nothing to compare.');

const key = (t: Trace) => `${t.persona.id}|${t.viewport.name}|${t.seed}`;
const byKey = new Map(B.map((t) => [key(t), t]));
const pairs = A.filter((t) => byKey.has(key(t))).map((a) => ({ a, b: byKey.get(key(a))! }));
const passed = (t: Trace, id: string) => t.grades!.find((g) => g.questionId === id)!.pass;
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const pts = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}`;

function section(set: 'working' | 'holdout'): string {
  const ps = pairs.filter((p) => p.a.personaSet === set);
  if (ps.length === 0) return 'No pairs.';
  const lines = spec.questions.map((q) => {
    const gained = ps.filter((p) => !passed(p.a, q.id) && passed(p.b, q.id)).length;
    const lost = ps.filter((p) => passed(p.a, q.id) && !passed(p.b, q.id)).length;
    const d = pairedDifference(gained, lost, ps.length);
    const rateA = ps.filter((p) => passed(p.a, q.id)).length / ps.length;
    const wb = wilson(ps.filter((p) => passed(p.b, q.id)).length, ps.length);
    const threshold = Number(pass[`${q.id}_rate`]);
    const call = d.lower > 0 ? 'B BETTER' : d.upper < 0 ? 'B WORSE' : 'INSIDE THE NOISE';
    return `| ${q.id} | ${pct(rateA)} | ${pct(wb.rate)} | ${pts(d.difference)} (${pts(d.lower)} to ${pts(d.upper)}) | ${gained} gained, ${lost} lost | ${d.p < 0.001 ? '<0.001' : d.p.toFixed(3)} | ${call} | ${pct(wb.lower)} to ${pct(wb.upper)} vs ${pct(threshold)}: ${verdict(wb, threshold).toUpperCase()} |`;
  });
  return [
    `${ps.length} pairs.`,
    '',
    '| Question | A | B | Change in points (95% interval) | Pairs that flipped | p | Call | B against its threshold |',
    '|---|---|---|---|---|---|---|---|',
    ...lines,
  ].join('\n');
}

const reach = (set: Trace[]) => {
  const order: string[] = [];
  for (const t of [...set].sort((x, y) => y.steps.length - x.steps.length)) for (const b of t.steps.flatMap((s) => s.visible)) if (!order.includes(b.section)) order.push(b.section);
  const at = order.indexOf('scorecard');
  return set.filter((t) => at >= 0 && order.indexOf(t.deepestSection) >= at).length / set.length;
};

const md = `# Paired comparison: ${spec.experiment}

- A (baseline): batch \`${values.a}\`, page \`${A[0]!.page.path}\`, sha256 \`${A[0]!.page.sha256.slice(0, 12)}\`, ${A[0]!.page.words} words
- B (candidate): batch \`${values.b}\`, page \`${B[0]!.page.path}\`, sha256 \`${B[0]!.page.sha256.slice(0, 12)}\`, ${B[0]!.page.words} words
- Pairs: ${pairs.length} of ${A.length} A runs and ${B.length} B runs, matched on persona, viewport, and seed
${A.every((t) => t.dials.calibrated) && B.every((t) => t.dials.calibrated) ? '' : '- **Dials are not calibrated.** This compares two pages for the simulated readers. It is not a prediction about real readers.\n'}
A change counts only when its whole 95% interval is on one side of zero. Otherwise it is inside the noise and is not a result.

## Working set

${section('working')}

## Holdout set

${section('holdout')}

## Secondary

- Readers who reached the scorecard: A ${pct(reach(A))}, B ${pct(reach(B))}
- Words on the page: A ${A[0]!.page.words}, B ${B[0]!.page.words}

## How to read this

The interval is for the paired difference (B minus A). The p value is an exact McNemar test on the pairs that flipped. Pairs share a persona, a viewport, and a skim seed. The model's answers and the judge's grades are not seeded, so some flips in both directions are expected even between two runs of the same page.
`;

const outDir = path.join(repoRoot, 'reports', spec.experiment);
await mkdir(outDir, { recursive: true });
const name = `compare-${values.a.replace(':', '-')}-vs-${values.b.replace(':', '-')}.md`;
await writeFile(path.join(outDir, name), md);
console.log(md);
console.log(`Report: reports/${spec.experiment}/${name}`);
