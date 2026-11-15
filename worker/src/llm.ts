import type { Env } from './env';

/**
 * LLM layer — one small interface, swappable providers.
 *
 * Call sites only ever use `LlmProvider.generate()` via `getLlmProvider()`.
 * Adding a second provider (e.g. Meta Model API / Muse Spark) means adding
 * one class implementing this interface and one branch in
 * `getLlmProvider()` — no call-site changes.
 *
 * TERMS GUARDRAIL (TMDB API Terms of Use §1.C): TMDB content must not be
 * used "in connection with" an ML/AI-based application. Prompts built for
 * this layer therefore contain ONLY user-authored text (taste notes,
 * feedback reasons, ad-hoc queries) and show titles/IDs — NEVER TMDB
 * overviews, posters, or other TMDB content. Keep it that way: if a future
 * feature needs the LLM to see show descriptions, that needs a product /
 * terms decision first, not a quiet prompt change.
 */

export interface LlmRequest {
  system: string;
  user: string;
  /** Cap on generated tokens; provider default when omitted. */
  maxTokens?: number;
}

export interface LlmProvider {
  readonly name: string;
  generate(req: LlmRequest): Promise<string>;
}

const LLAMA_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** Workers AI provider (Llama 3.3 70B). Used when the AI binding exists. */
export class WorkersAiLlamaProvider implements LlmProvider {
  readonly name = 'workers-ai:llama-3.3-70b';
  constructor(private readonly ai: NonNullable<Env['AI']>) {}

  async generate(req: LlmRequest): Promise<string> {
    const out = (await this.ai.run(LLAMA_MODEL, {
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      max_tokens: req.maxTokens ?? 512,
    })) as unknown;
    // Workers AI chat responses carry the text in `response`.
    if (out && typeof out === 'object' && 'response' in out) {
      const text = (out as { response?: unknown }).response;
      if (typeof text === 'string') return text;
    }
    if (typeof out === 'string') return out;
    throw new Error(`unexpected Workers AI response shape: ${JSON.stringify(out).slice(0, 200)}`);
  }
}

/** Fallback when no AI binding is present: clearly-marked canned output. */
export class StubLlmProvider implements LlmProvider {
  readonly name = 'stub';
  async generate(_req: LlmRequest): Promise<string> {
    return '[STUB — no LLM binding configured] Taste summary consolidation needs Workers AI.';
  }
}

// Future provider sketch (do NOT implement until decided):
// export class MetaModelApiProvider implements LlmProvider {
//   readonly name = 'meta-model-api:muse-spark';
//   constructor(private readonly apiKey: string) {}
//   ... POST https://api.meta.ai/v1/chat/completions, OpenAI-compatible ...
// }

export function getLlmProvider(env: Env): LlmProvider {
  if (env.AI) return new WorkersAiLlamaProvider(env.AI);
  return new StubLlmProvider();
}

/**
 * Build the taste-consolidation prompt from the RAW feedback log only.
 * Input is user-authored text; no TMDB content ever enters this prompt.
 */
export function buildConsolidationPrompt(
  rawNotes: { kind: string; text: string; createdAt: number }[],
  uiLang: string,
  existingSummary: string | null,
): LlmRequest {
  const notes = rawNotes
    .map((n) => `- [${n.kind}] ${n.text}`)
    .join('\n');
  return {
    system:
      'You consolidate a household TV profile\'s taste notes into one coherent ' +
      'taste description used for ranking shows. Write ONLY in ' +
      (uiLang === 'he' ? 'Hebrew' : 'English') +
      '. Keep nuance (e.g. per-language likes/dislikes). Do not invent shows or preferences not in the notes.',
    user:
      (existingSummary ? `Current summary:\n${existingSummary}\n\n` : '') +
      `Raw notes (user-authored, newest last):\n${notes}\n\nWrite the updated consolidated taste description.`,
    maxTokens: 600,
  };
}
