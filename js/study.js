import { t, label, getLocale } from './i18n.js';
import { el, button, badge, date, announce, field } from './dom.js';
import { filterPanel, shuffle, questionPool } from './filters.js';
import { questionView } from './question.js';
import { scoreQuestion } from './scoring.js';
import { keyFor, matchesQueue, previewSchedule } from './spaced-repetition.js';

const reviewGroups = {
  due: ['Spaced repetition', 'Questions due for a scheduled review.'],
  incorrect: ['Incorrect answers', 'Questions whose latest graded answer was wrong.'],
  flagged: ['Flagged questions', 'Saved by you. Keep them here until you unflag them.'],
  skipped: ['Skipped questions', 'Questions you left unanswered. Answer them to clear this list.']
};

function ordered(ctx, items, order) {
  if (order === 'random') return shuffle(items);
  if (order === 'new')
    return items.sort(
      (a, b) =>
        Number(matchesQueue(ctx.states.get(keyFor(b.bankId, b.question.id)), 'new')) -
        Number(matchesQueue(ctx.states.get(keyFor(a.bankId, a.question.id)), 'new'))
    );
  if (order === 'easy' || order === 'hard') {
    const rank = { easy: 0, medium: 1, hard: 2 };
    return items.sort(
      (a, b) =>
        (rank[a.question.difficulty] - rank[b.question.difficulty]) * (order === 'hard' ? -1 : 1)
    );
  }
  return items.sort(
    (a, b) =>
      (ctx.states.get(keyFor(a.bankId, a.question.id))?.due ?? Infinity) -
      (ctx.states.get(keyFor(b.bankId, b.question.id))?.due ?? Infinity)
  );
}

export function studySetup(ctx, options = {}) {
  ctx.cleanup?.();
  ctx.cleanup = null;
  if (options.review && !options.references) return reviewSetup(ctx, options);
  const filters = filterPanel(ctx.banks, ctx.states, { ...options, review: false });
  const count = el('strong', {}, t`${filters.eligible().length} eligible questions`);
  filters.panel.addEventListener('change', () => {
    count.textContent = t`${filters.eligible().length} eligible questions`;
  });
  const order = el(
    'select',
    {},
    el('option', { value: 'new' }, t('New first')),
    el('option', { value: 'random' }, t('Random')),
    el('option', { value: 'easy' }, t('Difficulty: easy to hard')),
    el('option', { value: 'hard' }, t('Difficulty: hard to easy'))
  );
  const limit = el('input', { type: 'number', min: 1, max: 10000, step: 1, value: 20 });
  const start = () => {
    if (!limit.reportValidity()) return;
    const items = ordered(ctx, filters.eligible(), order.value).slice(0, Number(limit.value));
    if (!items.length) {
      ctx.notice(t('No matching questions. Enable banks or change your filters.'), 'error');
      return;
    }
    studySession(ctx, items, options);
  };
  const startButton = button(t('Start session →'), start, 'primary');
  const showLaunch = () => {
    startButton.scrollIntoView({ block: 'center' });
    startButton.focus({ preventScroll: true });
  };
  const pool = questionPool(ctx.banks);
  const topics = [...new Set(pool.map((item) => item.topicTitle).filter(Boolean))];
  ctx.show(
    ctx.title(
      '',
      options.references ? t('Review this exam') : t('Make knowledge stick.'),
      t('Explore topics, learn new material, or build your own practice session.')
    ),
    !options.references &&
      el(
        'section',
        { class: 'panel' },
        el('h2', {}, t('Practice a topic')),
        topics.length
          ? el(
              'div',
              { class: 'topic-list' },
              topics.map((topic) => {
                const questions = pool.filter((item) => item.topicTitle === topic);
                const fresh = questions.filter((item) =>
                  matchesQueue(ctx.states.get(keyFor(item.bankId, item.question.id)), 'new')
                ).length;
                return el(
                  'div',
                  { class: 'topic-row' },
                  el(
                    'div',
                    {},
                    el('h3', {}, topic),
                    el('small', { class: 'muted' }, t`${questions.length} questions · ${fresh} new`)
                  ),
                  button(
                    t('Practice'),
                    () => {
                      filters.reset();
                      filters.set({ topics: [topic] });
                      showLaunch();
                    },
                    'secondary'
                  )
                );
              })
            )
          : el('p', {}, t('Enable or import a question bank to start learning.')),
        el(
          'div',
          { class: 'actions' },
          button(
            t('Learn new questions'),
            () => {
              filters.reset();
              filters.setQueue('new');
              showLaunch();
            },
            'secondary'
          ),
          button(t('Custom practice'), () => filters.reset(), 'subtle')
        )
      ),
    el(
      'section',
      { class: 'panel' },
      el(
        'div',
        { class: 'section-heading' },
        el('h2', {}, t('Build your session')),
        button(t('Clear filters'), () => filters.reset(), 'subtle')
      ),
      options.references &&
        el(
          'p',
          { class: 'notice' },
          t('Restricted to the selected exam’s questions. Disabled or deleted banks are excluded.')
        ),
      filters.panel,
      el(
        'div',
        { class: 'session-launch' },
        field(t('Order'), order),
        field(t('Session size'), limit),
        count,
        startButton
      )
    )
  );
}

function reviewSetup(ctx, options) {
  const queue = Object.hasOwn(reviewGroups, options.queue) ? options.queue : 'due';
  const pool = questionPool(ctx.banks);
  const stateFor = (item) => ctx.states.get(keyFor(item.bankId, item.question.id));
  const filters = filterPanel(ctx.banks, ctx.states, { review: true, queue, hideQueue: true });
  const count = el('strong', { role: 'status' });
  const empty = el('div', { class: 'review-empty' });
  const start = button(
    queue === 'due' ? t('Review due questions') : t('Start review'),
    () => {
      ctx.cleanup?.();
      ctx.cleanup = null;
      const items = ordered(ctx, filters.eligible(), 'due');
      if (items.length) studySession(ctx, items, { review: true, queue });
    },
    'primary'
  );
  const groupCounts = {};
  const nextReview = () =>
    pool
      .map(stateFor)
      .map((state) => state?.due)
      .filter((due) => due > Date.now())
      .sort((a, b) => a - b)[0];
  const update = () => {
    const nextDue = nextReview();
    for (const [key, node] of Object.entries(groupCounts))
      node.textContent = pool.filter((item) => matchesQueue(stateFor(item), key)).length;
    const n = filters.eligible().length;
    count.textContent = t`${n} eligible questions`;
    start.disabled = !n;
    empty.replaceChildren();
    if (!n)
      empty.append(
        el(
          'h3',
          {},
          queue === 'due' ? t('No reviews due now') : t('No questions in this selection')
        ),
        el(
          'p',
          { class: 'muted' },
          queue === 'due' && nextDue
            ? t`Next review: ${date(nextDue)}`
            : t('Choose another group or adjust your filters.')
        )
      );
  };
  filters.panel.addEventListener('change', update);
  update();
  ctx.show(
    ctx.title(
      '',
      t('Your review queue'),
      t('Return to scheduled reviews, mistakes, and questions saved for later.')
    ),
    el(
      'div',
      { class: 'review-groups', role: 'group', 'aria-label': t('Review groups') },
      Object.entries(reviewGroups).map(([key, [title]]) => {
        const n = pool.filter((item) => matchesQueue(stateFor(item), key)).length;
        groupCounts[key] = el('strong', {}, n);
        return button(
          [el('span', {}, t(title)), groupCounts[key]],
          () => studySetup(ctx, { review: true, queue: key }),
          'review-group',
          { 'aria-pressed': String(key === queue) }
        );
      })
    ),
    el(
      'section',
      { class: 'panel review-selection' },
      el('h2', {}, t(reviewGroups[queue][0])),
      el('p', { class: 'muted' }, t(reviewGroups[queue][1])),
      queue === 'due' &&
        el(
          'p',
          { class: 'muted' },
          t(
            'Repeat brings a forgotten question back in 10 minutes. Know schedules its next review with spaced repetition.'
          )
        ),
      el('div', { class: 'session-launch' }, count, start),
      empty,
      el(
        'details',
        { class: 'review-filters' },
        el('summary', {}, t('Filter by bank, topic, or difficulty')),
        filters.panel,
        button(t('Clear filters'), () => filters.reset(), 'subtle')
      )
    ),
    el(
      'p',
      { class: 'muted' },
      t(
        'Questions can belong to more than one group. Every answer updates the same learning progress.'
      )
    )
  );
  let timer;
  const refreshWhenDue = () => {
    const nextDue = nextReview();
    if (nextDue)
      timer = setTimeout(
        () => {
          update();
          refreshWhenDue();
        },
        Math.min(2147483647, Math.max(100, nextDue - Date.now() + 50))
      );
  };
  refreshWhenDue();
  ctx.cleanup = () => clearTimeout(timer);
}

function intervalText(minutes) {
  const days = minutes / 1440;
  const unit = days >= 1 ? 'day' : minutes >= 60 ? 'hour' : 'minute';
  const value = Math.max(1, Math.round(days >= 1 ? days : minutes >= 60 ? minutes / 60 : minutes));
  return new Intl.NumberFormat(getLocale(), { style: 'unit', unit, unitDisplay: 'short' }).format(
    value
  );
}

export function studySession(ctx, source, options = {}) {
  const items = structuredClone(source).map((i) => ({
    ...i,
    selected: [],
    text: '',
    feedback: false,
    recorded: false
  }));
  let index = 0;
  let busy = false;
  async function respond(response) {
    if (busy || items[index].recorded) return;
    busy = true;
    try {
      const item = items[index];
      const state = await ctx.respond(item, response);
      item.recorded = true;
      item.response = response;
      item.nextDue = response === 'skip' ? null : state.due;
      item.feedback = true;
      render();
      announce(
        response === 'skip' ? t('Question skipped') : t`Response saved. Next due ${date(state.due)}`
      );
    } finally {
      busy = false;
    }
  }
  function finish() {
    const answered = items.filter((item) => item.recorded && item.response !== 'skip').length;
    const skipped = items.filter((item) => item.response === 'skip').length;
    const pool = questionPool(ctx.banks);
    const due = pool.filter((item) =>
      matchesQueue(ctx.states.get(keyFor(item.bankId, item.question.id)), 'due')
    ).length;
    const next = pool
      .map((item) => ctx.states.get(keyFor(item.bankId, item.question.id))?.due)
      .filter((time) => time > Date.now())
      .sort((a, b) => a - b)[0];
    ctx.show(
      ctx.title('', t('Session complete'), t`${answered} answered · ${skipped} skipped`),
      el(
        'section',
        { class: 'panel' },
        el('h2', {}, options.review && !due ? t('No reviews due now') : t('Progress saved')),
        el('p', {}, t`${due} questions due now`),
        next && el('p', { class: 'muted' }, t`Next review: ${date(next)}`),
        button(
          options.review ? t('Back to review') : t('Back to study'),
          () => studySetup(ctx, options),
          'primary'
        )
      )
    );
  }
  function move(delta) {
    index = Math.max(0, Math.min(items.length - 1, index + delta));
    render();
    const prompt = document.querySelector('.prompt');
    prompt?.setAttribute('tabindex', '-1');
    prompt?.focus({ preventScroll: true });
    prompt?.scrollIntoView({ block: 'nearest' });
  }
  function render() {
    const item = items[index];
    const q = item.question;
    const state = ctx.states.get(keyFor(item.bankId, q.id));
    const due = items.filter(
      (i) => ctx.states.get(keyFor(i.bankId, i.question.id))?.due <= Date.now()
    ).length;
    const flag = button(
      state?.flagged ? t('⚑ Flagged') : t('⚐ Flag'),
      async () => {
        await ctx.flag(item, !ctx.states.get(keyFor(item.bankId, q.id))?.flagged);
        render();
      },
      'secondary',
      { 'aria-pressed': !!state?.flagged, 'data-shortcut': 'f' }
    );
    const controls = el('div', { class: 'actions' });
    const preview = !item.recorded ? previewSchedule(state, ctx.settings) : null;
    const ratingButton = (response, text, style, shortcut) =>
      button(
        [el('span', {}, text), el('small', {}, intervalText(preview[response].interval))],
        () => respond(response),
        style + ' rating-button',
        {
          'data-shortcut': shortcut,
          'aria-label': text,
          title: t`Next review: ${date(preview[response].due)}`
        }
      );
    if (!item.recorded) {
      if (q.type === 'open_ended') {
        if (!item.feedback)
          controls.append(
            button(
              t('Reveal answer'),
              () => {
                item.feedback = true;
                render();
              },
              'primary',
              { 'data-shortcut': 'r' }
            )
          );
        else
          controls.append(
            el('span', { class: 'muted' }, t('Self-assess your recall:')),
            ratingButton('repeat', t('Repeat'), 'secondary', '1'),
            ratingButton('know', t('Know'), 'primary', '2')
          );
      } else
        controls.append(
          button(
            t('Check answer'),
            async () => {
              if (!item.selected.length) {
                ctx.notice(t('Choose an answer, or intentionally skip this question.'), 'error');
                return;
              }
              await respond(scoreQuestion(q, item.selected).strict ? 'know' : 'repeat');
            },
            'primary',
            { 'data-shortcut': 'r' }
          )
        );
      if (q.type !== 'open_ended')
        controls.append(
          el(
            'p',
            { class: 'muted schedule-preview' },
            t`Incorrect: ${intervalText(preview.repeat.interval)} · Correct: ${intervalText(preview.know.interval)}`
          )
        );
      controls.append(button(t('Skip'), () => respond('skip'), 'subtle'));
    }
    if (item.recorded)
      controls.append(
        el(
          'p',
          { class: 'notice', role: 'status' },
          item.nextDue
            ? t`Saved · Next due ${date(item.nextDue)}`
            : t('Skipped · Saved to your skipped queue')
        )
      );
    const reviewed = items.filter((i) => i.recorded).length;
    ctx.show(
      ctx.title(
        '',
        t`Question ${index + 1} of ${items.length}`,
        t`${reviewed} reviewed · ${due} remaining due`,
        button(t('End session'), () => studySetup(ctx, options), 'subtle')
      ),
      el('progress', { max: items.length, value: reviewed, 'aria-label': t('Reviewed questions') }),
      el('div', { class: 'study-bar' }, badge(item.bankTitle), flag),
      options.review &&
        !options.references &&
        el(
          'p',
          { class: 'muted' },
          options.queue === 'due'
            ? t('Scheduled review')
            : t(reviewGroups[options.queue]?.[0] || 'Scheduled review')
        ),
      questionView(
        item,
        ctx.banks.find((b) => b.id === item.bankId),
        { feedback: item.feedback, disabled: item.recorded }
      ),
      controls,
      el(
        'div',
        { class: 'session-nav' },
        button(t('← Previous'), () => move(-1), 'secondary', {
          disabled: index === 0,
          'data-shortcut': 'p'
        }),
        el('span', { class: 'muted' }, t('Alt + R reveal/check · Alt + F flag')),
        index < items.length - 1
          ? button(t('Next →'), () => move(1), 'primary', { 'data-shortcut': 'n' })
          : button(
              t('Finish session ✓'),
              () => {
                ctx.notice(t`${reviewed} responses saved.`);
                finish();
              },
              'primary',
              { 'data-shortcut': 'n' }
            )
      )
    );
  }
  render();
}
