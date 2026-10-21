-- Give existing accounts a full retention window from migration. Historical
-- sign-in times were not reliably retained before this migration.
CREATE TABLE account_activity (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_sign_in INTEGER NOT NULL
);
CREATE INDEX account_activity_sign_in ON account_activity(last_sign_in);
INSERT INTO account_activity
  SELECT id, CAST(strftime('%s','now') AS INTEGER) * 1000 FROM users;
CREATE TRIGGER users_activity_insert AFTER INSERT ON users BEGIN
  INSERT INTO account_activity VALUES (NEW.id, CAST(strftime('%s','now') AS INTEGER) * 1000);
END;
-- These tables are not children of users in the original schema.
CREATE TRIGGER users_delete_private_data AFTER DELETE ON users BEGIN
  DELETE FROM restore_batches WHERE owner=OLD.id;
  DELETE FROM api_limits WHERE key='user:' || OLD.id;
END;
-- An upload request already in flight must not recreate orphaned private data
-- after its owner's account has been deleted by another request.
CREATE TRIGGER restore_owner_required BEFORE INSERT ON restore_batches BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.owner)
    THEN RAISE(ABORT,'account_deleted') END;
END;
