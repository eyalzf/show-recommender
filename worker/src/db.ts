import type { D1Database } from '@cloudflare/workers-types';
import { normalizeTitle, parseMoodRulesJson, parseTasteRecord, parseTasteSummary, PRESET_MOODS, serializeTasteRecord, serializeTasteSummary, type PreferenceRule, type TasteRecord, type TasteSections } from './util';

/**
 * D1 access for profile-scoped state. Every function here takes an
 * already-authorized profile id — authorization happens in the route
 * (authorize.ts) before any of these run.
 *
 * The deny_list is deliberately absent from every read in this module
 * except loadProfileContext's exclusion set: ranking and trust must
 * never treat a deny as a taste signal (spec build rule 14). The
 * engine's layered-negative checks read that exclusion set only to
 * extend exclusion (near-duplicate exclusion, removal-only check) —
 * never to infer taste or demote by theme.
 */

export interface ProfileRow {
  id: string;
  accountId: string;
  name: string;
  iconKind: string;
  iconRef: string | null;
  languages: string[];
  uiLanguage: string;
  /** Persisted mood selection: null = the main list. Stays set until the user picks the main list or deletes the mood. */
  activeMoodId: string | null;
  createdAt: number;
}

export interface FeedbackRow {
  id: string;
  kind: 'show' | 'note';
  tmdbId: number | null;
  showTitle: string | null;
  rating: string | null;
  text: string;
  originalLanguage: string | null;
  createdAt: number;
}

export interface ExternalRecRow {
  id: string;
  tmdbId: number | null;
  showTitle: string;
  kind: 'personal' | 'generic';
  note: string;
  names: string[];
  createdAt: number;
}

export interface OverrideRow {
  tmdbId: number;
  heTitle: string | null;
  heOverview: string | null;
  originLabel: string | null;
  providersNote: string | null;
  excluded: boolean;
}

export interface ProfileContext {
  profile: ProfileRow;
  /** All feedback, oldest first (raw log order). */
  feedback: FeedbackRow[];
  /** Free-text notes only (kind='note'). */
  notes: FeedbackRow[];
  /** Show feedback only (kind='show'), newest first. */
  showFeedback: FeedbackRow[];
  ratedIds: Set<number>;
  likedIds: number[];
  denyIds: Set<number>;
  excludedIds: Set<number>;
  overrides: Map<number, OverrideRow>;
  tasteSummary: string | null;
  /**
   * Fingerprint of the consolidation input the stored record was
   * derived from (see llm.consolidationInputFingerprint), or null
   * when never consolidated / pre-migration. A fingerprint that
   * differs from the current log means the record is stale and the
   * next refresh (or Preferences read) consolidates first.
   */
  tasteInputHash: string | null;
  /** Stored summary parsed into Shared/Casual/Deep sections (see util.ts storage note). Legacy plain text reads as Shared-only. */
  tasteSections: TasteSections;
  /** Derived preference rules stored with the summary (validated; empty for legacy rows). */
  rules: PreferenceRule[];
  externalRecs: ExternalRecRow[];
}

/**
 * Bootstrap (onboarding) progress: 5 rated shows including at least one
 * dislike/drop, plus one free-text taste note (spec §7, settled 2026-11-15).
 * Latest rating per show wins, so re-rating a show moves it between the
 * liked and negative buckets instead of double-counting.
 */
export interface BootstrapStatus {
  rated: number;
  negatives: number;
  hasNote: boolean;
  complete: boolean;
}

export function bootstrapStatusFromFeedback(feedback: FeedbackRow[]): BootstrapStatus {
  const latest = new Map<number, string>();
  let hasNote = false;
  for (const f of feedback) {
    if (f.kind === 'note') {
      if (f.text.trim().length > 0) hasNote = true;
    } else if (f.tmdbId != null && f.rating) {
      latest.set(f.tmdbId, f.rating);
    }
  }
  const negatives = [...latest.values()].filter((r) => r !== 'liked').length;
  const rated = latest.size;
  return { rated, negatives, hasNote, complete: rated >= 5 && negatives >= 1 && hasNote };
}

export async function loadBootstrapStatus(
  db: D1Database,
  profileId: string,
): Promise<BootstrapStatus> {
  const res = await db
    .prepare(
      'SELECT kind, tmdb_id, rating, text FROM feedback_log WHERE profile_id = ? ORDER BY created_at ASC',
    )
    .bind(profileId)
    .all<Record<string, unknown>>();
  const feedback: FeedbackRow[] = (res.results ?? []).map((r, i) => ({
    id: String(i),
    kind: r['kind'] === 'note' ? 'note' : 'show',
    tmdbId: r['tmdb_id'] == null ? null : Number(r['tmdb_id']),
    showTitle: null,
    rating: r['rating'] == null ? null : String(r['rating']),
    text: String(r['text'] ?? ''),
    originalLanguage: null,
    createdAt: 0,
  }));
  return bootstrapStatusFromFeedback(feedback);
}

function parseLanguages(json: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(json ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export async function loadProfile(db: D1Database, profileId: string): Promise<ProfileRow | null> {
  const row = await db
    .prepare(
      'SELECT id, account_id, name, icon_kind, icon_ref, languages_json, ui_language, active_mood_id, created_at FROM profiles WHERE id = ?',
    )
    .bind(profileId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    id: String(row['id']),
    accountId: String(row['account_id']),
    name: String(row['name']),
    iconKind: String(row['icon_kind']),
    iconRef: row['icon_ref'] == null ? null : String(row['icon_ref']),
    languages: parseLanguages(String(row['languages_json'] ?? '[]')),
    uiLanguage: String(row['ui_language']),
    activeMoodId: row['active_mood_id'] == null ? null : String(row['active_mood_id']),
    createdAt: Number(row['created_at']),
  };
}

export async function loadProfileContext(
  db: D1Database,
  profileId: string,
  uiLang: string,
): Promise<ProfileContext | null> {
  const profile = await loadProfile(db, profileId);
  if (!profile) return null;

  const feedbackRes = await db
    .prepare(
      'SELECT id, kind, tmdb_id, show_title, rating, text, original_language, created_at FROM feedback_log WHERE profile_id = ? ORDER BY created_at ASC',
    )
    .bind(profileId)
    .all<Record<string, unknown>>();
  const feedback: FeedbackRow[] = (feedbackRes.results ?? []).map((r) => ({
    id: String(r['id']),
    kind: r['kind'] === 'note' ? 'note' : 'show',
    tmdbId: r['tmdb_id'] == null ? null : Number(r['tmdb_id']),
    showTitle: r['show_title'] == null ? null : String(r['show_title']),
    rating: r['rating'] == null ? null : String(r['rating']),
    text: String(r['text'] ?? ''),
    originalLanguage: r['original_language'] == null ? null : String(r['original_language']),
    createdAt: Number(r['created_at']),
  }));

  const denyRes = await db
    .prepare('SELECT tmdb_id FROM deny_list WHERE profile_id = ?')
    .bind(profileId)
    .all<Record<string, unknown>>();
  const denyIds = new Set((denyRes.results ?? []).map((r) => Number(r['tmdb_id'])));

  const overrideRes = await db
    .prepare('SELECT tmdb_id, he_title, he_overview, origin_label, providers_note, excluded FROM curated_overrides')
    .all<Record<string, unknown>>();
  const overrides = new Map<number, OverrideRow>();
  const excludedIds = new Set<number>();
  for (const r of overrideRes.results ?? []) {
    const id = Number(r['tmdb_id']);
    const excluded = Number(r['excluded'] ?? 0) === 1;
    overrides.set(id, {
      tmdbId: id,
      heTitle: r['he_title'] == null ? null : String(r['he_title']),
      heOverview: r['he_overview'] == null ? null : String(r['he_overview']),
      originLabel: r['origin_label'] == null ? null : String(r['origin_label']),
      providersNote: r['providers_note'] == null ? null : String(r['providers_note']),
      excluded,
    });
    if (excluded) excludedIds.add(id);
  }

  const summary = await db
    .prepare(
      'SELECT summary_text, input_hash FROM taste_summaries WHERE profile_id = ? AND ui_language = ?',
    )
    .bind(profileId, uiLang)
    .first<{ summary_text: string; input_hash: string | null }>();

  const recRes = await db
    .prepare(
      'SELECT id, tmdb_id, show_title, kind, note, created_at FROM external_recommendations WHERE profile_id = ? ORDER BY created_at DESC',
    )
    .bind(profileId)
    .all<Record<string, unknown>>();
  const peopleRes = await db
    .prepare(
      `SELECT rp.recommendation_id, rp.person_name FROM recommendation_people rp
       JOIN external_recommendations er ON er.id = rp.recommendation_id
       WHERE er.profile_id = ?`,
    )
    .bind(profileId)
    .all<Record<string, unknown>>();
  const namesByRec = new Map<string, string[]>();
  for (const r of peopleRes.results ?? []) {
    const id = String(r['recommendation_id']);
    const list = namesByRec.get(id) ?? [];
    list.push(String(r['person_name']));
    namesByRec.set(id, list);
  }
  const externalRecs: ExternalRecRow[] = (recRes.results ?? []).map((r) => ({
    id: String(r['id']),
    tmdbId: r['tmdb_id'] == null ? null : Number(r['tmdb_id']),
    showTitle: String(r['show_title']),
    kind: r['kind'] === 'generic' ? 'generic' : 'personal',
    note: String(r['note'] ?? ''),
    names: namesByRec.get(String(r['id'])) ?? [],
    createdAt: Number(r['created_at']),
  }));

  const showFeedback = feedback.filter((f) => f.kind === 'show').slice().reverse();
  const summaryText = summary?.summary_text ?? null;
  const tasteRecord = parseTasteRecord(summaryText);
  return {
    profile,
    feedback,
    notes: feedback.filter((f) => f.kind === 'note'),
    showFeedback,
    ratedIds: new Set(showFeedback.filter((f) => f.tmdbId != null).map((f) => f.tmdbId as number)),
    likedIds: showFeedback
      .filter((f) => f.rating === 'liked' && f.tmdbId != null)
      .map((f) => f.tmdbId as number),
    denyIds,
    excludedIds,
    overrides,
    tasteSummary: summaryText,
    tasteInputHash: summary?.input_hash ?? null,
    tasteSections: tasteRecord.sections,
    rules: tasteRecord.rules,
    externalRecs,
  };
}

// ---------------------------------------------------------------- writes

export async function insertFeedback(
  db: D1Database,
  profileId: string,
  tmdbId: number,
  showTitle: string | null,
  rating: string,
  reason: string,
  originalLanguage: string | null,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO feedback_log (id, profile_id, kind, tmdb_id, show_title, rating, text, original_language, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      crypto.randomUUID(),
      profileId,
      'show',
      tmdbId,
      showTitle,
      rating,
      reason,
      originalLanguage,
      Date.now(),
    )
    .run();
}

export async function insertNote(
  db: D1Database,
  profileId: string,
  kind: 'like' | 'dislike' | 'note',
  text: string,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO feedback_log (id, profile_id, kind, tmdb_id, show_title, rating, text, created_at) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)',
    )
    .bind(crypto.randomUUID(), profileId, 'note', kind, text, Date.now())
    .run();
}

export async function insertDeny(db: D1Database, profileId: string, tmdbId: number): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO deny_list (profile_id, tmdb_id, created_at) VALUES (?, ?, ?)')
    .bind(profileId, tmdbId, Date.now())
    .run();
}

export async function saveTasteSummary(
  db: D1Database,
  profileId: string,
  uiLang: string,
  summaryText: string,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO taste_summary_history (id, profile_id, ui_language, summary_text, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(crypto.randomUUID(), profileId, uiLang, summaryText, Date.now())
    .run();
  await db
    .prepare(
      `INSERT INTO taste_summaries (profile_id, ui_language, summary_text, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id, ui_language) DO UPDATE SET summary_text = excluded.summary_text, updated_at = excluded.updated_at`,
    )
    .bind(profileId, uiLang, summaryText, Date.now())
    .run();
}

/** Read just the stored summary, parsed into sections. No other state. */
export async function loadTasteSections(
  db: D1Database,
  profileId: string,
  uiLang: string,
): Promise<TasteSections> {
  const row = await db
    .prepare('SELECT summary_text FROM taste_summaries WHERE profile_id = ? AND ui_language = ?')
    .bind(profileId, uiLang)
    .first<{ summary_text: string }>();
  return parseTasteSummary(row?.summary_text ?? null);
}

/** Save sectioned summary (serialized; plain text when only Shared set). */
export async function saveTasteSections(
  db: D1Database,
  profileId: string,
  uiLang: string,
  sections: TasteSections,
): Promise<void> {
  await saveTasteSummary(db, profileId, uiLang, serializeTasteSummary(sections));
}

/** Read the stored summary as the full record (sections + hard exclusions). */
export async function loadTasteRecord(
  db: D1Database,
  profileId: string,
  uiLang: string,
): Promise<TasteRecord> {
  const row = await db
    .prepare('SELECT summary_text FROM taste_summaries WHERE profile_id = ? AND ui_language = ?')
    .bind(profileId, uiLang)
    .first<{ summary_text: string }>();
  return parseTasteRecord(row?.summary_text ?? null);
}

/** Save the full record (sections + hard exclusions). */
export async function saveTasteRecord(
  db: D1Database,
  profileId: string,
  uiLang: string,
  record: TasteRecord,
): Promise<void> {
  await saveTasteSummary(db, profileId, uiLang, serializeTasteRecord(record));
}

/**
 * Record that a consolidation consumed a given log input, WITHOUT
 * touching the summary, the history, or the lists. Called after a
 * successful model run even when the record was unchanged (the
 * no-op path): the input was consumed, so the next trigger must
 * skip the call rather than re-run it. Plain UPDATE — a no-op when
 * no summary row exists yet (the first consolidation saves the
 * record first, so the row exists in every realistic path).
 * Manual section edits deliberately do NOT call this: the log is
 * unchanged, so the edit is preserved until new log input arrives.
 */
export async function updateTasteInputHash(
  db: D1Database,
  profileId: string,
  uiLang: string,
  inputHash: string,
): Promise<void> {
  await db
    .prepare('UPDATE taste_summaries SET input_hash = ? WHERE profile_id = ? AND ui_language = ?')
    .bind(inputHash, profileId, uiLang)
    .run();
}

/**
 * Claim-guard TTL: a claim older than this is treated as orphaned
 * (its run crashed before releasing) and may be reclaimed. Generous
 * vs a single 70B call; the mock is instant.
 */
export const CONSOLIDATION_CLAIM_TTL_MS = 120_000;

/**
 * Claim the consolidation MUTEX for one (profile, language): the
 * INSERT is atomic, so at most one run per profile+language holds
 * it at a time, whatever the input. Returns the claim token
 * (claimed_at, ms) on success, or null when another run holds the
 * mutex — the caller must skip, even if the holder finished
 * between the conflict and any re-read (re-claiming would
 * duplicate its save, because the caller's context predates its
 * fingerprint stamp). A crashed holder's orphaned row is removed
 * by the cleanup DELETE below on a later attempt (TTL), so a
 * conflict never blocks consolidation permanently. Callers MUST
 * pair a token with releaseConsolidationClaim in a finally block.
 */
export async function tryClaimConsolidation(
  db: D1Database,
  profileId: string,
  uiLang: string,
  inputHash: string,
): Promise<number | null> {
  const now = Date.now();
  // Opportunistic cleanup of orphaned claims (crashed runs).
  await db
    .prepare('DELETE FROM consolidation_claims WHERE claimed_at < ?')
    .bind(now - CONSOLIDATION_CLAIM_TTL_MS)
    .run();
  try {
    await db
      .prepare(
        'INSERT INTO consolidation_claims (profile_id, ui_language, input_hash, claimed_at) VALUES (?, ?, ?, ?)',
      )
      .bind(profileId, uiLang, inputHash, now)
      .run();
    return now;
  } catch {
    // PK conflict: another run holds (or just held) the mutex.
    return null;
  }
}

/**
 * Release a mutex acquired by tryClaimConsolidation. Deletes only
 * the row matching the caller's token, so a slow run's release can
 * never steal a successor's claim after a TTL takeover. Idempotent.
 */
export async function releaseConsolidationClaim(
  db: D1Database,
  profileId: string,
  uiLang: string,
  claimedAt: number,
): Promise<void> {
  await db
    .prepare(
      'DELETE FROM consolidation_claims WHERE profile_id = ? AND ui_language = ? AND claimed_at = ?',
    )
    .bind(profileId, uiLang, claimedAt)
    .run();
}

/**
 * Reservoir-aware invalidation: a taste-affecting change (new tip,
 * manual section edit, language-filter change, consolidation that
 * actually changed the summary) clears the DISPLAYED snapshots but
 * KEEPS the stored reservoirs, so the next regeneration re-ranks
 * known shows instead of rebuilding from zero. The cleared snapshot
 * is the empty-string sentinel (never a stored value otherwise):
 * listsResponse regenerates when it sees it, while a stored empty
 * array means "generated, genuinely empty" and is served as-is.
 * Ratings and denies do NOT call this — they prune surgically
 * (pruneStoredLists) and the snapshot refills from the reservoir on
 * read.
 */
export async function invalidateLists(db: D1Database, profileId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE recommendation_lists
       SET snapshot_json = '', short_reason = NULL, updated_at = ?
       WHERE profile_id = ?`,
    )
    .bind(Date.now(), profileId)
    .run();
}

/**
 * Surgical prune: drop one show from both stored reservoirs and both
 * snapshots (rating / deny). The snapshot refills from the reservoir
 * on the next read — no regeneration, no churn. Tolerant of
 * unparseable rows (left untouched). No-op when nothing is stored.
 */
export async function pruneStoredLists(
  db: D1Database,
  profileId: string,
  tmdbId: number,
): Promise<void> {
  // All moods: a rated/denied show must leave every stored list, not
  // just the active one, or it resurfaces when an inactive mood is
  // picked again.
  const res = await db
    .prepare('SELECT kind, mood_id, pool_json, snapshot_json FROM recommendation_lists WHERE profile_id = ?')
    .bind(profileId)
    .all<Record<string, unknown>>();
  for (const r of res.results ?? []) {
    const kind = String(r['kind']);
    const moodId = String(r['mood_id'] ?? '');
    let poolJson = String(r['pool_json']);
    let snapshotJson = String(r['snapshot_json']);
    let changed = false;
    try {
      const pool = JSON.parse(poolJson) as unknown;
      if (Array.isArray(pool)) {
        const kept = pool.filter(
          (e) => !(e && typeof e === 'object' && (e as Record<string, unknown>)['tmdbId'] === tmdbId),
        );
        if (kept.length !== pool.length) {
          poolJson = JSON.stringify(kept);
          changed = true;
        }
      }
    } catch {
      // Unparseable pool: leave the row alone.
    }
    try {
      const snap = JSON.parse(snapshotJson) as unknown;
      if (Array.isArray(snap)) {
        const kept = snap.filter(
          (e) => !(e && typeof e === 'object' && (e as Record<string, unknown>)['tmdbId'] === tmdbId),
        );
        if (kept.length !== snap.length) {
          snapshotJson = JSON.stringify(kept);
          changed = true;
        }
      }
    } catch {
      // Unparseable snapshot: leave the row alone.
    }
    if (changed) {
      await db
        .prepare(
          'UPDATE recommendation_lists SET pool_json = ?, snapshot_json = ? WHERE profile_id = ? AND kind = ? AND mood_id = ?',
        )
        .bind(poolJson, snapshotJson, profileId, kind, moodId)
        .run();
    }
  }
}

export interface StoredList {
  poolJson: string;
  snapshotJson: string;
  shortReason: string | null;
  updatedAt: number;
}

export async function loadStoredLists(
  db: D1Database,
  profileId: string,
  moodId = '',
): Promise<{ casual: StoredList | null; deep: StoredList | null }> {
  const res = await db
    .prepare(
      'SELECT kind, pool_json, snapshot_json, short_reason, updated_at FROM recommendation_lists WHERE profile_id = ? AND mood_id = ?',
    )
    .bind(profileId, moodId)
    .all<Record<string, unknown>>();
  let casual: StoredList | null = null;
  let deep: StoredList | null = null;
  for (const r of res.results ?? []) {
    const item: StoredList = {
      poolJson: String(r['pool_json']),
      snapshotJson: String(r['snapshot_json']),
      shortReason: r['short_reason'] == null ? null : String(r['short_reason']),
      updatedAt: Number(r['updated_at']),
    };
    if (r['kind'] === 'casual') casual = item;
    else if (r['kind'] === 'deep') deep = item;
  }
  return { casual, deep };
}

export async function saveStoredList(
  db: D1Database,
  profileId: string,
  kind: 'casual' | 'deep',
  poolJson: string,
  snapshotJson: string,
  shortReason: string | null,
  moodId = '',
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO recommendation_lists (profile_id, kind, mood_id, pool_json, snapshot_json, short_reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, kind, mood_id) DO UPDATE SET pool_json = excluded.pool_json, snapshot_json = excluded.snapshot_json, short_reason = excluded.short_reason, updated_at = excluded.updated_at`,
    )
    .bind(profileId, kind, moodId, poolJson, snapshotJson, shortReason, Date.now())
    .run();
}

export async function insertExternalRec(
  db: D1Database,
  profileId: string,
  showTitle: string,
  kind: 'personal' | 'generic',
  names: string[],
  note: string,
  tmdbId: number | null,
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      'INSERT INTO external_recommendations (id, profile_id, tmdb_id, show_title, kind, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(id, profileId, tmdbId, showTitle, kind, note, Date.now())
    .run();
  for (const name of [...new Set(names.map((n) => n.trim()).filter(Boolean))]) {
    await db
      .prepare('INSERT OR IGNORE INTO recommendation_people (recommendation_id, person_name) VALUES (?, ?)')
      .bind(id, name)
      .run();
  }
  return id;
}

// ---------------------------------------------------------------- profiles

export async function ensureAccount(db: D1Database, accountId: string): Promise<void> {
  // Stub-mode account row: the email is a placeholder until real auth
  // lands and accounts carry real emails.
  await db
    .prepare('INSERT OR IGNORE INTO accounts (id, email, created_at) VALUES (?, ?, ?)')
    .bind(accountId, `${accountId}@stub.local`, Date.now())
    .run();
}

export async function createProfile(
  db: D1Database,
  accountId: string,
  name: string,
  languages: string[],
  uiLanguage: string,
  iconKind: string,
  iconRef: string | null,
): Promise<ProfileRow> {
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  await db
    .prepare(
      'INSERT INTO profiles (id, account_id, name, icon_kind, icon_ref, languages_json, ui_language, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(id, accountId, name, iconKind, iconRef, JSON.stringify(languages), uiLanguage, createdAt)
    .run();
  return {
    id,
    accountId,
    name,
    iconKind,
    iconRef,
    languages,
    uiLanguage,
    activeMoodId: null,
    createdAt,
  };
}

export async function updateProfile(
  db: D1Database,
  profileId: string,
  patch: { name?: string; languages?: string[]; uiLanguage?: string; iconKind?: string; iconRef?: string | null },
): Promise<ProfileRow | null> {
  const current = await loadProfile(db, profileId);
  if (!current) return null;
  const next: ProfileRow = {
    ...current,
    name: patch.name ?? current.name,
    languages: patch.languages ?? current.languages,
    uiLanguage: patch.uiLanguage ?? current.uiLanguage,
    iconKind: patch.iconKind ?? current.iconKind,
    iconRef: patch.iconRef !== undefined ? patch.iconRef : current.iconRef,
  };
  await db
    .prepare(
      'UPDATE profiles SET name = ?, icon_kind = ?, icon_ref = ?, languages_json = ?, ui_language = ? WHERE id = ?',
    )
    .bind(next.name, next.iconKind, next.iconRef, JSON.stringify(next.languages), next.uiLanguage, profileId)
    .run();
  return next;
}

// ---------------------------------------------------------------- moods
// A Mood is an overlay: its own text + extracted rules, and its own
// stored lists (recommendation_lists keyed by mood_id). The fixed
// profile rules are never modified — generation merges them with the
// mood's rules (util.effectiveRules) and the mood's text rides along
// as a prose suffix in the rank prompt. Presets and user-created
// moods are the same rows; `source` only records the origin.

export interface MoodRow {
  id: string;
  profileId: string;
  text: string;
  rules: PreferenceRule[];
  source: 'preset' | 'user';
  createdAt: number;
  lastUsedAt: number;
}

function moodFromRow(r: Record<string, unknown>): MoodRow {
  return {
    id: String(r['id']),
    profileId: String(r['profile_id']),
    text: String(r['text'] ?? ''),
    rules: parseMoodRulesJson(r['rules_json'] == null ? null : String(r['rules_json'])),
    source: r['source'] === 'preset' ? 'preset' : 'user',
    createdAt: Number(r['created_at']),
    lastUsedAt: Number(r['last_used_at']),
  };
}

/** Moods most-recently-used first (activation bumps last_used_at). */
export async function listMoods(db: D1Database, profileId: string): Promise<MoodRow[]> {
  const res = await db
    .prepare(
      'SELECT id, profile_id, text, rules_json, source, created_at, last_used_at FROM moods WHERE profile_id = ? ORDER BY last_used_at DESC, created_at ASC',
    )
    .bind(profileId)
    .all<Record<string, unknown>>();
  return (res.results ?? []).map(moodFromRow);
}

export async function getMood(
  db: D1Database,
  profileId: string,
  moodId: string,
): Promise<MoodRow | null> {
  const row = await db
    .prepare(
      'SELECT id, profile_id, text, rules_json, source, created_at, last_used_at FROM moods WHERE profile_id = ? AND id = ?',
    )
    .bind(profileId, moodId)
    .first<Record<string, unknown>>();
  return row ? moodFromRow(row) : null;
}

export async function createMood(
  db: D1Database,
  profileId: string,
  text: string,
  rules: PreferenceRule[],
  source: 'preset' | 'user',
): Promise<MoodRow> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await db
    .prepare(
      'INSERT INTO moods (id, profile_id, text, rules_json, source, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(id, profileId, text, JSON.stringify(rules), source, now, now)
    .run();
  return { id, profileId, text, rules, source, createdAt: now, lastUsedAt: now };
}

/** Seed the preset moods for a newly created profile (existing profiles were seeded by migration 0004). */
export async function seedPresetMoods(
  db: D1Database,
  profileId: string,
  uiLanguage: string,
): Promise<void> {
  for (const preset of PRESET_MOODS) {
    await createMood(
      db,
      profileId,
      uiLanguage === 'he' ? preset.textHe : preset.textEn,
      preset.rules,
      'preset',
    );
  }
}

/**
 * Delete a mood and its stored lists. If it was the active mood,
 * the profile falls back to the main list. No edit in v1 — delete
 * and recreate (the text re-extracts on creation).
 */
export async function deleteMood(db: D1Database, profileId: string, moodId: string): Promise<boolean> {
  const existing = await getMood(db, profileId, moodId);
  if (!existing) return false;
  await db
    .prepare('DELETE FROM recommendation_lists WHERE profile_id = ? AND mood_id = ?')
    .bind(profileId, moodId)
    .run();
  await db.prepare('DELETE FROM moods WHERE profile_id = ? AND id = ?').bind(profileId, moodId).run();
  await db
    .prepare('UPDATE profiles SET active_mood_id = NULL WHERE id = ? AND active_mood_id = ?')
    .bind(profileId, moodId)
    .run();
  return true;
}

/**
 * Persist the active mood (null = main list). The selection survives
 * reloads and profile switches until the user picks the main list or
 * deletes the mood. Activation bumps last_used_at for recency order.
 * Returns false when the mood id does not belong to the profile.
 */
export async function setActiveMood(
  db: D1Database,
  profileId: string,
  moodId: string | null,
): Promise<boolean> {
  if (moodId !== null) {
    const mood = await getMood(db, profileId, moodId);
    if (!mood) return false;
    await db
      .prepare('UPDATE moods SET last_used_at = ? WHERE profile_id = ? AND id = ?')
      .bind(Date.now(), profileId, moodId)
      .run();
  }
  await db.prepare('UPDATE profiles SET active_mood_id = ? WHERE id = ?').bind(moodId, profileId).run();
  return true;
}

/** Latest feedback outcome for a show, matched by id or normalized title. */
export function matchFeedbackForShow(
  showFeedbackNewestFirst: FeedbackRow[],
  tmdbId: number | null,
  showTitle: string,
): FeedbackRow | null {
  const normalized = normalizeTitle(showTitle);
  for (const f of showFeedbackNewestFirst) {
    if (tmdbId != null && f.tmdbId === tmdbId) return f;
    if (f.showTitle && normalized && normalizeTitle(f.showTitle) === normalized) return f;
  }
  return null;
}
