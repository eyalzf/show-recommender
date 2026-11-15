import { Hono } from 'hono';
import type { Context } from 'hono';
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
  getShow,
  searchShows,
} from './tmdb';
import {
  buildConsolidationPrompt,
  getLlmProvider,
} from './llm';
import {
  createProfile,
  ensureAccount,
  insertDeny,
  insertExternalRec,
  insertFeedback,
  insertNote,
  invalidateLists,
  loadProfile,
  loadProfileContext,
  loadStoredLists,
  matchFeedbackForShow,
  saveStoredList,
  saveTasteSummary,
  updateProfile,
} from './db';
import { generateAdhocPick, generateLists, type GeneratedLists } from './engine';
import { loadKnownNames, recomputePeopleScores } from './trust';
import { detectLanguageConflict, parseConsolidationResponse } from './util';
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

app.get('/api/search', async (c: Ctx) => {
  const q = (c.req.query('q') ?? '').trim();
  const lang = c.req.query('lang') ?? 'en';
  if (q.length < 2) return c.json({ results: [] });
  let results = await searchShows(c, q, lang);
  if (hasDb(c)) {
    // Drop override-excluded duplicates (the DB flag is the mechanism;
    // the hardcoded blocklist in tmdb.ts is the fallback).
    const excluded = await c.env.DB!.prepare(
      'SELECT tmdb_id FROM curated_overrides WHERE excluded = 1',
    ).all<{ tmdb_id: number }>();
    const excludedIds = new Set((excluded.results ?? []).map((r) => r.tmdb_id));
    results = results.filter((r) => !excludedIds.has(r.id));
  }
  return c.json({
    results: results.map((r) => ({
      tmdbId: r.id,
      title: r.name,
      originalTitle: r.original_name,
      originalLanguage: r.original_language,
      overview: r.overview,
      posterPath: r.poster_path,
      firstAirDate: r.first_air_date,
      originCountry: r.origin_country,
    })),
  });
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

function profileView(p: {
  id: string;
  name: string;
  iconKind: string;
  iconRef: string | null;
  languages: string[];
  uiLanguage: string;
}) {
  return {
    id: p.id,
    name: p.name,
    iconKind: p.iconKind,
    iconRef: p.iconRef,
    languages: p.languages,
    uiLanguage: p.uiLanguage,
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
  return c.json({
    profiles: (rows.results as unknown as Record<string, unknown>[]).map((r) =>
      profileView({
        id: String(r['id']),
        name: String(r['name']),
        iconKind: String(r['icon_kind']),
        iconRef: r['icon_ref'] == null ? null : String(r['icon_ref']),
        languages: JSON.parse(String(r['languages_json'] ?? '[]')) as string[],
        uiLanguage: String(r['ui_language']),
      }),
    ),
  });
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
  return c.json({ profile: profileView(profile) }, 201);
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
  return c.json({ profile: profileView(updated) });
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

// Continuous free-text like/dislike notes (kind='note' in the raw log).
app.post('/api/notes', async (c: Ctx) => {
  const denied = dbRequired(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const { profileId, kind, text } = body as { profileId?: string; kind?: string; text?: string };
  if (!profileId || !['like', 'dislike', 'note'].includes(String(kind)) || !String(text ?? '').trim()) {
    return c.json(
      { error: 'bad_request', message: 'profileId, kind like|dislike|note, and non-empty text are required.' },
      400,
    );
  }
  await requireProfileAccess(c, profileId);
  await insertNote(c.env.DB!, profileId, kind as 'like' | 'dislike', String(text).trim());
  await invalidateLists(c.env.DB!, profileId);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- taste

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
  const allTexts = [
    ...ctx.notes.map((n) => n.text),
    ...ctx.showFeedback.map((f) => f.text).filter(Boolean),
  ];
  const conflict = detectLanguageConflict(allTexts, ctx.profile.languages);
  return c.json({
    summary: ctx.tasteSummary ?? '',
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
    profile: profileView(ctx.profile),
  });
});

// Direct edit of the living summary (history row kept; raw log untouched).
app.put('/api/taste', async (c: Ctx) => {
  const denied = dbRequired(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const { profileId, lang, summary } = body as { profileId?: string; lang?: string; summary?: string };
  if (!profileId || typeof summary !== 'string') {
    return c.json({ error: 'bad_request', message: 'profileId and summary are required.' }, 400);
  }
  await requireProfileAccess(c, profileId);
  const uiLang = lang === 'he' ? 'he' : 'en';
  await saveTasteSummary(c.env.DB!, profileId, uiLang, summary);
  await invalidateLists(c.env.DB!, profileId);
  return c.json({ ok: true });
});

// Consolidate raw notes into the living summary via the LLM layer.
// The prompt contains ONLY user-authored text (see llm.ts terms guardrail).
app.post('/api/taste/consolidate', async (c: Ctx) => {
  const body = await c.req.json().catch(() => ({}));
  const { profileId, lang } = body as { profileId?: string; lang?: string };
  if (!profileId) {
    return c.json({ error: 'bad_request', message: 'profileId is required.' }, 400);
  }
  await requireProfileAccess(c, profileId);
  const uiLang = lang === 'he' ? 'he' : 'en';
  const provider = getLlmProvider(c.env);

  let notes: { kind: string; text: string; createdAt: number }[] = [];
  let existing: string | null = null;
  let allowedLanguages: string[] = [];
  if (hasDb(c)) {
    const ctx = await loadProfileContext(c.env.DB!, profileId, uiLang);
    if (!ctx) {
      return c.json({ error: 'not_found', message: 'Profile not found.' }, 404);
    }
    allowedLanguages = ctx.profile.languages;
    existing = ctx.tasteSummary;
    notes = ctx.feedback
      .filter((f) => f.text.trim().length > 0)
      .map((f) => ({
        kind: f.kind === 'show' ? String(f.rating ?? 'show') : String(f.rating ?? 'note'),
        text: f.showTitle ? `${f.showTitle}: ${f.text}` : f.text,
        createdAt: f.createdAt,
      }));
  } else {
    notes = STUB_TASTE.notes.map((n) => ({ kind: n.kind, text: n.text, createdAt: n.createdAt }));
    existing = STUB_TASTE.summary;
    allowedLanguages = STUB_PROFILE.languages;
  }

  const raw = await provider.generate(buildConsolidationPrompt(notes, uiLang, existing, allowedLanguages));
  const parsed = parseConsolidationResponse(raw);
  // Keyword heuristic supplements the LLM's language-conflict call.
  const heuristic = detectLanguageConflict(
    notes.map((n) => n.text),
    allowedLanguages,
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
  const contradictions = parsed.contradictions.slice(0, 3);

  if (hasDb(c) && parsed.summary) {
    await saveTasteSummary(c.env.DB!, profileId, uiLang, parsed.summary);
    await invalidateLists(c.env.DB!, profileId);
  }
  return c.json({
    summary: parsed.summary,
    contradictions,
    languageConflict,
    provider: provider.name,
    stub: !hasDb(c),
  });
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
