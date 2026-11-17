# Development verification playbook — quota-frugal by default

Workers AI's free allowance is **10,000 neurons/day per account**,
shared by production AND dev, resetting at 00:00 UTC. On 2026-11-15
development verification burned the whole day's allowance and took
down all LLM features app-wide until the reset. These rules exist so
that never happens again.

## The rules

1. **Mock first, always.** Verify against the deterministic mock
   provider (unit tests + the local run below) before anything touches
   a real model. The mock proves triggers, parsing, caps, grounding,
   and persistence — everything except ranking quality.
2. **At most ONE live end-to-end run per deploy** against production,
   and only when the change touches ranking/consolidation quality.
   UI-only changes get zero live LLM runs.
3. **Reuse ONE temp profile per verification session.** Never create a
   fresh profile per probe — each bootstrap burns a consolidation +
   generation cycle. Wipe temp profiles when done, scoped to their ids.
4. **Batch probes.** One profile, one data set, many assertions — not
   one deployment per question.
5. **Never run the eval-harness judge steps against the free allowance
   without checking budget first.** The judge is the most expensive
   step; it stays blocked until the token gains Workers AI permission
   anyway (see README).
6. **Verification must never burn the day's quota before real user
   traffic.** If the allowance is low, stop and say so — a
   half-verified deploy with quota left for the user beats a
   fully-verified deploy with a dead app.
7. **Production data is never test data.** Eyal's profile, feedback,
   and taste rows are read-only during verification unless a
   regeneration/backfill is explicitly authorized. Dev testing happens
   on the dev Worker or locally.

## The mock provider

`worker/src/mockLlm.ts` implements the `LlmProvider` interface
deterministically: consolidation echoes prompt statements into the
three sections, ranking orders candidates by a hash of (taste + id),
the removal check removes nothing, and embeddings are hash-seeded
normalized vectors. Same input → same output, every run.

Enable it with the env flag `LLM_PROVIDER=mock` (default is always the
real provider). Mock fixtures contain no TMDB overviews/descriptions —
the terms guardrail holds for fixtures too.

## Local end-to-end run (zero neurons, zero network)

```sh
npm run local:mock
```

`scripts/local-mock-run.mjs` drives the real Worker code in Node:
in-memory SQLite running the real migrations, a stubbed TMDB fetch
serving invented fixtures, and an AI binding that throws if touched.
It exercises profile creation → ratings/notes → event-driven
consolidation → full list generation → ad-hoc pick, plus the
no-override-path proof (a stray override header is ignored
everywhere). Exit code non-zero on any failed assertion.

Unit tests (`npm run test`) cover mock determinism/shapes, provider
selection (default-real, mock flag, no override path), and
model-config defaults. Run `npm run typecheck && npm run test` before
every push.

## The dev deployment (mock only)

- URL: https://show-recommender-dev.eyalzf.workers.dev
- Same bundle as production; separate D1 (`show-recommender-dev`) and
  R2 (`show-recommender-dev`); `LLM_PROVIDER=mock`,
  `IS_DEV_WORKER=true`.
- The UI shows an unmistakable DEV banner + watermark stating the
  mock provider. There is NO provider switch: the dev Worker is
  mock-only via env, period (decision 19:15 IST — the per-request
  override path was removed, so no header or UI control can change
  the provider on either Worker).
- Deploy: see `deploy/README.md`. Never copy production profile,
  feedback, or taste data into dev — create test profiles there.
- Dev costs zero neurons: the mock never calls Workers AI. There is
  no cheap-model path in the dev view, so no smoke call is owed for
  one.

### Model-config overrides (local runs only)

The chat/embedding model ids are env-configurable (`LLM_MODEL`,
`EMBEDDING_MODEL`), defaulting to Llama 3.3 70B + BGE-M3. The
overrides are a LOCAL-run knob only — neither Worker sets them.
A cheap local-run option is `@cf/meta/llama-3.1-8b-instruct-fp8`.
(`LLM_RANK_MODEL` is the one exception: production bindings set it
to the 8B model per the 2026-11-17 split-model decision; dev never
sets it, so the rank model follows `LLM_MODEL` there.)
Notes:

- The non-fp8 `@cf/meta/llama-3.1-8b-instruct` id was deprecated
  30 May 2026 — do not use it.
- Cloudflare lists the fp8 id with a planned deprecation of
  20 Nov 2026. If a cheap local run stops working, pick the current
  cheap id from the Workers AI model catalog — no code change needed.
- Embeddings stay BGE-M3 (or mock) in all modes.
- Real-model local runs draw from the same account allowance as
  production — check the budget before running one, and prefer the
  mock.

## Deploy commands

```sh
npm run build
# Production:
python3 ~/workspace/show-recommender-tools/deploy_worker.py show-recommender worker/bundle.js deploy/bindings.json
# Dev:
python3 ~/workspace/show-recommender-tools/deploy_worker.py show-recommender-dev worker/bundle.js deploy/bindings-dev.json
```

After every deploy, verify ONLY health + asset hash (zero neurons)
unless a live run is justified under rule 2:

```sh
curl -s -A "node" https://show-recommender.eyalzf.workers.dev/api/health
# expect: llmProvider "workers-ai:llama-3.3-70b", dev false
curl -s -A "node" https://show-recommender-dev.eyalzf.workers.dev/api/health
# expect: llmProvider "mock", dev true
```

(The `node` user agent matters: workers.dev returns 403 error 1010
for Python-urllib user agents.)

## One-time dev setup (manual)

The dev Worker needs the `TMDB_READ_TOKEN` secret (same value as
production) for TMDB search/discover/detail. Set it once in the
Cloudflare dashboard on the `show-recommender-dev` Worker — the
secret value cannot be copied by automation. Until then, dev search
and list generation return empty results while mock consolidation
still works.
