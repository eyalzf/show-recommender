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
  groundRisk,
  LONG_TERM_BLEND_WEIGHT,
  maxNegativeSimilarity,
  mergeRankPasses,
  NEGATIVE_DEMOTION_COSINE,
  NEGATIVE_DEMOTION_PENALTY,
  NEGATIVE_EXCLUSION_COSINE,
  noveltyFor,
  relaxedDisplay,
  SHORT_TERM_BLEND_WEIGHT,
  type RerankCandidate,
} from './rerank';
import {
  classifyKind,
  classifyType,
  clusterFor,
  combineTasteSections,
  cosine,
  effectiveRules,
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
  RESERVOIR_FRESH_BATCH,
  RESERVOIR_SIZE,
  reservoirEntryFacts,
  reservoirPath,
  selectCapped,
  softRuleScore,
  structureFor,
  tasteTextForKind,
  toneFor,
  type PreferenceRule,
  type RankedEntry,
  type ReservoirEntry,
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
 * factual labels only (see llm.ts terms guardrail).
 *
 * Stability comes from a persistent ranked RESERVOIR (see util.ts):
 * each kind keeps up to 50 shows in pool_json and displays 10.
 * Regeneration prunes the reservoir (rated/denied/rule-failing shows
 * drop), re-ranks the survivors with a fresh batch mixed in, tops up
 * below 30 survivors, and rebuilds from scratch at 10 or fewer — so a
 * refresh keeps good shows instead of churning them, and rating a
 * show promotes the next reservoir entry without a regeneration.
 *
 * A deterministic post-pass then re-orders each kind's ranked list
 * (see rerank.deterministicRerank): MMR over embedding similarity,
 * Steck calibration toward the liked-show cluster mix, and the
 * MOSTRA epsilon rule for the fit/novelty/freshness blend — with the
 * strict diversity caps binding inside the same pass. The caps keep a
 * Top 10 from collapsing into one type of show: at most 3 shows per
 * genre-ID cluster per list (see clusterFor in util.ts), plus a looser
 * per-cluster cap on the rank pool so one cluster cannot crowd out the
 * rest before ranking. The display slice RELAXES the cap on narrow
 * pools (see relaxedDisplay): cap-blocked shows fill only slots the
 * strict order leaves empty, so a 2-show list while good same-cluster
 * shows sat blocked cannot happen; on wide pools the cap still binds
 * exactly as before. Fewer than 10 are shown with a reason only when
 * the ranked pool itself holds fewer than 10 — never padded.
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
  /** Retrieval anchor title, when known. Internal: lets the read path re-ground the rationale; not displayed. */
  anchorTitle?: string | null;
  posterPath: string | null;
}

export interface GeneratedList {
  /** Persistent ranked reservoir (up to RESERVOIR_SIZE per kind); the snapshot slices its head. */
  pool: ReservoirEntry[];
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
/**
 * Hard cap on removals per kind per generation. The check is the
 * third of three negative layers (retrieval exclusion and demotion
 * already ran); its realistic yield is 0–2 shows. Without a cap, one
 * bad 8B output over a long check set can wipe a whole reservoir —
 * on 2026-11-17 the full-reservoir check removed all 43 casual
 * entries in one generation. The cap bounds that failure mode to a
 * small loss while preserving every realistic use.
 */
const MAX_REMOVAL_CHECK_REMOVALS = 5;

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
 * Rebuild a candidate from a stored reservoir entry — no detail
 * fetch (the entry carries the snapshot; see the reservoir note in
 * util.ts). Genre names re-derive from ids so the UI language is
 * always current. Anchors and retrieval boosts recompute downstream.
 */
function candidateFromEntry(entry: ReservoirEntry, genreMap: Map<number, string>): Candidate {
  return {
    tmdbId: entry.tmdbId,
    title: entry.title,
    originalTitle: entry.originalTitle,
    originalLanguage: entry.originalLanguage,
    originCountry: [...entry.originCountry],
    genreIds: [...entry.genreIds],
    genreNames: entry.genreIds.map((id) => genreMap.get(id) ?? '').filter(Boolean),
    popularity: entry.popularity,
    voteAverage: entry.voteAverage,
    voteCount: entry.voteCount,
    firstAirDate: entry.firstAirDate,
    posterPath: entry.posterPath,
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
    detailFacts: { ...entry.detailFacts },
  };
}

/** Snapshot a candidate into a reservoir entry for storage. */
function entryFromCandidate(cand: Candidate, rationale: string, risk: string | null): ReservoirEntry {
  return {
    tmdbId: cand.tmdbId,
    score: cand.retrievalScore,
    rationale,
    risk,
    ...(cand.anchorTitle ? { anchorTitle: cand.anchorTitle } : {}),
    title: cand.title,
    originalTitle: cand.originalTitle,
    originalLanguage: cand.originalLanguage,
    originCountry: [...cand.originCountry],
    genreIds: [...cand.genreIds],
    firstAirDate: cand.firstAirDate,
    popularity: cand.popularity,
    voteAverage: cand.voteAverage,
    voteCount: cand.voteCount,
    posterPath: cand.posterPath,
    detailFacts: cand.detailFacts ?? { ...EMPTY_DETAIL_FACTS },
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
          risk: groundRisk(r.risk ?? null),
          ...(cand?.anchorTitle ? { anchorTitle: cand.anchorTitle } : {}),
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
          ...(cand.anchorTitle ? { anchorTitle: cand.anchorTitle } : {}),
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
        ...(cand.anchorTitle ? { anchorTitle: cand.anchorTitle } : {}),
      })),
    shortReason: null,
  };
}

/**
 * Final negative layer (c): an LLM removal-only check over the
 * ranked order (greedy order + cap-deferred remainder). Returns the
 * ids to remove — validated against the checked set, so the check
 * can only remove, and capped (see MAX_REMOVAL_CHECK_REMOVALS) so a
 * bad model output cannot gut a list. Fails open (no removals) when
 * there are no negatives, the call fails, or nothing parses: the
 * retrieval and demotion layers still apply. The reservoir TAIL is
 * deliberately not checked here: tail shows passed the retrieval
 * exclusion and demotion layers at this same regeneration, and they
 * get this check when they enter the ranked order — checking the
 * tail too tripled the prompt and let one bad output wipe a whole
 * reservoir (2026-11-17).
 */
async function removalCheck(
  c: Context<{ Bindings: Env }>,
  ordered: RankedEntry[],
  byId: Map<number, Candidate>,
  negatives: ShowMeta[],
  uiLang: string,
  checkSize: number = REMOVAL_CHECK_SIZE,
): Promise<Set<number>> {
  if (negatives.length === 0 || ordered.length === 0) return new Set();
  const checkSet = ordered.slice(0, checkSize);
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
    return new Set(parseRemovalCheckResponse(text, validIds).slice(0, MAX_REMOVAL_CHECK_REMOVALS));
  } catch (err) {
    console.error('removal check failed', err);
    return new Set();
  }
}

/** Enrich one ranked entry into a display item (rank assigned by the caller). Null on fetch failure. */
async function enrichOne(
  c: Context<{ Bindings: Env }>,
  entry: RankedEntry,
  ctx: ProfileContext,
  uiLang: string,
): Promise<ListItemOut | null> {
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
    return {
      rank: 0,
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
      rationale: groundRationale(
        entry.rationale,
        entry.anchorTitle ?? null,
        show.genres,
        show.firstAirDate ? show.firstAirDate.slice(0, 4) : '',
        uiLang,
      ),
      risk: groundRisk(entry.risk),
      ...(entry.anchorTitle ? { anchorTitle: entry.anchorTitle } : {}),
      posterPath: show.posterPath,
    };
  } catch (err) {
    console.error(`enrichment failed for ${entry.tmdbId}`, err);
    // A failed detail fetch drops the show rather than inventing data.
    return null;
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
  for (const entry of top) {
    const item = await enrichOne(c, entry, ctx, uiLang);
    if (item) items.push(item);
  }
  // Re-rank after drops so ranks stay dense.
  items.forEach((item, i) => {
    item.rank = i + 1;
  });
  return items;
}

/**
 * Serve-time repair for stored snapshot items (2026-11-18 rationale
 * fix): re-ground rationale/risk through the same checks as generation,
 * so echoes stored before the fix never display. Read-only — the
 * stored snapshot is untouched; the cleaned copy is what the client
 * receives. The item's stored anchorTitle (absent on pre-fix snapshots)
 * lets anchor-citing sentences survive; without it, genre+year carries
 * the check, as in groundRationale.
 */
export function sanitizeStoredItem(item: ListItemOut, uiLang: string): ListItemOut {
  return {
    ...item,
    rationale: groundRationale(
      item.rationale,
      item.anchorTitle ?? null,
      item.genres ?? [],
      item.firstYear ? String(item.firstYear) : '',
      uiLang,
    ),
    risk: groundRisk(item.risk),
  };
}

/**
 * Refill a short snapshot from the reservoir (read path, no LLM):
 * after a rating/deny prunes the snapshot, the next reservoir entries
 * promote into view. Each promoted entry is re-checked against the
 * CURRENT hard rules with FRESH cached details before it can
 * surface — stored facts can go stale (a show's status or season
 * count changes), and the tail never passed the pool-stage filter.
 * Rated/denied/excluded and off-language entries are skipped, never
 * promoted. Returns the merged snapshot with dense ranks.
 */
export async function refillSnapshot(
  c: Context<{ Bindings: Env }>,
  snapshot: ListItemOut[],
  pool: ReservoirEntry[],
  ctx: ProfileContext,
  uiLang: string,
  overlay?: MoodOverlay,
): Promise<ListItemOut[]> {
  if (snapshot.length >= TOP_N) return snapshot;
  // Mood lists refill under the effective rules, like generation.
  if (overlay) {
    ctx = { ...ctx, rules: effectiveRules(ctx.rules, overlay.rules) };
  }
  const languages = ctx.profile.languages;
  const excluded = new Set<number>([...ctx.ratedIds, ...ctx.denyIds, ...ctx.excludedIds]);
  const present = new Set(snapshot.map((item) => item.tmdbId));
  const items = [...snapshot];
  for (const entry of pool) {
    if (items.length >= TOP_N) break;
    if (present.has(entry.tmdbId) || excluded.has(entry.tmdbId) || isBlockedId(entry.tmdbId)) continue;
    if (languages.length > 0 && !languages.includes(entry.originalLanguage)) continue;
    let detail;
    try {
      detail = await getShowDetailCached(c, entry.tmdbId, uiLang);
    } catch {
      continue;
    }
    const resolved = resolveDetail(detail, null, uiLang, []);
    const year = Number(detail.first_air_date ? detail.first_air_date.slice(0, 4) : NaN);
    const facts: ShowFacts = {
      genreIds: (detail.genres ?? []).map((g) => g.id),
      year: Number.isInteger(year) ? year : null,
      originCountry: detail.origin_country ?? [],
      status: resolved.status,
      seasons: resolved.numberOfSeasons,
      episodeMinutes: resolved.episodeRunTime?.[0] ?? null,
    };
    if (!passesHardRules(facts, ctx.rules)) continue;
    const item = await enrichOne(
      c,
      { tmdbId: entry.tmdbId, rationale: entry.rationale, risk: entry.risk, anchorTitle: entry.anchorTitle ?? null },
      ctx,
      uiLang,
    );
    if (item) {
      present.add(entry.tmdbId);
      items.push(item);
    }
  }
  items.forEach((item, i) => {
    item.rank = i + 1;
  });
  return items;
}

function emptyList(shortReason: string | null): GeneratedList {
  return { pool: [], snapshot: [], shortReason, updatedAt: Date.now() };
}

/**
 * A Mood overlay for one generation: the mood's own text plus its
 * extracted rules. Generation merges the rules with the fixed
 * profile rules (dimension-level override — see
 * util.effectiveRules) and appends the text as a prose suffix on
 * the taste text, so a prose-only mood (zero extracted rules) still
 * shifts retrieval and ranking.
 */
export interface MoodOverlay {
  text: string;
  rules: PreferenceRule[];
}

/**
 * Generate both lists for a profile. Requires TMDB (throws
 * TmdbNotConfiguredError / TmdbApiError) and a non-empty feedback log;
 * with no feedback at all the lists stay empty with a reason, because
 * there is nothing to rank against.
 *
 * Reservoir-aware: `prev` carries the stored reservoirs (empty on
 * first generation, or after a legacy pool row). Each kind
 * independently prunes its survivors (rated/denied/excluded/blocked,
 * off-language, or failing a hard rule on stored facts), then picks
 * a path by survivor count — rebuild (10 or fewer: survivors
 * discarded, fresh pipeline only), top-up (under 30: a fresh batch
 * refills toward the reservoir size), or re-rank (30+: survivors +
 * a small fresh batch, so the reservoir cannot fossilize). Survivors
 * and fresh candidates merge into one deterministically scored pool;
 * the LLM listwise-ranks a 30-show working set per kind exactly as
 * before, and the reservoir keeps the greedy order + cap-deferred
 * remainder + deterministic tail, capped at 50. The removal check
 * covers the ranked order (capped per generation), so it can never
 * wipe the reservoir; tail shows are vetted by the retrieval and
 * demotion layers and get the removal check when ranked.
 *
 * With an `overlay`, the whole generation runs under the EFFECTIVE
 * rules (mood rules override fixed rules per dimension) and the mood
 * text rides along on the taste text. The caller's stored rows for
 * the mood keep their own reservoirs — `prev` must be the mood's
 * reservoirs, never the main list's.
 */
export async function generateLists(
  c: Context<{ Bindings: Env }>,
  ctx: ProfileContext,
  uiLang: string,
  prev?: { casual: ReservoirEntry[]; deep: ReservoirEntry[] },
  overlay?: MoodOverlay,
): Promise<GeneratedLists> {
  const now = Date.now();
  // Mood overlay: swap in the effective rules for the whole
  // generation — retrieval, prune, pool filter, and soft scoring all
  // read ctx.rules, so one reassignment (on a shallow copy; the
  // caller's context is untouched) covers every layer.
  if (overlay) {
    ctx = { ...ctx, rules: effectiveRules(ctx.rules, overlay.rules) };
  }
  const moodSuffix =
    overlay && overlay.text.trim()
      ? `\n\nCurrent mood (what the user wants right now — weigh it alongside the taste description above, never instead of the standing likes and dislikes):\n${overlay.text.trim()}`
      : '';
  if (ctx.showFeedback.length === 0) {
    const reason =
      uiLang === 'he'
        ? 'דרגו כמה סדרות קודם — הרשימות נבנות מהדירוגים וההערות שלכם.'
        : 'Rate a few shows first — the lists are built from your ratings and notes.';
    return { casual: emptyList(reason), deep: emptyList(reason) };
  }

  // --- prune the stored reservoirs ----------------------------------
  // Stored facts decide here (no fetches — see the reservoir note in
  // util.ts); detail facts refresh at the pool stage for ranked
  // shows, and promotion re-checks with fresh details.
  const languages = ctx.profile.languages;
  const excludedIds = new Set<number>([...ctx.ratedIds, ...ctx.denyIds, ...ctx.excludedIds]);
  const pruneReservoir = (entries: ReservoirEntry[]): ReservoirEntry[] =>
    entries.filter((entry) => {
      if (excludedIds.has(entry.tmdbId) || isBlockedId(entry.tmdbId)) return false;
      if (languages.length > 0 && !languages.includes(entry.originalLanguage)) return false;
      return passesHardRules(reservoirEntryFacts(entry), ctx.rules);
    });
  const casualSurvivors = pruneReservoir(prev?.casual ?? []);
  const deepSurvivors = pruneReservoir(prev?.deep ?? []);
  const casualPath = reservoirPath(casualSurvivors.length);
  const deepPath = reservoirPath(deepSurvivors.length);
  const survivorById = new Map<number, ReservoirEntry>();
  for (const entry of [...casualSurvivors, ...deepSurvivors]) {
    if (!survivorById.has(entry.tmdbId)) survivorById.set(entry.tmdbId, entry);
  }
  // Rebuild discards survivors; the other paths carry them. A show
  // stored in both reservoirs is carried when either kind carries it.
  const carriedIds = new Set<number>();
  if (casualPath !== 'rebuild') for (const e of casualSurvivors) carriedIds.add(e.tmdbId);
  if (deepPath !== 'rebuild') for (const e of deepSurvivors) carriedIds.add(e.tmdbId);

  // --- fresh retrieval (shared by both kinds) -----------------------
  const fresh = await retrieveCandidates(c, ctx, uiLang);
  const genreMap = await getGenreMap(c, uiLang).catch(() => new Map<number, string>());

  // Survivors re-enter as candidates from their stored snapshot. A
  // show retrieval also found keeps the FRESH candidate (current
  // TMDB data); its stored rationale stays available for the tail.
  const freshById = new Map(fresh.map((cand) => [cand.tmdbId, cand]));
  const candidates: Candidate[] = [...fresh];
  for (const id of carriedIds) {
    if (freshById.has(id)) continue;
    const entry = survivorById.get(id);
    if (entry) candidates.push(candidateFromEntry(entry, genreMap));
  }
  const survivorIds = new Set<number>(carriedIds);

  const tasteText = tasteTextForRanking(ctx) + moodSuffix;
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
  // denied/disliked shows never reach the rank pools — survivors
  // included, so a new dislike evicts its look-alikes.
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

  // Per-kind merge: survivors + fresh batch. Rebuild takes fresh
  // only; top-up refills toward the reservoir size; re-rank mixes a
  // small fresh batch so new shows keep arriving.
  const mergeKind = (
    primary: Candidate[],
    path: 'rebuild' | 'topup' | 'rerank',
  ): Candidate[] => {
    if (path === 'rebuild') return primary.filter((cand) => !survivorIds.has(cand.tmdbId));
    const kept = primary.filter((cand) => survivorIds.has(cand.tmdbId));
    const freshOnly = primary.filter((cand) => !survivorIds.has(cand.tmdbId));
    const batch =
      path === 'topup'
        ? Math.max(0, RESERVOIR_SIZE - kept.length)
        : RESERVOIR_FRESH_BATCH;
    return [...kept, ...freshOnly.slice(0, batch)].sort(byScore);
  };
  const casualMerged = mergeKind(casualPrimary, casualPath);
  const deepMerged = mergeKind(deepPrimary, deepPath);

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
  const casualBucket = buildRankPool(casualMerged, deepMerged);
  const deepBucket = buildRankPool(deepMerged, casualMerged);
  let casualCands = casualBucket.picked;
  let deepCands = deepBucket.picked;
  // Tail: merged candidates outside the working set, in score order.
  // They keep reservoir depth without LLM cost and compete for the
  // working set on the next regeneration; they never display
  // directly (the LLM never vetted them).
  const casualWorkingIds = new Set(casualCands.map((cand) => cand.tmdbId));
  const deepWorkingIds = new Set(deepCands.map((cand) => cand.tmdbId));
  const casualTail = casualMerged.filter((cand) => !casualWorkingIds.has(cand.tmdbId));
  const deepTail = deepMerged.filter((cand) => !deepWorkingIds.has(cand.tmdbId));

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
    rankKind(c, 'casual', casualCands, casualBucket.strictIds, tasteTextForRankingWithRecency(ctx, 'casual', now) + moodSuffix, uiLang),
    rankKind(c, 'deep', deepCands, deepBucket.strictIds, tasteTextForRankingWithRecency(ctx, 'deep', now) + moodSuffix, uiLang),
  ]);

  // Deterministic post-LLM pass (MMR + calibration + epsilon blend +
  // strict caps, one greedy pass — see rerank.deterministicRerank).
  // Fit comes from the merged LLM rank position, minus the layer-(b)
  // negative demotion. The pass returns the greedy order plus the
  // cap-deferred remainder; the display slice relaxes the cap (see
  // relaxedDisplay), and the reservoir keeps the full order.
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

  // Reservoir assembly: greedy order ++ cap-deferred remainder ++
  // deterministic tail, deduped and capped. Ranked entries carry
  // their LLM/template rationale; tail survivors keep their stored
  // rationale, tail fresh shows get a template rationale.
  const assemble = (
    greedy: { ordered: GreedyEntry[]; deferred: GreedyEntry[] },
    tail: Candidate[],
    pool: Candidate[],
  ): { ordered: RankedEntry[]; deferred: RankedEntry[]; reservoir: ReservoirEntry[] } => {
    const byId = new Map(pool.map((cand) => [cand.tmdbId, cand]));
    const ordered = greedy.ordered.map((g) => g.entry);
    const deferred = greedy.deferred.map((g) => g.entry);
    const rankedOrder = [...ordered, ...deferred];
    const seen = new Set<number>();
    const reservoir: ReservoirEntry[] = [];
    for (const entry of rankedOrder) {
      if (seen.has(entry.tmdbId) || reservoir.length >= RESERVOIR_SIZE) continue;
      const cand = byId.get(entry.tmdbId);
      if (!cand) continue;
      seen.add(entry.tmdbId);
      reservoir.push(entryFromCandidate(cand, entry.rationale, entry.risk));
    }
    for (const cand of tail) {
      if (seen.has(cand.tmdbId) || reservoir.length >= RESERVOIR_SIZE) continue;
      seen.add(cand.tmdbId);
      const stored = survivorById.get(cand.tmdbId);
      const rationale =
        stored && stored.rationale
          ? stored.rationale
          : groundRationale(
              '',
              cand.anchorTitle,
              cand.genreNames,
              cand.firstAirDate ? cand.firstAirDate.slice(0, 4) : '',
              uiLang,
            );
      reservoir.push(entryFromCandidate(cand, rationale, stored?.risk ?? null));
    }
    return { ordered, deferred, reservoir };
  };
  const casualAssembled = assemble(casualGreedy, casualTail, casualCands);
  const deepAssembled = assemble(deepGreedy, deepTail, deepCands);

  // Final negative layer (c): removal-only LLM check over the RANKED
  // order only (greedy order + cap-deferred remainder) — never the
  // tail, and capped per generation (see removalCheck). Removals
  // cannot violate the caps (removal only shrinks clusters).
  // Display backfills from the ranked order after removals — the
  // tail never displays directly.
  const casualById = new Map(casualCands.map((cand) => [cand.tmdbId, cand]));
  const deepById = new Map(deepCands.map((cand) => [cand.tmdbId, cand]));
  const casualRankedOrder = [...casualAssembled.ordered, ...casualAssembled.deferred];
  const deepRankedOrder = [...deepAssembled.ordered, ...deepAssembled.deferred];
  const [casualRemoved, deepRemoved] = await Promise.all([
    removalCheck(c, casualRankedOrder, casualById, exclusionMeta, uiLang, casualRankedOrder.length),
    removalCheck(c, deepRankedOrder, deepById, exclusionMeta, uiLang, deepRankedOrder.length),
  ]);
  const casualReservoir = casualAssembled.reservoir.filter((e) => !casualRemoved.has(e.tmdbId));
  const deepReservoir = deepAssembled.reservoir.filter((e) => !deepRemoved.has(e.tmdbId));
  // Display: strict greedy head first, cap-deferred remainder filling
  // leftover slots (narrow-pool relaxation) — after removals, so a
  // removed show's slot backfills from the ranked order. The tail
  // never displays directly.
  const casualDisplay = relaxedDisplay(
    casualAssembled.ordered.filter((e) => !casualRemoved.has(e.tmdbId)),
    casualAssembled.deferred.filter((e) => !casualRemoved.has(e.tmdbId)),
    TOP_N,
  );
  const deepDisplay = relaxedDisplay(
    deepAssembled.ordered.filter((e) => !deepRemoved.has(e.tmdbId)),
    deepAssembled.deferred.filter((e) => !deepRemoved.has(e.tmdbId)),
    TOP_N,
  );

  const [casualItems, deepItems] = await Promise.all([
    enrichToListItems(c, casualDisplay, ctx, uiLang),
    enrichToListItems(c, deepDisplay, ctx, uiLang),
  ]);

  // The cap no longer shortens the display (relaxedDisplay fills
  // leftover slots from the cap-deferred remainder), so a short list
  // means the ranked pool itself held fewer than 10.
  const shortReasonFor = (
    items: ListItemOut[],
    poolSize: number,
    llmReason: string | null,
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
    return uiLang === 'he'
      ? `רק ${items.length} סדרות מתאימות כרגע.`
      : `Only ${items.length} shows qualify right now.`;
  };

  return {
    casual: {
      pool: casualReservoir,
      snapshot: casualItems,
      shortReason: shortReasonFor(casualItems, casualCands.length, casualRank.shortReason),
      updatedAt: now,
    },
    deep: {
      pool: deepReservoir,
      snapshot: deepItems,
      shortReason: shortReasonFor(deepItems, deepCands.length, deepRank.shortReason),
      updatedAt: now,
    },
  };
}

