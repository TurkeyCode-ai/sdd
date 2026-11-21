import { createClaudeCodeLLM } from './claude-code.ts';
import type { LLM } from './types.ts';

export * from './types.ts';

/** SDD_LLM_PROVIDER picks the provider. Only claude-code exists so far. */
export function createLLM(): LLM {
  const provider = process.env.SDD_LLM_PROVIDER ?? 'claude-code';
  switch (provider) {
    case 'claude-code':
      return createClaudeCodeLLM();
    default:
      throw new Error(`Unknown SDD_LLM_PROVIDER "${provider}"`);
  }
}
