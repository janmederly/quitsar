import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateBank, safePath } from '../js/validation.js';
import { scoreQuestion, summarize } from '../js/scoring.js';
import { defaults, schedule, keyFor } from '../js/spaced-repetition.js';
import { validateBackup, mergePlan, attemptCsv } from '../js/transfer.js';
const demo = JSON.parse(await readFile(new URL('../banks/demo.json', import.meta.url), 'utf8'));
const multi = demo.questions.find((q) => q.type === 'multiple_choice');
test('complete demo is valid with all four types', () => {
  assert.deepEqual(validateBank(demo), []);
  assert.equal(new Set(demo.questions.map((q) => q.type)).size, 4);
});
test('malformed structures fail without throwing', () => {
  for (const v of [null, [], {}, 1, 'a', { bank: {}, questions: [null] }])
    assert.ok(validateBank(v).length);
});
test('duplicate and unresolved identifiers include exact paths', () => {
  const b = structuredClone(demo);
  b.questions[1].id = b.questions[0].id;
  b.questions[0].topicId = 'missing';
  const e = validateBank(b);
  assert.ok(e.some((s) => s.includes('questions[1].id') && s.includes('duplicate')));
  assert.ok(e.some((s) => s.includes('question math-open-001') && s.includes('.topicId')));
});
test('unsafe image references rejected', () => {
  for (const p of [
    '../a.svg',
    '/etc/a.svg',
    'https://x/a.png',
    'data:image/svg+xml,x',
    'a\\b.svg',
    'a//b.png',
    'a/./b.png',
    '%2e%2e/a.png',
    'a.png?x',
    'a.svg#x',
    'file:///a.png'
  ])
    assert.equal(safePath(p), false, p);
  assert.equal(safePath('images/a-b 1.svg'), true);
});
test('version, option, alt, rationale, dates and type validation', () => {
  const b = structuredClone(demo);
  b.schemaVersion = '2';
  b.bank.updatedAt = '2026-02-30';
  b.questions[0].images[0].alt = '';
  b.questions[1].options[1].isCorrect = true;
  b.questions[1].options[0].rationale = '';
  b.questions[2].type = 'code';
  const e = validateBank(b).join('\n');
  for (const p of [
    'schemaVersion',
    'bank.updatedAt',
    'images[0].alt',
    'exactly one',
    'rationale',
    '.type'
  ])
    assert.ok(e.includes(p), p);
});
test('option IDs are stable and unique', () => {
  const b = structuredClone(demo);
  b.questions[1].options[1].id = b.questions[1].options[0].id;
  assert.ok(validateBank(b).some((e) => e.includes('duplicate option')));
});
test('strict and bounded partial scoring examples', () => {
  assert.deepEqual(scoreQuestion(multi, ['shape', 'border']), {
    strict: 1,
    partial: 1,
    tp: 2,
    fp: 0
  });
  assert.equal(scoreQuestion(multi, ['shape']).partial, 0.5);
  assert.equal(scoreQuestion(multi, ['shape', 'material']).partial, 0);
  assert.equal(scoreQuestion(multi, ['shape', 'border', 'material']).partial, 0.5);
  assert.equal(scoreQuestion(multi, []).strict, 0);
  assert.equal(scoreQuestion(multi, ['material', 'purpose']).partial, 0);
  assert.equal(scoreQuestion(multi, ['shape', 'shape']).partial, 0.5);
});
test('single select is always binary; open-ended ungraded', () => {
  const single = demo.questions.find((q) => q.type === 'single_choice');
  assert.equal(scoreQuestion(single, ['annular']).partial, 1);
  assert.equal(scoreQuestion(single, ['annular', 'linear']).partial, 0);
  assert.equal(scoreQuestion(demo.questions[0], []), null);
});
test('partial score stays bounded for every option subset', () => {
  for (let mask = 0; mask < 16; mask++) {
    const selected = multi.options.filter((_, i) => mask & (1 << i)).map((o) => o.id);
    const s = scoreQuestion(multi, selected);
    assert.ok(s.partial >= 0 && s.partial <= 1);
    assert.ok(s.strict === 0 || s.strict === 1);
  }
});
test('image-recognition single and multiple selection score correctly', () => {
  const single = demo.questions.find(
    (q) => q.type === 'image_recognition' && q.selectionMode === 'single'
  );
  const multiple = demo.questions.find(
    (q) => q.type === 'image_recognition' && q.selectionMode === 'multiple'
  );
  assert.equal(scoreQuestion(single, ['ring']).strict, 1);
  assert.equal(scoreQuestion(multiple, ['membrane']).partial, 0.5);
});
test('summaries exclude open answers and handle malicious grouping labels', () => {
  const q = { ...multi, topicId: 'constructor' };
  const r = summarize({
    items: [
      { question: q, selected: ['shape'], topicTitle: '__proto__' },
      { question: demo.questions[0], text: 'My answer' }
    ]
  });
  assert.equal(r.objective, 1);
  assert.equal(r.open, 1);
  assert.equal(r.partial, 0.5);
  assert.equal(r.groups.topic.__proto__.count, 1);
  assert.equal({}.count, undefined);
});
test('first Repeat and Know intervals and timestamps', () => {
  const now = 100000;
  assert.equal(schedule(null, 'repeat', defaults, now).due, now + 600000);
  assert.equal(schedule(null, 'know', defaults, now).interval, 1440);
});
test('later reviews quarter or multiply interval and respect bounds', () => {
  const first = schedule(null, 'know', defaults, 0);
  assert.equal(schedule(first, 'know', defaults, 0).interval, 2880);
  assert.equal(schedule(first, 'repeat', defaults, 0).interval, 360);
  assert.equal(schedule({ repetitions: 2, interval: 10 }, 'repeat', defaults, 0).interval, 10);
  assert.equal(
    schedule({ repetitions: 2, interval: 259200 }, 'know', defaults, 0).interval,
    259200
  );
});
test('custom settings and counters persist', () => {
  const s = schedule(
    { flagged: true, correctCount: 3 },
    'know',
    { ...defaults, initialKnow: 60 },
    123
  );
  assert.equal(s.interval, 60);
  assert.equal(s.correctCount, 3);
  assert.equal(s.flagged, true);
  assert.equal(s.timesSeen, 1);
  assert.equal(keyFor('a:b', 'c'), JSON.stringify(['a:b', 'c']));
});
test('restore rejects unknown formats, stores, bad states, invalid banks', async () => {
  for (const v of [
    {},
    { format: 'quitsar-backup', version: 1, records: { evil: [] } },
    { format: 'quitsar-backup', version: 1, records: { states: [{ id: 'bad', due: -1 }] } },
    { format: 'quitsar-backup', version: 1, records: { banks: [{ id: 'a', data: {} }] } }
  ])
    await assert.rejects(validateBackup(v));
});
test('study backup validates and merge keeps newest timestamp', async () => {
  const record = {
    id: keyFor('demo', 'q'),
    bankId: 'demo',
    questionId: 'q',
    flagged: false,
    updatedAt: 20
  };
  const incoming = await validateBackup({
    format: 'quitsar-backup',
    version: 1,
    records: { states: [record] }
  });
  const plan = mergePlan(incoming, { states: [{ ...record, updatedAt: 10 }] });
  assert.equal(plan.stats.updated, 1);
  assert.equal(mergePlan(incoming, { states: [record] }).stats.skipped, 1);
});
test('bank and active identity conflicts require explicit separate handling', () => {
  const rows = {
    banks: [{ id: 'demo', updatedAt: 200 }],
    active: [{ id: 'current', updatedAt: 200 }]
  };
  const p = mergePlan(rows, {
    banks: [{ id: 'demo', updatedAt: 1 }],
    active: [{ id: 'current', updatedAt: 1 }]
  });
  assert.equal(p.changes.length, 0);
  assert.equal(p.stats.bankConflicts, 1);
});
test('CSV escapes quotes, lines and spreadsheet formulas', () => {
  const csv = attemptCsv({
    id: 'exam',
    items: [
      {
        question: { ...multi, prompt: '=DANGER("x")\nnext' },
        selected: ['shape'],
        bankId: 'demo',
        bankVersion: '1'
      }
    ]
  });
  assert.ok(csv.includes('"\'=DANGER(""x"")\nnext"'));
  assert.ok(csv.includes('"0.5"'));
});
test('saved attempt backup validates snapshots and rejects unknown answers', async () => {
  const item = {
    bankId: demo.bank.id,
    bankVersion: demo.bank.version,
    question: demo.questions[1],
    selected: ['annular'],
    flagged: false
  };
  const attempt = {
    id: 'exam',
    index: 0,
    startedAt: 1,
    completedAt: 2,
    config: { timer: false, duration: 30, warnings: [1], changes: true, explanations: true },
    items: [item]
  };
  const backup = { format: 'quitsar-backup', version: 1, records: { attempts: [attempt] } };
  await validateBackup(backup);
  item.selected = ['bad'];
  await assert.rejects(validateBackup(backup));
});
test('every bundled module parses and every service-worker asset exists', async () => {
  const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  const paths = [...sw.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean);
  for (const p of paths) {
    const file = new URL('../' + p, import.meta.url);
    await readFile(file);
    if (p.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', fileURLToPath(file)], {
        encoding: 'utf8'
      });
      assert.equal(result.status, 0, result.stderr);
    }
  }
});
