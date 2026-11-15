import type { Env } from './env';
import { MockLlmProvider } from './mockLlm';
import { formatSectionsForPrompt, type TasteSections } from './util';

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
 *
 * PROVIDER SELECTION (resolveLlmMode — the ONE place): the default is
 * always the real Workers AI provider. The deterministic mock
 * (mockLlm.ts) engages only via the explicit LLM_PROVIDER=mock env
 * flag (dev Worker bindings, local runs). There is deliberately NO
 * per-request override path: no header, parameter, or UI switch can
 * change the provider at runtime, so production can never be switched
 * to the mock or a cheaper model by a request. See
 * docs/dev-verification.md.
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

/** Production chat model. Never change the default without a product decision. */
export const DEFAULT_CHAT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** True only on the dev Worker. Drives the DEV banner (via /api/health); it gates nothing else. */
export function isDevWorker(env: Env): boolean {
  return env.IS_DEV_WORKER === 'true';
}

export type LlmMode =
  | { kind: 'mock' }
  | { kind: 'real'; model: string }
  | { kind: 'stub' };

/**
 * THE provider decision — every call site goes through here (via
 * getLlmProvider / embedTextsWithEnv). Precedence:
 *   1. LLM_PROVIDER=mock env flag (dev Worker bindings, local runs).
 *   2. Real provider with LLM_MODEL override, else the 70B default.
 *   3. No AI binding: the stub (which callers must never persist).
 *
 * There is no per-request override: the decision is a pure function
 * of env, so no header or client input can change it. Unit-tested in
 * scripts/selftest.mjs.
 */
export function resolveLlmMode(env: Env): LlmMode {
  if (env.LLM_PROVIDER === 'mock') return { kind: 'mock' };
  if (env.AI) return { kind: 'real', model: env.LLM_MODEL ?? DEFAULT_CHAT_MODEL };
  return { kind: 'stub' };
}

/** Workers AI provider. Used when the AI binding exists. */
export class WorkersAiLlamaProvider implements LlmProvider {
  readonly name: string;
  constructor(
    private readonly ai: NonNullable<Env['AI']>,
    private readonly model: string = DEFAULT_CHAT_MODEL,
  ) {
    // The default keeps the long-standing provider name; an override
    // names the model actually in use so health/provider reporting
    // stays honest.
    this.name = model === DEFAULT_CHAT_MODEL ? 'workers-ai:llama-3.3-70b' : `workers-ai:${model}`;
  }

  async generate(req: LlmRequest): Promise<string> {
    const out = (await this.ai.run(this.model, {
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
  const mode = resolveLlmMode(env);
  if (mode.kind === 'mock') return new MockLlmProvider();
  if (mode.kind === 'real') return new WorkersAiLlamaProvider(env.AI!, mode.model);
  return new StubLlmProvider();
}

/** One raw-log entry for consolidation. `source` decides routing: rating-derived statements always land in Shared; only free-text notes are routed by meaning. */
export interface ConsolidationNote {
  kind: string;
  source: 'rating' | 'note';
  text: string;
  createdAt: number;
}

/**
 * Build the taste-consolidation prompt from the RAW feedback log only.
 * Input is user-authored text; no TMDB content ever enters this prompt.
 *
 * The model returns a JSON object: the consolidated summary in THREE
 * sections (Shared / Casual / Deep focus), any same-section
 * contradictions it spotted, and a language conflict when the notes
 * praise a language outside the profile's hard filter. The caller falls
 * back to plain-text handling when the output is not JSON (see
 * util.parseConsolidationResponse).
 *
 * Routing rules (the default-to-Shared rule is load-bearing: on any
 * ambiguity the statement stays Shared, which is exactly the old
 * single-summary behavior, so a routing miss costs nothing).
 *
 * Free-text notes carry NO like/dislike label in this prompt: the model
 * infers sentiment from the wording alone (the Preferences screen no
 * longer asks the user to pick one). Ratings keep their kind label
 * ([rating:liked]/[rating:disliked]/[rating:dropped]) — that is
 * per-show feedback, a separate feature.
 */
export function buildConsolidationPrompt(
  rawNotes: ConsolidationNote[],
  uiLang: string,
  existing: TasteSections | null,
  allowedLanguages: string[] = [],
): LlmRequest {
  // Notes render without a sentiment label — sentiment is inferred
  // from the wording (see the SENTIMENT rule below). Ratings keep
  // their kind: [rating:liked] / [rating:disliked] / [rating:dropped].
  const notes = rawNotes
    .map((n) => `- [${n.source === 'note' ? 'note' : `rating:${n.kind}`}] ${n.text}`)
    .join('\n');
  const existingText = existing ? formatSectionsForPrompt(existing) : '';
  return {
    system:
      'You consolidate a household TV profile\'s taste notes into a taste description in THREE sections: ' +
      'Shared (applies to both lists), Casual (casual watching only), Deep focus (deep-focus watching only). ' +
      'Write ONLY in ' +
      (uiLang === 'he' ? 'Hebrew' : 'English') +
      '. Keep nuance (e.g. per-language likes/dislikes). Do not invent shows or preferences not in the notes. ' +
      'ROUTING RULES — every statement goes to exactly one section: ' +
      '1) Entries marked [rating:*] come from show ratings (liked/disliked/dropped). Their statements ALWAYS go to Shared, never to Casual or Deep focus. ' +
      '2) Free-text notes ([note]) are routed by meaning. Explicit mode wording routes directly: "for casual", "light evenings", "when tired", "background watching" go to Casual; "for deep focus", "when I can concentrate", "immersive", "full attention" go to Deep focus — Hebrew equivalents too: "קליל", "ערב קליל", "כשעייפים", "ברקע" go to Casual; "מעמיק", "מיקוד עמוק", "כשאפשר להתרכז", "דורש ריכוז", "סוחף" go to Deep focus. ' +
      '3) Implicit cues: lightness, ease, background-friendliness, short-and-simple, easy to dip into go to Casual; depth, complexity, serialization, demands attention, slow burn go to Deep focus. ' +
      '4) Genre, topic, language, and content likes/dislikes ("love Israeli drama", "no horror") go to Shared. ' +
      '5) WHEN IN DOUBT, Shared. Anything ambiguous defaults to Shared — never guess a mode. ' +
      'SENTIMENT — free-text notes carry no like/dislike label: infer from the wording whether each note expresses a liking, a dislike, or a neutral constraint. ' +
      'Dislike wording includes "no", "never", "avoid", "can\'t stand", "not for me", "hate" and Hebrew equivalents ("לא", "לעולם לא", "לא סובל/ת", "שונא/ת", "אין", "בלי"). ' +
      'Liking wording includes "love", "like", "more of", "only", "great" and Hebrew equivalents ("אוהב/ת", "מאוד", "רק", "נהדר"). ' +
      'A dislike must be preserved as an avoidance in the summary — never flip it into a liking, and never drop it. ' +
      'Preserve the existing summary\'s sectioning: keep statements in their current sections unless a note moves them. ' +
      'CONTRADICTIONS are scoped: list one ONLY when a newer note genuinely conflicts with the current summary or an older note WITHIN THE SAME SECTION. ' +
      'A Casual statement and a Deep-focus statement that look opposed (e.g. "nothing slow" for casual vs "love a slow burn" for deep focus) are NOT a contradiction — they coexist in different sections, never flag them. ' +
      'Each contradiction carries its scope, and the proposed merge must honor both sides within that scope. ' +
      'Return ONLY a JSON object with this shape, no other text: ' +
      '{"summary": {"shared": "...", "casual": "...", "deep": "..."}, "contradictions": [{"scope": "shared", "oldText": "...", "newText": "...", "proposedMerge": "..."}], ' +
      '"languageConflict": {"languageCode": "ko", "languageName": "Korean"} or null}. ' +
      'Empty sections are empty strings. ' +
      'Set languageConflict only when the notes praise a language ' +
      `NOT in this allowed list: [${allowedLanguages.join(', ')}]. ` +
      'Language codes: he=Hebrew, en=English, es=Spanish, ko=Korean, fr=French, de=German.',
    user:
      (existingText ? `Current summary:\n${existingText}\n\n` : 'No current summary.\n\n') +
      `Raw notes (user-authored, newest last):\n${notes}\n\nWrite the updated consolidated taste description as the JSON object.`,
    maxTokens: 1000,
  };
}

export interface RankCandidateInput {
  tmdbId: number;
  title: string;
  year: string;
  genres: string[];
  originalLanguage: string;
  originCountry: string[];
  /**
   * The liked show that actually drove this candidate's retrieval (TMDB
   * recommendation source, else best genre overlap). A show title — a
   * factual label, inside the terms guardrail. Rationales must cite it.
   */
  anchorTitle?: string;
}

/**
 * Build the list re-rank prompt. The model sees the taste summary
 * (user-authored) and factual labels per candidate — title, year,
 * genres, language, country, anchor show. NO overviews, NO
 * descriptions. It ranks ONLY the listed ids and returns JSON; the
 * caller validates every id against the offered set.
 *
 * Grounding discipline (2026-11-15 engine batch): each rationale MUST
 * name the candidate's anchor show and cite only the listed attributes.
 * The model must never invent shared cast, creators, themes, or plot
 * details — anything not in the candidate line does not exist for this
 * ranking. The caller replaces ungrounded rationales with a template
 * built from real data (see rerank.groundRationale).
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
        `- id ${cand.tmdbId}: "${cand.title}" (${cand.year}) [${cand.genres.join(', ') || 'no genre'}] lang=${cand.originalLanguage} country=${cand.originCountry.join('/') || '?'}` +
        (cand.anchorTitle ? ` anchor="${cand.anchorTitle}"` : ''),
    )
    .join('\n');
  return {
    system:
      'You rank TV shows for a household profile. Rank ONLY the shows listed below, by TMDB id. ' +
      'Output ONLY ids from the candidate list — never output an id, title, or attribute that is not listed. ' +
      'Base every judgment ONLY on the taste description and the listed attributes (title, year, genres, language, country, anchor show). ' +
      'Balance variety across genres, eras, and countries of origin while staying relevant to the taste text: ' +
      'do not fill the list with near-identical shows (for example all animation, or all sci-fi) when relevant alternatives are listed. ' +
      'GROUNDING: every rationale MUST name the candidate\'s anchor show (the anchor="..." value) and cite only the listed genres/year/language. ' +
      'Do NOT invent plot details, cast, creators, shared themes, or qualities not in the list — if the anchor is missing, cite the listed genres and year instead. ' +
      'Write rationales ONLY in ' +
      (uiLang === 'he' ? 'Hebrew' : 'English') +
      '. Return ONLY a JSON object, no other text: ' +
      '{"ranked": [{"tmdbId": 123, "rationale": "one sentence naming the anchor show and the listed genres that match the taste text", "risk": "one genuine fit risk grounded in the listed attributes, or null"}], ' +
      '"shortReason": "only when fewer than 10 shows genuinely fit, one sentence why, else null"}. ' +
      'Rank at most 10 shows. Prefer shows that fit the taste text; a show that clashes with a stated dislike must rank last or be omitted.',
    user:
      `Taste description:\n${tasteText}\n\nList kind: ${kindLine}\n\nCandidates:\n${lines}\n\nReturn the ranking JSON.`,
    maxTokens: 1200,
  };
}

export interface RemovalCheckNegative {
  title: string;
  year: string;
  genres: string[];
}

/**
 * Build the removal-only negative check prompt (layered negative
 * feedback, final layer — Meta "Your Algorithm" pattern). The model
 * sees ONLY titles/years/genres: the shows the user disliked, dropped,
 * or removed, and the shortlisted candidates. NO overviews, NO
 * descriptions. It returns ONLY the ids to remove; the caller validates
 * every id against the checked set and can only remove — never add,
 * reorder, or suggest. When in doubt the model keeps the show, so a
 * cautious model costs nothing and an aggressive one is bounded by the
 * checked set. The prompt never asks the model to explain taste — only
 * resemblance to concrete negative examples.
 */
export function buildRemovalCheckPrompt(
  negatives: RemovalCheckNegative[],
  candidates: RankCandidateInput[],
  uiLang: string,
): LlmRequest {
  const negLines = negatives
    .map((n) => `- "${n.title}" (${n.year}) [${n.genres.join(', ') || 'no genre'}]`)
    .join('\n');
  const candLines = candidates
    .map(
      (cand) =>
        `- id ${cand.tmdbId}: "${cand.title}" (${cand.year}) [${cand.genres.join(', ') || 'no genre'}] lang=${cand.originalLanguage}`,
    )
    .join('\n');
  return {
    system:
      'You check a TV shortlist against shows a user disliked, dropped, or removed. ' +
      'Return ONLY the ids of shortlisted shows that CLOSELY resemble a negative example in genre, type, and era — near-duplicates, same franchise entries, or shows of the same narrow kind. ' +
      'A shared broad genre alone is NOT enough to remove. When in doubt, KEEP the show. ' +
      'You may only remove shows from the shortlist: never add, reorder, or suggest shows, and never output an id that is not listed. ' +
      'Base every judgment ONLY on the listed titles, years, and genres. ' +
      'Return ONLY a JSON object, no other text: {"removeIds": [123, 456]}. ' +
      'An empty list is a valid answer when nothing closely resembles a negative example.',
    user:
      `Shows the user disliked, dropped, or removed:\n${negLines}\n\nShortlist to check:\n${candLines}\n\nReturn the removal JSON.`,
    maxTokens: 300,
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
