import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from './env';
import { authMiddleware } from './auth';
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
  getShow,
  searchShows,
} from './tmdb';
import {
  buildConsolidationPrompt,
  getLlmProvider,
} from './llm';
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
  const results = await searchShows(c, q, lang);
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

app.get('/api/profiles', async (c: Ctx) => {
  if (!hasDb(c)) {
    return c.json({ profiles: STUB_PROFILES, stub: true });
  }
  const rows = await c.env.DB!.prepare(
    'SELECT id, name, icon_kind, icon_ref, languages_json, ui_language FROM profiles WHERE account_id = ? ORDER BY created_at',
  )
    .bind('dev-account-1')
    .all();
  return c.json({
    profiles: (rows.results as unknown as Record<string, unknown>[]).map((r) => ({
      id: r['id'],
      name: r['name'],
      iconKind: r['icon_kind'],
      iconRef: r['icon_ref'],
      languages: JSON.parse(String(r['languages_json'] ?? '[]')) as string[],
      uiLanguage: r['ui_language'],
    })),
  });
});

// ---------------------------------------------------------------- lists
// Milestone 1: stub payloads (ranking engine is milestone 2). Flagged.

app.get('/api/lists', async (c: Ctx) => {
  const profileId = c.req.query('profileId') ?? DEV_PROFILE_ID;
  await requireProfileAccess(c, profileId);
  void hasDb(c); // DB-backed lists arrive with the ranking engine (m2).
  return c.json({
    stub: true,
    profileId,
    updatedAt: null,
    casual: STUB_CASUAL,
    deep: STUB_DEEP,
    shortReason: null,
  });
});

// ---------------------------------------------------------------- feedback
// Rating a show removes it from both lists (spec §7, build rule 13) — the
// frontend applies that immediately; the server records the feedback.

app.post('/api/feedback', async (c: Ctx) => {
  const body = await c.req.json().catch(() => ({}));
  const { profileId, tmdbId, rating, reason } = body as {
    profileId?: string;
    tmdbId?: number;
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
  if (!hasDb(c)) {
    return c.json(
      { error: 'database_not_configured', message: 'Feedback cannot be saved yet: the D1 database is not bound.' },
      503,
    );
  }
  await c.env.DB!.prepare(
    'INSERT INTO feedback_log (id, profile_id, kind, tmdb_id, rating, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(crypto.randomUUID(), profileId, 'show', tmdbId, rating, String(reason ?? ''), Date.now())
    .run();
  return c.json({ ok: true });
});

// Remove with "No Reason" writes ONLY a deny-list entry (build rule 14).
app.post('/api/deny', async (c: Ctx) => {
  const body = await c.req.json().catch(() => ({}));
  const { profileId, tmdbId } = body as { profileId?: string; tmdbId?: number };
  if (!profileId || !Number.isInteger(tmdbId)) {
    return c.json({ error: 'bad_request', message: 'profileId and integer tmdbId are required.' }, 400);
  }
  await requireProfileAccess(c, profileId);
  if (!hasDb(c)) {
    return c.json(
      { error: 'database_not_configured', message: 'Deny-list cannot be saved yet: the D1 database is not bound.' },
      503,
    );
  }
  await c.env.DB!.prepare(
    'INSERT OR IGNORE INTO deny_list (profile_id, tmdb_id, created_at) VALUES (?, ?, ?)',
  )
    .bind(profileId, tmdbId, Date.now())
    .run();
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
  const summary = await c.env.DB!.prepare(
    'SELECT summary_text FROM taste_summaries WHERE profile_id = ? AND ui_language = ?',
  )
    .bind(profileId, lang)
    .first<{ summary_text: string }>();
  const notes = await c.env.DB!.prepare(
    "SELECT id, rating, text, created_at FROM feedback_log WHERE profile_id = ? AND kind = 'note' ORDER BY created_at DESC LIMIT 50",
  )
    .bind(profileId)
    .all();
  return c.json({
    summary: summary?.summary_text ?? '',
    summaryLanguage: lang,
    notes: (notes.results as unknown as Record<string, unknown>[]).map((n) => ({
      id: n['id'],
      kind: n['rating'],
      text: n['text'],
      createdAt: n['created_at'],
    })),
    contradiction: null,
    languageConflict: null,
  });
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
  if (hasDb(c)) {
    const rows = await c.env.DB!.prepare(
      'SELECT kind, rating, text, created_at FROM feedback_log WHERE profile_id = ? ORDER BY created_at ASC',
    )
      .bind(profileId)
      .all();
    notes = (rows.results as unknown as Record<string, unknown>[])
      .filter((r) => String(r['text'] ?? '').trim().length > 0)
      .map((r) => ({
        kind: String(r['kind'] === 'show' ? r['rating'] : r['rating'] ?? 'note'),
        text: String(r['text']),
        createdAt: Number(r['created_at']),
      }));
    const s = await c.env.DB!.prepare(
      'SELECT summary_text FROM taste_summaries WHERE profile_id = ? AND ui_language = ?',
    )
      .bind(profileId, uiLang)
      .first<{ summary_text: string }>();
    existing = s?.summary_text ?? null;
  } else {
    notes = STUB_TASTE.notes.map((n) => ({ kind: n.kind, text: n.text, createdAt: n.createdAt }));
    existing = STUB_TASTE.summary;
  }

  const summary = await provider.generate(buildConsolidationPrompt(notes, uiLang, existing));
  if (hasDb(c)) {
    await c.env.DB!.prepare(
      `INSERT INTO taste_summaries (profile_id, ui_language, summary_text, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id, ui_language) DO UPDATE SET summary_text = excluded.summary_text, updated_at = excluded.updated_at`,
    )
      .bind(profileId, uiLang, summary, Date.now())
      .run();
  }
  return c.json({ summary, provider: provider.name, stub: !hasDb(c) });
});

// ---------------------------------------------------------------- external recommendations

app.get('/api/recommendations', async (c: Ctx) => {
  const profileId = c.req.query('profileId') ?? DEV_PROFILE_ID;
  await requireProfileAccess(c, profileId);
  if (!hasDb(c)) {
    return c.json({ ...STUB_RECOMMENDATIONS, stub: true });
  }
  // DB-backed inbox + people ranking arrive with milestone 2 (trust engine).
  return c.json({ inbox: [], peopleRanking: [], knownNames: [], stub: false });
});

app.post('/api/recommendations', async (c: Ctx) => {
  const body = await c.req.json().catch(() => ({}));
  const { profileId, showTitle, kind, names, note } = body as {
    profileId?: string;
    showTitle?: string;
    kind?: string;
    names?: string[];
    note?: string;
  };
  if (!profileId || !showTitle || !['personal', 'generic'].includes(String(kind))) {
    return c.json(
      { error: 'bad_request', message: 'profileId, showTitle, and kind personal|generic are required.' },
      400,
    );
  }
  if (kind === 'personal' && (!Array.isArray(names) || names.length === 0)) {
    return c.json({ error: 'bad_request', message: 'Personal recommendations need at least one name.' }, 400);
  }
  await requireProfileAccess(c, profileId);
  if (!hasDb(c)) {
    return c.json(
      { error: 'database_not_configured', message: 'Recommendations cannot be saved yet: the D1 database is not bound.' },
      503,
    );
  }
  const id = crypto.randomUUID();
  await c.env.DB!.prepare(
    'INSERT INTO external_recommendations (id, profile_id, tmdb_id, show_title, kind, note, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
  )
    .bind(id, profileId, showTitle, kind, String(note ?? ''), Date.now())
    .run();
  if (kind === 'personal') {
    for (const name of [...new Set(names!.map((n) => n.trim()).filter(Boolean))]) {
      await c.env.DB!.prepare(
        'INSERT OR IGNORE INTO recommendation_people (recommendation_id, person_name) VALUES (?, ?)',
      )
        .bind(id, name)
        .run();
    }
  }
  // Retrospective scoring (build rule 17) recomputes people_scores from
  // existing feedback; implemented with the trust engine in milestone 2.
  return c.json({ ok: true, id });
});

// ---------------------------------------------------------------- ad-hoc
// Independent by design: writes nothing to taste or lists (build rule 8),
// except an adhoc_history row for reference. Milestone 1 returns one
// TMDB discover pick with an LLM-written rationale (titles + user text
// only — never TMDB overviews; see llm.ts).

app.post('/api/adhoc', async (c: Ctx) => {
  const body = await c.req.json().catch(() => ({}));
  const { profileId, query, lang } = body as { profileId?: string; query?: string; lang?: string };
  if (!profileId || !String(query ?? '').trim()) {
    return c.json({ error: 'bad_request', message: 'profileId and a non-empty query are required.' }, 400);
  }
  await requireProfileAccess(c, profileId);
  const uiLang = lang === 'he' ? 'he' : 'en';
  // Requires the TMDB key: picks must be real shows, never invented.
  const candidates = await discoverShows(c, uiLang);
  if (candidates.length === 0) {
    return c.json({ error: 'no_candidates', message: 'No candidate shows came back from TMDB.' }, 502);
  }
  const pick = candidates[0];
  const provider = getLlmProvider(c.env);
  const rationale = await provider.generate({
    system:
      'You write a one-sentence rationale for a TV recommendation. Use ONLY the ' +
      'user request and the show title given. Write in ' +
      (uiLang === 'he' ? 'Hebrew' : 'English') +
      '. Do not invent plot details.',
    user: `Request: "${String(query).trim()}"\nShow: ${pick.name} (${pick.first_air_date?.slice(0, 4) ?? ''})`,
    maxTokens: 200,
  });
  const result = {
    tmdbId: pick.id,
    title: pick.name,
    originalLanguage: pick.original_language,
    firstAirDate: pick.first_air_date,
    rationale: rationale.trim(),
  };
  if (hasDb(c)) {
    await c.env.DB!.prepare(
      'INSERT INTO adhoc_history (id, profile_id, query_text, result_json, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(crypto.randomUUID(), profileId, String(query).trim(), JSON.stringify(result), Date.now())
      .run();
  }
  return c.json({ result, provider: provider.name, stub: false });
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
