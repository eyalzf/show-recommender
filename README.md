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
- Preferences (formerly "Taste"): living summary in three sections
  (Shared / Casual / Deep focus — free-text notes routed by the
  consolidation LLM, ratings always Shared, ambiguous notes default to
  Shared), per-section view/edit, contradiction flow scoped per section
  (accept merge / replace / keep old), continuous like/dislike notes,
  language-conflict detection with an offer to add the language.
- Recommendations (formerly "Lists"): engine-generated Top 10 casual +
  Top 10 deep-focus with rationales, Remove/Rate quick actions,
  event-driven refresh (any feedback/note/rec/language change
  invalidates the stored lists) plus manual refresh. Fewer than 10
  shown with a reason, never padded. Rail cards show years played
  (open-ended when running), seasons, and episodes (season 0 excluded).
- Tips (formerly "Recommendations"): outside recommendations, personal
  (multi-name, auto-fill) + generic, inbox with outcomes, people
  ranking from simple counts.
- Ad-hoc: one embedding-matched pick + LLM rationale, independent of
  taste and lists. Reached from the Recommendations screen (no top-nav
  item).
- Taste consolidation runs event-driven: every feedback/note write
  re-consolidates in the background (waitUntil), and reading the
  Preferences screen self-heals a missing summary the same way. The
  manual route (`/api/taste/consolidate`) remains for explicit re-runs.
  Prompts use user-authored text only (see the terms guardrail below).

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
4. Split into casual / deep-focus by a genre-ID heuristic (IDs, never
   localized genre names — see `worker/src/util.ts`), then Llama 3.3 70B
   re-ranks up to 30 per kind into the Top 10 with a rationale each —
   each kind's prompt gets the Shared taste section plus its own
   section, plus a labeled short-term "recent signals" section (90-day
   half-life decay; the long-term summary is never decayed away).
   Two listwise passes run per kind (input order + reversed order) and
   merge by mean rank, mitigating position bias. A bucket the heuristic
   starves is backfilled from the other bucket's pool; backfilled
   candidates surface only if the re-rank accepts them. Ids are
   validated against the offered set in both passes: the model can
   never invent a show.
   A deterministic post-pass (`worker/src/rerank.ts`) then re-orders
   each list: MMR over embedding similarity, Steck calibration toward
   the liked-show cluster mix, and a MOSTRA epsilon-rule blend of
   fit/novelty/freshness (per-kind weights). Diversity caps (genre-ID
   clusters, see `clusterFor`) bind inside the same pass: at most 3
   shows per cluster per Top 10 — strict, over-cap shows never
   surface, and a cap-shortened list carries a short reason — plus at
   most 12 per cluster in the rank pool. Only the pool cap relaxes on
   narrow pools, so lists are never padded with junk to look varied.
   Negative feedback is layered (Meta pattern): retrieval excludes
   near-duplicates of denied/disliked shows by embedding distance,
   re-ranking demotes strong resemblances to disliked/dropped shows,
   and a final LLM removal-only check can only remove shortlisted
   shows resembling a negative example. Rationales are grounded: each
   cites the anchor show that drove retrieval plus real genres/year,
   else a template built from real data replaces the LLM text.
5. Finalists are enriched through the 180-day metadata cache; the ranked
   pool (up to 30) and the Top 10 snapshot are stored per profile.

Held-out evaluation (dev-time only, `scripts/eval.py`): hides recent
liked shows, measures Recall/NDCG@10, and runs an LLM-as-judge pairwise
check of the engine list vs a popularity baseline with swapped A/B
labels. Raw counts only — no p-values or significance claims. See the
script header for the exposure-bias caveat.

Known v1 limitations:

- List generation is synchronous on GET/refresh (up to ~44 TMDB
  subrequests on a cold cache + 6 LLM calls in 2 sequential stages;
  can take up to about a minute). If wall-clock limits bite, move
  generation behind `waitUntil` + polling.
- Classification (kind/type/tone/pace/structure) is heuristic from
  genre IDs + runtime; tune from real usage.
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
npm run test       # pure-helper self-test + mock/provider-selection tests
npm run local:mock # full Worker end-to-end in Node with the mock LLM (zero neurons)
npm run typecheck
```

Verification is mock-first and quota-frugal — read
[`docs/dev-verification.md`](docs/dev-verification.md) before running
anything against a real model. The dev deployment
(https://show-recommender-dev.eyalzf.workers.dev) runs the same bundle
with the mock provider by default, a separate database, and a DEV
banner + provider switch in the UI; production keeps the 70B model
only. See `deploy/README.md` for the bindings split and the rule that
production bindings must never carry dev flags.

## Deploy

Deployments go through the Cloudflare Workers upload API (the available
API token cannot be handed to wrangler), uploading `worker/bundle.js`
with the bindings in `deploy/bindings.json` (production) or
`deploy/bindings-dev.json` (dev) and enabling the `workers.dev` route.
See `wrangler.toml` for the binding contract and `deploy/README.md`
for the exact commands.

Secrets (dashboard or API only, never committed):

- `TMDB_READ_TOKEN` — TMDB API v4 read access token (Bearer). Needed
  on BOTH Workers (same value); the dev Worker's copy is a one-time
  manual dashboard step.

## Layout

```
src/                 React frontend (7 screens in src/screens/)
worker/src/          Hono Worker: routes, TMDB client, LLM layer, engine,
                     trust scoring, auth stub
worker/migrations/   D1 schema (0001) + override seed contract (0002)
                     + engine migration: show_title, excluded flag,
                     verified override seeds (0003)
scripts/             bundle-worker.mjs — embeds dist/ + esbuild bundle;
                     selftest.mjs — pure-helper + mock/provider assertions;
                     local-mock-run.mjs — full local Worker run, mock LLM
docs/                dev-verification.md — quota-frugal verification playbook
deploy/              bindings.json — production Worker bindings;
                     bindings-dev.json — dev Worker bindings (mock + dev flags)
```

## Build rules that must keep holding (spec §9)

1. Every read/write is scoped to the active profile; no cross-profile leaks.
2. Language hard filter is absolute; taste nuance can only narrow within it.
3. The raw feedback log is append-only; consolidation never rewrites it.
4. No "Want to watch" state, button, or queue anywhere.
5. Deny-list entries never feed taste consolidation or trust, and never
   demote by theme — a "No Reason" deny is not a taste signal. They
   drive list exclusion only, plus near-duplicate exclusion at
   retrieval and the removal-only final check (both are exclusion
   layers, not preference learning).
6. Rating a show anywhere removes it from both Top 10 lists.
7. The default LLM provider is always the real one. The mock engages
   only via the explicit LLM_PROVIDER=mock flag or the dev-only
   override, which the backend honors only when IS_DEV_WORKER=true —
   production bindings must never carry either flag (see
   deploy/README.md).
