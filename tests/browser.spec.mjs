import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { seoFiles } from '../tools/seo.mjs';
const demo = JSON.parse(await readFile(new URL('../banks/demo.json', import.meta.url), 'utf8'));
test('public overview and generated metadata remain readable without JavaScript', async ({
  browser
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    const source = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const { html } = seoFiles(source, { url: 'https://study.example.org' });
    await page.route('http://127.0.0.1:8080/', (route) =>
      route.fulfill({ contentType: 'text/html', body: html })
    );
    await page.goto('http://127.0.0.1:8080/');
    await expect(page.locator('main h1')).toHaveCount(1);
    await expect(
      page.getByRole('heading', { name: 'Your next question is a good place to start.' })
    ).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'https://study.example.org/'
    );
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index, follow');
    const schema = JSON.parse(
      await page.locator('script[type="application/ld+json"]').textContent()
    );
    expect(schema.url).toBe('https://study.example.org/');
  } finally {
    await context.close();
  }
});

test('production HTML permits the app and JSON-LD under its content security policy', async ({
  page
}) => {
  const source = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const { html } = seoFiles(source, { url: 'https://study.example.org' });
  const violations = [];
  await page.addInitScript(() => {
    window.seoCspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      window.seoCspViolations.push(event.violatedDirective)
    );
  });
  await page.route('http://127.0.0.1:8080/', (route) =>
    route.fulfill({ contentType: 'text/html', body: html })
  );
  await page.goto('/');
  await expect(page.locator('#header-language')).toBeEnabled();
  await go(page, 'Study');
  await expect(page).toHaveTitle(/quitsar/);
  violations.push(...(await page.evaluate(() => window.seoCspViolations)));
  expect(violations).toEqual([]);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    'https://study.example.org/'
  );
});

test.beforeEach(async ({ page, context }) => {
  page.on('dialog', (dialog) => dialog.accept());
  page.on('pageerror', (error) => {
    throw error;
  });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== 'http://127.0.0.1:8080')
      throw new Error(`External request: ${url}`);
    return route.continue();
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A little progress, every day.' })).toBeVisible();
});
async function go(page, name) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name, exact: true })
    .click();
}
async function loadDemo(page) {
  await go(page, 'Question banks');
  await page.getByRole('button', { name: 'Load included demo bank' }).click();
  await expect(page.getByText('Demo saved locally with all images.')).toBeVisible();
}
async function exam(page, { count = 2, open = false, timer = false, changes = true } = {}) {
  await go(page, 'Exam simulator');
  await page.getByLabel('Number of questions').fill(String(count));
  await page.getByLabel('Random question order').uncheck();
  await page.getByLabel('Use countdown timer').setChecked(timer);
  await page.getByLabel('Include open-ended self-assessment').setChecked(open);
  await page.getByLabel('Allow answer changes before final submission').setChecked(changes);
  await page.getByRole('button', { name: 'Preview exam' }).click();
  await page.getByRole('button', { name: 'Start exam', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Question 1 of ${count}` })).toBeVisible();
}
async function submit(page) {
  await page.getByRole('button', { name: 'Submit exam', exact: true }).click();
  await page.getByRole('button', { name: 'Submit & save results' }).click();
  await expect(
    page.getByRole('heading', { name: 'A clearer picture of your progress.' })
  ).toBeVisible();
}
async function records(page, store) {
  return page.evaluate(async (s) => {
    const db = await import('/js/storage.js');
    return db.all(s);
  }, store);
}

test('Google sign-in is available when the account service is configured', async ({ page }) => {
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ user: null, googleEnabled: true })
    })
  );
  await page.reload();
  await expect(page.getByRole('link', { name: 'Sign in with Google' })).toHaveAttribute(
    'href',
    '/api/auth/google'
  );
  await expect(page.getByRole('heading', { name: 'A little progress, every day.' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const accountToggle = page.getByRole('button', { name: 'Account & help', exact: true });
  await expect(accountToggle).toHaveAttribute('aria-expanded', 'false');
  await accountToggle.click();
  await expect(accountToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
  await page.getByRole('button', { name: 'Help & shortcuts' }).click();
  await expect(page.getByRole('dialog')).toContainText('Help & keyboard shortcuts');
  await page.keyboard.press('Escape');
  await accountToggle.click();
  await expect(page.locator('#sidebar-info')).toBeHidden();
});

test('empty dashboard, demo metadata, mobile layout and keyboard help', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'A fresh start' })).toBeVisible();
  await loadDemo(page);
  await page.getByRole('button', { name: 'Inspect', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('12');
  await page.keyboard.press('Escape');
  await go(page, 'Overview');
  await expect(page.getByRole('heading', { name: 'A little progress, every day.' })).toBeVisible();
  await page.screenshot({ path: 'test-results/dashboard-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/dashboard-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog')).toContainText('Alt + N');
  await page.keyboard.press('Escape');
});
test('open reveal, Know, flagged review, image and persistent schedule', async ({ page }) => {
  await loadDemo(page);
  await go(page, 'Study');
  await page.getByRole('listbox', { name: 'Question types' }).selectOption('open_ended');
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.locator('.question-images img')).toBeVisible();
  expect(
    await page
      .locator('.question-images img')
      .evaluate((img) => img.complete && img.naturalWidth > 0)
  ).toBe(true);
  await page.getByRole('textbox').fill('A ring-shaped region');
  await page.keyboard.press('Alt+f');
  await page.keyboard.press('Alt+r');
  await expect(page.getByText('Official answer', { exact: true })).toBeVisible();
  await page.keyboard.press('Alt+2');
  await expect(page.getByText(/Saved · Next due/)).toBeVisible();
  let states = await records(page, 'states');
  expect(states[0].interval).toBe(1440);
  expect(states[0].flagged).toBe(true);
  expect(states[0].repetitions).toBe(1);
  await page.reload();
  await go(page, 'Review queue');
  await page.getByRole('combobox', { name: 'Review queue' }).selectOption('flagged');
  await expect(page.getByText('1 eligible questions')).toBeVisible();
});
test('choice study requires selection and shows every rationale', async ({ page }) => {
  await loadDemo(page);
  await go(page, 'Study');
  await page.getByRole('listbox', { name: 'Question types' }).selectOption('single_choice');
  await page.getByRole('button', { name: 'Start session' }).click();
  await page.getByRole('button', { name: 'Check answer' }).click();
  await expect(page.getByRole('alert')).toContainText('Choose an answer');
  await page.getByRole('radio', { name: 'B Linear', exact: true }).check();
  await page.getByRole('button', { name: 'Check answer' }).click();
  await expect(page.getByText('✕ Incorrect or unanswered')).toBeVisible();
  await expect(page.locator('.rationale')).toHaveCount(3);
  const states = await records(page, 'states');
  expect(states[0].lastObjectiveCorrect).toBe(false);
  expect(states[0].interval).toBe(10);
});
test('exam autosave and resume, hidden feedback, strict and partial results, exports', async ({
  page
}) => {
  await loadDemo(page);
  await exam(page);
  await page.getByRole('radio', { name: 'A Annular', exact: true }).check();
  await expect(page.getByText('Annular describes a ring-shaped arrangement.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next →', exact: true }).click();
  await page.getByRole('checkbox', { name: 'A A ring-shaped region', exact: true }).check();
  await expect(
    page.locator('.exam-aside').getByText('✓ Progress saved locally', { exact: true })
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Resume exam' }).click();
  await expect(
    page.getByRole('checkbox', { name: 'A A ring-shaped region', exact: true })
  ).toBeChecked();
  await submit(page);
  const strictScore = page.locator('.stat').filter({ hasText: 'Strict score' });
  await expect(strictScore.locator('strong')).toHaveText('1/2');
  await expect(strictScore.locator('small')).toHaveText('50.0%');
  const partialScore = page.locator('.stat').filter({ hasText: 'Partial score' });
  await expect(partialScore.locator('strong')).toHaveText('1.50/2');
  await expect(partialScore.locator('small')).toHaveText('75.0%');
  expect((await records(page, 'active')).length).toBe(0);
  expect((await records(page, 'attempts')).length).toBe(1);
  for (const label of ['Export JSON', 'Export CSV']) {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: label, exact: true }).click();
    expect((await download).suggestedFilename()).toContain(
      label === 'Export JSON' ? '.json' : '.csv'
    );
  }
  await page.reload();
  await go(page, 'Results & statistics');
  await page.getByRole('button', { name: 'View results' }).click();
  await expect(page.getByRole('heading', { name: 'Detailed question review' })).toBeVisible();
});
test('timer expiration submits exactly once across refresh and retains results', async ({
  page
}) => {
  await loadDemo(page);
  await exam(page, { count: 1, timer: true });
  await page.getByRole('button', { name: 'Save & return home' }).click();
  await page.evaluate(async () => {
    const db = await import('/js/storage.js');
    const active = await db.get('active', 'current');
    active.deadline = Date.now() + 2000;
    await db.put('active', active);
  });
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'A clearer picture of your progress.' })
  ).toBeVisible({ timeout: 10000 });
  const attempts = await records(page, 'attempts');
  expect(attempts.length).toBe(1);
  expect(attempts[0].automatic).toBe(true);
  expect(attempts[0].remaining).toBe(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'A little progress, every day.' })).toBeVisible();
  expect((await records(page, 'attempts')).length).toBe(1);
});
test('answer locking, open self-assessment and exam review queue', async ({ page }) => {
  await loadDemo(page);
  await exam(page, { count: 2, open: true, changes: false });
  await page.getByRole('textbox').fill('A ring-shaped region');
  await page.getByRole('button', { name: 'Save answer', exact: true }).click();
  await expect(page.getByRole('textbox')).toBeDisabled();
  await page.getByRole('button', { name: 'Next →', exact: true }).click();
  await page.getByRole('radio', { name: 'A Annular', exact: true }).check();
  await submit(page);
  const strictScore = page.locator('.stat').filter({ hasText: 'Strict score' });
  await expect(strictScore.locator('strong')).toHaveText('1/1');
  await expect(strictScore.locator('small')).toHaveText('100.0%');
  await page.getByRole('button', { name: 'Know', exact: true }).click();
  await expect(page.getByText(/Self-assessed: Know/)).toBeVisible();
  await page.getByRole('button', { name: 'Add to review queue', exact: true }).first().click();
  expect((await records(page, 'states')).some((s) => s.flagged)).toBe(true);
  await page.getByRole('button', { name: 'Review this exam' }).click();
  await expect(page.getByText('2 eligible questions')).toBeVisible();
});
test('expired exam stops retrying failed submission, preserves export, and allows retry', async ({
  page
}) => {
  await loadDemo(page);
  await exam(page, { count: 1, timer: true });
  await page.getByRole('button', { name: 'Save & return home' }).click();
  await page.evaluate(async () => {
    const db = await import('/js/storage.js');
    const active = await db.get('active', 'current');
    active.deadline = Date.now() - 1;
    await db.put('active', active);
  });
  await page.addInitScript(() => {
    window.failExamCommit = true;
    window.examCommitAttempts = 0;
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (stores, ...args) {
      if (Array.isArray(stores) && stores.includes('attempts') && args[0] === 'readwrite') {
        // storage.js can fall back to the legacy transaction signature after
        // the strict-durability attempt throws. Count submission operations.
        if (args[1]?.durability === 'strict') window.examCommitAttempts++;
        if (window.failExamCommit) throw new Error('Simulated storage failure');
      }
      return original.call(this, stores, ...args);
    };
  });
  await page.reload();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Could not finalize the exam:' })
  ).toBeVisible();
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => window.examCommitAttempts)).toBe(1);
  expect((await records(page, 'active')).length).toBe(1);
  expect((await records(page, 'attempts')).length).toBe(0);
  for (const input of await page.locator('.options input').all())
    await expect(input).toBeDisabled();
  const saved = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download current answers', exact: true }).click();
  const backup = JSON.parse(await readFile(await (await saved).path(), 'utf8'));
  expect(backup.records.active).toHaveLength(1);
  await page.evaluate(() => {
    window.failExamCommit = false;
  });
  await submit(page);
  expect(await page.evaluate(() => window.examCommitAttempts)).toBe(2);
  const attempts = await records(page, 'attempts');
  expect(attempts).toHaveLength(1);
  expect(attempts[0].automatic).toBe(true);
  expect(attempts[0].remaining).toBe(0);
});
test('bank validation, missing image, safe imported text and sanitized SVG', async ({ page }) => {
  await go(page, 'Question banks');
  const bank = structuredClone(demo);
  bank.bank.id = 'safe-import';
  bank.questions = [bank.questions[0]];
  bank.questions[0].prompt = '<img src="https://evil.test/x" onerror="alert(1)">';
  await page.getByLabel('Question bank JSON files').setInputFiles({
    name: 'bank.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(bank))
  });
  await page.getByRole('button', { name: 'Validate & import' }).click();
  await expect(page.getByText(/saved 1 questions/)).toBeVisible();
  await go(page, 'Study');
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.locator('.prompt')).toHaveText(bank.questions[0].prompt);
  await expect(page.getByText(/Image unavailable: images\/annulus.svg/)).toBeVisible();
  expect(await page.locator('.prompt img').count()).toBe(0);
  await go(page, 'Question banks');
  await page.getByText('Attach / replace local images').click();
  await page.getByLabel('Attach images for Across Subjects · Demo').setInputFiles({
    name: 'annulus.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><script>alert(1)</script><image href="https://evil.test/x"/><circle cx="10" cy="10" r="5" fill="red" onload="alert(1)"/></svg>'
    )
  });
  await expect(
    page.locator('.toast').filter({ hasText: 'Selected matching images saved locally.' })
  ).toBeVisible();
  const banks = await records(page, 'banks');
  const svg = banks[0].assets['images/annulus.svg'].data;
  expect(svg).not.toMatch(/script|onload|evil\.test|<image/);
  expect(svg).toContain('circle');
});
test('backup export and validated restore preview are idempotent', async ({ page }) => {
  await loadDemo(page);
  await go(page, 'Backup & export');
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download full backup', exact: true }).click();
  const file = await event;
  const content = await readFile(await file.path());
  const parsed = JSON.parse(content);
  expect(parsed.records.banks.length).toBe(1);
  expect(Object.keys(parsed.records.banks[0].assets).length).toBe(3);
  await page
    .getByLabel('Backup or study-data JSON')
    .setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: content });
  await page.getByRole('button', { name: 'Validate & preview merge' }).click();
  await expect(page.getByRole('heading', { name: 'Ready to merge' })).toBeVisible();
  expect((await records(page, 'banks')).length).toBe(1);
  await page.getByRole('button', { name: 'Confirm merge' }).click();
  await expect(page.getByText(/Restore complete/)).toBeVisible();
  expect((await records(page, 'banks')).length).toBe(1);
  await page.evaluate(async () => {
    const db = await import('/js/storage.js');
    await db.clear('banks');
  });
  await page.getByRole('button', { name: 'Validate & preview merge' }).click();
  await page.getByRole('button', { name: 'Confirm merge' }).click();
  await expect(page.getByText(/Restore complete/)).toBeVisible();
  expect((await records(page, 'banks')).length).toBe(1);
});
test('theme persists, disabled banks excluded, invalid JSON rejected', async ({ page }) => {
  await loadDemo(page);
  await page.getByRole('button', { name: 'Disable', exact: true }).click();
  await go(page, 'Study');
  await expect(page.getByText('0 eligible questions')).toBeVisible();
  await go(page, 'Settings');
  await page.getByLabel('Theme', { exact: true }).selectOption('dark');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(
    page.locator('.toast').filter({ hasText: 'Preferences saved locally.' })
  ).toBeVisible();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await go(page, 'Question banks');
  await page
    .getByLabel('Question bank JSON files')
    .setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{bad') });
  await page.getByRole('button', { name: 'Validate & import' }).click();
  await expect(page.getByText(/malformed JSON/)).toBeVisible();
  expect((await records(page, 'banks')).length).toBe(1);
});
test('offline app shell and demo stay available with network disconnected', async ({
  page,
  context
}) => {
  await expect(page.locator('.local-label')).toContainText('Offline cache ready');
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'A little progress, every day.' })).toBeVisible();
  await loadDemo(page);
  await go(page, 'Study');
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.locator('.question-images img')).toBeVisible();
});
test('bank version update retains study history and duplicate import is confirmed', async ({
  page
}) => {
  await loadDemo(page);
  await go(page, 'Study');
  await page.getByRole('listbox', { name: 'Question types' }).selectOption('open_ended');
  await page.getByRole('button', { name: 'Start session' }).click();
  await page.getByRole('button', { name: 'Reveal answer' }).click();
  await page.getByRole('button', { name: 'Repeat', exact: true }).click();
  await expect(page.getByText(/Saved · Next due/)).toBeVisible();
  const before = await records(page, 'states');
  const updated = structuredClone(demo);
  updated.bank.version = '1.1.0';
  updated.questions[0].prompt += ' Updated example.';
  await go(page, 'Question banks');
  await page.getByLabel('Question bank JSON files').setInputFiles({
    name: 'updated.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(updated))
  });
  await page.getByRole('button', { name: 'Validate & import' }).click();
  await expect(page.getByText('Updated 1.0.0 → 1.1.0; study history retained.')).toBeVisible();
  expect(await records(page, 'states')).toEqual(before);
  expect((await records(page, 'banks')).length).toBe(1);
});
test('repeat-count configuration, skip, flag, and print review remain usable on mobile', async ({
  page
}) => {
  await loadDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await go(page, 'Exam simulator');
  await page.getByRole('listbox', { name: 'Question types' }).selectOption('single_choice');
  await page.getByLabel('Number of questions').fill('5');
  await page.getByLabel('Use countdown timer').uncheck();
  await page.getByRole('button', { name: 'Preview exam' }).click();
  await expect(page.getByRole('alert')).toContainText('Only 3 questions');
  await page.getByLabel('Allow repeats when count exceeds eligible questions').check();
  await page.getByRole('button', { name: 'Preview exam' }).click();
  await page.getByRole('button', { name: 'Start exam', exact: true }).click();
  await page.getByRole('button', { name: '⚐ Flag', exact: true }).click();
  await page.getByRole('button', { name: 'Skip question' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await submit(page);
  const attempts = await records(page, 'attempts');
  expect(attempts[0].items.length).toBe(5);
  expect(attempts[0].items[0].skipped).toBe(true);
  expect(attempts[0].items[0].flagged).toBe(true);
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('heading', { name: 'Detailed question review' })).toBeVisible();
});
test('pending storage writes guard refresh and can finish after cancellation', async ({ page }) => {
  await loadDemo(page);
  await exam(page, { count: 1 });
  await expect(
    page.locator('.exam-aside').getByText('✓ Progress saved locally', { exact: true })
  ).toBeVisible();
  page.removeAllListeners('dialog');
  let guarded = false;
  page.on('dialog', async (d) => {
    if (d.type() === 'beforeunload') {
      guarded = true;
      await d.dismiss();
    } else await d.accept();
  });
  // Keep a transaction busy until the navigation prompt appears. It models slow disks.
  await page.evaluate(() => {
    const opener = indexedDB.open('quitsar', 1);
    opener.onsuccess = () => {
      const db = opener.result;
      const tx = db.transaction('active', 'readwrite');
      const store = tx.objectStore('active');
      const until = Date.now() + 3000;
      function hold() {
        const r = store.get('current');
        r.onsuccess = () => {
          if (Date.now() < until) hold();
        };
      }
      hold();
      tx.oncomplete = () => db.close();
    };
  });
  await page.getByRole('radio', { name: 'A Annular', exact: true }).check();
  await page.reload({ timeout: 5000, waitUntil: 'commit' }).catch(() => {});
  expect(guarded).toBe(true);
  await expect(
    page.locator('.exam-aside').getByText('✓ Progress saved locally', { exact: true })
  ).toBeVisible({ timeout: 10000 });
  await page.reload();
  await page.getByRole('button', { name: 'Resume exam' }).click();
  await expect(page.getByRole('radio', { name: 'A Annular', exact: true })).toBeChecked();
});

test('Slovak interface persists, preserves bank content and supports study and exams offline', async ({
  page,
  context
}) => {
  await loadDemo(page);
  await go(page, 'Settings');
  await page.getByLabel('Interface language').selectOption('sk');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'sk');
  await expect(page.getByRole('heading', { name: 'Nastavenia', exact: true })).toBeVisible();
  await expect(page.getByLabel('Jazyk rozhrania')).toHaveValue('sk');
  await expect(page).toHaveTitle('Nastavenia · quitsar');
  await expect(page.getByText('Hosť · uložené v tomto prehliadači')).toBeVisible();
  const navigate = async (name) =>
    page
      .getByRole('navigation', { name: 'Hlavná navigácia' })
      .getByRole('link', { name, exact: true })
      .click();
  await navigate('Banky otázok');
  await expect(page.getByRole('heading', { name: demo.bank.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Podrobnosti', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Jazyk');
  await page.getByRole('button', { name: 'Zavrieť', exact: true }).click();
  await navigate('Učenie');
  await expect(page.getByLabel('Náročnosť').getByRole('option', { name: 'Ľahká' })).toHaveAttribute(
    'value',
    'easy'
  );
  await page.getByRole('button', { name: 'Začať učenie →' }).click();
  await expect(page.getByRole('heading', { name: /^Otázka 1 z/ })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: demo.questions[0].prompt, exact: true })
  ).toBeVisible();
  const skip = page.getByRole('button', { name: 'Preskočiť', exact: true });
  await skip.click();
  await expect(page.getByText('Preskočené · Uložené medzi preskočené otázky')).toBeVisible();
  await navigate('Simulátor skúšky');
  await page.getByLabel('Počet otázok', { exact: true }).fill('1');
  await page.getByLabel('Použiť odpočítavanie času').uncheck();
  await page.getByRole('button', { name: 'Náhľad skúšky →' }).click();
  await expect(page.getByRole('dialog')).toContainText('Môžeme začať?');
  await page.getByRole('button', { name: 'Začať skúšku', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Otázka 1 z 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Odovzdať skúšku', exact: true }).click();
  await page.getByRole('button', { name: 'Odovzdať a uložiť výsledky' }).click();
  await expect(
    page.getByRole('heading', { name: 'Jasnejší obraz o vašom pokroku.' })
  ).toBeVisible();
  for (const name of ['Otázky na opakovanie', 'Výsledky a štatistiky', 'Zálohovanie a export']) {
    await navigate(name);
    await expect(page.locator('#section-name')).toHaveText(name);
  }
  await page.getByRole('button', { name: 'Pomoc a skratky' }).click();
  await expect(page.getByRole('dialog')).toContainText('Pomoc a klávesové skratky');
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })
      );
  });
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'sk');
  await navigate('Prehľad');
  await expect(page.getByRole('heading', { name: 'Každý deň o krok ďalej.' })).toBeVisible();
  await expect(page.locator('.local-label')).toContainText('Offline pamäť je pripravená');
  await navigate('Nastavenia');
  await page.getByLabel('Jazyk rozhrania').selectOption('en');
  await page.getByRole('button', { name: 'Uložiť nastavenia', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  expect((await records(page, 'banks')).length).toBe(1);
  expect((await records(page, 'history')).length).toBeGreaterThan(0);
  expect((await records(page, 'attempts')).length).toBe(1);
});

test('Slovak browser preference applies on first visit', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'sk-SK' });
  try {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Každý deň o krok ďalej.' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'sk');
  } finally {
    await context.close();
  }
});

test('header language selector is immediately available on desktop and mobile', async ({
  page
}) => {
  const header = page.getByRole('banner');
  await expect(header.getByRole('combobox', { name: 'Language', exact: true })).toBeEnabled();
  await header.getByRole('combobox', { name: 'Language', exact: true }).selectOption('sk');
  await expect(page.getByRole('heading', { name: 'Každý deň o krok ďalej.' })).toBeVisible();
  await expect(header.getByRole('combobox', { name: 'Jazyk', exact: true })).toHaveValue('sk');
  await expect(page.locator('html')).toHaveAttribute('lang', 'sk');
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(header.getByRole('combobox', { name: 'Jazyk', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await expect(header.getByRole('combobox', { name: 'Jazyk', exact: true })).toHaveValue('sk');
  await header.getByRole('combobox', { name: 'Jazyk', exact: true }).selectOption('cs');
  await expect(page.getByRole('heading', { name: 'Každý den o krok dál.' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'cs');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await expect(header.getByRole('combobox', { name: 'Jazyk', exact: true })).toHaveValue('cs');
  await header.getByRole('combobox', { name: 'Jazyk', exact: true }).selectOption('en');
  await expect(page.getByRole('heading', { name: 'A little progress, every day.' })).toBeVisible();
  await go(page, 'Settings');
  await expect(page.getByLabel('Interface language')).toHaveValue('en');
  expect((await records(page, 'settings')).find((row) => row.id === 'preferences').language).toBe(
    'en'
  );
});

test('Czech interface persists, preserves bank content and supports study and exams offline', async ({
  page,
  context
}) => {
  await loadDemo(page);
  await go(page, 'Settings');
  await page.getByLabel('Interface language').selectOption('cs');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'cs');
  await expect(page.getByRole('heading', { name: 'Nastavení', exact: true })).toBeVisible();
  await expect(page.getByLabel('Jazyk rozhraní')).toHaveValue('cs');
  await expect(page).toHaveTitle('Nastavení · quitsar');
  await expect(page.getByText('Host · uloženo v tomto prohlížeči')).toBeVisible();
  const navigate = async (name) =>
    page
      .getByRole('navigation', { name: 'Hlavní navigace' })
      .getByRole('link', { name, exact: true })
      .click();
  await navigate('Banky otázek');
  await expect(page.getByRole('heading', { name: demo.bank.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Podrobnosti', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Jazyk');
  await page.getByRole('button', { name: 'Zavřít', exact: true }).click();
  await navigate('Učení');
  await expect(page.getByLabel('Obtížnost').getByRole('option', { name: 'Lehká' })).toHaveAttribute(
    'value',
    'easy'
  );
  await page.getByRole('button', { name: 'Začít učení →' }).click();
  await expect(page.getByRole('heading', { name: /^Otázka 1 z/ })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: demo.questions[0].prompt, exact: true })
  ).toBeVisible();
  const skip = page.getByRole('button', { name: 'Přeskočit', exact: true });
  await skip.click();
  await expect(page.getByText('Přeskočeno · Uloženo mezi přeskočené otázky')).toBeVisible();
  await navigate('Simulátor zkoušky');
  await page.getByLabel('Počet otázek', { exact: true }).fill('1');
  await page.getByLabel('Použít odpočítávání času').uncheck();
  await page.getByRole('button', { name: 'Náhled zkoušky →' }).click();
  await expect(page.getByRole('dialog')).toContainText('Můžeme začít?');
  await page.getByRole('button', { name: 'Začít zkoušku', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Otázka 1 z 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Odevzdat zkoušku', exact: true }).click();
  await page.getByRole('button', { name: 'Odevzdat a uložit výsledky' }).click();
  await expect(
    page.getByRole('heading', { name: 'Jasnější obraz o vašem pokroku.' })
  ).toBeVisible();
  for (const name of ['Otázky k opakování', 'Výsledky a statistiky', 'Zálohování a export']) {
    await navigate(name);
    await expect(page.locator('#section-name')).toHaveText(name);
  }
  await page.getByRole('button', { name: 'Nápověda a zkratky' }).click();
  await expect(page.getByRole('dialog')).toContainText('Nápověda a klávesové zkratky');
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })
      );
  });
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'cs');
  await navigate('Přehled');
  await expect(page.getByRole('heading', { name: 'Každý den o krok dál.' })).toBeVisible();
  await expect(page.locator('.local-label')).toContainText('Offline mezipaměť je připravena');
  await navigate('Nastavení');
  await page.getByLabel('Jazyk rozhraní').selectOption('en');
  await page.getByRole('button', { name: 'Uložit nastavení', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  expect((await records(page, 'banks')).length).toBe(1);
  expect((await records(page, 'history')).length).toBeGreaterThan(0);
  expect((await records(page, 'attempts')).length).toBe(1);
});

test('Czech browser preference applies on first visit', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'cs-CZ' });
  try {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Každý den o krok dál.' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'cs');
  } finally {
    await context.close();
  }
});

for (const [language, locale, home, settings, interfaceLanguage, save, banks] of [
  [
    'de',
    'de-DE',
    'Jeden Tag ein kleiner Fortschritt.',
    'Einstellungen',
    'Sprache der Benutzeroberfläche',
    'Einstellungen speichern',
    'Fragenbanken'
  ],
  [
    'es',
    'es-ES',
    'Un pequeño avance cada día.',
    'Ajustes',
    'Idioma de la interfaz',
    'Guardar ajustes',
    'Bancos de preguntas'
  ],
  [
    'fr',
    'fr-FR',
    'Un petit progrès chaque jour.',
    'Paramètres',
    'Langue de l’interface',
    'Enregistrer les paramètres',
    'Banques de questions'
  ]
]) {
  test(`${language} persists across selectors and works offline without changing bank content`, async ({
    page,
    context
  }) => {
    await loadDemo(page);
    await page.locator('#header-language').selectOption(language);
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await expect(page.locator('#section-name')).toHaveText(banks);
    const navigate = (name) => page.locator('nav').getByRole('link', { name, exact: true }).click();
    await navigate(banks);
    await expect(page.getByRole('heading', { name: demo.bank.title, exact: true })).toBeVisible();
    await navigate(settings);
    await expect(page.getByLabel(interfaceLanguage)).toHaveValue(language);
    await page.getByRole('button', { name: save, exact: true }).click();
    expect((await records(page, 'settings')).find((row) => row.id === 'preferences').language).toBe(
      language
    );
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller)
        await new Promise((resolve) =>
          navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })
        );
    });
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await expect(page.getByLabel(interfaceLanguage)).toHaveValue(language);
    await page.getByLabel(interfaceLanguage).selectOption('en');
    await page.getByRole('button', { name: save, exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.locator('#header-language')).toHaveValue('en');
    expect((await records(page, 'banks')).length).toBe(1);
  });

  test(`${language} browser preference applies on first visit`, async ({ browser }) => {
    const context = await browser.newContext({ locale });
    try {
      const page = await context.newPage();
      await page.goto('/');
      await expect(page.getByRole('heading', { name: home, exact: true })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', language);
      await expect(page.locator('#header-language')).toHaveValue(language);
    } finally {
      await context.close();
    }
  });
}

test('the local server rejects embedding the app in a frame', async ({ page }) => {
  const response = await page.goto('/');
  expect(response.headers()['x-frame-options']).toBe('DENY');
  expect(response.headers()['content-security-policy']).toBe("frame-ancestors 'none'");
  // Even a same-origin ancestor must be rejected; this also excludes other origins.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const frame = document.createElement('iframe');
        frame.src = '/';
        frame.onload = resolve;
        document.body.replaceChildren(frame);
      })
  );
  await expect(page.frameLocator('iframe').locator('main')).toHaveCount(0);
});

test('malformed legacy records have export and removal recovery without crashing the app', async ({
  page
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluate(async () => {
    const db = await import('/js/storage.js');
    await db.put('active', { id: 'current' });
  });
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Some saved records need attention' })
  ).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download record', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('invalid-record.json');
  await page.getByRole('button', { name: 'Remove invalid record', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Some saved records need attention' })
  ).toHaveCount(0);
  expect(await records(page, 'active')).toEqual([]);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'A little progress, every day.' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a library larger than the restore limit exports independently restorable parts', async ({
  page
}) => {
  await page.evaluate(async () => {
    const db = await import('/js/storage.js');
    await db.atomic(
      Array.from({ length: 28 }, (_, i) => ({
        store: 'history',
        value: {
          id: 'large-' + i,
          bankId: 'demo',
          questionId: 'q1',
          at: i,
          response: 'know',
          padding: 'x'.repeat(900000)
        }
      }))
    );
  });
  await go(page, 'Backup & export');
  await page.getByRole('button', { name: 'Download full backup', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Download backup parts', exact: true })
  ).toBeVisible();
  const parts = [];
  for (let index = 1; index <= 2; index++) {
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: `Download part ${index} of 2`, exact: true }).click();
    const file = await pending;
    const content = await readFile(await file.path());
    expect(content.length).toBeLessThanOrEqual(16 * 1024 * 1024);
    parts.push({ name: file.suggestedFilename(), mimeType: 'application/json', buffer: content });
  }
  await page.keyboard.press('Escape');
  await page.evaluate(async () => (await import('/js/storage.js')).clear('history'));
  for (const part of parts) {
    await page.getByLabel('Backup or study-data JSON', { exact: true }).setInputFiles(part);
    await page.getByRole('button', { name: 'Validate & preview merge' }).click();
    await expect(page.getByRole('heading', { name: 'Ready to merge' })).toBeVisible();
    await page.getByRole('button', { name: 'Confirm merge', exact: true }).click();
    await expect(
      page.getByText('Restore complete. Records merged into local storage.', { exact: true })
    ).toBeVisible();
  }
  expect((await records(page, 'history')).length).toBe(28);
});
