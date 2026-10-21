import { t, label } from './i18n.js';
import { el, button, badge, date, announce } from './dom.js';
import { filterPanel, shuffle } from './filters.js';
import { questionView } from './question.js';
import { scoreQuestion } from './scoring.js';
import { keyFor } from './spaced-repetition.js';
export function studySetup(ctx, options = {}) {
  const filters = filterPanel(ctx.banks, ctx.states, options);
  const count = el('strong', {}, t`${filters.eligible().length} eligible questions`);
  filters.panel.addEventListener(
    'change',
    () => (count.textContent = t`${filters.eligible().length} eligible questions`)
  );
  const order = el(
    'select',
    {},
    el('option', { value: 'due' }, t('Due first')),
    el('option', { value: 'random' }, t('Random'))
  );
  const start = () => {
    let items = filters.eligible();
    if (order.value === 'random') items = shuffle(items);
    else
      items.sort(
        (a, b) =>
          (ctx.states.get(keyFor(a.bankId, a.question.id))?.due || Infinity) -
          (ctx.states.get(keyFor(b.bankId, b.question.id))?.due || Infinity)
      );
    if (!items.length) {
      ctx.notice(t('No matching questions. Enable banks or change your filters.'), 'error');
      return;
    }
    studySession(ctx, items);
  };
  ctx.show(
    ctx.title(
      options.review ? t('RETURN & REFLECT') : t('DAILY PRACTICE'),
      options.review ? t('Your review queue') : t('Make knowledge stick.'),
      t('Choose a manageable set. Answers and explanations appear as you go.')
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
        el('label', {}, t('Order '), order),
        count,
        button(t('Start session →'), start, 'primary')
      )
    ),
    el(
      'section',
      { class: 'panel' },
      el('h2', {}, t('Quick review')),
      el(
        'div',
        { class: 'actions' },
        ['due', 'flagged', 'incorrect', 'skipped', 'new'].map((queue) =>
          button(label(queue), () => studySetup(ctx, { ...options, queue }), 'secondary')
        )
      ),
      el(
        'p',
        { class: 'muted' },
        t(
          'Due means previously reviewed and scheduled for now. New questions have no recorded response. Incorrect uses the most recent objective response.'
        )
      )
    )
  );
}
export function studySession(ctx, source) {
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
      item.nextDue = state.due;
      item.feedback = true;
      render();
      announce(
        response === 'skip' ? t('Question skipped') : t`Response saved. Next due ${date(state.due)}`
      );
    } finally {
      busy = false;
    }
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
            button(t('Repeat'), () => respond('repeat'), 'secondary', { 'data-shortcut': '1' }),
            button(t('Know'), () => respond('know'), 'primary', { 'data-shortcut': '2' })
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
        t('FOCUSED STUDY'),
        t`Question ${index + 1} of ${items.length}`,
        t`${reviewed} reviewed · ${due} remaining due`,
        button(t('End session'), () => studySetup(ctx), 'subtle')
      ),
      el('progress', { max: items.length, value: reviewed, 'aria-label': t('Reviewed questions') }),
      el('div', { class: 'study-bar' }, badge(item.bankTitle), flag),
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
                studySetup(ctx);
              },
              'primary',
              { 'data-shortcut': 'n' }
            )
      )
    );
  }
  render();
}
