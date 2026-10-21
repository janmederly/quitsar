import { t } from './i18n.js';
export const TYPES = ['open_ended', 'single_choice', 'multiple_choice', 'image_recognition'];
export const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export function safePath(path) {
  return (
    typeof path === 'string' &&
    path.length <= 300 &&
    /^[a-zA-Z0-9_./ -]+$/.test(path) &&
    !path.startsWith('/') &&
    !path.split('/').some((p) => !p || p === '.' || p === '..') &&
    /\.(svg|png|jpe?g|gif|webp)$/i.test(path)
  );
}
export function validateBank(data) {
  const errors = [];
  const bankId = data?.bank?.id || t('(unknown bank)');
  let questionId = '—';
  const error = (path, message) =>
    errors.push(
      t`[bank ${String(bankId).slice(0, 100)}; question ${String(questionId).slice(0, 100)}] ${path}: ${message}`
    );
  const text = (value, path, required = true, max = 30000) => {
    if (value === undefined && !required) return;
    if (typeof value !== 'string' || (required && !value.trim()) || value.length > max)
      error(path, t`must be ${required ? t('nonempty ') : ''}text, at most ${max} characters`);
  };
  const id = (value, path) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value))
      error(
        path,
        t('use 1–100 letters, digits, dots, underscores or hyphens; begin with a letter or digit')
      );
  };
  const list = (value, path, required = false) => {
    if (value === undefined && !required) return [];
    if (!Array.isArray(value)) {
      error(path, t('must be an array'));
      return [];
    }
    return value;
  };
  if (!isRecord(data)) return [t('$: must be a JSON object')];
  if (data.schemaVersion !== '1.0') error('schemaVersion', t('supported version is "1.0"'));
  if (!isRecord(data.bank)) return [...errors, t('$.bank: must be an object')];
  const b = data.bank;
  id(b.id, 'bank.id');
  text(b.title, 'bank.title', true, 300);
  text(b.version, 'bank.version', true, 100);
  text(b.language, 'bank.language', true, 40);
  for (const field of ['description', 'author', 'license']) text(b[field], `bank.${field}`, false);
  for (const field of ['createdAt', 'updatedAt'])
    if (
      b[field] !== undefined &&
      (typeof b[field] !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(b[field]) ||
        !Number.isFinite(Date.parse(b[field])) ||
        new Date(b[field]).toISOString().slice(0, 10) !== b[field])
    )
      error(`bank.${field}`, t('must be a real date in YYYY-MM-DD format'));
  const topics = new Map();
  list(b.topics, 'bank.topics', true).forEach((topic, i) => {
    const p = `bank.topics[${i}]`;
    if (!isRecord(topic)) {
      error(p, t('must be an object'));
      return;
    }
    id(topic.id, `${p}.id`);
    text(topic.title, `${p}.title`, true, 300);
    if (topics.has(topic.id)) error(`${p}.id`, t('duplicate topic ID'));
    const subs = new Set();
    list(topic.subtopics, `${p}.subtopics`).forEach((sub, j) => {
      if (!isRecord(sub)) {
        error(`${p}.subtopics[${j}]`, t('must be an object'));
        return;
      }
      id(sub.id, `${p}.subtopics[${j}].id`);
      text(sub.title, `${p}.subtopics[${j}].title`, true, 300);
      if (subs.has(sub.id)) error(`${p}.subtopics[${j}].id`, t('duplicate subtopic ID'));
      subs.add(sub.id);
    });
    topics.set(topic.id, subs);
  });
  const ids = new Set();
  const questions = list(data.questions, 'questions', true);
  if (!questions.length || questions.length > 20000)
    error('questions', t('must contain 1–20,000 questions'));
  questions.forEach((q, i) => {
    questionId = q?.id || t('(unknown question)');
    const p = `questions[${i}]`;
    if (!isRecord(q)) {
      error(p, t('must be an object'));
      return;
    }
    id(q.id, `${p}.id`);
    if (ids.has(q.id)) error(`${p}.id`, t('duplicate question ID within this bank'));
    ids.add(q.id);
    if (!TYPES.includes(q.type)) error(`${p}.type`, t`must be one of ${TYPES.join(', ')}`);
    text(q.prompt, `${p}.prompt`);
    text(q.explanation, `${p}.explanation`);
    if (!topics.has(q.topicId)) error(`${p}.topicId`, t('must reference a declared bank topic'));
    if (q.subtopicId !== undefined && !topics.get(q.topicId)?.has(q.subtopicId))
      error(`${p}.subtopicId`, t('must reference a subtopic of this question’s topic'));
    if (!['easy', 'medium', 'hard'].includes(q.difficulty))
      error(`${p}.difficulty`, t('must be easy, medium or hard'));
    list(q.tags, `${p}.tags`).forEach((tag, j) => text(tag, `${p}.tags[${j}]`, true, 100));
    list(q.images, `${p}.images`).forEach((img, j) => {
      if (!isRecord(img)) {
        error(`${p}.images[${j}]`, t('must be an object'));
        return;
      }
      if (!safePath(img.path))
        error(
          `${p}.images[${j}].path`,
          t('use a safe relative SVG/PNG/JPEG/GIF/WebP path without traversal, URLs or backslashes')
        );
      text(img.alt, `${p}.images[${j}].alt`, true, 2000);
    });
    if (q.source !== undefined) {
      if (!isRecord(q.source)) error(`${p}.source`, t('must be an object'));
      else
        for (const [field, value] of Object.entries(q.source))
          text(value, `${p}.source.${field}`, false, 3000);
    }
    if (q.type === 'open_ended') {
      if (!isRecord(q.acceptedAnswer))
        error(`${p}.acceptedAnswer`, t('must be an object with display answer'));
      else {
        text(q.acceptedAnswer.display, `${p}.acceptedAnswer.display`);
        text(q.acceptedAnswer.feedback, `${p}.acceptedAnswer.feedback`, false);
        list(q.acceptedAnswer.aliases, `${p}.acceptedAnswer.aliases`).forEach((a, j) =>
          text(a, `${p}.acceptedAnswer.aliases[${j}]`, true, 1000)
        );
      }
    } else if (TYPES.includes(q.type)) {
      const options = list(q.options, `${p}.options`, true);
      if (options.length < 2 || options.length > 100)
        error(`${p}.options`, t('requires 2–100 options'));
      const optionIds = new Set();
      let correct = 0;
      options.forEach((o, j) => {
        const op = `${p}.options[${j}]`;
        if (!isRecord(o)) {
          error(op, t('must be an object'));
          return;
        }
        id(o.id, `${op}.id`);
        if (optionIds.has(o.id)) error(`${op}.id`, t('duplicate option ID'));
        optionIds.add(o.id);
        text(o.text, `${op}.text`);
        text(o.rationale, `${op}.rationale`);
        if (typeof o.isCorrect !== 'boolean') error(`${op}.isCorrect`, t('must be a boolean'));
        if (o.isCorrect === true) correct++;
      });
      const single =
        q.type === 'single_choice' ||
        (q.type === 'image_recognition' && q.selectionMode === 'single');
      if (correct < 1 || (single && correct !== 1))
        error(
          `${p}.options`,
          single
            ? t('requires exactly one correct option')
            : t('requires at least one correct option')
        );
      if (q.type === 'image_recognition') {
        if (!Array.isArray(q.images) || !q.images.length)
          error(`${p}.images`, t('image recognition requires at least one image'));
        if (!['single', 'multiple'].includes(q.selectionMode))
          error(`${p}.selectionMode`, t('must be single or multiple'));
      }
    }
  });
  return errors;
}
