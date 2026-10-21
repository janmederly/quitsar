import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { stores, readBody, validateChanges } from '../server/records.js';
import { LIMITS } from '../js/limits.js';
import { admitWrite, cleanupExpired, maintain } from '../server/maintenance.js';
import { restore } from '../server/restore.js';

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};

// One library per file. No users, passwords, sessions, or Google credentials.
export async function openLocalDatabase(filename) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS records (
      store TEXT NOT NULL CHECK(store IN ('banks','states','attempts','history','settings','active')),
      id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 400),
      value TEXT NOT NULL CHECK(json_valid(value)),
      bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 1048576),
      PRIMARY KEY(store, id)
    );
  `);
  if (db.prepare('PRAGMA user_version').get().user_version < 2) {
    const schema = await readFile(
      new URL('../migrations/0002_restore.sql', import.meta.url),
      'utf8'
    );
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(schema);
      db.exec('PRAGMA user_version=2; COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }
  if (db.prepare('PRAGMA user_version').get().user_version < 5) {
    const schema = await readFile(
      new URL('../migrations/0005_api_maintenance.sql', import.meta.url),
      'utf8'
    );
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(schema);
      db.exec('PRAGMA user_version=5; COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }
  const adapter = {
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
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => statement.execute());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  };
  await cleanupExpired(adapter);
  const maintenanceTimer = setInterval(() => {
    cleanupExpired(adapter).catch((error) =>
      console.error('Database cleanup failed:', error.message)
    );
  }, 60000);
  maintenanceTimer.unref();
  const one = db.prepare('SELECT value FROM records WHERE store=? AND id=?');
  const all = db.prepare('SELECT value FROM records WHERE store=? ORDER BY id');
  const clear = db.prepare('DELETE FROM records WHERE store=?');
  const remove = db.prepare('DELETE FROM records WHERE store=? AND id=?');
  const put = db.prepare(`INSERT INTO records (store,id,value,bytes) VALUES (?,?,?,?)
    ON CONFLICT(store,id) DO UPDATE SET value=excluded.value,bytes=excluded.bytes`);
  return {
    close: () => {
      clearInterval(maintenanceTimer);
      db.close();
    },
    async handle(request) {
      const url = new URL(request.url);
      if (!['GET', 'POST'].includes(request.method)) fail(405, 'Method not allowed.');
      if (request.method === 'POST' && request.headers.get('Origin') !== url.origin)
        fail(403, 'Cross-origin writes are forbidden.');
      if (request.method === 'POST') {
        try {
          await admitWrite(adapter, 'local');
        } catch (error) {
          if (/api_rate/.test(error.message))
            fail(429, 'Too many writes. Please wait a minute and retry.');
          throw error;
        }
      }
      await maintain(adapter);
      if (url.pathname === '/api/auth/session' && request.method === 'GET')
        return { user: null, googleEnabled: false, storage: 'local', limits: LIMITS };
      if (url.pathname === '/api/restore' && request.method === 'POST')
        return restore(request, adapter, 'local', true);
      if (url.pathname !== '/api/records') fail(404, 'Unknown API route.');
      if (request.method === 'GET') {
        const store = url.searchParams.get('store');
        if (!stores.has(store)) fail(400, 'Invalid store.');
        const id = url.searchParams.get('id');
        if (id !== null) {
          const row = one.get(store, id);
          return row ? JSON.parse(row.value) : null;
        }
        return all.all(store).map((row) => JSON.parse(row.value));
      }
      const body = await readBody(request);
      const names = body?.clearStores ?? (body?.clear ? [body.clear] : null);
      if (names !== null) {
        if (
          !Array.isArray(names) ||
          !names.length ||
          names.length > stores.size ||
          names.some((name) => !stores.has(name))
        )
          fail(400, 'Invalid stores to clear.');
      } else validateChanges(body?.changes);
      // No await inside the transaction: another HTTP request cannot interleave writes.
      db.exec('BEGIN IMMEDIATE');
      try {
        if (names) {
          for (const name of names) clear.run(name);
        } else {
          for (const change of body.changes) {
            if (change.delete) remove.run(change.store, change.id);
            else {
              const value = JSON.stringify(change.value);
              put.run(change.store, change.value.id, value, Buffer.byteLength(value));
            }
          }
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return { ok: true };
    }
  };
}
