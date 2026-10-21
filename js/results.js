import { t, label, getLocale } from './i18n.js';
import * as db from './storage.js';
import { el, button, badge, percent, date, download, table, number, prettyType } from './dom.js';
import { scoreQuestion, summarize } from './scoring.js';
import { questionView } from './question.js';
import { attemptCsv, attemptJson } from './transfer.js';
import { keyFor } from './spaced-repetition.js';

export function resultsList(ctx) {
  const objective = ctx.attempts
    .flatMap((a) => a.items)
    .filter((i) => i.question.type !== 'open_ended');
  const points = objective.reduce(
    (sum, i) => sum + scoreQuestion(i.question, i.selected).strict,
    0
  );
  const byDay = new Map();
  for (const event of ctx.history) {
    const day = new Date(event.at).toLocaleDateString(getLocale());
    byDay.set(day, (byDay.get(day) || 0) + 1);
  }
  ctx.show(
    ctx.title(
      t('REFLECT & REFINE'),
      t('Results & statistics'),
      t('See what you know, and where to return next.')
    ),
    el(
      'div',
      { class: 'stats-grid' },
      metric(t('Completed exams'), ctx.attempts.length),
      metric(t('Objective responses'), objective.length),
      metric(t('Strict accuracy'), percent(points, objective.length)),
      metric(t('Study responses'), ctx.history.length)
    ),
    el(
      'section',
      { class: 'panel' },
      el('h2', {}, t('Completed attempts')),
      ctx.attempts.length
        ? table(
            [t('Completed'), t('Questions'), t('Strict'), t('Partial'), t('Review')],
            ctx.attempts.map((a) => {
              const s = summarize(a);
              return [
                date(a.completedAt),
                s.total,
                percent(s.strict, s.objective),
                percent(s.partial, s.objective),
                button(t('View results'), () => attemptView(ctx, a), 'secondary')
              ];
            })
          )
        : el(
            'div',
            { class: 'empty' },
            el('p', {}, t('Your first exam result will appear here.')),
            button(t('Configure an exam'), () => ctx.navigate('exam'), 'primary')
          )
    ),
    el(
      'section',
      { class: 'panel' },
      el('h2', {}, t('Recent study activity')),
      byDay.size
        ? table([t('Day'), t('Responses')], [...byDay].reverse().slice(0, 14))
        : el(
            'p',
            { class: 'muted' },
            t('Study sessions and objective exam responses will be counted here.')
          )
    )
  );
}
function metric(title, value, detail) {
  return el(
    'section',
    { class: detail ? 'stat stat-score' : 'stat' },
    el('span', {}, title),
    el('strong', {}, value),
    detail && el('small', {}, detail)
  );
}
export function attemptView(ctx, attempt) {
  let assessing = false;
  const summary = summarize(attempt);
  const scoring = attempt.config.scoring || 'both';
  const incorrect = attempt.items
    .filter(
      (i) => i.question.type !== 'open_ended' && !scoreQuestion(i.question, i.selected).strict
    )
    .map((i) => keyFor(i.bankId, i.question.id));
  const all = attempt.items.map((i) => keyFor(i.bankId, i.question.id));
  const stats = [
    metric(t('Total questions'), summary.total),
    metric(t('Objective / open ended'), `${summary.objective} / ${summary.open}`)
  ];
  if (scoring !== 'partial')
    stats.push(
      metric(
        t('Strict score'),
        `${summary.strict}/${summary.objective}`,
        percent(summary.strict, summary.objective)
      )
    );
  if (scoring !== 'strict')
    stats.push(
      metric(
        t('Partial score'),
        `${number(summary.partial)}/${summary.objective}`,
        percent(summary.partial, summary.objective)
      )
    );
  const result = el('div', {});
  const review = el('div', { class: 'detailed-review' });
  function renderReview() {
    review.replaceChildren(
      ...attempt.items.map((item, index) => {
        const q = item.question;
        const current = ctx.states.get(keyFor(item.bankId, q.id));
        const assessment =
          q.type === 'open_ended'
            ? el(
                'div',
                { class: 'self-assessment' },
                el('h4', { class: 'question-subheading' }, t('Open-ended self-assessment')),
                el(
                  'p',
                  {},
                  t(
                    'Your written answer is not automatically graded and does not enter the objective percentages.'
                  )
                ),
                item.selfAssessment
                  ? el(
                      'p',
                      { class: 'notice' },
                      t`Self-assessed: ${item.selfAssessment === 'know' ? t('Know') : t('Repeat')} · Next due ${date(item.selfDue)}`
                    )
                  : el(
                      'div',
                      { class: 'actions' },
                      ['repeat', 'know'].map((response) =>
                        button(
                          response === 'know' ? t('Know') : t('Repeat'),
                          async (event) => {
                            if (item.selfAssessment || assessing) return;
                            assessing = true;
                            event.currentTarget.disabled = true;
                            try {
                              await ctx.respond(item, response, 'exam-self-assessment', (state) => {
                                item.selfAssessment = response;
                                item.selfDue = state.due;
                                attempt.updatedAt = Date.now();
                                return [{ store: 'attempts', value: attempt }];
                              });
                              renderReview();
                            } catch (error) {
                              delete item.selfAssessment;
                              delete item.selfDue;
                              event.currentTarget.disabled = false;
                              throw error;
                            } finally {
                              assessing = false;
                            }
                          },
                          response === 'know' ? 'primary' : 'secondary'
                        )
                      )
                    )
              )
            : null;
        return el(
          'section',
          { class: 'review-item' },
          el(
            'div',
            { class: 'section-heading' },
            el('h3', { class: 'review-heading' }, t`Question ${index + 1}`),
            el(
              'div',
              { class: 'tags' },
              item.skipped && badge(t('↷ Skipped')),
              item.flagged && badge(t('⚑ Flagged during exam')),
              !item.selected.length && !item.text?.trim() && badge(t('Unanswered'))
            )
          ),
          questionView(
            item,
            ctx.banks.find((b) => b.id === item.bankId),
            { feedback: true, disabled: true, headingLevel: 4 }
          ),
          assessment,
          el(
            'div',
            { class: 'actions no-print' },
            button(
              current?.flagged ? t('⚑ In review queue') : t('Add to review queue'),
              async () => {
                await ctx.flag(item, !ctx.states.get(keyFor(item.bankId, q.id))?.flagged);
                renderReview();
              },
              'secondary',
              { 'aria-pressed': !!current?.flagged }
            )
          )
        );
      })
    );
  }
  const groups = el(
    'section',
    { class: 'panel' },
    el('h2', {}, t('Objective score breakdown')),
    Object.entries(summary.groups).map(([kind, values]) =>
      el(
        'details',
        { open: kind === 'topic' },
        el('summary', {}, t`By ${label(kind)}`),
        table(
          [
            label(kind),
            t('Questions'),
            t('Strict points'),
            t('Strict %'),
            t('Partial points'),
            t('Partial %')
          ],
          Object.entries(values).map(([name, s]) => [
            kind === 'type'
              ? prettyType(name)
              : kind === 'difficulty'
                ? label(name)
                : name === 'No subtopic'
                  ? t('No subtopic')
                  : name,
            s.count,
            s.strict,
            percent(s.strict, s.count),
            number(s.partial),
            percent(s.partial, s.count)
          ])
        )
      )
    )
  );
  const time = Math.round((attempt.elapsed ?? attempt.completedAt - attempt.startedAt) / 1000);
  result.append(
    ctx.title(
      t('EXAM COMPLETE'),
      t('A clearer picture of your progress.'),
      t`Completed ${date(attempt.completedAt)}${attempt.automatic ? t(' · Automatically submitted at the deadline') : ''}`,
      button(t('All results'), () => resultsList(ctx), 'secondary')
    ),
    el('div', { class: 'stats-grid' }, stats),
    el(
      'section',
      { class: 'panel' },
      el(
        'div',
        { class: 'tags' },
        badge(t`${summary.answered} answered`),
        badge(t`${summary.unanswered} unanswered`),
        badge(t`${summary.skipped} skipped`),
        badge(t`${summary.flagged} flagged`),
        badge(t`${Math.floor(time / 60)}m ${time % 60}s spent`)
      ),
      el(
        'p',
        {},
        attempt.config.timer
          ? t`Timer duration: ${attempt.config.duration} min · ${attempt.remaining >= 0 ? t`${Math.ceil(attempt.remaining / 1000)} seconds remaining` : t`${Math.ceil(-attempt.remaining / 1000)} seconds overtime`}`
          : t('Untimed exam')
      ),
      el(
        'p',
        { class: 'muted' },
        t(
          'Unanswered includes skipped questions. Skipped is a separate intent marker. Open-ended questions are excluded from objective percentages.'
        )
      ),
      el(
        'div',
        { class: 'actions no-print' },
        button(
          t('Study incorrect questions'),
          () => ctx.study({ review: true, references: incorrect }),
          'primary',
          { disabled: !incorrect.length }
        ),
        button(
          t('Review this exam'),
          () => ctx.study({ review: true, references: all }),
          'secondary'
        ),
        button(
          t('Export JSON'),
          () => download(`exam-${attempt.id}.json`, attemptJson(attempt)),
          'secondary'
        ),
        button(
          t('Export CSV'),
          () => download(`exam-${attempt.id}.csv`, attemptCsv(attempt), 'text/csv;charset=utf-8'),
          'secondary'
        ),
        button(t('Print results'), () => window.print(), 'subtle')
      )
    ),
    groups,
    el('h2', {}, t('Detailed question review')),
    review
  );
  ctx.show(result);
  renderReview();
}
