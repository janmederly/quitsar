import { purgeInactiveAccounts } from '../server/retention.js';

export default {
  async scheduled(_event, env) {
    await purgeInactiveAccounts(env.DB);
    // Clear expired temporary data even when the site receives no visits.
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        'DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at<=? LIMIT 256)'
      ).bind(now),
      env.DB.prepare(
        'DELETE FROM oauth_states WHERE state_hash IN (SELECT state_hash FROM oauth_states WHERE expires_at<=? LIMIT 1000)'
      ).bind(now),
      env.DB.prepare('DELETE FROM oauth_limits WHERE window<?').bind(Math.floor(now / 600000)),
      env.DB.prepare('DELETE FROM api_limits WHERE window<?').bind(Math.floor(now / 60000)),
      env.DB.prepare(
        'DELETE FROM restore_batches WHERE owner IN (SELECT owner FROM restore_batches WHERE expires_at<=? LIMIT 4)'
      ).bind(now)
    ]);
  }
};
