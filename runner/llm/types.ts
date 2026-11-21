// Provider-agnostic LLM interface. The runner, judge, and reviser talk to
// this and nothing else. The model for each role comes from the environment.

export type LLMRole = 'persona' | 'judge' | 'reviser';

export interface LLMRequest {
  role: LLMRole;
  system: string;
  prompt: string;
  /**
   * Images shown to the model, before the prompt text. `base64` is dropped
   * when a call is stored in a trace. `ref` and `sha256` stay, so the image
   * can be found and checked later.
   */
  images?: LLMImage[];
  /** JSON Schema for the reply. When set, the reply is parsed into `structured`. */
  schema?: Record<string, unknown>;
}

export interface LLMImage {
  mediaType: 'image/jpeg' | 'image/png';
  base64?: string;
  /** Where the image file is stored, relative to the repo root. */
  ref?: string;
  sha256?: string;
}

/** A copy of a request that is safe to store: image bytes removed. */
export function storable(request: LLMRequest): LLMRequest {
  if (!request.images) return request;
  return { ...request, images: request.images.map(({ base64: _dropped, ...rest }) => rest) };
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LLMResponse {
  provider: string;
  model: string;
  text: string;
  structured?: unknown;
  usage: LLMUsage;
  /** Cost at list prices as reported by the provider. Notional on a subscription. */
  costUsd: number;
  durationMs: number;
  /** The provider's full reply, kept for audit. */
  raw: unknown;
}

export interface LLM {
  provider: string;
  complete(request: LLMRequest): Promise<LLMResponse>;
}

/** One stored call: everything needed to audit a score later. */
export interface LLMCallRecord {
  request: LLMRequest;
  response: LLMResponse;
}

const DEFAULT_MODELS: Record<LLMRole, string> = {
  persona: 'claude-haiku-5-5',
  judge: 'claude-sonnet-5-5',
  reviser: 'claude-opus-5-5',
};

/** SDD_MODEL_PERSONA, SDD_MODEL_JUDGE, SDD_MODEL_REVISER override the defaults. */
export function modelFor(role: LLMRole): string {
  return process.env[`SDD_MODEL_${role.toUpperCase()}`] ?? DEFAULT_MODELS[role];
}
