-- 0005: consolidation input fingerprint (deferred-consolidation work,
-- 2026-11-17). taste_summaries gains the fingerprint of the raw-log
-- input the stored record was derived from, so a consolidation whose
-- input hasn't changed can skip the model call entirely, and so
-- staleness (log changed since the last consolidation) is detectable
-- without a call. NULL for rows never consolidated or written before
-- this migration — NULL always differs, so those profiles
-- consolidate once at their next refresh, then store a fingerprint.
ALTER TABLE taste_summaries ADD COLUMN input_hash TEXT;
