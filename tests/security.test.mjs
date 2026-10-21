import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { validateRecord } from '../js/records.js';
import { validateChanges } from '../server/records.js';
import { validateBackup, backupParts, mergePlan } from '../js/transfer.js';
import { createAutosave } from '../js/autosave.js';
import { admitWrite, cleanupExpired, API_WINDOW } from '../server/maintenance.js';
import { onRequest, hash } from '../functions/api/[[path]].js';
import { LIMITS, jsonBytes } from '../js/limits.js';
import { preferences, historyRecord, stateRecord, examRecord } from './fixtures.mjs';
globalThis.crypto ??= webcrypto;
const supported = Number(process.versions.node.split('.')[0]) >= 22;
const migrations = [
  '0001_accounts.sql',
  '0002_restore.sql',
  '0003_oauth_limits.sql',
  '0004_constant_quotas.sql',
  '0005_api_maintenance.sql'
];
async function database() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of migrations)
    db.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
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
        async run() {
          return statement.run(...this.args);
        },
        async all() {
          return { results: statement.all(...this.args) };
        },
        execute() {
          return { results: statement.all(...this.args) };
        }
      };
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = statements.map((s) => s.execute());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  };
  return { db, DB };
}

test('API writes and backups use the same record schemas for every store', async () => {
  const valid = {
    settings: preferences(),
    history: historyRecord('h1'),
    states: stateRecord(),
    active: examRecord(),
    attempts: examRecord({ id: 'a1', completedAt: 10 })
  };
  const invalid = {
    settings: { id: 'preferences', theme: 'dark' },
    history: { id: 'h1', response: 'bad' },
    states: { id: 'q1', due: 1 },
    active: { id: 'current' },
    attempts: { id: 'a1', items: [] }
  };
  for (const store of Object.keys(valid)) {
    assert.equal(validateRecord(store, valid[store]), valid[store]);
    assert.doesNotThrow(() => validateChanges([{ store, value: valid[store] }]));
    await validateBackup({
      format: 'quitsar-backup',
      version: 1,
      records: { [store]: [valid[store]] }
    });
    assert.throws(
      () => validateChanges([{ store, value: invalid[store] }]),
      (e) => e.status === 400
    );
    await assert.rejects(
      validateBackup({
        format: 'quitsar-backup',
        version: 1,
        records: { [store]: [invalid[store]] }
      })
    );
  }
  assert.throws(() => validateRecord('history', historyRecord('bad\0id')));
  const active = examRecord();
  active.items[0].selected = ['unknown'];
  assert.throws(() => validateChanges([{ store: 'active', value: active }]));
});

test(
  'quota migration backfills existing data and counters follow upsert, delete and rollback',
  { skip: !supported },
  async (t) => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(await readFile(new URL('../migrations/0001_accounts.sql', import.meta.url), 'utf8'));
    db.exec(`INSERT INTO users VALUES ('a','a@a','A',1); INSERT INTO users VALUES ('b','b@b','B',1);
    INSERT INTO records VALUES ('a','history','old','{"id":"old"}',12);`);
    db.exec(
      await readFile(new URL('../migrations/0004_constant_quotas.sql', import.meta.url), 'utf8')
    );
    const usage = () => ({
      ...db.prepare("SELECT bytes,records FROM account_usage WHERE user_id='a'").get()
    });
    assert.deepEqual(usage(), { bytes: 12, records: 1 });
    db.exec(`INSERT INTO records VALUES ('a','history','old','{"id":"old"}',30)
    ON CONFLICT(user_id,store,id) DO UPDATE SET bytes=excluded.bytes;`);
    assert.deepEqual(usage(), { bytes: 30, records: 1 });
    db.exec(
      `INSERT INTO records VALUES ('b','history','b','{}',10); DELETE FROM records WHERE user_id='a';`
    );
    assert.deepEqual(usage(), { bytes: 0, records: 0 });
    const insert = db.prepare("INSERT INTO records VALUES ('a','history',?,'{}',1048576)");
    for (let i = 0; i < 20; i++) insert.run(String(i));
    assert.deepEqual(usage(), { bytes: LIMITS.account, records: 20 });
    db.exec('BEGIN');
    db.exec("UPDATE records SET bytes=1 WHERE user_id='a' AND id='0'");
    assert.throws(() => {
      insert.run('overflow1');
      insert.run('overflow2');
    }, /account_quota/);
    db.exec('ROLLBACK');
    assert.deepEqual(usage(), { bytes: LIMITS.account, records: 20 });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM records WHERE user_id='b'").get().n, 1);
  }
);

test(
  '20,000 permitted inserts stay within a linear SQLite instruction budget',
  { skip: spawnSync('python3', ['--version']).status !== 0 },
  () => {
    const result = spawnSync(
      'python3',
      [
        '-c',
        `import sqlite3,pathlib
c=sqlite3.connect(':memory:')
for name in ['0001_accounts.sql','0004_constant_quotas.sql']:
 c.executescript(pathlib.Path('migrations',name).read_text())
c.execute("INSERT INTO users VALUES ('a','a@a','A',0)")
steps=0
def budget():
 global steps
 steps+=1
 return steps>10000
c.set_progress_handler(budget,1000)
c.executemany("INSERT INTO records VALUES ('a','history',?,'{}',2)",((str(i),) for i in range(20000)))
assert c.execute("SELECT records FROM account_usage WHERE user_id='a'").fetchone()[0]==20000
try: c.execute("INSERT INTO records VALUES ('a','history','overflow','{}',2)")
except sqlite3.IntegrityError as e: assert 'account_quota' in str(e)
else: raise AssertionError('record quota bypassed')
print(steps*1000)
`
      ],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Number(result.stdout) < 10000000);
  }
);

test(
  'write limits survive fresh bindings, expire, and reject requests before body validation',
  { skip: !supported },
  async (t) => {
    const { db, DB } = await database();
    t.after(() => db.close());
    db.exec("INSERT INTO users VALUES ('a','a@a','A',1)");
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(
      await hash('token'),
      'a',
      Date.now() + 60000
    );
    const now = Date.now();
    for (let i = 0; i < 120; i++) await admitWrite({ ...DB }, 'a', now);
    await assert.rejects(admitWrite({ ...DB }, 'a', now), /api_rate/);
    const response = await onRequest({
      env: { DB: { ...DB } },
      request: new Request('https://study.example/api/records', {
        method: 'POST',
        headers: {
          Origin: 'https://study.example',
          Cookie: '__Host-qr_session=token',
          'X-Quitsar-User': 'a',
          'Content-Type': 'application/json'
        },
        body: '{malformed'
      })
    });
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get('Retry-After')) > 0);
    await admitWrite({ ...DB }, 'a', now + API_WINDOW);
    // Global protection remains independent of the per-account bucket.
    db.prepare("UPDATE api_limits SET requests=maximum WHERE key='global'").run();
    await assert.rejects(admitWrite({ ...DB }, 'b', now + API_WINDOW), /api_rate/);
  }
);

test(
  'cleanup reclaims other owners uploads in bounded passes and preserves live uploads',
  { skip: !supported },
  async (t) => {
    const { db, DB } = await database();
    t.after(() => db.close());
    for (let i = 0; i < 7; i++) {
      db.prepare('INSERT INTO restore_batches (owner,id,expires_at) VALUES (?,?,?)').run(
        'owner' + i,
        'id' + i,
        i === 6 ? Date.now() + 60000 : 0
      );
      db.prepare('INSERT INTO restore_chunks VALUES (?,?,?,?,?,?)').run(
        'owner' + i,
        'id' + i,
        0,
        '[]',
        2,
        1
      );
    }
    await cleanupExpired(DB);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM restore_batches').get().n, 3);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM restore_chunks').get().n, 3);
    await cleanupExpired(DB);
    assert.equal(db.prepare('SELECT owner FROM restore_batches').get().owner, 'owner6');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM restore_chunks').get().n, 1);
  }
);

test('autosave coalesces typing during a slow write and flushes the latest answer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let latest = '',
    release;
  const writes = [],
    pending = [];
  const saver = createAutosave(
    async () => {
      writes.push(latest);
      if (writes.length === 1)
        await new Promise((resolve) => {
          release = resolve;
        });
    },
    { onPending: (value) => pending.push(value) }
  );
  for (let i = 0; i < 100; i++) {
    latest = String(i);
    saver.schedule();
  }
  t.mock.timers.tick(749);
  assert.equal(writes.length, 0);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.deepEqual(writes, ['99']);
  for (let i = 100; i < 200; i++) {
    latest = String(i);
    saver.schedule();
  }
  assert.equal(writes.length, 1);
  release();
  await saver.flush();
  assert.deepEqual(writes, ['99', '199']);
  assert.equal(pending.at(-1), false);
  t.mock.timers.tick(10000);
  await Promise.resolve();
  assert.equal(writes.length, 2);
});

test('autosave retains a failed snapshot for explicit retry', async () => {
  let calls = 0;
  const saver = createAutosave(async () => {
    if (++calls === 1) throw new Error('offline');
  });
  saver.schedule();
  await assert.rejects(saver.flush(), /offline/);
  await saver.flush();
  assert.equal(calls, 2);
});

test('large backup parts round-trip without exceeding import or staged-restore limits', async () => {
  const records = {
    history: Array.from({ length: 30 }, (_, i) =>
      historyRecord('row' + i, { padding: 'é'.repeat(440000) })
    )
  };
  assert.ok(jsonBytes(records) > LIMITS.backup);
  const parts = backupParts(records);
  assert.ok(parts.length > 1);
  const restored = {};
  for (const part of parts) {
    assert.ok(jsonBytes(part) <= 16 * 1024 * 1024);
    const incoming = await validateBackup(part);
    const { changes } = mergePlan(incoming, restored);
    assert.ok(jsonBytes(changes) <= LIMITS.backup);
    for (const change of changes) (restored[change.store] ||= []).push(change.value);
  }
  assert.deepEqual(restored, records);
  assert.equal(backupParts({ history: records.history.slice(0, 5) }, { maxRecords: 2 }).length, 3);
});
