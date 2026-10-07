CREATE TABLE IF NOT EXISTS auth_state (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS auth_state_expiry ON auth_state(expires);
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limit_expiry ON rate_limits(expires);
