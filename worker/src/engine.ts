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
import { buildAdhocRationalePrompt, buildRankPrompt, getLlmProvider } from './llm';
import { candidateEmbedText, embedTexts } from './embeddings';
import {
  classifyKind,
  classifyType,
  combineTasteSections,
  cosine,
  displaySeasons,
  normalizeTitle,
  paceFor,
  parseRankResponse,
  structureFor,
  tasteTextForKind,
  toneFor,
  type RankedEntry,
} from './util';

/**
 * Recommendation engine v1: retrieval, then LLM re-rank.
 *
 * Retrieval narrows the catalog to a few dozen candidates:
 *   1. hard filters first — profile languages, rated/dropped/deny-listed
 *      shows excluded, override-excluded duplicates excluded;
 *   2. candidate sources — TMDB discover (language-filtered, popular),
 *      trending, TMDB recommendations anchored on liked shows, genre
 *      discover from liked shows' genres, and resolved external recs;
 *   3. retrieval scoring — embedding similarity of the taste summary
 *      against title+genre text (NEVER overviews), popularity, votes,
 *      similar-show and external-rec boosts, genre overlap with likes.
 *
 * Ranking splits candidates into casual / deep-focus by a genre-ID
 * heuristic (IDs, never localized genre names — see util.ts), then the
 * LLM re-ranks up to 30 per kind into the Top 10 with a rationale each.
 * A bucket the heuristic starves (fewer than 10 primaries) is backfilled
 * from the other bucket's pool so the re-rank — not the heuristic —
 * decides fit; backfilled candidates surface only if the LLM ranks
 * them. Each kind's re-rank prompt gets the Shared taste section plus
 * its own section; retrieval embedding uses all sections joined. Prompts contain user text + factual labels
 * only (see llm.ts terms guardrail). The ranked pool stays larger than
 * 10 so removals promote; fewer than 10 are shown with a reason, never
 * padded.
 *
 * Subrequest budget: at most ~36 TMDB calls per generation (free-plan
 * Workers allow 50 per invocation). Finalist details go through the
 * 180-day metadata cache, so repeat generations cost less.
 */

export interface ListItemOut {
  rank: number;
  tmdbId: number;
  title: string;
  type: string;
  genres: string[];
  tone: string;
  pace: string;
  structure: string;
  episodeMinutes: number;
  seasons: number;
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
          mark(cand);
          byId.set(r.id, cand);
        }
      }
    } catch (err) {
      errors.push(err as Error);
    }
  };

  // Primary pools (parallel).
  await Promise.all([
    absorb(() => discoverShows(c, uiLang, { languages, page: 1, minVoteCount: 10 }), () => {}),
    absorb(() => discoverShows(c, uiLang, { languages, page: 2, minVoteCount: 10 }), () => {}),
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
      }),
    ),
    ...(topGenreIds.length > 0
      ? [
          absorb(
            () => discoverShows(c, uiLang, { languages, genreIds: topGenreIds, page: 1, minVoteCount: 10 }),
            () => {},
          ),
        ]
      : []),
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
            cand.fromRec = true;
            byId.set(rec.tmdbId, cand);
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
            cand.fromRec = true;
            byId.set(hit.id, cand);
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

async function scoreCandidates(
  c: Context<{ Bindings: Env }>,
  candidates: Candidate[],
  tasteText: string,
  likedGenreIds: Set<number>,
): Promise<void> {
  // Embedding similarity (degrades to null without an AI binding).
  let sims: number[] | null = null;
  if (c.env.AI && tasteText.trim()) {
    const vectors = await embedTexts(c.env.AI, [
      tasteText,
      ...candidates.map((cand) =>
        candidateEmbedText(cand.title, cand.genreNames, cand.originalLanguage, cand.originCountry),
      ),
    ]);
    if (vectors && vectors.length === candidates.length + 1) {
      const taste = vectors[0];
      sims = vectors.slice(1).map((v) => (cosine(taste, v) + 1) / 2);
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
  const provider = getLlmProvider(c.env);
  const fallbackRationale =
    uiLang === 'he' ? 'תואם את פרופיל הטעם.' : 'Matches your taste profile.';
  try {
    const parsed = parseRankResponse(
      await provider.generate(
        buildRankPrompt(
          tasteText,
          kind,
          candidates.map((cand) => ({
            tmdbId: cand.tmdbId,
            title: cand.title,
            year: cand.firstAirDate ? cand.firstAirDate.slice(0, 4) : '',
            genres: cand.genreNames,
            originalLanguage: cand.originalLanguage,
            originCountry: cand.originCountry,
          })),
          uiLang,
        ),
      ),
      new Set(candidates.map((cand) => cand.tmdbId)),
    );
    if (parsed) {
      const ranked = parsed.ranked.map((r) => ({
        ...r,
        rationale: r.rationale || fallbackRationale,
      }));
      const rankedIds = new Set(ranked.map((r) => r.tmdbId));
      // Fill up to the pool size from retrieval order (never invented),
      // except backfilled candidates the LLM did not rank.
      for (const cand of candidates) {
        if (ranked.length >= RANK_POOL_SIZE) break;
        if (rankedIds.has(cand.tmdbId)) continue;
        if (strictIds.has(cand.tmdbId)) continue;
        ranked.push({ tmdbId: cand.tmdbId, rationale: fallbackRationale, risk: null });
      }
      return { ranked, shortReason: parsed.shortReason };
    }
  } catch (err) {
    console.error(`LLM re-rank failed for ${kind}`, err);
  }
  return {
    ranked: candidates
      .filter((cand) => !strictIds.has(cand.tmdbId))
      .map((cand) => ({ tmdbId: cand.tmdbId, rationale: fallbackRationale, risk: null })),
    shortReason: null,
  };
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
      items.push({
        rank: i + 1,
        tmdbId: show.tmdbId,
        title: show.title,
        type: classifyType(show.genreIds, show.numberOfSeasons, show.numberOfEpisodes, show.status),
        genres: show.genres,
        tone: toneFor(show.genreIds),
        pace: paceFor(episodeMinutes || null),
        structure: structureFor(show.genreIds),
        episodeMinutes,
        seasons,
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
  const likedGenreIds = new Set<number>();
  for (const id of ctx.likedIds.slice(0, MAX_LIKED_ANCHORS)) {
    try {
      const detail = await getShowDetailCached(c, id, uiLang);
      for (const g of detail.genres ?? []) likedGenreIds.add(g.id);
    } catch {
      // Genre overlap is a soft signal; a failed fetch just skips it.
    }
  }
  await scoreCandidates(c, candidates, tasteText, likedGenreIds);

  const byScore = (a: Candidate, b: Candidate) => b.retrievalScore - a.retrievalScore;
  const casualPrimary = candidates
    .filter((cand) => classifyKind(cand.genreIds) === 'casual')
    .sort(byScore);
  const deepPrimary = candidates
    .filter((cand) => classifyKind(cand.genreIds) === 'deep')
    .sort(byScore);

  // Backfill a starved bucket (fewer primaries than a Top 10) from the
  // other bucket's pool, best retrieval score first. Borrowed candidates
  // are strict: the re-rank must accept them or they never surface.
  const withBackfill = (primary: Candidate[], other: Candidate[]) => {
    const picked = primary.slice(0, RANK_POOL_SIZE);
    const strictIds = new Set<number>();
    if (primary.length < TOP_N) {
      const pickedIds = new Set(picked.map((cand) => cand.tmdbId));
      for (const cand of other) {
        if (picked.length >= RANK_POOL_SIZE) break;
        if (pickedIds.has(cand.tmdbId)) continue;
        picked.push(cand);
        strictIds.add(cand.tmdbId);
      }
    }
    return { picked, strictIds };
  };
  const casualBucket = withBackfill(casualPrimary, deepPrimary);
  const deepBucket = withBackfill(deepPrimary, casualPrimary);
  const casualCands = casualBucket.picked;
  const deepCands = deepBucket.picked;

  const [casualRank, deepRank] = await Promise.all([
    rankKind(c, 'casual', casualCands, casualBucket.strictIds, tasteTextForRanking(ctx, 'casual'), uiLang),
    rankKind(c, 'deep', deepCands, deepBucket.strictIds, tasteTextForRanking(ctx, 'deep'), uiLang),
  ]);
  const casualRanked = casualRank.ranked;
  const deepRanked = deepRank.ranked;

  const [casualItems, deepItems] = await Promise.all([
    enrichToListItems(c, casualRanked, ctx, uiLang),
    enrichToListItems(c, deepRanked, ctx, uiLang),
  ]);

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
      pool: casualRanked.map((r) => ({
        tmdbId: r.tmdbId,
        score: casualCands.find((cand) => cand.tmdbId === r.tmdbId)?.retrievalScore ?? 0,
      })),
      snapshot: casualItems,
      shortReason: shortReasonFor(casualItems, casualCands.length, casualRank.shortReason),
      updatedAt: now,
    },
    deep: {
      pool: deepRanked.map((r) => ({
        tmdbId: r.tmdbId,
        score: deepCands.find((cand) => cand.tmdbId === r.tmdbId)?.retrievalScore ?? 0,
      })),
      snapshot: deepItems,
      shortReason: shortReasonFor(deepItems, deepCands.length, deepRank.shortReason),
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
  const byId = new Map<number, Candidate>();
  const absorb = (results: TmdbSearchResult[]) => {
    for (const r of results) {
      if (isBlockedId(r.id) || excluded.has(r.id)) continue;
      if (languages.length > 0 && !languages.includes(r.original_language)) continue;
      if (!byId.has(r.id)) byId.set(r.id, toCandidate(r, genreMap));
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
    const vectors = await embedTexts(c.env.AI, [
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

  const provider = getLlmProvider(c.env);
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
