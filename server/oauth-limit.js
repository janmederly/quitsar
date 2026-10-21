// D1 is authoritative across isolates. The bounded in-memory gate rejects hot
// clients before database access; losing an isolate cannot bypass the D1 limit.
const gates = new WeakMap();
export const OAUTH_WINDOW = 600000;
export function oauthAdmission(DB, client, now) {
  const window = Math.floor(now / OAUTH_WINDOW);
  let gate = gates.get(DB);
  if (!gate || gate.window !== window) {
    gate = { window, total: 0, clients: new Map() };
    gates.set(DB, gate);
  }
  const count = gate.clients.get(client) || 0;
  if (gate.total >= 300 || count >= 10) return false;
  // At most 300 distinct clients can be inserted in a window.
  gate.total++;
  gate.clients.set(client, count + 1);
  return true;
}
export function oauthCounters(DB, client, now) {
  const window = Math.floor(now / OAUTH_WINDOW);
  const increment = (key, maximum) =>
    DB.prepare(
      `
    INSERT INTO oauth_limits (key,window,requests,maximum) VALUES (?,?,1,?)
    ON CONFLICT(key) DO UPDATE SET window=excluded.window,
      requests=CASE WHEN oauth_limits.window=excluded.window THEN oauth_limits.requests+1 ELSE 1 END,
      maximum=excluded.maximum`
    ).bind(key, window, maximum);
  return [
    increment('global', 300),
    increment('ip:' + client, 10),
    DB.prepare(
      'DELETE FROM oauth_limits WHERE key IN (SELECT key FROM oauth_limits WHERE window<? LIMIT 128)'
    ).bind(window)
  ];
}
