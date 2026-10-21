import { t, label, getLocale } from './i18n.js';
import * as db from './storage.js';
import { signedIn, usesServerStorage } from './account.js';
import { el, button, field, modal, badge, announce } from './dom.js';
import { filterPanel, shuffle } from './filters.js';
import { questionView } from './question.js';
import { keyFor, schedule } from './spaced-repetition.js';
import { scoreQuestion } from './scoring.js';
import { createAutosave } from './autosave.js';
import { attemptView } from './results.js';

export function examSetup(ctx) {
  if (ctx.active) {
    ctx.show(
      ctx.title(
        t('INTERRUPTED SESSION'),
        t('Pick up where you left off.'),
        t('Your saved answers are here. Timed sessions retain the original deadline.')
      ),
      el(
        'section',
        { class: 'panel' },
        el(
          'p',
          {},
          t`${ctx.active.items.length} questions · started ${new Date(ctx.active.startedAt).toLocaleString(getLocale())}`
        ),
        el(
          'div',
          { class: 'actions' },
          button(t('Resume exam'), () => resumeExam(ctx, ctx.active), 'primary'),
          button(
            t('Discard exam'),
            async () => {
              if (confirm(t('Discard the interrupted exam and its unsubmitted answers?'))) {
                await db.remove('active', 'current');
                ctx.active = null;
                examSetup(ctx);
              }
            },
            'danger'
          )
        )
      )
    );
    return;
  }
  const filters = filterPanel(ctx.banks, ctx.states, { exam: true });
  const number = el('input', { type: 'number', value: 10, min: 1, max: 1000, required: true });
  const duration = el('input', { type: 'number', value: 30, min: 1, max: 1440, required: true });
  const warnings = el('input', { value: ctx.settings.warnings, required: true });
  const random = el('input', { type: 'checkbox', checked: true });
  const repeat = el('input', { type: 'checkbox' });
  const open = el('input', { type: 'checkbox', checked: false });
  const timer = el('input', { type: 'checkbox', checked: true });
  const changes = el('input', { type: 'checkbox', checked: true });
  const explanations = el('input', { type: 'checkbox', checked: ctx.settings.explanations });
  const scoring = el(
    'select',
    {},
    ['both', 'strict', 'partial'].map((v) =>
      el('option', { value: v, selected: ctx.settings.scoring === v }, label(v))
    )
  );
  const count = el('strong');
  const eligible = () =>
    filters.eligible().filter((i) => open.checked || i.question.type !== 'open_ended');
  function update() {
    count.textContent = t`${eligible().length} eligible questions`;
  }
  const check = (input, label) => el('label', { class: 'checkbox-row' }, input, label);
  const form = el(
    'form',
    {
      class: 'panel',
      onsubmit: (e) => {
        e.preventDefault();
        const items = eligible();
        const requested = Number(number.value);
        if (!items.length) {
          ctx.notice(t('No questions match these filters.'), 'error');
          return;
        }
        if (requested > items.length && !repeat.checked) {
          ctx.notice(
            t`Only ${items.length} questions are eligible. Reduce the count or enable repeats.`,
            'error'
          );
          return;
        }
        if (
          !/^\s*\d+(\.\d+)?(\s*,\s*\d+(\.\d+)?)*\s*$/.test(warnings.value) ||
          warnings.value.split(',').some((n) => Number(n) > 1440)
        ) {
          ctx.notice(t('Warnings must be comma-separated minutes between 0 and 1440.'), 'error');
          return;
        }
        const config = {
          requested,
          random: random.checked,
          repeat: repeat.checked,
          includeOpen: open.checked,
          timer: timer.checked,
          duration: Number(duration.value),
          warnings: [...new Set(warnings.value.split(',').map(Number))].sort((a, b) => b - a),
          changes: changes.checked,
          explanations: explanations.checked,
          scoring: scoring.value,
          filters: filters.description(),
          eligible: items.length
        };
        const selectedBankTitles = [...new Set(items.map((i) => i.bankTitle))];
        const dialog = modal(
          t('Ready to begin?'),
          el('p', {}, t`Banks: ${selectedBankTitles.join(', ')}`),
          el('p', {}, config.filters),
          el(
            'p',
            {},
            t`${items.length} eligible · ${requested} requested${repeat.checked ? t(' · Repeats allowed') : ''}`
          ),
          el(
            'p',
            {},
            timer.checked
              ? t`Timer: ${duration.value} minutes. It continues while the page is closed.`
              : t('Untimed session')
          ),
          el(
            'p',
            {},
            t(
              'Scoring: strict all-or-nothing and bounded partial credit. Open-ended answers are self-assessed separately.'
            )
          ),
          el(
            'p',
            {},
            explanations.checked
              ? t('Explanations appear after final submission.')
              : t(
                  'Practice setting: explanations can be revealed after locking an individual answer.'
                )
          ),
          button(
            t('Start exam'),
            async () => {
              const sequence = [];
              let deck = random.checked ? shuffle(items) : [...items];
              while (sequence.length < requested) {
                sequence.push(...deck.slice(0, requested - sequence.length));
                if (random.checked) deck = shuffle(items);
              }
              const now = Date.now();
              const active = {
                id: 'current',
                attemptId: crypto.randomUUID(),
                index: 0,
                startedAt: now,
                updatedAt: now,
                deadline: timer.checked ? now + config.duration * 60000 : null,
                config,
                items: structuredClone(sequence).map((i) => ({
                  ...i,
                  selected: [],
                  text: '',
                  skipped: false,
                  flagged: !!ctx.states.get(keyFor(i.bankId, i.question.id))?.flagged,
                  visited: false,
                  locked: false
                })),
                warned: []
              };
              await db.put('active', active);
              ctx.active = active;
              dialog.close();
              resumeExam(ctx, active);
            },
            'primary'
          )
        );
      }
    },
    el(
      'div',
      { class: 'section-heading' },
      el('h2', {}, t('Choose your question pool')),
      button(
        t('Clear filters'),
        () => {
          filters.reset();
          update();
        },
        'subtle'
      )
    ),
    filters.panel,
    el('h2', {}, t('Session settings')),
    el(
      'div',
      { class: 'filter-grid' },
      field(t('Number of questions'), number, '1–1000'),
      field(t('Duration (minutes)'), duration, '1–1440'),
      field(t('Timer warnings (minutes)'), warnings),
      field(t('Score display'), scoring)
    ),
    el(
      'div',
      { class: 'check-grid' },
      check(random, t('Random question order')),
      check(repeat, t('Allow repeats when count exceeds eligible questions')),
      check(open, t('Include open-ended self-assessment')),
      check(timer, t('Use countdown timer')),
      check(changes, t('Allow answer changes before final submission')),
      check(explanations, t('Hide explanations until final submission'))
    ),
    el(
      'div',
      { class: 'session-launch' },
      count,
      el('button', { type: 'submit', class: 'primary' }, t('Preview exam →'))
    )
  );
  form.addEventListener('change', update);
  update();
  ctx.show(
    ctx.title(
      t('PRACTICE WITH PURPOSE'),
      t('Exam simulator'),
      t('Create a rehearsal that fits your exam. Your progress is saved as you go.')
    ),
    form
  );
}

export function resumeExam(ctx, saved) {
  ctx.examRunning = true;
  const exam = structuredClone(saved);
  let finishing = false;
  let submissionFailed = false;
  let queue = Promise.resolve();
  let interval;
  let saveError = false;
  let pendingSaves = 0;
  let timerNode, saveNode, navigation;
  const stage = el('div');
  const remoteSave = usesServerStorage();
  const writeSnapshot = () => {
    exam.updatedAt = Date.now();
    const snapshot = structuredClone(exam);
    // Begin in the input handler. IndexedDB orders these write transactions itself;
    // deferring creation through a Promise queue can lose the last click on refresh.
    if (saveNode) {
      saveNode.textContent = signedIn() ? t('Saving to your account…') : t('Saving locally…');
      saveNode.className = 'muted';
    }
    pendingSaves++;
    queue = db.put('active', snapshot);
    queue
      .then(() => {
        pendingSaves--;
        if (saveNode && !pendingSaves && !remoteSave) {
          saveNode.textContent = signedIn()
            ? t('✓ Progress saved to your account')
            : t('✓ Progress saved locally');
          saveNode.className = 'muted';
        }
        saveError = false;
      })
      .catch((error) => {
        pendingSaves--;
        saveError = true;
        if (saveNode) {
          saveNode.textContent = t('⚠ Save failed — export your answers before leaving');
          saveNode.className = 'error';
        }
        ctx.notice(error.message, 'error');
      });
    ctx.active = exam;
    return queue;
  };
  let unsaved = false;
  const saver = createAutosave(writeSnapshot, {
    onPending: (value) => {
      unsaved = value;
      if (saveNode && !saveError)
        saveNode.textContent = value
          ? signedIn()
            ? t('Saving to your account…')
            : t('Saving locally…')
          : signedIn()
            ? t('✓ Progress saved to your account')
            : t('✓ Progress saved locally');
    },
    onError: () => {} // writeSnapshot already reports failures with recovery controls.
  });
  const flush = () => (remoteSave ? saver.flush() : queue);
  ctx.flushExamSave = flush;
  const guardUnload = (event) => {
    if (unsaved) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', guardUnload);
  const save = (immediate = false) => {
    if (finishing) return queue;
    ctx.active = exam;
    if (!remoteSave) return writeSnapshot();
    if (saveNode)
      saveNode.textContent = signedIn() ? t('Saving to your account…') : t('Saving locally…');
    saver.schedule();
    return immediate ? saver.flush() : Promise.resolve();
  };
  function lockCurrent() {
    const item = exam.items[exam.index];
    if (item.selected.length || item.text?.trim() || item.skipped) item.locked = true;
  }
  function move(index) {
    if (finishing) return;
    lockCurrent();
    exam.index = index;
    renderQuestion();
    save();
    const prompt = stage.querySelector('.prompt');
    prompt?.setAttribute('tabindex', '-1');
    prompt?.focus({ preventScroll: true });
  }
  async function finish(automatic = false) {
    if (finishing) return;
    const pending = flush();
    finishing = true;
    submissionFailed = false;
    clearInterval(interval);
    renderQuestion();
    try {
      await pending.catch(() => {});
      await ctx.flushQuestionWrites();
      const completedAt = automatic && exam.deadline ? exam.deadline : Date.now();
      const attempt = {
        ...structuredClone(exam),
        id: exam.attemptId,
        completedAt,
        updatedAt: Date.now(),
        automatic,
        elapsed: Math.max(0, completedAt - exam.startedAt),
        remaining: exam.deadline ? exam.deadline - completedAt : null
      };
      // Completion, history, schedules and removal of the active session commit together.
      const changes = [
        { store: 'attempts', value: attempt },
        { store: 'active', delete: true, id: 'current' }
      ];
      const states = new Map(ctx.states);
      for (let n = 0; n < attempt.items.length; n++) {
        const item = attempt.items[n];
        const id = keyFor(item.bankId, item.question.id);
        const old = states.get(id);
        let state = {
          ...old,
          id,
          bankId: item.bankId,
          bankVersion: item.bankVersion,
          questionId: item.question.id,
          flagged: item.flagged,
          updatedAt: Date.now()
        };
        if (item.question.type !== 'open_ended') {
          const score = scoreQuestion(item.question, item.selected);
          const response =
            item.skipped || !item.selected.length ? 'skip' : score.strict ? 'know' : 'repeat';
          if (response === 'skip')
            state = { ...state, skipped: true, timesSeen: (state.timesSeen || 0) + 1 };
          else {
            state = {
              ...schedule(state, response, ctx.settings),
              skipped: false,
              lastObjectiveCorrect: !!score.strict
            };
            state[score.strict ? 'correctCount' : 'incorrectCount'] =
              (state[score.strict ? 'correctCount' : 'incorrectCount'] || 0) + 1;
          }
          changes.push({
            store: 'history',
            value: {
              id: `${attempt.id}:${n}`,
              bankId: item.bankId,
              bankVersion: item.bankVersion,
              questionId: item.question.id,
              response,
              at: Date.now(),
              origin: 'exam'
            }
          });
        } else if (item.skipped) state.skipped = true;
        states.set(id, state);
      }
      for (const [id, state] of states)
        if (state !== ctx.states.get(id)) changes.push({ store: 'states', value: state });
      await db.atomic(changes);
      await ctx.refresh();
      ctx.cleanup?.();
      ctx.cleanup = null;
      ctx.examRunning = false;
      document.querySelector('#modal').close();
      announce(
        automatic ? t('Time is up. Exam saved and submitted.') : t('Exam submitted and saved.')
      );
      attemptView(ctx, attempt);
    } catch (error) {
      finishing = false;
      submissionFailed = true;
      saveError = true;
      ctx.notice(
        t`Could not finalize the exam: ${error.message}. Your saved session is retained. Retry submission or export your answers.`,
        'error'
      );
      renderQuestion();
      // Keep the recovery controls usable. An expired deadline must not cause
      // renderQuestion -> tick -> finish to retry a failed transaction forever.
      interval = setInterval(tick, 1000);
    }
  }
  function requestFinish() {
    modal(
      t('Submit this exam?'),
      el(
        'p',
        {},
        t`${exam.items.filter((i) => i.selected.length || i.text?.trim()).length} of ${exam.items.length} questions answered. Submission ends this attempt. You can review all explanations afterwards.`
      ),
      button(
        t('Submit & save results'),
        () => {
          document.querySelector('#modal').close();
          finish(exam.config.timer && exam.deadline <= Date.now());
        },
        'primary'
      )
    );
  }
  function tick() {
    if (!exam.config.timer || finishing) return;
    const remaining = exam.deadline - Date.now();
    if (timerNode) {
      const seconds = Math.max(0, Math.ceil(remaining / 1000));
      timerNode.textContent = t`◷ ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} remaining`;
      timerNode.classList.toggle('timer-warning', remaining <= 60000);
    }
    if (remaining <= 0) {
      clearInterval(interval);
      if (!submissionFailed) finish(true);
      return;
    }
    exam.warned ||= [];
    for (const threshold of exam.config.warnings)
      if (
        remaining <= threshold * 60000 &&
        !exam.warned.includes(threshold) &&
        threshold * 60000 < exam.config.duration * 60000
      ) {
        exam.warned.push(threshold);
        ctx.notice(
          t`Timer warning: ${threshold} minute${threshold === 1 ? '' : 's'} or less remain.`
        );
        save();
      }
  }
  function grid() {
    navigation.replaceChildren(
      ...exam.items.map((item, index) => {
        const status = [
          index === exam.index ? t('Current') : null,
          item.selected.length || item.text?.trim()
            ? t('Answered')
            : item.skipped
              ? t('Skipped')
              : t('Unanswered'),
          item.flagged ? t('Flagged') : null,
          item.visited ? t('Visited') : t('Unvisited')
        ]
          .filter(Boolean)
          .join(' · ');
        return button(
          el(
            'span',
            {},
            el('strong', {}, index + 1),
            el(
              'small',
              {},
              `${item.flagged ? '⚑ ' : ''}${item.selected.length || item.text?.trim() ? '✓' : item.skipped ? '↷' : item.visited ? '·' : '○'}`
            )
          ),
          () => move(index),
          `grid-question ${index === exam.index ? 'current' : ''} ${item.selected.length || item.text?.trim() ? 'answered' : ''}`,
          {
            'aria-label': t`Question ${index + 1}: ${status}`,
            'aria-current': index === exam.index ? 'step' : null,
            title: status
          }
        );
      })
    );
  }
  function renderQuestion() {
    const item = exam.items[exam.index];
    item.visited = true;
    timerNode = el(
      'strong',
      { class: 'exam-timer', role: 'timer', 'aria-label': t('Exam time remaining') },
      exam.config.timer ? t('Calculating timer…') : t('Untimed session')
    );
    saveNode = el(
      'p',
      { class: saveError ? 'error' : 'muted' },
      saveError
        ? t('⚠ Previous save failed')
        : signedIn()
          ? t('✓ Progress saved to your account')
          : t('✓ Progress saved locally')
    );
    navigation = el('nav', { class: 'question-grid', 'aria-label': t('Exam question navigation') });
    const controls = el('div', { class: 'actions' });
    const expired = exam.config.timer && exam.deadline <= Date.now();
    if (!submissionFailed && !expired && (!item.locked || exam.config.changes))
      controls.append(
        button(
          t('Save answer'),
          () => {
            if (!item.selected.length && !item.text?.trim()) {
              ctx.notice(t('Choose or write an answer, or use Skip.'), 'error');
              return;
            }
            lockCurrent();
            save();
            renderQuestion();
          },
          'secondary'
        ),
        button(
          t('Skip question'),
          () => {
            item.selected = [];
            item.text = '';
            item.skipped = true;
            item.locked = true;
            save();
            if (exam.index < exam.items.length - 1) move(exam.index + 1);
            else renderQuestion();
          },
          'subtle'
        )
      );
    if (item.locked && !exam.config.changes) controls.append(badge(t('Answer locked')));
    const feedback = !exam.config.explanations && item.reveal;
    if (!exam.config.explanations && item.locked && !item.reveal)
      controls.append(
        button(
          t('Reveal feedback (locks this answer)'),
          () => {
            item.locked = true;
            item.reveal = true;
            save();
            renderQuestion();
          },
          'secondary'
        )
      );
    stage.replaceChildren(
      ctx.title(
        t('EXAM IN PROGRESS'),
        t`Question ${exam.index + 1} of ${exam.items.length}`,
        item.bankTitle,
        timerNode
      ),
      el('progress', {
        max: exam.items.length,
        value: exam.items.filter((i) => i.selected.length || i.text?.trim() || i.skipped).length,
        'aria-label': t('Exam progress')
      }),
      el(
        'div',
        { class: 'exam-layout' },
        el(
          'div',
          {},
          questionView(
            item,
            ctx.banks.find((b) => b.id === item.bankId),
            {
              disabled:
                submissionFailed ||
                expired ||
                finishing ||
                feedback ||
                (!exam.config.changes && item.locked),
              feedback,
              onChange: () => {
                save();
                grid();
              }
            }
          ),
          controls,
          el(
            'div',
            { class: 'session-nav' },
            button(t('← Previous'), () => move(exam.index - 1), 'secondary', {
              disabled: exam.index === 0,
              'data-shortcut': 'p'
            }),
            button(
              item.flagged ? t('⚑ Flagged') : t('⚐ Flag'),
              () => {
                item.flagged = !item.flagged;
                save();
                renderQuestion();
              },
              'secondary',
              { 'aria-pressed': item.flagged, 'data-shortcut': 'f' }
            ),
            button(t('Next →'), () => move(exam.index + 1), 'primary', {
              disabled: exam.index === exam.items.length - 1,
              'data-shortcut': 'n'
            })
          )
        ),
        el(
          'aside',
          { class: 'panel exam-aside' },
          el('h2', {}, t('Your progress')),
          navigation,
          el(
            'p',
            { class: 'muted' },
            t(
              '✓ Answered · ○ Unvisited · · Visited · ↷ Skipped · ⚑ Flagged. The outlined question is current.'
            )
          ),
          saveNode,
          button(t('Submit exam'), requestFinish, 'primary'),
          button(
            t('Save & return home'),
            async () => {
              lockCurrent();
              await save(true);
              await ctx.navigate('home');
            },
            'subtle'
          ),
          button(
            t('Download current answers'),
            () =>
              import('./dom.js').then(({ download }) =>
                download('interrupted-exam.json', {
                  format: 'quitsar-backup',
                  version: 1,
                  exportedAt: Date.now(),
                  records: { active: [structuredClone(exam)] }
                })
              ),
            'subtle'
          )
        )
      )
    );
    grid();
    tick();
  }
  ctx.cleanup = () => {
    window.removeEventListener('beforeunload', guardUnload);
    ctx.flushExamSave = null;
    clearInterval(interval);
    ctx.examRunning = false;
  };
  ctx.show(stage);
  renderQuestion();
  if (!finishing) {
    save();
    interval = setInterval(tick, 1000);
  }
}
