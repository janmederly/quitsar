-- Backfill once; subsequent writes update one counter row in the same transaction.
DROP TRIGGER records_insert_quota;
DROP TRIGGER records_update_quota;
CREATE TABLE account_usage (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bytes INTEGER NOT NULL DEFAULT 0,
  records INTEGER NOT NULL DEFAULT 0
);
INSERT INTO account_usage SELECT user_id,SUM(bytes),COUNT(*) FROM records GROUP BY user_id;
CREATE TRIGGER records_insert_quota AFTER INSERT ON records BEGIN
  INSERT INTO account_usage VALUES (NEW.user_id,NEW.bytes,1)
  ON CONFLICT(user_id) DO UPDATE SET bytes=bytes+NEW.bytes,records=records+1;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM account_usage WHERE user_id=NEW.user_id
    AND (bytes>20971520 OR records>20000)) THEN RAISE(ABORT,'account_quota') END;
END;
CREATE TRIGGER records_update_quota AFTER UPDATE ON records BEGIN
  UPDATE account_usage SET bytes=bytes+NEW.bytes-OLD.bytes WHERE user_id=NEW.user_id;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM account_usage WHERE user_id=NEW.user_id
    AND bytes>20971520) THEN RAISE(ABORT,'account_quota') END;
END;
CREATE TRIGGER records_delete_quota AFTER DELETE ON records BEGIN
  UPDATE account_usage SET bytes=bytes-OLD.bytes,records=records-1 WHERE user_id=OLD.user_id;
END;
