import { t, label } from './i18n.js';
import { el, field, prettyType } from './dom.js';
import { TYPES } from './validation.js';
import { matchesQueue } from './spaced-repetition.js';
export function questionPool(banks) {
  return banks
    .filter((b) => b.enabled)
    .flatMap((b) =>
      b.data.questions.map((q) => ({
        bankId: b.id,
        bankVersion: b.data.bank.version,
        bankTitle: b.data.bank.title,
        question: q,
        topicTitle: b.data.bank.topics.find((t) => t.id === q.topicId)?.title,
        subtopicTitle: b.data.bank.topics
          .find((t) => t.id === q.topicId)
          ?.subtopics?.find((s) => s.id === q.subtopicId)?.title
      }))
    );
}
export function filterPanel(banks, states, options = {}) {
  const pool = questionPool(banks);
  const controls = {};
  const select = (name, title, entries) => {
    const input = el(
      'select',
      { multiple: true, size: Math.min(4, Math.max(2, entries.length)), 'aria-label': title },
      entries.map(([id, label]) => el('option', { value: id }, label))
    );
    controls[name] = input;
    return field(title, input);
  };
  const unique = (values) => [...new Set(values.filter(Boolean))].sort().map((s) => [s, s]);
  const panel = el(
    'div',
    { class: 'filter-grid' },
    select(
      'banks',
      t('Banks'),
      banks.filter((b) => b.enabled).map((b) => [b.id, b.data.bank.title])
    ),
    select('topics', t('Topics'), unique(pool.map((i) => i.topicTitle))),
    select('subtopics', t('Subtopics'), unique(pool.map((i) => i.subtopicTitle))),
    select('tags', t('Tags (any match)'), unique(pool.flatMap((i) => i.question.tags || []))),
    select(
      'difficulty',
      t('Difficulty'),
      ['easy', 'medium', 'hard'].map((s) => [s, label(s)])
    ),
    select(
      'types',
      t('Question types'),
      TYPES.map((s) => [s, prettyType(s)])
    ),
    select('source', t('Source title'), unique(pool.map((i) => i.question.source?.title)))
  );
  panel.prepend(
    el(
      'p',
      { class: 'filter-hint' },
      t(
        'Empty selections include all. Use Ctrl/Cmd or Shift to select several; use Clear filters to reset.'
      )
    )
  );
  const stateSelect = el(
    'select',
    {},
    (options.review ? ['due', 'incorrect', 'flagged', 'skipped'] : ['all', 'new']).map((s) =>
      el('option', { value: s, selected: s === options.queue }, label(s))
    )
  );
  if (!options.exam && !options.hideQueue)
    panel.append(field(t('Question selection'), stateSelect));
  const referenceSet = options.references ? new Set(options.references) : null;
  const selected = (name) => [...controls[name].selectedOptions].map((o) => o.value);
  function eligible() {
    return pool.filter((item) => {
      const q = item.question;
      const key = JSON.stringify([item.bankId, q.id]);
      const state = states.get(key);
      if (referenceSet && !referenceSet.has(key)) return false;
      const values = {
        banks: [item.bankId],
        topics: [item.topicTitle],
        subtopics: [item.subtopicTitle],
        tags: q.tags || [],
        difficulty: [q.difficulty],
        types: [q.type],
        source: [q.source?.title]
      };
      for (const [name, vals] of Object.entries(values)) {
        const picked = selected(name);
        if (picked.length && !picked.some((v) => vals.includes(v))) return false;
      }
      if (options.exam) return true;
      return matchesQueue(state, stateSelect.value);
    });
  }
  return {
    panel,
    eligible,
    setQueue(queue) {
      stateSelect.value = queue;
      panel.dispatchEvent(new Event('change'));
    },
    queue: () => stateSelect.value,
    set(values) {
      for (const [name, selected] of Object.entries(values)) {
        if (!controls[name]) continue;
        for (const option of controls[name].options)
          option.selected = selected.includes(option.value);
      }
      panel.dispatchEvent(new Event('change'));
    },
    reset() {
      Object.values(controls).forEach((s) => [...s.options].forEach((o) => (o.selected = false)));
      stateSelect.value = options.review ? stateSelect.value : 'all';
      panel.dispatchEvent(new Event('change'));
    },
    description() {
      return (
        Object.keys(controls)
          .map((k) => {
            const titles = {
              banks: 'Banks',
              topics: 'Topics',
              subtopics: 'Subtopics',
              tags: 'Tags (any match)',
              difficulty: 'Difficulty',
              types: 'Question types',
              source: 'Source title'
            };
            const values = [...controls[k].selectedOptions].map((option) => option.textContent);
            return `${t(titles[k])}: ${values.join(', ') || t('All')}`;
          })
          .join(' · ') +
        (options.exam ? '' : ` · ${t('Review queue')}: ${label(stateSelect.value)}`)
      );
    }
  };
}
export function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
