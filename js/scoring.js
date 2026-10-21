// Replace this bounded function to change partial-credit policy everywhere.
export function scoreQuestion(question, selected = []) {
  if (question.type === 'open_ended') return null;
  const correct = new Set(question.options.filter((o) => o.isCorrect).map((o) => o.id));
  const choices = new Set(selected);
  const tp = [...choices].filter((id) => correct.has(id)).length;
  const fp = choices.size - tp;
  const strict = tp === correct.size && fp === 0 ? 1 : 0;
  const single =
    question.type === 'single_choice' ||
    (question.type === 'image_recognition' && question.selectionMode === 'single');
  return {
    strict,
    partial: single ? strict : Math.max(0, Math.min(1, (tp - fp) / correct.size)),
    tp,
    fp
  };
}

export function summarize(attempt) {
  const result = {
    total: attempt.items.length,
    objective: 0,
    open: 0,
    answered: 0,
    skipped: 0,
    flagged: 0,
    strict: 0,
    partial: 0,
    groups: Object.fromEntries(
      ['topic', 'subtopic', 'type', 'difficulty'].map((k) => [k, Object.create(null)])
    )
  };
  for (const item of attempt.items) {
    const q = item.question;
    const answered = q.type === 'open_ended' ? !!item.text?.trim() : !!item.selected?.length;
    if (answered) result.answered++;
    if (item.skipped) result.skipped++;
    if (item.flagged) result.flagged++;
    const score = scoreQuestion(q, item.selected);
    if (!score) {
      result.open++;
      continue;
    }
    result.objective++;
    result.strict += score.strict;
    result.partial += score.partial;
    for (const [kind, value] of Object.entries({
      topic: item.topicTitle || q.topicId,
      subtopic: item.subtopicTitle || q.subtopicId || 'No subtopic',
      type: q.type,
      difficulty: q.difficulty || 'unspecified'
    })) {
      const group = (result.groups[kind][value] ||= { count: 0, strict: 0, partial: 0 });
      group.count++;
      group.strict += score.strict;
      group.partial += score.partial;
    }
  }
  result.unanswered = result.total - result.answered;
  return result;
}
