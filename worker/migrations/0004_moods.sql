-- Show Recommender — D1 schema, migration 0004 (Moods).
--
-- 1. `moods`: per-profile overlays (see worker/src/db.ts). Each mood
--    carries its own text + extracted rules; its lists live in
--    recommendation_lists keyed by mood_id. `source` records whether
--    the row was a seeded preset or user-created; behavior is
--    identical either way (delete-and-recreate, recency order).
-- 2. `profiles.active_mood_id`: the persisted selection — a mood
--    stays active until the user picks the main list or deletes it.
-- 3. `recommendation_lists` is rebuilt with mood_id in the key
--    ('' = the main list). Existing rows are copied with mood_id ''
--    so no stored list is lost.
-- 4. Preset moods are seeded for every existing profile, in the
--    profile's UI language, with hand-curated rules (no LLM at seed
--    time). Deterministic ids make the seed idempotent. New profiles
--    are seeded by the profile-creation route instead.
-- 5. The ad-hoc feature is removed: adhoc_history is dropped (it
--    held only one-off queries, which never fed taste or lists).

CREATE TABLE IF NOT EXISTS moods (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  text TEXT NOT NULL,
  rules_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moods_profile ON moods(profile_id, last_used_at);

ALTER TABLE profiles ADD COLUMN active_mood_id TEXT;

CREATE TABLE recommendation_lists_new (
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  kind TEXT NOT NULL,
  mood_id TEXT NOT NULL DEFAULT '',
  pool_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  short_reason TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, kind, mood_id)
);
INSERT INTO recommendation_lists_new (profile_id, kind, mood_id, pool_json, snapshot_json, short_reason, updated_at)
  SELECT profile_id, kind, '', pool_json, snapshot_json, short_reason, updated_at FROM recommendation_lists;
DROP TABLE recommendation_lists;
ALTER TABLE recommendation_lists_new RENAME TO recommendation_lists;

INSERT OR IGNORE INTO moods (id, profile_id, text, rules_json, source, created_at, last_used_at)
  SELECT 'preset:' || id || ':israeli-drama', id,
    CASE ui_language WHEN 'he' THEN 'דרמה ישראלית' ELSE 'Israeli drama' END,
    '[{"dimension":"country","operator":"is","value":"IL","mode":"hard"},{"dimension":"genre","operator":"is","value":18,"mode":"hard"}]',
    'preset', unixepoch() * 1000, unixepoch() * 1000
  FROM profiles;

INSERT OR IGNORE INTO moods (id, profile_id, text, rules_json, source, created_at, last_used_at)
  SELECT 'preset:' || id || ':something-light', id,
    CASE ui_language WHEN 'he' THEN 'משהו קליל' ELSE 'Something light' END,
    '[{"dimension":"genre","operator":"is","value":35,"mode":"soft"},{"dimension":"episodeMinutes","operator":"lte","value":30,"mode":"soft"}]',
    'preset', unixepoch() * 1000, unixepoch() * 1000
  FROM profiles;

INSERT OR IGNORE INTO moods (id, profile_id, text, rules_json, source, created_at, last_used_at)
  SELECT 'preset:' || id || ':with-kids', id,
    CASE ui_language WHEN 'he' THEN 'עם הילדים' ELSE 'With the kids' END,
    '[{"dimension":"genre","operator":"is","value":10751,"mode":"soft"}]',
    'preset', unixepoch() * 1000, unixepoch() * 1000
  FROM profiles;

INSERT OR IGNORE INTO moods (id, profile_id, text, rules_json, source, created_at, last_used_at)
  SELECT 'preset:' || id || ':weekend-binge', id,
    CASE ui_language WHEN 'he' THEN 'מרתון סופ״ש' ELSE 'Weekend binge' END,
    '[{"dimension":"seasons","operator":"gte","value":3,"mode":"soft"}]',
    'preset', unixepoch() * 1000, unixepoch() * 1000
  FROM profiles;

DROP TABLE IF EXISTS adhoc_history;
