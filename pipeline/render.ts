// The derived spec in plain language, for the owner to read and approve.
// Everything in it comes from the checked spec and ledger. Nothing is scored
// here, and the page says so.

import type { Ledger } from './facts.ts';
import type { Assumption, PipelineSpec, SpecPersona, Stage } from './spec.ts';

const pct = (x: number) => `${Math.round(x * 100)}%`;

function persona(p: SpecPersona): string {
  return [
    `**${p.id}**${p.holdout ? ' (held back)' : ''}: ${p.archetype}`,
    `  - ${p.role}. ${p.experience}`,
    `  - Already uses: ${p.alreadyUses.join(', ')}`,
    `  - Arrives from ${p.arrivalSource}, having seen: "${p.arrivalSaw}"`,
    `  - Hopes for: ${p.needs.join('; ')}`,
    `  - Doubts: ${p.objections.join('; ')}`,
    `  - Reads at ${p.readingWpm} words a minute and skips ${pct(p.skimRate)} of body text`,
  ].join('\n');
}

function stage(s: Stage, n: number): string {
  const lines: string[] = [];
  if (s.kind === 'read') {
    lines.push(`### Stage ${n}: ${s.id} (reading)`, '', s.goal, '');
    lines.push(`Each person arrives from ${s.entryFrom}, skims for ${s.timeBudgetSeconds} seconds on ${s.viewports.join(' and ')}, then the page is taken away and they answer from memory.`, '');
    lines.push('| Question | A passing answer states | Must pass | Why |', '|---|---|---|---|');
    for (const q of s.questions) lines.push(`| ${q.ask} | ${q.required.join('<br>')} | ${pct(q.threshold)} | ${q.reason} |`);
  } else if (s.kind === 'decide') {
    lines.push(`### Stage ${n}: ${s.id} (deciding)`, '', s.goal, '');
    lines.push(`Nobody asks them to do anything. They arrive from ${s.entryFrom} on ${s.viewports.join(' and ')}, have ${s.patienceSeconds} seconds of patience, and leaving is the default.`, '');
    lines.push('It counts when a person does any one of these:');
    for (const a of s.success.leavesTo) lines.push(`- follows a link to an address that includes \`${a}\``);
    for (const c of s.success.clicks) lines.push(`- presses a control whose label includes "${c}"`);
    lines.push('', `**Must succeed: ${pct(s.threshold)}.** ${s.reason}`);
  } else if (s.kind === 'agent') {
    lines.push(`### Stage ${n}: ${s.id} (an AI agent is the visitor)`, '', s.goal, '');
    lines.push('A developer asks their coding agent for something. The agent reads the whole page as text, with no layout, images or time limit, and replies to its developer. A judge grades the reply.', '');
    lines.push('| The developer asks | Is the product a fit? | Shown to the designer? |', '|---|---|---|');
    for (const r of s.requests) lines.push(`| ${r.ask} | ${r.fits ? 'yes' : 'no'} | ${r.holdout ? 'no, held back' : 'yes'} |`);
    lines.push('', 'When the product fits, it counts if the agent recommends it, says nothing the ledger does not support, and gets these right:');
    for (const r of s.required) lines.push(`- ${r}`);
    lines.push('', 'When the product does not fit, it counts only if the agent does not recommend it. A page that oversells scores worse.');
    lines.push('', `**Must succeed: ${pct(s.threshold)}.** ${s.reason}`);
  } else {
    lines.push(`### Stage ${n}: ${s.id} (trying, in a terminal)`, '', s.goal, '');
    lines.push(`- Machine: \`${s.machine.image}\``);
    lines.push(`- Already installed: ${s.machine.preinstalled.join(', ') || 'nothing'}`);
    lines.push(`- Deliberately absent: ${s.machine.notPresent.join(', ') || 'nothing'}`);
    lines.push(`- The agent is given: ${s.given}`);
    lines.push(`- It counts when: ${s.success.observable}`);
    lines.push(`- How that is seen: ${s.success.check}`);
    lines.push(`- Time limit: ${s.timeLimitSeconds} seconds`);
    lines.push('', `**Must succeed: ${pct(s.threshold)}.** ${s.reason}`);
  }
  return lines.join('\n');
}

function assumption(a: Assumption): string {
  const value = `${a.value}${a.unit ? ` ${a.unit}` : ''}`;
  return `| ${a.statement} | ${value} | ${a.source} | ${a.how} | ${a.sweep.join(', ')} | ${a.affects.join(', ')} |`;
}

export function renderDerivedSpec(spec: PipelineSpec, ledger: Ledger, run: { costUsd: number; sources: string[] }): string {
  const working = spec.personas.filter((p) => !p.holdout);
  const holdout = spec.personas.filter((p) => p.holdout);
  const fileFacts = ledger.facts.filter((f) => f.source.kind === 'file').length;
  const out: string[] = [];

  out.push('# Derived spec', '');
  out.push(`> ${spec.result}`, '');
  out.push('This is what the sentence above was turned into. Nothing here has been simulated or scored: every score is **not run**. Read it, correct it, and approve it before anything is designed.', '');

  out.push('## Who it is for', '', spec.audience.who, '', 'Inferred from:', ...spec.audience.inferredFrom.map((s) => `- ${s}`), '');

  out.push(`## The people (${working.length} seen by the designer, ${holdout.length} held back)`, '');
  out.push('Held-back people are never shown to whoever designs or builds. They check that the result works for people it was not tuned for.', '');
  out.push(...working.map(persona), '', ...holdout.map(persona), '');

  out.push('## What has to happen, in order', '');
  spec.stages.forEach((s, i) => out.push(stage(s, i + 1), ''));

  out.push('## What the simulation takes as given', '');
  out.push('"measured" means the deriver ran something and this is the reading. "assumed" means it could not check. The sweep is the range that will be tried to find where scores break.', '');
  out.push('| Assumption | Value | Source | How | Sweep | Affects |', '|---|---|---|---|---|---|');
  out.push(...spec.assumptions.map(assumption), '');

  out.push('## What a page is allowed to say', '');
  out.push(`The ledger holds ${ledger.facts.length} statements about the product, ${fileFacts} quoted from files (each quote checked against the file) and ${ledger.facts.length - fileFacts} measured or looked up. A design that says anything else about the product fails, whatever it scores.`, '');
  if (ledger.notTrue.length > 0) {
    out.push('Things a page would be tempted to say that are not true, or not true yet:', '');
    out.push(...ledger.notTrue.map((n) => `- **${n.claim}** ${n.why}`), '');
  }

  out.push('## Questions only you can answer', '');
  out.push(...(spec.openQuestions.length > 0 ? spec.openQuestions.map((q) => `- ${q}`) : ['- None.']), '');

  out.push('## This step', '');
  out.push(`- Looked at: ${run.sources.join(', ') || 'no sources given'}`);
  out.push(`- Cost of deriving, at list prices: $${run.costUsd.toFixed(2)}`);
  out.push('- Simulated: not run. Built: not run.', '');
  return out.join('\n');
}
