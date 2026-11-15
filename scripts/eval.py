#!/usr/bin/env python3
"""Held-out evaluation + LLM-as-judge gate for the Show Recommender engine.

DEV-TIME ONLY. Not a user feature, not A/B testing, not interleaving:
with 2 users no online experiment can reach significance, so this is the
offline gate the industry-practices research recommends (report §2.13):
  (a) held-out ranking metrics — hide the most recent liked shows, check
      Recall/NDCG@10 against them, with the exposure-bias caveat stated;
  (b) LLM-as-judge pairwise comparison of the engine list vs a
      popularity baseline, with shuffled A/B tags and a swapped repeat.

The script creates a temporary profile, seeds it, generates lists,
measures, judges, and wipes the profile. It reports raw counts only —
no p-values, no "significance" language anywhere.

Usage:
    python3 scripts/eval.py [--base-url URL] [--keep]

Credentials: Cloudflare API calls (D1 cleanup, Workers AI judge) go
through the surrogate helper like the other tools in
~/workspace/show-recommender-tools/ — no token ever appears in this
file. The app API needs no auth (stub mode). The D1 database is
discovered by name; nothing is hardcoded.

Guardrail: the judge prompt contains ONLY user-authored text (the eval
note + liked titles) and show titles/years/genres — never TMDB
overviews/descriptions (same terms line as llm.ts).
"""

import argparse
import json
import math
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

CF_BASE = "https://api.cloudflare.com/client/v4"
CF_ALLOWED_HOSTS = ["api.cloudflare.com"]
DB_NAME = "show-recommender"
JUDGE_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"

# Seed set: well-known ensemble comedies. Held-out shows are NOT seeded —
# the engine must surface them from retrieval + ranking alone.
SEED_LIKES = ["Seinfeld", "Frasier", "Cheers", "The Office", "Parks and Recreation"]
SEED_DROPPED = "The Walking Dead"
HELD_OUT = ["Friends", "Brooklyn Nine-Nine", "Modern Family", "Community", "30 Rock"]
SEED_NOTE = "I love witty ensemble comedies with fast dialogue and running gags."


def app_request(base_url, method, path, body=None, timeout=60, retries=3):
    # Via curl, not urllib: Python's http.client hits IncompleteRead on
    # this workers.dev endpoint (responses truncate at the 8 KiB buffer
    # boundary), while curl reads them fine. Node-family UA: workers.dev
    # returns 403 error 1010 for Python-urllib UAs.
    import subprocess
    import time

    last_exc = None
    for attempt in range(retries):
        cmd = ["curl", "-sS", "-A", "node", "--max-time", str(timeout),
               "-w", "\n%{http_code}", "-X", method, base_url + path]
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
        if code != "200" and code != "201":
            raise RuntimeError(f"{method} {path} -> HTTP {code}: {payload[:300]}")
        try:
            return json.loads(payload)
        except json.JSONDecodeError as exc:
            last_exc = exc
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"{method} {path} failed after {retries} attempts: {last_exc}")


def cf_request(method, path, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"User-Agent": "muse-cloudflare-skill"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(CF_BASE + path, data=data, headers=headers, method=method)
    add_surrogate_to_request(req, "custom.cloudflare", entry_name="access_token", allowed_hosts=CF_ALLOWED_HOSTS)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return read_json_response(resp)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"CF {method} {path} -> HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')[:300]}") from exc


def d1_query(account_id, db_id, sql):
    res = cf_request("POST", f"/accounts/{account_id}/d1/database/{db_id}/query", {"sql": sql})
    if not res.get("success"):
        raise RuntimeError(f"D1 query failed: {res.get('errors')}")
    return res.get("result") or []


def normalize_title(s):
    return " ".join("".join(ch.lower() if ch.isalnum() or ch.isspace() else " " for ch in s).split())


def resolve_title(base_url, title):
    q = urllib.parse.quote(title)
    res = app_request(base_url, "GET", f"/api/search?q={q}&lang=en")
    wanted = normalize_title(title)
    for r in res.get("results", []):
        if normalize_title(r["title"]) == wanted or normalize_title(r["originalTitle"]) == wanted:
            return r["tmdbId"], r["title"]
    raise RuntimeError(f"could not resolve title via /api/search: {title}")


def recall_ndcg(ranked_ids, held_out_ids, k=10):
    top = ranked_ids[:k]
    hits = [i for i, tid in enumerate(top) if tid in held_out_ids]
    recall = len(hits) / len(held_out_ids) if held_out_ids else 0.0
    dcg = sum(1.0 / math.log2(i + 2) for i in hits)
    ideal = sum(1.0 / math.log2(i + 2) for i in range(min(len(held_out_ids), k)))
    return recall, (dcg / ideal if ideal else 0.0), [top[i] for i in hits]


def judge_lists(account_id, taste_text, list_a, list_b, label_a, label_b):
    def fmt(items):
        return "\n".join(f'- "{t}" ({y}) [{", ".join(g)}]' for t, y, g in items)

    prompt = {
        "messages": [
            {
                "role": "system",
                "content": "You judge which of two TV recommendation lists better matches a taste profile. "
                "Base your judgment ONLY on the taste description and the listed titles, years, and genres. "
                "Return ONLY a JSON object, no other text: {\"winner\": \"A\" or \"B\", \"reason\": \"one sentence\"}.",
            },
            {
                "role": "user",
                "content": f"Taste profile:\n{taste_text}\n\nList A ({label_a}):\n{fmt(list_a)}\n\n"
                f"List B ({label_b}):\n{fmt(list_b)}\n\nWhich list better matches the taste profile? Return the JSON.",
            },
        ],
        "max_tokens": 200,
    }
    res = cf_request("POST", f"/accounts/{account_id}/ai/run/{JUDGE_MODEL}", prompt)
    text = ((res.get("result") or {}).get("response") or "").strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None, f"unparseable judge output: {text[:120]}"
    try:
        parsed = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None, f"unparseable judge output: {text[:120]}"
    winner = parsed.get("winner")
    if winner not in ("A", "B"):
        return None, f"judge returned no winner: {text[:120]}"
    return winner, str(parsed.get("reason", ""))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="https://show-recommender.eyalzf.workers.dev")
    ap.add_argument("--keep", action="store_true", help="do not wipe the temp profile (debugging)")
    args = ap.parse_args()
    base = args.base_url.rstrip("/")

    print("== eval: resolving seed titles ==")
    likes = [resolve_title(base, t) for t in SEED_LIKES]
    dropped = resolve_title(base, SEED_DROPPED)
    held_out = [resolve_title(base, t) for t in HELD_OUT]
    print("likes:", likes)
    print("dropped:", dropped)
    print("held out:", held_out)

    print("== eval: creating temp profile ==")
    created = app_request(base, "POST", "/api/profiles", {
        "name": "Eval Temp", "languages": ["en"], "uiLanguage": "en",
        "iconKind": "initials", "iconRef": None,
    })
    profile_id = created["profile"]["id"]
    print("profile:", profile_id)

    try:
        for tmdb_id, title in likes:
            app_request(base, "POST", "/api/feedback", {
                "profileId": profile_id, "tmdbId": tmdb_id, "showTitle": title,
                "originalLanguage": "en", "rating": "liked", "reason": "",
            })
        app_request(base, "POST", "/api/feedback", {
            "profileId": profile_id, "tmdbId": dropped[0], "showTitle": dropped[1],
            "originalLanguage": "en", "rating": "dropped", "reason": "too grim",
        })
        app_request(base, "POST", "/api/notes", {
            "profileId": profile_id, "kind": "like", "text": SEED_NOTE,
        })

        print("== eval: generating lists (this takes up to ~1 min) ==")
        lists = app_request(base, "POST", "/api/lists/refresh", {
            "profileId": profile_id, "lang": "en",
        }, timeout=240)
        casual_ids = [i["tmdbId"] for i in lists["casual"]]
        deep_ids = [i["tmdbId"] for i in lists["deep"]]
        print(f"casual ({len(casual_ids)}): {[i['title'] for i in lists['casual']]}")
        print(f"deep ({len(deep_ids)}): {[i['title'] for i in lists['deep']]}")

        held_ids = {tid for tid, _ in held_out}
        print("== eval: held-out metrics (Recall@10 / NDCG@10, binary relevance) ==")
        for name, ids in (("casual", casual_ids), ("deep", deep_ids)):
            recall, ndcg, hits = recall_ndcg(ids, held_ids)
            print(f"{name}: Recall@10={recall:.2f} NDCG@10={ndcg:.2f} hits={hits}")
        union = list(dict.fromkeys(casual_ids + deep_ids))
        recall, ndcg, hits = recall_ndcg(union, held_ids, k=20)
        print(f"union(top 20): Recall@20={recall:.2f} NDCG@20={ndcg:.2f} hits={hits}")
        print("CAVEAT (exposure bias): held-out shows are ones the profile already knows; "
              "retrieval may never surface them, and a low score does not mean the lists are bad. "
              "This is a gate for regressions, not a decision metric.")

        print("== eval: LLM-as-judge (engine vs popularity baseline, swapped labels) ==")
        picks = app_request(base, "GET", f"/api/quick-picks?profileId={profile_id}&lang=en")
        baseline = [(r["title"], (r["firstAirDate"] or "")[:4], r["genres"]) for r in picks["results"][:10]]
        engine = [(i["title"], str(i["firstYear"] or ""), i["genres"]) for i in lists["casual"]]
        taste_text = SEED_NOTE + "\nLiked: " + ", ".join(t for _, t in likes) + "."
        accounts = cf_request("GET", "/accounts?per_page=50").get("result") or []
        if len(accounts) != 1:
            raise RuntimeError(f"expected exactly 1 Cloudflare account, found {len(accounts)}")
        account_id = accounts[0]["id"]
        try:
            w1, r1 = judge_lists(account_id, taste_text, engine, baseline, "engine", "popularity")
            w2, r2 = judge_lists(account_id, taste_text, baseline, engine, "popularity", "engine")
        except RuntimeError as exc:
            # The Cloudflare API token may lack Workers AI permission
            # (HTTP 401, code 10000 — the same failure D1 calls gave
            # before D1:Edit was added to the token). The judge step is
            # then unavailable, but the materials print below so the
            # check can run by hand or once the token gains permission.
            print(f"judge step unavailable: {exc}")
            print("judge materials (taste + lists) for a manual run:")
            print("TASTE:", taste_text)
            print("ENGINE:", [t for t, _, _ in engine])
            print("BASELINE:", [t for t, _, _ in baseline])
            w1 = w2 = None
            r1 = r2 = "judge unavailable"
        # Map both verdicts back to engine-vs-baseline.
        v1 = {"A": "engine", "B": "popularity"}.get(w1) if w1 else None
        v2 = {"A": "popularity", "B": "engine"}.get(w2) if w2 else None
        print(f"run 1 (engine=A): winner={v1} reason={r1}")
        print(f"run 2 (engine=B): winner={v2} reason={r2}")
        if v1 and v2:
            print("agreement:", "yes" if v1 == v2 else "NO — order-sensitive, treat as inconclusive")
        else:
            print("agreement: inconclusive (a judge call failed to parse or was unavailable)")
    finally:
        if args.keep:
            print(f"--keep: temp profile {profile_id} left in place")
            return
        print("== eval: wiping temp profile ==")
        accounts = cf_request("GET", "/accounts?per_page=50").get("result") or []
        account_id = accounts[0]["id"]
        dbs = cf_request("GET", f"/accounts/{account_id}/d1/database?name={DB_NAME}&per_page=10").get("result") or []
        db_id = next((d["uuid"] for d in dbs if d["name"] == DB_NAME), None)
        if not db_id:
            raise RuntimeError("D1 database not found by name; temp profile NOT wiped: " + profile_id)
        pid = profile_id.replace("'", "''")
        for sql in [
            f"DELETE FROM recommendation_people WHERE recommendation_id IN (SELECT id FROM external_recommendations WHERE profile_id = '{pid}')",
            f"DELETE FROM external_recommendations WHERE profile_id = '{pid}'",
            f"DELETE FROM feedback_log WHERE profile_id = '{pid}'",
            f"DELETE FROM deny_list WHERE profile_id = '{pid}'",
            f"DELETE FROM taste_summaries WHERE profile_id = '{pid}'",
            f"DELETE FROM taste_summary_history WHERE profile_id = '{pid}'",
            f"DELETE FROM recommendation_lists WHERE profile_id = '{pid}'",
            f"DELETE FROM adhoc_history WHERE profile_id = '{pid}'",
            f"DELETE FROM profiles WHERE id = '{pid}'",
        ]:
            d1_query(account_id, db_id, sql)
        left = d1_query(account_id, db_id, f"SELECT COUNT(*) AS c FROM feedback_log WHERE profile_id = '{pid}'")
        try:
            remaining = left[0]["results"][0]["c"]
        except (KeyError, IndexError, TypeError):
            remaining = f"unparsed: {left}"
        print("feedback rows remaining for temp profile:", remaining)
        print("temp profile wiped")


if __name__ == "__main__":
    main()
