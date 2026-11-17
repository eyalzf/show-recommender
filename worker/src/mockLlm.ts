import type { LlmProvider, LlmRequest } from './llm';
import {
  CATEGORICAL_MARKERS,
  COUNTRY_GROUNDING_CUES,
  GENRE_GROUNDING_CUES,
  LIKING_MARKERS,
  MILD_MARKERS,
  TMDB_TV_GENRES,
  validateRules,
  type PreferenceRule,
} from './util';

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

// Mock rule extraction — SIMULATION ONLY, same caveat as routeNote:
// the production model extracts by meaning; the mock can only match
// a modal marker + a cue word in the same NOTE line (ratings never
// count — a rating of one show is not a category statement). Values
// resolve through the FIXED lists, so the mock can never emit a
// value the server would reject — and the server validates anyway.
// The mock shares the single rule-extraction vocabulary (util.ts):
// marker lists AND cue tables are imported, never copied — mock
// extraction, the prompts, and grounding cannot drift apart. The
// ONE deliberate difference: EXCLUSION_MARKERS excludes the quantity
// words 'nothing'/'none', because "nothing but comedies" is an
// inclusion and the year regexes below handle those phrasings
// directly.
const EXCLUSION_MARKERS = CATEGORICAL_MARKERS.filter((m) => m !== 'nothing' && m !== 'none');
const LIKE_MARKERS = LIKING_MARKERS;
const NEGATED_PREFER_MARKERS = MILD_MARKERS;

/** Extract preference rules from note statements. Exported for selftest. */
export function extractMockRules(notes: string[]): PreferenceRule[] {
  const genreIdByName = new Map(TMDB_TV_GENRES.map((g) => [g.name, g.id]));
  const draft: Array<{ dimension: string; operator: string; value: number | string; mode: string }> = [];
  const push = (
    dimension: string,
    operator: string,
    value: number | string,
    mode: 'hard' | 'soft',
  ) => draft.push({ dimension, operator, value, mode });
  for (const statement of notes) {
    const lower = statement.toLowerCase();
    const has = (markers: ReadonlyArray<string>) => markers.some((m) => lower.includes(m.toLowerCase()));
    const categorical = has(EXCLUSION_MARKERS);
    const negatedPrefer = has(NEGATED_PREFER_MARKERS);
    const liking = has(LIKE_MARKERS);
    // Genre + country: categorical -> hard isNot; negated prefer ->
    // soft isNot; liking -> soft is. Categorical wins over liking
    // ("don't like" contains "like"; "לא אוהב" contains "אוהב").
    // EXCEPTION: an inclusion modal ("only", "must", "רק", "חייב")
    // right before the cue word means is/HARD ("only comedies"),
    // unless a negation sits between the modal and the cue
    // ("must avoid comedies" stays an exclusion) — and a post-cue
    // inclusion ("comedies only", "דרמה בלבד") means the same.
    const inclusionBefore = (idx: number) => {
      // The LAST inclusion modal before the cue decides: the segment
      // between it and the cue must be short and negation-free
      // ("only comedies" includes; "must avoid comedies" and
      // "only comedies, never drama" for the drama cue exclude).
      const before = lower.slice(0, idx);
      let lastEnd = -1;
      for (const m of before.matchAll(/\bonly\b|\bmust\b|has to|have to|חייב|רק/g)) {
        lastEnd = (m.index ?? 0) + m[0].length;
      }
      if (lastEnd === -1) return false;
      const segment = before.slice(lastEnd);
      return segment.length <= 20 && !/\bnever\b|\bno\b|\bnot\b|avoid|dislike|hate|לא|בלי/.test(segment);
    };
    const inclusionAfter = (idx: number) => {
      // The cue is a substring match (stems), so skip to the end of
      // the WORD containing the cue, then look for an inclusion modal
      // in the same clause ("comedies only", "דרמה בלבד", "דרמה
      // ישראלית בלבד" — the modal scopes over the whole phrase). A
      // clause boundary before the modal breaks it ("comedies, only
      // drama" says nothing inclusive about comedies — the "only"
      // belongs to drama).
      let end = idx;
      while (end < lower.length && !/[\s,.;:!?]/.test(lower[end])) end++;
      const tail = lower.slice(end, end + 24);
      const boundary = tail.search(/[,.;:!?]/);
      const segment = boundary === -1 ? tail : tail.slice(0, boundary);
      return segment.includes('בלבד') || /\bonly\b/.test(segment);
    };
    const genreMode: 'hard' | 'soft' | null = categorical
      ? 'hard'
      : negatedPrefer || liking
        ? 'soft'
        : null;
    if (genreMode || lower.includes('only') || lower.includes('רק') || lower.includes('must') || lower.includes('חייב')) {
      const operator = categorical || negatedPrefer ? 'isNot' : 'is';
      for (const cue of GENRE_GROUNDING_CUES) {
        const id = genreIdByName.get(cue.name);
        if (id === undefined) continue;
        for (const w of cue.words) {
          const idx = lower.indexOf(w.toLowerCase());
          if (idx === -1) continue;
          if (inclusionBefore(idx) || inclusionAfter(idx)) push('genre', 'is', id, 'hard');
          else if (genreMode) push('genre', operator, id, genreMode);
          break;
        }
      }
      for (const cue of COUNTRY_GROUNDING_CUES) {
        for (const w of cue.words) {
          const idx = lower.indexOf(w.toLowerCase());
          if (idx === -1) continue;
          if (inclusionBefore(idx) || inclusionAfter(idx)) push('country', 'is', cue.code, 'hard');
          else if (genreMode) push('country', operator, cue.code, genreMode);
          break;
        }
      }
    }
    // Status: "only finished/ended" -> is Ended; "no ongoing" ->
    // isNot Returning Series + isNot In Production. Mode follows
    // the same categorical/liking rule.
    if (/only\b[^.]*\b(finished|ended|completed)\b|רק[^.]*?(שהסתיימו|גמורות)/i.test(statement)) {
      push('status', 'is', 'Ended', categorical ? 'hard' : 'soft');
    }
    if (/\bno\b[^.]*\b(ongoing|still running)\b|בלי[^.]*?(ממשיכות|עדיין)/i.test(statement)) {
      push('status', 'isNot', 'Returning Series', 'hard');
      push('status', 'isNot', 'In Production', 'hard');
    }
    // Seasons: "at least N seasons" -> gte N; "no more than N" /
    // "up to N seasons" -> lte N. Hebrew mirrors with עונות.
    const seasonsGte =
      /at least\s+(\d+)\s+seasons?|לפחות\s+(\d+)\s+עונות/i.exec(statement);
    if (seasonsGte) push('seasons', 'gte', Number(seasonsGte[1] ?? seasonsGte[2]), categorical ? 'hard' : 'soft');
    const seasonsLte =
      /(?:no more than|never more than|at most|up to)\s+(\d+)\s+seasons?|(?:לא יותר מ-?|עד)\s+(\d+)\s+עונות/i.exec(statement);
    if (seasonsLte) push('seasons', 'lte', Number(seasonsLte[1] ?? seasonsLte[2]), categorical ? 'hard' : 'soft');
    // Episode minutes: "episodes under N minutes" -> lte N;
    // "episodes over/at least N minutes" -> gte N. Hebrew mirrors.
    const minutesLte =
      /episodes?\s+(?:under|less than|at most|up to)\s+(\d+)\s+minutes?|פרקים?\s+(?:עד|פחות מ-?)\s+(\d+)\s+דקות/i.exec(statement);
    if (minutesLte) push('episodeMinutes', 'lte', Number(minutesLte[1] ?? minutesLte[2]), categorical ? 'hard' : 'soft');
    const minutesGte =
      /episodes?\s+(?:over|more than|at least)\s+(\d+)\s+minutes?|פרקים?\s+(?:מעל|לפחות)\s+(\d+)\s+דקות/i.exec(statement);
    if (minutesGte) push('episodeMinutes', 'gte', Number(minutesGte[1] ?? minutesGte[2]), categorical ? 'hard' : 'soft');
    // Year boundaries. "Before" is ambiguous on its own ("nothing
    // before 2000" wants 2000+, "only before 2000" wants pre-2000),
    // so bare "before YYYY" is SKIPPED (when in doubt, omit — the
    // production rule). Only unambiguous phrasings map:
    // nothing/no/none before YYYY -> gte YYYY (exclude older);
    // nothing/no/none after YYYY -> lte YYYY (exclude newer);
    // only ... before YYYY -> lte YYYY-1 (exclude newer);
    // after/since/from YYYY -> gte YYYY (after: YYYY+1);
    // until/up to/through YYYY -> lte YYYY. Hebrew mirrors:
    // שום דבר/כלום לפני -> gte; שום דבר/כלום אחרי -> lte;
    // רק לפני -> lte YYYY-1; מ-/משנת/החל מ- -> gte; עד -> lte.
    // Mode: categorical/only -> hard; liking/prefer -> soft; bare
    // boundary phrasing reads as a constraint -> hard.
    const yearMode: 'hard' | 'soft' = categorical || lower.includes('only') || lower.includes('רק')
      ? 'hard'
      : liking
        ? 'soft'
        : 'hard';
    const nothingBefore = /(?:nothing|none|no)\b[^.]*?\bbefore\s+(\d{4})|(?:שום דבר|כלום)\s+לפני\s+(\d{4})/i.exec(statement);
    if (nothingBefore) push('year', 'gte', Number(nothingBefore[1] ?? nothingBefore[2]), yearMode);
    const nothingAfter = /(?:nothing|none|no)\b[^.]*?\bafter\s+(\d{4})|(?:שום דבר|כלום)\s+אחרי\s+(\d{4})/i.exec(statement);
    if (nothingAfter) push('year', 'lte', Number(nothingAfter[1] ?? nothingAfter[2]), yearMode);
    const onlyBefore = /only\b[^.]*before\s+(\d{4})|רק\s+לפני\s+(\d{4})/i.exec(statement);
    if (onlyBefore) push('year', 'lte', Number(onlyBefore[1] ?? onlyBefore[2]) - 1, 'hard');
    if (!nothingAfter) {
      const after = /after\s+(\d{4})/i.exec(statement);
      if (after) push('year', 'gte', Number(after[1]) + 1, yearMode);
    }
    const sinceFrom = /(?:since|from)\s+(\d{4})/i.exec(statement);
    if (sinceFrom) push('year', 'gte', Number(sinceFrom[1]), yearMode);
    const heAfter = /(?:מ-|החל מ-?|משנת)\s*(\d{4})/.exec(statement);
    if (heAfter) push('year', 'gte', Number(heAfter[1]), yearMode);
    const until = /(?:until|up to|through)\s+(\d{4})|עד\s+(\d{4})/i.exec(statement);
    if (until) push('year', 'lte', Number(until[1] ?? until[2]), yearMode);
  }
  return validateRules(draft);
}

/**
 * Mock consolidation: echo the prompt's raw-note lines into the three
 * sections deterministically. Rating lines always land in Shared (the
 * production routing rule); free-text notes route on the same cue
 * words the real prompt lists, defaulting to Shared. The show-name
 * output ban is mirrored: a rating line's "Title: " prefix is
 * stripped (first ': ' split — the title is prompt context only),
 * and a bare-title rating line (no reason) is dropped entirely, as
 * the real model generalizes-or-drops it. No statements are
 * invented or reworded — the output is a pure function of the input
 * lines, so a mock consolidation is trivially auditable.
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
      // Title is context only: keep the reason, drop the title; a
      // bare title carries no free text and is dropped outright.
      const sep = statement.indexOf(': ');
      if (sep < 0) continue;
      sections.shared.push(statement.slice(sep + 2).trim());
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
    rules: extractMockRules(noteStatements),
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
    if (system.includes('MOOD RULE EXTRACTION')) {
      return JSON.stringify({ rules: extractMockRules([req.user]) });
    }
    return '[mock] unrecognized prompt — no mock behavior defined for this request.';
  }
}
