import { preferences, historyRecord, stateRecord, examRecord } from './fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';

const supported = Number(process.versions.node.split('.')[0]) >= 22;
test(
  'local SQLite API persists all stores, rolls back failed writes, and isolates private files',
  { skip: !supported },
  async (t) => {
    const { DatabaseSync } = await import('node:sqlite');
    const dir = await mkdtemp(path.join(tmpdir(), 'quitsar-local-'));
    const filename = path.join(dir, 'library.sqlite');
    let server;
    t.after(async () => {
      if (server) await stop(server);
      await rm(dir, { recursive: true, force: true });
    });
    async function start(bindHost = '127.0.0.1', allowedOrigins = '') {
      server = spawn(process.execPath, ['tools/serve.mjs', '--local-db'], {
        env: {
          ...process.env,
          STORAGE_MODE: 'local',
          PORT: '0',
          HOST: bindHost,
          ALLOWED_ORIGINS: allowedOrigins,
          LOCAL_DB_PATH: filename
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      return await new Promise((resolve, reject) => {
        let log = '';
        const timer = setTimeout(() => reject(new Error(log || 'Startup timeout')), 10000);
        server.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Server exited ${code}: ${log}`));
        });
        server.stderr.on('data', (chunk) => {
          log += chunk;
        });
        server.stdout.on('data', (chunk) => {
          log += chunk;
          const match = log.match(/listening on [^ ]+:(\d+)/);
          if (match) {
            clearTimeout(timer);
            resolve(`http://127.0.0.1:${match[1]}`);
          }
        });
      });
    }
    let origin = await start();
    const post = (body, headers = {}) =>
      fetch(origin + '/api/records', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body)
      });
    const read = async (store) => (await fetch(origin + '/api/records?store=' + store)).json();
    const home = await fetch(origin + '/');
    assert.equal(home.headers.get('X-Frame-Options'), 'DENY');
    assert.equal(home.headers.get('Content-Security-Policy'), "frame-ancestors 'none'");
    const session = await (await fetch(origin + '/api/auth/session')).json();
    assert.equal(session.storage, 'local');
    assert.equal(session.user, null);
    assert.equal(session.googleEnabled, false);
    const demo = JSON.parse(await (await fetch(origin + '/banks/demo.json')).text());
    const bank = {
      id: demo.bank.id,
      data: demo,
      importedAt: 1,
      enabled: true,
      assets: {
        'images/test.svg': {
          mime: 'image/svg+xml',
          data: '<svg xmlns="http://www.w3.org/2000/svg"/>'
        }
      }
    };
    const records = {
      banks: bank,
      settings: preferences({ theme: 'dark' }),
      states: stateRecord({ due: 123 }),
      history: historyRecord('h1'),
      attempts: examRecord({ id: 'exam1', completedAt: 456 }),
      active: examRecord({ deadline: 789 })
    };
    const response = await post({
      changes: Object.entries(records).map(([store, value]) => ({ store, value }))
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(
      (await fetch(origin + '/api/records?store=banks')).headers.get('cache-control'),
      'no-store'
    );
    for (const [store, value] of Object.entries(records))
      assert.deepEqual(await read(store), [value]);
    // An independent connection proves data is in a real host SQLite file.
    const db = new DatabaseSync(filename);
    assert.equal(db.prepare('SELECT count(*) AS n FROM records').get().n, 6);
    db.exec(`CREATE TRIGGER reject_test BEFORE INSERT ON records WHEN NEW.id='fail'
      BEGIN SELECT RAISE(ABORT, 'test rollback'); END;`);
    const failed = await post({
      changes: [
        { store: 'settings', value: preferences({ theme: 'light' }) },
        { store: 'history', value: historyRecord('fail') }
      ]
    });
    assert.equal(failed.status, 500);
    assert.equal((await read('settings'))[0].theme, 'dark');
    db.exec('DROP TRIGGER reject_test');
    db.close();
    for (const body of [
      null,
      {},
      { changes: [{ store: 'bad', value: { id: 'x' } }] },
      { clearStores: 'settings' },
      { changes: [{ store: 'banks', value: { id: 'invalid' } }] }
    ])
      assert.equal((await post(body)).status, 400);
    assert.equal(
      (await post({ clear: 'settings' }, { Origin: 'https://other.example' })).status,
      403
    );
    assert.equal(
      (
        await fetch(origin + '/api/records?store=settings', {
          headers: { 'Sec-Fetch-Site': 'cross-site' }
        })
      ).status,
      403
    );
    assert.equal((await fetch(origin + '/api/records?store=invalid')).status, 400);
    for (const asset of [
      '/tools/local-db.mjs',
      '/server/records.js',
      '/package.json',
      '/.data/quitsar.sqlite',
      '/.data/quitsar.sqlite-wal',
      '/wrangler.toml'
    ])
      assert.equal((await fetch(origin + asset)).status, 404, asset);
    const large = await post({
      changes: [{ store: 'settings', value: { id: 'big', data: 'x'.repeat(2 * 1024 * 1024) } }]
    });
    assert.equal(large.status, 413);
    await stop(server);
    server = null;
    origin = await start();
    for (const [store, value] of Object.entries(records))
      assert.deepEqual(await read(store), [value]);
    assert.equal(
      (await post({ changes: [{ store: 'active', id: 'current', delete: true }] })).status,
      200
    );
    assert.deepEqual(await read('active'), []);
    assert.equal((await post({ clearStores: ['states', 'history'] })).status, 200);
    assert.deepEqual(await read('states'), []);
    assert.deepEqual(await read('history'), []);
    assert.deepEqual(await read('banks'), [bank]);
    const stage = async (body) =>
      fetch(origin + '/api/restore', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    const { id } = await (await stage({ action: 'start' })).json();
    for (let part = 0; part < 3; part++)
      assert.equal(
        (
          await stage({
            action: 'upload',
            id,
            part,
            changes: [
              {
                store: 'history',
                value: historyRecord('large-' + part, { data: 'x'.repeat(800000) })
              }
            ]
          })
        ).status,
        200
      );
    assert.deepEqual(await read('history'), []);
    assert.equal((await stage({ action: 'commit', id, parts: 3 })).status, 200);
    assert.equal((await read('history')).length, 3);
    const expired = await (await stage({ action: 'start' })).json();
    const inspect = new DatabaseSync(filename);
    inspect.prepare('UPDATE restore_batches SET expires_at=0 WHERE id=?').run(expired.id);
    assert.equal(
      (
        await stage({
          action: 'upload',
          id: expired.id,
          part: 0,
          changes: [{ store: 'history', value: historyRecord('never') }]
        })
      ).status,
      410
    );
    assert.equal((await stage({ action: 'commit', id: expired.id, parts: 1 })).status, 410);
    const replacement = await (await stage({ action: 'start' })).json();
    assert.notEqual(replacement.id, expired.id);
    await stage({ action: 'cancel', id: replacement.id });
    assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM restore_chunks').get().n, 0);
    inspect.close();
    await stop(server);
    server = null;
    origin = await start('0.0.0.0', 'http://study.internal:8080');
    const raw = (hostHeader, method = 'GET') =>
      new Promise((resolve, reject) => {
        const req = http.request(
          origin + '/api/records?store=banks',
          {
            method,
            headers: {
              Host: hostHeader,
              Origin: 'http://' + hostHeader,
              'Sec-Fetch-Site': 'same-origin',
              'Content-Type': 'application/json'
            }
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
          }
        );
        req.on('error', reject);
        req.end(method === 'POST' ? JSON.stringify({ clear: 'banks' }) : undefined);
      });
    assert.equal(await raw('rebind.attacker.test:8080'), 403);
    assert.equal(await raw('rebind.attacker.test:8080', 'POST'), 403);
    assert.equal(await raw('study.internal:8080'), 200);
    assert.deepEqual(await read('banks'), [bank]);
  }
);

async function stop(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
}
