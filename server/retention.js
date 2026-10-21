// Calendar months, with leap-day clamping, rather than a fixed number of days.
export function inactiveCutoff(now = Date.now()) {
  const cutoff = new Date(now);
  const day = cutoff.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 2);
  const lastDay = new Date(
    Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)
  ).getUTCDate();
  cutoff.setUTCDate(Math.min(day, lastDay));
  return cutoff.getTime();
}

// Foreign keys and the users_delete_private_data trigger remove the owner's
// records, sessions, usage counters, activity, and staged uploads atomically.
export async function purgeInactiveAccounts(DB, now = Date.now()) {
  return DB.prepare(
    `DELETE FROM users WHERE id IN (
    SELECT user_id FROM account_activity WHERE last_sign_in<=?
    ORDER BY last_sign_in LIMIT 10
  )`
  )
    .bind(inactiveCutoff(now))
    .run();
}
