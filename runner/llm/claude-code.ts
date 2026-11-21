// LLM provider that shells out to the Claude Code CLI in headless mode
// (`claude -p`), using whatever login the CLI already has.
//
// Each call is a clean, single-shot completion: no tools, no MCP servers,
// no settings or CLAUDE.md, no saved session, and an empty working directory.
// So the model sees the system prompt and the prompt, nothing from this repo.

import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { modelFor, type LLM, type LLMRequest, type LLMResponse } from './types.ts';

interface CliResult {
  is_error: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** With images, the prompt goes in as one stream-json user message and the result comes back as the last stream-json line. */
function imageInput(request: LLMRequest): string {
  const content = [
    ...request.images!.map((image) => {
      if (!image.base64) throw new Error('Image has no data');
      return { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } };
    }),
    { type: 'text', text: request.prompt },
  ];
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}

function parseResult(stdout: string, streamed: boolean): CliResult {
  if (!streamed) return JSON.parse(stdout) as CliResult;
  for (const line of stdout.split('\n').reverse()) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as CliResult & { type?: string };
      if (event.type === 'result') return event;
    } catch {
      // not a JSON line
    }
  }
  throw new Error('No result event in stream output');
}

function run(args: string[], stdin: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`claude exited ${code}: ${err || out}`.slice(0, 2000)));
    });
    child.stdin.end(stdin);
  });
}

export function createClaudeCodeLLM(): LLM {
  let cwd: Promise<string> | undefined;

  return {
    provider: 'claude-code',
    async complete(request: LLMRequest): Promise<LLMResponse> {
      cwd ??= mkdtemp(path.join(tmpdir(), 'sdd-llm-'));
      const model = modelFor(request.role);
      const args = [
        '-p',
        '--model', model,
        '--system-prompt', request.system,
        '--tools', '',
        '--strict-mcp-config',
        '--setting-sources', '',
        '--disable-slash-commands',
        '--no-session-persistence',
      ];
      const streamed = Boolean(request.images?.length);
      if (streamed) args.push('--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose');
      else args.push('--output-format', 'json');
      if (request.schema) args.push('--json-schema', JSON.stringify(request.schema));

      const started = Date.now();
      const dir = await cwd;
      // Retry transient failures (rate limits, dropped connections) with backoff.
      let raw: CliResult | undefined;
      let lastError: unknown;
      for (let attempt = 0; attempt < 4 && !raw; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 5000 * 3 ** (attempt - 1)));
        try {
          const stdout = await run(args, streamed ? imageInput(request) : request.prompt, dir);
          const parsed = parseResult(stdout, streamed);
          if (parsed.is_error) throw new Error(`claude returned an error: ${stdout.slice(0, 2000)}`);
          if (request.schema && parsed.structured_output === undefined) {
            throw new Error(`claude returned no structured output: ${stdout.slice(0, 2000)}`);
          }
          raw = parsed;
        } catch (err) {
          lastError = err;
        }
      }
      if (!raw) throw lastError;

      return {
        provider: 'claude-code',
        model,
        text: raw.result ?? '',
        structured: raw.structured_output,
        usage: {
          inputTokens: raw.usage?.input_tokens ?? 0,
          outputTokens: raw.usage?.output_tokens ?? 0,
          cacheReadTokens: raw.usage?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: raw.usage?.cache_creation_input_tokens ?? 0,
        },
        costUsd: raw.total_cost_usd ?? 0,
        durationMs: raw.duration_ms ?? Date.now() - started,
        raw,
      };
    },
  };
}
