-- Add pincode column to users so coord/leader own pincode is stored
-- (used for gender-aware bulk-assign and pincode-locality auto-fill).
ALTER TABLE users ADD COLUMN pincode TEXT;
CREATE INDEX IF NOT EXISTS users_pincode_idx ON users(pincode);
