-- Show Recommender — D1 schema, migration 0001.
-- SQLite (D1). All timestamps are Unix epoch milliseconds.
-- Authorization is app-level (see worker/src/authorize.ts): every
-- profile-scoped row carries profile_id, and every route verifies the
-- profile belongs to the authed account before reading/writing.

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  -- Custom icon/image: 'initials' (name-initial fallback), 'icon' (chosen
  -- icon name in icon_ref), or 'image' (R2 object key in icon_ref).
  icon_kind TEXT NOT NULL DEFAULT 'initials',
  icon_ref TEXT,
  -- Language hard filter: JSON array of original-language codes, e.g. ["he","en"].
  languages_json TEXT NOT NULL DEFAULT '[]',
  ui_language TEXT NOT NULL DEFAULT 'en',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profiles_account ON profiles(account_id);

-- Raw feedback log: APPEND-ONLY source of truth (spec §5, build rule 9).
-- Never rewritten by consolidation. kind: 'show' | 'note'.
CREATE TABLE IF NOT EXISTS feedback_log (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  kind TEXT NOT NULL,
  tmdb_id INTEGER,
  rating TEXT, -- 'liked' | 'disliked' | 'dropped' (show feedback only)
  text TEXT NOT NULL DEFAULT '',
  original_language TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_profile ON feedback_log(profile_id, created_at);

-- Living taste summary: one row per profile per UI language. Editable;
-- edit history kept in taste_summary_history.
CREATE TABLE IF NOT EXISTS taste_summaries (
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  ui_language TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, ui_language)
);

CREATE TABLE IF NOT EXISTS taste_summary_history (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  ui_language TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_taste_history_profile ON taste_summary_history(profile_id, created_at);

-- External recommendations: kind 'personal' (1+ names) or 'generic' (no names).
CREATE TABLE IF NOT EXISTS external_recommendations (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  tmdb_id INTEGER,
  show_title TEXT NOT NULL,
  kind TEXT NOT NULL, -- 'personal' | 'generic'
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_extrec_profile ON external_recommendations(profile_id, created_at);

-- One row per (recommendation, person): multiple names share one item and
-- EACH is credited (spec §6, build rule 16).
CREATE TABLE IF NOT EXISTS recommendation_people (
  recommendation_id TEXT NOT NULL REFERENCES external_recommendations(id),
  person_name TEXT NOT NULL,
  PRIMARY KEY (recommendation_id, person_name)
);

-- Per-person trust record, DERIVED from feedback outcomes (never user-set).
-- Recomputed whenever feedback lands or a retrospective recommendation is
-- added (spec §6, build rule 17). Stored as a cache; recompute is cheap.
CREATE TABLE IF NOT EXISTS people_scores (
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  person_name TEXT NOT NULL,
  recommended INTEGER NOT NULL DEFAULT 0,
  liked INTEGER NOT NULL DEFAULT 0,
  disliked INTEGER NOT NULL DEFAULT 0,
  dropped INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, person_name)
);

-- Deny-list: Remove with "No Reason" ONLY. Excludes the show from future
-- lists and NOTHING else: ranking, taste consolidation, and trust must
-- never read this table (spec §7, build rule 14).
CREATE TABLE IF NOT EXISTS deny_list (
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  tmdb_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, tmdb_id)
);

-- TMDB metadata cache. Rows MUST expire within the terms' 6-month cap;
-- the client enforces a 180-day TTL (see worker/src/tmdb.ts).
CREATE TABLE IF NOT EXISTS show_metadata_cache (
  tmdb_id INTEGER NOT NULL,
  language TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  cached_at INTEGER NOT NULL,
  PRIMARY KEY (tmdb_id, language)
);

-- Curated Israeli override table (spec §4): hand-maintained fixes for
-- Israeli titles. Override values win over TMDB/TheTVDB for the fields
-- present; NULL means "no override, use the source value".
CREATE TABLE IF NOT EXISTS curated_overrides (
  tmdb_id INTEGER PRIMARY KEY,
  he_title TEXT,
  he_overview TEXT,
  origin_label TEXT, -- one canonical label, e.g. 'Kan 11 original'
  providers_note TEXT, -- display-only where-to-watch note
  notes TEXT,
  updated_at INTEGER NOT NULL
);

-- Recommendation lists: ranked pool + Top 10 display snapshot per profile
-- per kind ('casual' | 'deep'). Pool is JSON: ranked tmdb_ids with scores;
-- snapshot is JSON: the displayed Top 10 with rationale + chips.
CREATE TABLE IF NOT EXISTS recommendation_lists (
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  kind TEXT NOT NULL, -- 'casual' | 'deep'
  pool_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  short_reason TEXT, -- why fewer than 10, when applicable; never filler
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, kind)
);

-- Ad-hoc history: kept per profile, separated from the lists (spec §7).
-- The query never feeds taste or lists (build rule 8).
CREATE TABLE IF NOT EXISTS adhoc_history (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  query_text TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_adhoc_profile ON adhoc_history(profile_id, created_at);
