-- Uploads are private to an owner and invisible to ordinary record reads.
-- One bounded, expiring upload per owner; chunks commit in one transaction.
CREATE TABLE restore_batches (
  owner TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','committing')),
  parts INTEGER NOT NULL DEFAULT 0,
  UNIQUE(owner, id)
);
CREATE TABLE restore_chunks (
  owner TEXT NOT NULL,
  restore_id TEXT NOT NULL,
  part INTEGER NOT NULL CHECK(part BETWEEN 0 AND 127),
  data TEXT NOT NULL CHECK(json_valid(data)),
  bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 1500000),
  records INTEGER NOT NULL CHECK(records BETWEEN 1 AND 20000),
  PRIMARY KEY(owner, restore_id, part),
  FOREIGN KEY(owner, restore_id) REFERENCES restore_batches(owner, id) ON DELETE CASCADE
);
CREATE TRIGGER restore_chunk_limits BEFORE INSERT ON restore_chunks BEGIN
  SELECT CASE WHEN NEW.part != (SELECT COUNT(*) FROM restore_chunks WHERE owner=NEW.owner AND restore_id=NEW.restore_id)
    THEN RAISE(ABORT, 'restore_order') END;
  SELECT CASE WHEN NEW.bytes + (SELECT COALESCE(SUM(bytes),0) FROM restore_chunks WHERE owner=NEW.owner) > 25165824
    OR NEW.records + (SELECT COALESCE(SUM(records),0) FROM restore_chunks WHERE owner=NEW.owner) > 150000
    THEN RAISE(ABORT, 'restore_quota') END;
END;
CREATE TRIGGER restore_commit_checks BEFORE UPDATE OF state ON restore_batches
WHEN NEW.state='committing' BEGIN
  SELECT CASE WHEN NEW.parts < 1 OR NEW.parts != (SELECT COUNT(*) FROM restore_chunks WHERE owner=NEW.owner AND restore_id=NEW.id)
    THEN RAISE(ABORT, 'restore_incomplete') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM restore_chunks, json_each(restore_chunks.data) AS change
    WHERE owner=NEW.owner AND restore_id=NEW.id
    GROUP BY json_extract(change.value,'$.store'),
      CASE WHEN json_extract(change.value,'$.delete')
        THEN json_extract(change.value,'$.id') ELSE json_extract(change.value,'$.value.id') END
    HAVING COUNT(*) > 1
  ) THEN RAISE(ABORT, 'restore_duplicate') END;
END;
