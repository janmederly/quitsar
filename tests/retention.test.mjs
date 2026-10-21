import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { inactiveCutoff, purgeInactiveAccounts } from '../server/retention.js';
import retentionWorker from '../workers/account-retention.js';
import { onRequest, hash } from '../functions/api/[[path]].js';

globalThis.crypto ??= webcrypto;
const supported = Number(process.versions.node.split('.')[0]) >= 22;
const origin = 'https://study.example';
async function database(t, beforeRetention) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  for (const filename of (await readdir(new URL('../migrations/', import.meta.url)))
    .filter((p) => p.endsWith('.sql'))
    .sort()) {
    if (filename === '0006_account_retention.sql') beforeRetention?.(db);
    db.exec(await readFile(new URL('../migrations/' + filename, import.meta.url), 'utf8'));
  }
  const DB = {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        args: [],
        bind(...args) {
          this.args = args;
          return this;
        },
        async first() {
          return statement.get(...this.args) || null;
        },
        async all() {
          return { results: statement.all(...this.args) };
        },
        async run() {
          return statement.run(...this.args);
        },
        execute() {
          return { results: statement.all(...this.args) };
        }
      };
    },
    async batch(queries) {
      db.exec('BEGIN');
      try {
        const result = queries.map((q) => q.execute());
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  };
  const env = {
    DB,
    APP_ORIGIN: origin,
    GOOGLE_CLIENT_ID: 'client',
    GOOGLE_CLIENT_SECRET: 'secret'
  };
  const send = (
    path,
    { token = 'a-token', user = 'a', method = 'POST', body, requestOrigin = origin } = {}
  ) =>
    onRequest({
      env,
      request: new Request(origin + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Origin: requestOrigin,
          'X-Quitsar-User': user,
          Cookie: token ? `__Host-qr_session=${token}` : ''
        },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {})
      })
    });
  return { db, DB, env, send };
}
async function seed(db, id, lastSignIn = Date.now()) {
  db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(id, id + '@example.com', id, 1);
  db.prepare('UPDATE account_activity SET last_sign_in=? WHERE user_id=?').run(lastSignIn, id);
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(
    await hash(id + '-token'),
    id,
    Date.now() + 86400000
  );
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(
    await hash(id + '-second-device'),
    id,
    Date.now() + 86400000
  );
  for (const store of ['banks', 'states', 'history', 'settings', 'active', 'attempts'])
    db.prepare('INSERT INTO records VALUES (?,?,?,?,?)').run(id, store, 'one', '{"id":"one"}', 12);
  db.prepare('INSERT INTO restore_batches (owner,id,expires_at) VALUES (?,?,?)').run(
    id,
    'upload-' + id,
    Date.now() + 900000
  );
  db.prepare('INSERT INTO restore_chunks VALUES (?,?,?,?,?,?)').run(
    id,
    'upload-' + id,
    0,
    '[]',
    2,
    1
  );
  db.prepare('INSERT INTO api_limits VALUES (?,?,?,?)').run(
    'user:' + id,
    Math.floor(Date.now() / 60000),
    1,
    120
  );
}
function assertRemoved(db, id) {
  for (const [table, key] of [
    ['users', 'id'],
    ['sessions', 'user_id'],
    ['records', 'user_id'],
    ['account_activity', 'user_id'],
    ['account_usage', 'user_id'],
    ['restore_batches', 'owner'],
    ['restore_chunks', 'owner']
  ])
    assert.equal(
      db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${key}=?`).get(id).n,
      0,
      table
    );
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM api_limits WHERE key=?').get('user:' + id).n,
    0
  );
}

test('24-month retention uses calendar years and clamps leap days', () => {
  assert.equal(
    new Date(inactiveCutoff(Date.parse('2028-02-29T12:34:56Z'))).toISOString(),
    '2026-02-28T12:34:56.000Z'
  );
  assert.equal(
    new Date(inactiveCutoff(Date.parse('2026-10-21T12:34:56Z'))).toISOString(),
    '2024-10-21T12:34:56.000Z'
  );
});

test(
  'retention migration gives existing accounts a full grace period',
  { skip: !supported },
  async (t) => {
    const before = Date.now() - 1000;
    const { db } = await database(t, (db) =>
      db.exec("INSERT INTO users VALUES ('old','old@example.com','Old',1)")
    );
    assert.ok(
      db.prepare('SELECT last_sign_in FROM account_activity WHERE user_id=?').get('old')
        .last_sign_in >= before
    );
  }
);

test(
  'account deletion requires authentication, origin, current identity, and typed confirmation',
  { skip: !supported },
  async (t) => {
    const { db, send } = await database(t);
    await seed(db, 'a');
    await seed(db, 'b');
    const valid = { confirmation: 'DELETE', email: 'a@example.com' };
    for (const [options, status] of [
      [{ token: '', body: valid }, 401],
      [{ requestOrigin: 'https://evil.example', body: valid }, 403],
      [{ user: 'b', body: valid }, 409],
      [{ user: '', body: valid }, 409],
      [{ body: { ...valid, confirmation: 'delete' } }, 400],
      [{ body: { ...valid, email: 'b@example.com' } }, 400],
      [{ method: 'GET' }, 404]
    ]) {
      assert.equal((await send('/api/auth/delete-account', options)).status, status);
      assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 2);
    }
    const result = await send('/api/auth/delete-account', { body: { ...valid, userId: 'b' } });
    assert.equal(result.status, 200);
    assert.match(result.headers.get('Set-Cookie'), /__Host-qr_session=;.*Max-Age=0/);
    assert.match(result.headers.get('Set-Cookie'), /__Host-qr_oauth=;.*Max-Age=0/);
    assertRemoved(db, 'a');
    assert.equal(db.prepare("SELECT count(*) AS n FROM records WHERE user_id='b'").get().n, 6);
    assert.equal(
      (await send('/api/records?store=banks', { token: 'a-second-device', method: 'GET' })).status,
      401
    );
    assert.equal((await send('/api/auth/delete-account', { body: valid })).status, 401);
    assert.throws(
      () =>
        db
          .prepare('INSERT INTO restore_batches (owner,id,expires_at) VALUES (?,?,?)')
          .run('a', 'late', Date.now() + 1000),
      /account_deleted/
    );
  }
);

test(
  'failed account deletion rolls back all changes and permits retry',
  { skip: !supported },
  async (t) => {
    const { db, send } = await database(t);
    await seed(db, 'a');
    db.exec(
      "CREATE TRIGGER reject_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT,'forced_delete_failure'); END"
    );
    const body = { confirmation: 'DELETE', email: 'a@example.com' };
    const failure = await send('/api/auth/delete-account', { body });
    assert.equal(failure.status, 500);
    assert.equal(failure.headers.get('Set-Cookie'), null);
    assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM restore_chunks').get().n, 1);
    db.exec('DROP TRIGGER reject_delete');
    assert.equal((await send('/api/auth/delete-account', { body })).status, 200);
    assertRemoved(db, 'a');
  }
);

test(
  'inactivity cleanup deletes expired accounts and preserves recently signed-in accounts',
  { skip: !supported },
  async (t) => {
    const { db, DB } = await database(t);
    const now = Date.now();
    await seed(db, 'expired', inactiveCutoff(now));
    await seed(db, 'active', inactiveCutoff(now) + 10000);
    await purgeInactiveAccounts(DB, now);
    assertRemoved(db, 'expired');
    assert.equal(db.prepare("SELECT count(*) AS n FROM users WHERE id='active'").get().n, 1);
    // The worker is also safe to repeat with no expired accounts.
    await retentionWorker.scheduled({}, { DB });
    assert.equal(db.prepare("SELECT count(*) AS n FROM users WHERE id='active'").get().n, 1);
  }
);

test(
  'cleanup is bounded and old data cannot be revived by a late Google sign-in',
  { skip: !supported },
  async (t) => {
    const { db, DB, env, send } = await database(t);
    const expired = inactiveCutoff() - 86400000;
    for (let i = 0; i < 11; i++) await seed(db, 'old-' + i, expired);
    await purgeInactiveAccounts(DB);
    assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
    await seed(db, 'a', expired);
    assert.equal((await send('/api/records?store=banks', { method: 'GET' })).status, 401);
    const previous = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = previous;
    });
    globalThis.fetch = async (url) =>
      Response.json(
        String(url).includes('/token')
          ? { access_token: 'test-only' }
          : { sub: 'a', email: 'a@example.com', name: 'A', email_verified: true }
      );
    const start = await onRequest({ env, request: new Request(origin + '/api/auth/google') });
    const state = new URL(start.headers.get('Location')).searchParams.get('state');
    const login = await onRequest({
      env,
      request: new Request(origin + `/api/auth/callback?state=${state}&code=test`, {
        headers: { Cookie: start.headers.get('Set-Cookie').split(';')[0] }
      })
    });
    assert.equal(login.status, 302);
    assert.equal(db.prepare("SELECT count(*) AS n FROM records WHERE user_id='a'").get().n, 0);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM restore_batches WHERE owner='a'").get().n,
      0
    );
    assert.ok(
      db.prepare("SELECT last_sign_in FROM account_activity WHERE user_id='a'").get().last_sign_in >
        expired
    );
  }
);
