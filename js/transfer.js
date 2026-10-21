import { t } from './i18n.js';
import * as db from './storage.js';
import { isRecord, safePath } from './validation.js';
import { validateRecord } from './records.js';
import { readAsset } from './assets.js';
import { download, modal, el, button } from './dom.js';
import { jsonBytes } from './limits.js';
import { scoreQuestion, summarize } from './scoring.js';
export function attemptJson(attempt) {
  return {
    ...attempt,
    summary: summarize(attempt),
    items: attempt.items.map((item) => ({
      ...item,
      score: scoreQuestion(item.question, item.selected)
    }))
  };
}
// Every part is a normal v1 backup, independently valid and atomically merged.
// Leave room for change wrappers used by the 24 MiB staged-restore protocol.
export function backupParts(records, { maxBytes = 16 * 1024 * 1024, maxRecords = 100000 } = {}) {
  const parts = [];
  const exportedAt = Date.now();
  const empty = () => ({ format: 'quitsar-backup', version: 1, exportedAt, records: {} });
  let part = empty();
  let bytes = jsonBytes(part);
  let count = 0;
  const finish = () => {
    parts.push(part);
    part = empty();
    bytes = jsonBytes(part);
    count = 0;
  };
  // Place banks before their study data, and completed attempts before active exams.
  for (const store of ['banks', 'settings', 'states', 'history', 'attempts', 'active']) {
    for (const row of records[store] || []) {
      validateRecord(store, row);
      const size = jsonBytes(row) + 1;
      const overhead = () => (part.records[store] ? 0 : jsonBytes(store) + 4);
      if (count && (bytes + size + overhead() > maxBytes || count >= maxRecords)) finish();
      if (bytes + size + overhead() > maxBytes)
        throw new Error(t('Record is too large for a backup part.'));
      bytes += size + overhead();
      (part.records[store] ||= []).push(row);
      count++;
    }
  }
  if (count || !parts.length) finish();
  return parts;
}
export async function exportBackup(studyOnly = false) {
  const stores = studyOnly
    ? ['states', 'history']
    : ['banks', 'states', 'attempts', 'history', 'settings', 'active'];
  const records = {};
  for (const store of stores) records[store] = await db.all(store);
  const parts = backupParts(records);
  const prefix = studyOnly ? 'quitsar-study' : 'quitsar-backup';
  if (parts.length === 1) return download(prefix + '.json', JSON.stringify(parts[0]));
  modal(
    t('Download backup parts'),
    el('p', {}, t('Download every part and restore them in order. Each part merges separately.')),
    ...parts.map((part, index) =>
      button(
        t`Download part ${index + 1} of ${parts.length}`,
        () =>
          download(
            `${prefix}-${String(index + 1).padStart(3, '0')}-of-${parts.length}.json`,
            JSON.stringify(part)
          ),
        'secondary'
      )
    )
  );
}
export function attemptCsv(attempt) {
  const rows = [
    [
      'attempt_id',
      'bank_id',
      'bank_version',
      'question_id',
      'type',
      'topic',
      'subtopic',
      'difficulty',
      'prompt',
      'selected_ids',
      'written_answer',
      'correct_ids',
      'strict',
      'partial',
      'skipped',
      'flagged',
      'self_assessment'
    ]
  ];
  for (const i of attempt.items) {
    const q = i.question;
    const score = scoreQuestion(q, i.selected);
    rows.push([
      attempt.id,
      i.bankId,
      i.bankVersion,
      q.id,
      q.type,
      i.topicTitle,
      i.subtopicTitle,
      q.difficulty,
      q.prompt,
      (i.selected || []).join('|'),
      i.text,
      (q.options || [])
        .filter((o) => o.isCorrect)
        .map((o) => o.id)
        .join('|'),
      score?.strict,
      score?.partial,
      i.skipped,
      i.flagged,
      i.selfAssessment
    ]);
  }
  // Prevent spreadsheet formula injection while preserving a standard quoted CSV.
  return rows
    .map((row) =>
      row
        .map((v) => {
          let s = String(v ?? '');
          if (/^[\t\r\n]|^\s*[=+\-@]/.test(s)) s = "'" + s;
          return '"' + s.replaceAll('"', '""') + '"';
        })
        .join(',')
    )
    .join('\r\n');
}
export async function validateBackup(data) {
  if (
    !isRecord(data) ||
    data.format !== 'quitsar-backup' ||
    data.version !== 1 ||
    !isRecord(data.records)
  )
    throw new Error(t('Expected a quitsar backup version 1.'));
  const allowed = new Set(db.STORES);
  const result = {};
  let count = 0;
  for (const [store, rows] of Object.entries(data.records)) {
    if (!allowed.has(store) || !Array.isArray(rows))
      throw new Error(t`records.${store}: unsupported store or invalid array`);
    const seen = new Set();
    result[store] = [];
    for (const row of rows) {
      if (!isRecord(row) || typeof row.id !== 'string' || row.id.length > 400 || seen.has(row.id))
        throw new Error(t`${store}: invalid or duplicate record ID`);
      seen.add(row.id);
      if (++count > 150000) throw new Error(t('Backup exceeds 150,000 records.'));
      validateRecord(store, row);
      if (store === 'banks') {
        if (
          row.id !== row.data.bank.id ||
          typeof row.enabled !== 'boolean' ||
          !Number.isFinite(row.importedAt)
        )
          throw new Error(t('Bank metadata does not match the bank'));
        const assets = {};
        if (!isRecord(row.assets || {})) throw new Error(t('Invalid bank assets'));
        for (const [path, asset] of Object.entries(row.assets || {})) {
          if (
            !safePath(path) ||
            !isRecord(asset) ||
            typeof asset.data !== 'string' ||
            asset.data.length > 17000000
          )
            throw new Error(t('Invalid image in backup'));
          let blob;
          if (asset.mime === 'image/svg+xml') blob = new Blob([asset.data]);
          else if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(asset.mime)) {
            try {
              blob = new Blob([Uint8Array.from(atob(asset.data), (c) => c.charCodeAt(0))]);
            } catch {
              throw new Error(t('Invalid image encoding'));
            }
          } else throw new Error(t('Unsupported image MIME type'));
          assets[path] = await readAsset(blob, path);
        }
        result[store].push({ ...row, assets });
        continue;
      }
      result[store].push(row);
    }
  }
  return result;
}
export function mergePlan(incoming, existing) {
  const changes = [];
  const stats = { added: 0, updated: 0, skipped: 0, bankConflicts: 0 };
  for (const [store, rows] of Object.entries(incoming)) {
    const current = new Map((existing[store] || []).map((r) => [r.id, r]));
    for (const row of rows) {
      const old = current.get(row.id);
      if (
        store === 'active' &&
        [...(existing.attempts || []), ...(incoming.attempts || [])].some(
          (a) => a.id === row.attemptId
        )
      ) {
        stats.skipped++;
        continue;
      }
      // Bank content and active sessions never silently replace an existing identity.
      if (old && (store === 'banks' || store === 'active')) {
        stats.skipped++;
        if (store === 'banks') stats.bankConflicts++;
        continue;
      }
      const stamp = (r) => r.updatedAt || r.completedAt || r.at || r.importedAt || 0;
      if (old && stamp(row) <= stamp(old)) {
        stats.skipped++;
        continue;
      }
      stats[old ? 'updated' : 'added']++;
      changes.push({ store, value: row });
    }
  }
  return { changes, stats };
}
