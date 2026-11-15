# Show Recommender — סדרות מומלצות

A bilingual (English / Hebrew) profile-based TV show recommender for a
household. It helps a profile stop scrolling and pick the next show: wide
inventory, free-text taste, trusted outside recommendations, and two ranked
Top 10 lists — Casual and Deep focus.

Product spec: see the v2 spec PDF (Decisions v4) in the project workspace.
This repo is milestone 1: the full scaffold, all seven screens, the real
TMDB search route, the LLM layer behind a swappable interface, and the D1
schema. Ranking, trust scoring, and real auth are later milestones.

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

## Status (milestone 1)

Works end-to-end once deployed:

- Health endpoint (`/api/health`) reporting binding status.
- Show search (`/api/search`) against the real TMDB API — returns a clear
  `tmdb_not_configured` error until the `TMDB_READ_TOKEN` secret is set.
- Show detail (`/api/shows/:id`) with the TMDB → curated-override chain.
- Taste consolidation (`/api/taste/consolidate`) via Workers AI, prompted
  with user-authored text only (see the terms guardrail below).
- All seven screens with the EN/HE toggle and RTL mirroring.

Stubbed / pending:

- **Auth is a stub**: one fixed dev profile. The real decision (Clerk free
  tier vs. sessions in D1) is still open. The seam is `worker/src/auth.ts`;
  per-profile authorization is already enforced server-side in
  `worker/src/authorize.ts` on every profile-scoped route.
- **D1 database is NOT created**: on 2026-11-15 the Cloudflare API token
  returned HTTP 401 "Authentication error" (code 10000) for D1 create and
  list calls — the token has no D1 permission. Until the database exists
  and is bound, read routes return clearly-marked stub data (`stub: true`)
  and write routes return `database_not_configured`. To finish: create the
  `show-recommender` D1 database (dashboard, or a token with D1:Edit),
  apply `worker/migrations/*.sql`, put the real `database_id` in
  `wrangler.toml`, and redeploy with the D1 binding.
- Lists, inbox, and people ranking are stub payloads (ranking + trust
  engine: milestone 2). The override-table seed
  (`worker/migrations/0002_seed_overrides.sql`) is intentionally a no-op
  until TMDB IDs for the known-gap titles are confirmed via the API.

## TMDB terms guardrail — read before touching the LLM prompts

TMDB's API Terms of Use §1.C forbids using TMDB APIs or Content "in
connection with, including for training, a machine learning (ML) or
artificial intelligence (AI) based Application", and forbids caching TMDB
data "for longer than 6 months" (terms last updated 2023-10-20; full text
at https://www.themoviedb.org/api-terms-of-use). Consequences in this
codebase, by design:

1. The LLM layer NEVER receives TMDB content. Prompts contain only
   user-authored text (taste notes, feedback reasons, ad-hoc queries) and
   show titles/IDs — never overviews or other TMDB content. Keep it that
   way; a feature needing the LLM to see descriptions needs a product /
   terms decision first.
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
worker/src/          Hono Worker: routes, TMDB client, LLM layer, auth stub
worker/migrations/   D1 schema (0001) + override seed contract (0002)
scripts/             bundle-worker.mjs — embeds dist/ + esbuild bundle
```

## Build rules that must keep holding (spec §9)

1. Every read/write is scoped to the active profile; no cross-profile leaks.
2. Language hard filter is absolute; taste nuance can only narrow within it.
3. The raw feedback log is append-only; consolidation never rewrites it.
4. No "Want to watch" state, button, or queue anywhere.
5. Deny-list entries are read by list exclusion only — never by ranking,
   taste consolidation, or trust.
6. Rating a show anywhere removes it from both Top 10 lists.
