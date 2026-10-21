CREATE TABLE oauth_limits (
  key TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  requests INTEGER NOT NULL,
  maximum INTEGER NOT NULL,
  CONSTRAINT oauth_rate CHECK(requests BETWEEN 1 AND maximum)
);
-- Remove pre-migration expired/excess state so the hard cap cannot lock out an
-- installation which accumulated many states before rate limiting existed.
DELETE FROM oauth_states WHERE expires_at <= CAST(strftime('%s','now') AS INTEGER) * 1000;
DELETE FROM oauth_states WHERE state_hash NOT IN
  (SELECT state_hash FROM oauth_states ORDER BY expires_at DESC LIMIT 1000);
-- A hard bound remains effective across isolates, IP rotation and clock windows.
CREATE TRIGGER oauth_pending_limit BEFORE INSERT ON oauth_states BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM oauth_states) >= 1000
    THEN RAISE(ABORT, 'oauth_rate') END;
END;
