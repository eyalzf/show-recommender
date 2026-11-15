import type { Context } from 'hono';
import type { Env } from './env';

/**
 * Server-side TMDB client (api.themoviedb.org/3, Bearer token from the
 * TMDB_READ_TOKEN Worker secret).
 *
 * Terms guardrails (TMDB API Terms of Use, last updated 2023-10-20):
 *  - §1.C forbids using TMDB APIs/Content "in connection with, including
 *    for training, a machine learning (ML) or artificial intelligence (AI)
 *    based Application". This app's LLM layer therefore NEVER receives
 *    TMDB content: prompts are built from user-authored taste text and show
 *    titles/IDs only. See llm.ts. This is a terms-reading, not legal advice;
 *    the scope of "AI based Application" is ambiguous and needs a product
 *    decision before the LLM features go beyond taste consolidation.
 *  - §1.C also forbids caching TMDB data "for longer than 6 months". The
 *    metadata cache below enforces a 180-day TTL, well inside that limit.
 *  - Attribution (footer + logo) is a license condition; see the frontend
 *    footer in src/App.tsx.
 */

const TMDB_BASE = 'https://api.themoviedb.org/3';

/** Cache TTL for TMDB metadata: 180 days (terms cap is 6 months). */
export const TMDB_CACHE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

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
  originCountry: string[];
  /** Canonical origin label, e.g. "Kan 11 original" (override table wins). */
  originLabel: string | null;
  status: string | null;
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
  return data.results ?? [];
}

/**
 * Popular-show discovery for the ad-hoc flow (milestone 1 seed list).
 * Language filtering by profile happens in milestone 2; this returns
 * popular titles and the caller picks from them.
 */
export async function discoverShows(
  c: Context<{ Bindings: Env }>,
  uiLang: string,
): Promise<TmdbSearchResult[]> {
  const data = await tmdbFetch<{ results: TmdbSearchResult[] }>(c, '/discover/tv', {
    language: tmdbLanguage(uiLang),
    sort_by: 'popularity.desc',
    include_adult: 'false',
    page: '1',
  });
  return data.results ?? [];
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

/** Fetch a show's detail and resolve it through the TMDB -> override chain. */
export async function getShow(
  c: Context<{ Bindings: Env }>,
  tmdbId: number,
  uiLang: string,
): Promise<ResolvedShow> {
  const detail = await tmdbFetch<TmdbShowDetail>(c, `/tv/${tmdbId}`, {
    language: tmdbLanguage(uiLang),
  });
  const override = await readOverride(c, tmdbId);

  let title = detail.name;
  let overview = detail.overview;
  let source: ResolvedShow['source'] = 'tmdb';
  if (uiLang === 'he' && override) {
    // Curated override wins for Hebrew text where present (spec §4 chain).
    if (override.he_title) title = override.he_title;
    if (override.he_overview) overview = override.he_overview;
    if (override.he_title || override.he_overview) source = 'override';
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
    originCountry: detail.origin_country,
    originLabel: override?.origin_label ?? detail.networks[0]?.name ?? null,
    status: detail.status,
    numberOfSeasons: detail.number_of_seasons,
    numberOfEpisodes: detail.number_of_episodes,
    episodeRunTime: detail.episode_run_time,
    providers: override?.providers_note ? [override.providers_note] : [],
  };
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
