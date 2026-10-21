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
    await expect(page.getByRole('heading', { name: 'Ready to study?' })).toBeVisible();
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
  browser
}) => {
  // A fresh context ensures the generated HTML is tested, rather than the
  // service worker's development shell installed by beforeEach.
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
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
  } finally {
    await context.close();
  }
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
  await expect(page.locator('#header-language')).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Your study space' })).toBeVisible();
});
async function go(page, name) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name, exact: true })
    .click();
}
async function loadDemo(page) {
  await go(page, 'Question banks');
  await page.getByRole('button', { name: 'Try the demo bank' }).click();
  await expect(page.getByText('Demo saved locally with all images.')).toBeVisible();
}
async function exam(page, { count = 2, open = false, timer = false, changes = true } = {}) {
  await go(page, 'Exam simulator');
  await page
    .getByRole('listbox', { name: 'Question types' })
    .selectOption(
      open
        ? ['open_ended', 'single_choice', 'multiple_choice']
        : ['single_choice', 'multiple_choice']
    );
  await page.getByLabel('Number of questions').fill(String(count));
  await page.getByLabel('Random question order').uncheck();
  await page.getByLabel('Use countdown timer').setChecked(timer);
  await page.getByLabel('Include open-ended self-assessment').setChecked(open);
  await page.getByLabel('Allow answer changes before submitting').setChecked(changes);
  await page.getByRole('button', { name: 'Preview exam', exact: true }).click();
  await page.getByRole('button', { name: 'Start exam', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Question 1 of ${count}` })).toBeVisible();
}
async function submit(page) {
  await page.getByRole('button', { name: 'Submit exam', exact: true }).click();
  await page.getByRole('button', { name: 'Submit & save results' }).click();
  await expect(page.getByRole('heading', { name: 'Exam results' })).toBeVisible();
}
async function records(page, store) {
  return page.evaluate(async (s) => {
    const db = await import('/js/storage.js');
    return db.all(s);
  }, store);
}

test('empty libraries start with biology questions and no invented progress', async ({ page }) => {
  const banks = await records(page, 'banks');
  expect(banks).toHaveLength(1);
  expect(banks[0].id).toBe(demo.bank.id);
  expect(banks[0].isDefaultDemo).toBe(true);
  expect(banks[0].data.questions).toHaveLength(12);
  expect(Object.keys(banks[0].assets).sort()).toEqual([
    'images/animal-cell.webp',
    'images/food-chain.webp'
  ]);
  for (const store of ['states', 'history', 'attempts', 'active'])
    expect(await records(page, store)).toEqual([]);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Start studying', exact: true })).toBeVisible();
  expect(await records(page, 'banks')).toHaveLength(1);
});

test('the first demo image is a scored question without self-assessment controls', async ({
  page
}) => {
  await go(page, 'Study');
  await page.getByRole('button', { name: 'Start studying', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Which structure is labelled A?' })).toBeVisible();
  const image = page.locator('.question-images img');
  await expect(image).toBeVisible();
  expect(await image.evaluate((node) => node.complete && node.naturalWidth > 0)).toBe(true);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reveal answer', exact: true })).toHaveCount(0);
  await page.getByRole('radio', { name: 'A Nucleus', exact: true }).check();
  await page.getByRole('button', { name: 'Check answer', exact: true }).click();
  await expect(page.getByText('✓ Correct', { exact: true })).toBeVisible();
  const state = (await records(page, 'states')).find(
    (state) => state.questionId === demo.questions[0].id
  );
  expect(state.lastObjectiveCorrect).toBe(true);
  await expect(page.getByRole('button', { name: 'Know', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Repeat', exact: true })).toHaveCount(0);
});

test('automatic demo updates preserve progress and explicit imports keep their version', async ({
  page
}) => {
  await page.evaluate(async () => {
    const db = await import('/js/storage.js');
    const { DEMO_ID } = await import('/js/demo.js');
    const bank = await db.get('banks', DEMO_ID);
    bank.data.bank.version = '1.0.0';
    bank.assets['images/legacy-cell.svg'] = {
      mime: 'image/svg+xml',
      data: '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
    };
    await db.put('banks', bank);
    await db.put('states', {
      id: JSON.stringify([DEMO_ID, 'cells-open-001']),
      bankId: DEMO_ID,
      questionId: 'cells-open-001',
      flagged: true,
      updatedAt: 1
    });
  });
  await page.reload();
  await expect(page.locator('#header-language')).toBeEnabled();
  const [bank] = await records(page, 'banks');
  expect(bank.data.bank.version).toBe(demo.bank.version);
  expect(bank.assets['images/legacy-cell.svg'].mime).toBe('image/svg+xml');
  expect((await records(page, 'states'))[0].flagged).toBe(true);
  await page.evaluate(async () => {
    const db = await import('/js/storage.js');
    const { DEMO_ID } = await import('/js/demo.js');
    const bank = await db.get('banks', DEMO_ID);
    delete bank.isDefaultDemo;
    bank.data.bank.version = '1.0.0';
    await db.put('banks', bank);
  });
  await page.reload();
  await expect(page.locator('#header-language')).toBeEnabled();
  expect((await records(page, 'banks'))[0].data.bank.version).toBe('1.0.0');
});

test('imported material replaces only the automatic demo and stays selected after reload', async ({
  page
}) => {
  const ownBank = structuredClone(demo);
  ownBank.bank.id = 'my-course';
  ownBank.bank.title = 'My biology course';
  ownBank.questions = [ownBank.questions.find((question) => question.type === 'single_choice')];
  await go(page, 'Question banks');
  await page.getByLabel('Question bank JSON files').setInputFiles({
    name: 'my-course.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(ownBank))
  });
  await page.getByRole('button', { name: 'Import questions', exact: true }).click();
  await expect(page.getByRole('heading', { name: ownBank.bank.title })).toBeVisible();
  expect((await records(page, 'banks')).map((bank) => bank.id)).toEqual(['my-course']);
  await page.reload();
  await expect(page.locator('#header-language')).toBeEnabled();
  expect((await records(page, 'banks')).map((bank) => bank.id)).toEqual(['my-course']);
  await go(page, 'Exam simulator');
  await expect(page.getByRole('heading', { name: 'Try a biology exam' })).toHaveCount(0);
  await expect(page.getByLabel('Number of questions', { exact: true })).toHaveValue('1');
  // A disabled bank is still imported material; it must not bring the default demo back.
  await page.evaluate(async () => {
    const db = await import('/js/storage.js');
    const bank = await db.get('banks', 'my-course');
    await db.put('banks', { ...bank, enabled: false });
  });
  await page.reload();
  await expect(page.locator('#header-language')).toBeEnabled();
  expect((await records(page, 'banks')).map((bank) => [bank.id, bank.enabled])).toEqual([
    ['my-course', false]
  ]);
});

test('biology exam examples preview and start real quizzes, timed exams and written practice', async ({
  page
}) => {
  for (const [name, count, timer, written] of [
    ['Quick quiz', 5, false, false],
    ['Timed practice', 8, true, false],
    ['Explain it yourself', 3, false, true]
  ]) {
    await go(page, 'Exam simulator');
    await page.getByRole('button', { name: `Preview exam: ${name}`, exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText(demo.bank.title);
    expect(await records(page, 'active')).toEqual([]);
    await page.getByRole('button', { name: 'Start exam', exact: true }).click();
    await expect(page.getByRole('heading', { name: `Question 1 of ${count}` })).toBeVisible();
    const [active] = await records(page, 'active');
    expect(active.items).toHaveLength(count);
    expect(active.config.timer).toBe(timer);
    expect(active.deadline === null).toBe(!timer);
    expect(new Set(active.items.map((item) => item.question.id)).size).toBe(count);
    expect(active.items.every((item) => item.bankId === demo.bank.id)).toBe(true);
    expect(active.items.every((item) => (item.question.type === 'open_ended') === written)).toBe(
      true
    );
    if (timer) expect(active.deadline - active.startedAt).toBe(10 * 60000);
    await page.getByRole('button', { name: 'Save & return home' }).click();
    await go(page, 'Exam simulator');
    await page.getByRole('button', { name: 'Discard exam', exact: true }).click();
  }
  expect(await records(page, 'attempts')).toEqual([]);
});

test('an explicitly loaded demo stays alongside imported banks', async ({ page }) => {
  await loadDemo(page);
  const ownBank = structuredClone(demo);
  ownBank.bank.id = 'another-course';
  ownBank.bank.title = 'Another course';
  await page.getByLabel('Question bank JSON files').setInputFiles({
    name: 'another-course.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(ownBank))
  });
  await page.getByRole('button', { name: 'Import questions', exact: true }).click();
  await expect(page.getByRole('heading', { name: ownBank.bank.title })).toBeVisible();
  expect((await records(page, 'banks')).map((bank) => bank.id).sort()).toEqual(
    ['another-course', demo.bank.id].sort()
  );
});

test('unavailable demo files leave the library usable for custom imports', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await page.route('**/banks/demo.json', (route) => route.fulfill({ status: 404, body: '' }));
    await page.goto('http://127.0.0.1:8080');
    await expect(page.locator('#header-language')).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Add questions', exact: true })).toBeVisible();
    expect(await records(page, 'banks')).toEqual([]);
    await go(page, 'Question banks');
    await expect(page.getByRole('button', { name: 'Import questions', exact: true })).toBeEnabled();
  } finally {
    await context.close();
  }
});

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
  await expect(page.getByRole('heading', { name: 'Your study space' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const accountToggle = page.getByRole('button', { name: 'Account & help', exact: true });
  await expect(accountToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeInViewport();
  await accountToggle.click();
  await expect(accountToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
  await page.getByRole('button', { name: 'Help & shortcuts' }).click();
  await expect(page.getByRole('dialog')).toContainText('Help & keyboard shortcuts');
  await page.keyboard.press('Escape');
  await accountToggle.click();
  await expect(page.locator('#sidebar-info')).toBeHidden();
});

test('default biology bank, demo metadata, mobile layout and keyboard help', async ({ page }) => {
  await expect(page.getByText(demo.bank.title, { exact: true })).toBeVisible();
  await loadDemo(page);
  await page.getByRole('button', { name: 'Inspect', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('12');
  await page.keyboard.press('Escape');
  await go(page, 'Overview');
  await expect(page.getByRole('heading', { name: 'Your study space' })).toBeVisible();
  await page.screenshot({ path: 'test-results/dashboard-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/dashboard-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog')).toContainText('Alt + N');
  await page.keyboard.press('Escape');
});
test('open reveal, Know, flagged review and persistent schedule', async ({ page }) => {
  await loadDemo(page);
  await go(page, 'Study');
  await page.getByRole('listbox', { name: 'Question types' }).selectOption('open_ended');
  await page.getByRole('button', { name: 'Start studying' }).click();
  await page.getByRole('textbox').fill('It contains DNA and controls cell activities.');
  await page.keyboard.press('Alt+f');
  await page.keyboard.press('Alt+r');
  await expect(page.getByText('Suggested answer', { exact: true })).toBeVisible();
  await page.keyboard.press('Alt+2');
  await expect(page.getByText(/Saved · Next due/)).toBeVisible();
  let states = await records(page, 'states');
  expect(states[0].interval).toBeGreaterThanOrEqual(1440);
  expect(states[0].fsrs.state).toBe(2);
  expect(states[0].flagged).toBe(true);
  expect(states[0].repetitions).toBe(1);
  await page.reload();
  await go(page, 'Review queue');
  await page.getByRole('button', { name: /Flagged questions/ }).click();
  await expect(page.getByText('1 eligible questions')).toBeVisible();
});
test('choice study requires selection and shows every rationale', async ({ page }) => {
  await loadDemo(page);
  await go(page, 'Study');
  await page.getByRole('listbox', { name: 'Question types' }).selectOption('single_choice');
  await page.getByRole('button', { name: 'Start studying' }).click();
  await page.getByRole('button', { name: 'Check answer' }).click();
  await expect(page.getByRole('alert')).toContainText('Choose an answer');
  await page.getByRole('radio', { name: 'B Nucleus', exact: true }).check();
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
  await page.getByRole('radio', { name: 'A Mitochondrion', exact: true }).check();
  await expect(
    page.getByText(
      'Most stages of aerobic respiration take place in mitochondria, producing ATP that the cell can use.'
    )
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Next →', exact: true }).click();
  await page.getByRole('checkbox', { name: 'A Cell wall', exact: true }).check();
  await expect(
    page.locator('.exam-aside').getByText('✓ Progress saved locally', { exact: true })
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Resume exam' }).click();
  await expect(page.getByRole('checkbox', { name: 'A Cell wall', exact: true })).toBeChecked();
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
  await expect(page.getByRole('heading', { name: 'Exam results' })).toBeVisible({ timeout: 10000 });
  const attempts = await records(page, 'attempts');
  expect(attempts.length).toBe(1);
  expect(attempts[0].automatic).toBe(true);
  expect(attempts[0].remaining).toBe(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your study space' })).toBeVisible();
  expect((await records(page, 'attempts')).length).toBe(1);
});
test('answer locking, open self-assessment and exam review queue', async ({ page }) => {
  await loadDemo(page);
  await exam(page, { count: 2, open: true, changes: false });
  await page.getByRole('textbox').fill('It contains DNA and controls cell activities.');
  await page.getByRole('button', { name: 'Save answer', exact: true }).click();
  await expect(page.getByRole('textbox')).toBeDisabled();
  await page.getByRole('button', { name: 'Next →', exact: true }).click();
  await page.getByRole('radio', { name: 'A Mitochondrion', exact: true }).check();
  await submit(page);
  const strictScore = page.locator('.stat').filter({ hasText: 'Strict score' });
  await expect(strictScore.locator('strong')).toHaveText('1/1');
  await expect(strictScore.locator('small')).toHaveText('100.0%');
  await page.getByRole('button', { name: 'Know', exact: true }).click();
  await expect(page.getByText(/Self-assessed: Know/)).toBeVisible();
  await page.getByRole('button', { name: 'Save for later', exact: true }).first().click();
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
  bank.questions[0].images[0].path = 'images/animal-cell.svg';
  bank.questions[0].prompt = '<img src="https://evil.test/x" onerror="alert(1)">';
  await page.getByLabel('Question bank JSON files').setInputFiles({
    name: 'bank.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(bank))
  });
  await page.getByRole('button', { name: 'Import questions' }).click();
  await expect(page.getByText(/saved 1 questions/)).toBeVisible();
  await go(page, 'Study');
  await page.getByRole('button', { name: 'Start studying' }).click();
  await expect(page.locator('.prompt')).toHaveText(bank.questions[0].prompt);
  await expect(page.getByText(/Image unavailable: images\/animal-cell.svg/)).toBeVisible();
  expect(await page.locator('.prompt img').count()).toBe(0);
  await go(page, 'Question banks');
  await page.getByText('Add or replace images').click();
  await page.getByLabel('Attach images for Biology · High-school practice').setInputFiles({
    name: 'animal-cell.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><script>alert(1)</script><image href="https://evil.test/x"/><circle cx="10" cy="10" r="5" fill="red" onload="alert(1)"/></svg>'
    )
  });
  await expect(
    page.locator('.toast').filter({ hasText: 'Selected matching images saved locally.' })
  ).toBeVisible();
  const banks = await records(page, 'banks');
  const svg = banks[0].assets['images/animal-cell.svg'].data;
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
  expect(Object.keys(parsed.records.banks[0].assets).length).toBe(2);
  await page
    .getByLabel('Backup or study-data JSON')
    .setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: content });
  await page.getByRole('button', { name: 'Preview restore' }).click();
  await expect(page.getByRole('heading', { name: 'Review your backup' })).toBeVisible();
  expect((await records(page, 'banks')).length).toBe(1);
  await page.getByRole('button', { name: 'Restore backup' }).click();
  await expect(page.getByText(/Restore complete/)).toBeVisible();
  expect((await records(page, 'banks')).length).toBe(1);
  await page.evaluate(async () => {
    const db = await import('/js/storage.js');
    await db.clear('banks');
  });
  await page.getByRole('button', { name: 'Preview restore' }).click();
  await page.getByRole('button', { name: 'Restore backup' }).click();
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
  await page.getByRole('button', { name: 'Import questions' }).click();
  await expect(page.getByText(/malformed JSON/)).toBeVisible();
  expect((await records(page, 'banks')).length).toBe(1);
});
test('offline app shell and demo stay available with network disconnected', async ({
  page,
  context
}) => {
  await expect(page.locator('.local-label')).toContainText('Offline ready');
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your study space' })).toBeVisible();
  await loadDemo(page);
  await go(page, 'Study');
  await page.getByRole('button', { name: 'Start studying' }).click();
  await expect(page.locator('.question-images img')).toBeVisible();
  await page.getByRole('radio', { name: 'A Nucleus', exact: true }).check();
  await page.getByRole('button', { name: 'Check answer', exact: true }).click();
  await expect(page.getByText(/Saved · Next due/)).toBeVisible();
  expect((await records(page, 'states'))[0].fsrs.state).toBe(2);
});
test('bank version update retains study history and duplicate import is confirmed', async ({
  page
}) => {
  await loadDemo(page);
  await go(page, 'Study');
  await page.getByRole('listbox', { name: 'Question types' }).selectOption('open_ended');
  await page.getByRole('button', { name: 'Start studying' }).click();
  await page.getByRole('button', { name: 'Reveal answer' }).click();
  await page.getByRole('button', { name: 'Repeat', exact: true }).click();
  await expect(page.getByText(/Saved · Next due/)).toBeVisible();
  const before = await records(page, 'states');
  const updated = structuredClone(demo);
  updated.bank.version = '1.2.0';
  updated.questions[0].prompt += ' Updated example.';
  await go(page, 'Question banks');
  await page.getByLabel('Question bank JSON files').setInputFiles({
    name: 'updated.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(updated))
  });
  await page.getByRole('button', { name: 'Import questions' }).click();
  await expect(
    page.getByText(
      `Updated ${demo.bank.version} → ${updated.bank.version}; study history retained.`
    )
  ).toBeVisible();
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
  await page.getByRole('button', { name: 'Preview exam', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Only 3 questions');
  await page.getByLabel('Allow repeated questions if needed').check();
  await page.getByRole('button', { name: 'Preview exam', exact: true }).click();
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
  await page.getByRole('radio', { name: 'A Mitochondrion', exact: true }).check();
  await page.reload({ timeout: 5000, waitUntil: 'commit' }).catch(() => {});
  expect(guarded).toBe(true);
  await expect(
    page.locator('.exam-aside').getByText('✓ Progress saved locally', { exact: true })
  ).toBeVisible({ timeout: 10000 });
  await page.reload();
  await page.getByRole('button', { name: 'Resume exam' }).click();
  await expect(page.getByRole('radio', { name: 'A Mitochondrion', exact: true })).toBeChecked();
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
  await page.getByRole('button', { name: 'Začať sa učiť' }).click();
  await expect(page.getByRole('heading', { name: /^Otázka 1 z/ })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: demo.questions[0].prompt, exact: true })
  ).toBeVisible();
  const skip = page.getByRole('button', { name: 'Preskočiť', exact: true });
  await skip.click();
  await expect(page.getByText('Preskočené · Nájdete v časti Rýchle opakovanie')).toBeVisible();
  await navigate('Simulátor skúšky');
  await page.getByLabel('Počet otázok', { exact: true }).fill('1');
  await page.getByLabel('Použiť odpočítavanie času').uncheck();
  await page.getByRole('button', { name: 'Náhľad skúšky', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Môžeme začať?');
  await page.getByRole('button', { name: 'Začať skúšku', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Otázka 1 z 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Odovzdať skúšku', exact: true }).click();
  await page.getByRole('button', { name: 'Odovzdať a uložiť výsledky' }).click();
  await expect(page.getByRole('heading', { name: 'Výsledky skúšky' })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'Váš priestor na učenie' })).toBeVisible();
  await expect(page.locator('.local-label')).toContainText('Dostupné offline');
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
    await expect(page.getByRole('heading', { name: 'Váš priestor na učenie' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'sk');
  } finally {
    await context.close();
  }
});

test('header language selector is immediately available on desktop and mobile', async ({
  page
}) => {
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({ json: { user: null, googleEnabled: true } })
  );
  await page.reload();
  const header = page.getByRole('banner');
  await expect(header.locator('.language-picker > span')).toHaveText('Language');
  for (const width of [320, 700, 901, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(header.getByRole('combobox', { name: 'Language', exact: true })).toBeInViewport();
    await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
  }
  await expect(header.getByRole('combobox', { name: 'Language', exact: true })).toBeEnabled();
  await header.getByRole('combobox', { name: 'Language', exact: true }).selectOption('sk');
  await expect(page.getByRole('heading', { name: 'Váš priestor na učenie' })).toBeVisible();
  await expect(header.getByRole('combobox', { name: 'Jazyk', exact: true })).toHaveValue('sk');
  await expect(page.locator('html')).toHaveAttribute('lang', 'sk');
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(header.getByRole('combobox', { name: 'Jazyk', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await expect(header.getByRole('combobox', { name: 'Jazyk', exact: true })).toHaveValue('sk');
  await header.getByRole('combobox', { name: 'Jazyk', exact: true }).selectOption('cs');
  await expect(page.getByRole('heading', { name: 'Váš prostor pro učení' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'cs');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await expect(header.getByRole('combobox', { name: 'Jazyk', exact: true })).toHaveValue('cs');
  await header.getByRole('combobox', { name: 'Jazyk', exact: true }).selectOption('en');
  await expect(page.getByRole('heading', { name: 'Your study space' })).toBeVisible();
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
  await page.getByRole('button', { name: 'Začít se učit' }).click();
  await expect(page.getByRole('heading', { name: /^Otázka 1 z/ })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: demo.questions[0].prompt, exact: true })
  ).toBeVisible();
  const skip = page.getByRole('button', { name: 'Přeskočit', exact: true });
  await skip.click();
  await expect(page.getByText('Přeskočeno · Najdete v části Rychlé opakování')).toBeVisible();
  await navigate('Simulátor zkoušky');
  await page.getByLabel('Počet otázek', { exact: true }).fill('1');
  await page.getByLabel('Použít odpočítávání času').uncheck();
  await page.getByRole('button', { name: 'Náhled zkoušky', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Můžeme začít?');
  await page.getByRole('button', { name: 'Začít zkoušku', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Otázka 1 z 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Odevzdat zkoušku', exact: true }).click();
  await page.getByRole('button', { name: 'Odevzdat a uložit výsledky' }).click();
  await expect(page.getByRole('heading', { name: 'Výsledky zkoušky' })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'Váš prostor pro učení' })).toBeVisible();
  await expect(page.locator('.local-label')).toContainText('Dostupné offline');
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
    await expect(page.getByRole('heading', { name: 'Váš prostor pro učení' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'cs');
  } finally {
    await context.close();
  }
});

for (const [language, locale, home, settings, interfaceLanguage, save, banks] of [
  [
    'de',
    'de-DE',
    'Ihr Lernbereich',
    'Einstellungen',
    'Sprache der Benutzeroberfläche',
    'Einstellungen speichern',
    'Fragenbanken'
  ],
  [
    'es',
    'es-ES',
    'Tu espacio de estudio',
    'Ajustes',
    'Idioma de la interfaz',
    'Guardar ajustes',
    'Bancos de preguntas'
  ],
  [
    'fr',
    'fr-FR',
    'Votre espace de révision',
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
  await expect(page.getByRole('heading', { name: 'Your study space' })).toBeVisible();
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
    await page.getByRole('button', { name: 'Preview restore' }).click();
    await expect(page.getByRole('heading', { name: 'Review your backup' })).toBeVisible();
    await page.getByRole('button', { name: 'Restore backup', exact: true }).click();
    await expect(
      page.getByText('Restore complete. Records merged into local storage.', { exact: true })
    ).toBeVisible();
  }
  expect((await records(page, 'history')).length).toBe(28);
});

test('review groups share progress, preserve skipped schedules, and relearn mature mistakes', async ({
  page
}) => {
  await loadDemo(page);
  const seeded = await page.evaluate(async () => {
    const db = await import('/js/storage.js');
    const { keyFor } = await import('/js/spaced-repetition.js');
    const bank = (await db.all('banks')).find((b) => b.enabled);
    const question = bank.data.questions.find((q) => q.type === 'single_choice');
    const now = Date.now();
    const state = {
      id: keyFor(bank.id, question.id),
      bankId: bank.id,
      bankVersion: bank.data.bank.version,
      questionId: question.id,
      flagged: true,
      skipped: true,
      lastObjectiveCorrect: false,
      repetitions: 8,
      timesSeen: 8,
      interval: 64 * 1440,
      due: now - 1000,
      lastReviewed: now - 64 * 86400000,
      updatedAt: now
    };
    await db.put('states', state);
    return { state, correct: question.options.find((o) => o.isCorrect).text };
  });
  await go(page, 'Review queue');
  await expect(page.getByRole('button', { name: /Spaced repetition/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  for (const name of [
    'Spaced repetition',
    'Incorrect answers',
    'Flagged questions',
    'Skipped questions'
  ])
    await expect(page.getByRole('button', { name: new RegExp(name) }).locator('strong')).toHaveText(
      '1'
    );
  await page.getByRole('button', { name: 'Review due questions', exact: true }).click();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(
    page.getByText('Skipped · Find this in Review queue → Skipped questions', { exact: true })
  ).toBeVisible();
  let state = (await records(page, 'states')).find((s) => s.id === seeded.state.id);
  expect(state.due).toBe(seeded.state.due);
  expect(state.repetitions).toBe(8);
  expect(state.fsrs).toBeUndefined();
  await page.getByRole('button', { name: 'Finish session', exact: true }).click();
  await page.getByRole('button', { name: 'Back to review', exact: true }).click();
  await page.getByRole('button', { name: /Skipped questions/ }).click();
  await page.getByRole('button', { name: 'Start review', exact: true }).click();
  await page.getByRole('radio', { name: 'B Nucleus', exact: true }).check();
  await page.getByRole('button', { name: 'Check answer', exact: true }).click();
  await expect(page.getByText(/Saved · Next due/)).toBeVisible();
  state = (await records(page, 'states')).find((s) => s.id === seeded.state.id);
  expect(state.interval).toBe(10);
  expect(state.fsrs.state).toBe(3);
  expect(state.skipped).toBe(false);
  expect(state.flagged).toBe(true);
  expect(state.lastObjectiveCorrect).toBe(false);
  await page.getByRole('button', { name: 'Finish session', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'No reviews due now', exact: true })
  ).toBeVisible();
  await expect(page.getByText(/Next review:/)).toBeVisible();
  await page.getByRole('button', { name: 'Back to review', exact: true }).click();
  await expect(
    page.getByRole('button', { name: /Skipped questions/ }).locator('strong')
  ).toHaveText('0');
  await page.getByRole('button', { name: /Incorrect answers/ }).click();
  await page.getByRole('button', { name: 'Start review', exact: true }).click();
  await page.getByRole('radio', { name: 'A Mitochondrion', exact: true }).check();
  await page.getByRole('button', { name: 'Check answer', exact: true }).click();
  await expect(page.getByText(/Saved · Next due/)).toBeVisible();
  await page.getByRole('button', { name: 'End session', exact: true }).click();
  await expect(
    page.getByRole('button', { name: /Incorrect answers/ }).locator('strong')
  ).toHaveText('0');
  await expect(
    page.getByRole('button', { name: /Flagged questions/ }).locator('strong')
  ).toHaveText('1');
  await page.getByRole('button', { name: /Flagged questions/ }).click();
  await page.getByRole('button', { name: 'Start review', exact: true }).click();
  await page.getByRole('button', { name: '⚑ Flagged', exact: true }).click();
  await page.getByRole('button', { name: 'End session', exact: true }).click();
  await expect(
    page.getByRole('button', { name: /Flagged questions/ }).locator('strong')
  ).toHaveText('0');
  await expect(page.getByRole('button', { name: 'Start review', exact: true })).toBeDisabled();
});

test('study offers topic practice, new questions, and a bounded session with interval previews', async ({
  page
}) => {
  await loadDemo(page);
  await go(page, 'Study');
  await expect(page.getByRole('heading', { name: 'Practice a topic', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Review groups' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Practice', exact: true }).first().click();
  await expect(page.getByRole('listbox', { name: 'Topics' }).locator('option:checked')).toHaveCount(
    1
  );
  await page.getByRole('button', { name: 'Learn new questions', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Question selection', exact: true })).toHaveValue(
    'new'
  );
  await page.getByRole('listbox', { name: 'Question types' }).selectOption('open_ended');
  await page.getByRole('spinbutton', { name: 'Session size' }).fill('1');
  await page.getByRole('button', { name: 'Start studying', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Question 1 of 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reveal answer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Repeat', exact: true })).toContainText('10 min');
  await expect(page.getByRole('button', { name: 'Know', exact: true })).toHaveAttribute(
    'title',
    /Next review:/
  );
  await page.getByRole('button', { name: 'Know', exact: true }).click();
  await expect(page.getByText(/Saved · Next due/)).toBeVisible();
  await page.getByRole('button', { name: 'End session', exact: true }).click();
  await page.getByRole('button', { name: 'Learn new questions', exact: true }).click();
  await expect(page.getByText('11 eligible questions', { exact: true })).toBeVisible();
});

test('retention settings save in days and survive reload', async ({ page }) => {
  await go(page, 'Settings');
  await expect(
    page.getByRole('spinbutton', { name: 'Desired retention (%)', exact: true })
  ).toHaveValue('90');
  await page.getByRole('spinbutton', { name: 'Desired retention (%)', exact: true }).fill('95');
  await page.getByRole('spinbutton', { name: 'Maximum interval (days)', exact: true }).fill('120');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByText('Preferences saved locally.', { exact: true })).toBeVisible();
  const preferences = (await records(page, 'settings')).find((s) => s.id === 'preferences');
  expect(preferences.desiredRetention).toBe(95);
  expect(preferences.maximumInterval).toBe(120 * 1440);
  await page.reload();
  await expect(
    page.getByRole('spinbutton', { name: 'Desired retention (%)', exact: true })
  ).toHaveValue('95');
  await expect(
    page.getByRole('spinbutton', { name: 'Maximum interval (days)', exact: true })
  ).toHaveValue('120');
});

test('a scheduled question becomes reviewable without resetting open filters', async ({ page }) => {
  await page.clock.install();
  const bankId = await page.evaluate(async () => {
    const db = await import('/js/storage.js');
    const { keyFor } = await import('/js/spaced-repetition.js');
    const bank = (await db.all('banks')).find((b) => b.enabled);
    const question = bank.data.questions[0];
    const now = Date.now();
    await db.put('states', {
      id: keyFor(bank.id, question.id),
      bankId: bank.id,
      questionId: question.id,
      flagged: false,
      repetitions: 1,
      timesSeen: 1,
      interval: 10,
      due: now + 60000,
      lastReviewed: now - 540000,
      updatedAt: now
    });
    return bank.id;
  });
  await go(page, 'Review queue');
  await expect(
    page.getByRole('button', { name: 'Review due questions', exact: true })
  ).toBeDisabled();
  await page.getByText('Filter by bank, topic, or difficulty', { exact: true }).click();
  await page.getByRole('listbox', { name: 'Banks', exact: true }).selectOption(bankId);
  await page.clock.fastForward(61000);
  await expect(
    page.getByRole('button', { name: 'Review due questions', exact: true })
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: /Spaced repetition/ }).locator('strong')
  ).toHaveText('1');
  await expect(page.getByRole('listbox', { name: 'Banks', exact: true })).toHaveValues([bankId]);
});

test('Study orders new questions first or by difficulty without offering due-date order', async ({
  page
}) => {
  await page.evaluate(async () => {
    const db = await import('/js/storage.js');
    const { keyFor } = await import('/js/spaced-repetition.js');
    const bank = (await db.all('banks')).find((b) => b.enabled);
    const question = bank.data.questions[0];
    await db.put('states', {
      id: keyFor(bank.id, question.id),
      bankId: bank.id,
      questionId: question.id,
      timesSeen: 1,
      skipped: true,
      flagged: false,
      updatedAt: Date.now()
    });
  });
  await go(page, 'Study');
  const order = page.getByRole('combobox', { name: 'Order', exact: true });
  await expect(order).toHaveValue('new');
  await expect(order.locator('option')).toHaveText([
    'New first',
    'Random',
    'Difficulty: easy to hard',
    'Difficulty: hard to easy'
  ]);
  await page.getByRole('spinbutton', { name: 'Session size', exact: true }).fill('1');
  await page.getByRole('button', { name: 'Start studying', exact: true }).click();
  await expect(page.locator('.prompt')).toHaveText(demo.questions[1].prompt);
  await page.getByRole('button', { name: 'End session', exact: true }).click();
  for (const [value, difficulty] of [
    ['easy', 'easy'],
    ['hard', 'hard']
  ]) {
    await order.selectOption(value);
    await page.getByRole('spinbutton', { name: 'Session size', exact: true }).fill('1');
    await page.getByRole('button', { name: 'Start studying', exact: true }).click();
    await expect(page.locator('.prompt')).toHaveText(
      demo.questions.find((q) => q.difficulty === difficulty).prompt
    );
    await page.getByRole('button', { name: 'End session', exact: true }).click();
  }
  await order.selectOption('random');
  await expect(order).toHaveValue('random');
});

test('overview import shortcut opens a copyable format guide and keeps selected files', async ({
  page
}) => {
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.formatCopiedText = text;
        }
      }
    })
  );
  const action = page.getByRole('button', { name: 'Import questions', exact: true });
  await expect(action).toBeVisible();
  await expect(
    action.locator('..').getByRole('button', { name: 'Start studying', exact: true })
  ).toBeVisible();
  await action.click();
  const picker = page.getByLabel('Question bank JSON files', { exact: true });
  await picker.setInputFiles({
    name: 'my-questions.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(demo))
  });
  await page.getByRole('button', { name: 'Format & AI guide', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Question bank format', exact: true });
  await expect(dialog.getByRole('button', { name: 'Copy AI prompt', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Copy AI prompt', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText(
    'Copied. Paste it into your AI tool or text editor.'
  );
  const prompt = await page.evaluate(() => window.formatCopiedText);
  expect(prompt).toContain('MY STUDY MATERIAL:');
  expect(prompt).toContain('JSON SCHEMA');
  expect(prompt).toContain('"schemaVersion": "1.0"');
  expect(prompt).toContain('single_choice');
  expect(prompt).toContain('multiple_choice');
  expect(prompt).toContain('image_recognition');
  expect(prompt).toContain('open_ended');
  await dialog.getByText('Question fields', { exact: true }).click();
  await expect(dialog.locator('dt').filter({ hasText: 'questions[].difficulty' })).toContainText(
    'Required'
  );
  await expect(
    dialog.locator('dt:visible').filter({ hasText: 'questions[].acceptedAnswer' })
  ).toContainText('Depends on question type');
  await dialog.getByText('Answer option fields', { exact: true }).click();
  await expect(
    dialog.locator('dd').filter({ hasText: 'Explain why this individual option' })
  ).toBeVisible();
  await dialog.getByText('Full JSON Schema', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Copy schema', exact: true }).click();
  const schema = JSON.parse(await page.evaluate(() => window.formatCopiedText));
  expect(schema.properties.schemaVersion.const).toBe('1.0');
  await dialog.getByText('Example JSON — all four question types', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Copy example JSON', exact: true }).click();
  const example = JSON.parse(await page.evaluate(() => window.formatCopiedText));
  expect(example.questions).toHaveLength(4);
  const downloadEvent = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download example JSON', exact: true }).click();
  expect((await downloadEvent).suggestedFilename()).toBe('question-bank-example.json');
  await dialog.getByRole('button', { name: 'Back to import', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(await picker.evaluate((input) => input.files[0].name)).toBe('my-questions.json');
  await picker.setInputFiles({
    name: 'example.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(example))
  });
  await page.getByRole('button', { name: 'Import questions', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Foundations', exact: true })).toBeVisible();
});

test('format guide is available offline and selects text when clipboard access fails', async ({
  page,
  context
}) => {
  await expect(page.locator('.local-label')).toContainText('Offline ready');
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'Import questions', exact: true }).click();
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('Clipboard unavailable');
        }
      }
    })
  );
  await page.getByRole('button', { name: 'Format & AI guide', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Question bank format', exact: true });
  await dialog.getByRole('button', { name: 'Copy AI prompt', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('The text is selected');
  expect(await page.evaluate(() => window.getSelection().toString())).toContain(
    'Create a quitsar question-bank JSON file'
  );
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});

test('format guide recovers from a failed asset request without disturbing import', async ({
  page
}) => {
  await page.getByRole('button', { name: 'Import questions', exact: true }).click();
  // Block service-worker cache for this request by stubbing the guide fetch directly.
  await page.evaluate(() => {
    const original = window.fetch;
    window.formatOriginalFetch = original;
    window.fetch = (...args) =>
      String(args[0]).includes('question-bank.schema.json')
        ? Promise.resolve(new Response('', { status: 503 }))
        : original(...args);
  });
  await page.getByRole('button', { name: 'Format & AI guide', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Question bank format', exact: true });
  await expect(dialog.getByRole('alert')).toContainText('could not be loaded');
  await page.evaluate(() => {
    window.fetch = window.formatOriginalFetch;
  });
  await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copy AI prompt', exact: true })).toBeVisible();
});
