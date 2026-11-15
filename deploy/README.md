# Deploy bindings — production vs dev

Two Workers run the SAME bundle (`worker/bundle.js`, built by
`npm run build`). They differ only in bindings. Deploy with:

```sh
# Production (real 70B model, real data):
python3 ~/workspace/show-recommender-tools/deploy_worker.py show-recommender worker/bundle.js deploy/bindings.json

# Dev (mock LLM by default, separate test database):
python3 ~/workspace/show-recommender-tools/deploy_worker.py show-recommender-dev worker/bundle.js deploy/bindings-dev.json
```

## `bindings.json` — PRODUCTION. Do not add dev flags here.

Production bindings are ONLY the D1 database, the R2 bucket, and the
AI binding. In particular, NEVER add these to production bindings:

- `LLM_PROVIDER=mock` — would silently replace the real model with
  the deterministic mock for real users.
- `IS_DEV_WORKER=true` — would enable the dev-only provider override
  header and the DEV banner in the real app.

The code defaults to the real provider with no flags set, and the
override header is ignored without `IS_DEV_WORKER=true` (defense in
depth, unit-tested) — but the bindings are the first line of defense:
production must carry no dev configuration at all. After every
production deploy, verify `/api/health` shows the real provider and
`dev: false`.

Secrets (TMDB_READ_TOKEN) are set separately via the Cloudflare
dashboard/API and survive script uploads; they are not in these files.

## `bindings-dev.json` — DEV (`show-recommender-dev`)

- Own D1 database `show-recommender-dev` (`b1549e3a-…`) — test data
  never touches production data. Same migrations as production.
- Own R2 bucket `show-recommender-dev` — profile-icon uploads in dev
  stay in dev (full isolation; the poster cache is TMDB-fetched, not
  R2, so sharing it would save nothing).
- `LLM_PROVIDER=mock` — the dev default: zero neurons.
- `IS_DEV_WORKER=true` — enables the dev-only provider override header
  and the DEV banner/watermark in the UI.
- `LLM_MODEL` — the cheap 8B model used by the dev view's "cheap
  model" switch. Embeddings stay BGE-M3 (or mock). If the cheap model
  id is retired, update this value — no code change needed.

Dev still needs the `TMDB_READ_TOKEN` secret (same value as
production) for search/discover/detail calls; set it once in the
dashboard on the `show-recommender-dev` Worker. Without it, dev
search and list generation return empty results (the mock paths still
work). The secret value lives in the Secure Vault and cannot be
copied by automation — this is a one-time manual step.
