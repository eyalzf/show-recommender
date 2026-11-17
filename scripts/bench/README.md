# LLM model benchmark suite

Compares Workers AI chat models on the app's two real LLM tasks —
taste consolidation and list re-ranking — to decide whether production
can move off Llama 3.3 70B and stay inside the 10,000-neuron daily
free allocation.

## Candidates

Rates: Cloudflare Workers AI pricing page (updated 2026-11-12), neurons
per million input/output tokens. All four survive the 20 Nov 2026 model
deprecation (official changelog, 5 Nov 2026).

| Model | In / Out per M |
|---|---|
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (reference) | 26,668 / 204,805 |
| `@cf/meta/llama-3.1-8b-instruct-fp8-fast` | 4,119 / 34,868 |
| `@cf/google/gemma-4-26b-a4b-it` | 9,091 / 27,273 |
| `@cf/zai-org/glm-4.7-flash` | 5,500 / 36,400 |

`@cf/qwen/qwen3-30b-a3b-fp8` is deliberately excluded (deprecated
20 Nov 2026). Note the 8B must be the `fp8-fast` variant — the plain
`-fp8` variant is also deprecated. Embeddings stay BGE-M3 (1,075/M —
negligible; a flat 5-neuron allowance per generation covers it).

## What it measures

Deterministic scoring only — no LLM-as-judge:

- **Consolidation** (5 cases, Hebrew + English): section routing
  (casual/deep/shared), sentiment inference from unlabelled wording,
  per-language nuance preservation, contradiction flagging, and
  ratings-always-Shared. Scored by keyword checks against the returned
  sections plus the contradictions array. Keyword scoring of free-form
  Hebrew is approximate — raw sections are saved in every report for
  human review.
- **Ranking** (1 case, mixed anchors): kind-fit compliance (heuristic
  kind of each surfaced show vs the list it landed in), cluster-cap
  compliance (≤3 per genre-ID cluster), all listed ids resolvable via
  TMDB (no invented shows), rationale presence, and Jaccard overlap
  with the 70B reference lists.

## What it cannot measure (HTTP observability limits)

The harness drives the dev Worker over HTTP and the Worker exposes no
raw LLM text, so these are out of reach without Worker instrumentation
(deliberately excluded — no Worker code changes for the bench):

- Raw model outputs — the harness saves full API responses instead.
- Dual-pass stability and raw JSON validity — the engine merges passes
  and falls back to retrieval order internally; only the end-to-end
  outcome is visible. Generation health (non-empty, non-stale lists)
  is the proxy.
- A fixed candidate set / invalid-ID trap — retrieval is server-side;
  the harness measures the final lists instead.

## Design: setup via D1, measurement via HTTP

Case inputs are seeded directly into the dev D1 (feedback rows +
taste summaries) so every model sees byte-identical inputs at zero
neuron cost, and every measured LLM call is an explicit API call the
ledger accounts for. Seeding via HTTP writes would fire one
event-driven consolidation per write and blow the budget. The
event-driven path itself is out of scope here (covered by the morning
verification run). All measurement goes through the HTTP API
(`POST /api/taste/consolidate`, `POST /api/lists/refresh`,
`GET /api/shows/:id`). Temp profiles are wiped via D1 afterwards and
the pre-existing profile list is asserted unchanged.

Model switching uses the Workers API: the live script is fetched and
re-uploaded byte-identical with only plain-text vars changed
(`LLM_PROVIDER=workers-ai` + `LLM_MODEL=<id>`). Bindings are
snapshotted first (settings API read-back), the secret binding is
verified present after every upload, and the mock config is restored
in a `finally` block and verified via settings + `/api/health`. There
is no per-request model override anywhere in the Worker, by design.
`LLM_RANK_MODEL` is never set on dev, so the rank model follows
`LLM_MODEL` and each flip measures one model on both tasks.

## Cost accounting

`measure.mjs` builds the exact consolidation prompts with the real
prompt builders (from each case's seed) and models rank/removal
prompts at the full 30/15-candidate pools with Hebrew labels. Tokens
are estimated as English chars/4 + Hebrew chars/2.5 (documented
heuristic in `lib.mjs`); assumed outputs are 300 (consolidation) /
400 (rank) / 30 (removal) tokens; a 1.15x safety factor is applied.
The runner refuses to start when the estimate exceeds the cap
(default 2,000), keeps a running ledger, hard-stops before any step
that would exceed it, and hard-stops on quota error 4006 or any 5xx
during a real run (restore + partial report).

Current suite estimate: ~1,711 neurons (margin ~289). The suite was
shrunk once to fit: an English genre-like consolidation case was
dropped as redundant (Shared routing is covered by three other
cases).

## Commands

```sh
# Estimate only (always safe, no network beyond the local helper)
python3 scripts/bench/run.py --estimate

# Verify the var-update mechanism (dummy var round-trip; no model flip)
python3 scripts/bench/run.py --probe-vars

# Full dry run against the mock provider (zero neurons; scores meaningless)
python3 scripts/bench/run.py --dry-run

# THE REAL RUN (after the quota reset; ~1,711 estimated neurons)
python3 scripts/bench/run.py --run
```

Options: `--cap N`, `--models <short names>`, `--out-dir <dir>`,
`--keep` (skip wiping, debugging only). Reports land in
`scripts/bench/results/<mode>-<timestamp>/` (`report.json` +
`report.md`) unless `--out-dir` says otherwise.

Unit tests: `node scripts/bench/test.mjs` (also wired into `npm test`).

## If a run dies mid-switch

The bindings snapshot is written to the run's output directory AND
`/tmp/bench-bindings-snapshot.json`. To restore by hand, re-upload the
dev Worker from the repo's bindings file (which carries
`LLM_PROVIDER=mock` and no `LLM_MODEL`):

```sh
npm run build
python3 ~/workspace/show-recommender-tools/deploy_worker.py \
  show-recommender-dev worker/bundle.js deploy/bindings.json
curl -s -A node https://show-recommender-dev.eyalzf.workers.dev/api/health
# expect: dev:true, llmProvider:"mock"
```
