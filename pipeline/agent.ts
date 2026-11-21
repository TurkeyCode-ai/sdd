// An agent session with tools, for pipeline steps that have to look and
// measure. The engine's own model calls have no tools at all (see
// runner/llm/claude-code.ts); this is the other kind.
//
// Every session has a named list of tools, a list of folders it may read
// beyond its own, and a dollar cap. Its cost is reported back for the log.

import { spawn } from 'node:child_process';

export interface AgentRunOptions {
  /** What this session is, for logs: "deriver". */
  name: string;
  prompt: string;
  /** Where it runs. It may write here. */
  cwd: string;
  /** Other folders it may read. */
  addDirs: string[];
  /** Built-in tools it gets. Nothing else is available to it. */
  tools: string[];
  budgetUsd: number;
  model?: string;
  timeoutMs?: number;
}

export interface AgentResult {
  ok: boolean;
  /** The session's final message. */
  text: string;
  costUsd: number;
  durationMs: number;
  turns?: number;
  /** Why it failed, when it did. */
  error?: string;
}

export interface AgentRunner {
  run(options: AgentRunOptions): Promise<AgentResult>;
}

export const DEFAULT_AGENT_MODEL = 'claude-opus-5-5';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export function agentArgs(options: AgentRunOptions, env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    '-p',
    '--model', options.model ?? env.SDD_MODEL_DERIVER ?? DEFAULT_AGENT_MODEL,
    '--output-format', 'json',
    '--max-budget-usd', options.budgetUsd.toFixed(2),
    // Only these tools exist for the session, and they run without asking.
    '--tools', options.tools.join(','),
    '--allowedTools', options.tools.join(','),
    // No user settings, no MCP servers: it must not reach a memory of earlier conversations.
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    ...options.addDirs.flatMap((dir) => ['--add-dir', dir]),
  ];
}

/** Reads the JSON the CLI prints in print mode. */
export function parseAgentOutput(stdout: string, exitCode: number | null, stderr: string): Omit<AgentResult, 'durationMs'> & { durationMs?: number } {
  try {
    const out = JSON.parse(stdout) as { result?: string; is_error?: boolean; total_cost_usd?: number; num_turns?: number; duration_ms?: number; subtype?: string };
    const ok = exitCode === 0 && out.is_error !== true;
    return {
      ok,
      text: out.result ?? '',
      costUsd: typeof out.total_cost_usd === 'number' ? out.total_cost_usd : 0,
      turns: out.num_turns,
      durationMs: out.duration_ms,
      error: ok ? undefined : `${out.subtype ?? 'error'}: ${(out.result ?? stderr).slice(0, 600)}`,
    };
  } catch {
    return { ok: false, text: '', costUsd: 0, error: `claude exited ${exitCode}: ${(stderr || stdout).slice(0, 600)}` };
  }
}

export function createClaudeAgent(): AgentRunner {
  return {
    run(options) {
      const started = Date.now();
      return new Promise((resolve) => {
        const child = spawn('claude', agentArgs(options), { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        child.on('error', (e) => {
          clearTimeout(timer);
          resolve({ ok: false, text: '', costUsd: 0, durationMs: Date.now() - started, error: `could not start claude: ${e.message}` });
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          const parsed = parseAgentOutput(out, code, err);
          resolve({
            ...parsed,
            durationMs: Date.now() - started,
            ok: parsed.ok && !timedOut,
            error: timedOut ? `${options.name} was stopped after ${Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 60000)} minutes` : parsed.error,
          });
        });
        child.stdin.end(options.prompt);
      });
    },
  };
}
