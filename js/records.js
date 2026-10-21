import { t, languages } from './i18n.js';
import { validateBank, isRecord, safePath } from './validation.js';
import { LIMITS, jsonBytes } from './limits.js';

const invalid = (status, message) => {
  throw Object.assign(new Error(t(message)), { status });
};

export function validateRecord(store, row) {
  if (!['banks', 'states', 'attempts', 'history', 'settings', 'active'].includes(store))
    invalid(400, 'Invalid store.');
  if (
    !isRecord(row) ||
    typeof row.id !== 'string' ||
    !row.id.length ||
    row.id.length > 400 ||
    row.id.includes('\0')
  )
    throw new Error(t('Invalid record ID.'));
  if (jsonBytes(row) > LIMITS.record)
    throw Object.assign(
      new Error(t('Record exceeds 1 MiB. Split the bank or use smaller images/exams.')),
      { status: 413 }
    );
  if (store === 'banks') {
    const errors = validateBank(row.data);
    if (errors.length) throw new Error(errors.slice(0, 20).join('\n'));
    if (
      row.id !== row.data.bank.id ||
      typeof row.enabled !== 'boolean' ||
      !Number.isFinite(row.importedAt) ||
      !isRecord(row.assets || {})
    )
      throw new Error(t('Bank metadata does not match the bank'));
    if (jsonBytes(row.data) > LIMITS.bank)
      throw Object.assign(new Error(t('Bank JSON exceeds 512 KiB.')), { status: 413 });
    for (const [path, asset] of Object.entries(row.assets || {})) {
      if (
        !safePath(path) ||
        !isRecord(asset) ||
        typeof asset.data !== 'string' ||
        !['image/svg+xml', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
          asset.mime
        )
      )
        invalid(400, 'Invalid image.');
      let size;
      try {
        size =
          asset.mime === 'image/svg+xml'
            ? new TextEncoder().encode(asset.data).length
            : atob(asset.data).length;
      } catch {
        invalid(400, 'Invalid image encoding.');
      }
      if (size > LIMITS.image) invalid(413, 'Image exceeds 256 KiB.');
    }
  }
  if (store === 'states') {
    if (
      typeof row.bankId !== 'string' ||
      typeof row.questionId !== 'string' ||
      row.id !== JSON.stringify([row.bankId, row.questionId])
    )
      throw new Error(t('Invalid question-state identity'));
    for (const field of [
      'repetitions',
      'interval',
      'due',
      'lastReviewed',
      'timesSeen',
      'correctCount',
      'incorrectCount',
      'updatedAt'
    ])
      if (row[field] !== undefined && (!Number.isFinite(row[field]) || row[field] < 0))
        throw new Error(t`states.${field}: expected nonnegative number`);
    if (typeof row.flagged !== 'boolean' || !Number.isFinite(row.updatedAt))
      throw new Error(t('State requires flagged and updatedAt'));
    for (const f of ['skipped', 'lastObjectiveCorrect'])
      if (row[f] !== undefined && typeof row[f] !== 'boolean')
        throw new Error(t`states.${f}: expected boolean`);
  }
  if (store === 'attempts' || store === 'active') {
    if (
      !Array.isArray(row.items) ||
      !row.items.length ||
      row.items.length > 1000 ||
      !Number.isFinite(row.startedAt) ||
      !isRecord(row.config)
    )
      throw new Error(t('Invalid saved exam'));
    if (
      !Number.isFinite(row.config.duration) ||
      row.config.duration < 0 ||
      row.config.duration > 1440 ||
      !Array.isArray(row.config.warnings) ||
      row.config.warnings.length > 1024 ||
      row.config.warnings.some((n) => !Number.isFinite(n) || n < 0 || n > 1440) ||
      typeof row.config.timer !== 'boolean' ||
      typeof row.config.changes !== 'boolean' ||
      typeof row.config.explanations !== 'boolean'
    )
      throw new Error(t('Invalid saved exam configuration'));
    if (row.config.timer && (!Number.isFinite(row.deadline) || row.deadline < row.startedAt))
      throw new Error(t('Invalid exam deadline'));
    if (!Number.isInteger(row.index) || row.index < 0 || row.index >= row.items.length)
      throw new Error(t('Invalid saved exam index'));
    if (store === 'attempts' && !Number.isFinite(row.completedAt))
      throw new Error(t('Completed attempt needs a completion timestamp'));
    if (store === 'active' && row.id !== 'current') throw new Error(t('Invalid active exam key'));
    if (
      store === 'active' &&
      (typeof row.attemptId !== 'string' || !row.attemptId || row.attemptId.length > 100)
    )
      throw new Error(t('Active exam needs a stable attempt ID'));
    if (
      row.warned !== undefined &&
      (!Array.isArray(row.warned) || row.warned.some((n) => !Number.isFinite(n) || n < 0))
    )
      throw new Error(t('Invalid timer-warning state'));
    for (const item of row.items) {
      if (
        !isRecord(item) ||
        typeof item.bankId !== 'string' ||
        !isRecord(item.question) ||
        typeof item.bankVersion !== 'string'
      )
        throw new Error(t('Invalid exam question snapshot'));
      const q = item.question;
      const shell = {
        schemaVersion: '1.0',
        bank: {
          id: item.bankId,
          title: 'Snapshot',
          language: 'en',
          version: item.bankVersion,
          topics: [
            {
              id: q.topicId,
              title: 'Snapshot',
              subtopics: q.subtopicId ? [{ id: q.subtopicId, title: 'Snapshot' }] : []
            }
          ]
        },
        questions: [q]
      };
      const errors = validateBank(shell);
      if (errors.length) throw new Error(errors.slice(0, 10).join('\n'));
      if (
        !Array.isArray(item.selected) ||
        item.selected.some((id) => !(q.options || []).some((o) => o.id === id)) ||
        new Set(item.selected).size !== item.selected.length ||
        (item.text !== undefined && (typeof item.text !== 'string' || item.text.length > 100000))
      )
        throw new Error(t('Invalid saved answer'));
      if ((q.type === 'single_choice' || q.selectionMode === 'single') && item.selected.length > 1)
        throw new Error(t('Single choice has several saved answers'));
      for (const f of ['skipped', 'flagged', 'visited', 'locked', 'reveal'])
        if (item[f] !== undefined && typeof item[f] !== 'boolean')
          throw new Error(t`exam item.${f}: expected boolean`);
      if (item.selfAssessment !== undefined && !['know', 'repeat'].includes(item.selfAssessment))
        throw new Error(t('Invalid self-assessment'));
    }
  }
  if (store === 'settings') {
    if (!['preferences', 'storage-check'].includes(row.id))
      throw new Error(t('Invalid setting record'));
    if (row.id === 'preferences') {
      if (
        !['system', 'light', 'dark'].includes(row.theme) ||
        (row.language !== undefined && !languages.includes(row.language)) ||
        !['strict', 'partial', 'both'].includes(row.scoring) ||
        typeof row.explanations !== 'boolean' ||
        typeof row.warnings !== 'string' ||
        row.warnings.length > 1024 ||
        !/^\s*\d+(\.\d+)?(\s*,\s*\d+(\.\d+)?)*\s*$/.test(row.warnings) ||
        row.warnings.split(',').some((n) => Number(n) > 1440)
      )
        throw new Error(t('Invalid preferences'));
      for (const f of [
        'initialRepeat',
        'initialKnow',
        'minimumInterval',
        'maximumInterval',
        'multiplier'
      ])
        if (!Number.isFinite(row[f]) || row[f] <= 0)
          throw new Error(t`settings.${f}: must be positive`);
      if (
        row.maximumInterval < row.minimumInterval ||
        row.maximumInterval > 5256000 ||
        row.multiplier < 1 ||
        row.multiplier > 10
      )
        throw new Error(t('Settings outside supported limits'));
    }
  }
  if (
    store === 'history' &&
    (typeof row.bankId !== 'string' ||
      typeof row.questionId !== 'string' ||
      !Number.isFinite(row.at) ||
      !['know', 'repeat', 'skip'].includes(row.response))
  )
    throw new Error(t('Invalid study-history event'));

  return row;
}
