import type { D1Database } from '@cloudflare/workers-types';
import { normalizeTitle, parseTasteRecord, parseTasteSummary, serializeTasteRecord, serializeTasteSummary, type PreferenceRule, type TasteRecord, type TasteSections } from './util';

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
      'SELECT id, account_id, name, icon_kind, icon_ref, languages_json, ui_language, created_at FROM profiles WHERE id = ?',
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
    .prepare('SELECT summary_text FROM taste_summaries WHERE profile_id = ? AND ui_language = ?')
    .bind(profileId, uiLang)
    .first<{ summary_text: string }>();

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
 * Event-driven invalidation: any feedback, note, recommendation, deny,
 * or language change deletes the stored lists, so the next GET
 * recomputes from the fresh state. Cheap, and impossible to go stale.
 */
export async function invalidateLists(db: D1Database, profileId: string): Promise<void> {
  await db.prepare('DELETE FROM recommendation_lists WHERE profile_id = ?').bind(profileId).run();
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
): Promise<{ casual: StoredList | null; deep: StoredList | null }> {
  const res = await db
    .prepare(
      'SELECT kind, pool_json, snapshot_json, short_reason, updated_at FROM recommendation_lists WHERE profile_id = ?',
    )
    .bind(profileId)
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
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO recommendation_lists (profile_id, kind, pool_json, snapshot_json, short_reason, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, kind) DO UPDATE SET pool_json = excluded.pool_json, snapshot_json = excluded.snapshot_json, short_reason = excluded.short_reason, updated_at = excluded.updated_at`,
    )
    .bind(profileId, kind, poolJson, snapshotJson, shortReason, Date.now())
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
