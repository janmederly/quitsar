import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateBank, safePath } from '../js/validation.js';
import { scoreQuestion, summarize } from '../js/scoring.js';
import {
  defaults,
  schedule,
  keyFor,
  previewSchedule,
  matchesQueue
} from '../js/spaced-repetition.js';
import { validateBackup, mergePlan, attemptCsv } from '../js/transfer.js';
const demo = JSON.parse(await readFile(new URL('../banks/demo.json', import.meta.url), 'utf8'));
const multi = demo.questions.find((q) => q.type === 'multiple_choice');
const open = demo.questions.find((q) => q.type === 'open_ended');
const single = demo.questions.find((q) => q.type === 'single_choice');
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
  assert.ok(
    e.some((s) => s.includes(`question ${demo.questions[0].id}`) && s.includes('.topicId'))
  );
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
  b.questions[0].options[1].isCorrect = true;
  b.questions[0].options[0].rationale = '';
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
  b.questions[0].options[1].id = b.questions[0].options[0].id;
  assert.ok(validateBank(b).some((e) => e.includes('duplicate option')));
});
test('strict and bounded partial scoring examples', () => {
  assert.deepEqual(scoreQuestion(multi, ['cell-wall', 'chloroplast']), {
    strict: 1,
    partial: 1,
    tp: 2,
    fp: 0
  });
  assert.equal(scoreQuestion(multi, ['cell-wall']).partial, 0.5);
  assert.equal(scoreQuestion(multi, ['cell-wall', 'nucleus']).partial, 0);
  assert.equal(scoreQuestion(multi, ['cell-wall', 'chloroplast', 'nucleus']).partial, 0.5);
  assert.equal(scoreQuestion(multi, []).strict, 0);
  assert.equal(scoreQuestion(multi, ['nucleus', 'membrane']).partial, 0);
  assert.equal(scoreQuestion(multi, ['cell-wall', 'cell-wall']).partial, 0.5);
});
test('single select is always binary; open-ended ungraded', () => {
  const single = demo.questions.find((q) => q.type === 'single_choice');
  assert.equal(scoreQuestion(single, ['mitochondrion']).partial, 1);
  assert.equal(scoreQuestion(single, ['mitochondrion', 'nucleus']).partial, 0);
  assert.equal(scoreQuestion(open, []), null);
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
  assert.equal(scoreQuestion(single, ['nucleus']).strict, 1);
  assert.equal(scoreQuestion(multiple, ['membrane']).partial, 0.5);
});
test('summaries exclude open answers and handle malicious grouping labels', () => {
  const q = { ...multi, topicId: 'constructor' };
  const r = summarize({
    items: [
      { question: q, selected: ['cell-wall'], topicTitle: '__proto__' },
      { question: open, text: 'My answer' }
    ]
  });
  assert.equal(r.objective, 1);
  assert.equal(r.open, 1);
  assert.equal(r.partial, 0.5);
  assert.equal(r.groups.topic.__proto__.count, 1);
  assert.equal({}.count, undefined);
});
test('FSRS starts learning, previews intervals without writes, and preserves counters', () => {
  const now = 1700000000000;
  const old = { flagged: true, correctCount: 3 };
  const before = structuredClone(old);
  const preview = previewSchedule(old, defaults, now);
  assert.deepEqual(old, before);
  assert.equal(preview.repeat.due, now + 600000);
  assert.ok(preview.know.interval >= 1440);
  const learned = schedule(old, 'know', defaults, now);
  assert.deepEqual(learned, preview.know);
  assert.equal(learned.fsrs.state, 2);
  assert.equal(learned.fsrs.reps, 1);
  assert.equal(learned.correctCount, 3);
  assert.equal(learned.flagged, true);
  assert.equal(learned.timesSeen, 1);
  assert.equal(keyFor('a:b', 'c'), JSON.stringify(['a:b', 'c']));
});
test('FSRS relearns forgotten mature questions in minutes and grows successful intervals', () => {
  const now = 1700000000000;
  const first = schedule(null, 'know', defaults, now);
  const second = schedule(first, 'know', defaults, first.due);
  assert.ok(second.interval > first.interval);
  const forgotten = schedule(second, 'repeat', defaults, second.due);
  assert.equal(forgotten.interval, 10);
  assert.equal(forgotten.fsrs.state, 3);
  assert.equal(forgotten.fsrs.lapses, 1);
  const relearned = schedule(forgotten, 'know', defaults, forgotten.due);
  assert.equal(relearned.fsrs.state, 2);
  assert.ok(relearned.interval >= 1440);
});
test('retention, maximum interval, and elapsed review time affect FSRS scheduling', () => {
  const now = 1700000000000;
  const first = schedule(null, 'know', defaults, now);
  assert.ok(
    schedule(null, 'know', { ...defaults, desiredRetention: 97 }, now).interval < first.interval
  );
  assert.equal(schedule(null, 'know', { ...defaults, maximumInterval: 1440 }, now).interval, 1440);
  const onTime = schedule(first, 'know', defaults, first.due);
  const overdue = schedule(first, 'know', defaults, first.due + 30 * 86400000);
  assert.notEqual(onTime.fsrs.stability, overdue.fsrs.stability);
  const restored = JSON.parse(JSON.stringify(first));
  assert.deepEqual(schedule(restored, 'know', defaults, first.due), onTime);
});
test('legacy progress migrates on the next answer without mutating the original state', () => {
  const now = 1700000000000;
  const old = {
    repetitions: 8,
    interval: 64 * 1440,
    lastReviewed: now - 64 * 86400000,
    due: now,
    timesSeen: 9,
    flagged: true,
    correctCount: 6
  };
  const before = structuredClone(old);
  const next = schedule(old, 'repeat', defaults, now);
  assert.deepEqual(old, before);
  assert.equal(next.interval, 10);
  assert.equal(next.fsrs.reps, 9);
  assert.equal(next.timesSeen, 10);
  assert.equal(next.flagged, true);
  assert.equal(next.correctCount, 6);
});
test('review groups overlap and skip does not classify a question as incorrect', () => {
  const now = 1700000000000;
  const state = {
    due: now,
    flagged: true,
    skipped: true,
    timesSeen: 1,
    lastObjectiveCorrect: false
  };
  for (const queue of ['due', 'flagged', 'skipped', 'incorrect'])
    assert.equal(matchesQueue(state, queue, now), true);
  assert.equal(matchesQueue(state, 'new', now), false);
  assert.equal(matchesQueue({ skipped: true, timesSeen: 1 }, 'incorrect', now), false);
  assert.equal(matchesQueue({ ...state, due: now + 1 }, 'due', now), false);
  assert.equal(matchesQueue({ flagged: true }, 'new', now), true);
});
test('FSRS progress survives backups and rejects malformed scheduler data', async () => {
  const state = {
    ...schedule(null, 'know', defaults, 1700000000000),
    id: keyFor('biology', 'cell'),
    bankId: 'biology',
    questionId: 'cell',
    flagged: false
  };
  const backup = (row) => ({ format: 'quitsar-backup', version: 1, records: { states: [row] } });
  assert.deepEqual(
    (await validateBackup(JSON.parse(JSON.stringify(backup(state))))).states[0],
    state
  );
  for (const changes of [
    { stability: -1 },
    { difficulty: 11 },
    { due: state.due + 1 },
    { reps: 0.5 },
    { state: 5 },
    { last_review: null }
  ])
    await assert.rejects(
      validateBackup(backup({ ...state, fsrs: { ...state.fsrs, ...changes } })),
      /Invalid spaced repetition state/
    );
  const legacy = { ...state };
  delete legacy.fsrs;
  await validateBackup(backup(legacy));
  const preferences = { ...defaults, id: 'preferences', updatedAt: 1 };
  const settingsBackup = (row) => ({
    format: 'quitsar-backup',
    version: 1,
    records: { settings: [row] }
  });
  for (const value of [0, 69, 98, '90', null])
    await assert.rejects(
      validateBackup(settingsBackup({ ...preferences, desiredRetention: value })),
      /Desired retention/
    );
  // Legacy interval fields cannot block saving a language/theme preference
  // after the new retention default is merged into an old settings record.
  await validateBackup(
    settingsBackup({ ...preferences, minimumInterval: 10000, maximumInterval: 1440 })
  );
  await validateBackup(settingsBackup({ ...preferences, maximumInterval: 600 }));
  delete preferences.desiredRetention;
  await validateBackup(settingsBackup(preferences));
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
        selected: ['cell-wall'],
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
    question: single,
    selected: ['mitochondrion'],
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

test('published import guide describes every field and its example imports all four types', async () => {
  const schema = JSON.parse(
    await readFile(new URL('../assets/question-bank.schema.json', import.meta.url), 'utf8')
  );
  const example = JSON.parse(
    await readFile(new URL('../assets/question-bank.example.json', import.meta.url), 'utf8')
  );
  assert.deepEqual(validateBank(example), []);
  assert.deepEqual(
    new Set(example.questions.map((q) => q.type)),
    new Set(['open_ended', 'single_choice', 'multiple_choice', 'image_recognition'])
  );
  assert.ok(new TextEncoder().encode(JSON.stringify(example)).length <= 512 * 1024);
  function inspect(node) {
    if (!node || typeof node !== 'object') return;
    if (node.description)
      for (const [name, rule] of Object.entries(node.properties || {}))
        assert.ok(rule.description?.trim(), `Missing description: ${name}`);
    if (node.$ref) assert.ok(schema.$defs[node.$ref.replace('#/$defs/', '')], node.$ref);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(inspect);
      else if (value && typeof value === 'object') inspect(value);
    }
  }
  inspect(schema);
});
