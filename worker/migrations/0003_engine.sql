-- Show Recommender — D1 schema, migration 0003 (v1 engine).
--
-- 1. feedback_log gains show_title so people-score matching can join
--    external recommendations to feedback by normalized title when no
--    TMDB id was captured (title input is free text; see trust.ts).
-- 2. curated_overrides gains an `excluded` flag: rows that must never
--    surface in search or lists (duplicate TMDB entries).
-- 3. Verified override seeds from the TMDB API check of 2026-11-15
--    (evidence: tv-recommender/verification/tmdb-api.md). Every value
--    below was read from the API response; nothing is title-guessed.

ALTER TABLE feedback_log ADD COLUMN show_title TEXT;

ALTER TABLE curated_overrides ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0;

-- Canonical Zagouri Empire entry: carries IMDb/TVDB/Wikidata join keys.
INSERT INTO curated_overrides (tmdb_id, he_title, he_overview, origin_label, providers_note, excluded, notes, updated_at)
VALUES (75547, NULL, NULL, 'HOT3', NULL, 0, 'Zagouri Empire canonical entry (verified 2026-11-15).', unixepoch() * 1000)
ON CONFLICT(tmdb_id) DO UPDATE SET origin_label = excluded.origin_label, notes = excluded.notes;

-- Guf Shlishi: origin label (Keshet 12). Hebrew overview exists in TMDB,
-- so no he_overview override is needed.
INSERT INTO curated_overrides (tmdb_id, he_title, he_overview, origin_label, providers_note, excluded, notes, updated_at)
VALUES (220158, NULL, NULL, 'Keshet 12', NULL, 0, 'Guf Shlishi origin label (verified 2026-11-15).', unixepoch() * 1000)
ON CONFLICT(tmdb_id) DO UPDATE SET origin_label = excluded.origin_label, notes = excluded.notes;

-- On the Spectrum: origin label (yes).
INSERT INTO curated_overrides (tmdb_id, he_title, he_overview, origin_label, providers_note, excluded, notes, updated_at)
VALUES (79830, NULL, NULL, 'yes', NULL, 0, 'On the Spectrum origin label (verified 2026-11-15).', unixepoch() * 1000)
ON CONFLICT(tmdb_id) DO UPDATE SET origin_label = excluded.origin_label, notes = excluded.notes;

-- Srugim: origin label (yes).
INSERT INTO curated_overrides (tmdb_id, he_title, he_overview, origin_label, providers_note, excluded, notes, updated_at)
VALUES (32210, NULL, NULL, 'yes', NULL, 0, 'Srugim origin label (verified 2026-11-15).', unixepoch() * 1000)
ON CONFLICT(tmdb_id) DO UPDATE SET origin_label = excluded.origin_label, notes = excluded.notes;

-- Zagouri duplicates: excluded from search and lists.
INSERT INTO curated_overrides (tmdb_id, he_title, he_overview, origin_label, providers_note, excluded, notes, updated_at)
VALUES (290353, NULL, NULL, NULL, NULL, 1, 'Zagouri duplicate: current episode counts but no join IDs (verified 2026-11-15).', unixepoch() * 1000)
ON CONFLICT(tmdb_id) DO UPDATE SET excluded = 1, notes = excluded.notes;

INSERT INTO curated_overrides (tmdb_id, he_title, he_overview, origin_label, providers_note, excluded, notes, updated_at)
VALUES (68885, NULL, NULL, NULL, NULL, 1, 'Zagouri bad duplicate: original language en, 2016 (verified 2026-11-15).', unixepoch() * 1000)
ON CONFLICT(tmdb_id) DO UPDATE SET excluded = 1, notes = excluded.notes;
