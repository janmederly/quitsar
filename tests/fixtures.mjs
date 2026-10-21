import { defaults } from '../js/spaced-repetition.js';
import { readFile } from 'node:fs/promises';
const demo = JSON.parse(await readFile(new URL('../banks/demo.json', import.meta.url), 'utf8'));
export const preferences = (extra = {}) => ({
  ...defaults,
  id: 'preferences',
  updatedAt: 1,
  ...extra
});
export const historyRecord = (id, extra = {}) => ({
  id,
  bankId: demo.bank.id,
  questionId: demo.questions[0].id,
  at: 1,
  response: 'know',
  ...extra
});
export const stateRecord = (extra = {}) => ({
  id: JSON.stringify([demo.bank.id, demo.questions[0].id]),
  bankId: demo.bank.id,
  questionId: demo.questions[0].id,
  flagged: false,
  updatedAt: 1,
  ...extra
});
export const examRecord = (extra = {}) => ({
  id: 'current',
  attemptId: 'exam1',
  startedAt: 1,
  index: 0,
  config: {
    duration: 30,
    warnings: [],
    timer: false,
    changes: true,
    explanations: true,
    scoring: 'both'
  },
  items: [
    {
      bankId: demo.bank.id,
      bankVersion: demo.bank.version,
      question: demo.questions[0],
      selected: []
    }
  ],
  ...extra
});
