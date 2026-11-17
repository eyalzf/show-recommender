-- 0006: consolidation claims (claim-guard, 2026-11-17). One row per
-- in-flight consolidation, keyed by (profile, language): the INSERT
-- is a MUTEX — at most one consolidation per profile+language runs
-- at a time, whatever the input. The fingerprint check happens
-- INSIDE the mutex against freshly reloaded state (a fingerprint
-- check before claiming races: a run that loaded stale context
-- before another run's stamp, but claimed after its release, would
-- duplicate the save). input_hash is informational only (which
-- input the holder is working on). Rows are deleted when the run
-- finishes; claimed_at + TTL lets a crashed run's orphaned claim be
-- removed by the next attempt's cleanup DELETE. A separate table
-- (not a column on taste_summaries) because the first consolidation
-- of a profile has no summary row yet — and the first consolidation
-- is exactly the stampede-prone case (Preferences polling during
-- onboarding).
CREATE TABLE IF NOT EXISTS consolidation_claims (
  profile_id TEXT NOT NULL,
  ui_language TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, ui_language)
);
