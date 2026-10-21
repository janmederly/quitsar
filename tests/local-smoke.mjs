// Run with Node 22.13+ and Playwright Chromium installed.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const directory = await mkdtemp(path.join(tmpdir(), 'quitsar-local-browser-'));
let server, browser, origin;
async function start() {
  server = spawn(process.execPath, ['tools/serve.mjs', '--local-db'], {
    env: {
      ...process.env,
      STORAGE_MODE: 'local',
      PORT: '0',
      HOST: '127.0.0.1',
      LOCAL_DB_PATH: path.join(directory, 'library.sqlite')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  origin = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(output)), 10000);
    server.stderr.on('data', (chunk) => {
      output += chunk;
    });
    server.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Exited ${code}: ${output}`));
    });
    server.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/listening on 127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
  });
}
async function stop() {
  if (server?.exitCode === null)
    await new Promise((resolve) => {
      server.once('exit', resolve);
      server.kill('SIGTERM');
    });
}
async function go(page, name) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name, exact: true })
    .click();
}
async function data(page, store) {
  return page.evaluate(async (store) => (await import('/js/storage.js')).all(store), store);
}
try {
  await start();
  browser = await chromium.launch();
  const context = await browser.newContext({ locale: 'en-GB' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole('heading', { name: 'A little progress, every day.' }).waitFor();
  assert.match(await page.locator('.local-label').textContent(), /Local database/);
  if (await page.locator('#account-toggle').isVisible())
    await page.locator('#account-toggle').click();
  assert.equal(await page.getByText('Local database · single user', { exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Sign out', exact: true }).count(), 0);
  await go(page, 'Question banks');
  await page.getByRole('button', { name: 'Load included demo bank' }).click();
  await page.getByText('Saved to the local database.', { exact: true }).waitFor();
  assert.equal((await data(page, 'banks')).length, 1);
  assert.ok(Object.keys((await data(page, 'banks'))[0].assets).length);
  await go(page, 'Settings');
  await page.getByLabel('Theme', { exact: true }).selectOption('dark');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await go(page, 'Study');
  await page.getByRole('button', { name: 'Start session' }).click();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await page.getByText('Skipped · Saved to your skipped queue', { exact: true }).waitFor();
  assert.equal((await data(page, 'history')).length, 1);
  await go(page, 'Exam simulator');
  await page.getByLabel('Number of questions').fill('1');
  await page.getByLabel('Use countdown timer').uncheck();
  await page.getByRole('button', { name: 'Preview exam' }).click();
  await page.getByRole('button', { name: 'Start exam', exact: true }).click();
  await page.getByRole('heading', { name: 'Question 1 of 1', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Submit exam', exact: true }).click();
  await page.getByRole('button', { name: 'Submit & save results' }).click();
  await page.getByRole('heading', { name: 'A clearer picture of your progress.' }).waitFor();
  assert.equal((await data(page, 'attempts')).length, 1);
  assert.equal((await data(page, 'active')).length, 0);
  assert.ok((await data(page, 'states')).length);
  assert.ok(
    !(await page.evaluate(() => indexedDB.databases())).some((db) => db.name === 'quitsar')
  );
  // A slow server must retain only the current write and the latest answer.
  await go(page, 'Exam simulator');
  await page.getByLabel('Number of questions').fill('1');
  await page.getByLabel('Include open-ended self-assessment').check();
  await page.getByLabel('Question types', { exact: true }).selectOption('open_ended');
  await page.getByLabel('Use countdown timer').uncheck();
  await page.getByRole('button', { name: 'Preview exam' }).click();
  await page.getByRole('button', { name: 'Start exam', exact: true }).click();
  const answer = page.locator('textarea');
  await answer.waitFor();
  await page
    .locator('.exam-aside')
    .getByText('✓ Progress saved locally', { exact: true })
    .waitFor();
  let releaseWrite, startedWrite;
  const blocked = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  const started = new Promise((resolve) => {
    startedWrite = resolve;
  });
  const snapshots = [];
  await page.route('**/api/records', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      const change = body.changes?.find((change) => change.store === 'active' && !change.delete);
      if (change) {
        snapshots.push(change.value);
        if (snapshots.length === 1) {
          startedWrite();
          await blocked;
        }
      }
    }
    return route.continue();
  });
  await answer.fill('first answer');
  await started;
  await answer.evaluate((node) => {
    for (let i = 0; i < 100; i++) {
      node.value = 'latest answer ' + i;
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await go(page, 'Overview');
  releaseWrite();
  await page.getByRole('heading', { name: 'A little progress, every day.' }).waitFor();
  assert.equal(snapshots.length, 2);
  assert.equal((await data(page, 'active'))[0].items[0].text, 'latest answer 99');
  await go(page, 'Exam simulator');
  await page.getByRole('button', { name: 'Resume exam', exact: true }).click();
  assert.equal(await answer.inputValue(), 'latest answer 99');
  await answer.fill('final answer before debounce');
  await page.getByRole('button', { name: 'Submit exam', exact: true }).click();
  await page.getByRole('button', { name: 'Submit & save results' }).click();
  await page.getByRole('heading', { name: 'A clearer picture of your progress.' }).waitFor();
  const completed = (await data(page, 'attempts')).find(
    (a) => a.items[0].text === 'final answer before debounce'
  );
  assert.ok(completed);
  assert.equal((await data(page, 'active')).length, 0);
  await page.unroute('**/api/records');
  await page.evaluate(
    async (id) => (await import('/js/storage.js')).remove('attempts', id),
    completed.id
  );
  // Restore an actual >2 MiB file through the UI. Chunks remain invisible until
  // the final commit; failure of an intermediate upload leaves no partial data.
  const largeBackup = JSON.stringify({
    format: 'quitsar-backup',
    version: 1,
    records: {
      history: Array.from({ length: 3 }, (_, i) => ({
        id: 'large-restore-' + i,
        bankId: 'demo',
        questionId: 'q1',
        at: i + 1,
        response: 'know',
        padding: 'x'.repeat(790000)
      }))
    }
  });
  assert.ok(Buffer.byteLength(largeBackup) > 2 * 1024 * 1024);
  const beforeHistory = (await data(page, 'history')).length;
  await go(page, 'Backup & export');
  await page.getByLabel('Backup or study-data JSON').setInputFiles({
    name: 'large.json',
    mimeType: 'application/json',
    buffer: Buffer.from(largeBackup)
  });
  await page.getByRole('button', { name: 'Validate & preview merge' }).click();
  await page.getByRole('heading', { name: 'Ready to merge' }).waitFor();
  let uploads = 0;
  await page.route('**/api/restore', async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === 'upload' && ++uploads === 2)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Simulated interrupted upload' })
      });
    return route.continue();
  });
  await page.getByRole('button', { name: 'Confirm merge' }).click();
  await page.getByText('Simulated interrupted upload', { exact: true }).waitFor();
  assert.equal((await data(page, 'history')).length, beforeHistory);
  await page.unroute('**/api/restore');
  await page.getByRole('button', { name: 'Confirm merge' }).click();
  await page.getByText('Saved to the local database.', { exact: true }).waitFor();
  assert.equal((await data(page, 'history')).length, beforeHistory + 3);
  await context.close();
  await stop();
  await start();
  // A fresh browser context at a new origin still sees the host's persisted library.
  const fresh = await browser.newContext({ locale: 'en-GB' });
  const again = await fresh.newPage();
  await again.goto(origin);
  await again.getByRole('heading', { name: 'A little progress, every day.' }).waitFor();
  assert.equal((await data(again, 'banks')).length, 1);
  assert.equal((await data(again, 'attempts')).length, 1);
  assert.equal(await again.locator('html').getAttribute('data-theme'), 'dark');
  // Cached UI must not silently switch to a new guest library without the API.
  await again.evaluate(() => navigator.serviceWorker.ready);
  await fresh.setOffline(true);
  await again.reload();
  await again.getByRole('heading', { name: 'Study storage could not be opened' }).waitFor();
  assert.match(await again.locator('main').textContent(), /Local database unavailable/);
  assert.ok(
    !(await again.evaluate(() => indexedDB.databases())).some((db) => db.name === 'quitsar')
  );
  assert.deepEqual(errors, []);
  console.log(
    'Local browser smoke passed: images, preferences, study, exams, large atomic restore/recovery, restart persistence, and offline isolation.'
  );
} finally {
  await browser?.close();
  await stop();
  await rm(directory, { recursive: true, force: true });
}
