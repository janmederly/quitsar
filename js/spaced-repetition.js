import { createEmptyCard, fsrs, Rating, State } from './vendor/ts-fsrs.js';

export const defaults = Object.freeze({
  theme: 'system',
  // Retained in saved preferences so older v1 backups remain valid.
  initialRepeat: 10,
  initialKnow: 1440,
  minimumInterval: 10,
  multiplier: 2,
  maximumInterval: 259200,
  desiredRetention: 90,
  warnings: '10,5,1',
  explanations: true,
  scoring: 'both'
});
export const keyFor = (bankId, questionId) => JSON.stringify([bankId, questionId]);

function scheduler(settings) {
  return fsrs({
    request_retention: (settings.desiredRetention ?? defaults.desiredRetention) / 100,
    maximum_interval: Math.max(
      1,
      Math.floor((settings.maximumInterval ?? defaults.maximumInterval) / 1440)
    ),
    enable_fuzz: false,
    learning_steps: ['10m'],
    relearning_steps: ['10m']
  });
}

function cardFor(previous, now) {
  if (previous?.fsrs) return { ...previous.fsrs };
  const card = createEmptyCard(new Date(now));
  if (!previous?.repetitions) return card;
  // Migrate only when the learner next answers. Existing due dates and history
  // remain untouched. Legacy intervals approximate stability at 90% recall;
  // difficulty starts neutral because the binary scheduler did not track it.
  const interval = previous.interval || defaults.initialKnow;
  return {
    ...card,
    due: new Date(previous.due ?? now),
    last_review: new Date(
      previous.lastReviewed ?? Math.max(0, (previous.due ?? now) - interval * 60000)
    ),
    stability: Math.max(0.1, interval / 1440),
    difficulty: 5,
    scheduled_days: interval / 1440,
    reps: previous.repetitions,
    state: previous.lastResponse === 'repeat' ? State.Relearning : State.Review
  };
}

export function schedule(previous, response, settings = defaults, now = Date.now()) {
  if (!['know', 'repeat'].includes(response)) throw new Error('Expected Know or Repeat');
  const old = previous || {};
  const { card } = scheduler(settings).next(
    cardFor(old, now),
    new Date(now),
    response === 'repeat' ? Rating.Again : Rating.Good
  );
  return {
    ...old,
    fsrs: {
      ...card,
      due: card.due.getTime(),
      last_review: card.last_review.getTime()
    },
    interval: (card.due.getTime() - now) / 60000,
    repetitions: (old.repetitions || 0) + 1,
    due: card.due.getTime(),
    lastReviewed: now,
    lastResponse: response,
    timesSeen: (old.timesSeen || 0) + 1,
    updatedAt: now
  };
}

// Preview and commit use the same deterministic scheduler, without mutating state.
export function previewSchedule(previous, settings = defaults, now = Date.now()) {
  return Object.fromEntries(
    ['repeat', 'know'].map((response) => [response, schedule(previous, response, settings, now)])
  );
}

export function matchesQueue(state, queue, now = Date.now()) {
  switch (queue) {
    case 'due':
      return !!state?.due && state.due <= now;
    case 'new':
      return !state?.timesSeen;
    case 'flagged':
      return !!state?.flagged;
    case 'incorrect':
      return state?.lastObjectiveCorrect === false;
    case 'skipped':
      return !!state?.skipped;
    default:
      return true;
  }
}
