import { readBody, validateChanges } from './records.js';
import { jsonBytes } from '../js/limits.js';

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};

// DB implements the D1 prepare/batch interface; the local adapter commits batches
// synchronously in SQLite. Never load an entire staged backup into worker memory.
export async function restore(request, DB, owner, local = false) {
  const body = await readBody(request);
  const now = Date.now();
  try {
    if (body?.action === 'start') {
      const id = crypto.randomUUID();
      await DB.batch([
        DB.prepare('DELETE FROM restore_batches WHERE owner=? AND expires_at<=?').bind(owner, now),
        DB.prepare(
          'INSERT INTO restore_batches (owner,id,expires_at) VALUES (?,?,?) ON CONFLICT(owner) DO NOTHING'
        ).bind(owner, id, now + 900000)
      ]);
      const row = await DB.prepare('SELECT id FROM restore_batches WHERE owner=?')
        .bind(owner)
        .first();
      if (row?.id !== id)
        fail(409, 'Another restore is in progress. Retry after it finishes or expires.');
      return { id };
    }
    if (typeof body?.id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.id))
      fail(400, 'Invalid restore ID.');
    if (body.action === 'cancel') {
      await DB.prepare('DELETE FROM restore_batches WHERE owner=? AND id=?')
        .bind(owner, body.id)
        .run();
      return { ok: true };
    }
    if (body.action === 'upload') {
      if (!Number.isInteger(body.part) || body.part < 0 || body.part >= 128)
        fail(400, 'Invalid restore part.');
      const changes = validateChanges(body.changes);
      const data = JSON.stringify(changes);
      const bytes = jsonBytes(changes);
      if (bytes > 1500000) fail(413, 'Restore part exceeds its upload limit.');
      const result = await DB.prepare(
        `INSERT INTO restore_chunks (owner,restore_id,part,data,bytes,records)
        SELECT owner,id,?,?,?,? FROM restore_batches
        WHERE owner=? AND id=? AND state='uploading' AND expires_at>?
        RETURNING part`
      )
        .bind(body.part, data, bytes, changes.length, owner, body.id, now)
        .all();
      if (!result.results.length) fail(410, 'Restore expired. Start the restore again.');
      return { ok: true };
    }
    if (
      body.action !== 'commit' ||
      !Number.isInteger(body.parts) ||
      body.parts < 1 ||
      body.parts > 128
    )
      fail(400, 'Invalid restore commit.');
    // The first statement freezes and validates the upload inside the same
    // transaction as all record changes. Concurrent uploads cannot slip in.
    const staged = `FROM restore_chunks AS chunk
      JOIN restore_batches AS batch ON batch.owner=chunk.owner AND batch.id=chunk.restore_id,
      json_each(chunk.data) AS change
      WHERE batch.owner=? AND batch.id=? AND batch.state='committing'`;
    const scope = local ? '' : 'user_id=? AND ';
    const result = await DB.batch([
      DB.prepare(
        `UPDATE restore_batches SET parts=?,state='committing'
        WHERE owner=? AND id=? AND state='uploading' AND expires_at>?`
      ).bind(body.parts, owner, body.id, now),
      DB.prepare(
        `DELETE FROM records WHERE ${scope}(store,id) IN
        (SELECT json_extract(change.value,'$.store'),json_extract(change.value,'$.id')
        ${staged} AND json_extract(change.value,'$.delete'))`
      ).bind(...(local ? [] : [owner]), owner, body.id),
      DB.prepare(
        `INSERT INTO records (${local ? '' : 'user_id,'}store,id,value,bytes)
        SELECT ${local ? '' : '?,'}json_extract(change.value,'$.store'),json_extract(change.value,'$.value.id'),
          json_extract(change.value,'$.value'),length(CAST(json_extract(change.value,'$.value') AS BLOB))
        ${staged} AND NOT COALESCE(json_extract(change.value,'$.delete'),0)
        ON CONFLICT(${local ? '' : 'user_id,'}store,id) DO UPDATE SET value=excluded.value,bytes=excluded.bytes`
      ).bind(...(local ? [] : [owner]), owner, body.id),
      DB.prepare(
        `DELETE FROM restore_batches WHERE owner=? AND id=? AND state='committing' RETURNING id`
      ).bind(owner, body.id)
    ]);
    if (!result.at(-1).results.length) fail(410, 'Restore expired. Start the restore again.');
    return { ok: true };
  } catch (error) {
    if (/restore_quota/.test(error.message))
      fail(413, 'Restore exceeds 24 MiB or 150,000 records.');
    if (/restore_order|restore_incomplete|restore_duplicate/.test(error.message))
      fail(400, 'Restore parts are missing, out of order, or contain duplicate records.');
    throw error;
  }
}
