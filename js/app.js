import { t, getLanguage, setLanguage, localizeShell } from './i18n.js';
import * as db from './storage.js';
import {
  initializeAccount,
  signedIn,
  localDatabase,
  showAccount,
  setBeforeAccountChange
} from './account.js';
import { ensureDefaultDemo, removeReplacedDemo } from './demo.js';
import { defaults, keyFor, schedule } from './spaced-repetition.js';
import { el, button, badge, modal, announce, date, prettyType, icon } from './dom.js';
import { validateRecord } from './records.js';
import { download } from './dom.js';
import { questionPool } from './filters.js';
import { banksView, toolsView, settingsView } from './management.js';
import { studySetup } from './study.js';
import { examSetup, resumeExam } from './exam.js';
import { resultsList, attemptView } from './results.js';

const main = document.querySelector('#main');
const routes = [
  ['home', 'Overview'],
  ['banks', 'Question banks'],
  ['study', 'Study'],
  ['exam', 'Exam simulator'],
  ['review', 'Review queue'],
  ['results', 'Results & statistics'],
  ['tools', 'Backup & export'],
  ['settings', 'Settings']
];
let cacheStatus = '◉ Local storage · Preparing offline cache';
function reportStorage() {
  document.querySelector('.local-label').textContent = t(
    localDatabase()
      ? '◉ Local database · Server connection required'
      : signedIn()
        ? '◉ Account storage · Connection required'
        : cacheStatus
  );
}
const questionWrites = new Map();
function updateQuestion(id, action) {
  const job = (questionWrites.get(id) || Promise.resolve()).catch(() => {}).then(action);
  questionWrites.set(id, job);
  const release = () => {
    if (questionWrites.get(id) === job) questionWrites.delete(id);
  };
  job.then(release, release);
  return job;
}
export const ctx = {
  banks: [],
  states: new Map(),
  attempts: [],
  history: [],
  settings: { ...defaults },
  active: null,
  cleanup: null,
  flushExamSave: null,
  invalidRecords: [],
  examRunning: false,
  async flushQuestionWrites() {
    await Promise.allSettled([...questionWrites.values()]);
  },
  async refresh() {
    await ctx.flushQuestionWrites();
    const [banks, states, attempts, history, preferences, active] = await Promise.all([
      db.all('banks'),
      db.all('states'),
      db.all('attempts'),
      db.all('history'),
      db.get('settings', 'preferences'),
      db.get('active', 'current')
    ]);
    ctx.invalidRecords = [];
    const valid = (store, rows) =>
      rows.filter((row) => {
        try {
          validateRecord(store, row);
          return true;
        } catch (error) {
          ctx.invalidRecords.push({ store, row, error: error.message });
          return false;
        }
      });
    Object.assign(ctx, {
      banks: await removeReplacedDemo(valid('banks', banks)),
      states: new Map(valid('states', states).map((s) => [s.id, s])),
      attempts: valid('attempts', attempts).sort((a, b) => b.completedAt - a.completedAt),
      history: valid('history', history),
      active: valid('active', active ? [active] : [])[0] || null,
      settings: { ...defaults, ...valid('settings', preferences ? [preferences] : [])[0] }
    });
    document.documentElement.dataset.theme = ctx.settings.theme;
    setLanguage(preferences?.language);
    localizeShell();
    renderNavigation();
    showAccount();
    reportStorage();
    document.querySelector('#header-language').value = getLanguage();
  },
  show(...nodes) {
    main.replaceChildren(...nodes.filter((n) => n !== undefined && n !== null && n !== false));
    if (ctx.invalidRecords.length)
      main.prepend(
        el(
          'section',
          { class: 'notice warning', role: 'alert' },
          el('h2', {}, t('Some saved records need attention')),
          el(
            'p',
            {},
            t('Invalid records are excluded from this view. Download a copy before removing them.')
          ),
          ...ctx.invalidRecords.map(({ store, row, error }) =>
            el(
              'div',
              {},
              el('p', {}, `${store}/${row?.id || '?'}: ${error}`),
              button(
                t('Download record'),
                () => download('invalid-record.json', { store, value: row }),
                'secondary'
              ),
              button(
                t('Remove invalid record'),
                async () => {
                  if (!confirm(t('Permanently remove this invalid record? Download a copy first.')))
                    return;
                  await db.remove(store, row.id);
                  await render();
                },
                'danger'
              )
            )
          )
        )
      );
    main.focus({ preventScroll: true });
  },
  title(eyebrow, heading, subtitle, action) {
    document.title = `${heading} · quitsar`;
    return el(
      'div',
      { class: 'page-heading' },
      el('div', {}, el('h1', {}, heading), subtitle && el('p', { class: 'subtitle' }, subtitle)),
      action
    );
  },
  notice(message, kind = 'success') {
    announce(message);
    const box = el(
      'div',
      { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
      message,
      button(t('Dismiss'), () => box.remove(), 'subtle')
    );
    document.body.append(box);
    setTimeout(() => box.remove(), 12000);
  },
  async navigate(route) {
    if (location.hash.slice(1) !== route) history.pushState(null, '', `#${route}`);
    await render();
  },
  async flag(item, value) {
    const id = keyFor(item.bankId, item.question.id);
    return updateQuestion(id, async () => {
      const state = {
        ...ctx.states.get(id),
        id,
        bankId: item.bankId,
        bankVersion: item.bankVersion,
        questionId: item.question.id,
        flagged: value,
        updatedAt: Date.now()
      };
      await db.put('states', state);
      ctx.states.set(id, state);
    });
  },
  async respond(item, response, origin = 'study', additions = () => []) {
    const id = keyFor(item.bankId, item.question.id);
    return updateQuestion(id, async () => {
      const old = ctx.states.get(id);
      let state = {
        ...old,
        id,
        bankId: item.bankId,
        bankVersion: item.bankVersion,
        questionId: item.question.id,
        flagged: old?.flagged || false,
        updatedAt: Date.now()
      };
      if (response === 'skip')
        state = { ...state, skipped: true, timesSeen: (state.timesSeen || 0) + 1 };
      else {
        state = { ...schedule(state, response, ctx.settings), skipped: false };
        if (item.question.type !== 'open_ended') {
          state.lastObjectiveCorrect = response === 'know';
          state[response === 'know' ? 'correctCount' : 'incorrectCount'] =
            (state[response === 'know' ? 'correctCount' : 'incorrectCount'] || 0) + 1;
        }
      }
      const event = {
        id: crypto.randomUUID(),
        bankId: item.bankId,
        bankVersion: item.bankVersion,
        questionId: item.question.id,
        response,
        at: Date.now(),
        origin
      };
      await db.atomic([
        { store: 'states', value: state },
        { store: 'history', value: event },
        ...additions(state)
      ]);
      ctx.states.set(id, state);
      ctx.history.push(event);
      return state;
    });
  },
  async viewAttempt(id) {
    ctx.cleanup?.();
    ctx.cleanup = null;
    const attempt = await db.get('attempts', id);
    if (attempt) attemptView(ctx, attempt);
  },
  study(options = {}) {
    ctx.cleanup?.();
    ctx.cleanup = null;
    studySetup(ctx, options);
  }
};
setBeforeAccountChange(() => ctx.flushExamSave?.());
let currentRoute = '';
let renderVersion = 0;
async function home() {
  const pool = questionPool(ctx.banks);
  const now = Date.now();
  const due = pool.filter(
    (i) => ctx.states.get(keyFor(i.bankId, i.question.id))?.due <= now
  ).length;
  const flagged = pool.filter(
    (i) => ctx.states.get(keyFor(i.bankId, i.question.id))?.flagged
  ).length;
  const today = new Date().toDateString();
  const studied = ctx.history.filter((h) => new Date(h.at).toDateString() === today).length;
  ctx.show(
    ctx.title(
      t('YOUR STUDY SPACE'),
      t('A little progress, every day.'),
      t('Study any subject. Build understanding. Test your knowledge.'),
      badge(
        localDatabase()
          ? t('● Saved to the local database')
          : signedIn()
            ? t('● Saved to your account')
            : t('● All data on this device'),
        'local-badge'
      )
    ),
    el(
      'div',
      { class: 'hero' },
      el(
        'div',
        {},
        el('h2', {}, t('Your next question is a good place to start.')),
        el(
          'p',
          {},
          ctx.banks.length === 1 && ctx.banks[0].isDefaultDemo
            ? t('Try 12 high-school biology questions, or import your own subject.')
            : pool.length
              ? t`${pool.length} questions across ${ctx.banks.filter((b) => b.enabled).length} enabled banks. Settle in for a focused session.`
              : t(
                  'Add a question bank for your course, or try the mathematics, science, and humanities demo.'
                )
        ),
        el(
          'div',
          { class: 'actions' },
          button(
            pool.length ? t('Start studying →') : t('Explore question banks →'),
            () => ctx.navigate(pool.length ? 'study' : 'banks'),
            'primary'
          ),
          button(t('Import questions'), () => ctx.navigate('banks'), 'secondary'),
          button(t('Set up an exam'), () => ctx.navigate('exam'), 'secondary')
        )
      )
    ),
    el(
      'div',
      { class: 'stats-grid' },
      stat(t('Ready for review'), due, t('Due now'), 'exam'),
      stat(t('Reviewed today'), studied, t('Study responses'), 'study'),
      stat(t('Saved for later'), flagged, t('Flagged questions'), 'review'),
      stat(t('Practice exams'), ctx.attempts.length, t('Completed attempts'), 'results')
    ),
    ctx.active &&
      el(
        'section',
        { class: 'notice warning' },
        el('h2', {}, t('An exam is waiting')),
        el('p', {}, t`Started ${date(ctx.active.startedAt)}. The original deadline still applies.`),
        button(t('Resume exam'), () => resumeExam(ctx, ctx.active), 'primary'),
        button(t('Discard saved exam'), () => discardActive(), 'danger')
      ),
    el(
      'div',
      { class: 'two-column home-sections' },
      el(
        'section',
        { class: 'panel' },
        el(
          'div',
          { class: 'section-heading' },
          el('h2', {}, t('Your question banks')),
          button(t('Manage banks →'), () => ctx.navigate('banks'), 'subtle')
        ),
        ctx.banks.length
          ? ctx.banks
              .slice(0, 4)
              .map((b) =>
                el(
                  'div',
                  { class: 'list-row' },
                  el(
                    'div',
                    {},
                    el('strong', {}, b.data.bank.title),
                    el(
                      'small',
                      {},
                      t`${b.data.questions.length} questions · ${b.data.bank.topics.length} topics`
                    )
                  ),
                  badge(b.enabled ? t('Enabled') : t('Disabled'))
                )
              )
          : el(
              'div',
              { class: 'empty' },
              el('h3', {}, t('A fresh start')),
              el('p', {}, t('Import a JSON bank to build your personal study library.')),
              button(t('Add a bank'), () => ctx.navigate('banks'), 'secondary')
            )
      ),
      el(
        'section',
        { class: 'panel' },
        el('h2', {}, t('Choose your pace')),
        el(
          'div',
          { class: 'list-row' },
          el(
            'div',
            {},
            el('h3', {}, t('Focused review')),
            el('p', {}, t('Return to due, flagged, or missed questions.'))
          ),
          button(t('Review →'), () => ctx.navigate('review'), 'subtle')
        ),
        el(
          'div',
          { class: 'list-row' },
          el(
            'div',
            {},
            el('h3', {}, t('Exam rehearsal')),
            el('p', {}, t('A timed session with detailed feedback.'))
          ),
          button(t('Configure →'), () => ctx.navigate('exam'), 'subtle')
        ),
        el(
          'p',
          { class: 'muted' },
          localDatabase()
            ? t('All study data is saved on this server. Export backups regularly.')
            : signedIn()
              ? t(
                  'Your answers, schedules, and results are saved to your account. Export a backup to keep a second copy.'
                )
              : t(
                  'Your answers, schedules, and results stay in this browser. Export a backup to keep a second copy.'
                )
        )
      )
    )
  );
}
function stat(title, value, note, iconName) {
  return el(
    'section',
    { class: 'stat' },
    el('div', {}, el('span', {}, title), icon(iconName, 'stat-icon')),
    el('strong', {}, value),
    el('small', {}, note)
  );
}
async function discardActive() {
  if (confirm(t('Discard this interrupted exam? Completed results and study history are kept.'))) {
    await db.remove('active', 'current');
    await ctx.refresh();
    await render();
  }
}
let initialized = false;
async function render() {
  if (!initialized) return;
  const version = ++renderVersion;
  await ctx.flushExamSave?.();
  if (version !== renderVersion) return;
  ctx.cleanup?.();
  ctx.cleanup = null;
  currentRoute = location.hash.slice(1) || 'home';
  ctx.show(el('p', { role: 'status' }, t('Loading local data…')));
  await ctx.refresh();
  if (version !== renderVersion) return;
  const route = routes.find((r) => r[0] === currentRoute) || routes[0];
  document.title = `${t(route[1])} · quitsar`;
  document.querySelector('#section-name').textContent = t(route[1]);
  document.querySelectorAll('nav a').forEach((a) => {
    if (a.getAttribute('href') === `#${route[0]}`) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const views = {
    home,
    banks: () => banksView(ctx),
    study: () => studySetup(ctx),
    review: () => studySetup(ctx, { review: true }),
    exam: () => examSetup(ctx),
    results: () => resultsList(ctx),
    tools: () => toolsView(ctx),
    settings: () => settingsView(ctx)
  };
  await views[route[0]]();
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
function help() {
  modal(
    t('Help & keyboard shortcuts'),
    el(
      'p',
      {},
      t(
        localDatabase()
          ? 'All study data is saved on this server. Export backups regularly.'
          : 'Guests save in this browser; signed-in users save to their account. Import banks in Question banks, choose Study for immediate feedback, or configure an Exam. Back up regularly through Backup & export.'
      )
    ),
    el(
      'dl',
      { class: 'shortcut-list' },
      el('dt', {}, '?'),
      el('dd', {}, t('Open this help')),
      el('dt', {}, 'Alt + N / Alt + P'),
      el('dd', {}, t('Next / previous question')),
      el('dt', {}, 'Alt + F'),
      el('dd', {}, t('Flag / unflag current question')),
      el('dt', {}, 'Alt + R'),
      el('dd', {}, t('Reveal or submit a study answer')),
      el('dt', {}, 'Alt + 1 / Alt + 2'),
      el('dd', {}, t('Repeat / Know after revealing an open answer')),
      el('dt', {}, 'Tab / Shift + Tab'),
      el('dd', {}, t('Move between controls')),
      el('dt', {}, t('Space / arrows')),
      el('dd', {}, t('Toggle checkboxes / select radio answers')),
      el('dt', {}, 'Esc'),
      el('dd', {}, t('Close this dialog'))
    ),
    el(
      'p',
      {},
      t(
        localDatabase()
          ? 'All study data is saved on this server. Export backups regularly.'
          : 'Guests can study offline after the app cache is ready. Signed-in accounts save to Cloudflare and require a connection. Guest and account libraries stay separate; transfer data using backups. Select image files explicitly. Clearing browser site data deletes the guest library.'
      )
    )
  );
}
function renderNavigation() {
  const route = routes.find(([id]) => id === (location.hash.slice(1) || 'home')) || routes[0];
  document.querySelector('#section-name').textContent = t(route[1]);
  document.querySelector('#navigation').replaceChildren(
    ...routes.map(([id, title]) =>
      el(
        'a',
        {
          href: `#${id}`,
          'aria-current': id === route[0] ? 'page' : null
        },
        icon(id),
        t(title)
      )
    )
  );
}
localizeShell();
renderNavigation();
reportStorage();
const headerLanguage = document.querySelector('#header-language');
headerLanguage.value = getLanguage();
headerLanguage.addEventListener('change', async () => {
  const language = headerLanguage.value;
  if (language === getLanguage()) return;
  headerLanguage.disabled = true;
  try {
    await ctx.flushExamSave?.();
    await ctx.flushQuestionWrites();
    const preferences = (await db.get('settings', 'preferences')) || ctx.settings;
    await db.put('settings', {
      ...preferences,
      id: 'preferences',
      language,
      updatedAt: Date.now()
    });
    setLanguage(language);
    location.reload();
  } catch (error) {
    headerLanguage.value = getLanguage();
    headerLanguage.disabled = false;
    showError(error);
  }
});
document.querySelector('#help-button').addEventListener('click', help);
document.querySelector('#account-toggle').addEventListener('click', (event) => {
  const toggle = event.currentTarget;
  toggle.setAttribute('aria-expanded', String(toggle.getAttribute('aria-expanded') !== 'true'));
});
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href^="#"]');
  if (
    !link ||
    link.classList.contains('skip-link') ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.altKey ||
    event.button !== 0
  )
    return;
  const route = link.getAttribute('href').slice(1);
  if (routes.some((r) => r[0] === route)) {
    event.preventDefault();
    ctx.navigate(route).catch(showError);
  }
});
document.querySelector('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  main.focus({ preventScroll: true });
  main.scrollIntoView({ block: 'start' });
});
document.addEventListener('keydown', (event) => {
  if (event.key === '?' && !/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) {
    event.preventDefault();
    help();
  }
  if (document.querySelector('#modal').open) return;
  if (event.altKey) {
    const target = document.querySelector(`[data-shortcut="${event.key.toLowerCase()}"]`);
    if (target && !target.disabled) {
      event.preventDefault();
      target.click();
    }
  }
});
window.addEventListener('hashchange', () => render().catch(showError));
let printDetails = [];
window.addEventListener('beforeprint', () => {
  printDetails = [...document.querySelectorAll('main details:not([open])')];
  printDetails.forEach((d) => (d.open = true));
});
window.addEventListener('afterprint', () => {
  printDetails.forEach((d) => (d.open = false));
  printDetails = [];
});
window.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  showError(event.reason);
});
function showError(error) {
  console.error(error);
  ctx.notice(
    error?.message || t('Something went wrong. Your saved data is still in this browser.'),
    'error'
  );
}
try {
  await initializeAccount();
  await db.openStorage();
  try {
    await ensureDefaultDemo();
  } catch (error) {
    showError(error);
  }
  initialized = true;
  await render();
  headerLanguage.disabled = false;
  // The absolute deadline also applies when the user visits another app section.
  setInterval(() => {
    if (!ctx.examRunning && ctx.active?.config.timer && ctx.active.deadline <= Date.now()) {
      ctx.cleanup?.();
      ctx.cleanup = null;
      resumeExam(ctx, ctx.active);
    }
  }, 1000);
  if ('serviceWorker' in navigator)
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => {
        const report = () => {
          if (navigator.serviceWorker.controller)
            cacheStatus = '◉ Local storage · Offline cache ready';
          reportStorage();
        };
        report();
        navigator.serviceWorker.addEventListener('controllerchange', report);
      })
      .catch(() => {
        cacheStatus = '◉ Local storage · Offline cache unavailable';
        reportStorage();
      });
  else {
    cacheStatus = '◉ Local storage · Keep local server running';
    reportStorage();
  }
} catch (error) {
  ctx.show(
    el(
      'section',
      { class: 'notice error', role: 'alert' },
      el('h1', {}, t('Study storage could not be opened')),
      el('p', {}, error.message),
      button(t('Try again'), () => location.reload())
    )
  );
}
