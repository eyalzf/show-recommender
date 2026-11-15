// Local end-to-end run of the Worker with the MOCK LLM provider.
//
// Drives the real Hono app in Node (no miniflare, no network): an
// in-memory SQLite database via node:sqlite running the REAL migrations,
// a stubbed TMDB fetch serving invented fixtures (titles/IDs/genres
// only — no overviews, per the terms guardrail), and an AI binding
// whose run() throws, proving ZERO real Workers AI calls.
//
// Run: npm run local:mock  (or: node scripts/local-mock-run.mjs)
// Exits non-zero on any failed assertion. Costs zero neurons.
import { build } from 'esbuild';
import { readFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- D1 shim over node:sqlite

function makeD1(sqliteDb) {
  return {
    prepare(sql) {
      const stmt = sqliteDb.prepare(sql);
      let params = [];
      return {
        bind(...args) {
          params = args;
          return this;
        },
        async all() {
          return { results: stmt.all(...params), success: true, meta: {} };
        },
        async first() {
          const row = stmt.get(...params);
          return row === undefined ? null : row;
        },
        async run() {
          const info = stmt.run(...params);
          return {
            success: true,
            meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
          };
        },
      };
    },
  };
}

const sqliteDb = new DatabaseSync(':memory:');
for (const migration of ['0001_init.sql', '0002_seed_overrides.sql', '0003_engine.sql']) {
  sqliteDb.exec(await readFile(join(root, 'worker', 'migrations', migration), 'utf8'));
}
const DB = makeD1(sqliteDb);

// ---------------------------------------------------------------- TMDB fixtures (invented shows, no overviews)

// Genre ids: 35 Comedy, 18 Drama, 16 Animation, 80 Crime, 10765 Sci-Fi,
// 99 Documentary, 10764 Reality, 9648 Mystery, 10751 Family, 10767 Talk.
const GENRE_NAMES = {
  35: 'Comedy', 18: 'Drama', 16: 'Animation', 80: 'Crime', 10765: 'Science Fiction',
  99: 'Documentary', 10764: 'Reality', 9648: 'Mystery', 10751: 'Family', 10767: 'Talk',
};
const FIXTURES = [
  // [id, name, lang, genreIds, year] — 12 casual-leaning, 12 deep-leaning.
  [1001, 'Mock Heights', 'en', [35], 2019],
  [1002, 'The Test Kitchen', 'en', [35, 10751], 2020],
  [1003, 'Paper Planes', 'he', [16, 35], 2021],
  [1004, 'Quiet Neighbors', 'en', [35, 18], 2018],
  [1005, 'Reality Checkup', 'en', [10764], 2022],
  [1006, 'The Late Desk', 'en', [10767, 35], 2020],
  [1007, 'Family Recipe', 'he', [10751, 35], 2021],
  [1008, 'Cartoon Court', 'en', [16], 2019],
  [1009, 'Second Breakfast', 'en', [35], 2023],
  [1010, 'The Hobbyists', 'he', [10764, 35], 2022],
  [1011, 'Sunny Side Street', 'en', [10751], 2018],
  [1012, 'Punchline Park', 'en', [35, 16], 2021],
  [1013, 'The Silent File', 'en', [18, 80], 2020],
  [1014, 'Northern Case', 'he', [80, 9648], 2021],
  [1015, 'Orbital Decay', 'en', [10765, 18], 2022],
  [1016, 'The Archive', 'en', [99], 2019],
  [1017, 'Borderline County', 'en', [18, 80], 2018],
  [1018, 'The Long Winter', 'he', [18], 2020],
  [1019, 'Static Signals', 'en', [10765, 9648], 2023],
  [1020, 'Deep Water Rights', 'en', [99, 18], 2021],
  [1021, 'The Confession Room', 'en', [80, 18], 2022],
  [1022, 'Paper Trails', 'he', [9648, 18], 2019],
  [1023, 'The Last Cartographer', 'en', [10765], 2020],
  [1024, 'Verdict Season', 'en', [18, 80], 2023],
].map(([id, name, lang, genreIds, year]) => ({
  id,
  name,
  original_name: name,
  original_language: lang,
  overview: '',
  poster_path: '/mock-poster.jpg',
  backdrop_path: null,
  first_air_date: `${year}-03-01`,
  genre_ids: genreIds,
  origin_country: [lang === 'he' ? 'IL' : 'US'],
  popularity: 50 + (id % 40),
  vote_average: 7 + ((id % 25) / 10),
  vote_count: 500 + id,
}));

function toDetail(f) {
  const seasons = Math.max(1, (f.id % 4) + 1);
  return {
    ...f,
    genres: f.genre_ids.map((id) => ({ id, name: GENRE_NAMES[id] ?? 'Unknown' })),
    number_of_seasons: seasons,
    number_of_episodes: seasons * 8,
    episode_run_time: [f.genre_ids.includes(35) ? 25 : 50],
    status: f.id % 3 === 0 ? 'Returning Series' : 'Ended',
    last_air_date: `${2024}-05-01`,
    networks: [{ id: 1, name: 'Mock Network' }],
    created_by: [],
    seasons: [
      { season_number: 0, episode_count: 2, air_date: null },
      ...Array.from({ length: seasons }, (_, i) => ({
        season_number: i + 1,
        episode_count: 8,
        air_date: `${2020 + i}-01-01`,
      })),
    ],
  };
}

const byId = new Map(FIXTURES.map((f) => [f.id, f]));

globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const path = u.pathname;
  const json = (data, status = 200) => Response.json(data, { status });
  if (path === '/3/genre/tv/list') {
    return json({ genres: Object.entries(GENRE_NAMES).map(([id, name]) => ({ id: Number(id), name })) });
  }
  if (path === '/3/discover/tv') {
    const page = Number(u.searchParams.get('page') ?? '1');
    const slice = FIXTURES.slice((page - 1) * 12, page * 12);
    return json({ results: slice });
  }
  if (path === '/3/trending/tv/week') return json({ results: FIXTURES.slice(0, 8) });
  if (path === '/3/search/tv') return json({ results: [] });
  const recMatch = /^\/3\/tv\/(\d+)\/recommendations$/.exec(path);
  if (recMatch) {
    const seed = Number(recMatch[1]) % FIXTURES.length;
    return json({ results: [0, 1, 2, 3].map((i) => FIXTURES[(seed + i * 5) % FIXTURES.length]) });
  }
  const provMatch = /^\/3\/tv\/(\d+)\/watch\/providers$/.exec(path);
  if (provMatch) return json({ results: {} });
  const creditsMatch = /^\/3\/tv\/(\d+)\/credits$/.exec(path);
  if (creditsMatch) {
    // Fixture cast: billing order, one member without a photo.
    return json({
      cast: [
        { id: 9001, name: 'Lead Actor', character: 'Hero', profile_path: '/lead.jpg', order: 0 },
        { id: 9002, name: 'Second Actor', character: 'Sidekick', profile_path: null, order: 1 },
        { id: 9003, name: 'Third Actor', character: 'Villain', profile_path: '/third.jpg', order: 2 },
      ],
      crew: [],
    });
  }
  const detailMatch = /^\/3\/tv\/(\d+)$/.exec(path);
  if (detailMatch) {
    const f = byId.get(Number(detailMatch[1]));
    if (f) return json(toDetail(f));
    return json({ status_message: 'not found' }, 404);
  }
  return json({ status_message: 'unmocked TMDB path' }, 404);
};

// ---------------------------------------------------------------- AI binding that must never be called

let aiCalls = 0;
const throwingAi = {
  run: async () => {
    aiCalls++;
    throw new Error('REAL AI CALLED — mock leak');
  },
};

// ---------------------------------------------------------------- bundle + drive the Worker

const outFile = join(root, 'node_modules', '.local-run.mjs');
await build({
  entryPoints: [join(root, 'worker', 'src', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: outFile,
  logLevel: 'silent',
});
const { default: app } = await import(outFile);

const pending = [];
const execCtx = { waitUntil: (p) => void pending.push(Promise.resolve(p)) };
async function drain() {
  while (pending.length > 0) {
    const batch = pending.splice(0, pending.length);
    await Promise.all(batch);
  }
}

async function call(env, method, path, body, extraHeaders) {
  const res = await app.request(
    `http://localhost${path}`,
    {
      method,
      headers: { 'content-type': 'application/json', ...(extraHeaders ?? {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
    execCtx,
  );
  await drain();
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { _raw: text };
  }
  return { status: res.status, body: parsed };
}

const MOCK_ENV = {
  DB,
  AI: throwingAi,
  TMDB_READ_TOKEN: 'mock-token',
  LLM_PROVIDER: 'mock',
  IS_DEV_WORKER: 'true',
};

// 1. Health reports the mock provider + dev flag.
{
  const { status, body } = await call(MOCK_ENV, 'GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(body.dev, true);
  assert.equal(body.llmProvider, 'mock');
  assert.equal(body.dbBound, true);
  assert.equal(body.tmdbConfigured, true);
  console.log('health: dev=true, llmProvider=mock');
}

// 2. Profile creation + bootstrap (5 ratings incl. 1 negative + 2 notes).
let profileId;
{
  const { status, body } = await call(MOCK_ENV, 'POST', '/api/profiles', {
    name: 'Mock Runner',
    languages: ['he', 'en'],
    uiLanguage: 'he',
    iconKind: 'initials',
    iconRef: null,
  });
  assert.equal(status, 201);
  profileId = body.profile.id;
  assert.ok(profileId);
  console.log('profile created:', profileId);
}
const ratings = [
  [1001, 'liked', ''],
  [1003, 'liked', 'fun animation'],
  [1013, 'liked', 'gripping crime'],
  [1015, 'liked', 'great sci-fi'],
  [1005, 'disliked', 'too loud'],
];
for (const [tmdbId, rating, reason] of ratings) {
  const f = byId.get(tmdbId);
  const { status } = await call(MOCK_ENV, 'POST', '/api/feedback', {
    profileId,
    tmdbId,
    rating,
    reason,
    showTitle: f.name,
    originalLanguage: f.original_language,
  });
  assert.equal(status, 200);
}
for (const text of [
  'Something light and easy for tired evenings',
  'I want complex serialized stories that demand full concentration',
]) {
  const { status } = await call(MOCK_ENV, 'POST', '/api/notes', { profileId, text });
  assert.equal(status, 200);
}
console.log('bootstrap data written (5 ratings + 2 notes)');

// 3. Taste sections populated by mock consolidation (event-driven).
{
  const { status, body } = await call(MOCK_ENV, 'GET', `/api/taste?profileId=${profileId}&lang=he`);
  assert.equal(status, 200);
  assert.ok(body.sections.shared.includes('Mock Heights'), 'ratings route to Shared');
  assert.ok(body.sections.shared.includes('Reality Checkup'), 'negative rating kept in Shared');
  assert.ok(body.sections.casual.includes('light'), 'casual cue routes to Casual');
  assert.ok(body.sections.deep.includes('complex'), 'deep cue routes to Deep');
  console.log('taste sections populated by mock consolidation:', JSON.stringify(body.sections));
}

// 4. Full list generation end to end (retrieval + mock rank + caps + enrichment).
{
  const { status, body } = await call(MOCK_ENV, 'POST', '/api/lists/refresh', { profileId, lang: 'he' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(body.casual.length >= 1, 'casual list non-empty');
  assert.ok(body.deep.length >= 1, 'deep list non-empty');
  assert.ok(body.casual.length <= 10 && body.deep.length <= 10);
  const rated = new Set(ratings.map(([id]) => id));
  for (const item of [...body.casual, ...body.deep]) {
    assert.ok(byId.has(item.tmdbId), `item ${item.tmdbId} is a fixture`);
    assert.ok(!rated.has(item.tmdbId), `rated show ${item.tmdbId} must not surface`);
    assert.ok(typeof item.rationale === 'string' && item.rationale.length > 0, 'rationale present');
    assert.ok(item.seasons >= 1 && item.episodes >= 1, 'enrichment ran');
  }
  console.log(`lists generated: casual ${body.casual.length}, deep ${body.deep.length}`);
}

// 5. Ad-hoc pick via mock rationale.
{
  const { status, body } = await call(MOCK_ENV, 'POST', '/api/adhoc', {
    profileId,
    query: 'something funny',
    lang: 'he',
  });
  assert.equal(status, 200);
  assert.ok(byId.has(body.result.tmdbId));
  assert.ok(body.result.rationale.startsWith('Mock:'));
  assert.equal(body.provider, 'mock');
  console.log('ad-hoc pick via mock:', body.result.title);
}

// 6. Show detail carries the top-billed cast (credits fetch + cache).
{
  const { status, body } = await call(MOCK_ENV, 'GET', '/api/shows/1001?lang=he');
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(Array.isArray(body.show.cast), 'cast array present');
  assert.equal(body.show.cast.length, 3);
  assert.deepEqual(body.show.cast[0], {
    tmdbId: 9001,
    name: 'Lead Actor',
    character: 'Hero',
    profilePath: '/lead.jpg',
  });
  assert.equal(body.show.cast[1].profilePath, null, 'missing photo stays null (placeholder)');
  console.log('show detail carries cast:', body.show.cast.map((m) => m.name).join(', '));
}

// 7. There is NO override path: a stray x-dev-llm-provider header is
//    IGNORED everywhere. A dev Worker WITHOUT the LLM_PROVIDER=mock
//    env flag takes the REAL path even with the header — the throwing
//    AI binding fails the call, proving no request can engage the mock.
{
  const devNoFlag = { DB, AI: throwingAi, TMDB_READ_TOKEN: 'mock-token', IS_DEV_WORKER: 'true' };
  const before = aiCalls;
  const { status } = await call(
    devNoFlag,
    'POST',
    '/api/taste/consolidate',
    { profileId, lang: 'he' },
    { 'x-dev-llm-provider': 'mock' },
  );
  assert.equal(status, 500);
  assert.equal(aiCalls, before + 1, 'header ignored: exactly one real AI attempt');
  console.log('stray override header ignored on dev Worker (real path attempted, failed as designed)');
}

// 8. The SAME header is likewise ignored without the dev flag:
//    no AI binding + header -> 'no_ai', never the mock.
{
  const prodLike = { DB, TMDB_READ_TOKEN: 'mock-token' };
  const { status, body } = await call(
    prodLike,
    'POST',
    '/api/taste/consolidate',
    { profileId, lang: 'he' },
    { 'x-dev-llm-provider': 'mock' },
  );
  assert.equal(status, 503);
  assert.equal(body.error, 'ai_not_configured');
  console.log('override header ignored without IS_DEV_WORKER (503 no_ai, mock NOT engaged)');
}

// 9. Zero real AI calls across the whole mock flow.
assert.equal(aiCalls, 1, 'only the deliberate header-is-dead probe touched AI');
console.log('AI calls total:', aiCalls, '(1 = the deliberate header-is-dead probe; mock flow = 0)');

await unlink(outFile).catch(() => {});
console.log('local mock run: ALL CHECKS PASSED (zero neurons)');
