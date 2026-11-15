/**
 * Pure helpers for the recommendation engine. No runtime imports: this
 * module is unit-testable with plain Node (see scripts/selftest.mjs).
 *
 * Classification (kind / type / tone / pace / structure) is heuristic v1
 * from TMDB genre names + runtime + season counts. The heuristics are
 * deliberately simple and documented here; tune them from real usage,
 * not from speculation.
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

const CASUAL_GENRES = new Set(['Comedy', 'Reality', 'Animation', 'Family', 'Kids', 'Talk', 'News', 'Soap']);
const DEEP_GENRES = new Set([
  'Drama',
  'Crime',
  'Mystery',
  'Sci-Fi & Fantasy',
  'War & Politics',
  'Documentary',
  'Western',
  'Action & Adventure',
]);

/**
 * Casual vs deep-focus, v1 heuristic: genre majority wins; ties break
 * toward deep when Drama is present, toward casual when Comedy is
 * present, else deep. The LLM re-rank judges kind-fit afterwards, so a
 * misclassified show drops in its list rather than vanishing.
 */
export function classifyKind(genreNames: string[]): 'casual' | 'deep' {
  let deep = 0;
  let casual = 0;
  for (const g of genreNames) {
    if (DEEP_GENRES.has(g)) deep++;
    if (CASUAL_GENRES.has(g)) casual++;
  }
  if (deep > casual) return 'deep';
  if (casual > deep) return 'casual';
  if (genreNames.includes('Drama')) return 'deep';
  if (genreNames.includes('Comedy')) return 'casual';
  return 'deep';
}

export type ShowType = 'series' | 'limited' | 'docuseries' | 'reality';

/**
 * Show type, v1 heuristic. TMDB has no reliable "limited series" flag,
 * so one ended season with at most 12 episodes reads as limited.
 */
export function classifyType(
  genreNames: string[],
  seasonCount: number | null,
  episodeCount: number | null,
  status: string | null,
): ShowType {
  if (genreNames.includes('Reality')) return 'reality';
  if (genreNames.includes('Documentary')) return 'docuseries';
  if (seasonCount === 1 && status === 'Ended' && episodeCount != null && episodeCount <= 12) {
    return 'limited';
  }
  return 'series';
}

/** Tone chip, v1 heuristic from the first matching genre. */
export function toneFor(genreNames: string[]): string {
  if (genreNames.includes('Comedy')) return 'Light';
  if (genreNames.includes('Crime') || genreNames.includes('Mystery')) return 'Tense';
  if (genreNames.includes('Drama')) return 'Serious';
  if (genreNames.includes('Documentary')) return 'Curious';
  if (genreNames.includes('Reality')) return 'Easy';
  if (genreNames.includes('Sci-Fi & Fantasy')) return 'Imaginative';
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
export function structureFor(genreNames: string[]): 'serialized' | 'episodic' {
  if (
    genreNames.includes('Comedy') ||
    genreNames.includes('Reality') ||
    genreNames.includes('Animation') ||
    genreNames.includes('Talk') ||
    genreNames.includes('News')
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
  oldText: string;
  newText: string;
  proposedMerge: string;
}

export interface ConsolidationResult {
  summary: string;
  contradictions: Contradiction[];
  languageConflict: { languageCode: string; languageName: string } | null;
}

/**
 * Parse the consolidation response. Accepts the JSON contract
 * {summary, contradictions, languageConflict}; falls back to treating
 * the whole output as the summary when it is plain text.
 */
export function parseConsolidationResponse(text: string): ConsolidationResult {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as {
        summary?: unknown;
        contradictions?: unknown;
        languageConflict?: unknown;
      };
      if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
        const contradictions: Contradiction[] = [];
        if (Array.isArray(parsed.contradictions)) {
          for (const c of parsed.contradictions) {
            if (!c || typeof c !== 'object') continue;
            const rec = c as { oldText?: unknown; newText?: unknown; proposedMerge?: unknown };
            if (
              typeof rec.oldText === 'string' &&
              typeof rec.newText === 'string' &&
              typeof rec.proposedMerge === 'string'
            ) {
              contradictions.push({
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
        return { summary: parsed.summary.trim(), contradictions, languageConflict };
      }
    } catch {
      // Fall through to plain-text handling.
    }
  }
  return { summary: trimmed, contradictions: [], languageConflict: null };
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
