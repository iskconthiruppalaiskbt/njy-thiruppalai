-- Add gender column to users (M/F/other) so coord/leader gender can be
-- stored authoritatively rather than inferred from devotional honorifics.
ALTER TABLE users ADD COLUMN gender TEXT;  -- nullable; NULL falls back to name-inference
CREATE INDEX IF NOT EXISTS users_gender_idx ON users(gender);
