import { t, label } from './i18n.js';
import { el, badge, prettyType, number } from './dom.js';
import { assetUrl } from './assets.js';
import { scoreQuestion } from './scoring.js';
let sequence = 0;
export function sourcePanel(q) {
  if (!q.source) return null;
  return el(
    'details',
    { class: 'source' },
    el('summary', {}, t('Source & reference')),
    el(
      'dl',
      {},
      Object.entries(q.source).flatMap(([key, value]) => [el('dt', {}, key), el('dd', {}, value)])
    )
  );
}
export function questionView(
  item,
  bank,
  { feedback = false, disabled = false, onChange = () => {}, headingLevel = 2 } = {}
) {
  const q = item.question;
  const group = `question-${++sequence}`;
  const selected = new Set(item.selected || []);
  const card = el(
    'article',
    { class: 'question-card' },
    el(
      'div',
      { class: 'question-meta' },
      badge(prettyType(q.type)),
      badge(label(q.difficulty)),
      el(
        'span',
        {},
        `${item.topicTitle || q.topicId}${q.subtopicId ? ' / ' + (item.subtopicTitle || q.subtopicId) : ''}`
      )
    ),
    el(`h${headingLevel}`, { class: 'prompt' }, q.prompt)
  );
  if (q.images?.length)
    card.append(
      el(
        'div',
        { class: 'question-images' },
        q.images.map((img) => {
          const url = assetUrl(bank, img.path);
          const warning = el(
            'p',
            { class: 'notice warning' },
            t`Image unavailable: ${img.path}. Select this related image in Banks → Attach images. You can continue with the text.`
          );
          if (!url) return warning;
          const image = el('img', {
            src: url,
            alt: img.alt,
            loading: feedback ? 'lazy' : 'eager',
            decoding: 'async'
          });
          image.addEventListener('error', () => image.replaceWith(warning), { once: true });
          return el('figure', {}, image, el('figcaption', {}, img.alt));
        })
      )
    );
  if (q.type === 'open_ended') {
    if (feedback)
      card.append(
        el(
          'section',
          { class: 'written-answer' },
          el(`h${headingLevel + 1}`, { class: 'question-subheading' }, t('Your written answer')),
          el('p', {}, item.text || t('No written answer.'))
        )
      );
    else
      card.append(
        el(
          'label',
          { class: 'field' },
          el('span', {}, t('Your answer (optional · self-assessed)')),
          el(
            'textarea',
            {
              rows: 5,
              maxlength: 100000,
              disabled,
              oninput: (event) => {
                item.text = event.target.value;
                onChange();
              }
            },
            item.text || ''
          )
        )
      );
    if (feedback)
      card.append(
        el(
          'div',
          { class: 'answer-panel' },
          el(`h${headingLevel + 1}`, { class: 'question-subheading' }, t('Official answer')),
          el('p', {}, q.acceptedAnswer.display),
          q.acceptedAnswer.aliases?.length &&
            el('p', {}, t`Accepted aliases: ${q.acceptedAnswer.aliases.join('; ')}`),
          q.acceptedAnswer.feedback && el('p', {}, q.acceptedAnswer.feedback),
          el(`h${headingLevel + 1}`, { class: 'question-subheading' }, t('Explanation')),
          el('p', {}, q.explanation),
          sourcePanel(q)
        )
      );
  } else {
    const multiple = q.type === 'multiple_choice' || q.selectionMode === 'multiple';
    const set = el(
      'fieldset',
      { class: 'options' },
      el('legend', {}, multiple ? t('Select all correct answers') : t('Select one answer'))
    );
    q.options.forEach((o, index) => {
      const picked = selected.has(o.id);
      const status = o.isCorrect
        ? picked
          ? t('Selected · correct')
          : t('Missed · correct answer')
        : picked
          ? t('Selected · incorrect')
          : t('Not selected · incorrect option');
      const input = el('input', {
        type: multiple ? 'checkbox' : 'radio',
        name: group,
        value: o.id,
        checked: picked,
        disabled: disabled || feedback,
        onchange: () => {
          if (!multiple) selected.clear();
          input.checked ? selected.add(o.id) : selected.delete(o.id);
          item.selected = [...selected];
          item.skipped = false;
          onChange();
        }
      });
      set.append(
        el(
          'div',
          {
            class: `option ${feedback ? (o.isCorrect ? 'is-correct' : picked ? 'is-incorrect' : '') : ''}`
          },
          el(
            'label',
            {},
            input,
            el('span', { class: 'option-letter' }, String.fromCharCode(65 + index)),
            el('span', {}, o.text)
          ),
          feedback && el('div', { class: 'rationale' }, badge(status), el('p', {}, o.rationale))
        )
      );
    });
    card.append(set);
    if (feedback) {
      const score = scoreQuestion(q, item.selected);
      card.append(
        el(
          'div',
          { class: 'answer-panel' },
          el(
            'strong',
            {},
            score.strict
              ? t('✓ Correct')
              : item.skipped
                ? t('↷ Skipped')
                : t('✕ Incorrect or unanswered')
          ),
          el('p', {}, t`Strict: ${score.strict}/1 · Partial: ${number(score.partial)}/1`),
          el(`h${headingLevel + 1}`, { class: 'question-subheading' }, t('Explanation')),
          el('p', {}, q.explanation),
          sourcePanel(q)
        )
      );
    }
  }
  if (q.tags?.length)
    card.append(
      el(
        'div',
        { class: 'tags' },
        q.tags.map((t) => badge(t))
      )
    );
  return card;
}
