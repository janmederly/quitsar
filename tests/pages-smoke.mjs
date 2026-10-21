// Run with Node 22+ after `npm run build`; uses an isolated local D1 database.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';

const state = await mkdtemp(path.join(tmpdir(), 'quitsar-pages-'));
const wrangler = path.resolve('node_modules/wrangler/bin/wrangler.js');
const origin = 'http://localhost:8789';
let server, browser;
let logs = '';
function cli(args) {
  const result = spawnSync(process.execPath, [wrangler, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
try {
  cli(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state]);
  const seed = path.join(state, 'seed.sql');
  const token = 'pages-smoke-test-only';
  const digest = createHash('sha256').update(token).digest('hex');
  await writeFile(
    seed,
    `INSERT INTO users VALUES ('smoke','smoke@example.com','Smoke',1);
INSERT INTO sessions VALUES ('${digest}','smoke',${Date.now() + 300000});`
  );
  cli(['d1', 'execute', 'DB', '--local', '--persist-to', state, '--file', seed]);
  server = spawn(
    process.execPath,
    [
      wrangler,
      'pages',
      'dev',
      '--port=8789',
      '--persist-to',
      state,
      '--binding=GOOGLE_CLIENT_ID=smoke-client',
      '--binding=GOOGLE_CLIENT_SECRET=smoke-secret',
      '--binding=APP_ORIGIN=' + origin
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  server.stdout.on('data', (chunk) => {
    logs += chunk;
  });
  server.stderr.on('data', (chunk) => {
    logs += chunk;
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(origin + '/api/auth/session')).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, logs);
  // Exercise the SQL-backed pending-state cap in the actual D1 runtime, even
  // when this isolate has not seen enough requests to trip its memory gate.
  const pending = path.join(state, 'pending.sql');
  await writeFile(
    pending,
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<999)
    INSERT INTO oauth_states SELECT 'pending-' || i, 'test-verifier', ${Date.now() + 300000} FROM n;`
  );
  cli(['d1', 'execute', 'DB', '--local', '--persist-to', state, '--file', pending]);
  const limited = await fetch(origin + '/api/auth/google', { redirect: 'manual' });
  assert.equal(limited.status, 429, await limited.text());
  assert.ok(Number(limited.headers.get('Retry-After')) > 0);
  const homepage = await fetch(origin + '/');
  assert.equal(homepage.status, 200);
  const html = await homepage.text();
  assert.match(html, /name="description"/);
  assert.match(html, /<h1>A little progress, every day\.<\/h1>/);
  const schema = JSON.parse(
    html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)[1]
  );
  assert.equal(schema['@type'], 'WebApplication');
  const robots = await fetch(origin + '/robots.txt');
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get('Content-Type'), /text\/plain/);
  assert.match(await robots.text(), /Disallow: \/api\//);
  const sitemap = await fetch(origin + '/sitemap.xml');
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers.get('Content-Type'), /xml/);
  assert.match(
    await sitemap.text(),
    /<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9"/
  );
  assert.equal((await fetch(origin + '/banks/demo.json')).headers.get('X-Robots-Tag'), 'noindex');
  const missing = await fetch(origin + '/does-not-exist');
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /name="robots" content="noindex"/);
  for (const url of [
    '/.dev.vars',
    '/wrangler.toml',
    '/migrations/0001_accounts.sql',
    '/tests/accounts.test.mjs'
  ]) {
    assert.equal((await fetch(origin + url)).status, 404, url);
  }
  assert.equal((await fetch(origin + '/api/records?store=banks')).status, 401);
  const changes = Array.from({ length: 120 }, (_, i) => ({
    store: 'history',
    value: { id: String(i), at: i, bankId: 'demo', questionId: 'q1', response: 'know' }
  }));
  const post = await fetch(origin + '/api/records', {
    method: 'POST',
    headers: {
      Origin: origin,
      Cookie: `qr_session=${token}`,
      'X-Quitsar-User': 'smoke',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ changes })
  });
  assert.equal(post.status, 200, await post.text());
  const saved = await fetch(origin + '/api/records?store=history', {
    headers: { Cookie: `qr_session=${token}`, 'X-Quitsar-User': 'smoke' }
  });
  assert.equal((await saved.json()).length, 120);
  assert.equal(saved.headers.get('Cache-Control'), 'no-store');
  browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addCookies([
    { name: 'qr_session', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }
  ]);
  const page = await context.newPage();
  await page.goto(origin);
  await page.getByText('smoke@example.com', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Question banks', exact: true }).click();
  await page.getByRole('button', { name: 'Load included demo bank' }).click();
  await page.getByText('Demo saved to your account with all images.', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Theme', { exact: true }).selectOption('dark');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByText('Preferences saved to your account.', { exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Save settings', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Theme', { exact: true }).inputValue(), 'dark');
  await page.evaluate(async () => {
    const db = await import('/js/storage.js');
    await Promise.all(
      Array.from({ length: 12 }, (_, value) => db.put('settings', { id: 'storage-check', value }))
    );
    if ((await db.get('settings', 'storage-check')).value !== 11)
      throw new Error('Account autosaves completed out of order');
    await db.remove('settings', 'storage-check');
    await db.restoreChanges(
      Array.from({ length: 3 }, (_, i) => ({
        store: 'history',
        value: {
          id: 'staged-' + i,
          at: i,
          bankId: 'demo',
          questionId: 'q1',
          response: 'know',
          padding: 'x'.repeat(790000)
        }
      }))
    );
    for (let i = 0; i < 3; i++) {
      const row = await db.get('history', 'staged-' + i);
      if (row.padding.length !== 790000) throw new Error('Large account restore failed');
    }
  });
  // Account data never creates a guest database.
  assert.equal(
    await page.evaluate(async () =>
      (await indexedDB.databases()).some((db) => db.name === 'quitsar')
    ),
    false
  );
  await context.clearCookies();
  await page.reload();
  await page.getByRole('heading', { name: 'Study storage could not be opened' }).waitFor();
  await page.getByRole('button', { name: 'Continue as guest' }).waitFor();
  assert.equal(
    await page.evaluate(async () =>
      (await indexedDB.databases()).some((db) => db.name === 'quitsar')
    ),
    false
  );
  await context.close();
  console.log(
    'Pages smoke passed: routing, secret exclusion, D1 OAuth limits, large atomic restores, account uploads/settings, save ordering and expired-session isolation.'
  );
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  if (server) {
    server.kill('SIGTERM');
    await new Promise((resolve) => {
      server.once('exit', resolve);
      setTimeout(resolve, 3000).unref();
    });
  }
  await rm(state, { recursive: true, force: true });
}
