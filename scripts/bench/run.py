#!/usr/bin/env python3
"""LLM model benchmark runner for the Show Recommender app.

Compares candidate Workers AI chat models on the app's two real LLM
tasks — taste consolidation and list re-ranking — by driving the DEV
Worker over HTTP, switching its model via Workers API env-var updates
between runs, and scoring the recorded API responses deterministically
(no LLM-as-judge).

MODES:
  --estimate    Print the pre-flight neuron estimate and exit (no HTTP
                except the local measure helper; always safe).
  --dry-run     Full end-to-end run against the mock provider: no Worker
                config changes, zero neurons. Validates mechanics only;
                mock quality scores are meaningless.
  --run         The real benchmark. Switches the dev Worker between
                models, runs all cases, restores the mock config.
  --probe-vars  Verify the var-update mechanism with a harmless dummy
                var round-trip (set, read back, restore). No model flip.

SAFETY:
  * Dev Worker ONLY (URL hardcoded; health dev flag asserted).
  * Bindings are snapshotted before any switch and restored in a
    finally block; the snapshot is also written to /tmp for manual
    recovery. Restore is verified via the settings API + /api/health.
  * Pre-flight estimate must fit the cap (default 2,000 neurons) or the
    run refuses to start. A running ledger hard-stops the run if the
    next step would exceed the cap, and any quota/5xx error during a
    real run stops it immediately (restore + partial report).
  * Every temp profile is wiped via D1 afterwards; the pre-existing
    profile list is asserted unchanged at the end.

SETUP vs MEASUREMENT: case inputs are seeded via D1 (zero neurons,
byte-identical inputs per model) and every measurement goes through
the HTTP API (POST /api/taste/consolidate, POST /api/lists/refresh,
GET /api/shows/:id). The event-driven consolidation path is out of
scope here — it is covered by the morning verification run. Raw LLM
text is not observable through the HTTP API, so the harness records
full API responses instead (see README.md).

Credentials: Cloudflare API calls go through the surrogate helper like
the other tools in ~/workspace/show-recommender-tools/ — no token ever
appears in this file. The app API needs no auth (stub mode).
"""

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
DEV_BASE = "https://show-recommender-dev.eyalzf.workers.dev"
SCRIPT_NAME = "show-recommender-dev"
ACCOUNT_ID = "3903e7cd24b94405b411952b3bcaf749"
DB_NAME = "show-recommender-dev"
CF_BASE = "https://api.cloudflare.com/client/v4"
CF_ALLOWED_HOSTS = ["api.cloudflare.com"]
BINDINGS_FILE = REPO_ROOT / "deploy" / "bindings-dev.json"
DEFAULT_CAP = 2000


class BenchError(RuntimeError):
    pass


class QuotaStop(BenchError):
    """Quota exhaustion (or an indistinguishable 5xx) during a real run."""


class CapStop(BenchError):
    """The next step would exceed the neuron cap."""


# ------------------------------------------------------------------ CF API

def cf_call(method, path, body=None, content_type=None, raw=False):
    headers = {"User-Agent": "muse-cloudflare-skill"}
    if content_type:
        headers["Content-Type"] = content_type
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        headers.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(CF_BASE + path, data=data, headers=headers, method=method)
    add_surrogate_to_request(req, "custom.cloudflare", entry_name="access_token",
                             allowed_hosts=CF_ALLOWED_HOSTS)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            if raw:
                return resp.status, resp.headers, resp.read()
            return read_json_response(resp)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise BenchError(f"CF {method} {path} -> HTTP {exc.code}: {detail}") from exc


def d1_query(db_id, sql):
    res = cf_call("POST", f"/accounts/{ACCOUNT_ID}/d1/database/{db_id}/query", {"sql": sql})
    if not res.get("success"):
        raise BenchError(f"D1 query failed: {res.get('errors')} :: {sql[:200]}")
    return res.get("result") or []


def discover_db_id():
    dbs = cf_call("GET", f"/accounts/{ACCOUNT_ID}/d1/database?name={DB_NAME}&per_page=10").get("result") or []
    db_id = next((d["uuid"] for d in dbs if d["name"] == DB_NAME), None)
    if not db_id:
        raise BenchError(f"D1 database {DB_NAME!r} not found")
    return db_id


# -------------------------------------------------------------- app HTTP

def app_request(method, path, body=None, timeout=60, retries=3):
    # Via curl, not urllib: Python's http.client truncates workers.dev
    # responses at the 8 KiB buffer boundary, and workers.dev 403s
    # Python-urllib UAs (error 1010). Same pattern as scripts/eval.py.
    last_exc = None
    for attempt in range(retries):
        cmd = ["curl", "-sS", "-A", "node", "--max-time", str(timeout),
               "-w", "\n%{http_code}", "-X", method, DEV_BASE + path]
        if body is not None:
            cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10)
        except Exception as exc:  # noqa: BLE001 - retry transient transport errors
            last_exc = exc
            time.sleep(2 * (attempt + 1))
            continue
        if out.returncode != 0:
            last_exc = RuntimeError(f"curl rc={out.returncode}: {out.stderr[:200]}")
            time.sleep(2 * (attempt + 1))
            continue
        payload, _, code = out.stdout.rpartition("\n")
        if code not in ("200", "201"):
            raise BenchError(f"{method} {path} -> HTTP {code}: {payload[:300]}")
        try:
            return json.loads(payload)
        except json.JSONDecodeError as exc:
            last_exc = exc
            time.sleep(2 * (attempt + 1))
    raise BenchError(f"{method} {path} failed after {retries} attempts: {last_exc}")


def get_health():
    return app_request("GET", "/api/health", timeout=30)


# --------------------------------------------------------- worker admin

def normalize_bindings(bindings):
    """Server-added fields (project/id) stripped; secrets kept as markers."""
    norm = {}
    for b in bindings:
        entry = {"type": b["type"]}
        if b["type"] == "plain_text":
            entry["text"] = b.get("text")
        elif b["type"] == "d1":
            entry["database_id"] = b.get("database_id")
        elif b["type"] == "r2_bucket":
            entry["bucket_name"] = b.get("bucket_name")
        norm[b["name"]] = entry
    return norm


def get_live_bindings():
    res = cf_call("GET", f"/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}/settings")
    result = res.get("result") or {}
    return result.get("compatibility_date"), result.get("bindings") or []


def get_script_code():
    _status, headers, raw = cf_call(
        "GET", f"/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}", raw=True)
    ctype = headers.get("Content-Type", "")
    boundary = None
    for part in ctype.split(";"):
        part = part.strip()
        if part.startswith("boundary="):
            boundary = part.split("=", 1)[1].strip().strip('"')
    if not boundary:
        raise BenchError("GET script: no multipart boundary in response")
    sep = ("--" + boundary).encode()
    for chunk in raw.split(sep):
        if b'name="worker.js"' not in chunk:
            continue
        _head, _, body = chunk.partition(b"\r\n\r\n")
        code = body[:-2] if body.endswith(b"\r\n") else body
        text = code.decode("utf-8")
        if len(text) < 100_000:
            raise BenchError(f"extracted worker.js implausibly short: {len(text)} chars")
        for marker in ("llama-3.3-70b", "api/health"):
            if marker not in text:
                raise BenchError(f"extracted worker.js lacks marker {marker!r}; refusing to upload")
        return text
    raise BenchError("GET script: no worker.js part in multipart response")


def upload_script(code, bindings, compatibility_date):
    metadata = {
        "main_module": "worker.js",
        "compatibility_date": compatibility_date,
        "bindings": bindings,
    }
    boundary = "----benchform" + uuid.uuid4().hex
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n'
        f"Content-Type: application/json\r\n\r\n{json.dumps(metadata)}\r\n",
        f'--{boundary}\r\nContent-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n'
        f"Content-Type: application/javascript+module\r\n\r\n{code}\r\n",
        f"--{boundary}--\r\n",
    ]
    data = cf_call(
        "PUT",
        f"/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}",
        body="".join(parts).encode("utf-8"),
        content_type=f"multipart/form-data; boundary={boundary}",
    )
    if not data.get("success"):
        raise BenchError(f"script upload failed: {json.dumps(data)[:400]}")


def with_vars(base_bindings, var_map):
    """Return base bindings with plain_text vars replaced/added per var_map.
    A None value removes the var."""
    out = [dict(b) for b in base_bindings if b["name"] not in var_map]
    for name, value in var_map.items():
        if value is not None:
            out.append({"name": name, "text": value, "type": "plain_text"})
    return out


def wait_for_health(predicate, description, timeout=120):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = get_health()
        except BenchError as exc:
            last = {"error": str(exc)}
        else:
            if not last.get("dbBound") or not last.get("tmdbConfigured"):
                raise BenchError(f"health check unsafe after upload: {last}")
            if predicate(last):
                return last
        time.sleep(5)
    raise BenchError(f"timed out waiting for health: {description}; last={last}")


def wait_for_bindings(predicate, description, timeout=90):
    """Poll the settings read-back until the predicate holds. Binding
    changes propagate a few seconds behind a successful upload, so a
    single immediate read can still show the previous version."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            _date, live = get_live_bindings()
            last = normalize_bindings(live)
        except BenchError as exc:
            last = {"error": str(exc)}
        else:
            if predicate(last):
                return last
        time.sleep(5)
    raise BenchError(f"timed out waiting for bindings: {description}; last={last}")


class WorkerSwitch:
    """Snapshot / switch / restore for the dev Worker's env vars.

    The script code is re-uploaded byte-identical (fetched via the API);
    only plain_text vars change. Secrets (TMDB_READ_TOKEN) are never
    in the upload metadata and are verified present after every upload.
    """

    def __init__(self):
        self.compatibility_date = None
        self.code = None
        self.base_bindings = None
        self.snapshot_norm = None

    def snapshot(self):
        self.compatibility_date, live = get_live_bindings()
        self.snapshot_norm = normalize_bindings(live)
        if "TMDB_READ_TOKEN" not in self.snapshot_norm:
            raise BenchError("snapshot: TMDB_READ_TOKEN secret binding missing; refusing to proceed")
        self.base_bindings = json.loads(BINDINGS_FILE.read_text(encoding="utf-8"))
        live_nosecret = {k: v for k, v in self.snapshot_norm.items() if k != "TMDB_READ_TOKEN"}
        if normalize_bindings(self.base_bindings) != live_nosecret:
            raise BenchError(
                "live bindings drifted from deploy/bindings-dev.json; refusing to switch.\n"
                f"live={json.dumps(live_nosecret, sort_keys=True)}\n"
                f"file={json.dumps(normalize_bindings(self.base_bindings), sort_keys=True)}")
        self.code = get_script_code()
        return self.snapshot_norm

    def _upload_and_verify(self, bindings, expect_vars, health_predicate, description):
        upload_script(self.code, bindings, self.compatibility_date)

        def bindings_ok(norm):
            if "TMDB_READ_TOKEN" not in norm:
                return False
            return all(norm.get(name, {}).get("text") == value for name, value in expect_vars.items())

        norm = wait_for_bindings(bindings_ok, f"vars after {description}")
        if "TMDB_READ_TOKEN" not in norm:
            raise BenchError("TMDB_READ_TOKEN secret binding LOST after upload; STOP — re-set it in the dashboard")
        return wait_for_health(health_predicate, description)

    def switch_to_model(self, model):
        bindings = with_vars(self.base_bindings, {
            "LLM_PROVIDER": "workers-ai",
            "LLM_MODEL": model["id"],
        })
        self._upload_and_verify(
            bindings,
            {"LLM_PROVIDER": "workers-ai", "LLM_MODEL": model["id"]},
            lambda h: model["marker"] in str(h.get("llmProvider")),
            f"model {model['short']}",
        )

    def switch_to_dummy(self, var_name, value):
        bindings = with_vars(self.base_bindings, {var_name: value})
        self._upload_and_verify(
            bindings,
            {var_name: value, "LLM_PROVIDER": "mock"},
            lambda h: h.get("llmProvider") == "mock",
            f"dummy var {var_name}",
        )

    def restore(self):
        self._upload_and_verify(
            self.base_bindings,
            {"LLM_PROVIDER": "mock"},
            lambda h: h.get("llmProvider") == "mock",
            "restore mock",
        )
        want = {k: v for k, v in self.snapshot_norm.items() if k != "TMDB_READ_TOKEN"}

        def restored(norm):
            live_nosecret = {k: v for k, v in norm.items() if k != "TMDB_READ_TOKEN"}
            return live_nosecret == want

        wait_for_bindings(restored, "restore matches snapshot")


# ------------------------------------------------------------------- D1

def sql_escape(value):
    return str(value).replace("'", "''")


def seed_profile(db_id, profile_id, case, kind):
    """Insert the case's fixed inputs directly (no HTTP writes, so no
    event-driven consolidation fires — every measured LLM call is an
    explicit API call the ledger accounts for)."""
    now = int(time.time() * 1000)
    seq = [0]

    def ts():
        seq[0] += 1
        return now + seq[0] * 1000

    seed = case["seed"]
    for r in seed.get("ratings", []):
        d1_query(db_id,
                 "INSERT INTO feedback_log (id, profile_id, kind, tmdb_id, show_title, rating, text, "
                 f"original_language, created_at) VALUES ('{uuid.uuid4()}', '{profile_id}', 'show', "
                 f"{int(r['tmdbId'])}, '{sql_escape(r['showTitle'])}', '{sql_escape(r['rating'])}', "
                 f"'{sql_escape(r.get('text', ''))}', '{sql_escape(r.get('originalLanguage', ''))}', {ts()})")
    for text in seed.get("notes", []):
        d1_query(db_id,
                 "INSERT INTO feedback_log (id, profile_id, kind, tmdb_id, show_title, rating, text, "
                 f"created_at) VALUES ('{uuid.uuid4()}', '{profile_id}', 'note', NULL, NULL, 'note', "
                 f"'{sql_escape(text)}', {ts()})")
    sections = seed.get("tasteSections") or seed.get("existingSummary")
    if sections:
        shared = (sections.get("shared") or "").strip()
        casual = (sections.get("casual") or "").strip()
        deep = (sections.get("deep") or "").strip()
        # Mirrors util.serializeTasteSummary: plain text when only Shared.
        summary_text = shared if not casual and not deep else json.dumps(
            {"v": 1, "shared": shared, "casual": casual, "deep": deep}, ensure_ascii=False)
        d1_query(db_id,
                 "INSERT INTO taste_summaries (profile_id, ui_language, summary_text, updated_at) "
                 f"VALUES ('{profile_id}', '{case['uiLang']}', '{sql_escape(summary_text)}', {ts()}) "
                 "ON CONFLICT(profile_id, ui_language) DO UPDATE SET summary_text = excluded.summary_text, "
                 "updated_at = excluded.updated_at")


WIPE_STMTS = [
    "DELETE FROM people_scores WHERE profile_id = '{pid}'",
    "DELETE FROM recommendation_people WHERE recommendation_id IN "
    "(SELECT id FROM external_recommendations WHERE profile_id = '{pid}')",
    "DELETE FROM external_recommendations WHERE profile_id = '{pid}'",
    "DELETE FROM feedback_log WHERE profile_id = '{pid}'",
    "DELETE FROM deny_list WHERE profile_id = '{pid}'",
    "DELETE FROM taste_summaries WHERE profile_id = '{pid}'",
    "DELETE FROM taste_summary_history WHERE profile_id = '{pid}'",
    "DELETE FROM recommendation_lists WHERE profile_id = '{pid}'",
    "DELETE FROM adhoc_history WHERE profile_id = '{pid}'",
    "DELETE FROM profiles WHERE id = '{pid}'",
]


def wipe_profile(db_id, profile_id):
    pid = profile_id.replace("'", "''")
    for stmt in WIPE_STMTS:
        d1_query(db_id, stmt.format(pid=pid))
    left = d1_query(db_id, f"SELECT COUNT(*) AS c FROM feedback_log WHERE profile_id = '{pid}'")
    remaining = left[0]["results"][0]["c"]
    if remaining != 0:
        raise BenchError(f"wipe failed: {remaining} feedback rows remain for {profile_id}")


# ---------------------------------------------------------------- runner

def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def run_measure(cap):
    out = subprocess.run(
        ["node", str(HERE / "measure.mjs"), str(HERE / "cases.json"), str(HERE / "models.json"),
         "--cap", str(cap)],
        capture_output=True, text=True, timeout=120)
    if out.returncode != 0 and not out.stdout.strip():
        raise BenchError(f"measure.mjs failed: {out.stderr[:300]}")
    return json.loads(out.stdout)


def run_scorer(doc, out_path):
    doc_path = out_path / "score-input.json"
    doc_path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    out = subprocess.run(
        ["node", str(HERE / "score.mjs"), str(doc_path)],
        capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise BenchError(f"score.mjs failed: {out.stderr[:300]}")
    return json.loads(out.stdout)


def is_quota_error(text):
    lowered = text.lower()
    return "4006" in lowered or "quota" in lowered or "exceeded" in lowered


class Runner:
    def __init__(self, args):
        self.args = args
        self.cases = load_json(HERE / "cases.json")
        self.models_doc = load_json(HERE / "models.json")
        self.models = self.models_doc["models"]
        if args.models:
            wanted = {s.strip() for s in args.models.split(",")}
            self.models = [m for m in self.models if m["short"] in wanted or m["id"] in wanted]
            if not self.models:
                raise BenchError(f"--models matched nothing: {args.models}")
        self.estimate = None
        self.spent = 0.0
        self.runs = []
        self.db_id = None
        self.start_profiles = None
        self.out_dir = None
        self.switch = None

    # ------------------------------------------------------------ ledger
    def step_cost(self, model_id, case_id):
        return self.estimate["perModel"][model_id]["byCase"][case_id]

    def charge(self, model_id, case_id):
        cost = self.step_cost(model_id, case_id)
        if self.spent + cost > self.args.cap:
            raise CapStop(
                f"next step ({model_id} / {case_id}, ~{cost:.0f} neurons) would exceed "
                f"the {self.args.cap} cap (spent ~{self.spent:.0f})")
        self.spent += cost
        return cost

    # ------------------------------------------------------------ cases
    def create_profile(self, case, model_short):
        name = f"bench-{case['id']}-{model_short}"[:60]
        created = app_request("POST", "/api/profiles", {
            "name": name, "languages": case["languages"], "uiLanguage": case["uiLang"],
            "iconKind": "initials", "iconRef": None,
        })
        return created["profile"]["id"]

    def run_consolidation(self, model, case):
        cost = self.charge(model["id"], case["id"])
        profile_id = self.create_profile(case, model["short"])
        try:
            seed_profile(self.db_id, profile_id, case, "consolidation")
            try:
                resp = app_request("POST", "/api/taste/consolidate", {
                    "profileId": profile_id, "lang": case["uiLang"],
                }, timeout=120, retries=1)
            except BenchError as exc:
                if self.args.mode == "run" and (is_quota_error(str(exc)) or "HTTP 5" in str(exc)):
                    raise QuotaStop(f"consolidation failed, treating as quota stop: {exc}") from exc
                raise
            if self.args.mode == "run" and model["marker"] not in str(resp.get("provider")):
                raise BenchError(
                    f"provider mismatch: expected marker {model['marker']!r}, got {resp.get('provider')!r}")
            self.runs.append({"modelId": model["id"], "caseId": case["id"], "kind": "consolidation",
                              "response": resp, "details": {}, "profileId": profile_id,
                              "estimatedCost": cost})
            print(f"  [{model['short']}] {case['id']}: provider={resp.get('provider')} "
                  f"sections={ {k: (len(v or '')) for k, v in (resp.get('sections') or {}).items()} } "
                  f"contradictions={len(resp.get('contradictions') or [])}")
        finally:
            if not self.args.keep:
                wipe_profile(self.db_id, profile_id)

    def run_ranking(self, model, case):
        cost = self.charge(model["id"], case["id"])
        profile_id = self.create_profile(case, model["short"])
        try:
            seed_profile(self.db_id, profile_id, case, "ranking")
            try:
                resp = app_request("POST", "/api/lists/refresh", {
                    "profileId": profile_id, "lang": case["uiLang"],
                }, timeout=240, retries=1)
            except BenchError as exc:
                if self.args.mode == "run" and (is_quota_error(str(exc)) or "HTTP 5" in str(exc)):
                    raise QuotaStop(f"generation failed, treating as quota stop: {exc}") from exc
                raise
            ids = {i["tmdbId"] for kind in ("casual", "deep") for i in (resp.get(kind) or [])}
            details = {}
            for tid in sorted(ids):
                try:
                    show = app_request("GET", f"/api/shows/{tid}?lang=en", timeout=60)["show"]
                    details[tid] = show.get("genreIds") or []
                except BenchError as exc:
                    print(f"  warning: detail fetch failed for {tid}: {exc}")
            self.runs.append({"modelId": model["id"], "caseId": case["id"], "kind": "ranking",
                              "response": resp, "details": details, "profileId": profile_id,
                              "estimatedCost": cost})
            print(f"  [{model['short']}] {case['id']}: casual={len(resp.get('casual') or [])} "
                  f"deep={len(resp.get('deep') or [])} stale={resp.get('stale')}")
        finally:
            if not self.args.keep:
                wipe_profile(self.db_id, profile_id)

    # ------------------------------------------------------------ modes
    def prepare(self):
        health = get_health()
        if not health.get("dev"):
            raise BenchError(f"refusing: {DEV_BASE} does not report dev=true: {health}")
        if self.args.mode == "run" and health.get("llmProvider") != "mock":
            raise BenchError(f"refusing: dev Worker is not in mock mode before the run: {health}")
        self.db_id = discover_db_id()
        profiles = app_request("GET", "/api/profiles", timeout=30)
        self.start_profiles = {p["id"] for p in profiles.get("profiles", [])}
        print(f"pre-existing profiles: {len(self.start_profiles)} (must be unchanged at the end)")
        self.estimate = run_measure(self.args.cap)
        print(f"estimate: total ~{self.estimate['total']:.0f} neurons "
              f"(cap {self.args.cap}, margin ~{self.estimate['margin']:.0f})")
        if not self.estimate["fits"]:
            raise BenchError("estimate exceeds the cap; shrink the suite (see README) and re-run --estimate")
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        self.out_dir = Path(self.args.out_dir or (HERE / "results" / f"{self.args.mode}-{stamp}"))
        self.out_dir.mkdir(parents=True, exist_ok=True)

    def verify_profiles_unchanged(self):
        if self.args.keep:
            print("--keep: profile-list check skipped")
            return
        profiles = app_request("GET", "/api/profiles", timeout=30)
        now = {p["id"] for p in profiles.get("profiles", [])}
        if now != self.start_profiles:
            raise BenchError(f"profile list changed: added={now - self.start_profiles} "
                             f"removed={self.start_profiles - now}")

    def write_report(self, scores, stopped_reason):
        report = {
            "mode": self.args.mode,
            "cap": self.args.cap,
            "estimatedSpent": round(self.spent, 1),
            "estimate": self.estimate,
            "stoppedReason": stopped_reason,
            "scores": scores,
            "runs": self.runs,
        }
        (self.out_dir / "report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        lines = [
            f"# Bench report — {self.args.mode}",
            "",
            f"Cap: {self.args.cap} estimated neurons. Estimated spent: ~{self.spent:.0f}.",
        ]
        if stopped_reason:
            lines += ["", f"STOPPED EARLY: {stopped_reason}"]
        if self.args.mode == "dry-run":
            lines += ["", "DRY RUN against the mock provider: quality scores below are MEANINGLESS "
                      "(the mock echoes inputs); only mechanics + the cost estimate were validated."]
        if scores:
            lines += ["", "## Per-model summary", ""]
            for m in self.models:
                s = scores["perModel"].get(m["id"], {})
                lines.append(
                    f"- **{m['short']}**: consolidation {s.get('consolidationMean', 0):.2f}, "
                    f"routing {s.get('routingAccuracy', 0):.2f}, "
                    f"sentiment {s.get('sentimentAccuracy', 0):.2f}, "
                    f"contradiction {s.get('contradictionDetection', 0):.2f}, "
                    f"kind-fit {s.get('rankingKindFit', 0):.2f}, "
                    f"cluster-cap {s.get('clusterCapCompliance', 0):.2f}, "
                    f"overlap-vs-ref {s.get('overlapVsReference')}")
        lines += ["", "## Runs", ""]
        for run in self.runs:
            lines.append(f"### {run['modelId'].split('/')[-1]} / {run['caseId']} (~{run['estimatedCost']:.0f})")
            if run["kind"] == "consolidation":
                secs = run["response"].get("sections") or {}
                for key in ("shared", "casual", "deep"):
                    lines.append(f"- {key}: {secs.get(key, '')!r}")
                lines.append(f"- contradictions: {json.dumps(run['response'].get('contradictions'), ensure_ascii=False)}")
            else:
                for kind in ("casual", "deep"):
                    titles = [i.get("title") for i in (run["response"].get(kind) or [])]
                    lines.append(f"- {kind} ({len(titles)}): {titles}")
            lines.append("")
        lines += ["## Caveats",
                  "",
                  "- Estimates use real prompt builders + assumed outputs (300/400/30 tokens) + 1.15x safety factor; see README.",
                  "- Raw LLM text is not observable via the HTTP API; scores come from parsed API responses.",
                  "- Dual-pass stability and raw JSON validity are not measurable without Worker instrumentation (excluded).",
                  ""]
        (self.out_dir / "report.md").write_text("\n".join(lines), encoding="utf-8")
        print(f"report: {self.out_dir / 'report.md'}")

    def run_cases_for_model(self, model):
        for case in self.cases["consolidation"]:
            self.run_consolidation(model, case)
        for case in self.cases["ranking"]:
            self.run_ranking(model, case)

    def execute(self):
        stopped_reason = None
        self.prepare()
        if self.args.mode == "run":
            self.switch = WorkerSwitch()
            snapshot = self.switch.snapshot()
            snap_path = self.out_dir / "bindings-snapshot.json"
            snap_path.write_text(json.dumps(snapshot, indent=2, sort_keys=True), encoding="utf-8")
            Path("/tmp/bench-bindings-snapshot.json").write_text(
                json.dumps(snapshot, indent=2, sort_keys=True), encoding="utf-8")
            print(f"bindings snapshot: {snap_path} (+ /tmp copy)")
        try:
            for model in self.models:
                if self.args.mode == "run":
                    print(f"== switching to {model['short']} ==")
                    self.switch.switch_to_model(model)
                print(f"== cases: {model['short']} ==")
                self.run_cases_for_model(model)
        except (QuotaStop, CapStop) as exc:
            stopped_reason = str(exc)
            print(f"STOP: {exc}")
        finally:
            if self.args.mode == "run":
                print("== restoring mock config ==")
                try:
                    self.switch.restore()
                except BenchError as exc:
                    print(f"RESTORE FAILED: {exc}")
                    print("Manual recovery: re-upload the dev Worker from deploy/bindings-dev.json "
                          "via deploy_worker.py, then verify /api/health shows llmProvider=mock.")
                    if not stopped_reason:
                        stopped_reason = f"restore failed: {exc}"
                    else:
                        stopped_reason += f" | restore failed: {exc}"
                else:
                    print("mock config restored + verified")
        self.verify_profiles_unchanged()
        scores = None
        if self.runs:
            try:
                scores = run_scorer(
                    {"cases": self.cases, "models": self.models_doc, "runs": self.runs},
                    self.out_dir)
            except BenchError as exc:
                print(f"scoring failed (raw data kept): {exc}")
        self.write_report(scores, stopped_reason)
        return 0 if stopped_reason is None else 1


def probe_vars():
    """Harmless var round-trip: set a dummy var, read back, restore."""
    health = get_health()
    if not health.get("dev") or health.get("llmProvider") != "mock":
        raise BenchError(f"refusing probe: unexpected health: {health}")
    switch = WorkerSwitch()
    snapshot = switch.snapshot()
    print("snapshot ok; bindings match deploy/bindings-dev.json; secret present")
    try:
        switch.switch_to_dummy("BENCH_PROBE", "1")
        _date, live = get_live_bindings()
        norm = normalize_bindings(live)
        assert norm["BENCH_PROBE"]["text"] == "1", norm
        assert norm["LLM_PROVIDER"]["text"] == "mock", norm
        assert "TMDB_READ_TOKEN" in norm, norm
        print("round-trip set verified: BENCH_PROBE=1 present, LLM_PROVIDER still mock, secret present")
    finally:
        switch.restore()
        print("restore verified: dummy var gone, bindings match snapshot, health shows mock")
    print("PROBE PASS: var-update mechanism works end to end (no model flip, no AI calls)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--estimate", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--run", action="store_true")
    mode.add_argument("--probe-vars", action="store_true")
    ap.add_argument("--cap", type=int, default=DEFAULT_CAP)
    ap.add_argument("--models", help="comma-separated model short names or ids (default: all)")
    ap.add_argument("--out-dir", help="report directory (default: scripts/bench/results/<mode>-<ts>)")
    ap.add_argument("--keep", action="store_true", help="do not wipe temp profiles (debugging)")
    args = ap.parse_args()
    args.mode = "estimate" if args.estimate else "dry-run" if args.dry_run else "run" if args.run else "probe-vars"

    if args.mode == "estimate":
        est = run_measure(args.cap)
        print(f"total ~{est['total']:.0f} neurons (cap {args.cap}, margin ~{est['margin']:.0f})")
        for mid, m in est["perModel"].items():
            print(f"  {mid.split('/')[-1]}: ~{m['total']:.0f}")
        return 0 if est["fits"] else 2
    if args.mode == "probe-vars":
        probe_vars()
        return 0
    runner = Runner(args)
    return runner.execute()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BenchError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
