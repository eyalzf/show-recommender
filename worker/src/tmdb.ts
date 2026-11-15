import type { Context } from 'hono';
import type { Env } from './env';
import { displaySeasons } from './util';

/**
 * Server-side TMDB client (api.themoviedb.org/3, Bearer token from the
 * TMDB_READ_TOKEN Worker secret).
 *
 * Terms guardrails (TMDB API Terms of Use, last updated 2023-10-20):
 *  - §1.C forbids using TMDB APIs/Content "in connection with, including
 *    for training, a machine learning (ML) or artificial intelligence (AI)
 *    based Application". This app's LLM layer therefore NEVER receives
 *    TMDB content: prompts are built from user-authored taste text and
 *    show titles/IDs plus factual labels (genre names, year, language,
 *    runtime, season counts) only — never overviews or descriptions.
 *    See llm.ts. This is a terms-reading, not legal advice; the scope of
 *    "AI based Application" is ambiguous and needs a product decision
 *    before the LLM features go beyond taste consolidation + ranking.
 *  - §1.C also forbids caching TMDB data "for longer than 6 months". The
 *    metadata cache below enforces a 180-day TTL, well inside that limit.
 *  - Attribution (footer + logo) is a license condition; see the frontend
 *    footer in src/App.tsx.
 */

const TMDB_BASE = 'https://api.themoviedb.org/3';

/** Cache TTL for TMDB metadata: 180 days (terms cap is 6 months). */
export const TMDB_CACHE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Defense-in-depth blocklist for the verified Zagouri duplicate entries
 * (TMDB API check 2026-11-15). The curated_overrides `excluded` flag is
 * the real mechanism; this constant keeps the duplicates out even if the
 * seed migration was never applied. Canonical entry is 75547.
 */
export const BLOCKED_TMDB_IDS = new Set([290353, 68885]);

export function isBlockedId(tmdbId: number): boolean {
  return BLOCKED_TMDB_IDS.has(tmdbId);
}

export class TmdbNotConfiguredError extends Error {
  readonly status = 503;
  readonly code = 'tmdb_not_configured';
  constructor() {
    super(
      'TMDB key not configured: set the TMDB_READ_TOKEN Worker secret (TMDB API v4 read access token) and redeploy.',
    );
    this.name = 'TmdbNotConfiguredError';
  }
}

export class TmdbApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`TMDB API error (HTTP ${status}): ${message}`);
    this.name = 'TmdbApiError';
    this.status = status;
  }
}

export interface TmdbSearchResult {
  id: number;
  name: string;
  original_name: string;
  original_language: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  first_air_date: string;
  genre_ids: number[];
  origin_country: string[];
  popularity: number;
  vote_average: number;
  vote_count: number;
}

export interface TmdbShowDetail extends TmdbSearchResult {
  genres: { id: number; name: string }[];
  number_of_seasons: number;
  number_of_episodes: number;
  episode_run_time: number[];
  status: string;
  networks: { id: number; name: string }[];
  created_by: { name: string }[];
  seasons: { season_number: number; episode_count: number; air_date: string | null }[];
}

/** One canonical origin label per show (spec §4) — never a raw passthrough. */
export interface ResolvedShow {
  tmdbId: number;
  title: string;
  originalTitle: string;
  originalLanguage: string;
  overview: string;
  /** Where the displayed title/overview came from (fallback chain position). */
  source: 'tmdb' | 'override';
  autoTranslated: false;
  posterPath: string | null;
  firstAirDate: string;
  genres: string[];
  genreIds: number[];
  originCountry: string[];
  /** Canonical origin label, e.g. "Kan 11 original" (override table wins). */
  originLabel: string | null;
  status: string | null;
  /** Seasons excluding season 0 (specials). */
  numberOfSeasons: number | null;
  numberOfEpisodes: number | null;
  episodeRunTime: number[] | null;
  /** Display-only providers; never a filter (spec §3). */
  providers: string[];
}

function requireToken(c: Context<{ Bindings: Env }>): string {
  const token = c.env.TMDB_READ_TOKEN;
  if (!token) throw new TmdbNotConfiguredError();
  return token;
}

async function tmdbFetch<T>(
  c: Context<{ Bindings: Env }>,
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const token = requireToken(c);
  const url = new URL(TMDB_BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new TmdbApiError(res.status, (await res.text()).slice(0, 300));
  }
  return (await res.json()) as T;
}

/** UI language -> TMDB language tag. */
export function tmdbLanguage(uiLang: string): string {
  return uiLang === 'he' ? 'he-IL' : 'en-US';
}

/** Search TV shows. Matching downstream must use IDs, never titles (spec §4). */
export async function searchShows(
  c: Context<{ Bindings: Env }>,
  query: string,
  uiLang: string,
  page = 1,
): Promise<TmdbSearchResult[]> {
  const data = await tmdbFetch<{ results: TmdbSearchResult[] }>(c, '/search/tv', {
    query,
    language: tmdbLanguage(uiLang),
    page: String(page),
    include_adult: 'false',
  });
  return (data.results ?? []).filter((r) => !isBlockedId(r.id));
}

export interface DiscoverOptions {
  /** Original-language codes; empty = no language restriction. */
  languages?: string[];
  genreIds?: number[];
  sortBy?: string;
  page?: number;
  minVoteCount?: number;
}

/**
 * Discover TV shows with the profile's hard language filter applied at
 * the API level (with_original_language ORs with `|`).
 */
export async function discoverShows(
  c: Context<{ Bindings: Env }>,
  uiLang: string,
  opts: DiscoverOptions = {},
): Promise<TmdbSearchResult[]> {
  const params: Record<string, string> = {
    language: tmdbLanguage(uiLang),
    sort_by: opts.sortBy ?? 'popularity.desc',
    include_adult: 'false',
    page: String(opts.page ?? 1),
  };
  if (opts.languages && opts.languages.length > 0) {
    params['with_original_language'] = opts.languages.join('|');
  }
  if (opts.genreIds && opts.genreIds.length > 0) {
    params['with_genres'] = opts.genreIds.join(',');
  }
  if (opts.minVoteCount != null) {
    params['vote_count.gte'] = String(opts.minVoteCount);
  }
  const data = await tmdbFetch<{ results: TmdbSearchResult[] }>(c, '/discover/tv', params);
  return (data.results ?? []).filter((r) => !isBlockedId(r.id));
}

/** Trending TV this week (freshness pool for the engine). */
export async function getTrending(
  c: Context<{ Bindings: Env }>,
  uiLang: string,
): Promise<TmdbSearchResult[]> {
  const data = await tmdbFetch<{ results: TmdbSearchResult[] }>(c, '/trending/tv/week', {
    language: tmdbLanguage(uiLang),
  });
  return (data.results ?? []).filter((r) => !isBlockedId(r.id));
}

/** TMDB's own recommendations for a show ("more like this" anchor). */
export async function getShowRecommendations(
  c: Context<{ Bindings: Env }>,
  tmdbId: number,
  uiLang: string,
): Promise<TmdbSearchResult[]> {
  const data = await tmdbFetch<{ results: TmdbSearchResult[] }>(c, `/tv/${tmdbId}/recommendations`, {
    language: tmdbLanguage(uiLang),
    page: '1',
  });
  return (data.results ?? []).filter((r) => !isBlockedId(r.id));
}

// Genre id -> name map, cached per isolate per language (the list barely
// changes, but the names are localized, so each language gets its own entry).
const genreCaches = new Map<string, { at: number; map: Map<number, string> }>();

export async function getGenreMap(
  c: Context<{ Bindings: Env }>,
  uiLang: string,
): Promise<Map<number, string>> {
  const tag = tmdbLanguage(uiLang);
  const hit = genreCaches.get(tag);
  if (hit && Date.now() - hit.at < 24 * 60 * 60 * 1000) return hit.map;
  const data = await tmdbFetch<{ genres: { id: number; name: string }[] }>(c, '/genre/tv/list', {
    language: tag,
  });
  const map = new Map((data.genres ?? []).map((g) => [g.id, g.name]));
  genreCaches.set(tag, { at: Date.now(), map });
  return map;
}

interface OverrideRow {
  he_title: string | null;
  he_overview: string | null;
  origin_label: string | null;
  providers_note: string | null;
}

async function readOverride(
  c: Context<{ Bindings: Env }>,
  tmdbId: number,
): Promise<OverrideRow | null> {
  const db = c.env.DB;
  if (!db) return null;
  return await db
    .prepare(
      'SELECT he_title, he_overview, origin_label, providers_note FROM curated_overrides WHERE tmdb_id = ?',
    )
    .bind(tmdbId)
    .first<OverrideRow>();
}

/** Raw detail fetch (no override merge, no providers). */
export async function getShowDetailRaw(
  c: Context<{ Bindings: Env }>,
  tmdbId: number,
  uiLang: string,
): Promise<TmdbShowDetail> {
  return await tmdbFetch<TmdbShowDetail>(c, `/tv/${tmdbId}`, {
    language: tmdbLanguage(uiLang),
  });
}

/** IL watch providers for a show, display-only. Empty when TMDB has none. */
export async function getWatchProviders(
  c: Context<{ Bindings: Env }>,
  tmdbId: number,
): Promise<string[]> {
  try {
    const data = await tmdbFetch<{
      results?: Record<string, { flatrate?: { provider_name: string }[]; rent?: { provider_name: string }[]; buy?: { provider_name: string }[]; free?: { provider_name: string }[]; ads?: { provider_name: string }[] }>;
    }>(c, `/tv/${tmdbId}/watch/providers`, {});
    const il = data.results?.['IL'];
    if (!il) return [];
    const names = new Set<string>();
    for (const kind of ['flatrate', 'free', 'ads', 'rent', 'buy'] as const) {
      for (const p of il[kind] ?? []) names.add(p.provider_name);
    }
    return [...names];
  } catch {
    // Providers are display-only; a failure must not break the detail page.
    return [];
  }
}

/** Merge raw detail through the TMDB -> override chain. */
export function resolveDetail(
  detail: TmdbShowDetail,
  override: OverrideRow | null,
  uiLang: string,
  providers: string[],
): ResolvedShow {
  let title = detail.name;
  let overview = detail.overview;
  let source: ResolvedShow['source'] = 'tmdb';
  if (uiLang === 'he' && override) {
    // Curated override wins for Hebrew text where present (spec §4 chain).
    if (override.he_title) title = override.he_title;
    if (override.he_overview) overview = override.he_overview;
    if (override.he_title || override.he_overview) source = 'override';
  }
  if (override?.providers_note) {
    providers = [override.providers_note, ...providers];
  }
  return {
    tmdbId: detail.id,
    title,
    originalTitle: detail.original_name,
    originalLanguage: detail.original_language,
    overview,
    source,
    autoTranslated: false,
    posterPath: detail.poster_path,
    firstAirDate: detail.first_air_date,
    genres: detail.genres.map((g) => g.name),
    genreIds: detail.genres.map((g) => g.id),
    originCountry: detail.origin_country,
    originLabel: override?.origin_label ?? detail.networks[0]?.name ?? null,
    status: detail.status,
    numberOfSeasons: displaySeasons(detail.seasons, detail.number_of_seasons),
    numberOfEpisodes: detail.number_of_episodes,
    episodeRunTime: detail.episode_run_time,
    providers,
  };
}

/** Fetch a show's detail and resolve it through the TMDB -> override chain. */
export async function getShow(
  c: Context<{ Bindings: Env }>,
  tmdbId: number,
  uiLang: string,
): Promise<ResolvedShow> {
  const [detail, override, providers] = await Promise.all([
    getShowDetailRaw(c, tmdbId, uiLang),
    readOverride(c, tmdbId),
    getWatchProviders(c, tmdbId),
  ]);
  return resolveDetail(detail, override, uiLang, providers);
}

/**
 * Read-through metadata cache (show_metadata_cache table).
 *
 * Only used when the DB is bound. Entries older than TMDB_CACHE_TTL_MS are
 * treated as misses and refreshed, keeping every cached row inside the
 * terms' 6-month caching cap. Cached values are raw TMDB payloads; the
 * override merge in getShow() still applies on top.
 */
export async function getCachedShowPayload(
  c: Context<{ Bindings: Env }>,
  tmdbId: number,
  uiLang: string,
): Promise<Record<string, unknown> | null> {
  const db = c.env.DB;
  if (!db) return null;
  const row = await db
    .prepare('SELECT payload_json, cached_at FROM show_metadata_cache WHERE tmdb_id = ? AND language = ?')
    .bind(tmdbId, tmdbLanguage(uiLang))
    .first<{ payload_json: string; cached_at: number }>();
  if (!row) return null;
  if (Date.now() - row.cached_at > TMDB_CACHE_TTL_MS) return null;
  try {
    return JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function putCachedShowPayload(
  c: Context<{ Bindings: Env }>,
  tmdbId: number,
  uiLang: string,
  payload: unknown,
): Promise<void> {
  const db = c.env.DB;
  if (!db) return;
  await db
    .prepare(
      `INSERT INTO show_metadata_cache (tmdb_id, language, payload_json, cached_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tmdb_id, language) DO UPDATE SET payload_json = excluded.payload_json, cached_at = excluded.cached_at`,
    )
    .bind(tmdbId, tmdbLanguage(uiLang), JSON.stringify(payload), Date.now())
    .run();
}

/**
 * Detail fetch with the read-through cache. Used by the engine for
 * finalist enrichment so repeat generations don't re-fetch TMDB.
 */
export async function getShowDetailCached(
  c: Context<{ Bindings: Env }>,
  tmdbId: number,
  uiLang: string,
): Promise<TmdbShowDetail> {
  const cached = await getCachedShowPayload(c, tmdbId, uiLang);
  if (cached && typeof cached['id'] === 'number') {
    return cached as unknown as TmdbShowDetail;
  }
  const detail = await getShowDetailRaw(c, tmdbId, uiLang);
  await putCachedShowPayload(c, tmdbId, uiLang, detail);
  return detail;
}
