import type { Env } from './env';
import { resolveLlmMode } from './llm';
import { mockEmbedTexts } from './mockLlm';

/**
 * Text embeddings via Workers AI (BGE-M3 — multilingual, handles Hebrew
 * and English in one model).
 *
 * TERMS GUARDRAIL (same as llm.ts): only user-authored text (taste
 * summary, ad-hoc query) and show titles + genre names are ever
 * embedded. NEVER embed TMDB overviews or any other TMDB descriptive
 * content. Genre names and titles are factual labels, not descriptions;
 * overviews are the line that must not be crossed.
 *
 * Embeddings are a retrieval signal, not a requirement: every caller
 * must degrade gracefully when this returns null (no AI binding, model
 * error, or unexpected response shape).
 */

/** Production embedding model. Never change the default without a product decision. */
export const DEFAULT_EMBED_MODEL = '@cf/baai/bge-m3';

export function resolveEmbedModel(env: Env): string {
  return env.EMBEDDING_MODEL ?? DEFAULT_EMBED_MODEL;
}

export async function embedTexts(
  ai: NonNullable<Env['AI']>,
  texts: string[],
  model: string = DEFAULT_EMBED_MODEL,
): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  try {
    const out = (await ai.run(model, { text: texts })) as unknown;
    if (out && typeof out === 'object' && 'data' in out) {
      const data = (out as { data?: unknown }).data;
      if (Array.isArray(data) && data.every((row) => Array.isArray(row))) {
        return data as number[][];
      }
      // Alternate shape: [{embedding: [...]}, ...].
      if (
        Array.isArray(data) &&
        data.every((row) => row && typeof row === 'object' && Array.isArray((row as { embedding?: unknown }).embedding))
      ) {
        return (data as { embedding: number[] }[]).map((row) => row.embedding);
      }
    }
    // Some shapes return the array directly.
    if (Array.isArray(out) && out.every((row) => Array.isArray(row))) {
      return out as number[][];
    }
    console.error('unexpected embeddings response shape');
    return null;
  } catch (err) {
    console.error('embeddings call failed', err);
    return null;
  }
}

/**
 * Env-aware embedding entry — the call sites' one path. In mock mode
 * (LLM_PROVIDER=mock or the dev-only override) returns deterministic
 * mock vectors with ZERO Workers AI calls; otherwise the real model
 * (EMBEDDING_MODEL override, else BGE-M3); null when no AI binding.
 * Embeddings stay BGE-M3 in cheap mode — only the chat model gets
 * cheaper, per the dev-view decision.
 */
export async function embedTextsWithEnv(
  env: Env,
  texts: string[],
  devOverrideHeader?: string | null,
): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  const mode = resolveLlmMode(env, devOverrideHeader);
  if (mode.kind === 'mock') return mockEmbedTexts(texts);
  if (mode.kind !== 'real' || !env.AI) return null;
  return embedTexts(env.AI, texts, resolveEmbedModel(env));
}

/**
 * The embeddable text for a candidate show: title + genre names + origin
 * labels only. No overview, ever.
 */
export function candidateEmbedText(
  title: string,
  genreNames: string[],
  originalLanguage: string,
  originCountry: string[],
): string {
  return [title, ...genreNames, originalLanguage, ...originCountry].filter(Boolean).join(' ');
}
