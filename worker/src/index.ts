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
  buildConsolidationPrompt,
  getLlmProvider,
  type ConsolidationNote,
} from './llm';
import {
  bootstrapStatusFromFeedback,
  createProfile,
  ensureAccount,
  insertDeny,
  insertExternalRec,
  insertFeedback,
  insertNote,
  invalidateLists,
  loadBootstrapStatus,
  loadProfile,
  loadProfileContext,
  loadStoredLists,
  loadTasteSections,
  matchFeedbackForShow,
  saveStoredList,
  saveTasteSections,
  updateProfile,
  type BootstrapStatus,
} from './db';
import { generateAdhocPick, generateLists, type GeneratedLists } from './engine';
import { loadKnownNames, recomputePeopleScores } from './trust';
import {
  combineTasteSections,
  detectLanguageConflict,
  parseConsolidationResponse,
  parseTasteSummary,
  type Contradiction,
  type TasteSections,
} from './util';
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
    bootstrap,
  };
}

app.get('/api/profiles', async (c: Ctx) => {
  if (!hasDb(c)) {
    return c.json({ profiles: STUB_PROFILES, stub: true });
  }
  const auth = getAuth(c);
  const rows = await c.env.DB!.prepare(
    'SELECT id, name, icon_kind, icon_ref, languages_json, ui_language FROM profiles WHERE account_id = ? ORDER BY created_at',
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
) {
  const db = c.env.DB!;
  const stored = await loadStoredLists(db, profileId);
  if (!forceRefresh && stored.casual && stored.deep) {
    return {
      stub: false,
      stale: false,
      profileId,
      updatedAt: new Date(Math.max(stored.casual.updatedAt, stored.deep.updatedAt)).toISOString(),
      casual: JSON.parse(stored.casual.snapshotJson) as unknown[],
      deep: JSON.parse(stored.deep.snapshotJson) as unknown[],
      shortReason: stored.casual.shortReason ?? stored.deep.shortReason,
      casualShortReason: stored.casual.shortReason,
      deepShortReason: stored.deep.shortReason,
    };
  }
  const ctx = await loadProfileContext(db, profileId, uiLang);
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
      updatedAt: null,
      casual: [],
      deep: [],
      shortReason: null,
      casualShortReason: null,
      deepShortReason: null,
    };
  }
  let generated: GeneratedLists;
  try {
    generated = await generateLists(c, ctx, uiLang);
  } catch (err) {
    // On engine failure, serve the last snapshot as stale rather than
    // failing outright — but never serve stale data as fresh.
    if (stored.casual && stored.deep) {
      return {
        stub: false,
        stale: true,
        profileId,
        updatedAt: new Date(Math.max(stored.casual.updatedAt, stored.deep.updatedAt)).toISOString(),
        casual: JSON.parse(stored.casual.snapshotJson) as unknown[],
        deep: JSON.parse(stored.deep.snapshotJson) as unknown[],
        shortReason: stored.casual.shortReason ?? stored.deep.shortReason,
        casualShortReason: stored.casual.shortReason,
        deepShortReason: stored.deep.shortReason,
      };
    }
    throw err;
  }
  await saveStoredList(db, profileId, 'casual', JSON.stringify(generated.casual.pool), JSON.stringify(generated.casual.snapshot), generated.casual.shortReason);
  await saveStoredList(db, profileId, 'deep', JSON.stringify(generated.deep.pool), JSON.stringify(generated.deep.snapshot), generated.deep.shortReason);
  return {
    stub: false,
    stale: false,
    profileId,
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
  const res = await listsResponse(c, profileId, uiLang, forceRefresh);
  if (res instanceof Response) return res;
  return c.json(res);
});

app.post('/api/lists/refresh', async (c: Ctx) => {
  const denied = dbRequired(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const { profileId, lang } = body as { profileId?: string; lang?: string };
  if (!profileId) {
    return c.json({ error: 'bad_request', message: 'profileId is required.' }, 400);
  }
  await requireProfileAccess(c, profileId);
  const uiLang = lang === 'he' ? 'he' : 'en';
  const res = await listsResponse(c, profileId, uiLang, true);
  if (res instanceof Response) return res;
  return c.json(res);
});

// ---------------------------------------------------------------- feedback
// Rating a show removes it from both lists (spec §7, build rule 13) —
// the frontend applies that immediately; the server records the
// feedback, recomputes people trust, and invalidates the lists.

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
  await insertFeedback(
    c.env.DB!,
    profileId,
    tmdbId as number,
    typeof showTitle === 'string' ? showTitle : null,
    String(rating),
    String(reason ?? ''),
    typeof originalLanguage === 'string' ? originalLanguage : null,
  );
  await invalidateLists(c.env.DB!, profileId);
  // Trust recompute is best-effort: feedback must not fail because of it.
  try {
    await recomputePeopleScores(c.env.DB!, profileId);
  } catch (err) {
    console.error('people-score recompute failed', err);
  }
  // Event-driven consolidation: the living summary follows new feedback
  // (background via waitUntil — the write itself stays fast).
  const profile = await loadProfile(c.env.DB!, profileId);
  if (profile) scheduleConsolidation(c, profileId, profile.uiLanguage);
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
  await invalidateLists(c.env.DB!, profileId);
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
  await insertNote(c.env.DB!, profileId, noteKind as 'like' | 'dislike' | 'note', String(text).trim());
  await invalidateLists(c.env.DB!, profileId);
  // Event-driven consolidation (background): the living summary follows
  // new notes, same as feedback.
  const profile = await loadProfile(c.env.DB!, profileId);
  if (profile) scheduleConsolidation(c, profileId, profile.uiLanguage);
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
  provider: string;
}

async function consolidateFromLog(
  env: Env,
  db: D1Database,
  profileId: string,
  uiLang: string,
): Promise<ConsolidationOutcome | 'not_found' | 'no_ai'> {
  if (!env.AI) return 'no_ai';
  const ctx = await loadProfileContext(db, profileId, uiLang);
  if (!ctx) return 'not_found';
  const provider = getLlmProvider(env);
  // Every rating feeds consolidation — a rating carries its show title
  // even without a reason ("Liked: Fauda" is a taste statement); only
  // text-less notes are meaningless and skipped. Titles in prompts are
  // inside the terms guardrail (titles/IDs + factual labels only).
  const notes: ConsolidationNote[] = ctx.feedback
    .filter((f) =>
      f.kind === 'show' ? Boolean(f.showTitle || f.text.trim()) : f.text.trim().length > 0,
    )
    .map((f) => ({
      kind: String(f.rating ?? (f.kind === 'show' ? 'show' : 'note')),
      source: f.kind === 'show' ? ('rating' as const) : ('note' as const),
      text: f.showTitle ? (f.text.trim() ? `${f.showTitle}: ${f.text}` : f.showTitle) : f.text,
      createdAt: f.createdAt,
    }));
  if (notes.length === 0) {
    // Nothing to consolidate from — no LLM call, nothing saved.
    return {
      summary: '',
      sections: { ...ctx.tasteSections },
      contradictions: [],
      languageConflict: null,
      provider: provider.name,
    };
  }
  const snapshotMaxCreatedAt = ctx.feedback.reduce((m, f) => Math.max(m, f.createdAt), 0);
  const raw = await provider.generate(
    buildConsolidationPrompt(notes, uiLang, ctx.tasteSections, ctx.profile.languages),
  );
  const parsed = parseConsolidationResponse(raw);
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
      await saveTasteSections(db, profileId, uiLang, parsed.sections);
      await invalidateLists(db, profileId);
    }
  }
  return {
    summary: parsed.summary,
    sections: parsed.sections,
    contradictions: parsed.contradictions.slice(0, 3),
    languageConflict,
    provider: provider.name,
  };
}

/**
 * Event-driven consolidation (settled refresh model): after feedback or
 * a note lands, re-consolidate in the background via waitUntil, so the
 * write stays fast and the living summary never goes stale. Best
 * effort — a failed consolidation must never fail the write, and the
 * next write (or the GET /api/taste self-heal) retries it. Rapid
 * successive writes may race; every run derives from the full raw log,
 * so results converge, and the next trigger heals any stale winner.
 */
function scheduleConsolidation(c: Ctx, profileId: string, uiLang: string): void {
  if (!hasDb(c) || !c.env.AI) return;
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
  // Self-heal: a profile with feedback but no stored summary yet (e.g.
  // consolidation never ran, or it ran before this trigger existed)
  // consolidates in the background; the next read shows the sections.
  if (ctx.tasteSummary == null && ctx.feedback.length > 0) {
    scheduleConsolidation(c, profileId, lang);
  }
  const allTexts = [
    ...ctx.notes.map((n) => n.text),
    ...ctx.showFeedback.map((f) => f.text).filter(Boolean),
  ];
  const conflict = detectLanguageConflict(allTexts, ctx.profile.languages);
  return c.json({
    summary: combineTasteSections(ctx.tasteSections),
    sections: ctx.tasteSections,
    summaryLanguage: lang,
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
  const existing = await loadTasteSections(c.env.DB!, profileId, uiLang);
  if (sections !== undefined) {
    if (!sections || typeof sections !== 'object' || Array.isArray(sections)) {
      return c.json({ error: 'bad_request', message: 'sections must be an object.' }, 400);
    }
    const next: TasteSections = { ...existing };
    for (const key of ['shared', 'casual', 'deep'] as const) {
      const value = (sections as Record<string, unknown>)[key];
      if (value !== undefined) {
        if (typeof value !== 'string') {
          return c.json({ error: 'bad_request', message: `sections.${key} must be a string.` }, 400);
        }
        next[key] = value;
      }
    }
    await saveTasteSections(c.env.DB!, profileId, uiLang, next);
  } else {
    await saveTasteSections(c.env.DB!, profileId, uiLang, {
      ...existing,
      shared: summary as string,
    });
  }
  await invalidateLists(c.env.DB!, profileId);
  return c.json({ ok: true });
});

// Consolidate raw notes into the living summary via the LLM layer.
// The prompt contains ONLY user-authored text (see llm.ts terms guardrail).
// The same consolidation also runs event-driven in the background after
// feedback/note writes (scheduleConsolidation above); this route is the
// manual re-run.
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
    return c.json({
      summary: parsed.summary,
      sections: parsed.sections,
      contradictions: parsed.contradictions.slice(0, 3),
      languageConflict: parsed.languageConflict,
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

// ---------------------------------------------------------------- ad-hoc
// Independent by design: reads the profile's filters/exclusions, writes
// nothing to taste or lists (build rule 8), except an adhoc_history row
// for reference.

app.post('/api/adhoc', async (c: Ctx) => {
  const body = await c.req.json().catch(() => ({}));
  const { profileId, query, lang } = body as { profileId?: string; query?: string; lang?: string };
  if (!profileId || !String(query ?? '').trim()) {
    return c.json({ error: 'bad_request', message: 'profileId and a non-empty query are required.' }, 400);
  }
  await requireProfileAccess(c, profileId);
  const uiLang = lang === 'he' ? 'he' : 'en';
  const ctx = hasDb(c) ? await loadProfileContext(c.env.DB!, profileId, uiLang) : null;
  const result = await generateAdhocPick(c, ctx, String(query).trim(), uiLang);
  if (hasDb(c)) {
    await c.env.DB!.prepare(
      'INSERT INTO adhoc_history (id, profile_id, query_text, result_json, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(crypto.randomUUID(), profileId, String(query).trim(), JSON.stringify(result), Date.now())
      .run();
  }
  return c.json({ result, provider: getLlmProvider(c.env).name, stub: false });
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
