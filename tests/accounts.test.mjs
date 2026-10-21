import { preferences, historyRecord, stateRecord, examRecord } from './fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { onRequest, hash, readBody, validateChanges } from '../functions/api/[[path]].js';
import { LIMITS } from '../js/limits.js';

globalThis.crypto ??= webcrypto;
const demo = JSON.parse(await readFile(new URL('../banks/demo.json', import.meta.url), 'utf8'));

test('API rejects unauthenticated requests and cross-origin writes', async () => {
  const DB = {
    prepare() {
      throw new Error('Should not access database');
    }
  };
  for (const [method, headers, expected] of [
    ['GET', {}, 401],
    ['POST', {}, 403],
    ['POST', { Origin: 'https://evil.example' }, 403],
    ['DELETE', {}, 405]
  ]) {
    const response = await onRequest({
      request: new Request('https://study.example/api/records?store=banks', { method, headers }),
      env: { DB }
    });
    assert.equal(response.status, expected);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
});

test('upload validation caps records, images, banks and batch count', () => {
  const bank = { id: demo.bank.id, data: demo, enabled: true, importedAt: 1, assets: {} };
  assert.equal(validateChanges([{ store: 'banks', value: bank }]).length, 1);
  for (const changes of [
    [{ store: 'other', value: { id: 'x' } }],
    [{ store: 'settings', id: 'x', delete: 'true' }],
    [{ store: 'banks', value: { ...bank, data: null } }],
    [{ store: 'settings', value: { id: 'x', text: 'é'.repeat(LIMITS.record / 2) } }],
    [
      {
        store: 'banks',
        value: {
          ...bank,
          assets: { 'images/a.svg': { mime: 'image/svg+xml', data: 'x'.repeat(LIMITS.image + 1) } }
        }
      }
    ],
    Array.from({ length: LIMITS.changes + 1 }, (_, i) => ({
      store: 'banks',
      delete: true,
      id: String(i)
    }))
  ])
    assert.throws(() => validateChanges(changes));
});

test('streamed uploads are capped without trusting Content-Length', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(LIMITS.request));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    }
  });
  await assert.rejects(
    readBody(
      new Request('https://study.example/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        duplex: 'half'
      })
    ),
    (error) => error.status === 413
  );
  await assert.rejects(
    readBody(
      new Request('https://study.example/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad'
      })
    ),
    (error) => error.status === 400
  );
});

// Run the real migration and SQL through SQLite. Python is optional for contributors;
// production uses the same SQL through the D1 binding, not this test adapter.
const python = spawnSync('python3', ['--version']).status === 0;
test(
  'SQLite integration: OAuth, account isolation, logout, quotas and atomic rollback',
  { skip: !python },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'quitsar-accounts-'));
    const database = path.join(directory, 'test.sqlite');
    const bridge = `import sqlite3,json,sys
db=sqlite3.connect(sys.argv[1])
db.row_factory=sqlite3.Row
db.execute('PRAGMA foreign_keys=ON')
payload=json.load(sys.stdin)
try:
 if 'script' in payload: db.executescript(payload['script']); result=[]
 else:
  result=[]
  for item in payload['queries']:
   rows=db.execute(item['sql'],item.get('args',[]))
   result.append([dict(r) for r in rows.fetchall()])
 db.commit()
 print(json.dumps(result))
except Exception as error:
 db.rollback()
 print(json.dumps({'error':str(error)}))
`;
    function execute(payload) {
      const process = spawnSync('python3', ['-c', bridge, database], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        maxBuffer: 30 * 1024 * 1024
      });
      assert.equal(process.status, 0, process.stderr);
      const value = JSON.parse(process.stdout);
      if (value.error) throw new Error(value.error);
      return value;
    }
    const DB = {
      prepare(sql) {
        return {
          sql,
          args: [],
          bind(...args) {
            this.args = args;
            return this;
          },
          async first() {
            return execute({ queries: [this] })[0][0] || null;
          },
          async all() {
            return { results: execute({ queries: [this] })[0] };
          },
          async run() {
            execute({ queries: [this] });
            return {};
          }
        };
      },
      async batch(queries) {
        return execute({ queries }).map((results) => ({ results }));
      }
    };
    const env = {
      DB,
      GOOGLE_CLIENT_ID: 'client',
      GOOGLE_CLIENT_SECRET: 'secret',
      APP_ORIGIN: 'https://study.example'
    };
    const send = (route, { token, method = 'GET', body, cookie, expectedUser } = {}) =>
      onRequest({
        env,
        request: new Request('https://study.example' + route, {
          method,
          headers: {
            Origin: env.APP_ORIGIN,
            'Content-Type': 'application/json',
            'X-Quitsar-User':
              expectedUser ||
              (token === 'alice' || token === 'expired'
                ? 'a'
                : token === 'bob'
                  ? 'b'
                  : 'new-google-user'),
            Cookie: cookie || (token ? `__Host-qr_session=${token}` : '')
          },
          body: body === undefined ? undefined : JSON.stringify(body)
        })
      });
    const oldFetch = globalThis.fetch;
    try {
      for (const migration of [
        '0001_accounts.sql',
        '0002_restore.sql',
        '0003_oauth_limits.sql',
        '0004_constant_quotas.sql',
        '0005_api_maintenance.sql'
      ])
        execute({
          script: await readFile(new URL('../migrations/' + migration, import.meta.url), 'utf8')
        });
      await DB.batch([
        DB.prepare('INSERT INTO users VALUES (?,?,?,?)').bind('a', 'a@example.com', 'A', 1),
        DB.prepare('INSERT INTO users VALUES (?,?,?,?)').bind('b', 'b@example.com', 'B', 1),
        DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(
          await hash('alice'),
          'a',
          Date.now() + 60000
        ),
        DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(
          await hash('bob'),
          'b',
          Date.now() + 60000
        ),
        DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await hash('expired'), 'a', 1)
      ]);
      const write = (changes) =>
        send('/api/records', { token: 'alice', method: 'POST', body: { changes } });
      assert.equal((await send('/api/records?store=banks', { token: 'expired' })).status, 401);
      assert.equal(
        (await send('/api/records?store=settings', { token: 'bob', expectedUser: 'a' })).status,
        409
      );
      assert.equal(
        (await write([{ store: 'settings', value: preferences({ theme: 'dark' }) }])).status,
        200
      );
      assert.deepEqual(
        await (await send('/api/records?store=settings', { token: 'bob' })).json(),
        []
      );
      assert.equal(
        (await send('/api/records?store=settings&id=preferences', { token: 'bob' })).status,
        200
      );
      assert.equal(
        await (await send('/api/records?store=settings&id=preferences', { token: 'bob' })).json(),
        null
      );
      assert.equal(
        (
          await send('/api/records', {
            token: 'bob',
            method: 'POST',
            body: { changes: [{ store: 'settings', id: 'preferences', delete: true }] }
          })
        ).status,
        200
      );
      assert.equal(
        (await (await send('/api/records?store=settings', { token: 'alice' })).json()).length,
        1
      );
      const stage = (body, token = 'alice') =>
        send('/api/restore', { token, method: 'POST', body });
      const staged = await (await stage({ action: 'start' })).json();
      assert.equal((await stage({ action: 'start' })).status, 409);
      const largeChanges = Array.from({ length: 3 }, (_, i) => ({
        store: 'history',
        value: historyRecord('restore-' + i, { data: 'x'.repeat(800000) })
      }));
      assert.equal(
        (
          await stage(
            { action: 'upload', id: staged.id, part: 0, changes: [largeChanges[0]] },
            'bob'
          )
        ).status,
        410
      );
      assert.equal(
        (await stage({ action: 'upload', id: staged.id, part: 1, changes: [largeChanges[0]] }))
          .status,
        400
      );
      for (let part = 0; part < 3; part++) {
        const response = await stage({
          action: 'upload',
          id: staged.id,
          part,
          changes: [largeChanges[part]]
        });
        assert.equal(response.status, 200, await response.text());
      }
      assert.deepEqual(
        await (await send('/api/records?store=history', { token: 'alice' })).json(),
        []
      );
      assert.equal((await stage({ action: 'commit', id: staged.id, parts: 2 })).status, 400);
      assert.equal((await stage({ action: 'commit', id: staged.id, parts: 3 }, 'bob')).status, 410);
      assert.equal((await stage({ action: 'commit', id: staged.id, parts: 3 })).status, 200);
      assert.equal(
        (await (await send('/api/records?store=history', { token: 'alice' })).json()).length,
        3
      );
      assert.equal((await stage({ action: 'commit', id: staged.id, parts: 3 })).status, 410);
      assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM restore_chunks').first()).n, 0);
      await send('/api/records', { token: 'alice', method: 'POST', body: { clear: 'history' } });
      // Duplicate identities across chunks cannot alter the live library.
      const duplicate = await (await stage({ action: 'start' })).json();
      for (let part = 0; part < 2; part++)
        assert.equal(
          (await stage({ action: 'upload', id: duplicate.id, part, changes: [largeChanges[0]] }))
            .status,
          200
        );
      assert.equal((await stage({ action: 'commit', id: duplicate.id, parts: 2 })).status, 400);
      assert.deepEqual(
        await (await send('/api/records?store=history', { token: 'alice' })).json(),
        []
      );
      assert.equal((await stage({ action: 'cancel', id: duplicate.id })).status, 200);
      const conflicting = await (await stage({ action: 'start' })).json();
      const conflicts = [
        { store: 'settings', value: preferences({ theme: 'light' }) },
        { store: 'settings', id: 'preferences', delete: true, value: { id: 'decoy' } }
      ];
      for (let part = 0; part < 2; part++)
        assert.equal(
          (await stage({ action: 'upload', id: conflicting.id, part, changes: [conflicts[part]] }))
            .status,
          200
        );
      assert.equal((await stage({ action: 'commit', id: conflicting.id, parts: 2 })).status, 400);
      assert.equal(
        (
          await (
            await send('/api/records?store=settings&id=preferences', { token: 'alice' })
          ).json()
        ).theme,
        'dark'
      );
      await stage({ action: 'cancel', id: conflicting.id });
      // Fill nearly all account space, then prove a failed batch rolls back its first write too.
      for (let i = 0; i < 20; i++)
        await DB.prepare('INSERT INTO records VALUES (?,?,?,?,?)')
          .bind(
            'a',
            'history',
            'fill' + i,
            JSON.stringify({ id: 'fill' + i, text: 'x'.repeat(1000000) }),
            1000050
          )
          .run();
      const failed = await write([
        { store: 'settings', value: preferences({ theme: 'light' }) },
        { store: 'history', value: historyRecord('overflow', { text: 'x'.repeat(1048400) }) }
      ]);
      assert.equal(failed.status, 413);
      assert.equal(
        (
          await (
            await send('/api/records?store=settings&id=preferences', { token: 'alice' })
          ).json()
        ).theme,
        'dark'
      );
      // A quota failure at final commit rolls back earlier updates and retains
      // the invisible upload for cancellation/retry.
      const overflow = await (await stage({ action: 'start' })).json();
      assert.equal(
        (
          await stage({
            action: 'upload',
            id: overflow.id,
            part: 0,
            changes: [
              { store: 'settings', value: preferences({ theme: 'light' }) },
              {
                store: 'history',
                value: historyRecord('restore-overflow', { data: 'x'.repeat(1048300) })
              }
            ]
          })
        ).status,
        200
      );
      assert.equal((await stage({ action: 'commit', id: overflow.id, parts: 1 })).status, 413);
      assert.equal(
        (
          await (
            await send('/api/records?store=settings&id=preferences', { token: 'alice' })
          ).json()
        ).theme,
        'dark'
      );
      assert.equal((await stage({ action: 'cancel', id: overflow.id })).status, 200);
      // Clear is scoped to the current user.
      await send('/api/records', { token: 'bob', method: 'POST', body: { clear: 'settings' } });
      assert.equal(
        (await (await send('/api/records?store=settings', { token: 'alice' })).json()).length,
        1
      );
      const start = await send('/api/auth/google');
      assert.equal(start.status, 302);
      const google = new URL(start.headers.get('Location'));
      assert.equal(google.searchParams.get('code_challenge_method'), 'S256');
      const state = google.searchParams.get('state');
      const oauthCookie = start.headers.get('Set-Cookie').split(';')[0];
      assert.match(start.headers.get('Set-Cookie'), /HttpOnly; SameSite=Lax/);
      assert.match(start.headers.get('Set-Cookie'), /Secure/);
      assert.equal((await send(`/api/auth/callback?state=${state}&code=one`)).status, 400);
      let fetched = 0;
      globalThis.fetch = async (url, options) => {
        fetched++;
        if (url === 'https://oauth2.googleapis.com/token') {
          assert.equal(options.body.get('client_secret'), 'secret');
          assert.ok(options.body.get('code_verifier'));
          return Response.json({ access_token: 'google-token' });
        }
        assert.equal(options.headers.Authorization, 'Bearer google-token');
        return Response.json({
          sub: 'new-google-user',
          email: 'new@example.com',
          name: 'New',
          email_verified: true
        });
      };
      const login = await send(`/api/auth/callback?state=${state}&code=one`, {
        cookie: oauthCookie
      });
      assert.equal(login.status, 302);
      assert.equal(fetched, 2);
      const token = login.headers.get('Set-Cookie').match(/__Host-qr_session=([^;]+)/)[1];
      assert.equal(
        (await (await send('/api/auth/session', { token })).json()).user.id,
        'new-google-user'
      );
      assert.equal(
        (await send(`/api/auth/callback?state=${state}&code=one`, { cookie: oauthCookie })).status,
        400
      );
      assert.equal(
        (await send('/api/auth/logout', { token, method: 'POST', body: {} })).status,
        200
      );
      assert.equal((await send('/api/records?store=banks', { token })).status, 401);
      // A new binding wrapper simulates a fresh isolate: D1 remains authoritative.
      const initiate = (DBBinding = DB) =>
        onRequest({
          env: { ...env, DB: DBBinding },
          request: new Request(env.APP_ORIGIN + '/api/auth/google', {
            headers: { 'CF-Connecting-IP': '192.0.2.10' }
          })
        });
      const starts = await Promise.all(Array.from({ length: 12 }, () => initiate()));
      assert.equal(starts.filter((r) => r.status === 302).length, 10);
      assert.equal(starts.filter((r) => r.status === 429).length, 2);
      const stateCount = (await DB.prepare('SELECT COUNT(*) AS n FROM oauth_states').first()).n;
      assert.equal((await initiate({ ...DB })).status, 429);
      assert.equal(
        (await DB.prepare('SELECT COUNT(*) AS n FROM oauth_states').first()).n,
        stateCount
      );
      await DB.prepare("UPDATE oauth_limits SET requests=1 WHERE key='global'").run();
      await DB.prepare(
        `INSERT INTO oauth_states
        SELECT 'pending-' || value, 'verifier', ? FROM json_each(?)`
      )
        .bind(
          Date.now() + 600000,
          JSON.stringify(Array.from({ length: 1000 - stateCount }, (_, i) => i))
        )
        .run();
      assert.equal(
        (
          await onRequest({
            env: { ...env, DB: { ...DB } },
            request: new Request(env.APP_ORIGIN + '/api/auth/google', {
              headers: { 'CF-Connecting-IP': '192.0.2.12' }
            })
          })
        ).status,
        429
      );
      assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM oauth_states').first()).n, 1000);
      await DB.prepare('UPDATE oauth_states SET expires_at=0').run();
      assert.equal(
        (
          await onRequest({
            env: { ...env, DB: { ...DB } },
            request: new Request(env.APP_ORIGIN + '/api/auth/google', {
              headers: { 'CF-Connecting-IP': '192.0.2.13' }
            })
          })
        ).status,
        302
      );
      assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM oauth_states').first()).n, 873);
      // Hot clients are refused without preparing any further database statements.
      const prepare = DB.prepare;
      DB.prepare = () => {
        throw new Error('Rate-limited requests must not touch D1');
      };
      const limited = await initiate();
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get('Retry-After')) > 0);
      DB.prepare = prepare;
      await DB.prepare("UPDATE oauth_limits SET requests=maximum WHERE key='global'").run();
      assert.equal(
        (
          await onRequest({
            env: { ...env, DB: { ...DB } },
            request: new Request(env.APP_ORIGIN + '/api/auth/google', {
              headers: { 'CF-Connecting-IP': '192.0.2.11' }
            })
          })
        ).status,
        429
      );
      assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM oauth_states').first()).n, 873);
    } finally {
      globalThis.fetch = oldFetch;
      await rm(directory, { recursive: true, force: true });
    }
  }
);
