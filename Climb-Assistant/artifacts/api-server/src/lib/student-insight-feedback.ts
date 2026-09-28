const STUDENT_INSIGHT_STATUS_LABELS: Record<string, string> = {
  acted_upon: "Acted upon",
  partly_acted_upon: "Partly acted upon",
  no_related_change: "No related change found",
  not_enough_evidence: "Not enough evidence",
  teacher_review_needed: "Teacher review needed",
  no_action_requested: "No action requested",
};

export type StudentInsightAnswerResponse = {
  feedbackOnePoints: Array<{ id: string; text: string }>;
  feedbackTwoPoints: Array<{ id: string; text: string }>;
  evidenceReferences: Array<{ id: string; excerpt: string }>;
};

export function joinStudentInsightResponse(response: any, answerResponse: StudentInsightAnswerResponse) {
  const join = (key: "feedbackOneConclusions" | "feedbackTwoConclusions", points: Array<{ id: string; text: string }>) => {
    if (points.length === 0) return [];
    return Array.isArray(response?.[key]) ? response[key]
      .filter((item: any) => points.some((point) => point.id === item?.feedbackPointId))
      .map((item: any) => ({
        feedbackPointId: item.feedbackPointId,
        feedbackPoint: points.find((point) => point.id === item.feedbackPointId)?.text ?? "",
        status: STUDENT_INSIGHT_STATUS_LABELS[item.status] ?? "Not enough evidence",
        evidenceReferenceIds: Array.isArray(item.evidenceReferenceIds) ? item.evidenceReferenceIds : [],
        evidenceReferences: (Array.isArray(item.evidenceReferenceIds) ? item.evidenceReferenceIds : [])
          .map((id: string) => answerResponse.evidenceReferences.find((reference) => reference.id === id))
          .filter(Boolean),
        conclusion: item.conclusion,
      })) : [];
  };
  return {
    afterFeedbackOneSummary: response?.afterFeedbackOneSummary ?? "",
    feedbackOneConclusions: join("feedbackOneConclusions", answerResponse.feedbackOnePoints),
    afterFeedbackTwoSummary: response?.afterFeedbackTwoSummary ?? "",
    feedbackTwoConclusions: join("feedbackTwoConclusions", answerResponse.feedbackTwoPoints),
    overallAnswerDevelopment: response?.overallAnswerDevelopment ?? "",
  };
}

export function hasCompleteStudentInsightFeedbackCoverage(value: unknown, answerResponse: StudentInsightAnswerResponse): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = (value as Record<string, unknown>).responseToAiFeedback;
  if (!response || typeof response !== "object" || Array.isArray(response)) return false;
  const record = response as Record<string, unknown>;
  const idsMatch = (actual: unknown, expected: Array<{ id: string }>) =>
    Array.isArray(actual)
    && actual.length === expected.length
    && new Set(actual.map((item) => item && typeof item === "object" ? (item as Record<string, unknown>).feedbackPointId : null)).size === expected.length
    && expected.every((point) => actual.some((item) => item && typeof item === "object" && (item as Record<string, unknown>).feedbackPointId === point.id));
  return idsMatch(record.feedbackOneConclusions, answerResponse.feedbackOnePoints)
    && idsMatch(record.feedbackTwoConclusions, answerResponse.feedbackTwoPoints);
}