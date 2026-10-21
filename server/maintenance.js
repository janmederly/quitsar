// D1 counters are authoritative across isolates. Limits apply before reading a
// write body, including rejected uploads. Fixed windows bound counter storage.
export const API_WINDOW = 60000;
export async function admitWrite(DB, owner, now = Date.now()) {
  const window = Math.floor(now / API_WINDOW);
  const increment = (key, maximum) =>
    DB.prepare(
      `
    INSERT INTO api_limits VALUES (?,?,1,?) ON CONFLICT(key) DO UPDATE SET
    window=excluded.window, maximum=excluded.maximum,
    requests=CASE WHEN api_limits.window=excluded.window THEN api_limits.requests+1 ELSE 1 END`
    ).bind(key, window, maximum);
  await DB.batch([increment('global', 1200), increment('user:' + owner, 120)]);
}

// Independent of upload ownership: any active account reclaims abandoned data.
// Bound cascade work to at most four uploads (128 chunks each) per pass.
export async function cleanupExpired(DB, now = Date.now()) {
  await DB.batch([
    DB.prepare(
      `DELETE FROM restore_batches WHERE owner IN
      (SELECT owner FROM restore_batches WHERE expires_at<=? ORDER BY expires_at LIMIT 4)`
    ).bind(now),
    DB.prepare(
      `DELETE FROM api_limits WHERE key IN
      (SELECT key FROM api_limits WHERE window<? LIMIT 2048)`
    ).bind(Math.floor(now / API_WINDOW))
  ]);
}
const lastCleanup = new WeakMap();
export async function maintain(DB, now = Date.now()) {
  if (now - (lastCleanup.get(DB) ?? -Infinity) < API_WINDOW) return;
  lastCleanup.set(DB, now);
  try {
    await cleanupExpired(DB, now);
  } catch (error) {
    lastCleanup.delete(DB);
    throw error;
  }
}
