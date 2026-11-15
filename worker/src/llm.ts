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
 * feedback reasons, ad-hoc queries) and show titles/IDs plus factual
 * labels (genre names, year, original language, country, episode
 * runtime, season counts) — NEVER TMDB overviews, taglines, or other
 * descriptive content. The line is descriptions, not facts: the model
 * may know a show is a 2021 Hebrew crime drama with 3 seasons, it may
 * never see what the show is about. Keep it that way: if a future
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
    // Shape 1 (observed 2026-11-15): OpenAI-style chat completion.
    if (out && typeof out === 'object' && 'choices' in out) {
      const choices = (out as { choices?: unknown }).choices;
      if (Array.isArray(choices) && choices.length > 0) {
        const first = choices[0] as { message?: { content?: unknown }; text?: unknown };
        const content = first.message?.content ?? first.text;
        if (typeof content === 'string') return content;
      }
    }
    // Shape 2: Workers AI chat responses carry the text in `response`.
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
 *
 * The model returns a JSON object: the consolidated summary, any
 * contradictions it spotted between new notes and the existing summary,
 * and a language conflict when the notes praise a language outside the
 * profile's hard filter. The caller falls back to plain-text handling
 * when the output is not JSON (see util.parseConsolidationResponse).
 */
export function buildConsolidationPrompt(
  rawNotes: { kind: string; text: string; createdAt: number }[],
  uiLang: string,
  existingSummary: string | null,
  allowedLanguages: string[] = [],
): LlmRequest {
  const notes = rawNotes.map((n) => `- [${n.kind}] ${n.text}`).join('\n');
  return {
    system:
      'You consolidate a household TV profile\'s taste notes into one coherent ' +
      'taste description used for ranking shows. Write ONLY in ' +
      (uiLang === 'he' ? 'Hebrew' : 'English') +
      '. Keep nuance (e.g. per-language likes/dislikes). Do not invent shows or preferences not in the notes. ' +
      'Return ONLY a JSON object with this shape, no other text: ' +
      '{"summary": "...", "contradictions": [{"oldText": "...", "newText": "...", "proposedMerge": "..."}], ' +
      '"languageConflict": {"languageCode": "ko", "languageName": "Korean"} or null}. ' +
      'List a contradiction only when a newer note genuinely conflicts with the current summary or an older note; ' +
      'the proposed merge must honor both sides. Set languageConflict only when the notes praise a language ' +
      `NOT in this allowed list: [${allowedLanguages.join(', ')}]. ` +
      'Language codes: he=Hebrew, en=English, es=Spanish, ko=Korean, fr=French, de=German.',
    user:
      (existingSummary ? `Current summary:\n${existingSummary}\n\n` : '') +
      `Raw notes (user-authored, newest last):\n${notes}\n\nWrite the updated consolidated taste description as the JSON object.`,
    maxTokens: 800,
  };
}

export interface RankCandidateInput {
  tmdbId: number;
  title: string;
  year: string;
  genres: string[];
  originalLanguage: string;
  originCountry: string[];
}

/**
 * Build the list re-rank prompt. The model sees the taste summary
 * (user-authored) and factual labels per candidate — title, year,
 * genres, language, country. NO overviews, NO descriptions. It ranks
 * ONLY the listed ids and returns JSON; the caller validates every id
 * against the offered set.
 */
export function buildRankPrompt(
  tasteText: string,
  kind: 'casual' | 'deep',
  candidates: RankCandidateInput[],
  uiLang: string,
): LlmRequest {
  const kindLine =
    kind === 'casual'
      ? 'Casual: easy, low-commitment watching — light episodes you can dip into after a long day.'
      : 'Deep focus: immersive, serialized watching that rewards full attention.';
  const lines = candidates
    .map(
      (cand) =>
        `- id ${cand.tmdbId}: "${cand.title}" (${cand.year}) [${cand.genres.join(', ') || 'no genre'}] lang=${cand.originalLanguage} country=${cand.originCountry.join('/') || '?'}`,
    )
    .join('\n');
  return {
    system:
      'You rank TV shows for a household profile. Rank ONLY the shows listed below, by TMDB id. ' +
      'Base every judgment ONLY on the taste description and the listed attributes (title, year, genres, language, country). ' +
      'Do NOT invent plot details, cast, or qualities not in the list. Write rationales ONLY in ' +
      (uiLang === 'he' ? 'Hebrew' : 'English') +
      '. Return ONLY a JSON object, no other text: ' +
      '{"ranked": [{"tmdbId": 123, "rationale": "one sentence, grounded in the taste text and the listed genres", "risk": "one genuine fit risk grounded in the listed attributes, or null"}], ' +
      '"shortReason": "only when fewer than 10 shows genuinely fit, one sentence why, else null"}. ' +
      'Rank at most 10 shows. Prefer shows that fit the taste text; a show that clashes with a stated dislike must rank last or be omitted.',
    user:
      `Taste description:\n${tasteText}\n\nList kind: ${kindLine}\n\nCandidates:\n${lines}\n\nReturn the ranking JSON.`,
    maxTokens: 1200,
  };
}

/** One-sentence rationale for an ad-hoc pick: query + factual labels only. */
export function buildAdhocRationalePrompt(
  query: string,
  pick: RankCandidateInput,
  uiLang: string,
): LlmRequest {
  return {
    system:
      'You write a one-sentence rationale for a TV recommendation. Use ONLY the ' +
      'user request and the show title, year, and genres given. Write in ' +
      (uiLang === 'he' ? 'Hebrew' : 'English') +
      '. Do not invent plot details.',
    user:
      `Request: "${query}"\n` +
      `Show: ${pick.title} (${pick.year}) [${pick.genres.join(', ') || 'no genre'}]`,
    maxTokens: 200,
  };
}
