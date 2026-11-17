import type { LlmProvider, LlmRequest } from './llm';
import { TMDB_TV_GENRES, validateHardExcludes, type HardExcludes } from './util';

/**
 * Deterministic mock LLM provider + mock embeddings — the quota-free
 * development path.
 *
 * Enabled ONLY by the explicit env flag LLM_PROVIDER=mock (dev Worker
 * bindings, or a local run) — see llm.resolveLlmMode. There is no
 * per-request override path. The mock never calls Workers AI, so a
 * verification session against the mock costs ZERO neurons. The
 * default, with no flag, is always the real provider.
 *
 * Determinism is load-bearing: the same request always yields the same
 * output, so mock runs are reproducible and the dual-pass rank merge
 * (input order + reversed) converges instead of diverging. Ranking
 * order is a hash of (taste text + candidate id), never input order.
 *
 * TERMS GUARDRAIL (same as llm.ts): the mock only ever echoes text the
 * caller already put in the prompt — user-authored notes and
 * titles/IDs + factual labels. Mock fixtures contain NO TMDB
 * overviews/descriptions, and the mock invents none: rationales cite
 * the anchor/genre/year from the candidate line, nothing else.
 *
 * The mock is a PLUMBING double, not a quality double: it proves
 * triggers, parsing, caps, grounding, and persistence work. It proves
 * nothing about ranking quality — that still needs the one live
 * end-to-end run per deploy (see docs/dev-verification.md).
 */

// ---------------------------------------------------------------- hashing

/** FNV-1a 32-bit hash — small, deterministic, no dependencies. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Mulberry32 PRNG: deterministic stream from a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- mock embeddings

/** Mock vector width. Smaller than BGE-M3's 1024 — cosine/MMR/calibration only need consistent width within a run. */
export const MOCK_EMBEDDING_DIM = 64;

/**
 * Deterministic pseudo-vector for a text: hash-seeded uniform values,
 * L2-normalized. Identical texts map to identical vectors (cosine 1);
 * distinct texts map to near-orthogonal vectors, so similarity,
 * novelty, and near-duplicate logic all exercise without real
 * embeddings. Empty text maps to the zero vector (cosine 0).
 */
export function mockEmbedText(text: string): number[] {
  if (!text) return new Array<number>(MOCK_EMBEDDING_DIM).fill(0);
  const rand = mulberry32(fnv1a(text));
  const vec: number[] = [];
  let normSq = 0;
  for (let i = 0; i < MOCK_EMBEDDING_DIM; i++) {
    const v = rand() * 2 - 1;
    vec.push(v);
    normSq += v * v;
  }
  const norm = Math.sqrt(normSq) || 1;
  return vec.map((v) => v / norm);
}

export function mockEmbedTexts(texts: string[]): number[][] {
  return texts.map(mockEmbedText);
}

// ---------------------------------------------------------------- mock chat

// Keyword routing for mock consolidation — SIMULATION ONLY. The
// production model routes by meaning; the mock can only match cue
// words, so these lists exist to make dev-environment notes land in
// the sections a Hebrew/English speaker would expect. Keep them
// tight: a cue must clearly signal the mode on its own, because a
// false match mis-routes the whole statement. Ambiguous notes still
// default to Shared (routeNote below), exactly like production's
// when-in-doubt rule. Ratings never reach this router — they always
// land in Shared.
const CASUAL_CUES = [
  'casual', 'light', 'tired', 'background', 'easy', 'dip into', 'short',
  'funny', 'comed', 'sitcom',
  'קליל', 'עייפ', 'ברקע', 'פשוט', 'קל ', 'כשבא לי משהו קל',
  'קצר', 'קומי', 'קומדיה', 'מצחיק', 'כיף', 'סיטקום',
];
const DEEP_CUES = [
  'deep', 'concentrat', 'immersive', 'attention', 'complex', 'slow burn',
  'serialized', 'demands attention',
  'thriller', 'suspense', 'drama', 'crime', 'mystery', 'action', 'tense',
  'מעמיק', 'ריכוז', 'להתרכז', 'סוחף', 'מורכב', 'דורש ריכוז',
  'משמעות', 'מתח', 'מותח', 'אקשן', 'דרמה', 'פשע', 'מסתור', 'רציני',
];

/** Route one free-text statement to a section. Exported for selftest. */
export function routeNote(text: string): 'shared' | 'casual' | 'deep' {
  const lower = text.toLowerCase();
  if (CASUAL_CUES.some((cue) => lower.includes(cue.toLowerCase()))) return 'casual';
  if (DEEP_CUES.some((cue) => lower.includes(cue.toLowerCase()))) return 'deep';
  return 'shared';
}

// Mock hard-exclusion extraction — SIMULATION ONLY, same caveat as
// routeNote: the production model extracts by meaning; the mock can
// only match a categorical marker + a genre cue word in the same NOTE
// line (ratings never count — a rating of one show is not a category
// rejection). Genre ids resolve through the FIXED list, so the mock
// can never emit an id the server would reject — and the server
// validates anyway. Deliberately narrow: mild wording ("prefer less")
// and unmappable categories ("horror", "musical") produce no
// exclusion, exactly like production's rules.
const EXCLUSION_MARKERS = [
  'never', "don't like", 'dont like', 'hate', "can't stand", 'cant stand',
  'avoid', 'no ', 'not a fan', 'dislike',
  'לעולם לא', 'לא אוהב', 'לא אוהבת', 'שונא', 'שונאת', 'לא סובל', 'לא סובלת', 'לא רוצה',
];

const GENRE_CUE_WORDS: Array<{ name: string; words: string[] }> = [
  { name: 'Action & Adventure', words: ['action', 'adventure', 'אקשן', 'הרפתקאות'] },
  { name: 'Animation', words: ['animation', 'animated', 'אנימציה', 'מצויר'] },
  { name: 'Comedy', words: ['comedy', 'comedies', 'sitcom', 'קומדיה', 'סיטקום'] },
  { name: 'Crime', words: ['crime', 'פשע'] },
  { name: 'Documentary', words: ['documentary', 'documentaries', 'דוקו'] },
  { name: 'Drama', words: ['drama', 'דרמה'] },
  { name: 'Family', words: ['family', 'משפחה'] },
  { name: 'Kids', words: ['kids', "children's", 'children', 'ילדים'] },
  { name: 'Mystery', words: ['mystery', 'מסתורין'] },
  { name: 'News', words: ['news', 'חדשות'] },
  { name: 'Reality', words: ['reality', 'ריאליטי', 'ריאלטי'] },
  { name: 'Sci-Fi & Fantasy', words: ['sci-fi', 'science fiction', 'fantasy', 'מדע בדיוני', 'פנטזיה'] },
  { name: 'Soap', words: ['soap', 'טלנובלה', 'סבון'] },
  { name: 'Talk', words: ['talk show', 'talkshow', 'אירוח'] },
  { name: 'War & Politics', words: ['war shows', 'politics', 'מלחמה', 'פוליטיקה'] },
  { name: 'Western', words: ['western', 'מערבון'] },
];

/** Extract hard exclusions from note statements. Exported for selftest. */
export function extractMockHardExcludes(notes: string[]): HardExcludes {
  const genreIdByName = new Map(TMDB_TV_GENRES.map((g) => [g.name, g.id]));
  const genres = new Set<number>();
  let minYear: number | null = null;
  let maxYear: number | null = null;
  for (const statement of notes) {
    const lower = statement.toLowerCase();
    if (EXCLUSION_MARKERS.some((m) => lower.includes(m.toLowerCase()))) {
      for (const cue of GENRE_CUE_WORDS) {
        if (cue.words.some((w) => lower.includes(w.toLowerCase()))) {
          const id = genreIdByName.get(cue.name);
          if (id !== undefined) genres.add(id);
        }
      }
    }
    // Year boundaries. "Before" is ambiguous on its own ("nothing
    // before 2000" wants 2000+, "only before 2000" wants pre-2000),
    // so bare "before YYYY" is SKIPPED (when in doubt, omit — the
    // production rule). Only unambiguous phrasings map:
    // nothing/no/none before YYYY -> minYear YYYY (exclude older);
    // nothing/no/none after YYYY -> maxYear YYYY (exclude newer);
    // only ... before YYYY -> maxYear YYYY-1 (exclude newer);
    // after/since/from YYYY -> minYear YYYY (after: YYYY+1);
    // until/up to/through YYYY -> maxYear YYYY. Hebrew mirrors:
    // שום דבר/כלום לפני -> minYear; שום דבר/כלום אחרי -> maxYear;
    // רק לפני -> maxYear-1; מ-/משנת/החל מ- -> minYear; עד -> maxYear.
    const nothingBefore = /(?:nothing|none|no)\b[^.]*?\bbefore\s+(\d{4})|(?:שום דבר|כלום)\s+לפני\s+(\d{4})/i.exec(statement);
    if (nothingBefore) minYear = Number(nothingBefore[1] ?? nothingBefore[2]);
    const nothingAfter = /(?:nothing|none|no)\b[^.]*?\bafter\s+(\d{4})|(?:שום דבר|כלום)\s+אחרי\s+(\d{4})/i.exec(statement);
    if (nothingAfter) maxYear = Number(nothingAfter[1] ?? nothingAfter[2]);
    const onlyBefore = /only\b[^.]*before\s+(\d{4})|רק\s+לפני\s+(\d{4})/i.exec(statement);
    if (onlyBefore) maxYear = Number(onlyBefore[1] ?? onlyBefore[2]) - 1;
    if (!nothingAfter) {
      const after = /after\s+(\d{4})/i.exec(statement);
      if (after) minYear = Number(after[1]) + 1;
    }
    const sinceFrom = /(?:since|from)\s+(\d{4})/i.exec(statement);
    if (sinceFrom) minYear = Number(sinceFrom[1]);
    const heAfter = /(?:מ-|החל מ-?|משנת)\s*(\d{4})/.exec(statement);
    if (heAfter) minYear = Number(heAfter[1]);
    const until = /(?:until|up to|through)\s+(\d{4})|עד\s+(\d{4})/i.exec(statement);
    if (until) maxYear = Number(until[1] ?? until[2]);
  }
  return validateHardExcludes({ genres: [...genres], minYear, maxYear });
}

/**
 * Mock consolidation: echo the prompt's raw-note lines into the three
 * sections deterministically. Rating lines always land in Shared (the
 * production routing rule); free-text notes route on the same cue
 * words the real prompt lists, defaulting to Shared. No statements are
 * invented, dropped, or reworded — the output is a pure function of
 * the input lines, so a mock consolidation is trivially auditable.
 */
function mockConsolidation(userText: string): string {
  const rawMarker = userText.indexOf('Raw notes');
  const notesPart = rawMarker >= 0 ? userText.slice(rawMarker) : userText;
  const sections: Record<'shared' | 'casual' | 'deep', string[]> = {
    shared: [],
    casual: [],
    deep: [],
  };
  const noteStatements: string[] = [];
  for (const line of notesPart.split('\n')) {
    const match = /^-\s*\[(note|rating:[^\]]+)\]\s*(.+)$/.exec(line.trim());
    if (!match) continue;
    const label = match[1];
    const statement = match[2].trim();
    if (!statement) continue;
    if (label.startsWith('rating:')) {
      sections.shared.push(statement);
    } else {
      sections[routeNote(statement)].push(statement);
      noteStatements.push(statement);
    }
  }
  return JSON.stringify({
    summary: {
      shared: sections.shared.join('; '),
      casual: sections.casual.join('; '),
      deep: sections.deep.join('; '),
    },
    contradictions: [],
    languageConflict: null,
    hardExcludes: extractMockHardExcludes(noteStatements),
  });
}

interface MockCandidate {
  tmdbId: number;
  title: string;
  year: string;
  genres: string;
  anchor?: string;
}

const CANDIDATE_LINE =
  /^-\s*id\s+(\d+):\s*"([^"]*)"\s*\(([^)]*)\)\s*\[([^\]]*)\]\s*lang=\S+(?:\s+country=\S+)?(?:\s+anchor="([^"]*)")?/;

/**
 * Mock ranking: parse the candidate lines, order them by a hash of
 * (taste text + id) so the order is independent of input order (the
 * two hygiene passes — forward and reversed — then agree), and return
 * at most 10 with rationales that cite the anchor show + genres/year
 * from the candidate line itself. Nothing is invented.
 */
function mockRank(systemText: string, userText: string): string {
  const tasteText = userText.split('Candidates:')[0] ?? userText;
  const candidates: MockCandidate[] = [];
  for (const line of userText.split('\n')) {
    const match = CANDIDATE_LINE.exec(line.trim());
    if (!match) continue;
    candidates.push({
      tmdbId: Number(match[1]),
      title: match[2],
      year: match[3],
      genres: match[4],
      anchor: match[5] || undefined,
    });
  }
  candidates.sort((a, b) => fnv1a(`${tasteText}|${b.tmdbId}`) - fnv1a(`${tasteText}|${a.tmdbId}`));
  const ranked = candidates.slice(0, 10).map((cand) => {
    const attrs = [cand.genres && cand.genres !== 'no genre' ? cand.genres : '', cand.year]
      .filter(Boolean)
      .join(', ');
    const rationale = cand.anchor
      ? `Mock: similar to ${cand.anchor}${attrs ? ` (${attrs})` : ''}.`
      : `Mock: matches ${attrs || cand.title}.`;
    return { tmdbId: cand.tmdbId, rationale, risk: null };
  });
  return JSON.stringify({ ranked, shortReason: null });
}

/**
 * Mock ad-hoc rationale: one deterministic sentence from the show line
 * in the prompt (title/year/genres only — never invented detail).
 */
function mockAdhoc(userText: string): string {
  const showMatch = /^Show:\s*(.+?)\s*\(([^)]*)\)\s*\[([^\]]*)\]/m.exec(userText);
  if (!showMatch) return 'Mock: a fitting pick for the request.';
  const title = showMatch[1].trim();
  const year = showMatch[2].trim();
  const genres = showMatch[3].trim();
  const firstGenre = genres && genres !== 'no genre' ? genres.split(',')[0].trim() : '';
  return `Mock: ${title}${year ? ` (${year})` : ''} fits the request${firstGenre ? ` as ${firstGenre}` : ''}.`;
}

/** The deterministic mock provider. One instance is stateless and shared. */
export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock';

  async generate(req: LlmRequest): Promise<string> {
    const system = req.system;
    // Markers mirror the prompt builders in llm.ts; if a builder's
    // wording changes, update the matching marker here.
    if (system.includes('THREE sections')) return mockConsolidation(req.user);
    if (system.includes('Rank ONLY the shows listed below')) return mockRank(system, req.user);
    if (system.includes('Return ONLY the ids of shortlisted shows')) {
      return JSON.stringify({ removeIds: [] });
    }
    if (system.includes('one-sentence rationale')) return mockAdhoc(req.user);
    return '[mock] unrecognized prompt — no mock behavior defined for this request.';
  }
}
