// Step 3: the owner approves the derived spec.
//
// Approval is of exact contents. It records a hash of everything the referee
// holds plus the claims ledger. If any of that changes afterwards, the project
// is no longer approved and nothing downstream may run until the owner
// approves again.

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectLayout } from './project.ts';

export interface Approval {
  schema: 'sdd-approval/1';
  hash: string;
  approvedAt: string;
  /** The cap on simulation spend for step 4, at list prices. */
  budgetUsd: number;
  /** Anything the owner wanted on record with the approval. */
  note?: string;
}

const approvalFile = (l: ProjectLayout) => path.join(l.referee, 'approval.json');

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else out.push(full);
  }
  return out;
}

/** A hash of the spec, every persona, and the ledger. The approval file itself is left out. */
export async function specHash(l: ProjectLayout): Promise<string> {
  const files = [...(await filesUnder(l.referee)).filter((f) => f !== approvalFile(l)), l.factsFile].sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(l.root, file));
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function approve(l: ProjectLayout, options: { budgetUsd: number; note?: string }): Promise<Approval> {
  if (!(options.budgetUsd > 0)) throw new Error('An approval needs a dollar budget for the simulations.');
  await readFile(l.specFile).catch(() => { throw new Error('There is no derived spec in this project to approve.'); });
  const approval: Approval = {
    schema: 'sdd-approval/1',
    hash: await specHash(l),
    approvedAt: new Date().toISOString(),
    budgetUsd: options.budgetUsd,
    note: options.note?.trim() || undefined,
  };
  await writeFile(approvalFile(l), JSON.stringify(approval, null, 2) + '\n');
  return approval;
}

export type ApprovalState =
  | { approved: true; approval: Approval }
  | { approved: false; reason: string };

/** Whether the spec as it stands now is the one the owner approved. */
export async function approvalState(l: ProjectLayout): Promise<ApprovalState> {
  let approval: Approval;
  try {
    approval = JSON.parse(await readFile(approvalFile(l), 'utf8')) as Approval;
  } catch {
    return { approved: false, reason: 'The owner has not approved the spec.' };
  }
  if (approval.hash !== (await specHash(l))) {
    return { approved: false, reason: 'The spec, the personas or the ledger changed after the owner approved them. It needs approving again.' };
  }
  return { approved: true, approval };
}

/** Throws unless the current spec is approved. Every later step calls this first. */
export async function requireApproval(l: ProjectLayout): Promise<Approval> {
  const state = await approvalState(l);
  if (!state.approved) throw new Error(state.reason);
  return state.approval;
}
