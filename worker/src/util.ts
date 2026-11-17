/**
 * Pure helpers for the recommendation engine. No runtime imports: this
 * module is unit-testable with plain Node (see scripts/selftest.mjs).
 *
 * Classification (kind / type / tone / pace / structure) is heuristic v1
 * from TMDB genre IDs + runtime + season counts. Genre IDs — never names:
 * TMDB localizes genre names per UI language, and matching English names
 * once starved the casual bucket to zero for a Hebrew-language profile
 * ('קומדיה' !== 'Comedy'), silently emptying its casual list (2026-11-15).
 * The heuristics are deliberately simple and documented here; tune them
 * from real usage, not from speculation.
 */

// ---------------------------------------------------------------- titles

/** Normalize a show title for matching (rec titles vs feedback titles). */
export function normalizeTitle(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0591-\u05C7]/g, '') // Hebrew niqqud (e.g. נֶבְסוּ -> נבסו)
    .replace(/[̀-ͯ]/g, '') // Latin combining marks
    .toLowerCase()
    .replace(/[^a-z0-9\u0590-\u05ff\u4e00-\u9fff\uac00-\ud7a3]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- vectors

export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------------------------------------------------------------- classification

// TMDB TV genre IDs (verified against /genre/tv/list, 2026-11-15).
// IDs are stable across UI languages; names are localized. Keep the two
// sets aligned with the English genre names in the comments.
const GENRE_ACTION_ADVENTURE = 10759;
const GENRE_ANIMATION = 16;
const GENRE_COMEDY = 35;
const GENRE_CRIME = 80;
const GENRE_DOCUMENTARY = 99;
const GENRE_DRAMA = 18;
const GENRE_FAMILY = 10751;
const GENRE_KIDS = 10762;
const GENRE_MYSTERY = 9648;
const GENRE_NEWS = 10763;
const GENRE_REALITY = 10764;
const GENRE_SCIFI_FANTASY = 10765;
const GENRE_SOAP = 10766;
const GENRE_TALK = 10767;
const GENRE_WAR_POLITICS = 10768;
const GENRE_WESTERN = 37;

/**
 * THE fixed TMDB TV genre list (id + canonical English name, verified
 * against /genre/tv/list, 2026-11-15). Single source of truth for
 * derived hard exclusions (2026-11-17): the consolidation prompt
 * receives exactly this list and may only output ids from it, and
 * validateHardExcludes rejects anything not in it. IDs are stable
 * across UI languages; display names are resolved at runtime via the
 * localized TMDB genre map, never from this list.
 */
export const TMDB_TV_GENRES: ReadonlyArray<{ id: number; name: string }> = [
  { id: GENRE_ACTION_ADVENTURE, name: 'Action & Adventure' },
  { id: GENRE_ANIMATION, name: 'Animation' },
  { id: GENRE_COMEDY, name: 'Comedy' },
  { id: GENRE_CRIME, name: 'Crime' },
  { id: GENRE_DOCUMENTARY, name: 'Documentary' },
  { id: GENRE_DRAMA, name: 'Drama' },
  { id: GENRE_FAMILY, name: 'Family' },
  { id: GENRE_KIDS, name: 'Kids' },
  { id: GENRE_MYSTERY, name: 'Mystery' },
  { id: GENRE_NEWS, name: 'News' },
  { id: GENRE_REALITY, name: 'Reality' },
  { id: GENRE_SCIFI_FANTASY, name: 'Sci-Fi & Fantasy' },
  { id: GENRE_SOAP, name: 'Soap' },
  { id: GENRE_TALK, name: 'Talk' },
  { id: GENRE_WAR_POLITICS, name: 'War & Politics' },
  { id: GENRE_WESTERN, name: 'Western' },
];

export const TMDB_TV_GENRE_IDS: ReadonlySet<number> = new Set(TMDB_TV_GENRES.map((g) => g.id));

const CASUAL_GENRE_IDS = new Set([
  GENRE_COMEDY,
  GENRE_REALITY,
  GENRE_ANIMATION,
  GENRE_FAMILY,
  GENRE_KIDS,
  GENRE_TALK,
  GENRE_NEWS,
  GENRE_SOAP,
]);
const DEEP_GENRE_IDS = new Set([
  GENRE_DRAMA,
  GENRE_CRIME,
  GENRE_MYSTERY,
  GENRE_SCIFI_FANTASY,
  GENRE_WAR_POLITICS,
  GENRE_DOCUMENTARY,
  GENRE_WESTERN,
  GENRE_ACTION_ADVENTURE,
]);

/**
 * Casual vs deep-focus, v1 heuristic: genre majority wins; ties break
 * toward deep when Drama is present, toward casual when Comedy is
 * present, else deep. Exception: Animation + Comedy together, with no
 * Crime/Mystery, reads casual even when Drama/Sci-Fi tags along — e.g.
 * Hazbin Hotel (Animation/Comedy/Drama/Sci-Fi & Fantasy) is an animated
 * musical comedy, not deep-focus viewing, despite the 2-2 tie. The LLM
 * re-rank judges kind-fit afterwards, so a misclassified show drops in
 * its list rather than vanishing.
 * Takes genre IDs, never localized names (see module header).
 */
export function classifyKind(genreIds: number[]): 'casual' | 'deep' {
  // Hazbin rule: animated comedies stay casual even with Drama/Sci-Fi
  // tags. Crime/Mystery presence opts out (dark animated crime keeps
  // the majority vote).
  if (
    genreIds.includes(GENRE_ANIMATION) &&
    genreIds.includes(GENRE_COMEDY) &&
    !genreIds.includes(GENRE_CRIME) &&
    !genreIds.includes(GENRE_MYSTERY)
  ) {
    return 'casual';
  }
  let deep = 0;
  let casual = 0;
  for (const id of genreIds) {
    if (DEEP_GENRE_IDS.has(id)) deep++;
    if (CASUAL_GENRE_IDS.has(id)) casual++;
  }
  if (deep > casual) return 'deep';
  if (casual > deep) return 'casual';
  if (genreIds.includes(GENRE_DRAMA)) return 'deep';
  if (genreIds.includes(GENRE_COMEDY)) return 'casual';
  return 'deep';
}

export type ShowType = 'series' | 'limited' | 'docuseries' | 'reality';

/**
 * Show type, v1 heuristic. TMDB has no reliable "limited series" flag,
 * so one ended season with at most 12 episodes reads as limited.
 */
export function classifyType(
  genreIds: number[],
  seasonCount: number | null,
  episodeCount: number | null,
  status: string | null,
): ShowType {
  if (genreIds.includes(GENRE_REALITY)) return 'reality';
  if (genreIds.includes(GENRE_DOCUMENTARY)) return 'docuseries';
  if (seasonCount === 1 && status === 'Ended' && episodeCount != null && episodeCount <= 12) {
    return 'limited';
  }
  return 'series';
}

/** Tone chip, v1 heuristic from the first matching genre. */
export function toneFor(genreIds: number[]): string {
  if (genreIds.includes(GENRE_COMEDY)) return 'Light';
  if (genreIds.includes(GENRE_CRIME) || genreIds.includes(GENRE_MYSTERY)) return 'Tense';
  if (genreIds.includes(GENRE_DRAMA)) return 'Serious';
  if (genreIds.includes(GENRE_DOCUMENTARY)) return 'Curious';
  if (genreIds.includes(GENRE_REALITY)) return 'Easy';
  if (genreIds.includes(GENRE_SCIFI_FANTASY)) return 'Imaginative';
  return 'Varied';
}

/** Pace chip, v1 heuristic from episode runtime. */
export function paceFor(episodeMinutes: number | null): string {
  if (episodeMinutes == null) return 'Steady';
  if (episodeMinutes < 30) return 'Brisk';
  if (episodeMinutes <= 50) return 'Steady';
  return 'Unhurried';
}

/** Serialized vs episodic, v1 heuristic from genres. */
export function structureFor(genreIds: number[]): 'serialized' | 'episodic' {
  if (
    genreIds.includes(GENRE_COMEDY) ||
    genreIds.includes(GENRE_REALITY) ||
    genreIds.includes(GENRE_ANIMATION) ||
    genreIds.includes(GENRE_TALK) ||
    genreIds.includes(GENRE_NEWS)
  ) {
    return 'episodic';
  }
  return 'serialized';
}

/**
 * Display season count: season 0 is specials and never counts as a
 * season (spec §4). Falls back to the totals field when the seasons
 * array is unavailable.
 */
export function displaySeasons(
  seasons: { season_number: number }[] | null | undefined,
  numberOfSeasons: number | null,
): number | null {
  if (seasons && seasons.length > 0) {
    const count = seasons.filter((s) => s.season_number > 0).length;
    return count > 0 ? count : numberOfSeasons;
  }
  return numberOfSeasons;
}

/**
 * Display episode count: the sum of episode counts over seasons with
 * season_number >= 1 — season 0 (specials) episodes never count.
 * Falls back to the totals field when the seasons array is unavailable
 * or carries no usable counts.
 */
export function displayEpisodes(
  seasons: { season_number: number; episode_count: number }[] | null | undefined,
  numberOfEpisodes: number | null,
): number | null {
  if (seasons && seasons.length > 0) {
    const regular = seasons.filter((s) => s.season_number > 0);
    if (regular.length > 0) {
      const sum = regular.reduce((acc, s) => acc + (s.episode_count || 0), 0);
      if (sum > 0) return sum;
    }
  }
  return numberOfEpisodes;
}

// ---------------------------------------------------------------- diversity clusters
//
// Diversity caps (settled 2026-11-15) keep a Top 10 from collapsing into
// one type of show (all cartoons, all sci-fi). Clusters are defined by
// TMDB GENRE ID — never by genre name, because names are localized per
// UI language and matching English names once starved the casual bucket
// to zero for a Hebrew-language profile (see module header).
//
// A show belongs to exactly one cluster: the FIRST matching genre ID in
// the fixed priority order below. The order is deliberate: the most
// visually/tonally distinctive clusters win (Animation before Comedy,
// so an animated comedy counts against the animation cap — the
// complaint that motivated the caps was "only cartoons").

export type ClusterKey =
  | 'animation'
  | 'comedy'
  | 'drama'
  | 'crime'
  | 'scifi'
  | 'documentary'
  | 'reality'
  | 'action'
  | 'mystery'
  | 'family'
  | 'talk'
  | 'other';

/** Fixed priority order: first matching genre ID decides the cluster. */
const CLUSTER_PRIORITY: { cluster: ClusterKey; genreIds: number[] }[] = [
  { cluster: 'animation', genreIds: [GENRE_ANIMATION] },
  { cluster: 'comedy', genreIds: [GENRE_COMEDY] },
  { cluster: 'drama', genreIds: [GENRE_DRAMA] },
  { cluster: 'crime', genreIds: [GENRE_CRIME] },
  { cluster: 'scifi', genreIds: [GENRE_SCIFI_FANTASY] },
  { cluster: 'documentary', genreIds: [GENRE_DOCUMENTARY] },
  { cluster: 'reality', genreIds: [GENRE_REALITY] },
  { cluster: 'action', genreIds: [GENRE_ACTION_ADVENTURE, GENRE_WAR_POLITICS, GENRE_WESTERN] },
  { cluster: 'mystery', genreIds: [GENRE_MYSTERY] },
  { cluster: 'family', genreIds: [GENRE_FAMILY, GENRE_KIDS] },
  { cluster: 'talk', genreIds: [GENRE_TALK, GENRE_NEWS, GENRE_SOAP] },
];

export function clusterFor(genreIds: number[]): ClusterKey {
  for (const { cluster, genreIds: ids } of CLUSTER_PRIORITY) {
    if (ids.some((id) => genreIds.includes(id))) return cluster;
  }
  return 'other';
}

/**
 * Greedy cluster-cap partition. Walks items in ranked order, accepting
 * while the item's cluster is under `cap`; over-cap items are deferred
 * (in ranked order), never dropped. The caller decides whether deferred
 * items fill remaining slots (the relevance guard: only when no
 * uncapped alternative exists — a narrow pool relaxes the cap rather
 * than padding with junk or showing a needlessly short list).
 */
export function partitionByClusterCap<T>(
  items: T[],
  clusterOf: (item: T) => ClusterKey,
  cap: number,
): { picked: T[]; deferred: T[] } {
  const counts = new Map<ClusterKey, number>();
  const picked: T[] = [];
  const deferred: T[] = [];
  for (const item of items) {
    const cluster = clusterOf(item);
    const count = counts.get(cluster) ?? 0;
    if (count < cap) {
      counts.set(cluster, count + 1);
      picked.push(item);
    } else {
      deferred.push(item);
    }
  }
  return { picked, deferred };
}

/**
 * Cap-aware selection of at most `limit` items: strict capped picks in
 * ranked order first, then deferred items in ranked order ONLY to fill
 * slots no uncapped candidate can fill (narrow-pool relaxation). Never
 * invents items; a short input stays short. Used ONLY for the rank
 * pool — the final Top 10 cap takes strict picks alone (see
 * partitionByClusterCap), so a Top 10 never exceeds the per-cluster
 * cap.
 */
export function selectCapped<T>(
  items: T[],
  clusterOf: (item: T) => ClusterKey,
  cap: number,
  limit: number,
): T[] {
  const { picked, deferred } = partitionByClusterCap(items, clusterOf, cap);
  const out = picked.slice(0, limit);
  for (const item of deferred) {
    if (out.length >= limit) break;
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------- per-language discovery
//
// The Hebrew gap (2026-11-15): no Israeli show ever reached the
// recommendations. Two causes, both in retrieval. First, the primary
// discover calls asked for the profile's languages COMBINED
// (with_original_language=he|en) sorted by global popularity — the top
// 40 results contained ZERO Hebrew shows (verified live against TMDB),
// because no Hebrew show outranks US shows on worldwide popularity.
// Second, every rated show was US/UK, so liked-show anchors pulled US
// similars. Hebrew shows never entered the pool, so they were never
// ranked, never rated, and never anchored: chicken and egg.
//
// The fix is pool-side, never ranking-side: discover runs ONCE PER
// PROFILE LANGUAGE (popularity within that language), each language
// keeps a guaranteed minimum share of the rank pool, and ranking stays
// one unified pass on merit — no per-language ranking, no final-list
// language quotas.

/** One TMDB discover call: a single language, one page, one threshold. */
export interface DiscoverPlan {
  /** Single-element for per-language calls; empty = no restriction. */
  languages: string[];
  page: number;
  minVoteCount: number;
  genreIds?: number[];
}

/**
 * Vote-count bar per discover language (TMDB counts, 2026-11-15).
 * English keeps 10: its catalog is deep and the bar only trims stubs.
 * Every other language uses 3: the Hebrew catalog has 27 shows at
 * >=10 votes but 109 at >=3 (1,146 unfiltered, mostly unvoted stubs),
 * and page 2 at >=3 is real, recognizable shows (Ramzor, Srugim,
 * Manayek, Valley of Tears). Larger non-English catalogs (es/ko/fr/de:
 * 345–1,422 shows at >=10) are unaffected in their popularity-sorted
 * head by the lower bar. 3 excludes pure stubs while admitting real
 * small-catalog shows.
 */
export function discoverMinVoteCount(language: string): number {
  return language === 'en' ? 10 : 3;
}

/**
 * Primary discover plans: one call per profile language, popularity
 * sorted WITHIN that language. Two pages per language when the profile
 * has at most two languages (the household case — Hebrew's page 2
 * holds shows the gap analysis found missing); one page per language
 * beyond that, to bound subrequest growth (a 6-language profile makes
 * 6 primary + 6 genre calls instead of 18). An empty language list
 * keeps the old combined calls (pages 1–2, threshold 10): there is no
 * language to split by, and behavior is unchanged.
 */
export function primaryDiscoverPlans(languages: string[]): DiscoverPlan[] {
  const langs = [...new Set(languages)];
  if (langs.length === 0) {
    return [
      { languages: [], page: 1, minVoteCount: 10 },
      { languages: [], page: 2, minVoteCount: 10 },
    ];
  }
  const pages = langs.length <= 2 ? 2 : 1;
  const plans: DiscoverPlan[] = [];
  for (const lang of langs) {
    for (let page = 1; page <= pages; page++) {
      plans.push({ languages: [lang], page, minVoteCount: discoverMinVoteCount(lang) });
    }
  }
  return plans;
}

/**
 * Genre-discover plans (liked-show genres): page 1 per profile
 * language, same thresholds as the primary plans. The old combined
 * call buried non-English shows exactly like the primary calls did.
 * Empty genre list (no liked shows yet) plans nothing.
 */
export function genreDiscoverPlans(languages: string[], genreIds: number[]): DiscoverPlan[] {
  if (genreIds.length === 0) return [];
  const langs = [...new Set(languages)];
  if (langs.length === 0) {
    return [{ languages: [], page: 1, minVoteCount: 10, genreIds }];
  }
  return langs.map((lang) => ({
    languages: [lang],
    page: 1,
    minVoteCount: discoverMinVoteCount(lang),
    genreIds,
  }));
}

/**
 * Per-language minimum share of a rank pool: up to 8 slots each,
 * fewer when many languages share the pool (floor(poolSize / count)),
 * never below 1. For a 30-slot pool: 2–3 languages -> 8 each,
 * 4 -> 7, 5 -> 6, 6 -> 5. Returns 0 when fewer than two languages:
 * a single-language (or unrestricted) profile needs no guarantee —
 * the hard filter already makes every candidate that language.
 */
export function languagePoolMinimum(poolSize: number, languageCount: number): number {
  if (languageCount < 2 || poolSize <= 0) return 0;
  return Math.max(1, Math.min(8, Math.floor(poolSize / languageCount)));
}

/**
 * Guarantee each profile language at least `minPerLanguage` slots in a
 * rank pool, as available. `ordered` is the full score-ordered
 * candidate list, `picked` the pool selectCapped chose from it. For
 * each under-minimum language, the highest-ranked not-yet-picked
 * candidates of that language swap in, each replacing the lowest-
 * ranked picked candidate of a language that stays at or above the
 * minimum. The result keeps score order. Best-effort by design: when
 * a language has no more candidates in `ordered`, or no surplus
 * victim exists (all minimums cannot fit the pool size), the pool is
 * left as close to the minimums as possible — never invents, never
 * drops a language below the minimum to satisfy another. Pool-only:
 * ranking and the final Top 10 caps are untouched.
 */
export function ensureLanguageMinimums<T>(
  ordered: T[],
  picked: T[],
  languageOf: (item: T) => string,
  languages: string[],
  minPerLanguage: number,
): T[] {
  const langs = [...new Set(languages)];
  if (langs.length < 2 || minPerLanguage <= 0 || picked.length === 0) return picked;
  const rankOf = new Map<T, number>();
  ordered.forEach((item, i) => rankOf.set(item, i));
  const rank = (item: T): number => rankOf.get(item) ?? Number.MAX_SAFE_INTEGER;
  const inPicked = new Set<T>(picked);
  const counts = new Map<string, number>();
  for (const item of picked) {
    const lang = languageOf(item);
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  // Swap-in candidates per language, in ranked order.
  const spares = new Map<string, T[]>();
  for (const item of ordered) {
    if (inPicked.has(item)) continue;
    const lang = languageOf(item);
    if (!langs.includes(lang)) continue;
    const list = spares.get(lang);
    if (list) list.push(item);
    else spares.set(lang, [item]);
  }
  const result = [...picked];
  for (const lang of langs) {
    let deficit = minPerLanguage - (counts.get(lang) ?? 0);
    const queue = spares.get(lang) ?? [];
    while (deficit > 0 && queue.length > 0) {
      // Victim: the lowest-ranked picked item whose language stays at
      // or above the minimum after losing it.
      let victimIdx = -1;
      let victimRank = -1;
      for (let i = 0; i < result.length; i++) {
        const item = result[i];
        if ((counts.get(languageOf(item)) ?? 0) <= minPerLanguage) continue;
        const r = rank(item);
        if (r > victimRank) {
          victimRank = r;
          victimIdx = i;
        }
      }
      if (victimIdx < 0) break;
      const victim = result[victimIdx];
      const incoming = queue.shift() as T;
      counts.set(languageOf(victim), (counts.get(languageOf(victim)) ?? 0) - 1);
      counts.set(lang, (counts.get(lang) ?? 0) + 1);
      result[victimIdx] = incoming;
      deficit--;
    }
  }
  return result.sort((a, b) => rank(a) - rank(b));
}

// ---------------------------------------------------------------- taste sections
//
// The living taste summary is split into three sections (settled
// 2026-11-15): Shared (applies to both lists), Casual (casual watching
// only), Deep focus (deep-focus watching only). Free-text notes are
// routed into sections by the consolidation LLM; rating-derived
// statements always land in Shared; anything ambiguous defaults to
// Shared. Contradictions are scoped: only same-section conflicts flag.
//
// STORAGE: taste_summaries.summary_text holds either legacy plain text
// (read as Shared-only — lossless, no migration needed, existing rows
// are never rewritten) or a versioned JSON object
// {"v":1,"shared":"...","casual":"...","deep":"..."}. Serialization
// writes plain text whenever only Shared is non-empty, so the legacy
// shape survives until a profile actually has sectioned content.

export type TasteSectionKey = 'shared' | 'casual' | 'deep';

export interface TasteSections {
  shared: string;
  casual: string;
  deep: string;
}

export const EMPTY_TASTE_SECTIONS: TasteSections = { shared: '', casual: '', deep: '' };

const TASTE_SUMMARY_VERSION = 1;

export function isTasteSectionKey(value: unknown): value is TasteSectionKey {
  return value === 'shared' || value === 'casual' || value === 'deep';
}

/** Parse stored summary text into sections; legacy plain text = Shared. */
export function parseTasteSummary(text: string | null | undefined): TasteSections {
  if (!text || !text.trim()) return { ...EMPTY_TASTE_SECTIONS };
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as {
        v?: unknown;
        shared?: unknown;
        casual?: unknown;
        deep?: unknown;
      };
      if (parsed && parsed.v === TASTE_SUMMARY_VERSION) {
        return {
          shared: typeof parsed.shared === 'string' ? parsed.shared : '',
          casual: typeof parsed.casual === 'string' ? parsed.casual : '',
          deep: typeof parsed.deep === 'string' ? parsed.deep : '',
        };
      }
    } catch {
      // Not JSON — fall through to legacy plain-text handling.
    }
  }
  return { shared: trimmed, casual: '', deep: '' };
}

/** Serialize sections for storage: plain text when only Shared is set. */
export function serializeTasteSummary(sections: TasteSections): string {
  const shared = sections.shared.trim();
  const casual = sections.casual.trim();
  const deep = sections.deep.trim();
  if (!casual && !deep) return shared;
  return JSON.stringify({ v: TASTE_SUMMARY_VERSION, shared, casual, deep });
}

// ---------------------------------------------------------------- derived hard exclusions

/**
 * Hard exclusions derived from the profile's own preferences at
 * consolidation time (2026-11-17): categorical, category-level
 * rejections ("never reality", "nothing before 2000") become hard
 * retrieval filters. Only dimensions with a fixed, validatable form
 * and retrieval-time data are hard: TMDB TV genre ids (from the fixed
 * list above) and a first-air year range. Anything else (horror has
 * no TV genre; seasons/runtime/status need detail fetches) stays a
 * soft signal in the taste text and the rank prompt.
 */
export interface HardExcludes {
  /** TMDB TV genre ids to exclude; a show matching ANY is excluded. */
  genres: number[];
  /** Exclude shows first aired before this year (null = no floor). */
  minYear: number | null;
  /** Exclude shows first aired after this year (null = no ceiling). */
  maxYear: number | null;
}

export const EMPTY_HARD_EXCLUDES: HardExcludes = { genres: [], minYear: null, maxYear: null };

const MIN_SANE_YEAR = 1900;

function saneYear(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  const maxSane = new Date().getUTCFullYear() + 1;
  if (value < MIN_SANE_YEAR || value > maxSane) return null;
  return value;
}

/**
 * Validate a model- (or stored-) supplied hard-exclusion object.
 * Unknown genre ids are DROPPED (the fixed list is the only authority
 * — a hallucinated id must never filter anything); out-of-range or
 * non-integer years are dropped; an inverted range drops both years.
 * Never throws; malformed input yields empty exclusions.
 */
export function validateHardExcludes(raw: unknown): HardExcludes {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY_HARD_EXCLUDES };
  const rec = raw as { genres?: unknown; minYear?: unknown; maxYear?: unknown };
  const genres: number[] = [];
  if (Array.isArray(rec.genres)) {
    const seen = new Set<number>();
    for (const g of rec.genres) {
      if (typeof g === 'number' && Number.isInteger(g) && TMDB_TV_GENRE_IDS.has(g) && !seen.has(g)) {
        seen.add(g);
        genres.push(g);
      }
    }
    genres.sort((a, b) => a - b);
  }
  let minYear = saneYear(rec.minYear);
  let maxYear = saneYear(rec.maxYear);
  if (minYear !== null && maxYear !== null && minYear > maxYear) {
    minYear = null;
    maxYear = null;
  }
  return { genres, minYear, maxYear };
}

export function hasHardExcludes(ex: HardExcludes): boolean {
  return ex.genres.length > 0 || ex.minYear !== null || ex.maxYear !== null;
}

/** A stored taste record: sections + derived hard exclusions. */
export interface TasteRecord {
  sections: TasteSections;
  hardExcludes: HardExcludes;
}

/**
 * Parse a stored summary into the full record. The v1 JSON shape
 * carries an optional `hardExcludes` key (validated); legacy plain
 * text and JSON without the key read as empty exclusions, so old
 * rows keep working unchanged.
 */
export function parseTasteRecord(text: string | null | undefined): TasteRecord {
  const sections = parseTasteSummary(text);
  if (!text || !text.trim()) return { sections, hardExcludes: { ...EMPTY_HARD_EXCLUDES } };
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { v?: unknown; hardExcludes?: unknown };
      if (parsed && parsed.v === TASTE_SUMMARY_VERSION) {
        return { sections, hardExcludes: validateHardExcludes(parsed.hardExcludes) };
      }
    } catch {
      // Not JSON — legacy plain text, empty exclusions.
    }
  }
  return { sections, hardExcludes: { ...EMPTY_HARD_EXCLUDES } };
}

/**
 * Serialize a record. Plain text only when Shared-only AND no
 * exclusions (preserves the historical shape); otherwise JSON, with
 * the `hardExcludes` key present only when non-empty.
 */
export function serializeTasteRecord(record: TasteRecord): string {
  const { sections, hardExcludes } = record;
  const shared = sections.shared.trim();
  const casual = sections.casual.trim();
  const deep = sections.deep.trim();
  if (!casual && !deep && !hasHardExcludes(hardExcludes)) return shared;
  const out: Record<string, unknown> = { v: TASTE_SUMMARY_VERSION, shared, casual, deep };
  if (hasHardExcludes(hardExcludes)) out.hardExcludes = hardExcludes;
  return JSON.stringify(out);
}

/**
 * Retrieval-time hard-exclusion check. A show is excluded when ANY of
 * its genre ids is excluded, or its first-air year falls outside the
 * year range. Unknown/missing years fail OPEN (never exclude on
 * missing data — the same rule as unknown durations elsewhere).
 */
export function passesHardExcludes(
  candidate: { genreIds: number[]; firstAirDate: string },
  excludes: HardExcludes,
): boolean {
  if (!hasHardExcludes(excludes)) return true;
  if (excludes.genres.length > 0) {
    const blocked = new Set(excludes.genres);
    if (candidate.genreIds.some((id) => blocked.has(id))) return false;
  }
  if (excludes.minYear !== null || excludes.maxYear !== null) {
    const year = Number(candidate.firstAirDate.slice(0, 4));
    if (Number.isInteger(year) && year > 0) {
      if (excludes.minYear !== null && year < excludes.minYear) return false;
      if (excludes.maxYear !== null && year > excludes.maxYear) return false;
    }
  }
  return true;
}

/** Taste text for one list kind: Shared + that kind's section. */
export function tasteTextForKind(sections: TasteSections, kind: 'casual' | 'deep'): string {
  return [sections.shared.trim(), sections[kind].trim()].filter(Boolean).join('\n');
}

/** All sections joined: retrieval embedding text + legacy display text. */
export function combineTasteSections(sections: TasteSections): string {
  return [sections.shared, sections.casual, sections.deep]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n');
}

/** Labeled sections for the consolidation prompt's "current summary". */
export function formatSectionsForPrompt(sections: TasteSections): string {
  const lines: string[] = [];
  if (sections.shared.trim()) lines.push(`[Shared] ${sections.shared.trim()}`);
  if (sections.casual.trim()) lines.push(`[Casual] ${sections.casual.trim()}`);
  if (sections.deep.trim()) lines.push(`[Deep focus] ${sections.deep.trim()}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- LLM output parsing

export interface RankedEntry {
  tmdbId: number;
  rationale: string;
  risk: string | null;
}

export interface RankResponse {
  ranked: RankedEntry[];
  shortReason: string | null;
}

/**
 * Parse the LLM re-rank response. Extracts the first JSON object, keeps
 * only ids that were actually offered (the model must never invent
 * shows), dedupes preserving order. Returns null when nothing parses.
 */
export function parseRankResponse(text: string, validIds: Set<number>): RankResponse | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = (parsed as { ranked?: unknown; shortReason?: unknown }).ranked;
  if (!Array.isArray(raw)) return null;
  const seen = new Set<number>();
  const ranked: RankedEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as { tmdbId?: unknown; rationale?: unknown; risk?: unknown };
    const tmdbId = typeof rec.tmdbId === 'number' ? rec.tmdbId : Number(rec.tmdbId);
    if (!Number.isInteger(tmdbId) || !validIds.has(tmdbId) || seen.has(tmdbId)) continue;
    seen.add(tmdbId);
    ranked.push({
      tmdbId,
      rationale: typeof rec.rationale === 'string' && rec.rationale.trim() ? rec.rationale.trim() : '',
      risk: typeof rec.risk === 'string' && rec.risk.trim() ? rec.risk.trim() : null,
    });
  }
  if (ranked.length === 0) return null;
  const shortRaw = (parsed as { shortReason?: unknown }).shortReason;
  return {
    ranked,
    shortReason: typeof shortRaw === 'string' && shortRaw.trim() ? shortRaw.trim() : null,
  };
}

export interface Contradiction {
  /** The section the conflict lives in; cross-section pairs never flag. */
  scope: TasteSectionKey;
  oldText: string;
  newText: string;
  proposedMerge: string;
}

/**
 * Parse the LLM removal-only check response (layered negative feedback,
 * final layer). Extracts the first JSON object and keeps only ids that
 * were actually in the checked set — the check can only REMOVE checked
 * shows, never add, reorder, or invent. Returns [] on any parse failure
 * (fail-open: the other negative layers still apply).
 */
export function parseRemovalCheckResponse(text: string, validIds: Set<number>): number[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const raw = (parsed as { removeIds?: unknown }).removeIds;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const removed: number[] = [];
  for (const item of raw) {
    const id = typeof item === 'number' ? item : Number(item);
    if (!Number.isInteger(id) || !validIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    removed.push(id);
  }
  return removed;
}

export interface ConsolidationResult {
  /** Combined text (all sections joined) — backward-compatible display. */
  summary: string;
  sections: TasteSections;
  contradictions: Contradiction[];
  languageConflict: { languageCode: string; languageName: string } | null;
  /** Derived hard exclusions, validated against the fixed lists. */
  hardExcludes: HardExcludes;
}

function sectionsFromConsolidationJson(parsed: {
  summary?: unknown;
  sections?: unknown;
}): TasteSections | null {
  const raw = parsed.summary ?? parsed.sections;
  // No summary key at all: not the JSON contract — the caller falls
  // back to plain-text handling. A summary key that IS present is
  // honored even when empty: an all-empty sections object means "no
  // taste statements", never "treat the raw JSON as the summary".
  if (raw === undefined) return null;
  if (typeof raw === 'string') {
    return raw.trim() ? { shared: raw.trim(), casual: '', deep: '' } : { ...EMPTY_TASTE_SECTIONS };
  }
  if (raw && typeof raw === 'object') {
    const rec = raw as { shared?: unknown; casual?: unknown; deep?: unknown };
    return {
      shared: typeof rec.shared === 'string' ? rec.shared.trim() : '',
      casual: typeof rec.casual === 'string' ? rec.casual.trim() : '',
      deep: typeof rec.deep === 'string' ? rec.deep.trim() : '',
    };
  }
  return null;
}

/**
 * Parse the consolidation response. Accepts the JSON contract
 * {summary: {shared, casual, deep} | string, contradictions, languageConflict, hardExcludes};
 * falls back to treating the whole output as a Shared-only summary when
 * it is plain text (no JSON object with a summary key). An all-empty
 * sections object is honored as empty — the raw JSON is never stored
 * as summary text. Contradictions without a valid scope default to
 * Shared (the pre-section contract). hardExcludes is validated
 * against the fixed lists; invalid entries are dropped, never stored.
 */
export function parseConsolidationResponse(text: string): ConsolidationResult {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as {
        summary?: unknown;
        sections?: unknown;
        contradictions?: unknown;
        languageConflict?: unknown;
        hardExcludes?: unknown;
      };
      const sections = sectionsFromConsolidationJson(parsed);
      if (sections) {
        const contradictions: Contradiction[] = [];
        if (Array.isArray(parsed.contradictions)) {
          for (const c of parsed.contradictions) {
            if (!c || typeof c !== 'object') continue;
            const rec = c as {
              scope?: unknown;
              oldText?: unknown;
              newText?: unknown;
              proposedMerge?: unknown;
            };
            if (
              typeof rec.oldText === 'string' &&
              typeof rec.newText === 'string' &&
              typeof rec.proposedMerge === 'string'
            ) {
              contradictions.push({
                scope: isTasteSectionKey(rec.scope) ? rec.scope : 'shared',
                oldText: rec.oldText,
                newText: rec.newText,
                proposedMerge: rec.proposedMerge,
              });
            }
          }
        }
        let languageConflict: ConsolidationResult['languageConflict'] = null;
        const lc = parsed.languageConflict as { languageCode?: unknown; languageName?: unknown } | null;
        if (lc && typeof lc.languageCode === 'string' && typeof lc.languageName === 'string') {
          languageConflict = { languageCode: lc.languageCode, languageName: lc.languageName };
        }
        return {
          summary: combineTasteSections(sections),
          sections,
          contradictions,
          languageConflict,
          hardExcludes: validateHardExcludes(parsed.hardExcludes),
        };
      }
    } catch {
      // Fall through to plain-text handling.
    }
  }
  return {
    summary: trimmed,
    sections: { shared: trimmed, casual: '', deep: '' },
    contradictions: [],
    languageConflict: null,
    hardExcludes: { ...EMPTY_HARD_EXCLUDES },
  };
}

// ---------------------------------------------------------------- language-conflict heuristic

const LANGUAGE_KEYWORDS: Record<string, { en: string; he: string; words: string[] }> = {
  // Stems, not full forms: Hebrew plurals (קוריאניות) and English
  // variants must match too.
  he: { en: 'Hebrew', he: 'עברית', words: ['hebrew', 'עברי'] },
  en: { en: 'English', he: 'אנגלית', words: ['english', 'אנגל'] },
  es: { en: 'Spanish', he: 'ספרדית', words: ['spanish', 'ספרדי'] },
  ko: { en: 'Korean', he: 'קוריאנית', words: ['korean', 'קוריאני'] },
  fr: { en: 'French', he: 'צרפתית', words: ['french', 'צרפתי'] },
  de: { en: 'German', he: 'גרמנית', words: ['german', 'גרמני'] },
};

const POSITIVE_WORDS = [
  'love', 'loved', 'like', 'liked', 'enjoy', 'great', 'adore', 'prefer', 'fan', 'more',
  'אוהב', 'אוהבת', 'אוהבים', 'אוהבות', 'אהבתי', 'אהבנו', 'אהבה', 'נהנה', 'נהנית', 'מעולה', 'נהדר',
];

/**
 * Keyword heuristic: a note that mentions a language with a positive
 * word while that language is outside the hard filter. Deterministic
 * and cheap; false positives are possible ("I don't like Spanish
 * shows" still mentions Spanish + like), so the UI presents it as a
 * suggestion, never an auto-change. Returns the first conflict found.
 */
export function detectLanguageConflict(
  noteTexts: string[],
  allowedLanguages: string[],
): { languageCode: string; languageName: string } | null {
  for (const text of noteTexts) {
    const lower = text.toLowerCase();
    const hasPositive = POSITIVE_WORDS.some((w) => lower.includes(w.toLowerCase()));
    if (!hasPositive) continue;
    for (const [code, info] of Object.entries(LANGUAGE_KEYWORDS)) {
      if (allowedLanguages.includes(code)) continue;
      if (info.words.some((w) => lower.includes(w.toLowerCase()))) {
        return { languageCode: code, languageName: info.en };
      }
    }
  }
  return null;
}
