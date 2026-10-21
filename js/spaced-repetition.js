export const defaults = Object.freeze({
  theme: 'system',
  initialRepeat: 10,
  initialKnow: 1440,
  minimumInterval: 10,
  multiplier: 2,
  maximumInterval: 259200,
  warnings: '10,5,1',
  explanations: true,
  scoring: 'both'
});
export const keyFor = (bankId, questionId) => JSON.stringify([bankId, questionId]);
// Intervals are minutes. Repeat quarters an established interval; Know doubles it by default.
export function schedule(previous, response, settings = defaults, now = Date.now()) {
  const old = previous || {};
  const first = !old.repetitions;
  const raw =
    response === 'repeat'
      ? first
        ? settings.initialRepeat
        : (old.interval || settings.initialRepeat) / 4
      : first
        ? settings.initialKnow
        : (old.interval || settings.initialKnow) * settings.multiplier;
  const interval = Math.min(settings.maximumInterval, Math.max(settings.minimumInterval, raw));
  return {
    ...old,
    interval,
    repetitions: (old.repetitions || 0) + 1,
    due: now + interval * 60000,
    lastReviewed: now,
    lastResponse: response,
    timesSeen: (old.timesSeen || 0) + 1,
    updatedAt: now
  };
}
