import type { Env } from './env';

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

const EMBED_MODEL = '@cf/baai/bge-m3';

export async function embedTexts(
  ai: NonNullable<Env['AI']>,
  texts: string[],
): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  try {
    const out = (await ai.run(EMBED_MODEL, { text: texts })) as unknown;
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
