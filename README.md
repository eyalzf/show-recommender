# Show Recommender — סדרות מומלצות

A bilingual (English / Hebrew) profile-based TV show recommender for a
household. It helps a profile stop scrolling and pick the next show: wide
inventory, free-text taste, trusted outside recommendations, and two ranked
Top 10 lists — Casual and Deep focus.

Product spec: see the v2 spec PDF (Decisions v4) in the project workspace.
This repo is v1: the full scaffold, all seven screens wired to real API
routes, the recommendation engine (retrieval + LLM re-rank), the trust
engine (people scores from feedback outcomes), and the D1 schema. Auth
is intentionally a stub (single dev account, profile picker as entry);
real auth, TheTVDB, and the weekly sweep are deferred.

## Stack

- Frontend: React + Vite + TypeScript, EN (LTR) / HE (RTL) toggle, default
  from the browser language.
- API + hosting: one Cloudflare Worker (Hono) serving the API and the
  built frontend from a single bundled script.
- Data: Cloudflare D1 (SQLite) — schema in `worker/migrations/`.
- Profile icons/images: Cloudflare R2 bucket `show-recommender`.
- LLM: Cloudflare Workers AI (Llama 3.3 70B) behind `LlmProvider`
  (`worker/src/llm.ts`); a second provider must be addable without
  touching call sites.

## Status (v1 engine)

Works end-to-end once deployed (with D1 bound + the TMDB secret set):

- Health endpoint (`/api/health`) reporting binding status.
- Show search (`/api/search`) against the real TMDB API, with
  override-excluded duplicates filtered out.
- Show detail (`/api/shows/:id`) with the TMDB → curated-override chain,
  IL watch providers, and specials-aware season counts.
- Profiles: create/edit with icon (emoji/initials) or R2-hosted image,
  language hard filter, per-profile authorization on every route.
- Bootstrap: live-filtering TMDB search, 5 ratings incl. ≥1 negative +
  a free-text note, all persisted to the raw feedback log.
- Taste: living summary (view/edit/consolidate), contradiction flow
  (accept merge / replace / keep old), continuous like/dislike notes,
  language-conflict detection with an offer to add the language.
- Lists: engine-generated Top 10 casual + Top 10 deep-focus with
  rationales, Remove/Rate quick actions, event-driven refresh (any
  feedback/note/rec/language change invalidates the stored lists) plus
  manual refresh. Fewer than 10 shown with a reason, never padded.
- External recommendations: personal (multi-name, auto-fill) + generic,
  inbox with outcomes, people ranking from simple counts.
- Ad-hoc: one embedding-matched pick + LLM rationale, independent of
  taste and lists.
- Taste consolidation (`/api/taste/consolidate`) via Workers AI,
  prompted with user-authored text only (see the terms guardrail below).

Stubbed / pending:

- **Auth is a stub**: one fixed dev account. The seam is
  `worker/src/auth.ts`; per-profile authorization is already enforced
  server-side in `worker/src/authorize.ts` on every profile-scoped route.
- **D1 database is NOT created**: on 2026-11-15 the Cloudflare API token
  returned HTTP 401 "Authentication error" (code 10000) for D1 create and
  list calls — the token has no D1 permission. Until the database exists
  and is bound, read routes return clearly-marked stub data (`stub: true`)
  and write routes return `database_not_configured`. To finish: create the
  `show-recommender` D1 database (dashboard, or a token with D1:Edit),
  apply `worker/migrations/*.sql` in order, put the real `database_id` in
  `wrangler.toml`, and redeploy with the D1 binding.
- **TMDB secret is NOT set**: until `TMDB_READ_TOKEN` is set on the
  Worker, TMDB routes return `tmdb_not_configured` and list generation
  cannot run. The key lives in the Secure Vault and cannot be extracted;
  setting it is a dashboard step for the account owner.

## Engine (worker/src/engine.ts)

Retrieval, then LLM re-rank:

1. Hard filters: profile languages (empty = unrestricted), rated /
   dropped / deny-listed shows excluded, override-excluded duplicates
   excluded.
2. Candidate sources: TMDB discover (language-filtered, 2 pages),
   trending, TMDB recommendations anchored on up to 3 liked shows,
   genre discover from liked shows' genres, resolved external recs
   (strict title match or captured TMDB id).
3. Retrieval scoring: embedding similarity (Workers AI BGE-M3,
   multilingual) of the taste summary against title + genre text —
   never overviews — plus popularity, votes, similar-show and
   external-rec boosts, and genre overlap with likes.
4. Split into casual / deep-focus by a genre heuristic (see
   `worker/src/util.ts`), then Llama 3.3 70B re-ranks up to 30 per kind
   into the Top 10 with a rationale each. Ids are validated against the
   offered set: the model can never invent a show.
5. Finalists are enriched through the 180-day metadata cache; the ranked
   pool (up to 30) and the Top 10 snapshot are stored per profile.

Known v1 limitations:

- List generation is synchronous on GET/refresh (up to ~36 TMDB
  subrequests + 2 LLM calls; can take up to a minute). If wall-clock
  limits bite, move generation behind `waitUntil` + polling.
- Classification (kind/type/tone/pace/structure) is heuristic from
  genres + runtime; tune from real usage.
- The embedding model degrades silently to non-embedding signals when
  the AI binding is absent or the call fails.
- List snapshots store the rationale language of the generating UI
  language; switching languages re-renders on the next refresh.

## TMDB terms guardrail — read before touching the LLM prompts

TMDB's API Terms of Use §1.C forbids using TMDB APIs or Content "in
connection with, including for training, a machine learning (ML) or
artificial intelligence (AI) based Application", and forbids caching TMDB
data "for longer than 6 months" (terms last updated 2023-10-20; full text
at https://www.themoviedb.org/api-terms-of-use). Consequences in this
codebase, by design:

1. The LLM layer NEVER receives TMDB descriptive content. Prompts
   contain only user-authored text (taste notes, feedback reasons,
   ad-hoc queries) and show titles/IDs plus factual labels (genre
   names, year, original language, country, episode runtime, season
   counts) — never overviews, taglines, or other descriptions. The
   line is descriptions, not facts. Embeddings follow the same rule:
   taste text + title/genre strings only, never overviews. Keep it
   that way; a feature needing the LLM to see descriptions needs a
   product / terms decision first.
2. The metadata cache enforces a 180-day TTL, inside the 6-month cap.
3. The footer carries the required TMDB logo + "not endorsed or certified"
   attribution.

This is a terms-reading, not legal advice; the scope of "AI based
Application" is ambiguous. Do not weaken these guardrails quietly.

## Develop

```sh
npm install
npm run dev        # frontend only, Vite dev server
npm run build      # vite build + Worker bundle -> worker/bundle.js
npm run test       # pure-helper self-test (worker/src/util.ts)
npm run typecheck
```

## Deploy

Deployments go through the Cloudflare Workers upload API (the available
API token cannot be handed to wrangler), uploading `worker/bundle.js`
with the R2 + Workers AI bindings (D1 once it exists) and enabling the
`workers.dev` route. See `wrangler.toml` for the binding contract.

Secrets (dashboard or API only, never committed):

- `TMDB_READ_TOKEN` — TMDB API v4 read access token (Bearer).

## Layout

```
src/                 React frontend (7 screens in src/screens/)
worker/src/          Hono Worker: routes, TMDB client, LLM layer, engine,
                     trust scoring, auth stub
worker/migrations/   D1 schema (0001) + override seed contract (0002)
                     + engine migration: show_title, excluded flag,
                     verified override seeds (0003)
scripts/             bundle-worker.mjs — embeds dist/ + esbuild bundle;
                     selftest.mjs — pure-helper assertions
deploy/              bindings.json — Worker bindings for the upload API
```

## Build rules that must keep holding (spec §9)

1. Every read/write is scoped to the active profile; no cross-profile leaks.
2. Language hard filter is absolute; taste nuance can only narrow within it.
3. The raw feedback log is append-only; consolidation never rewrites it.
4. No "Want to watch" state, button, or queue anywhere.
5. Deny-list entries are read by list exclusion only — never by ranking,
   taste consolidation, or trust.
6. Rating a show anywhere removes it from both Top 10 lists.
