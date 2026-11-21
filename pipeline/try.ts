// The "try" stage: a developer at a terminal on a clean machine, handed only
// what the page says.
//
// The machine is a fresh container. The developer is a model with no tools:
// it reads the page's text and the terminal so far, and names the next
// command. The pipeline runs that command in the container and captures what
// really came back. Whether it worked is judged from that captured output
// against the spec's check, never from anything the developer model claims.

import { spawn } from 'node:child_process';
import type { LLM } from '../runner/llm/types.ts';
import type { TryStage } from './spec.ts';

export interface TryStep {
  command: string;
  why: string;
  exitCode: number | null;
  output: string;
  seconds: number;
}

export interface TryRun {
  n: number;
  met: boolean;
  /** How it ended: the check passed, the developer stopped, time ran out, or the step limit was hit. */
  ended: 'check met' | 'stopped' | 'time limit' | 'step limit' | 'error';
  note: string;
  steps: TryStep[];
  seconds: number;
  costUsd: number;
}

/** Runs one command somewhere and reports what came back. Swapped in tests. */
export interface Machine {
  exec(command: string, timeoutSeconds: number): Promise<{ exitCode: number | null; output: string; seconds: number }>;
  destroy(): Promise<void>;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, out: String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

/** The image name from the spec's description of the machine: its first word. */
export const imageOf = (stage: TryStage): string => stage.machine.image.trim().split(/[\s(,]/)[0]!;

/**
 * A fresh container, exactly as the image ships: its ordinary non-root user,
 * no terminal attached, no environment beyond the image's own. Nothing is set
 * up for the developer, so a global npm install fails here as it does for real.
 */
export async function startContainer(stage: TryStage, name: string): Promise<Machine> {
  const image = imageOf(stage);
  const started = await run('docker', [
    'run', '-d', '--rm', '--name', name, '--user', 'node', '-w', '/home/node',
    image, 'sleep', '3600',
  ], 120_000);
  if (started.code !== 0) throw new Error(`Could not start a clean ${image} machine: ${started.out.slice(0, 300)}`);
  return {
    async exec(command, timeoutSeconds) {
      const t0 = Date.now();
      // No terminal and no stdin, as the spec's machine says. timeout(1) ends a command that hangs.
      const r = await run('docker', ['exec', name, 'timeout', '-s', 'KILL', String(timeoutSeconds), 'bash', '-lc', command], (timeoutSeconds + 15) * 1000);
      return { exitCode: r.code, output: r.out.slice(-6000), seconds: (Date.now() - t0) / 1000 };
    },
    async destroy() {
      await run('docker', ['rm', '-f', name], 60_000);
    },
  };
}

const DEVELOPER_SYSTEM = `You predict what a developer does at a terminal on a machine they have just been given.

They have read one web page and know nothing else about the product on it. They were asked to try it. They follow what the page says, in the order it says it, the way a competent developer in a hurry would: they copy commands as written, adapt the obvious placeholder, read errors, and try the next thing the page suggests.
- They do not know anything the page does not say. Do not use outside knowledge of this product.
- They can make a folder, change into it, and run commands. Each command you give runs in a fresh shell in their home folder, so chain what belongs together with && (for example: mkdir -p todo && cd todo && <command>).
- There is no terminal attached: nothing interactive can be answered.
- They stop when the product has clearly run and told them something they cannot get past from the page alone, or when the page gives them nothing more to try.
Give one command, or stop.`;

const STEP_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['run', 'stop'] },
    command: { type: 'string', description: 'One shell command line. Empty when stopping.' },
    why: { type: 'string', description: 'One line: what on the page led to this.' },
  },
  required: ['action', 'command', 'why'],
  additionalProperties: false,
};

const CHECK_SYSTEM = `You decide whether something observable happened, from a terminal transcript.

You get the thing that must be observed, how it is to be seen, and the real transcript: each command that was run, its exit code, and what it printed. The transcript was captured by the test, not written by the person at the terminal.
- Judge only from command output and exit codes. Text that the person typed themselves, such as an echo of the expected message, does not count.
- If the check names specific output and an exit code, both have to be there, from the same command.
Answer whether it was met, with one line pointing at the command and output that shows it.`;

/** What the developer is asked to do: the quoted sentence in the spec's "given", or the stage goal. */
export function taskSentence(stage: TryStage): string {
  // An opening quote follows a space. That skips the apostrophe in words like "site's".
  return stage.given.match(/(?:^|\s)'([^']{10,})'/)?.[1] ?? stage.goal;
}

async function checkMet(llm: LLM, stage: TryStage, steps: TryStep[]): Promise<{ met: boolean; note: string; costUsd: number }> {
  if (steps.length === 0) return { met: false, note: 'No command was run.', costUsd: 0 };
  const response = await llm.complete({
    role: 'judge',
    system: CHECK_SYSTEM,
    prompt: [
      `What must be observed: ${stage.success.observable}`,
      `How it is seen: ${stage.success.check}`,
      '',
      '# Transcript',
      ...steps.map((s, i) => `\n## Command ${i + 1} (exit code ${s.exitCode}, ${s.seconds.toFixed(0)} s)\n$ ${s.command}\n${s.output || '(no output)'}`),
    ].join('\n'),
    schema: { type: 'object', properties: { met: { type: 'boolean' }, note: { type: 'string' } }, required: ['met', 'note'], additionalProperties: false },
  });
  const out = response.structured as { met?: boolean; note?: string } | undefined;
  return { met: out?.met === true, note: out?.note ?? '', costUsd: response.costUsd };
}

export interface TryOptions {
  stage: TryStage;
  /** The page's text, as a visitor reads it. The only thing the developer knows. */
  pageText: string;
  llm: LLM;
  machine: Machine;
  n: number;
  maxSteps?: number;
  /** Seconds each command may take before it is killed. */
  commandTimeoutSeconds?: number;
}

export async function tryOnce(options: TryOptions): Promise<TryRun> {
  const { stage, llm, machine } = options;
  const maxSteps = options.maxSteps ?? 10;
  const steps: TryStep[] = [];
  let costUsd = 0;
  let ended: TryRun['ended'] = 'step limit';
  const t0 = Date.now();
  const elapsed = () => (Date.now() - t0) / 1000;

  try {
    while (steps.length < maxSteps) {
      if (elapsed() >= stage.timeLimitSeconds) { ended = 'time limit'; break; }
      const response = await llm.complete({
        role: 'judge',
        system: DEVELOPER_SYSTEM,
        prompt: [
          '# The page they read', '', options.pageText, '',
          `# What they were asked`, '', taskSentence(stage), '',
          '# The terminal so far', '',
          steps.length === 0 ? '(nothing run yet)' : steps.map((s) => `$ ${s.command}\n${s.output.slice(-1500) || '(no output)'}\n[exit code ${s.exitCode}]`).join('\n\n'),
          '', 'What do they do next?',
        ].join('\n'),
        schema: STEP_SCHEMA,
      });
      costUsd += response.costUsd;
      const step = response.structured as { action?: string; command?: string; why?: string } | undefined;
      if (!step || step.action !== 'run' || !step.command?.trim()) { ended = 'stopped'; break; }

      const left = Math.max(5, Math.floor(stage.timeLimitSeconds - elapsed()));
      const result = await machine.exec(step.command, Math.min(options.commandTimeoutSeconds ?? 150, left));
      steps.push({ command: step.command, why: step.why ?? '', ...result });
    }
    const verdict = await checkMet(llm, stage, steps);
    costUsd += verdict.costUsd;
    return { n: options.n, met: verdict.met, ended: verdict.met ? 'check met' : ended, note: verdict.note, steps, seconds: elapsed(), costUsd };
  } catch (err) {
    return { n: options.n, met: false, ended: 'error', note: (err as Error).message.slice(0, 300), steps, seconds: elapsed(), costUsd };
  }
}

export interface TryResult {
  runs: TryRun[];
  passed: number;
  n: number;
  costUsd: number;
}

/** Several developers, each on a machine of their own. */
export async function tryStage(
  stage: TryStage,
  pageText: string,
  llm: LLM,
  count: number,
  start: (n: number) => Promise<Machine>,
  concurrency = 3,
): Promise<TryResult> {
  const runs: TryRun[] = [];
  let next = 1;
  async function worker() {
    while (next <= count) {
      const n = next++;
      let machine: Machine | undefined;
      try {
        machine = await start(n);
        runs.push(await tryOnce({ stage, pageText, llm, machine, n }));
      } catch (err) {
        runs.push({ n, met: false, ended: 'error', note: (err as Error).message.slice(0, 300), steps: [], seconds: 0, costUsd: 0 });
      } finally {
        await machine?.destroy();
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker));
  runs.sort((a, b) => a.n - b.n);
  return { runs, passed: runs.filter((r) => r.met).length, n: runs.length, costUsd: runs.reduce((s, r) => s + r.costUsd, 0) };
}
