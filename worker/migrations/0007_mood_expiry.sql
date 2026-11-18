-- Mood selections expire 3 hours after selection (invisible to the user:
-- a later visit finds no mood selected). Selections made before this
-- migration have a NULL expiry and are treated as expired on read.
ALTER TABLE profiles ADD COLUMN active_mood_expires_at INTEGER;
