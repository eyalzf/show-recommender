/**
 * Deterministic re-ranking + taste-decay helpers for the recommendation
 * engine. Pure functions, no runtime imports: unit-testable with plain
 * Node (see scripts/selftest.mjs).
 *
 * These implement the industry-practice imports settled 2026-11-15
 * (engine-only batch; no UI, no flow changes):
 *
 *  1. MMR + calibration + caps (Carbonell & Goldstein 1998; Steck 2018):
 *     a greedy pass AFTER the LLM re-rank. MMR over embedding similarity
 *     (genre-Jaccard fallback when no embeddings) keeps near-duplicates
 *     apart; Steck-style calibration nudges each list's cluster mix
 *     toward the profile's liked-show cluster mix; the strict diversity
 *     caps bind inside the same pass, so the three can never fight.
 *  2. Multi-objective blend with MOSTRA's epsilon rule (Bugliarello et
 *     al., WWW 2022): candidates score on fit + novelty + freshness
 *     (per-kind weights, documented below); a lower-fit candidate may
 *     win a slot only when within EPSILON_NEAR_TIE of the best remaining
 *     fit. Household fairness is deferred — no joint lists exist yet.
 *  3. Short-term + long-term taste (half-life decay): the stored summary
 *     is the long-term profile and is NEVER decayed away; a recency-
 *     weighted short-term component (recent feedback, weight floor)
 *     blends into retrieval and the rank prompt. The half-life is a
 *     named constant; a visible per-profile setting is a later UI
 *     decision, deliberately not added here.
 *  4. Layered negative feedback (Meta "Your Algorithm" pattern): the
 *     similarity helpers here back retrieval-time near-duplicate
 *     exclusion and re-rank demotion. The deny-list feeds ONLY the
 *     exclusion layers — never taste consolidation or trust (spec build
 *     rule 14 / README rule 5, as clarified for this batch).
 *  5. Grounded rationales: every rationale must cite the anchor show
 *     and/or real TMDB attributes (genres, year); anything else falls
 *     back to a template built from real data only.
 *  6. LLM hygiene: two listwise passes (input order + reversed order)
 *     merged by mean rank, mitigating position bias while keeping
 *     listwise comparison quality (pointwise scoring would lose it).
 *
 * TERMS GUARDRAIL: nothing here touches TMDB descriptive content. All
 * inputs are user-authored text, show titles/IDs, or factual labels.
 */

import {
  clusterFor,
  cosine,
  normalizeTitle,
  type ClusterKey,
  type RankedEntry,
} from './util';

// ---------------------------------------------------------------- decay
//
// Half-life decay for taste signals (YouTube/Netflix practice, per-user
// arithmetic): weight = 0.5 ^ (ageDays / half-life). A visible half-life
// setting is a later UI decision — this constant is the single place to
// change the value until then.

/** Half-life of a taste signal, in days. 90 days per the settled batch. */
export const TASTE_HALF_LIFE_DAYS = 90;

/**
 * Minimum decay weight for the short-term component: entries older than
 * ~180 days (weight < 0.25) contribute only via the long-term summary,
 * which always carries them at full weight — long-term taste is never
 * decayed away entirely.
 */
export const SHORT_TERM_WEIGHT_FLOOR = 0.25;

/** Blend weights for the retrieval embedding: long-term + short-term. */
export const LONG_TERM_BLEND_WEIGHT = 0.65;
export const SHORT_TERM_BLEND_WEIGHT = 0.35;

/** Max short-term entries folded into the rank prompt (prompt size). */
export const SHORT_TERM_MAX_ENTRIES = 12;

export function decayWeight(createdAtMs: number, nowMs: number): number {
  const ageDays = Math.max(0, (nowMs - createdAtMs) / 86_400_000);
  return Math.pow(0.5, ageDays / TASTE_HALF_LIFE_DAYS);
}

/** Minimal feedback-row shape the short-term builder needs. */
export interface TasteLogRow {
  kind: string;
  rating: string | null;
  showTitle: string | null;
  text: string;
  createdAt: number;
}

/**
 * Short-term taste text: recent feedback (weight >= floor), newest
 * first, in the same `[rating] Title: reason` shape the rank prompt
 * already understands. Returns '' when nothing recent qualifies — the
 * caller then ranks on the long-term summary alone.
 */
export function buildShortTermTasteText(
  rows: TasteLogRow[],
  nowMs: number,
  maxEntries: number = SHORT_TERM_MAX_ENTRIES,
): string {
  const lines: string[] = [];
  const newestFirst = [...rows].sort((a, b) => b.createdAt - a.createdAt);
  for (const row of newestFirst) {
    if (lines.length >= maxEntries) break;
    if (decayWeight(row.createdAt, nowMs) < SHORT_TERM_WEIGHT_FLOOR) continue;
    if (row.kind === 'show') {
      const title = (row.showTitle ?? '').trim();
      const reason = row.text.trim();
      if (!title && !reason) continue;
      lines.push(`[${row.rating ?? 'show'}] ${title}${reason ? `: ${reason}` : ''}`);
    } else if (row.text.trim()) {
      lines.push(`[${row.rating ?? 'note'}] ${row.text.trim()}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- objectives

/** MMR trade-off: relevance weight λ ≈ 0.7 (Carbonell & Goldstein). */
export const MMR_LAMBDA = 0.7;

/**
 * MOSTRA epsilon: a lower-fit candidate may win a slot only when its
 * fit is within this of the best remaining fit. Fit is 1 - rank/n, so
 * adjacent candidates differ by 1/n (~0.033 at n=30); 0.08 admits
 * roughly two adjacent swaps — near-ties only, never a leap.
 */
export const EPSILON_NEAR_TIE = 0.08;

/**
 * Per-kind objective weights (relative, not normalized — fit dominates
 * through the epsilon gate, not through weight size). Casual weights
 * freshness higher (light watching skews newer); deep-focus weights fit
 * higher (immersion over recency). Novelty is equal: both lists should
 * stretch beyond the already-watched.
 */
export interface RerankWeights {
  fit: number;
  novelty: number;
  freshness: number;
  calibration: number;
}

export const RERANK_WEIGHTS: Record<'casual' | 'deep', RerankWeights> = {
  casual: { fit: 0.55, novelty: 0.2, freshness: 0.25, calibration: 0.15 },
  deep: { fit: 0.7, novelty: 0.2, freshness: 0.1, calibration: 0.15 },
};

/** Freshness: full score for shows up to 1 year old, then linear decay. */
export const FRESHNESS_FULL_YEARS = 1;
export const FRESHNESS_DECAY_YEARS = 14;

/**
 * Freshness score 0..1 from a first-air date (year granularity). Unknown
 * dates score neutral (0.5) — absence of data must not punish a show.
 */
export function freshnessFor(firstAirDate: string, nowMs: number): number {
  const year = Number(firstAirDate.slice(0, 4));
  if (!Number.isInteger(year) || year <= 0) return 0.5;
  const currentYear = new Date(nowMs).getUTCFullYear();
  const ageYears = currentYear - year;
  if (ageYears <= FRESHNESS_FULL_YEARS) return 1;
  return Math.max(0, 1 - (ageYears - FRESHNESS_FULL_YEARS) / FRESHNESS_DECAY_YEARS);
}

/** Fit score 0..1 from a rank position: first = 1, last = 1/n. */
export function fitFromRank(index: number, total: number): number {
  if (total <= 0) return 0;
  return 1 - index / total;
}

function jaccard(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const intersection = a.filter((x) => setB.has(x)).length;
  return intersection / (a.length + b.length - intersection);
}

/**
 * Novelty 0..1: distance from the already-liked shows. Embedding cosine
 * when vectors exist, genre-Jaccard fallback otherwise, neutral 0.5
 * when neither is available.
 */
export function noveltyFor(
  embedding: number[] | undefined,
  genreIds: number[],
  likedEmbeddings: number[][],
  likedGenreSets: number[][],
): number {
  if (embedding && likedEmbeddings.length > 0) {
    const maxSim = Math.max(...likedEmbeddings.map((v) => cosine(embedding, v)));
    return Math.min(1, Math.max(0, 1 - maxSim));
  }
  if (genreIds.length > 0 && likedGenreSets.length > 0) {
    const maxOverlap = Math.max(...likedGenreSets.map((g) => jaccard(genreIds, g)));
    return 1 - maxOverlap;
  }
  return 0.5;
}

/**
 * Steck calibration target: the cluster distribution of the profile's
 * liked shows (shares summing to 1). Empty when no liked genre data —
 * the greedy pass then applies no calibration adjustment.
 */
export function calibrationTargetFromLiked(likedGenreIdSets: number[][]): Map<ClusterKey, number> {
  const counts = new Map<ClusterKey, number>();
  for (const ids of likedGenreIdSets) {
    const cluster = clusterFor(ids);
    counts.set(cluster, (counts.get(cluster) ?? 0) + 1);
  }
  const total = likedGenreIdSets.length;
  const target = new Map<ClusterKey, number>();
  if (total === 0) return target;
  for (const [cluster, count] of counts) target.set(cluster, count / total);
  return target;
}

// ---------------------------------------------------------------- greedy pass

export interface RerankCandidate {
  tmdbId: number;
  /** Fit 0..1 (LLM rank position, negative demotion already applied). */
  fit: number;
  novelty: number;
  freshness: number;
  cluster: ClusterKey;
  embedding?: number[];
  genreIds: number[];
}

function pairSimilarity(a: RerankCandidate, b: RerankCandidate): number {
  if (a.embedding && b.embedding) return cosine(a.embedding, b.embedding);
  return jaccard(a.genreIds, b.genreIds);
}

/**
 * Deterministic post-LLM greedy pass (MMR + calibration + epsilon blend
 * + strict caps, in one pass so they compose instead of fighting).
 *
 * At each step: among cluster-eligible candidates (strict cap — an
 * over-cap cluster is never eligible), only near-ties on fit compete
 * (MOSTRA epsilon rule); the winner maximizes the weighted objective
 * minus the MMR penalty for similarity to already-selected items, plus
 * a calibration bonus for under-represented clusters. Ties break toward
 * input order, so the pass is fully deterministic.
 *
 * Returns the FULL greedy order (pool order — the caller slices the Top
 * 10). `capBound` is true when the pass stopped with candidates left
 * that were all cap-blocked: the list is short because of the cap, not
 * because the pool ran out. Over-cap candidates never surface.
 */
export function deterministicRerank<T extends RerankCandidate>(
  items: T[],
  kind: 'casual' | 'deep',
  target: Map<ClusterKey, number>,
  cap: number,
): { ordered: T[]; capBound: boolean } {
  const weights = RERANK_WEIGHTS[kind];
  const remaining = [...items];
  const ordered: T[] = [];
  const clusterCounts = new Map<ClusterKey, number>();
  let capBound = false;

  while (remaining.length > 0) {
    const eligible = remaining.filter((it) => (clusterCounts.get(it.cluster) ?? 0) < cap);
    if (eligible.length === 0) {
      capBound = true;
      break;
    }
    const bestFit = Math.max(...eligible.map((it) => it.fit));
    const nearTied = eligible.filter((it) => it.fit >= bestFit - EPSILON_NEAR_TIE);
    let best: T | null = null;
    let bestScore = -Infinity;
    for (const it of nearTied) {
      const maxSim =
        ordered.length > 0 ? Math.max(...ordered.map((sel) => pairSimilarity(it, sel))) : 0;
      const currentShare =
        ordered.length > 0 ? (clusterCounts.get(it.cluster) ?? 0) / ordered.length : 0;
      const calibGain = Math.max(0, (target.get(it.cluster) ?? 0) - currentShare);
      const score =
        weights.fit * it.fit +
        weights.novelty * it.novelty +
        weights.freshness * it.freshness +
        weights.calibration * calibGain -
        (1 - MMR_LAMBDA) * maxSim;
      if (score > bestScore) {
        bestScore = score;
        best = it;
      }
    }
    const picked = best as T;
    ordered.push(picked);
    clusterCounts.set(picked.cluster, (clusterCounts.get(picked.cluster) ?? 0) + 1);
    remaining.splice(remaining.indexOf(picked), 1);
  }
  return { ordered, capBound: capBound && remaining.length > 0 };
}

// ---------------------------------------------------------------- negative similarity

/**
 * Cosine threshold for retrieval-time near-duplicate exclusion: only
 * near-identical title+genre text clears 0.92 (same franchise / title
 * variants). Deliberately conservative — a same-genre show with a
 * different title scores well below this.
 */
export const NEGATIVE_EXCLUSION_COSINE = 0.92;
/** Lower threshold for re-rank demotion: strong resemblance, not identity. */
export const NEGATIVE_DEMOTION_COSINE = 0.85;
/** Fit penalty for demoted candidates (applied before the greedy pass). */
export const NEGATIVE_DEMOTION_PENALTY = 0.15;

/** Max cosine similarity of a candidate embedding to any negative anchor. */
export function maxNegativeSimilarity(
  embedding: number[] | undefined,
  negativeEmbeddings: number[][],
): number {
  if (!embedding || negativeEmbeddings.length === 0) return 0;
  return Math.max(...negativeEmbeddings.map((neg) => cosine(embedding, neg)));
}

// ---------------------------------------------------------------- rank-pass merging

/**
 * Merge two listwise rank passes (input order + reversed order) by mean
 * normalized rank — the documented consistency check against position
 * bias. An item ranked in only one pass gets a penalty rank just below
 * that pass (it was not confirmed by the other order). The rationale
 * comes from the pass where the item ranked better; ties prefer the
 * first pass. Stable: equal means keep first-pass order.
 */
export function mergeRankPasses(first: RankedEntry[], second: RankedEntry[]): RankedEntry[] {
  const n1 = first.length;
  const n2 = second.length;
  const pos1 = new Map(first.map((e, i) => [e.tmdbId, i]));
  const pos2 = new Map(second.map((e, i) => [e.tmdbId, i]));
  const ids = [...new Set([...pos1.keys(), ...pos2.keys()])];
  const scored = ids.map((id) => {
    const has1 = pos1.has(id);
    const has2 = pos2.has(id);
    const r1 = has1 ? (pos1.get(id) as number) : n1;
    const r2 = has2 ? (pos2.get(id) as number) : n2;
    const norm1 = n1 > 0 ? r1 / n1 : 1;
    const norm2 = n2 > 0 ? r2 / n2 : 1;
    const e1 = has1 ? first[pos1.get(id) as number] : undefined;
    const e2 = has2 ? second[pos2.get(id) as number] : undefined;
    const entry = e1 && e2 ? (norm1 <= norm2 ? e1 : e2) : ((e1 ?? e2) as RankedEntry);
    return { entry, mean: (norm1 + norm2) / 2 };
  });
  scored.sort((a, b) => a.mean - b.mean);
  return scored.map((s) => s.entry);
}

// ---------------------------------------------------------------- anchor assignment

/**
 * Minimum shared genres for a genre-overlap anchor: a single shared
 * genre (usually just "Comedy") is too weak to claim similarity — it
 * made "The Office" the anchor for cartoons and crime dramas alike.
 * Candidates sourced by TMDB recommendations keep their sourcing show
 * as anchor regardless (that link is real retrieval provenance); this
 * threshold applies only to the post-hoc overlap fallback. Below the
 * threshold the candidate has no anchor and its rationale cites
 * genres/year only.
 */
export const MIN_ANCHOR_GENRE_OVERLAP = 2;

/**
 * Index of the liked show with the greatest genre overlap with the
 * candidate (ties keep the earliest = most recently liked), or -1 when
 * no liked show shares at least MIN_ANCHOR_GENRE_OVERLAP genres.
 */
export function bestGenreOverlapAnchor(
  candidateGenreIds: number[],
  likedGenreIdSets: number[][],
): number {
  let best = -1;
  let bestOverlap = 0;
  for (let i = 0; i < likedGenreIdSets.length; i++) {
    const overlap = candidateGenreIds.filter((id) => likedGenreIdSets[i].includes(id)).length;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = i;
    }
  }
  return bestOverlap >= MIN_ANCHOR_GENRE_OVERLAP ? best : -1;
}

/**
 * Kind-scoped anchor pick: the liked show with the greatest genre
 * overlap AMONG liked shows of the candidate's kind (parallel
 * `likedKinds` array, same order as `likedGenreIdSets`); falls back to
 * any liked show only when no same-kind show shares at least
 * MIN_ANCHOR_GENRE_OVERLAP genres. Prevents a deep-focus pick citing a
 * casual anchor (e.g. a deep candidate citing South Park) and vice
 * versa. Ties keep the earliest index in each pass, as
 * bestGenreOverlapAnchor. Returns -1 when nothing qualifies.
 */
export function bestKindScopedAnchor(
  candidateGenreIds: number[],
  likedGenreIdSets: number[][],
  likedKinds: Array<'casual' | 'deep'>,
  candidateKind: 'casual' | 'deep',
): number {
  const bestIn = (indices: number[]): number => {
    let best = -1;
    let bestOverlap = 0;
    for (const i of indices) {
      const overlap = candidateGenreIds.filter((id) => likedGenreIdSets[i].includes(id)).length;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = i;
      }
    }
    return bestOverlap >= MIN_ANCHOR_GENRE_OVERLAP ? best : -1;
  };
  const sameKind: number[] = [];
  for (let i = 0; i < likedGenreIdSets.length; i++) {
    if (likedKinds[i] === candidateKind) sameKind.push(i);
  }
  const scoped = bestIn(sameKind);
  if (scoped >= 0) return scoped;
  return bestIn(likedGenreIdSets.map((_, i) => i));
}

// ---------------------------------------------------------------- grounded rationales

/**
 * Template rationale built ONLY from real data: the anchor show that
 * actually drove retrieval + the candidate's real genres/year. Used
 * when the LLM's rationale is empty or cites neither the anchor nor the
 * candidate's real attributes.
 */
export function templateRationale(
  anchorTitle: string | null,
  genreNames: string[],
  year: string,
  uiLang: string,
): string {
  const attrs = [...genreNames, year].filter(Boolean).join(', ');
  if (uiLang === 'he') {
    if (anchorTitle) return attrs ? `דומה ל${anchorTitle} (${attrs}).` : `דומה ל${anchorTitle}.`;
    return attrs ? `תואם את הטעם (${attrs}).` : 'תואם את פרופיל הטעם.';
  }
  if (anchorTitle) return attrs ? `Similar to ${anchorTitle} (${attrs}).` : `Similar to ${anchorTitle}.`;
  return attrs ? `Matches your taste (${attrs}).` : 'Matches your taste profile.';
}

/**
 * Grounding check for an LLM rationale: keep it when it cites the
 * anchor show (full normalized title, or any anchor word of 4+ chars —
 * Hebrew rationales may translate or shorten a title) or when it cites
 * at least one real genre name AND the year. Otherwise replace with the
 * template. This cannot prove the absence of invented claims (e.g. a
 * fabricated shared actor); the prompt instruction is the control for
 * that, and this check is the backstop for unanchored text.
 */
export function groundRationale(
  rationale: string,
  anchorTitle: string | null,
  genreNames: string[],
  year: string,
  uiLang: string,
): string {
  const template = templateRationale(anchorTitle, genreNames, year, uiLang);
  const trimmed = rationale.trim();
  if (!trimmed) return template;
  const norm = normalizeTitle(trimmed);
  if (anchorTitle) {
    const anchorNorm = normalizeTitle(anchorTitle);
    if (anchorNorm && norm.includes(anchorNorm)) return trimmed;
    const words = anchorNorm.split(' ').filter((w) => w.length >= 4);
    if (words.some((w) => norm.includes(w))) return trimmed;
  }
  const genreHit = genreNames.some((g) => g && norm.includes(normalizeTitle(g)));
  if (genreHit && year && norm.includes(year)) return trimmed;
  return template;
}
