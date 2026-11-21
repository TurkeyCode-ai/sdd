// Runner command line.
//
//   node runner/cli.ts reader --persona backend-tdd [--viewport mobile] [--seed 1]
//                             [--spec specs/sdd-site.spec.yaml]
//
// Runs one persona through reader mode and writes one trace.

import path from 'node:path';
import { parseArgs } from 'node:util';
import { createLLM } from './llm/index.ts';
import { runReader } from './reader/run.ts';
import { startSandbox } from './sandbox/sandbox.ts';
import { loadPersona, loadSpec } from './spec.ts';
import { writeTrace } from './trace.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    spec: { type: 'string', default: 'specs/sdd-site.spec.yaml' },
    persona: { type: 'string' },
    viewport: { type: 'string', default: 'mobile' },
    seed: { type: 'string', default: '1' },
  },
});

if (positionals[0] !== 'reader' || !values.persona) {
  console.error('Usage: node runner/cli.ts reader --persona <id> [--viewport mobile|desktop] [--seed n] [--spec file]');
  process.exit(2);
}

const spec = await loadSpec(path.resolve(repoRoot, values.spec));
const persona = await loadPersona(path.resolve(repoRoot, spec.personas.working, `${values.persona}.yaml`));
if (!spec.page) throw new Error('This spec names no page file. Use the batch command with --target.');
const sandbox = await startSandbox({
  rootDir: path.dirname(path.resolve(repoRoot, spec.page)),
  indexFile: path.resolve(repoRoot, spec.page),
});

let trace;
try {
  trace = await runReader({
    repoRoot,
    spec,
    persona,
    viewport: values.viewport,
    seed: Number(values.seed),
    sandbox,
    llm: createLLM(),
  });
} finally {
  await sandbox.finish();
}

const file = await writeTrace(path.join(repoRoot, 'traces'), trace);
const seen = trace.steps.flatMap((s) => s.seen);
const pageWords = trace.page.words;
const seenWords = seen.reduce((n, f) => n + f.text.split(/\s+/).length, 0);

console.log(`${trace.persona.id} on ${trace.viewport.name}, seed ${trace.seed}`);
console.log(`  skim: ${trace.steps.length} screens, ${trace.simulatedSeconds}s simulated, ended by ${trace.outcome}, deepest section "${trace.deepestSection}"`);
console.log(`  took in ${seen.length} fragments (${seenWords} of ${pageWords} words), recalled ${trace.recalled.length}`);
for (const a of trace.answers) console.log(`  ${a.id}: ${a.answer}`);
console.log(`  cost: $${trace.cost.usd.toFixed(4)} (${trace.llmCalls[0]!.response.model}), not graded yet`);
console.log(`  trace: ${path.relative(repoRoot, file)}`);
