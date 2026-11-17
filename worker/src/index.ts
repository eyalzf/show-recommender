import { Hono } from 'hono';
import type { Context } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from './env';
import { getAuth, authMiddleware } from './auth';
import {
  AuthorizationError,
  DEV_PROFILE_ID,
  hasDb,
  requireProfileAccess,
} from './authorize';
import {
  TmdbApiError,
  TmdbNotConfiguredError,
  discoverShows,
  getGenreMap,
  getShow,
  searchShows,
  type TmdbSearchResult,
} from './tmdb';
import {
  buildConsolidationNotes,
  buildConsolidationPrompt,
  consolidationInputFingerprint,
  getLlmProvider,
  getRankLlmProvider,
  isDevWorker,
  resolveLlmMode,
  type ConsolidationNote,
} from './llm';
import {
  bootstrapStatusFromFeedback,
  createMood,
  createProfile,
  deleteMood,
  ensureAccount,
  getMood,
  insertDeny,
  insertExternalRec,
  insertFeedback,
  insertNote,
  invalidateLists,
  listMoods,
  loadBootstrapStatus,
  loadProfile,
  loadProfileContext,
  loadStoredLists,
  loadTasteRecord,
  matchFeedbackForShow,
  pruneStoredLists,
  saveStoredList,
  saveTasteRecord,
  seedPresetMoods,
  setActiveMood,
  updateProfile,
  updateTasteInputHash,
  type BootstrapStatus,
  type MoodRow,
} from './db';
import {
  generateLists,
  refillSnapshot,
  type GeneratedLists,
  type ListItemOut,
  type MoodOverlay,
} from './engine';
import { loadKnownNames, recomputePeopleScores } from './trust';
import {
  combineTasteSections,
  detectLanguageConflict,
  parseConsolidationResponse,
  parseReservoirEntries,
  parseTasteSummary,
  serializeReservoirEntries,
  tasteRecordsEqual,
  TMDB_TV_GENRES,
  type Contradiction,
  type PreferenceRule,
  type TasteSections,
} from './util';
import { extractMoodRules, resolveRules } from './rules';
import {
  STUB_CASUAL,
  STUB_DEEP,
  STUB_PROFILES,
  STUB_PROFILE,
  STUB_RECOMMENDATIONS,
  STUB_TASTE,
} from './stub';
import { DIST_ASSETS } from './dist-assets';

type Ctx = Context<{ Bindings: Env }>;

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', authMiddleware);

app.onError((err, c) => {
  if (err instanceof TmdbNotConfiguredError) {
    return c.json({ error: err.code, message: err.message }, 503);
  }
  if (err instanceof TmdbApiError) {
    // Upstream status is preserved in the message; the client sees 502.
    return c.json({ error: 'tmdb_error', message: err.message }, 502);
  }
  if (err instanceof AuthorizationError) {
    return c.json({ error: 'forbidden', message: err.message }, 403);
  }
  if (err instanceof Error && err.message === 'no_candidates') {
    return c.json({ error: 'no_candidates', message: 'No candidate shows qualified.' }, 502);
  }
  console.error('unhandled error', err);
  return c.json({ error: 'internal_error', message: 'Something went wrong.' }, 500);
});

app.notFound((c) => {
  // Unknown /api/* paths are JSON 404s. Unknown non-API GET paths fall
  // through to the SPA shell (serveAsset); other methods get a plain 404.
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: 'not_found', message: 'No such API route.' }, 404);
  }
  if (c.req.method === 'GET' || c.req.method === 'HEAD') {
    return serveAsset(c, c.req.path);
  }
  return c.text('Not found.', 404);
});

function dbRequired(c: Ctx) {
  // Throws a 503 JSON via the shared shape when the DB is unbound.
  if (!hasDb(c)) {
    return c.json(
      { error: 'database_not_configured', message: 'The D1 database is not bound yet.' },
      503,
    );
  }
  return null;
}

// ---------------------------------------------------------------- health

app.get('/api/health', (c) => {
  return c.json({
    ok: true,
    service: 'show-recommender',
    dbBound: hasDb(c),
    aiBound: Boolean(c.env.AI),
    tmdbConfigured: Boolean(c.env.TMDB_READ_TOKEN),
    auth: 'stub-dev-profile',
    // Runtime identity for the frontend + deploy verification: the dev
    // flag drives the DEV banner (same bundle serves both Workers),
    // and the provider name makes a misconfigured mock deploy visible.
    dev: isDevWorker(c.env),
    llmProvider: getLlmProvider(c.env).name,
    // Split model (2026-11-17): consolidation runs on llmProvider,
    // ranking/removal/ad-hoc on rankModel. Identical when
    // LLM_RANK_MODEL is unset.
    rankModel: getRankLlmProvider(c.env).name,
  });
});

// ---------------------------------------------------------------- search
// Real TMDB route. Errors cleanly (503 tmdb_not_configured) until the
// TMDB_READ_TOKEN secret is set. No stub fallback: search results must be
// real or explicitly absent, never invented.
//
// Rows are "rich": poster, genres (mapped from genre_ids — no detail call
// per keystroke), vote average/count, year, origin. Status/season counts
// are NOT in search payloads; the detail view carries them.

/** Map a TMDB search/discover result to the picker's rich row shape. */
function toRichRow(r: TmdbSearchResult, genreMap: Map<number, string>) {
  return {
    tmdbId: r.id,
    title: r.name,
    originalTitle: r.original_name,
    originalLanguage: r.original_language,
    overview: r.overview,
    posterPath: r.poster_path,
    firstAirDate: r.first_air_date,
    originCountry: r.origin_country,
    genres: r.genre_ids.map((id) => genreMap.get(id)).filter((g): g is string => Boolean(g)),
    voteAverage: r.vote_average,
    voteCount: r.vote_count,
  };
}

async function excludedOverrideIds(c: Ctx): Promise<Set<number>> {
  if (!hasDb(c)) return new Set();
  const excluded = await c.env.DB!.prepare(
    'SELECT tmdb_id FROM curated_overrides WHERE excluded = 1',
  ).all<{ tmdb_id: number }>();
  return new Set((excluded.results ?? []).map((r) => r.tmdb_id));
}

app.get('/api/search', async (c: Ctx) => {
  const q = (c.req.query('q') ?? '').trim();
  const lang = c.req.query('lang') ?? 'en';
  if (q.length < 2) return c.json({ results: [] });
  const [results, genreMap, excludedIds] = await Promise.all([
    searchShows(c, q, lang),
    getGenreMap(c, lang),
    excludedOverrideIds(c),
  ]);
  return c.json({
    results: results
      .filter((r) => !excludedIds.has(r.id))
      .map((r) => toRichRow(r, genreMap)),
  });
});

// ---------------------------------------------------------------- quick picks
// Highly popular shows of ALL TIME (not only recent): a blend of TMDB
// discover sorted by popularity and by vote average, both with a
// vote-count floor so the list is stable classics + acclaimed shows, not
// this week's trending. Filtered to the profile's hard language filter
// and stripped of rated / denied / override-excluded shows. No detail
// calls: rows come straight from the discover payloads.

const QUICK_PICKS_LIMIT = 16;

app.get('/api/quick-picks', async (c: Ctx) => {
  const profileId = c.req.query('profileId') ?? DEV_PROFILE_ID;
  await requireProfileAccess(c, profileId);
  const lang = c.req.query('lang') ?? 'en';
  const ctx = hasDb(c) ? await loadProfileContext(c.env.DB!, profileId, lang) : null;
  const languages = ctx?.profile.languages ?? [];
  const [popular, acclaimed, genreMap] = await Promise.all([
    discoverShows(c, lang, { languages, sortBy: 'popularity.desc', minVoteCount: 300, page: 1 }),
    discoverShows(c, lang, { languages, sortBy: 'vote_average.desc', minVoteCount: 1000, page: 1 }),
    getGenreMap(c, lang),
  ]);
  const seen = new Set<number>();
  const picks: TmdbSearchResult[] = [];
  // Interleave the two pools so neither popularity nor acclaim dominates.
  for (let i = 0; i < Math.max(popular.length, acclaimed.length) && picks.length < QUICK_PICKS_LIMIT; i++) {
    for (const pool of [popular, acclaimed]) {
      const r = pool[i];
      if (!r || seen.has(r.id) || !r.poster_path) continue;
      seen.add(r.id);
      if (ctx?.ratedIds.has(r.id) || ctx?.denyIds.has(r.id) || ctx?.excludedIds.has(r.id)) continue;
      picks.push(r);
      if (picks.length >= QUICK_PICKS_LIMIT) break;
    }
  }
  return c.json({ results: picks.map((r) => toRichRow(r, genreMap)) });
});

// ---------------------------------------------------------------- shows

app.get('/api/shows/:id', async (c: Ctx) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'bad_request', message: 'Show id must be a positive integer.' }, 400);
  }
  const lang = c.req.query('lang') ?? 'en';
  const show = await getShow(c, id, lang);
  return c.json({ show });
});

// ---------------------------------------------------------------- profiles

function profileView(
  p: {
    id: string;
    name: string;
    iconKind: string;
    iconRef: string | null;
    languages: string[];
    uiLanguage: string;
    activeMoodId?: string | null;
  },
  bootstrap?: BootstrapStatus,
) {
  return {
    id: p.id,
    name: p.name,
    iconKind: p.iconKind,
    iconRef: p.iconRef,
    languages: p.languages,
    uiLanguage: p.uiLanguage,
    activeMoodId: p.activeMoodId ?? null,
    bootstrap,
  };
}

app.get('/api/profiles', async (c: Ctx) => {
  if (!hasDb(c)) {
    return c.json({ profiles: STUB_PROFILES, stub: true });
  }
  const auth = getAuth(c);
  const rows = await c.env.DB!.prepare(
    'SELECT id, name, icon_kind, icon_ref, languages_json, ui_language, active_mood_id FROM profiles WHERE account_id = ? ORDER BY created_at',
  )
    .bind(auth.accountId)
    .all();
  const profiles = await Promise.all(
    (rows.results as unknown as Record<string, unknown>[]).map(async (r) => {
      const id = String(r['id']);
      const bootstrap = await loadBootstrapStatus(c.env.DB!, id);
      return profileView(
        {
          id,
          name: String(r['name']),
          iconKind: String(r['icon_kind']),
          iconRef: r['icon_ref'] == null ? null : String(r['icon_ref']),
          languages: JSON.parse(String(r['languages_json'] ?? '[]')) as string[],
          uiLanguage: String(r['ui_language']),
          activeMoodId: r['active_mood_id'] == null ? null : String(r['active_mood_id']),
        },
        bootstrap,
      );
    }),
  );
  return c.json({ profiles });
});

app.post('/api/profiles', async (c: Ctx) => {
  const denied = dbRequired(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const { name, languages, uiLanguage, iconKind, iconRef } = body as {
    name?: string;
    languages?: string[];
    uiLanguage?: string;
    iconKind?: string;
    iconRef?: string | null;
  };
  const cleanName = String(name ?? '').trim();
  if (!cleanName || cleanName.length > 60) {
    return c.json({ error: 'bad_request', message: 'A profile name (1-60 chars) is required.' }, 400);
  }
  const langs = Array.isArray(languages) ? languages.filter((l) => typeof l === 'string') : [];
  const uiLang = uiLanguage === 'he' ? 'he' : 'en';
  const kind = ['initials', 'icon', 'image'].includes(String(iconKind)) ? String(iconKind) : 'initials';
  const auth = getAuth(c);
  await ensureAccount(c.env.DB!, auth.accountId);
  const profile = await createProfile(
    c.env.DB!,
    auth.accountId,
    cleanName,
    langs,
    uiLang,
    kind,
    kind === 'initials' ? null : (iconRef ?? null),
  );
  const bootstrap = await loadBootstrapStatus(c.env.DB!, profile.id);
  // New profiles start with the preset moods (existing profiles were
  // seeded by migration 0004). Seeding is best-effort relative to the
  // profile itself: the profile is already created at this point.
  await seedPresetMoods(c.env.DB!, profile.id, uiLang);
  return c.json({ profile: profileView(profile, bootstrap) }, 201);
});

app.patch('/api/profiles/:id', async (c: Ctx) => {
  const denied = dbRequired(c);
  if (denied) return denied;
  const profileId = c.req.param('id');
  if (!profileId) return c.json({ error: 'bad_request', message: 'Profile id is required.' }, 400);
  await requireProfileAccess(c, profileId);
  const before = await loadProfile(c.env.DB!, profileId);
  if (!before) return c.json({ error: 'not_found', message: 'Profile not found.' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const { name, languages, uiLanguage, iconKind, iconRef } = body as {
    name?: string;
    languages?: string[];
    uiLanguage?: string;
    iconKind?: string;
    iconRef?: string | null;
  };
  const patch: Parameters<typeof updateProfile>[2] = {};
  if (typeof name === 'string' && name.trim()) patch.name = name.trim().slice(0, 60);
  if (Array.isArray(languages)) patch.languages = languages.filter((l) => typeof l === 'string');
  if (uiLanguage === 'en' || uiLanguage === 'he') patch.uiLanguage = uiLanguage;
  if (['initials', 'icon', 'image'].includes(String(iconKind))) patch.iconKind = String(iconKind);
  if (iconRef === null || typeof iconRef === 'string') patch.iconRef = iconRef;
  const updated = await updateProfile(c.env.DB!, profileId, patch);
  if (!updated) return c.json({ error: 'not_found', message: 'Profile not found.' }, 404);
  // A language-filter change invalidates the lists (event-driven refresh).
  if (patch.languages && JSON.stringify(patch.languages) !== JSON.stringify(before.languages)) {
    await invalidateLists(c.env.DB!, profileId);
  }
  const bootstrap = await loadBootstrapStatus(c.env.DB!, profileId);
  return c.json({ profile: profileView(updated, bootstrap) });
});

// Profile image upload -> R2. The object key becomes icon_ref.
app.post('/api/profiles/:id/icon', async (c: Ctx) => {
  const denied = dbRequired(c);
  if (denied) return denied;
  if (!c.env.PROFILE_ICONS) {
    return c.json({ error: 'storage_not_configured', message: 'The R2 bucket is not bound.' }, 503);
  }
  const profileId = c.req.param('id');
  if (!profileId) return c.json({ error: 'bad_request', message: 'Profile id is required.' }, 400);
  await requireProfileAccess(c, profileId);
  const form = await c.req.parseBody();
  const file = form['file'];
  if (!(file instanceof File) || !file.type.startsWith('image/')) {
    return c.json({ error: 'bad_request', message: 'An image file upload is required.' }, 400);
  }
  if (file.size > 2 * 1024 * 1024) {
    return c.json({ error: 'bad_request', message: 'Image must be under 2 MB.' }, 400);
  }
  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const key = `icons/${profileId}/${crypto.randomUUID()}.${ext}`;
  await c.env.PROFILE_ICONS.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  });
  await updateProfile(c.env.DB!, profileId, { iconKind: 'image', iconRef: key });
  return c.json({ ok: true, iconRef: key });
});

app.get('/api/profiles/:id/icon', async (c: Ctx) => {
  const profileId = c.req.param('id');
  if (!profileId) return c.json({ error: 'bad_request', message: 'Profile id is required.' }, 400);
  await requireProfileAccess(c, profileId);
  const profile = hasDb(c) ? await loadProfile(c.env.DB!, profileId) : null;
  const key = profile?.iconRef;
  if (!key || !c.env.PROFILE_ICONS) {
    return c.json({ error: 'not_found', message: 'No profile image.' }, 404);
  }
  const obj = await c.env.PROFILE_ICONS.get(key);
  if (!obj) return c.json({ error: 'not_found', message: 'No profile image.' }, 404);
  return new Response(await obj.arrayBuffer(), {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'image/jpeg',
      'cache-control': 'public, max-age=86400',
    },
  });
});

// ---------------------------------------------------------------- lists
// Event-driven: writes invalidate the stored lists, so a GET recomputes
// from fresh state. Manual refresh forces recompute. Without a DB the
// clearly-marked stub payloads are returned.

async function listsResponse(
  c: Ctx,
  profileId: string,
  uiLang: string,
  forceRefresh: boolean,
  moodId = '',
) {
  const db = c.env.DB!;
  // A mood id selects that mood's stored lists (own reservoirs, own
  // snapshots) and its overlay for generation/refill. '' is the main
  // list. Toggling between moods is a fetch of the stored snapshot —
  // no regeneration unless the snapshot was invalidated (stale).
  let overlay: MoodOverlay | undefined;
  if (moodId) {
    const mood = await getMood(db, profileId, moodId);
    if (!mood) {
      return c.json({ error: 'not_found', message: 'Mood not found.' }, 404);
    }
    overlay = { text: mood.text, rules: mood.rules };
  }
  const stored = await loadStoredLists(db, profileId, moodId);
  const parseSnapshot = (json: string): ListItemOut[] => {
    try {
      const parsed: unknown = JSON.parse(json);
      return Array.isArray(parsed) ? (parsed as ListItemOut[]) : [];
    } catch {
      return [];
    }
  };
  const casualItems = stored.casual ? parseSnapshot(stored.casual.snapshotJson) : [];
  const deepItems = stored.deep ? parseSnapshot(stored.deep.snapshotJson) : [];
  const storedResponse = (
    casual: ListItemOut[],
    deep: ListItemOut[],
    stale: boolean,
    casualReason: string | null,
    deepReason: string | null,
  ) => ({
    stub: false,
    stale,
    profileId,
    moodId,
    updatedAt:
      stored.casual && stored.deep
        ? new Date(Math.max(stored.casual.updatedAt, stored.deep.updatedAt)).toISOString()
        : null,
    casual,
    deep,
    shortReason: casualReason ?? deepReason,
    casualShortReason: casualReason,
    deepShortReason: deepReason,
  });
  // Fast path: both snapshots stored (the empty-string sentinel means
  // invalidated — regenerate below). A short snapshot refills from
  // its reservoir (promotion, no LLM) instead of regenerating; a
  // stored empty array means genuinely empty and is served as-is.
  const snapshotsStored =
    stored.casual != null &&
    stored.deep != null &&
    stored.casual.snapshotJson !== '' &&
    stored.deep.snapshotJson !== '';
  if (!forceRefresh && snapshotsStored) {
    let casual = casualItems;
    let deep = deepItems;
    let casualReason = stored.casual?.shortReason ?? null;
    let deepReason = stored.deep?.shortReason ?? null;
    if (casual.length < 10 || deep.length < 10) {
      const ctx = await loadProfileContext(db, profileId, uiLang);
      if (ctx) {
        if (casual.length < 10 && stored.casual) {
          const refilled = await refillSnapshot(
            c,
            casual,
            parseReservoirEntries(stored.casual.poolJson),
            ctx,
            uiLang,
            overlay,
          );
          if (refilled.length !== casual.length) {
            casual = refilled;
            casualReason = casual.length >= 10 ? null : casualReason;
            await saveStoredList(
              db,
              profileId,
              'casual',
              stored.casual.poolJson,
              JSON.stringify(casual),
              casualReason,
              moodId,
            );
          }
        }
        if (deep.length < 10 && stored.deep) {
          const refilled = await refillSnapshot(
            c,
            deep,
            parseReservoirEntries(stored.deep.poolJson),
            ctx,
            uiLang,
            overlay,
          );
          if (refilled.length !== deep.length) {
            deep = refilled;
            deepReason = deep.length >= 10 ? null : deepReason;
            await saveStoredList(
              db,
              profileId,
              'deep',
              stored.deep.poolJson,
              JSON.stringify(deep),
              deepReason,
              moodId,
            );
          }
        }
      }
    }
    return storedResponse(casual, deep, false, casualReason, deepReason);
  }
  let ctx = await loadProfileContext(db, profileId, uiLang);
  if (!ctx) {
    return c.json({ error: 'not_found', message: 'Profile not found.' }, 404);
  }
  // Defense in depth for the onboarding gate (the frontend enforces it in
  // the flow): a profile that has not completed the bootstrap minimum gets
  // empty lists, never a generation from an empty taste signal.
  if (!bootstrapStatusFromFeedback(ctx.feedback).complete) {
    return {
      stub: false,
      stale: false,
      profileId,
      moodId,
      updatedAt: null,
      casual: [],
      deep: [],
      shortReason: null,
      casualShortReason: null,
      deepShortReason: null,
    };
  }
  // Lazy consolidation: ratings/notes no longer consolidate eagerly,
  // so the taste record catches up HERE — right before the refresh
  // that will use it — when the log changed since it was derived.
  // Generation then ranks with fresh prose/rules, and plain reads
  // (fast path above) cost no model call. Best-effort: a failed
  // consolidation must never fail the refresh — generation proceeds
  // with the stored record and the next refresh retries. A
  // consolidation that changes the record invalidates all moods'
  // snapshots (as the old eager trigger did); this regeneration
  // saves fresh snapshots for the requested mood right after.
  const genNotes = buildConsolidationNotes(ctx.feedback);
  if (
    genNotes.length > 0 &&
    consolidationInputFingerprint(genNotes, getLlmProvider(c.env).name) !== ctx.tasteInputHash
  ) {
    try {
      await consolidateFromLog(c.env, db, profileId, uiLang);
      const fresh = await loadProfileContext(db, profileId, uiLang);
      if (fresh) ctx = fresh;
    } catch (err) {
      console.error('lazy pre-generation consolidation failed', err);
    }
  }
  // Regenerate WITH the stored reservoirs (empty on first build, or
  // after a legacy pool row): prune + re-rank instead of rebuild.
  const prev = {
    casual: parseReservoirEntries(stored.casual?.poolJson),
    deep: parseReservoirEntries(stored.deep?.poolJson),
  };
  let generated: GeneratedLists;
  try {
    generated = await generateLists(c, ctx, uiLang, prev, overlay);
  } catch (err) {
    // On engine failure, serve the last snapshots as stale rather than
    // failing outright — but never serve stale data as fresh, and
    // never serve cleared (invalidated) or empty snapshots as content.
    if (casualItems.length > 0 && deepItems.length > 0) {
      return storedResponse(
        casualItems,
        deepItems,
        true,
        stored.casual?.shortReason ?? null,
        stored.deep?.shortReason ?? null,
      );
    }
    throw err;
  }
  await saveStoredList(db, profileId, 'casual', serializeReservoirEntries(generated.casual.pool), JSON.stringify(generated.casual.snapshot), generated.casual.shortReason, moodId);
  await saveStoredList(db, profileId, 'deep', serializeReservoirEntries(generated.deep.pool), JSON.stringify(generated.deep.snapshot), generated.deep.shortReason, moodId);
  return {
    stub: false,
    stale: false,
    profileId,
    moodId,
    updatedAt: new Date(Math.max(generated.casual.updatedAt, generated.deep.updatedAt)).toISOString(),
    casual: generated.casual.snapshot,
    deep: generated.deep.snapshot,
    shortReason: generated.casual.shortReason ?? generated.deep.shortReason,
    casualShortReason: generated.casual.shortReason,
    deepShortReason: generated.deep.shortReason,
  };
}

app.get('/api/lists', async (c: Ctx) => {
  const profileId = c.req.query('profileId') ?? DEV_PROFILE_ID;
  await requireProfileAccess(c, profileId);
  if (!hasDb(c)) {
    return c.json({
      stub: true,
      stale: false,
      profileId,
      moodId: '',
      updatedAt: null,
      casual: STUB_CASUAL,
      deep: STUB_DEEP,
      shortReason: null,
      casualShortReason: null,
      deepShortReason: null,
    });
  }
  const uiLang = c.req.query('lang') === 'he' ? 'he' : 'en';
  const forceRefresh = c.req.query('refresh') === '1';
  const moodId = c.req.query('mood') ?? '';
  const res = await listsResponse(c, profileId, uiLang, forceRefresh, moodId);
  if (res instanceof Response) return res;
  return c.json(res);
});

app.post('/api/lists/refresh', async (c: Ctx) => {
  const denied = dbRequired(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const { profileId, lang, moodId } = body as { profileId?: string; lang?: string; moodId?: string };
  if (!profileId) {
    return c.json({ error: 'bad_request', message: 'profileId is required.' }, 400);
  }
  await requireProfileAccess(c, profileId);
  const uiLang = lang === 'he' ? 'he' : 'en';
  const res = await listsResponse(c, profileId, uiLang, true, moodId ?? '');
  if (res instanceof Response) return res;
  return c.json(res);
});

// ---------------------------------------------------------------- moods
// A Mood is an overlay on the main list: its own text + extracted
// rules, its own stored lists, one active at a time per profile.
// Creation extracts rules from the mood text ONLY (the fixed rules
// are already stored and merge deterministically at generation).
// The active selection persists on the profile until the user picks
// the main list or deletes the mood.

function moodView(m: MoodRow) {
  return {
    id: m.id,
    text: m.text,
    rules: m.rules,
    source: m.source,
    createdAt: m.createdAt,
    lastUsedAt: m.lastUsedAt,
  };
}

app.get('/api/moods', async (c: Ctx) => {
  const profileId = c.req.query('profileId') ?? DEV_PROFILE_ID;
  await requireProfileAccess(c, profileId);
  if (!hasDb(c)) {
    return c.json({ moods: [], genreLabels: {}, stub: true });
  }
  const lang = c.req.query('lang') === 'he' ? 'he' : 'en';
  const moods = await listMoods(c.env.DB!, profileId);
  // Localized genre labels for rule display (same pattern as /api/taste).
  const genreRuleIds = [
    ...new Set(
      moods.flatMap((m) =>
        m.rules.filter((r) => r.dimension === 'genre').map((r) => Number(r.value)),
      ),
    ),
  ];
  const genreLabels: Record<string, string> = {};
  if (genreRuleIds.length > 0) {
    const canonical = new Map(TMDB_TV_GENRES.map((g) => [g.id, g.name]));
    try {
      const map = await getGenreMap(c, lang);
      for (const id of genreRuleIds) genreLabels[id] = map.get(id) ?? canonical.get(id) ?? String(id);
    } catch {
      for (const id of genreRuleIds) genreLabels[id] = canonical.get(id) ?? String(id);
    }
  }
  return c.json({ moods: moods.map(moodView), genreLabels });
});

app.post('/api/moods', async (c: Ctx) => {
  const denied = dbRequired(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const { profileId, text } = body as { profileId?: string; text?: string };
  const cleanText = String(text ?? '').trim();
  if (!profileId || !cleanText || cleanText.length > 120) {
    return c.json(
      { error: 'bad_request', message: 'profileId and a mood text (1-120 chars) are required.' },
      400,
    );
  }
  await requireProfileAccess(c, profileId);
  // Rules come from the mood text alone, via the single extraction
  // service (parse + validate + ground; failure yields no rules and
  // never blocks creation — a mood with no rules still works through
  // its prose text).
  const provider = getLlmProvider(c.env);
  const rules = await extractMoodRules(provider, cleanText);
  const mood = await createMood(c.env.DB!, profileId, cleanText, rules, 'user');
  return c.json({ mood: moodView(mood), provider: provider.name }, 201);
});

app.delete('/api/moods/:id', async (c: Ctx) => {
  const denied = dbRequired(c);
  if (denied) return denied;
  const profileId = c.req.query('profileId');
  const moodId = c.req.param('id');
  if (!profileId || !moodId) {
    return c.json({ error: 'bad_request', message: 'profileId and a mood id are required.' }, 400);
  }
  await requireProfileAccess(c, profileId);
  const deleted = await deleteMood(c.env.DB!, profileId, moodId);
  if (!deleted) {
    return c.json({ error: 'not_found', message: 'Mood not found.' }, 404);
  }
  return c.json({ ok: true });
});

app.post('/api/moods/active', async (c: Ctx) => {
  const denied = dbRequired(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const { profileId, moodId } = body as { profileId?: string; moodId?: string | null };
  if (!profileId || (moodId !== null && typeof moodId !== 'string')) {
    return c.json(
      { error: 'bad_request', message: 'profileId and a mood id (or null for the main list) are required.' },
      400,
    );
  }
  await requireProfileAccess(c, profileId);
  const ok = await setActiveMood(c.env.DB!, profileId, moodId);
  if (!ok) {
    return c.json({ error: 'not_found', message: 'Mood not found.' }, 404);
  }
  const profile = await loadProfile(c.env.DB!, profileId);
  if (!profile) {
    return c.json({ error: 'not_found', message: 'Profile not found.' }, 404);
  }
  const bootstrap = await loadBootstrapStatus(c.env.DB!, profileId);
  return c.json({ profile: profileView(profile, bootstrap) });
});

// ---------------------------------------------------------------- feedback
// Rating a show removes it from both lists (spec §7, build rule 13) —
// the frontend applies that immediately; the server records the
// feedback, recomputes people trust, and prunes the show from the
// stored reservoirs/snapshots (the snapshot refills from the
// reservoir on read — no regeneration, no churn).

// Show-feedback history, newest first. Lets the picker mark already-rated
// shows and lets onboarding resume with its real progress.
app.get('/api/feedback', async (c: Ctx) => {
  const profileId = c.req.query('profileId') ?? DEV_PROFILE_ID;
  await requireProfileAccess(c, profileId);
  if (!hasDb(c)) {
    return c.json({ feedback: [] });
  }
  const ctx = await loadProfileContext(c.env.DB!, profileId, 'en');
  if (!ctx) {
    return c.json({ error: 'not_found', message: 'Profile not found.' }, 404);
  }
  return c.json({
    feedback: ctx.showFeedback.map((f) => ({
      tmdbId: f.tmdbId,
      showTitle: f.showTitle,
      rating: f.rating,
      reason: f.text,
      originalLanguage: f.originalLanguage,
      createdAt: f.createdAt,
    })),
  });
});

app.post('/api/feedback', async (c: Ctx) => {
  const denied = dbRequired(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const { profileId, tmdbId, showTitle, originalLanguage, rating, reason } = body as {
    profileId?: string;
    tmdbId?: number;
    showTitle?: string;
    originalLanguage?: string;
    rating?: string;
    reason?: string;
  };
  if (!profileId || !Number.isInteger(tmdbId) || !['liked', 'disliked', 'dropped'].includes(String(rating))) {
    return c.json(
      { error: 'bad_request', message: 'profileId, integer tmdbId, and rating liked|disliked|dropped are required.' },
      400,
    );
  }
  await requireProfileAccess(c, profileId);
  // Deferred consolidation: a rating's ranking effect is immediate
  // without it (surgical prune + the embedding/deterministic paths
  // read the raw log directly), so the prose summary consolidates
  // only when the bootstrap completes — or lazily at the next
  // refresh / Preferences read. Capture the bootstrap state BEFORE
  // the insert to catch the exact completing write.
  const bootstrapBefore = await loadBootstrapStatus(c.env.DB!, profileId);
  await insertFeedback(
    c.env.DB!,
    profileId,
    tmdbId as number,
    typeof showTitle === 'string' ? showTitle : null,
    String(rating),
    String(reason ?? ''),
    typeof originalLanguage === 'string' ? originalLanguage : null,
  );
  await pruneStoredLists(c.env.DB!, profileId, tmdbId as number);
  // Trust recompute is best-effort: feedback must not fail because of it.
  try {
    await recomputePeopleScores(c.env.DB!, profileId);
  } catch (err) {
    console.error('people-score recompute failed', err);
  }
  // The bootstrap-completing write consolidates in the background
  // (via waitUntil — the write itself stays fast), so the first
  // list generation already has a fresh summary. Later ratings
  // consolidate lazily at refresh time instead.
  const bootstrapAfter = await loadBootstrapStatus(c.env.DB!, profileId);
  if (!bootstrapBefore.complete && bootstrapAfter.complete) {
    const profile = await loadProfile(c.env.DB!, profileId);
    if (profile) scheduleConsolidation(c, profileId, profile.uiLanguage);
  }
  return c.json({ ok: true });
});

// Remove with "No Reason" writes ONLY a deny-list entry (build rule 14).
app.post('/api/deny', async (c: Ctx) => {
  const denied = dbRequired(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const { profileId, tmdbId } = body as { profileId?: string; tmdbId?: number };
  if (!profileId || !Number.isInteger(tmdbId)) {
    return c.json({ error: 'bad_request', message: 'profileId and integer tmdbId are required.' }, 400);
  }
  await requireProfileAccess(c, profileId);
  await insertDeny(c.env.DB!, profileId, tmdbId as number);
  await pruneStoredLists(c.env.DB!, profileId, tmdbId as number);
  return c.json({ ok: true });
});

// Continuous free-text notes (kind='note' in the raw log). Notes carry
// no explicit like/dislike choice — sentiment is inferred from the
// wording at consolidation time. `kind` is accepted for back-compat
// with older clients and defaults to 'note' when omitted.
app.post('/api/notes', async (c: Ctx) => {
  const denied = dbRequired(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const { profileId, kind, text } = body as { profileId?: string; kind?: string; text?: string };
  const noteKind = kind === undefined ? 'note' : String(kind);
  if (!profileId || !['like', 'dislike', 'note'].includes(noteKind) || !String(text ?? '').trim()) {
    return c.json(
      { error: 'bad_request', message: 'profileId and non-empty text are required.' },
      400,
    );
  }
  await requireProfileAccess(c, profileId);
  // Deferred consolidation (see /api/feedback): capture the
  // bootstrap state BEFORE the insert to catch the completing write.
  const bootstrapBefore = await loadBootstrapStatus(c.env.DB!, profileId);
  await insertNote(c.env.DB!, profileId, noteKind as 'like' | 'dislike' | 'note', String(text).trim());
  // No list action and no immediate consolidation here: the next
  // refresh consolidates first when the log changed, and the
  // consolidation invalidates (snapshots cleared, reservoirs kept)
  // only when it actually changes the taste record — a note that
  // changes nothing costs no regeneration.
  const bootstrapAfter = await loadBootstrapStatus(c.env.DB!, profileId);
  if (!bootstrapBefore.complete && bootstrapAfter.complete) {
    const profile = await loadProfile(c.env.DB!, profileId);
    if (profile) scheduleConsolidation(c, profileId, profile.uiLanguage);
  }
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- taste

/**
 * Consolidate a profile's raw feedback log into the living taste
 * summary (sectioned) via the LLM layer, and persist it. Shared by the
 * manual route and the event-driven background trigger below.
 *
 * Returns 'not_found' when the profile does not exist, 'no_ai' when no
 * AI binding is present — a stub "summary" must never be saved.
 * The prompt contains ONLY user-authored text (see llm.ts terms
 * guardrail). The raw log is never modified.
 */
interface ConsolidationOutcome {
  summary: string;
  sections: TasteSections;
  contradictions: Contradiction[];
  languageConflict: {
    languageCode: string;
    languageName: string;
    message?: string;
  } | null;
  rules: PreferenceRule[];
  provider: string;
}

async function consolidateFromLog(
  env: Env,
  db: D1Database,
  profileId: string,
  uiLang: string,
): Promise<ConsolidationOutcome | 'not_found' | 'no_ai'> {
  // Mock mode needs no AI binding (the mock never calls Workers AI);
  // the stub path must still never save a canned "summary".
  if (!env.AI && resolveLlmMode(env).kind !== 'mock') return 'no_ai';
  const ctx = await loadProfileContext(db, profileId, uiLang);
  if (!ctx) return 'not_found';
  const provider = getLlmProvider(env);
  const notes = buildConsolidationNotes(ctx.feedback);
  if (notes.length === 0) {
    // Nothing to consolidate from — no LLM call, nothing saved.
    return {
      summary: '',
      sections: { ...ctx.tasteSections },
      contradictions: [],
      languageConflict: null,
      rules: ctx.rules,
      provider: provider.name,
    };
  }
  // Skip-when-unchanged: the stored record already derives from
  // exactly this input (same notes, same model, same input
  // version) — no model call, nothing saved. Temperature 0 makes
  // re-runs reproducible, so a skip is behavior-identical to a call.
  // A stored record must exist: a NULL/absent fingerprint (never
  // consolidated, or a pre-migration row) always differs.
  const fingerprint = consolidationInputFingerprint(notes, provider.name);
  if (ctx.tasteSummary != null && fingerprint === ctx.tasteInputHash) {
    return {
      summary: '',
      sections: { ...ctx.tasteSections },
      contradictions: [],
      languageConflict: null,
      rules: ctx.rules,
      provider: provider.name,
    };
  }
  const snapshotMaxCreatedAt = ctx.feedback.reduce((m, f) => Math.max(m, f.createdAt), 0);
  const raw = await provider.generate(
    buildConsolidationPrompt(notes, uiLang, ctx.tasteSections, ctx.profile.languages),
  );
  const parsed = parseConsolidationResponse(raw);
  // Validate + ground via the single extraction service (notes only:
  // rating lines never ground a rule — per-show feedback is not a
  // category statement). Applies to every provider, mock included.
  const rules = resolveRules(
    parsed.rules,
    notes.filter((n) => n.source === 'note').map((n) => n.text),
  );
  // Keyword heuristic supplements the LLM's language-conflict call.
  const heuristic = detectLanguageConflict(
    notes.map((n) => n.text),
    ctx.profile.languages,
  );
  const languageConflict =
    parsed.languageConflict ??
    (heuristic
      ? {
          languageCode: heuristic.languageCode,
          languageName: heuristic.languageName,
          message:
            uiLang === 'he'
              ? `ההערות משבחות ${heuristic.languageName}, אבל השפה לא במסנן השפות של הפרופיל.`
              : `Your notes praise ${heuristic.languageName}, but it is not in this profile's language filter.`,
        }
      : null);
  if (parsed.summary) {
    // Staleness guard: skip saving when newer feedback landed after our
    // snapshot — that write's own trigger consolidates the fuller log,
    // so a slow earlier run never clobbers a fresher summary.
    const latest = await db
      .prepare('SELECT MAX(created_at) AS m FROM feedback_log WHERE profile_id = ?')
      .bind(profileId)
      .first<{ m: number | null }>();
    if ((latest?.m ?? 0) <= snapshotMaxCreatedAt) {
      // No-op guard: a consolidation that reproduces the stored
      // record (sections trimmed, rules as a set) changes nothing —
      // skip the save AND the invalidation, so a rating whose taste
      // already says the same thing costs no regeneration.
      const next = { sections: parsed.sections, rules };
      const current = { sections: ctx.tasteSections, rules: ctx.rules };
      if (!tasteRecordsEqual(next, current)) {
        await saveTasteRecord(db, profileId, uiLang, next);
        await invalidateLists(db, profileId);
      }
      // The input was consumed — stamp its fingerprint even on the
      // no-op path, so the next trigger skips the call instead of
      // re-running it. Inside the staleness guard: a stale run must
      // not stamp a fingerprint for input it never saw. Stamped
      // AFTER the save so a first consolidation stamps a row that
      // exists.
      await updateTasteInputHash(db, profileId, uiLang, fingerprint);
    }
  }
  return {
    summary: parsed.summary,
    sections: parsed.sections,
    contradictions: parsed.contradictions.slice(0, 3),
    languageConflict,
    rules,
    provider: provider.name,
  };
}

/**
 * Background consolidation (deferred refresh model): runs on the
 * bootstrap-completing write and from the GET /api/taste self-heal
 * when the log changed. Post-bootstrap ratings/notes do NOT
 * schedule it — the taste record catches up lazily at the next
 * refresh instead (see listsResponse). Best effort — a failed
 * consolidation must never fail the write, and the next trigger
 * (or the lazy pre-generation check) retries it. Rapid successive
 * writes may race; every run derives from the full raw log, and
 * temperature 0 makes same-input runs identical, so results
 * converge.
 */
function scheduleConsolidation(c: Ctx, profileId: string, uiLang: string): void {
  if (!hasDb(c)) return;
  // The mock needs no AI binding; without it, a missing binding means
  // there is nothing to consolidate with (see consolidateFromLog).
  if (!c.env.AI && resolveLlmMode(c.env).kind !== 'mock') return;
  const task = (async () => {
    try {
      await consolidateFromLog(c.env, c.env.DB!, profileId, uiLang);
    } catch (err) {
      console.error('background consolidation failed', err);
    }
  })();
  const ex = c.executionCtx as { waitUntil?: (p: Promise<unknown>) => void } | undefined;
  if (ex?.waitUntil) ex.waitUntil(task);
}

app.get('/api/taste', async (c: Ctx) => {
  const profileId = c.req.query('profileId') ?? DEV_PROFILE_ID;
  await requireProfileAccess(c, profileId);
  if (!hasDb(c)) {
    return c.json({ ...STUB_TASTE, stub: true, profile: STUB_PROFILE });
  }
  const lang = c.req.query('lang') ?? 'en';
  const ctx = await loadProfileContext(c.env.DB!, profileId, lang);
  if (!ctx) {
    return c.json({ error: 'not_found', message: 'Profile not found.' }, 404);
  }
  // Self-heal, fingerprint-gated: when the raw log changed since
  // the stored record was derived (or no record exists yet — a NULL
  // fingerprint always differs), consolidate in the background; the
  // next read shows the sections. An unchanged log schedules
  // nothing, so Preferences reads cost no model call.
  const tasteNotes = buildConsolidationNotes(ctx.feedback);
  if (
    tasteNotes.length > 0 &&
    consolidationInputFingerprint(tasteNotes, getLlmProvider(c.env).name) !== ctx.tasteInputHash
  ) {
    scheduleConsolidation(c, profileId, lang);
  }
  const allTexts = [
    ...ctx.notes.map((n) => n.text),
    ...ctx.showFeedback.map((f) => f.text).filter(Boolean),
  ];
  const conflict = detectLanguageConflict(allTexts, ctx.profile.languages);
  // Resolve genre-rule display labels via the localized TMDB genre
  // map (the same source show cards use); fall back to the fixed
  // list's canonical English names when TMDB is unreachable, so a
  // metadata failure never breaks the taste read. Labels key by
  // genre id; the frontend formats each rule's display text.
  const genreRuleIds = [...new Set(ctx.rules.filter((r) => r.dimension === 'genre').map((r) => r.value as number))];
  const genreLabels: Record<string, string> = {};
  if (genreRuleIds.length > 0) {
    const canonical = new Map(TMDB_TV_GENRES.map((g) => [g.id, g.name]));
    try {
      const map = await getGenreMap(c, lang);
      for (const id of genreRuleIds) genreLabels[id] = map.get(id) ?? canonical.get(id) ?? String(id);
    } catch {
      for (const id of genreRuleIds) genreLabels[id] = canonical.get(id) ?? String(id);
    }
  }
  return c.json({
    summary: combineTasteSections(ctx.tasteSections),
    sections: ctx.tasteSections,
    summaryLanguage: lang,
    rules: ctx.rules,
    genreLabels,
    notes: ctx.notes
      .slice()
      .reverse()
      .map((n) => ({
        id: n.id,
        kind: n.rating,
        text: n.text,
        createdAt: n.createdAt,
      })),
    contradiction: null,
    languageConflict: conflict
      ? {
          praisedLanguage: conflict.languageName,
          languageCode: conflict.languageCode,
          message:
            lang === 'he'
              ? `ההערות משבחות ${conflict.languageName}, אבל השפה לא במסנן השפות של הפרופיל.`
              : `Your notes praise ${conflict.languageName}, but it is not in this profile's language filter.`,
        }
      : null,
    profile: profileView(ctx.profile, bootstrapStatusFromFeedback(ctx.feedback)),
  });
});

// Direct edit of the living summary (history row kept; raw log untouched).
// Accepts `sections` ({shared, casual, deep} — partial updates merge over
// the stored sections) or a legacy `summary` string, which replaces ONLY
// the Shared section so existing Casual/Deep content is never clobbered.
app.put('/api/taste', async (c: Ctx) => {
  const denied = dbRequired(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const { profileId, lang, summary, sections } = body as {
    profileId?: string;
    lang?: string;
    summary?: string;
    sections?: Partial<TasteSections>;
  };
  if (!profileId || (typeof summary !== 'string' && sections === undefined)) {
    return c.json({ error: 'bad_request', message: 'profileId and summary or sections are required.' }, 400);
  }
  await requireProfileAccess(c, profileId);
  const uiLang = lang === 'he' ? 'he' : 'en';
  const existing = await loadTasteRecord(c.env.DB!, profileId, uiLang);
  if (sections !== undefined) {
    if (!sections || typeof sections !== 'object' || Array.isArray(sections)) {
      return c.json({ error: 'bad_request', message: 'sections must be an object.' }, 400);
    }
    const next: TasteSections = { ...existing.sections };
    for (const key of ['shared', 'casual', 'deep'] as const) {
      const value = (sections as Record<string, unknown>)[key];
      if (value !== undefined) {
        if (typeof value !== 'string') {
          return c.json({ error: 'bad_request', message: `sections.${key} must be a string.` }, 400);
        }
        next[key] = value;
      }
    }
    // Manual section edits preserve the derived rules: only
    // a consolidation re-derives them from the raw log.
    await saveTasteRecord(c.env.DB!, profileId, uiLang, {
      sections: next,
      rules: existing.rules,
    });
  } else {
    await saveTasteRecord(c.env.DB!, profileId, uiLang, {
      sections: { ...existing.sections, shared: summary as string },
      rules: existing.rules,
    });
  }
  await invalidateLists(c.env.DB!, profileId);
  return c.json({ ok: true });
});

// Consolidate raw notes into the living summary via the LLM layer.
// The prompt contains ONLY user-authored text (see llm.ts terms guardrail).
// The same consolidation also runs lazily before list regenerations
// and in the background on bootstrap completion / Preferences reads
// (scheduleConsolidation above); this route is the manual re-run. A
// re-run over unchanged input returns the stored record without a
// model call (fingerprint skip in consolidateFromLog).
app.post('/api/taste/consolidate', async (c: Ctx) => {
  const body = await c.req.json().catch(() => ({}));
  const { profileId, lang } = body as { profileId?: string; lang?: string };
  if (!profileId) {
    return c.json({ error: 'bad_request', message: 'profileId is required.' }, 400);
  }
  await requireProfileAccess(c, profileId);
  const uiLang = lang === 'he' ? 'he' : 'en';
  if (!hasDb(c)) {
    const provider = getLlmProvider(c.env);
    const notes: ConsolidationNote[] = STUB_TASTE.notes.map((n) => ({
      kind: n.kind,
      source: 'note' as const,
      text: n.text,
      createdAt: n.createdAt,
    }));
    const raw = await provider.generate(
      buildConsolidationPrompt(notes, uiLang, parseTasteSummary(STUB_TASTE.summary), STUB_PROFILE.languages),
    );
    const parsed = parseConsolidationResponse(raw);
    const rules = resolveRules(
      parsed.rules,
      notes.map((n) => n.text),
    );
    return c.json({
      summary: parsed.summary,
      sections: parsed.sections,
      contradictions: parsed.contradictions.slice(0, 3),
      languageConflict: parsed.languageConflict,
      rules,
      provider: provider.name,
      stub: true,
    });
  }
  const outcome = await consolidateFromLog(c.env, c.env.DB!, profileId, uiLang);
  if (outcome === 'not_found') {
    return c.json({ error: 'not_found', message: 'Profile not found.' }, 404);
  }
  if (outcome === 'no_ai') {
    return c.json({ error: 'ai_not_configured', message: 'The Workers AI binding is not configured.' }, 503);
  }
  return c.json({ ...outcome, stub: false });
});

// ---------------------------------------------------------------- external recommendations

app.get('/api/recommendations', async (c: Ctx) => {
  const profileId = c.req.query('profileId') ?? DEV_PROFILE_ID;
  await requireProfileAccess(c, profileId);
  if (!hasDb(c)) {
    return c.json({ ...STUB_RECOMMENDATIONS, stub: true });
  }
  const ctx = await loadProfileContext(c.env.DB!, profileId, 'en');
  if (!ctx) {
    return c.json({ error: 'not_found', message: 'Profile not found.' }, 404);
  }
  const ranking = await recomputePeopleScores(c.env.DB!, profileId);
  const knownNames = await loadKnownNames(c.env.DB!, profileId);
  const inbox = ctx.externalRecs.map((rec) => {
    const outcome = matchFeedbackForShow(ctx.showFeedback, rec.tmdbId, rec.showTitle);
    return {
      id: rec.id,
      showTitle: rec.showTitle,
      kind: rec.kind,
      names: rec.names,
      note: rec.note,
      outcome: outcome?.rating ?? null,
      retrospective: outcome ? outcome.createdAt < rec.createdAt : false,
    };
  });
  return c.json({ inbox, peopleRanking: ranking, knownNames, stub: false });
});

app.post('/api/recommendations', async (c: Ctx) => {
  const denied = dbRequired(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const { profileId, showTitle, kind, names, note, tmdbId } = body as {
    profileId?: string;
    showTitle?: string;
    kind?: string;
    names?: string[];
    note?: string;
    tmdbId?: number;
  };
  if (!profileId || !String(showTitle ?? '').trim() || !['personal', 'generic'].includes(String(kind))) {
    return c.json(
      { error: 'bad_request', message: 'profileId, showTitle, and kind personal|generic are required.' },
      400,
    );
  }
  if (kind === 'personal' && (!Array.isArray(names) || names.filter((n) => String(n).trim()).length === 0)) {
    return c.json({ error: 'bad_request', message: 'Personal recommendations need at least one name.' }, 400);
  }
  await requireProfileAccess(c, profileId);
  const id = await insertExternalRec(
    c.env.DB!,
    profileId,
    String(showTitle).trim(),
    kind as 'personal' | 'generic',
    kind === 'personal' ? (names ?? []) : [],
    String(note ?? ''),
    Number.isInteger(tmdbId) ? (tmdbId as number) : null,
  );
  // Retrospective scoring: recompute immediately from existing feedback.
  try {
    await recomputePeopleScores(c.env.DB!, profileId);
  } catch (err) {
    console.error('people-score recompute failed', err);
  }
  await invalidateLists(c.env.DB!, profileId);
  return c.json({ ok: true, id });
});

// ---------------------------------------------------------------- static assets

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function serveAsset(c: Ctx, path: string): Response {
  let key = path === '/' ? '/index.html' : path;
  let asset = DIST_ASSETS[key];
  if (!asset) {
    // SPA fallback: unknown non-API paths serve the app shell.
    key = '/index.html';
    asset = DIST_ASSETS[key];
  }
  if (!asset) {
    return c.text('Frontend not built into this Worker (dist/ was empty at bundle time).', 500);
  }
  const ext = key.slice(key.lastIndexOf('.'));
  const body =
    asset.encoding === 'base64'
      ? Uint8Array.from(atob(asset.body), (ch) => ch.charCodeAt(0))
      : asset.body;
  return new Response(body, {
    headers: {
      'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'cache-control': key === '/index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    },
  });
}

// NOTE: there is deliberately no app.get('*') catch-all route — the
// notFound handler above is the static-asset fallback, so unknown /api/*
// paths still get JSON 404s instead of the HTML shell.

export default app;
