export type ThinkingChoiceEventLike = {
  researchId?: string;
  classId?: number;
  optionName: string;
  questionId?: string | null;
  eventType: "selected" | "inserted" | "edited" | "submitted" | string;
  occurredAt: Date | string;
  afterFormativeFeedback?: boolean;
  conversationTurn?: number;
  firstUseOrder?: number | null;
};

function percentage(count: number, total: number) {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

export function analyseThinkingChoices(events: ThinkingChoiceEventLike[]) {
  const ordered = [...events].sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());
  const usedEvents = ordered.filter((event) => event.eventType === "submitted");
  const options = Array.from(new Set(usedEvents.map((event) => event.optionName).filter(Boolean)));
  const counts: Record<string, number> = {};
  for (const event of usedEvents) counts[event.optionName] = (counts[event.optionName] ?? 0) + 1;
  const firstUse: string[] = [];
  for (const event of usedEvents) if (!firstUse.includes(event.optionName)) firstUse.push(event.optionName);
  const submittedQuestionIds = new Set(usedEvents.filter((event) => event.questionId).map((event) => event.questionId as string));
  const editedQuestionIds = new Set(
    ordered
      .filter((event) => event.eventType === "edited" && event.questionId && submittedQuestionIds.has(event.questionId))
      .map((event) => event.questionId as string),
  );
  const preFeedback = usedEvents.filter((event) => !event.afterFormativeFeedback).length;
  const postFeedback = usedEvents.filter((event) => event.afterFormativeFeedback).length;
  const transitions = firstUse.slice(1).map((option, index) => ({ from: firstUse[index], to: option }));
  const firstUseTurns = firstUse.map((option) =>
    usedEvents.find((event) => event.optionName === option)?.conversationTurn ?? 0,
  );
  const hadPreFeedbackUse = usedEvents.some((event) => event.afterFormativeFeedback !== true);
  return {
    usedOptionNames: options,
    optionCount: options.length,
    optionCounts: counts,
    mostFrequentOption: options.slice().sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0))[0] ?? null,
    firstUseOrder: firstUse,
    transitions,
    preFeedbackUse: preFeedback,
    postFeedbackUse: postFeedback,
    broadenedAfterFeedback: hadPreFeedbackUse && usedEvents.some((event, index) => (
      event.afterFormativeFeedback === true
      && !usedEvents.slice(0, index).some((prior) => prior.optionName === event.optionName)
    )),
    adaptedQuestionCount: editedQuestionIds.size,
    totalUseEvents: usedEvents.length,
    firstUseTurns,
    immediateMultiOption: firstUseTurns.length > 1 && firstUseTurns[1] - firstUseTurns[0] <= 1,
    gradualMultiOption: firstUseTurns.length > 1 && firstUseTurns[1] - firstUseTurns[0] > 1,
  };
}

export function thinkingChoicesText(events: ThinkingChoiceEventLike[]) {
  const analysis = analyseThinkingChoices(events);
  if (analysis.optionCount === 0) {
    return "You did not use the suggested thinking questions during this TORCH conversation. This does not mean that these forms of thinking were absent from your own questions.";
  }
  const range = analysis.optionCount === 1 ? "one of the four thinking options" : `${analysis.optionCount} of the four thinking options`;
  const frequency = analysis.mostFrequentOption ? ` You used ${analysis.mostFrequentOption} most frequently.` : "";
  const timing = analysis.postFeedbackUse > 0
    ? " Some recorded use occurred after formative feedback."
    : " Recorded use occurred before formative feedback.";
  const adapted = analysis.adaptedQuestionCount > 0
    ? ` ${analysis.adaptedQuestionCount} example question${analysis.adaptedQuestionCount === 1 ? " was" : "s were"} adapted in the student's own words.`
    : "";
  return `You used ${range}.${frequency} Your recorded questions ${analysis.optionCount > 1 ? "showed a range of thinking." : "mainly used one type of thinking."}${timing}${adapted}`;
}

export function aggregateThinkingChoices(records: Array<{ events?: ThinkingChoiceEventLike[] }>) {
  const analyses = records.map((record) => analyseThinkingChoices(record.events ?? []));
  const total = records.length;
  const byOption: Record<string, { students: number; uses: number; averageUse: number }> = {};
  for (const analysis of analyses) {
    for (const [option, uses] of Object.entries(analysis.optionCounts)) {
      byOption[option] ??= { students: 0, uses: 0, averageUse: 0 };
      byOption[option].students += 1;
      byOption[option].uses += uses;
    }
  }
  for (const item of Object.values(byOption)) item.averageUse = total > 0 ? Math.round((item.uses / total) * 100) / 100 : 0;
  const distribution = Object.fromEntries([0, 1, 2, 3, 4].map((count) => {
    const students = analyses.filter((analysis) => analysis.optionCount === count).length;
    return [count, { students, percentage: percentage(students, total) }];
  }));
  const firstChoices: Record<string, number> = {};
  const transitions: Array<{ from: string; to: string }> = [];
  for (const analysis of analyses) {
    const first = analysis.firstUseOrder[0];
    if (first) firstChoices[first] = (firstChoices[first] ?? 0) + 1;
    transitions.push(...analysis.transitions);
  }
  return {
    studentCount: total,
    showPercentages: total >= 5,
    studentsByOptionCount: distribution,
    optionPopularity: byOption,
    mostCommonFirstChoice: Object.entries(firstChoices).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    firstChoiceCounts: firstChoices,
    totalPreFeedbackUse: analyses.reduce((sum, analysis) => sum + analysis.preFeedbackUse, 0),
    totalPostFeedbackUse: analyses.reduce((sum, analysis) => sum + analysis.postFeedbackUse, 0),
    transitions,
    studentsWhoBroadenedAfterFeedback: analyses.filter((analysis) => analysis.broadenedAfterFeedback).length,
    immediateMultiOptionStudents: analyses.filter((analysis) => analysis.immediateMultiOption).length,
    gradualOptionStudents: analyses.filter((analysis) => analysis.gradualMultiOption).length,
    eventExport: records.flatMap((record) => (record.events ?? []).map((event) => ({
      researchId: event.researchId ?? "",
      classId: event.classId ?? null,
      optionName: event.optionName,
      questionId: event.questionId ?? null,
      eventType: event.eventType,
      occurredAt: new Date(event.occurredAt).toISOString(),
      stage: "TORCH",
      conversationTurn: event.conversationTurn ?? 0,
      afterFormativeFeedback: event.afterFormativeFeedback === true,
      firstUseOrder: event.firstUseOrder ?? null,
    }))),
  };
}