// Scorer: aggregates one batch of traces into a report.
//
//   node scorer/score.ts --batch <id> [--spec specs/sdd-site.spec.yaml]
//
// Writes reports/<experiment>/<batch>.md, .json, and a spot-check sheet.
// Reads traces. Never writes to them.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { createRng, deriveSeed } from '../runner/rng.ts';
import { loadSpec } from '../runner/spec.ts';
import { validateTrace, type Trace } from '../runner/trace.ts';
import { verdict, wilson, type Interval, type Verdict } from './stats.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const { values } = parseArgs({
  options: { spec: { type: 'string', default: 'specs/sdd-site.spec.yaml' }, batch: { type: 'string' }, grades: { type: 'string' } },
});
if (!values.batch) {
  console.error('Usage: node scorer/score.ts --batch <id> [--spec file]');
  process.exit(2);
}
const batch = values.batch;
const specFile = path.resolve(repoRoot, values.spec);
const spec = await loadSpec(specFile);
const pass = (parse(await readFile(specFile, 'utf8')) as { pass: Record<string, number | boolean | string> }).pass;
const questionIds = spec.questions.map((q) => q.id);
const threshold = (id: string) => Number(pass[`${id}_rate`]);

// Load and check the batch.
const dir = path.join(repoRoot, 'traces', spec.experiment);
const traces: Trace[] = [];
for (const file of (await readdir(dir)).sort()) {
  if (!file.endsWith('.json')) continue;
  const trace = JSON.parse(await readFile(path.join(dir, file), 'utf8')) as Trace;
  if (trace.batch !== batch) continue;
  validateTrace(trace, questionIds);
  if (values.grades) {
    // Use a regrade instead of the grades stored in the trace. The trace file is not changed.
    const regradeFile = path.join(repoRoot, 'grades', spec.experiment, batch, values.grades, file);
    const regrade = JSON.parse(await readFile(regradeFile, 'utf8')) as { grades: Trace['grades']; llmCalls: Trace['llmCalls']; costUsd: number };
    trace.grades = regrade.grades;
    trace.llmCalls = [...trace.llmCalls, ...regrade.llmCalls];
    trace.cost.usd += regrade.costUsd;
  }
  if (!trace.grades) throw new Error(`${file} is not graded`);
  traces.push(trace);
}
if (traces.length === 0) throw new Error(`No traces found for batch "${batch}"`);
const pageHashes = new Set(traces.map((t) => t.page.sha256));
if (pageHashes.size !== 1) throw new Error(`Batch mixes ${pageHashes.size} page variants. A batch scores one page.`);

const passed = (t: Trace, id: string) => t.grades!.find((g) => g.questionId === id)!.pass;
const rate = (set: Trace[], id: string): Interval => wilson(set.filter((t) => passed(t, id)).length, set.length);
const working = traces.filter((t) => t.personaSet === 'working');
const holdout = traces.filter((t) => t.personaSet === 'holdout');

interface Row { id: string; threshold: number; interval: Interval; verdict: Verdict }
const rows = (set: Trace[]): Row[] =>
  questionIds.map((id) => {
    const interval = rate(set, id);
    return { id, threshold: threshold(id), interval, verdict: verdict(interval, threshold(id)) };
  });
const workingRows = rows(working);
const holdoutRows = rows(holdout);
const workingMet = workingRows.every((r) => r.verdict === 'met');
const holdoutMet = holdout.length > 0 && holdoutRows.every((r) => r.verdict === 'met');
const overall = workingMet && holdoutMet;

// Where readers stopped. Section order comes from the page as readers saw it.
const sectionOrder: string[] = [];
for (const t of [...traces].sort((a, b) => b.steps.length - a.steps.length)) {
  for (const b of t.steps.flatMap((s) => s.visible)) if (!sectionOrder.includes(b.section)) sectionOrder.push(b.section);
}
const reached = (t: Trace, section: string) => {
  const at = sectionOrder.indexOf(section);
  return at >= 0 && sectionOrder.indexOf(t.deepestSection) >= at;
};

// Which rubric elements were missed.
const missed = spec.questions.flatMap((q) =>
  q.rubric.required.map((element, i) => ({
    question: q.id,
    element,
    working: wilson(working.filter((t) => !t.grades!.find((g) => g.questionId === q.id)!.requiredMet[i]).length, working.length),
    holdout: wilson(holdout.filter((t) => !t.grades!.find((g) => g.questionId === q.id)!.requiredMet[i]).length, holdout.length),
  })),
);

const calls = traces.flatMap((t) => t.llmCalls);
const costBy = (role: string) => calls.filter((c) => c.request.role === role).reduce((s, c) => s + c.response.costUsd, 0);
const modelOf = (role: string) => calls.find((c) => c.request.role === role)?.response.model ?? 'none';
const totalCost = traces.reduce((s, t) => s + t.cost.usd, 0);
const calibrated = traces.every((t) => t.dials.calibrated);
const first = traces[0]!;

// ---------- report ----------
const pct = (x: number) => (Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(0)}%`);
const ci = (i: Interval) => `${pct(i.lower)} to ${pct(i.upper)}`;
const cell = (i: Interval) => `${pct(i.rate)} (${i.passed}/${i.n})`;
const table = (head: string[], body: string[][]) =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const verdictTable = (set: Row[]) =>
  table(
    ['Question', 'Passed', '95% interval', 'Threshold', 'Verdict'],
    set.map((r) => [r.id, cell(r.interval), ci(r.interval), pct(r.threshold), r.verdict.toUpperCase()]),
  );
const groupTable = (label: string, groups: Map<string, Trace[]>) =>
  table(
    [label, 'Runs', ...questionIds],
    [...groups].map(([name, set]) => [name, String(set.length), ...questionIds.map((id) => `${cell(rate(set, id))}, ${ci(rate(set, id))}`)]),
  );
const groupBy = (set: Trace[], f: (t: Trace) => string) => {
  const m = new Map<string, Trace[]>();
  for (const t of set) m.set(f(t), [...(m.get(f(t)) ?? []), t]);
  return m;
};

const noisy = [...workingRows.map((r) => `working ${r.id}`), ...holdoutRows.map((r) => `holdout ${r.id}`)].filter(
  (_, i) => [...workingRows, ...holdoutRows][i]!.verdict === 'inside the noise',
);
const viewportNames = [...new Set(traces.map((t) => t.viewport.name))];
const scorecardReach = wilson(working.filter((t) => reached(t, 'scorecard')).length, working.length);

const md = `# Score report: ${spec.experiment}, batch "${batch}"

**Overall: ${overall ? 'PASS' : 'NOT PASSED'}.** ${
  overall
    ? 'Every threshold is cleared by the lower bound of its interval, on the working set and on the holdout set.'
    : 'A threshold counts as met only when the lower bound of its 95% interval clears it, on both the working set and the holdout set.'
}

${calibrated ? '' : '**These dials are not calibrated.** No real reader has been measured yet, so these rates say how the simulated readers did, not how real developers would. Do not publish them as predictions.\n'}
- Page: \`${first.page.path}\`, sha256 \`${first.page.sha256.slice(0, 12)}\`, ${first.page.words} visible words
- Runs: ${traces.length} (${working.length} working, ${holdout.length} holdout), viewports: ${viewportNames.join(', ')}
- Time budget: ${first.dials.timeBudgetSeconds} simulated seconds. Skim scale ${first.dials.skimScale}, recall decay ${first.dials.recallDecayPerSecond} per second.
${values.grades ? `- Grades: regrade "${values.grades}". Cost includes the original grading and the regrade.\n` : ''}- Models: persona \`${modelOf('persona')}\`, judge \`${modelOf('judge')}\`
- Cost at list prices: $${totalCost.toFixed(2)} (persona $${costBy('persona').toFixed(2)}, judge $${costBy('judge').toFixed(2)})

## Working set

${verdictTable(workingRows)}

## Holdout set

Kept separate. The revising agent never sees these personas.

${holdout.length ? verdictTable(holdoutRows) : 'No holdout runs in this batch.'}

Thresholds hold on the holdout set: **${holdout.length === 0 ? 'not run' : holdoutMet ? 'yes' : 'no'}**.${
  holdout.length === 0
    ? ''
    : ` Questions where holdout and working get a different verdict: ${
        workingRows.filter((r, i) => r.verdict !== holdoutRows[i]!.verdict).map((r) => r.id).join(', ') || 'none'
      }.`
}

## What is inside the noise

${
  noisy.length
    ? `For these, the interval straddles the threshold, so this batch cannot say whether the threshold is met: ${noisy.join(', ')}. More runs would narrow the interval.`
    : 'Nothing. Every interval sits clearly above or clearly below its threshold.'
}

The intervals treat every run as independent. Runs share personas, and the same persona tends to succeed or fail in the same way, so the true uncertainty is somewhat wider than shown.

## By viewport (working set)

${groupTable('Viewport', groupBy(working, (t) => t.viewport.name))}

## By persona

${groupTable('Persona', groupBy(traces, (t) => `${t.persona.id}${t.personaSet === 'holdout' ? ' (holdout)' : ''}`))}

## Where readers stopped

Share of runs whose reader got at least as far as each section before the time ran out.

${table(
  ['Section', ...viewportNames.map((v) => `${v} (working)`), 'holdout'],
  sectionOrder.map((s) => [
    s,
    ...viewportNames.map((v) => {
      const set = working.filter((t) => t.viewport.name === v);
      return pct(set.filter((t) => reached(t, s)).length / set.length);
    }),
    holdout.length ? pct(holdout.filter((t) => reached(t, s)).length / holdout.length) : 'n/a',
  ]),
)}

Sections that no reader reached do not appear above.

## Rubric elements missed most

Share of answers that did not state each required element.

${table(
  ['Question', 'Required element', 'Missed (working)', 'Missed (holdout)'],
  [...missed].sort((a, b) => b.working.rate - a.working.rate).map((m) => [m.question, m.element, cell(m.working), holdout.length ? cell(m.holdout) : 'n/a']),
)}

## Secondary measures (reported, not gating)

- Readers who reached the scorecard section (working): ${cell(scorecardReach)}, interval ${ci(scorecardReach)}
- Words on the page: ${first.page.words}
- Skeptic personas whose main objection was answered: not measured. Reader mode does not ask this yet.
`;

const outDir = path.join(repoRoot, 'reports', spec.experiment);
const outName = values.grades ? `${batch}-judge-${values.grades}` : batch;
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, `${outName}.md`), md);
await writeFile(
  path.join(outDir, `${outName}.json`),
  JSON.stringify(
    { experiment: spec.experiment, batch, page: first.page, runs: traces.length, calibrated, overall, working: workingRows, holdout: holdoutRows, missed, sectionOrder, scorecardReach, costUsd: totalCost },
    null,
    2,
  ) + '\n',
);

// Spot-check sheet: a seeded 10 percent sample of graded answers for Chad.
const rng = createRng(deriveSeed('spot-check', batch));
const csv = (s: string) => `"${s.replaceAll('"', '""')}"`;
const sample = traces
  .flatMap((t) => t.grades!.map((g) => ({ t, g })))
  .filter(() => rng() < 0.1)
  .map(({ t, g }) => {
    const q = spec.questions.find((x) => x.id === g.questionId)!;
    return [
      t.runId, q.id, q.ask, t.answers.find((a) => a.id === q.id)!.answer,
      q.rubric.required.map((r, i) => `${g.requiredMet[i] ? 'MET' : 'NOT MET'}: ${r}`).join(' / '),
      g.pass ? 'pass' : 'fail', g.note, '', '',
    ].map(csv).join(',');
  });
await writeFile(
  path.join(outDir, `${outName}-spot-check.csv`),
  ['run,question,asked,answer,judge_on_required_elements,judge_grade,judge_note,chad_grade,chad_comment', ...sample].join('\n') + '\n',
);

console.log(md.split('\n## By viewport')[0]);
console.log(`Report: reports/${spec.experiment}/${outName}.md`);
console.log(`Spot-check sheet: reports/${spec.experiment}/${outName}-spot-check.csv (${sample.length} answers)`);
