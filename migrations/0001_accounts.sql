CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_expiry ON oauth_states(expires_at);
CREATE TABLE records (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store TEXT NOT NULL CHECK(store IN ('banks','states','attempts','history','settings','active')),
  id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 400),
  value TEXT NOT NULL CHECK(json_valid(value)),
  bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 1048576),
  PRIMARY KEY(user_id, store, id)
);
-- Quotas run inside the write transaction, including concurrent requests and batches.
CREATE TRIGGER records_insert_quota AFTER INSERT ON records BEGIN
  SELECT CASE WHEN (SELECT COALESCE(SUM(bytes),0) FROM records WHERE user_id=NEW.user_id) > 20971520
    OR (SELECT COUNT(*) FROM records WHERE user_id=NEW.user_id) > 20000
    THEN RAISE(ABORT, 'account_quota') END;
END;
CREATE TRIGGER records_update_quota AFTER UPDATE ON records BEGIN
  SELECT CASE WHEN (SELECT COALESCE(SUM(bytes),0) FROM records WHERE user_id=NEW.user_id) > 20971520
    THEN RAISE(ABORT, 'account_quota') END;
END;
