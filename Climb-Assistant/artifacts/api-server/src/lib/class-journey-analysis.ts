import { createHash } from "crypto";
import { compareClimbSnapshots, compareFinalAnswers, finalAnswerFromSnapshot } from "./development-analysis";
import { aggregateThinkingChoices, analyseThinkingChoices, type ThinkingChoiceEventLike } from "./thinking-choice-analysis";

export const CLASS_JOURNEY_ANALYSIS_VERSION = 1;
const JOURNEY_STAGES = ["MAP", "TORCH", "RESEARCH", "COMPASS", "EMBED"] as const;

type InsightRecord = Record<string, unknown>;

export type ClassJourneyStudentRecord = {
  sessionId: number;
  studentName: string;
  studentInsights: Record<string, unknown>;
  snapshots: Array<any>;
  answerFeedbackAttempts: unknown[];
  formativeFeedbackActionedStages: string[];
  activity: {
    sessions: number;
    seconds: number;
    afterFormative: boolean;
  };
  thinkingChoiceEvents?: ThinkingChoiceEventLike[];
};

function record(value: unknown): InsightRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as InsightRecord : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function countByStatus(values: unknown[]) {
  const counts: Record<string, number> = {};
  for (const value of values) {
    if (typeof value === "string" && value.trim()) counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function hasInsight(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function compactText(value: unknown, max = 500): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function feedbackStatuses(insight: InsightRecord, phase: "formative" | "ai") {
  if (phase === "formative") {
    const breakdown = record(insight.progressBreakdown);
    return [
      ...list(breakdown.addressed).map(() => "addressed"),
      ...list(breakdown.partlyAddressed).map(() => "partly_addressed"),
      ...list(breakdown.stillToDevelop).map(() => "still_to_develop"),
    ];
  }
  const response = record(insight.responseToAiFeedback);
  return [
    ...list(response.feedbackOneConclusions).map((item) => record(item).status),
    ...list(response.feedbackTwoConclusions).map((item) => record(item).status),
  ];
}

function snapshotOf(snapshots: Array<any>, kind: string) {
  return snapshots.find((snapshot) => snapshot.snapshotKind === kind);
}

function answerEvidenceAvailable(recordValue: ClassJourneyStudentRecord): boolean {
  const finalisation = snapshotOf(recordValue.snapshots, "answer_assessment_finalisation");
  const finalAnswer = finalisation ? finalAnswerFromSnapshot(finalisation) : null;
  const attempts = recordValue.answerFeedbackAttempts.filter((attempt) => {
    const item = record(attempt);
    return typeof item.answerSnapshot === "string" && item.answerSnapshot.trim();
  });
  return Boolean(finalAnswer?.trim()) && attempts.length >= 1;
}

export function buildClassJourneyEvidence(records: ClassJourneyStudentRecord[]) {
  const evidenceRecords = records.map((student) => {
    const formative = record(student.studentInsights.formative);
    const summative = record(student.studentInsights.summative);
    const formativeSnapshot = snapshotOf(student.snapshots, "climb_formative");
    const summativeSnapshot = snapshotOf(student.snapshots, "climb_summative");
    const comparison = compareClimbSnapshots(formativeSnapshot, summativeSnapshot);
    const answerEvidence = answerEvidenceAvailable(student);
    const sufficient = hasInsight(student.studentInsights.formative)
      && hasInsight(student.studentInsights.summative)
      && comparison.available;
    const formativeStatuses = feedbackStatuses(summative, "formative");
    const aiStatuses = feedbackStatuses(summative, "ai");
    const formativeConclusions = list(summative.formativeFeedbackConclusions).map(record);
    const actionedFeedbackStatuses = (student.formativeFeedbackActionedStages ?? []).map((stage) => {
      const conclusion = formativeConclusions.find((item) => item.feedbackStage === stage);
      return typeof conclusion?.status === "string" ? conclusion.status : "not_enough_evidence";
    });
    return {
      sessionId: student.sessionId,
      studentName: student.studentName,
      hasFormativeInsight: hasInsight(student.studentInsights.formative),
      hasSummativeInsight: hasInsight(student.studentInsights.summative),
      hasFormativeSnapshot: Boolean(formativeSnapshot),
      hasSummativeSnapshot: Boolean(summativeSnapshot),
      hasAnswerEvidence: answerEvidence,
      sufficient,
      changedStages: (comparison.changedStages ?? []) as string[],
      changedStageDetails: comparison.changedStageDetails ?? [],
      unchangedStages: (comparison.unchangedStages ?? []) as string[],
      answerFeedbackOne: list(record(summative.responseToAiFeedback).feedbackOneConclusions),
      answerFeedbackTwo: list(record(summative.responseToAiFeedback).feedbackTwoConclusions),
      formativeStatuses,
      aiStatuses,
      actionedFeedbackStatuses,
      activity: student.activity,
      formativeSummary: compactText(formative.summary, 300),
      summativeFollowUp: compactText(summative.formativeFollowUp, 400),
      thinkingChoices: analyseThinkingChoices(student.thinkingChoiceEvents ?? []),
      thinkingChoiceEvents: student.thinkingChoiceEvents ?? [],
    };
  });

  const comparable = evidenceRecords.filter((item) => item.sufficient);
  const changedStageCounts = Object.fromEntries(
    JOURNEY_STAGES.map((stage) => [
      stage,
      comparable.filter((item) => item.changedStages.includes(stage)).length,
    ]),
  );
  const unchangedStageCounts = Object.fromEntries(
    JOURNEY_STAGES.map((stage) => [
      stage,
      comparable.filter((item) => item.unchangedStages.includes(stage)).length,
    ]),
  );
  const formativeStatusCounts = countByStatus(comparable.flatMap((item) => item.formativeStatuses));
  const aiStatusCounts = countByStatus(comparable.flatMap((item) => item.aiStatuses));
  const answerFeedbackOneCount = comparable.filter((item) => item.answerFeedbackOne.length > 0).length;
  const answerFeedbackTwoCount = comparable.filter((item) => item.answerFeedbackTwo.length > 0).length;
  const studentsWithActivityAfterFormative = comparable.filter((item) => item.activity.afterFormative).length;
  const actionedFeedbackStatuses = evidenceRecords.flatMap((item) => item.actionedFeedbackStatuses);
  const actionedFeedbackDenominator = actionedFeedbackStatuses.length;
  const feedbackMarkedAsActioned = {
    total: actionedFeedbackDenominator,
    relatedLaterChange: actionedFeedbackStatuses.filter((status) => status === "acted_upon").length,
    partialRelatedLaterChange: actionedFeedbackStatuses.filter((status) => status === "partly_acted_upon").length,
    noRelatedChangeFound: actionedFeedbackStatuses.filter((status) => status === "no_related_change").length,
    insufficientEvidence: actionedFeedbackStatuses.filter((status) =>
      !["acted_upon", "partly_acted_upon", "no_related_change"].includes(status),
    ).length,
    denominator: actionedFeedbackDenominator,
  };
  const thinkingChoices = aggregateThinkingChoices(records.map((record) => ({ events: record.thinkingChoiceEvents })));

  const evidenceCoverage = {
    totalStudents: records.length,
    studentsWithFormativeInsight: evidenceRecords.filter((item) => item.hasFormativeInsight).length,
    studentsWithSummativeInsight: evidenceRecords.filter((item) => item.hasSummativeInsight).length,
    studentsWithBothInsights: evidenceRecords.filter((item) => item.hasFormativeInsight && item.hasSummativeInsight).length,
    studentsWithComparableClimbEvidence: comparable.length,
    studentsWithAnswerEvidence: evidenceRecords.filter((item) => item.hasAnswerEvidence).length,
    awaitingComparableEvidence: records.length - comparable.length,
    denominator: comparable.length,
  };

  const evidenceLimitations = [
    evidenceCoverage.awaitingComparableEvidence > 0
      ? `${evidenceCoverage.awaitingComparableEvidence} of ${evidenceCoverage.totalStudents} students do not yet have both saved Student Insights and comparable preserved formative/summative work.`
      : "",
    evidenceCoverage.studentsWithAnswerEvidence < comparable.length
      ? `Final-answer feedback evidence is available for ${evidenceCoverage.studentsWithAnswerEvidence} of ${comparable.length} comparable students.`
      : "",
    "Recorded activity is contextual interaction inside the Climb, not a measure of time spent, effort, learning or attainment.",
    "The report identifies correspondence in recorded evidence and cannot establish causation.",
  ].filter(Boolean);

  const qualitativeEvidence = {
    denominator: comparable.length,
    changedStageCounts,
    unchangedStageCounts,
    formativeFeedbackStatuses: formativeStatusCounts,
    aiFeedbackStatuses: aiStatusCounts,
    studentsWithAiFeedbackOne: answerFeedbackOneCount,
    studentsWithAiFeedbackTwo: answerFeedbackTwoCount,
    studentsWithActivityAfterFormative,
    comparableStudentRecords: comparable.map((item) => ({
      changedStages: item.changedStages,
      unchangedStages: item.unchangedStages,
      formativeStatuses: item.formativeStatuses,
      aiStatuses: item.aiStatuses,
      hasAnswerEvidence: item.hasAnswerEvidence,
      activityAfterFormative: item.activity.afterFormative,
      formativeSummary: item.formativeSummary,
      summativeFollowUp: item.summativeFollowUp,
      thinkingChoices: item.thinkingChoices,
    })),
  };

  return {
    version: CLASS_JOURNEY_ANALYSIS_VERSION,
    evidenceCoverage,
    formativeToSummativeChanges: {
      studentsCompared: comparable.length,
      changedStageCounts,
      unchangedStageCounts,
    },
    responseToFormativeFeedback: {
      studentsCompared: comparable.length,
      statusCounts: formativeStatusCounts,
    },
    feedbackMarkedAsActioned,
    responseToAiFeedback: {
      studentsCompared: comparable.length,
      statusCounts: aiStatusCounts,
      studentsWithFeedbackOne: answerFeedbackOneCount,
      studentsWithFeedbackTwo: answerFeedbackTwoCount,
    },
    activityContext: {
      studentsCompared: comparable.length,
      studentsWithActivityAfterFormative,
      totalRecordedSessions: comparable.reduce((sum, item) => sum + item.activity.sessions, 0),
      totalRecordedSeconds: comparable.reduce((sum, item) => sum + item.activity.seconds, 0),
      note: "Recorded activity is contextual and is not treated as progress.",
    },
    thinkingChoicesAcrossClass: thinkingChoices,
    qualitativeEvidence,
    evidenceLimitations,
  };
}

export function classJourneySourceHash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}