CREATE INDEX restore_expiry ON restore_batches(expires_at);
CREATE TABLE api_limits (
  key TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  requests INTEGER NOT NULL,
  maximum INTEGER NOT NULL,
  CONSTRAINT api_rate CHECK(requests BETWEEN 1 AND maximum)
);
CREATE INDEX api_limits_window ON api_limits(window);
