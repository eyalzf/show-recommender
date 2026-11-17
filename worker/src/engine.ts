import type { Context } from 'hono';
import type { Env } from './env';
import type { ProfileContext } from './db';
import {
  TmdbApiError,
  TmdbNotConfiguredError,
  discoverShows,
  getGenreMap,
  getShowDetailCached,
  getShowRecommendations,
  getTrending,
  isBlockedId,
  resolveDetail,
  searchShows,
  type TmdbSearchResult,
} from './tmdb';
import {
  buildAdhocRationalePrompt,
  buildRankPrompt,
  buildRemovalCheckPrompt,
  getRankLlmProvider,
} from './llm';
import { candidateEmbedText, embedTextsWithEnv } from './embeddings';
import {
  bestKindScopedAnchor,
  buildShortTermTasteText,
  calibrationTargetFromLiked,
  deterministicRerank,
  fitFromRank,
  freshnessFor,
  groundRationale,
  LONG_TERM_BLEND_WEIGHT,
  maxNegativeSimilarity,
  mergeRankPasses,
  NEGATIVE_DEMOTION_COSINE,
  NEGATIVE_DEMOTION_PENALTY,
  NEGATIVE_EXCLUSION_COSINE,
  noveltyFor,
  SHORT_TERM_BLEND_WEIGHT,
  type RerankCandidate,
} from './rerank';
import {
  classifyKind,
  classifyType,
  clusterFor,
  combineTasteSections,
  cosine,
  EMPTY_DETAIL_FACTS,
  ensureLanguageMinimums,
  genreDiscoverPlans,
  languagePoolMinimum,
  normalizeTitle,
  paceFor,
  parseRankResponse,
  parseRemovalCheckResponse,
  passesHardRules,
  primaryDiscoverPlans,
  selectCapped,
  softRuleScore,
  structureFor,
  tasteTextForKind,
  toneFor,
  type RankedEntry,
  type ShowDetailFacts,
  type ShowFacts,
} from './util';

/**
 * Recommendation engine v1: retrieval, then LLM re-rank, then a
 * deterministic post-pass.
 *
 * Retrieval narrows the catalog to a few dozen candidates:
 *   1. hard filters first — profile languages, rated/dropped/deny-listed
 *      shows excluded, override-excluded duplicates excluded, and the
 *      profile's derived HARD preference rules (retrieval dimensions)
 *      applied; detail-dimension hard rules filter the rank pool
 *      after a cached detail enrichment (see generateLists);
 *   2. candidate sources — TMDB discover ONCE PER PROFILE LANGUAGE
 *      (popularity within that language; a combined-language discover
 *      buried non-English shows entirely — see util.ts), trending,
 *      TMDB recommendations anchored on liked shows, per-language
 *      genre discover from liked shows' genres, and resolved external
 *      recs; each language keeps a minimum share of the rank pool
 *      (see languagePoolMinimum), so score-order trimming cannot drop
 *      a whole language before ranking;
 *   3. retrieval scoring — embedding similarity of the taste summary
 *      against title+genre text (NEVER overviews), popularity, votes,
 *      similar-show and external-rec boosts, genre overlap with likes.
 *      The taste embedding blends the long-term summary with a
 *      recency-weighted short-term component (90-day half-life; the
 *      long-term summary is never decayed away — see rerank.ts).
 *
 * Ranking splits candidates into casual / deep-focus by a genre-ID
 * heuristic (IDs, never localized genre names — see util.ts), then the
 * LLM re-ranks up to 30 per kind into the Top 10 with a rationale each.
 * Two listwise passes run per kind (input order + reversed order) and
 * merge by mean rank, mitigating position bias; every id is validated
 * against the offered set, so the model can never invent a show. A
 * bucket the heuristic starves (fewer than 10 primaries) is backfilled
 * from the other bucket's pool so the re-rank — not the heuristic —
 * decides fit; backfilled candidates surface only if the LLM ranks
 * them. Each kind's re-rank prompt gets the Shared taste section plus
 * its own section, plus a labeled "recent signals" section; retrieval
 * embedding uses all sections joined. Prompts contain user text +
 * factual labels only (see llm.ts terms guardrail). The ranked pool
 * stays larger than 10 so removals promote; fewer than 10 are shown
 * with a reason, never padded.
 *
 * A deterministic post-pass then re-orders each kind's ranked list
 * (see rerank.deterministicRerank): MMR over embedding similarity,
 * Steck calibration toward the liked-show cluster mix, and the
 * MOSTRA epsilon rule for the fit/novelty/freshness blend — with the
 * strict diversity caps binding inside the same pass. The caps keep a
 * Top 10 from collapsing into one type of show: at most 3 shows per
 * genre-ID cluster per list (see clusterFor in util.ts), plus a looser
 * per-cluster cap on the rank pool so one cluster cannot crowd out the
 * rest before ranking. The Top 10 cap is STRICT: over-cap shows never
 * surface, even when that leaves a list short — the short-list reason
 * explains it, and no junk is ever added to fill slots. Only the pool
 * cap relaxes (a small pool keeps all its candidates for ranking; the
 * final cap still binds).
 *
 * Layered negative feedback (Meta pattern) runs at three stages:
 * retrieval excludes near-duplicates of denied/disliked shows by
 * embedding distance (exact-id exclusion always applies, with or
 * without embeddings); re-ranking demotes strong resemblances to
 * disliked/dropped shows; a final LLM removal-only check can only
 * remove shortlisted shows that closely resemble a negative example.
 * The deny-list feeds ONLY these exclusion layers — never taste
 * consolidation or trust. Not-watched / not-rated is never negative.
 *
 * Rationales are grounded: each cites the anchor show that actually
 * drove retrieval plus real genres/year; ungrounded LLM text falls back
 * to a template built from real data (see rerank.groundRationale).
 *
 * Subrequest budget: at most ~47 TMDB calls per generation on a cold
 * metadata cache for a two-language profile (free-plan Workers allow
 * 50 per invocation) — per-language discover adds 3 calls over the old
 * combined calls (4 primary + 2 genre instead of 2 + 1); profiles
 * with more languages fetch one primary page per language, bounding
 * discover at 12 calls for six languages. The liked/negative detail
 * fetches for calibration, anchors, and negative layers are capped
 * (see MAX_LIKED_META / MAX_NEGATIVE_META) and go through the 180-day
 * cache, so repeat generations cost less.
 */

export interface ListItemOut {
  rank: number;
  tmdbId: number;
  title: string;
  /** Original-language title: the small English subtitle on rail cards. */
  originalTitle: string;
  /** TMDB community rating (0–10): the ★ on rail cards. */
  voteAverage: number;
  type: string;
  genres: string[];
  tone: string;
  pace: string;
  structure: string;
  episodeMinutes: number;
  seasons: number;
  /** Total episodes, excluding season 0 (specials). */
  episodes: number;
  /** First air year, or null when unknown. */
  firstYear: number | null;
  /** Last air year, or null when unknown; ignored for ongoing shows (open-ended). */
  lastYear: number | null;
  totalHours: number;
  language: string;
  country: string;
  status: string;
  rationale: string;
  risk: string | null;
  posterPath: string | null;
}

export interface GeneratedList {
  pool: { tmdbId: number; score: number }[];
  snapshot: ListItemOut[];
  shortReason: string | null;
  updatedAt: number;
}

export interface GeneratedLists {
  casual: GeneratedList;
  deep: GeneratedList;
}

interface Candidate {
  tmdbId: number;
  title: string;
  originalTitle: string;
  originalLanguage: string;
  originCountry: string[];
  genreIds: number[];
  genreNames: string[];
  popularity: number;
  voteAverage: number;
  voteCount: number;
  firstAirDate: string;
  posterPath: string | null;
  fromSimilar: boolean;
  fromRec: boolean;
  retrievalScore: number;
  /** Liked shows whose TMDB recommendations sourced this candidate. */
  anchorIds: number[];
  /** Best anchor: a sourcing liked show, else max genre overlap. */
  anchorTmdbId: number | null;
  anchorTitle: string | null;
  /** BGE-M3 vector of title+genre text (for MMR / novelty / negatives). */
  embedding?: number[];
  /** Retrieval layer (a): near-duplicate of a denied/disliked show. */
  nearNegative: boolean;
  /** Re-rank layer (b): fit penalty for resembling a disliked show. */
  negativeDemotion: number;
  /** Novelty objective: distance from already-liked shows (0..1). */
  novelty: number;
  /** Freshness objective from first-air year (0..1). */
  freshness: number;
  /** Detail facts (status/seasons/episode minutes), attached by the
   * pool enrichment when a detail-dimension rule exists; absent
   * means unknown (rules fail open / score neutral). */
  detailFacts?: ShowDetailFacts;
}

/** The facts a preference rule matches against, for one candidate. */
function factsForCandidate(cand: Candidate): ShowFacts {
  const year = cand.firstAirDate ? Number(cand.firstAirDate.slice(0, 4)) : NaN;
  const detail = cand.detailFacts ?? EMPTY_DETAIL_FACTS;
  return {
    genreIds: cand.genreIds,
    year: Number.isInteger(year) ? year : null,
    originCountry: cand.originCountry,
    status: detail.status,
    seasons: detail.seasons,
    episodeMinutes: detail.episodeMinutes,
  };
}

const LANGUAGE_NAMES: Record<string, string> = {
  he: 'Hebrew',
  en: 'English',
  es: 'Spanish',
  ko: 'Korean',
  fr: 'French',
  de: 'German',
};

const MAX_LIKED_ANCHORS = 3;
const MAX_REC_RESOLUTIONS = 5;
const RANK_POOL_SIZE = 30;
const TOP_N = 10;
/** Max shows per genre-ID cluster in a Top 10 list (diversity cap). */
const TOP_CLUSTER_CAP = 3;
/** Max shows per genre-ID cluster in the rank pool (looser than the Top 10 cap). */
const POOL_CLUSTER_CAP = 12;
/** Liked-show details fetched for calibration, anchors, and novelty (cached; subrequest budget). */
const MAX_LIKED_META = 6;
/** Negative-show details fetched for the layered-negative checks (cached; subrequest budget). */
const MAX_NEGATIVE_META = 5;
/** Shortlist size for the final LLM removal-only check: Top 10 + promotion headroom. */
const REMOVAL_CHECK_SIZE = 15;

function toCandidate(r: TmdbSearchResult, genreMap: Map<number, string>): Candidate {
  return {
    tmdbId: r.id,
    title: r.name,
    originalTitle: r.original_name,
    originalLanguage: r.original_language,
    originCountry: r.origin_country ?? [],
    genreIds: r.genre_ids ?? [],
    genreNames: (r.genre_ids ?? []).map((id) => genreMap.get(id) ?? '').filter(Boolean),
    popularity: r.popularity ?? 0,
    voteAverage: r.vote_average ?? 0,
    voteCount: r.vote_count ?? 0,
    firstAirDate: r.first_air_date ?? '',
    posterPath: r.poster_path ?? null,
    fromSimilar: false,
    fromRec: false,
    retrievalScore: 0,
    anchorIds: [],
    anchorTmdbId: null,
    anchorTitle: null,
    nearNegative: false,
    negativeDemotion: 0,
    novelty: 0.5,
    freshness: 0.5,
  };
}

/**
 * Taste text the ranker reads: the living summary, sectioned per list
 * kind — casual gets Shared + Casual, deep gets Shared + Deep focus.
 * Without a kind, all sections joined (retrieval embedding text).
 * Falls back to raw notes + likes when no summary exists yet.
 */
export function tasteTextForRanking(ctx: ProfileContext, kind?: 'casual' | 'deep'): string {
  const combined = combineTasteSections(ctx.tasteSections);
  if (combined) {
    if (!kind) return combined;
    return tasteTextForKind(ctx.tasteSections, kind) || combined;
  }
  const parts: string[] = [];
  for (const n of ctx.notes) {
    if (n.text.trim()) parts.push(`[${n.rating ?? 'note'}] ${n.text.trim()}`);
  }
  const likedTitles = ctx.showFeedback
    .filter((f) => f.rating === 'liked' && f.showTitle)
    .map((f) => f.showTitle as string);
  if (likedTitles.length > 0) parts.push(`Liked shows: ${likedTitles.join(', ')}.`);
  const droppedTitles = ctx.showFeedback
    .filter((f) => f.rating === 'dropped' && f.showTitle)
    .map((f) => f.showTitle as string);
  if (droppedTitles.length > 0) parts.push(`Dropped shows: ${droppedTitles.join(', ')}.`);
  return parts.join('\n') || 'No taste notes yet — rank by broad appeal and variety.';
}

/**
 * Rank-prompt taste text: the long-term summary (sectioned per kind)
 * plus an explicitly labeled short-term "recent signals" section, so
 * the LLM can weigh what changed recently without the latest rating
 * swamping the long-term profile (the YouTube search-copying caution).
 * The recent section carries only user-authored feedback text/titles.
 */
export function tasteTextForRankingWithRecency(
  ctx: ProfileContext,
  kind: 'casual' | 'deep',
  nowMs: number,
): string {
  const longText = tasteTextForRanking(ctx, kind);
  const recent = buildShortTermTasteText(ctx.feedback, nowMs);
  if (!recent) return longText;
  return `${longText}\n\nRecent signals (newest first — what the profile rated or noted lately; weigh these alongside, not instead of, the taste description above):\n${recent}`;
}

async function retrieveCandidates(
  c: Context<{ Bindings: Env }>,
  ctx: ProfileContext,
  uiLang: string,
): Promise<Candidate[]> {
  const languages = ctx.profile.languages;
  const excluded = new Set<number>([
    ...ctx.ratedIds,
    ...ctx.denyIds,
    ...ctx.excludedIds,
  ]);
  // Derived HARD preference rules filter at ingestion, like
  // languages: excluded shows never enter the pool, so their slots
  // go to other candidates instead of shortening the lists. At this
  // stage only retrieval dimensions bind (genre/year/country) — the
  // detail facts are unknown, so detail-dimension rules pass open
  // here and bind at the pool stage instead (see generateLists).
  const rules = ctx.rules;
  const genreMap = await getGenreMap(c, uiLang).catch(() => new Map<number, string>());

  const byId = new Map<number, Candidate>();
  const errors: Error[] = [];
  const absorb = async (fn: () => Promise<TmdbSearchResult[]>, mark: (cand: Candidate) => void) => {
    try {
      for (const r of await fn()) {
        if (isBlockedId(r.id) || excluded.has(r.id)) continue;
        if (languages.length > 0 && !languages.includes(r.original_language)) continue;
        const existing = byId.get(r.id);
        if (existing) {
          mark(existing);
        } else {
          const cand = toCandidate(r, genreMap);
          if (!passesHardRules(factsForCandidate(cand), rules)) continue;
          mark(cand);
          byId.set(r.id, cand);
        }
      }
    } catch (err) {
      errors.push(err as Error);
    }
  };

  // Primary pools (parallel). Discover runs ONCE PER PROFILE
  // LANGUAGE (popularity within that language): a combined he|en
  // discover sorted by global popularity returned zero Hebrew shows
  // in 40 results, starving the pool before ranking ever ran (see
  // primaryDiscoverPlans in util.ts). Trending stays global.
  await Promise.all([
    ...primaryDiscoverPlans(languages).map((plan) =>
      absorb(() => discoverShows(c, uiLang, plan), () => {}),
    ),
    absorb(() => getTrending(c, uiLang), () => {}),
  ]);

  // Liked-show anchors: recommendations + genre discover.
  const anchors = ctx.likedIds.slice(0, MAX_LIKED_ANCHORS);
  const likedGenreIds = new Map<number, number>();
  for (const id of anchors) {
    try {
      const detail = await getShowDetailCached(c, id, uiLang);
      for (const g of detail.genres ?? []) {
        likedGenreIds.set(g.id, (likedGenreIds.get(g.id) ?? 0) + 1);
      }
    } catch (err) {
      errors.push(err as Error);
    }
  }
  const topGenreIds = [...likedGenreIds.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id]) => id);
  await Promise.all([
    ...anchors.map((id) =>
      absorb(() => getShowRecommendations(c, id, uiLang), (cand) => {
        cand.fromSimilar = true;
        // The sourcing liked show is this candidate's retrieval anchor
        // (grounded rationales cite it; see assignAnchors).
        if (!cand.anchorIds.includes(id)) cand.anchorIds.push(id);
      }),
    ),
    // Genre discover, per language like the primary calls: the old
    // combined call buried non-English shows the same way.
    ...genreDiscoverPlans(languages, topGenreIds).map((plan) =>
      absorb(() => discoverShows(c, uiLang, plan), () => {}),
    ),
  ]);

  // External recommendations: resolve titles to TMDB ids (strict title
  // match only — a wrong match would credit the wrong show).
  const recTitles = ctx.externalRecs.slice(0, MAX_REC_RESOLUTIONS);
  for (const rec of recTitles) {
    if (rec.tmdbId != null && !excluded.has(rec.tmdbId) && !isBlockedId(rec.tmdbId)) {
      try {
        const detail = await getShowDetailCached(c, rec.tmdbId, uiLang);
        if (languages.length === 0 || languages.includes(detail.original_language)) {
          const existing = byId.get(rec.tmdbId);
          if (existing) existing.fromRec = true;
          else {
            const cand = toCandidate(detail, genreMap);
            if (passesHardRules(factsForCandidate(cand), rules)) {
              cand.fromRec = true;
              byId.set(rec.tmdbId, cand);
            }
          }
        }
      } catch (err) {
        errors.push(err as Error);
      }
      continue;
    }
    try {
      const hits = await searchShows(c, rec.showTitle, uiLang);
      const wanted = normalizeTitle(rec.showTitle);
      const hit = hits.find(
        (h) => normalizeTitle(h.name) === wanted || normalizeTitle(h.original_name) === wanted,
      );
      if (hit && !excluded.has(hit.id) && !isBlockedId(hit.id)) {
        if (languages.length === 0 || languages.includes(hit.original_language)) {
          const existing = byId.get(hit.id);
          if (existing) existing.fromRec = true;
          else {
            const cand = toCandidate(hit, genreMap);
            if (passesHardRules(factsForCandidate(cand), rules)) {
              cand.fromRec = true;
              byId.set(hit.id, cand);
            }
          }
        }
      }
    } catch (err) {
      errors.push(err as Error);
    }
  }

  if (byId.size === 0) {
    const notConfigured = errors.find((e) => e instanceof TmdbNotConfiguredError);
    if (notConfigured) throw notConfigured;
    const apiErr = errors.find((e) => e instanceof TmdbApiError);
    if (apiErr) throw apiErr;
    if (errors.length > 0) throw errors[0];
  }
  return [...byId.values()];
}

/** Factual-label metadata for a rated/denied show, from cached details. */
interface ShowMeta {
  tmdbId: number;
  title: string;
  genreIds: number[];
  genreNames: string[];
  originalLanguage: string;
  originCountry: string[];
  year: string;
}

/**
 * Fetch cached details for a list of show ids (best-effort, capped by
 * the caller for the subrequest budget). A failed fetch drops the show
 * from the meta set — every consumer degrades without it.
 */
async function loadShowMeta(
  c: Context<{ Bindings: Env }>,
  ids: number[],
  uiLang: string,
): Promise<ShowMeta[]> {
  const metas: ShowMeta[] = [];
  for (const id of ids) {
    try {
      const detail = await getShowDetailCached(c, id, uiLang);
      metas.push({
        tmdbId: id,
        title: detail.name,
        genreIds: (detail.genres ?? []).map((g) => g.id),
        genreNames: (detail.genres ?? []).map((g) => g.name),
        originalLanguage: detail.original_language,
        originCountry: detail.origin_country ?? [],
        year: detail.first_air_date ? detail.first_air_date.slice(0, 4) : '',
      });
    } catch {
      // Meta is a soft signal; a failed fetch just skips the show.
    }
  }
  return metas;
}

/**
 * Assign each candidate its retrieval anchor: the sourcing liked show
 * when TMDB recommendations brought it in, else the liked show with the
 * greatest genre overlap — at least MIN_ANCHOR_GENRE_OVERLAP shared
 * genres (a single shared genre is too weak to claim similarity).
 * Overlap anchors are KIND-SCOPED: a same-kind liked show wins over a
 * cross-kind one, so a deep-focus pick cites a deep liked show when
 * one qualifies (a deep pick citing a casual comedy was the
 * classification-fix complaint); any liked show is the fallback only
 * when no same-kind show qualifies. The anchor title is what grounded
 * rationales cite; null when no liked show qualifies (the template
 * rationale then cites genres/year).
 */
function assignAnchors(candidates: Candidate[], likedMeta: ShowMeta[], ctx: ProfileContext): void {
  const titleById = new Map<number, string>();
  for (const m of likedMeta) titleById.set(m.tmdbId, m.title);
  for (const f of ctx.showFeedback) {
    if (f.rating === 'liked' && f.tmdbId != null && f.showTitle && !titleById.has(f.tmdbId)) {
      titleById.set(f.tmdbId, f.showTitle);
    }
  }
  const likedGenreSets = likedMeta.map((m) => m.genreIds);
  const likedKinds = likedMeta.map((m) => classifyKind(m.genreIds));
  for (const cand of candidates) {
    if (cand.anchorIds.length > 0) {
      cand.anchorTmdbId = cand.anchorIds[0];
      cand.anchorTitle = titleById.get(cand.anchorIds[0]) ?? null;
      continue;
    }
    const best = bestKindScopedAnchor(cand.genreIds, likedGenreSets, likedKinds, classifyKind(cand.genreIds));
    if (best >= 0) {
      cand.anchorTmdbId = likedMeta[best].tmdbId;
      cand.anchorTitle = likedMeta[best].title;
    }
  }
}

async function scoreCandidates(
  c: Context<{ Bindings: Env }>,
  candidates: Candidate[],
  tasteText: string,
  shortTermText: string,
  likedGenreIds: Set<number>,
  likedMeta: ShowMeta[],
  negativeExclusionMeta: ShowMeta[],
  negativeDemotionMeta: ShowMeta[],
): Promise<void> {
  // One embedding batch: long-term taste, short-term taste (when any),
  // every candidate, every negative anchor, every liked anchor. The
  // blended taste vector (long-term dominant, short-term additive) is
  // the retrieval query; negative/liked vectors feed the exclusion,
  // demotion, and novelty layers below.
  let sims: number[] | null = null;
  if (c.env.AI && tasteText.trim()) {
    const texts: string[] = [tasteText];
    if (shortTermText.trim()) texts.push(shortTermText);
    const shortIdx = shortTermText.trim() ? 1 : -1;
    const candStart = texts.length;
    for (const cand of candidates) {
      texts.push(candidateEmbedText(cand.title, cand.genreNames, cand.originalLanguage, cand.originCountry));
    }
    const exclStart = texts.length;
    for (const m of negativeExclusionMeta) {
      texts.push(candidateEmbedText(m.title, m.genreNames, m.originalLanguage, m.originCountry));
    }
    const demStart = texts.length;
    for (const m of negativeDemotionMeta) {
      texts.push(candidateEmbedText(m.title, m.genreNames, m.originalLanguage, m.originCountry));
    }
    const likedStart = texts.length;
    for (const m of likedMeta) {
      texts.push(candidateEmbedText(m.title, m.genreNames, m.originalLanguage, m.originCountry));
    }
    const vectors = await embedTextsWithEnv(c.env, texts);
    if (vectors && vectors.length === texts.length) {
      // Blend: long-term at full weight, short-term additive — the
      // long-term profile is never decayed away (see rerank.ts).
      let taste = vectors[0];
      if (shortIdx >= 0) {
        const short = vectors[shortIdx];
        taste = taste.map(
          (v, i) => LONG_TERM_BLEND_WEIGHT * v + SHORT_TERM_BLEND_WEIGHT * (short[i] ?? 0),
        );
      }
      const exclVecs = vectors.slice(exclStart, demStart);
      const demVecs = vectors.slice(demStart, likedStart);
      const likedVecs = vectors.slice(likedStart);
      const likedGenreSets = likedMeta.map((m) => m.genreIds);
      sims = [];
      candidates.forEach((cand, i) => {
        const vec = vectors[candStart + i];
        cand.embedding = vec;
        sims?.push((cosine(taste, vec) + 1) / 2);
        // Layer (a): near-duplicate of a denied/disliked show — excluded
        // at retrieval. Layer (b): strong resemblance to a disliked or
        // dropped show — demoted at re-rank. Without embeddings both
        // layers stay off and exact-id exclusion still applies.
        const exclSim = maxNegativeSimilarity(vec, exclVecs);
        if (exclSim >= NEGATIVE_EXCLUSION_COSINE) {
          cand.nearNegative = true;
        } else if (maxNegativeSimilarity(vec, demVecs) >= NEGATIVE_DEMOTION_COSINE) {
          cand.negativeDemotion = NEGATIVE_DEMOTION_PENALTY;
        }
        cand.novelty = noveltyFor(vec, cand.genreIds, likedVecs, likedGenreSets);
      });
    }
  }
  // No-embedding fallback for novelty: genre distance from liked shows.
  if (!sims) {
    const likedGenreSets = likedMeta.map((m) => m.genreIds);
    for (const cand of candidates) {
      cand.novelty = noveltyFor(undefined, cand.genreIds, [], likedGenreSets);
    }
  }

  candidates.forEach((cand, i) => {
    const pop = Math.min(1, Math.log10(cand.popularity + 1) / 3);
    const vote = (cand.voteAverage / 10) * (0.5 + 0.5 * Math.min(1, cand.voteCount / 200));
    const overlap =
      cand.genreIds.length > 0
        ? cand.genreIds.filter((id) => likedGenreIds.has(id)).length / cand.genreIds.length
        : 0;
    const boosts = (cand.fromSimilar ? 0.25 : 0) + (cand.fromRec ? 0.3 : 0);
    const emb = sims ? sims[i] : null;
    cand.retrievalScore =
      emb != null
        ? 0.45 * emb + 0.2 * pop + 0.15 * vote + 0.2 * overlap + boosts
        : 0.35 * pop + 0.25 * vote + 0.4 * overlap + boosts;
  });
}

/**
 * Re-rank one kind's candidates. `strictIds` are backfilled candidates
 * borrowed from the other bucket: they surface ONLY if the LLM ranks
 * them — the retrieval-order fill-up below never promotes them, so a
 * starved bucket is never padded with shows the re-rank rejected.
 *
 * LLM hygiene (2026-11-15 engine batch): two listwise passes run in
 * parallel — input order and reversed order — and merge by mean rank
 * (rerank.mergeRankPasses), mitigating the documented position bias of
 * listwise re-rankers while keeping listwise comparison quality. Every
 * id is validated against the offered set in both passes, so an
 * invented id can never surface; candidates the LLM drops are repaired
 * from retrieval order below. Rationales are grounded after merging:
 * each must cite its retrieval anchor or real attributes, else a
 * template built from real data replaces it.
 * Returns the LLM's own short reason when it ranked fewer than 10.
 */
async function rankKind(
  c: Context<{ Bindings: Env }>,
  kind: 'casual' | 'deep',
  candidates: Candidate[],
  strictIds: Set<number>,
  tasteText: string,
  uiLang: string,
): Promise<{ ranked: RankedEntry[]; shortReason: string | null }> {
  if (candidates.length === 0) return { ranked: [], shortReason: null };
  const provider = getRankLlmProvider(c.env);
  const fallbackRationale =
    uiLang === 'he' ? 'תואם את פרופיל הטעם.' : 'Matches your taste profile.';
  const byId = new Map(candidates.map((cand) => [cand.tmdbId, cand]));
  const validIds = new Set(candidates.map((cand) => cand.tmdbId));
  const toInput = (cand: Candidate) => ({
    tmdbId: cand.tmdbId,
    title: cand.title,
    year: cand.firstAirDate ? cand.firstAirDate.slice(0, 4) : '',
    genres: cand.genreNames,
    originalLanguage: cand.originalLanguage,
    originCountry: cand.originCountry,
    anchorTitle: cand.anchorTitle ?? undefined,
  });
  const runPass = async (ordered: Candidate[]) => {
    try {
      return parseRankResponse(
        await provider.generate(buildRankPrompt(tasteText, kind, ordered.map(toInput), uiLang)),
        validIds,
      );
    } catch (err) {
      console.error(`LLM re-rank pass failed for ${kind}`, err);
      return null;
    }
  };
  try {
    const [pass1, pass2] = await Promise.all([
      runPass(candidates),
      runPass([...candidates].reverse()),
    ]);
    const merged =
      pass1 && pass2
        ? mergeRankPasses(pass1.ranked, pass2.ranked)
        : ((pass1 ?? pass2)?.ranked ?? null);
    const shortReason = pass1?.shortReason ?? pass2?.shortReason ?? null;
    if (merged) {
      const ranked = merged.map((r) => {
        const cand = byId.get(r.tmdbId);
        return {
          ...r,
          rationale: cand
            ? groundRationale(
                r.rationale || fallbackRationale,
                cand.anchorTitle,
                cand.genreNames,
                cand.firstAirDate ? cand.firstAirDate.slice(0, 4) : '',
                uiLang,
              )
            : r.rationale || fallbackRationale,
        };
      });
      const rankedIds = new Set(ranked.map((r) => r.tmdbId));
      // Fill up to the pool size from retrieval order (never invented),
      // except backfilled candidates the LLM did not rank. Fill-up
      // entries get grounded template rationales, not the generic
      // fallback — their anchor/attributes are real data.
      for (const cand of candidates) {
        if (ranked.length >= RANK_POOL_SIZE) break;
        if (rankedIds.has(cand.tmdbId)) continue;
        if (strictIds.has(cand.tmdbId)) continue;
        ranked.push({
          tmdbId: cand.tmdbId,
          rationale: groundRationale(
            '',
            cand.anchorTitle,
            cand.genreNames,
            cand.firstAirDate ? cand.firstAirDate.slice(0, 4) : '',
            uiLang,
          ),
          risk: null,
        });
      }
      return { ranked, shortReason };
    }
  } catch (err) {
    console.error(`LLM re-rank failed for ${kind}`, err);
  }
  return {
    ranked: candidates
      .filter((cand) => !strictIds.has(cand.tmdbId))
      .map((cand) => ({
        tmdbId: cand.tmdbId,
        rationale: groundRationale(
          '',
          cand.anchorTitle,
          cand.genreNames,
          cand.firstAirDate ? cand.firstAirDate.slice(0, 4) : '',
          uiLang,
        ),
        risk: null,
      })),
    shortReason: null,
  };
}

/**
 * Final negative layer (c): an LLM removal-only check over the
 * shortlist head (Top 10 + promotion headroom, so promoted items were
 * checked too). Returns the ids to remove — validated against the
 * checked set, so the check can only remove. Fails open (no removals)
 * when there are no negatives, the call fails, or nothing parses: the
 * retrieval and demotion layers still apply.
 */
async function removalCheck(
  c: Context<{ Bindings: Env }>,
  ordered: RankedEntry[],
  byId: Map<number, Candidate>,
  negatives: ShowMeta[],
  uiLang: string,
): Promise<Set<number>> {
  if (negatives.length === 0 || ordered.length === 0) return new Set();
  const checkSet = ordered.slice(0, REMOVAL_CHECK_SIZE);
  const validIds = new Set(checkSet.map((e) => e.tmdbId));
  try {
    const provider = getRankLlmProvider(c.env);
    const text = await provider.generate(
      buildRemovalCheckPrompt(
        negatives.map((m) => ({ title: m.title, year: m.year, genres: m.genreNames })),
        checkSet.map((e) => {
          const cand = byId.get(e.tmdbId);
          return {
            tmdbId: e.tmdbId,
            title: cand?.title ?? '',
            year: cand?.firstAirDate ? cand.firstAirDate.slice(0, 4) : '',
            genres: cand?.genreNames ?? [],
            originalLanguage: cand?.originalLanguage ?? '',
            originCountry: cand?.originCountry ?? [],
          };
        }),
        uiLang,
      ),
    );
    return new Set(parseRemovalCheckResponse(text, validIds));
  } catch (err) {
    console.error('removal check failed', err);
    return new Set();
  }
}

async function enrichToListItems(
  c: Context<{ Bindings: Env }>,
  ranked: RankedEntry[],
  ctx: ProfileContext,
  uiLang: string,
): Promise<ListItemOut[]> {
  const items: ListItemOut[] = [];
  const top = ranked.slice(0, TOP_N);
  for (let i = 0; i < top.length; i++) {
    const entry = top[i];
    try {
      const detail = await getShowDetailCached(c, entry.tmdbId, uiLang);
      const override = ctx.overrides.get(entry.tmdbId) ?? null;
      const show = resolveDetail(
        detail,
        override
          ? {
              he_title: override.heTitle,
              he_overview: override.heOverview,
              origin_label: override.originLabel,
              providers_note: override.providersNote,
            }
          : null,
        uiLang,
        [],
      );
      const episodeMinutes = show.episodeRunTime?.[0] ?? 0;
      const seasons = show.numberOfSeasons ?? 0;
      const totalHours =
        show.numberOfEpisodes != null && episodeMinutes > 0
          ? Math.round((show.numberOfEpisodes * episodeMinutes) / 60)
          : 0;
      const yearOf = (date: string): number | null => {
        const year = Number(date.slice(0, 4));
        return Number.isInteger(year) && year > 0 ? year : null;
      };
      items.push({
        rank: i + 1,
        tmdbId: show.tmdbId,
        title: show.title,
        originalTitle: show.originalTitle,
        voteAverage: show.voteAverage,
        type: classifyType(show.genreIds, show.numberOfSeasons, show.numberOfEpisodes, show.status),
        genres: show.genres,
        tone: toneFor(show.genreIds),
        pace: paceFor(episodeMinutes || null),
        structure: structureFor(show.genreIds),
        episodeMinutes,
        seasons,
        episodes: show.numberOfEpisodes ?? 0,
        firstYear: yearOf(show.firstAirDate),
        lastYear: yearOf(show.lastAirDate),
        totalHours,
        language: LANGUAGE_NAMES[show.originalLanguage] ?? show.originalLanguage,
        country: show.originCountry[0] ?? '',
        status: show.status === 'Returning Series' || show.status === 'In Production' ? 'ongoing' : 'ended',
        rationale: entry.rationale,
        risk: entry.risk,
        posterPath: show.posterPath,
      });
    } catch (err) {
      console.error(`enrichment failed for ${entry.tmdbId}`, err);
      // A failed detail fetch drops the show rather than inventing data.
    }
  }
  // Re-rank after drops so ranks stay dense.
  items.forEach((item, i) => {
    item.rank = i + 1;
  });
  return items;
}

function emptyList(shortReason: string | null): GeneratedList {
  return { pool: [], snapshot: [], shortReason, updatedAt: Date.now() };
}

/**
 * Generate both lists for a profile. Requires TMDB (throws
 * TmdbNotConfiguredError / TmdbApiError) and a non-empty feedback log;
 * with no feedback at all the lists stay empty with a reason, because
 * there is nothing to rank against.
 */
export async function generateLists(
  c: Context<{ Bindings: Env }>,
  ctx: ProfileContext,
  uiLang: string,
): Promise<GeneratedLists> {
  const now = Date.now();
  if (ctx.showFeedback.length === 0) {
    const reason =
      uiLang === 'he'
        ? 'דרגו כמה סדרות קודם — הרשימות נבנות מהדירוגים וההערות שלכם.'
        : 'Rate a few shows first — the lists are built from your ratings and notes.';
    return { casual: emptyList(reason), deep: emptyList(reason) };
  }

  const candidates = await retrieveCandidates(c, ctx, uiLang);
  const tasteText = tasteTextForRanking(ctx);
  const shortTermText = buildShortTermTasteText(ctx.feedback, now);

  // Liked-show metadata (cached details, newest first): genre overlap
  // for retrieval scoring, calibration target, anchor assignment, and
  // novelty. Negative-show metadata: denied ids plus disliked/dropped
  // ratings — the exclusion layer covers both sets, the demotion layer
  // only disliked/dropped (a "No Reason" deny never demotes by theme).
  const likedMeta = await loadShowMeta(c, ctx.likedIds.slice(0, MAX_LIKED_META), uiLang);
  const negativeIds = ctx.showFeedback
    .filter((f) => f.rating !== 'liked' && f.tmdbId != null)
    .map((f) => f.tmdbId as number);
  const demotionMeta = await loadShowMeta(
    c,
    [...new Set(negativeIds)].slice(0, MAX_NEGATIVE_META),
    uiLang,
  );
  const exclusionIds = [...new Set([...ctx.denyIds, ...negativeIds])].slice(0, MAX_NEGATIVE_META);
  // Separate cached load (overlapping ids hit the D1 cache, not TMDB).
  const exclusionMeta = await loadShowMeta(c, exclusionIds, uiLang);

  const likedGenreIds = new Set<number>();
  for (const meta of likedMeta.slice(0, MAX_LIKED_ANCHORS)) {
    for (const id of meta.genreIds) likedGenreIds.add(id);
  }
  await scoreCandidates(
    c,
    candidates,
    tasteText,
    shortTermText,
    likedGenreIds,
    likedMeta,
    exclusionMeta,
    demotionMeta,
  );

  // Retrieval-layer negative exclusion (layer a): near-duplicates of
  // denied/disliked shows never reach the rank pools.
  const surviving = candidates.filter((cand) => !cand.nearNegative);
  assignAnchors(surviving, likedMeta, ctx);
  for (const cand of surviving) cand.freshness = freshnessFor(cand.firstAirDate, now);
  const calibrationTarget = calibrationTargetFromLiked(likedMeta.map((m) => m.genreIds));

  const byScore = (a: Candidate, b: Candidate) => b.retrievalScore - a.retrievalScore;
  const casualPrimary = surviving
    .filter((cand) => classifyKind(cand.genreIds) === 'casual')
    .sort(byScore);
  const deepPrimary = surviving
    .filter((cand) => classifyKind(cand.genreIds) === 'deep')
    .sort(byScore);

  // Rank-pool construction per kind: primaries in retrieval-score order,
  // backfilled from the other bucket's pool when starved (fewer
  // primaries than a Top 10 — borrowed candidates are strict: the
  // re-rank must accept them or they never surface), then the pool
  // diversity cap so one cluster cannot crowd out the rest before
  // ranking. The cap relaxes on narrow pools (see selectCapped).
  // Finally the per-language floor: each profile language keeps a
  // minimum share of the pool (see languagePoolMinimum), so
  // per-language discovery is not undone by score-order trimming
  // before ranking. Pool-only — ranking and the Top 10 caps are
  // untouched, and a single-language profile sees no change.
  const buildRankPool = (primary: Candidate[], other: Candidate[]) => {
    const ordered = [...primary];
    const strictIds = new Set<number>();
    if (primary.length < TOP_N) {
      const seen = new Set(primary.map((cand) => cand.tmdbId));
      for (const cand of other) {
        if (seen.has(cand.tmdbId)) continue;
        seen.add(cand.tmdbId);
        ordered.push(cand);
        strictIds.add(cand.tmdbId);
      }
    }
    const picked = selectCapped(ordered, (cand) => clusterFor(cand.genreIds), POOL_CLUSTER_CAP, RANK_POOL_SIZE);
    const guaranteed = ensureLanguageMinimums(
      ordered,
      picked,
      (cand) => cand.originalLanguage,
      ctx.profile.languages,
      languagePoolMinimum(RANK_POOL_SIZE, ctx.profile.languages.length),
    );
    return { picked: guaranteed, strictIds };
  };
  const casualBucket = buildRankPool(casualPrimary, deepPrimary);
  const deepBucket = buildRankPool(deepPrimary, casualPrimary);
  let casualCands = casualBucket.picked;
  let deepCands = deepBucket.picked;

  // Stage-2 rule filtering + soft-rule facts: detail dimensions
  // (status/seasons/episodeMinutes) need show detail, fetched once
  // per pool show through the 180-day cache and shared by both kind
  // pools (the Candidate objects are shared references). A failed
  // fetch leaves the facts unknown, which fails open for hard rules
  // and scores neutral for soft rules — enrichment never drops a
  // show. Skipped entirely when no rule needs detail facts, so
  // rule-less profiles pay no extra fetches.
  const DETAIL_RULE_DIMS = new Set(['status', 'seasons', 'episodeMinutes']);
  const hardDetailRules = ctx.rules.some((r) => r.mode === 'hard' && DETAIL_RULE_DIMS.has(r.dimension));
  const softDetailRules = ctx.rules.some((r) => r.mode === 'soft' && DETAIL_RULE_DIMS.has(r.dimension));
  if (hardDetailRules || softDetailRules) {
    const union = new Map<number, Candidate>();
    for (const cand of [...casualCands, ...deepCands]) union.set(cand.tmdbId, cand);
    await Promise.all(
      [...union.values()].map(async (cand) => {
        try {
          const detail = await getShowDetailCached(c, cand.tmdbId, uiLang);
          const resolved = resolveDetail(detail, null, uiLang, []);
          cand.detailFacts = {
            status: resolved.status,
            seasons: resolved.numberOfSeasons,
            episodeMinutes: resolved.episodeRunTime?.[0] ?? null,
          };
        } catch (err) {
          console.error(`detail enrichment failed for ${cand.tmdbId}`, err);
        }
      }),
    );
  }
  if (hardDetailRules) {
    casualCands = casualCands.filter((cand) => passesHardRules(factsForCandidate(cand), ctx.rules));
    deepCands = deepCands.filter((cand) => passesHardRules(factsForCandidate(cand), ctx.rules));
  }

  const [casualRank, deepRank] = await Promise.all([
    rankKind(c, 'casual', casualCands, casualBucket.strictIds, tasteTextForRankingWithRecency(ctx, 'casual', now), uiLang),
    rankKind(c, 'deep', deepCands, deepBucket.strictIds, tasteTextForRankingWithRecency(ctx, 'deep', now), uiLang),
  ]);

  // Deterministic post-LLM pass (MMR + calibration + epsilon blend +
  // strict caps, one greedy pass — see rerank.deterministicRerank).
  // Fit comes from the merged LLM rank position, minus the layer-(b)
  // negative demotion. The pass returns the full pool order; the
  // snapshot slices the Top 10 from it.
  interface GreedyEntry extends RerankCandidate {
    entry: RankedEntry;
  }
  const toGreedy = (ranked: RankedEntry[], pool: Candidate[]): GreedyEntry[] => {
    const byId = new Map(pool.map((cand) => [cand.tmdbId, cand]));
    return ranked.map((entry, i) => {
      const cand = byId.get(entry.tmdbId);
      return {
        tmdbId: entry.tmdbId,
        fit: Math.max(0, fitFromRank(i, ranked.length) - (cand?.negativeDemotion ?? 0)),
        novelty: cand?.novelty ?? 0.5,
        freshness: cand?.freshness ?? 0.5,
        rules: cand ? softRuleScore(factsForCandidate(cand), ctx.rules) : 0,
        cluster: clusterFor(cand?.genreIds ?? []),
        embedding: cand?.embedding,
        genreIds: cand?.genreIds ?? [],
        entry,
      };
    });
  };
  const casualGreedy = deterministicRerank(toGreedy(casualRank.ranked, casualCands), 'casual', calibrationTarget, TOP_CLUSTER_CAP);
  const deepGreedy = deterministicRerank(toGreedy(deepRank.ranked, deepCands), 'deep', calibrationTarget, TOP_CLUSTER_CAP);

  // Final negative layer (c): removal-only LLM check over each
  // shortlist head. Removals cannot violate the caps (removal only
  // shrinks clusters), and promotion headroom was checked too.
  const casualById = new Map(casualCands.map((cand) => [cand.tmdbId, cand]));
  const deepById = new Map(deepCands.map((cand) => [cand.tmdbId, cand]));
  const [casualRemoved, deepRemoved] = await Promise.all([
    removalCheck(c, casualGreedy.ordered.map((g) => g.entry), casualById, exclusionMeta, uiLang),
    removalCheck(c, deepGreedy.ordered.map((g) => g.entry), deepById, exclusionMeta, uiLang),
  ]);
  const casualRanked = casualGreedy.ordered
    .filter((g) => !casualRemoved.has(g.tmdbId))
    .map((g) => g.entry);
  const deepRanked = deepGreedy.ordered
    .filter((g) => !deepRemoved.has(g.tmdbId))
    .map((g) => g.entry);

  const [casualItems, deepItems] = await Promise.all([
    enrichToListItems(c, casualRanked, ctx, uiLang),
    enrichToListItems(c, deepRanked, ctx, uiLang),
  ]);

  const shortReasonFor = (
    items: ListItemOut[],
    poolSize: number,
    llmReason: string | null,
    capBound: boolean,
  ): string | null => {
    if (items.length >= TOP_N) return null;
    // The re-rank's own reason, when it ranked fewer than 10, is the
    // most specific explanation available.
    if (llmReason) return llmReason;
    if (poolSize === 0) {
      return uiLang === 'he'
        ? 'לא נמצאו סדרות מתאימות לשפות של הפרופיל.'
        : 'No shows qualified for this profile’s languages.';
    }
    // The strict variety cap held back relevant same-type shows.
    if (capBound) {
      return uiLang === 'he'
        ? 'פחות מ־10: מגבלת הגיוון מגבילה סדרות מאותו סוג.'
        : 'Fewer than 10: the variety cap limits shows of the same type.';
    }
    return uiLang === 'he'
      ? `רק ${items.length} סדרות מתאימות כרגע.`
      : `Only ${items.length} shows qualify right now.`;
  };

  return {
    casual: {
      pool: casualRanked.map((r) => ({
        tmdbId: r.tmdbId,
        score: casualCands.find((cand) => cand.tmdbId === r.tmdbId)?.retrievalScore ?? 0,
      })),
      snapshot: casualItems,
      shortReason: shortReasonFor(casualItems, casualCands.length, casualRank.shortReason, casualGreedy.capBound),
      updatedAt: now,
    },
    deep: {
      pool: deepRanked.map((r) => ({
        tmdbId: r.tmdbId,
        score: deepCands.find((cand) => cand.tmdbId === r.tmdbId)?.retrievalScore ?? 0,
      })),
      snapshot: deepItems,
      shortReason: shortReasonFor(deepItems, deepCands.length, deepRank.shortReason, deepGreedy.capBound),
      updatedAt: now,
    },
  };
}

// ---------------------------------------------------------------- ad-hoc

export interface AdhocPick {
  tmdbId: number;
  title: string;
  originalLanguage: string;
  firstAirDate: string;
  posterPath: string | null;
  genres: string[];
  rationale: string;
}

/**
 * One fresh pick for a free-text request. Independent by design: reads
 * the profile's filters/exclusions but writes nothing to taste or
 * lists. The query is embedded against candidate title+genre text and
 * the best match gets an LLM-written rationale (query + factual labels
 * only).
 */
export async function generateAdhocPick(
  c: Context<{ Bindings: Env }>,
  ctx: ProfileContext | null,
  query: string,
  uiLang: string,
): Promise<AdhocPick> {
  const languages = ctx?.profile.languages ?? [];
  const excluded = new Set<number>([
    ...(ctx?.ratedIds ?? []),
    ...(ctx?.denyIds ?? []),
    ...(ctx?.excludedIds ?? []),
  ]);
  const genreMap = await getGenreMap(c, uiLang).catch(() => new Map<number, string>());
  const rules = ctx?.rules ?? [];
  const byId = new Map<number, Candidate>();
  const absorb = (results: TmdbSearchResult[]) => {
    for (const r of results) {
      if (isBlockedId(r.id) || excluded.has(r.id)) continue;
      if (languages.length > 0 && !languages.includes(r.original_language)) continue;
      if (byId.has(r.id)) continue;
      const cand = toCandidate(r, genreMap);
      if (!passesHardRules(factsForCandidate(cand), rules)) continue;
      byId.set(r.id, cand);
    }
  };

  const [discover, trending] = await Promise.all([
    discoverShows(c, uiLang, { languages, page: 1, minVoteCount: 10 }),
    getTrending(c, uiLang),
  ]);
  absorb(discover);
  absorb(trending);

  // If the query names a show, its recommendations join the pool.
  try {
    const hits = await searchShows(c, query, uiLang);
    if (hits.length > 0) {
      const recs = await getShowRecommendations(c, hits[0].id, uiLang);
      absorb(recs);
    }
  } catch {
    // Query-driven expansion is best-effort.
  }

  const candidates = [...byId.values()];
  if (candidates.length === 0) {
    throw new Error('no_candidates');
  }

  let pick = candidates[0];
  if (c.env.AI) {
    const vectors = await embedTextsWithEnv(c.env, [
      query,
      ...candidates.map((cand) =>
        candidateEmbedText(cand.title, cand.genreNames, cand.originalLanguage, cand.originCountry),
      ),
    ]);
    if (vectors && vectors.length === candidates.length + 1) {
      let best = -Infinity;
      vectors.slice(1).forEach((v, i) => {
        const sim = cosine(vectors[0], v);
        if (sim > best) {
          best = sim;
          pick = candidates[i];
        }
      });
    }
  } else {
    candidates.sort((a, b) => b.popularity - a.popularity);
    pick = candidates[0];
  }

  const provider = getRankLlmProvider(c.env);
  const rationale = await provider.generate(
    buildAdhocRationalePrompt(
      query,
      {
        tmdbId: pick.tmdbId,
        title: pick.title,
        year: pick.firstAirDate ? pick.firstAirDate.slice(0, 4) : '',
        genres: pick.genreNames,
        originalLanguage: pick.originalLanguage,
        originCountry: pick.originCountry,
      },
      uiLang,
    ),
  );

  return {
    tmdbId: pick.tmdbId,
    title: pick.title,
    originalLanguage: pick.originalLanguage,
    firstAirDate: pick.firstAirDate,
    posterPath: pick.posterPath,
    genres: pick.genreNames,
    rationale: rationale.trim(),
  };
}
