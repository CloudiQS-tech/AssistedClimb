import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "crypto";
import { eq, sql, and, desc, lt, gte, ne, asc, inArray, ilike, isNull, isNotNull, or } from "drizzle-orm";
import {
  db,
  teachersTable,
  classesTable,
  studentSessionsTable,
  teacherMessagesTable,
  studentActivitySessionsTable,
  stageEntriesTable,
  chatMessagesTable,
  tasksTable,
  taskTemplatesTable,
  teacherFeedbackTable,
  organisationsTable,
  organisationRetentionDefaultsTable,
  organisationRetentionPoliciesTable,
  teacherRecordArchivesTable,
  teacherRecordDeletionEvidenceTable,
  studentRecordDeletionEvidenceTable,
  studentDataRequestsTable,
  studentDataRequestControlsTable,
  studentDataRequestControlEventsTable,
  studentDataRequestControlKinds,
  studentDataRequestControlReasonCategories,
  studentDataRequestControlAccessLimits,
  studentDataRequestControlProcessingLimits,
  organisationDataRequestProceduresTable,
  organisationDataRequestApprovalsTable,
  organisationDataRequestPublicationsTable,
  auditLogTable,
  developmentSnapshotsTable,
  thinkingChoiceEventsTable,
} from "@workspace/db";
import { logAudit } from "../../lib/audit";
import {
  acquireRetentionPolicyMutationLock,
  DEFAULT_STUDENT_RECORD_RETENTION_DAYS,
  DEFAULT_TEACHER_RECORD_RETENTION_DAYS,
  getRetentionBlockReason,
  RETENTION_CATEGORIES,
  retentionCategoryLabels,
} from "../../lib/organisation-retention";
import { findBlockingStudentDataControl, holdStudentDataControlLock } from "../../lib/student-data-request-controls";
import { ARCHIVE_EXPIRY_WARNING_DAYS, getOrganisationLifecycleDays, getPlatformRetentionDefaults } from "../../lib/archive-retention";
import { recordDeletionTombstones } from "../../lib/deletion-ledger";
import { requireTeacher } from "../../middlewares/teacherAuth";
import { hashPasswordResetToken, resetTeacherTotpAndSessionsInTransaction, terminateTeacherSessions } from "../../lib/teacher-security";
import { synthesiseAssessment, synthesiseClassInsights, synthesiseClassActivityInsights, synthesiseStudentActivityInsights, synthesiseStudentInsight, synthesiseClassJourneyAnalysis, generateFormativeFeedback, generateSummativePerStage, generateTaskSuggestion, parseAnswerFeedback, generateDevelopmentAnalysis, developmentProviderEvidence, isCurrentDevelopmentAnalysisReport, StudentInsightTruncationError, STUDENT_INSIGHT_PROMPT_VERSION, type AnswerFeedback, type OrgAiConfig } from "../../lib/ai";
import { encrypt, maskApiKey, decrypt } from "../../lib/crypto";
import { getTaskDeadlineState, isValidTaskDueDate, withTaskDeadlineState } from "../../lib/task-deadline";
import { admitTaskResearchRequest } from "../../lib/task-research-admission";
import { renderStudentDataExportPdf } from "../../lib/student-data-export-pdf";
import { renderDevelopmentAnalysisPdf } from "../../lib/development-analysis-pdf";
import { renderStudentInsightPdf } from "../../lib/student-insight-pdf";
import { buildDevelopmentEvidence, buildDevelopmentClassAggregate, buildStudentInsightActivityComparison, compareClimbSnapshots, compareFinalAnswers, finalAnswerFromSnapshot } from "../../lib/development-analysis";
import { buildClassJourneyEvidence, classJourneySourceHash, type ClassJourneyStudentRecord } from "../../lib/class-journey-analysis";
import { renderClassJourneyAnalysisPdf } from "../../lib/class-journey-analysis-pdf";
import { renderTeacherMessagesPdf } from "../../lib/teacher-messages-pdf";
import { hasCompleteStudentInsightFeedbackCoverage, joinStudentInsightResponse } from "../../lib/student-insight-feedback";
import { finalAnswerReadableText } from "../../lib/final-answer-format";
import { renderTextExportPdf } from "../../lib/text-export-pdf";
import { analyseThinkingChoices, thinkingChoicesText } from "../../lib/thinking-choice-analysis";

function formatDateOnly(value: string): string {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

import { z } from "zod/v4";
import {
  CreateClassBody,
  UpdateClassBody,
  ListClassesResponseItem,
  GetClassParams,
  GetClassResponse,
  ListClassStudentsParams,
  ListClassStudentsResponseItem,
  GetStudentDetailParams,
  GetStudentDetailResponse,
  GetStudentStagesResponseItem,
  GetClassTaskParams,
  UpsertClassTaskParams,
  UpsertClassTaskBody,
  GetClassTaskResponse,
  UpsertClassTaskResponse,
  DeleteClassParams,
  ListTeacherArchiveResponse,
  ResetStudentPinParams,
  ApproveStudentRegistrationParams,
  ApproveStudentRegistrationResponse,
  RejectStudentRegistrationParams,
  RejectStudentRegistrationResponse,
  DeleteRejectedStudentRegistrationParams,
  GetTeacherStudentActivityParams,
  GetTeacherStudentActivityResponse,
  ListOrganisationTeachersResponse,
  GetTeacherDashboardOverviewResponse,
  ListTaskTemplatesResponseItem,
  CreateTaskTemplateBody,
  CreateTaskTemplateResponse,
  UpdateTaskTemplateParams,
  UpdateTaskTemplateBody,
  UpdateTaskTemplateResponse,
  DeleteTaskTemplateParams,
  DuplicateTaskTemplateParams,
  DuplicateTaskTemplateResponse,
  ApplyTaskTemplateParams,
  ApplyTaskTemplateBody,
  ApplyTaskTemplateResponse,
  BulkReviewStudentRegistrationsParams,
  BulkReviewStudentRegistrationsBody,
  BulkReviewStudentRegistrationsResponse,
  GenerateClassTaskSuggestionParams,
  GenerateClassTaskSuggestionBody,
  GenerateClassTaskSuggestionResponse,
  SendTeacherMessageParams,
  ListTeacherStudentMessagesParams,
  SendTeacherMessageBody,
  SendTeacherMessageResponse,
  ListTeacherStudentMessagesResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.post(
  "/teacher/export/pdf",
  requireTeacher,
  async (req, res): Promise<void> => {
    const title = typeof req.body?.title === "string" ? req.body.title : "";
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!title.trim() || !text.trim()) {
      res.status(400).json({ error: "A report title and content are required." });
      return;
    }

    try {
      const pdf = await renderTextExportPdf({ title, text });
      res
        .type("application/pdf")
        .set("Content-Disposition", 'attachment; filename="assisted-climb-report.pdf"')
        .send(pdf);
    } catch (error) {
      req.log.error({ err: error }, "Teacher PDF export failed");
      res.status(500).json({ error: "The PDF could not be prepared." });
    }
  },
);
const SCHOOL_AUDIT_REPORT_EXPORTED = "organisation.security_audit_report_exported";
const SCHOOL_AUDIT_REPORT_LIMIT = 500;
const DETAILED_ARCHIVE_ACCESS_ACTIONS = new Set([
  "teacher.archived_student_record_viewed",
  "teacher.archived_records_exported",
]);
const SUMMATIVE_FEEDBACK_STAGES = ["MAP", "TORCH", "COMPASS", "RESEARCH", "EMBED"] as const;

type StoredClassInsight = Record<string, unknown> & { generatedAt: string };

function normaliseClassInsightsHistory(
  history: unknown,
  lastInsights: unknown,
  lastInsightsAt: Date | null,
): StoredClassInsight[] {
  if (Array.isArray(history)) {
    const stored = history.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.generatedAt !== "string") return [];
      return [record as StoredClassInsight];
    });
    if (stored.length > 0) return stored;
  }

  if (lastInsights && typeof lastInsights === "object" && !Array.isArray(lastInsights)) {
    return [{
      ...(lastInsights as Record<string, unknown>),
      generatedAt: lastInsightsAt?.toISOString() ?? new Date(0).toISOString(),
    }];
  }

  return [];
}

const ANSWER_FEEDBACK_LIMIT = 2;
type TeacherAnswerFeedbackAttempt = {
  answerSnapshot: string;
  feedback: AnswerFeedback;
  createdAt: string;
};

type ClimbSnapshotPayload = {
  stageEntries: unknown[];
  chatMessages: unknown[];
  feedback: unknown[];
};

async function loadClimbSnapshotPayload(executor: any, sessionId: number): Promise<ClimbSnapshotPayload> {
  const [stageEntries, chatMessages, feedback] = await Promise.all([
    executor.select().from(stageEntriesTable).where(eq(stageEntriesTable.sessionId, sessionId)).orderBy(asc(stageEntriesTable.stage)),
    executor.select().from(chatMessagesTable).where(eq(chatMessagesTable.sessionId, sessionId)).orderBy(asc(chatMessagesTable.createdAt)),
    executor.select().from(teacherFeedbackTable).where(eq(teacherFeedbackTable.sessionId, sessionId)).orderBy(asc(teacherFeedbackTable.stage)),
  ]);
  return { stageEntries, chatMessages, feedback };
}

async function runDevelopmentAnalysis(
  classId: number,
  sessionId: number,
  organisationId: number | null | undefined,
): Promise<{
  kind: "ready" | "existing" | "failed" | "not-found" | "not-eligible";
  report: ReturnType<typeof developmentAnalysisResponse> | null;
}> {
  const [session] = await db.select({
    id: studentSessionsTable.id,
    classId: studentSessionsTable.classId,
    archivedAt: studentSessionsTable.archivedAt,
    deletionScheduledFor: studentSessionsTable.deletionScheduledFor,
    answerFeedbackAttempts: studentSessionsTable.answerFeedbackAttempts,
    developmentAnalysisReport: studentSessionsTable.developmentAnalysisReport,
    developmentAnalysisGeneratedAt: studentSessionsTable.developmentAnalysisGeneratedAt,
    developmentAnalysisSourceHash: studentSessionsTable.developmentAnalysisSourceHash,
    developmentAnalysisStatus: studentSessionsTable.developmentAnalysisStatus,
    developmentAnalysisError: studentSessionsTable.developmentAnalysisError,
  }).from(studentSessionsTable).where(and(
    eq(studentSessionsTable.id, sessionId),
    eq(studentSessionsTable.classId, classId),
    isNull(studentSessionsTable.deletionScheduledFor),
  ));
  if (!session || session.archivedAt) return { kind: "not-found", report: null };

  const snapshots = await db.select().from(developmentSnapshotsTable)
    .where(eq(developmentSnapshotsTable.sessionId, sessionId))
    .orderBy(asc(developmentSnapshotsTable.createdAt));
  // A report is a one-time record of the finalised assessment. Do not allow
  // analysis to start from a legacy lock or a partial snapshot set.
  if (!snapshots.some((snapshot) => snapshot.snapshotKind === "climb_summative")
      || !snapshots.some((snapshot) => snapshot.snapshotKind === "answer_assessment_finalisation")) {
    return { kind: "not-eligible", report: null };
  }
  const attempts = persistedTeacherAnswerFeedbackAttempts(session.answerFeedbackAttempts);
  const activity = await db.select({
    startedAt: studentActivitySessionsTable.startedAt,
    lastSeenAt: studentActivitySessionsTable.lastSeenAt,
    endedAt: studentActivitySessionsTable.endedAt,
    activeStage: studentActivitySessionsTable.activeStage,
    pageDurations: studentActivitySessionsTable.pageDurations,
  }).from(studentActivitySessionsTable)
    .where(eq(studentActivitySessionsTable.studentSessionId, sessionId))
    .orderBy(asc(studentActivitySessionsTable.startedAt));
  const packageResult = buildDevelopmentEvidence(snapshots, attempts, activity);

  const marker = await db.transaction(async (tx) => {
    const [current] = await tx.select({
      report: studentSessionsTable.developmentAnalysisReport,
      generatedAt: studentSessionsTable.developmentAnalysisGeneratedAt,
      sourceHash: studentSessionsTable.developmentAnalysisSourceHash,
      status: studentSessionsTable.developmentAnalysisStatus,
      error: studentSessionsTable.developmentAnalysisError,
    }).from(studentSessionsTable)
      .where(eq(studentSessionsTable.id, sessionId))
      .for("update");
    if (!current) return { kind: "not-found" as const };
    if ((current.report && isCurrentDevelopmentAnalysisReport(current.report)) || current.status === "pending") {
      return {
        kind: "existing" as const,
        current: {
          developmentAnalysisReport: current.report,
          developmentAnalysisGeneratedAt: current.generatedAt,
          developmentAnalysisSourceHash: current.sourceHash,
          developmentAnalysisStatus: current.status,
          developmentAnalysisError: current.error,
        },
      };
    }
    await tx.update(studentSessionsTable).set({
      developmentAnalysisStatus: "pending",
      developmentAnalysisError: null,
      developmentAnalysisSourceHash: packageResult.sourceHash,
    }).where(eq(studentSessionsTable.id, sessionId));
    return { kind: "marked" as const };
  });
  if (marker.kind === "not-found") return { kind: "not-found", report: null };
  if (marker.kind === "existing") {
    return { kind: "existing", report: developmentAnalysisResponse(marker.current) };
  }

  let generated: Awaited<ReturnType<typeof generateDevelopmentAnalysis>>;
  try {
    const [organisation] = await db.select({
      aiProvider: organisationsTable.aiProvider,
      aiKeyEncrypted: organisationsTable.aiKeyEncrypted,
      azureEndpoint: organisationsTable.azureEndpoint,
      aiDataProcessingAcknowledged: organisationsTable.aiDataProcessingAcknowledged,
      aiDataRetentionNoTrainingConfirmed: organisationsTable.aiDataRetentionNoTrainingConfirmed,
      aiSchoolPoliciesConfirmed: organisationsTable.aiSchoolPoliciesConfirmed,
      aiDataProcessingRegion: organisationsTable.aiDataProcessingRegion,
    }).from(organisationsTable)
      .where(organisationId ? eq(organisationsTable.id, organisationId) : sql`false`);
    generated = await generateDevelopmentAnalysis(developmentProviderEvidence(packageResult.evidence), organisation ?? null);
  } catch {
    const [failed] = await db.update(studentSessionsTable).set({
      developmentAnalysisStatus: "failed",
      developmentAnalysisError: "AI development analysis is unavailable. Try again.",
    }).where(and(
      eq(studentSessionsTable.id, sessionId),
      eq(studentSessionsTable.developmentAnalysisSourceHash, packageResult.sourceHash),
    )).returning({
      developmentAnalysisReport: studentSessionsTable.developmentAnalysisReport,
      developmentAnalysisGeneratedAt: studentSessionsTable.developmentAnalysisGeneratedAt,
      developmentAnalysisSourceHash: studentSessionsTable.developmentAnalysisSourceHash,
      developmentAnalysisStatus: studentSessionsTable.developmentAnalysisStatus,
      developmentAnalysisError: studentSessionsTable.developmentAnalysisError,
    });
    return {
      kind: "failed",
      report: failed ? developmentAnalysisResponse(failed) : null,
    };
  }

  const generatedAt = new Date();
  const [saved] = await db.update(studentSessionsTable).set({
    developmentAnalysisReport: generated as unknown as Record<string, unknown>,
    developmentAnalysisGeneratedAt: generatedAt,
    developmentAnalysisSourceHash: packageResult.sourceHash,
    developmentAnalysisStatus: "ready",
    developmentAnalysisError: null,
  }).where(and(
    eq(studentSessionsTable.id, sessionId),
    eq(studentSessionsTable.developmentAnalysisSourceHash, packageResult.sourceHash),
  )).returning({
    developmentAnalysisReport: studentSessionsTable.developmentAnalysisReport,
    developmentAnalysisGeneratedAt: studentSessionsTable.developmentAnalysisGeneratedAt,
    developmentAnalysisSourceHash: studentSessionsTable.developmentAnalysisSourceHash,
    developmentAnalysisStatus: studentSessionsTable.developmentAnalysisStatus,
    developmentAnalysisError: studentSessionsTable.developmentAnalysisError,
  });
  return {
    kind: "ready",
    report: saved ? developmentAnalysisResponse(saved) : null,
  };
}

function buildDevelopmentAnalysis(
  snapshots: Array<{ id: number; snapshotKind: string; payload: Record<string, unknown>; triggerEvent: string; teacherId: number | null; createdAt: Date }>,
  attempts: TeacherAnswerFeedbackAttempt[],
) {
  const formative = snapshots.find((snapshot) => snapshot.snapshotKind === "climb_formative");
  const summative = snapshots.find((snapshot) => snapshot.snapshotKind === "climb_summative");
  const finalAnswerSnapshot = snapshots.find((snapshot) => snapshot.snapshotKind === "answer_assessment_finalisation");
  const answers = [
    attempts[0]?.answerSnapshot ?? null,
    attempts[1]?.answerSnapshot ?? null,
    finalAnswerSnapshot ? finalAnswerFromSnapshot(finalAnswerSnapshot as any) : null,
  ];
  const answerVersions = [
    { version: 1, answer: answers[0], feedback: attempts[0]?.feedback ?? null, createdAt: attempts[0]?.createdAt ?? null, label: "Final answer version 1" },
    { version: 2, answer: answers[1], feedback: attempts[1]?.feedback ?? null, createdAt: attempts[1]?.createdAt ?? null, label: "Final answer version 2" },
    {
      version: 3,
      answer: answers[2],
      feedback: null,
      createdAt: finalAnswerSnapshot?.createdAt ?? null,
      label: "Final answer version 3 — Answer at assessment finalisation",
    },
  ].filter((item) => item.answer !== null || (item.version === 3 && finalAnswerSnapshot));
  return {
    snapshots: snapshots.map(({ id, snapshotKind, payload, triggerEvent, teacherId, createdAt }) => ({
      id, snapshotKind, payload, triggerEvent, teacherId, createdAt,
    })),
    comparisons: {
      climb: compareClimbSnapshots(formative as any, summative as any),
      finalAnswers: [
        { version: 1, answer: answers[0], label: "Final answer version 1" },
        { version: 2, answer: answers[1], label: "Final answer version 2" },
        {
          version: 3,
          answer: answers[2],
          label: "Final answer version 3 — Answer at assessment finalisation",
          explanation: "This is the final answer that was present when the teacher finalised the assessment.",
        },
      ].filter((item) => item.answer !== null || (item.version === 3 && finalAnswerSnapshot)),
      answerComparison: compareFinalAnswers(answers[0], answers[1]),
      answerComparisons: [
        { fromVersion: 1, toVersion: 2, ...compareFinalAnswers(answers[0], answers[1]) },
        { fromVersion: 2, toVersion: 3, ...compareFinalAnswers(answers[1], answers[2]) },
      ].filter((comparison) => comparison.available),
        cumulativeAnswerComparison: {
          fromVersion: 1,
          toVersion: 3,
          ...compareFinalAnswers(answers[0], answers[2]),
        },
    },
    answerVersions,
    preservedEvidence: {
      snapshots: snapshots.map(({ id, snapshotKind, payload, triggerEvent, teacherId, createdAt }) => ({
        id, snapshotKind, payload, triggerEvent, teacherId, createdAt,
      })),
      answerVersions,
    },
  };
}

function persistedTeacherAnswerFeedbackAttempts(value: unknown): TeacherAnswerFeedbackAttempt[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, ANSWER_FEEDBACK_LIMIT).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.answerSnapshot !== "string" || typeof record.createdAt !== "string") return [];
    try {
      return [{
        answerSnapshot: record.answerSnapshot.slice(0, 50_000),
        feedback: parseAnswerFeedback(JSON.stringify(record.feedback)),
        createdAt: record.createdAt,
      }];
    } catch {
      return [];
    }
  });
}

function exportTeacherAnswerFeedbackAttempts(value: unknown): TeacherAnswerFeedbackAttempt[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.answerSnapshot !== "string" || typeof record.createdAt !== "string") return [];
    try {
      return [{
        answerSnapshot: record.answerSnapshot,
        feedback: parseAnswerFeedback(JSON.stringify(record.feedback)),
        createdAt: record.createdAt,
      }];
    } catch {
      return [];
    }
  });
}

/**
 * Formative feedback is part of the immutable formative snapshot.  The live
 * teacher-feedback rows are intentionally not used for a summative insight:
 * they may have been edited after the formative point.
 */
function preservedFormativeFeedback(snapshot: {
  payload: unknown;
} | undefined): Array<{ stage: string; comment: string; updatedAt: string | null }> {
  const payload = snapshot?.payload;
  const rows = payload && typeof payload === "object" && !Array.isArray(payload)
    && Array.isArray((payload as Record<string, unknown>).feedback)
    ? (payload as Record<string, unknown>).feedback as unknown[]
    : [];
  return rows.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const stage = typeof row.stage === "string" ? row.stage : "";
    const comment = typeof row.formativeComment === "string" ? row.formativeComment.trim() : "";
    if (!stage || !comment) return [];
    const updatedAt = row.updatedAt instanceof Date
      ? row.updatedAt.toISOString()
      : typeof row.updatedAt === "string" ? row.updatedAt : null;
    return [{ stage, comment, updatedAt }];
  });
}

function compactFeedbackPoints(feedback: AnswerFeedback | null, prefix: string): Array<{ id: string; text: string }> {
  const points = feedback?.nextSteps?.length ? feedback.nextSteps : feedback?.areasForDevelopment ?? [];
  return points.filter((point) => typeof point === "string" && point.trim())
    .slice(0, 8)
    .map((text, index) => ({ id: `${prefix}-${index + 1}`, text: text.trim().slice(0, 800) }));
}

function compactEvidenceReferences(comparisons: Array<{
  from: string;
  to: string;
  available: boolean;
  changed: boolean;
  addedWords?: string[];
  removedWords?: string[];
  laterText?: string;
}>) {
  const excerpt = (value: string | undefined) => {
    const text = value?.replace(/\s+/g, " ").trim() ?? "";
    if (!text) return "";
    if (text.length <= 180) return text;
    const boundary = text.lastIndexOf(" ", 177);
    return `${text.slice(0, boundary > 80 ? boundary : 177).trim()}…`;
  };
  return comparisons.filter((comparison) => comparison.available).map((comparison, index) => ({
    id: `answer-comparison-${index + 1}`,
    excerpt: !comparison.changed
      ? `From ${comparison.from} to ${comparison.to}, the preserved answer remained unchanged.`
      : [
        `From ${comparison.from} to ${comparison.to}, the later preserved answer reads: “${excerpt(comparison.laterText)}”.`,
        comparison.removedWords?.length
          ? `Earlier wording no longer present included “${comparison.removedWords.slice(0, 8).join(" ")}”.`
          : "",
      ].filter(Boolean).join(" "),
  }));
}

function refreshStudentInsightEvidence(
  insights: unknown,
  attemptsValue: unknown,
  finalAnswer: string | null,
) {
  if (!insights || typeof insights !== "object" || Array.isArray(insights)) return insights;
  const record = insights as Record<string, any>;
  const summative = record.summative;
  if (!summative || typeof summative !== "object" || Array.isArray(summative) || !summative.responseToAiFeedback) return insights;
  const attempts = persistedTeacherAnswerFeedbackAttempts(attemptsValue);
  const references = compactEvidenceReferences([
    { from: "answer one", to: "answer two", laterText: attempts[1]?.answerSnapshot ?? "", ...compareFinalAnswers(attempts[0]?.answerSnapshot ?? null, attempts[1]?.answerSnapshot ?? null) },
    { from: "answer two", to: "the final answer", laterText: finalAnswer ?? "", ...compareFinalAnswers(attempts[1]?.answerSnapshot ?? null, finalAnswer) },
    { from: "answer one", to: "the final answer", laterText: finalAnswer ?? "", ...compareFinalAnswers(attempts[0]?.answerSnapshot ?? null, finalAnswer) },
  ]);
  const refresh = (items: unknown) => Array.isArray(items) ? items.map((item) => ({
    ...item,
    evidenceReferences: (Array.isArray(item?.evidenceReferenceIds) ? item.evidenceReferenceIds : [])
      .map((id: string) => references.find((reference) => reference.id === id))
      .filter(Boolean),
  })) : items;
  return {
    ...record,
    summative: {
      ...summative,
      responseToAiFeedback: {
        ...summative.responseToAiFeedback,
        feedbackOneConclusions: refresh(summative.responseToAiFeedback.feedbackOneConclusions),
        feedbackTwoConclusions: refresh(summative.responseToAiFeedback.feedbackTwoConclusions),
      },
    },
  };
}

function progressSinceFormativeInsight(
  insights: unknown,
  formativeSnapshot: any,
  summativeSnapshot: any,
) {
  if (!insights || typeof insights !== "object" || Array.isArray(insights)) return insights;
  const record = insights as Record<string, any>;
  const formative = record.formative;
  const summative = record.summative;
  if (!formative || !summative || typeof formative !== "object" || typeof summative !== "object") return insights;
  if (/From the Formative Insight generated/i.test(summative.formativeFollowUp ?? "")) return insights;
  const comparison = compareClimbSnapshots(formativeSnapshot, summativeSnapshot);
  const strengths = Array.isArray(formative.strengths) ? formative.strengths.slice(0, 1).join(" ") : "No formative strengths were recorded.";
  const needs = Array.isArray(formative.nextSteps) ? formative.nextSteps.slice(0, 2).join(" ") : "No formative development needs were recorded.";
  const changed = comparison.changedStages?.length ? comparison.changedStages.join(", ") : "no Climb stages";
  const unchanged = comparison.unchangedStages?.length ? comparison.unchangedStages.join(", ") : "none recorded";
  const unresolved = Array.isArray(summative.nextSteps) ? summative.nextSteps.slice(0, 2).join(" ") : "Further teacher review is needed.";
  const generated = formative.generatedAt ? new Date(formative.generatedAt).toLocaleString("en-GB") : "an unrecorded time";
  return {
    ...record,
    summative: {
      ...summative,
      formativeFollowUp: `From the Formative Insight generated ${generated}, the main strengths included: ${strengths} The identified development needs included: ${needs} In the preserved Summative Climb, changes were recorded in ${changed}; stages remaining unchanged were ${unchanged}. ${summative.formativeFollowUp ?? "The available evidence does not establish which needs were addressed."} Needs still unresolved or requiring further evidence include: ${unresolved}`,
    },
  };
}

function attachStudentInsightActivityComparison(
  insights: unknown,
  formativeSnapshot: any,
  summativeSnapshot: any,
  activityRows: any[],
  totalMessages: unknown[],
  feedbackRounds: number | null,
) {
  if (!insights || typeof insights !== "object" || Array.isArray(insights)) return insights;
  const record = insights as Record<string, any>;
  if (!record.summative || typeof record.summative !== "object" || Array.isArray(record.summative)) return insights;
  return {
    ...record,
    summative: {
      ...record.summative,
      activityComparison: buildStudentInsightActivityComparison(
        formativeSnapshot,
        summativeSnapshot,
        activityRows,
        totalMessages,
        feedbackRounds,
        typeof record.formative?.generatedAt === "string" ? record.formative.generatedAt : null,
      ),
    },
  };
}

function hasVerifiedSummativeStudentInsight(value: unknown, answerResponse: {
  feedbackOnePoints: Array<{ id: string }>;
  feedbackTwoPoints: Array<{ id: string }>;
}): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = (value as Record<string, unknown>).responseToAiFeedback;
  if (!response || typeof response !== "object" || Array.isArray(response)) return false;
  const record = response as Record<string, unknown>;
  const insightRecord = value as Record<string, unknown>;
  const requiredText = ["afterFeedbackOneSummary", "afterFeedbackTwoSummary", "overallAnswerDevelopment"];
  const requiredInsightText = ["summary", "howItCameTogether", "formativeFollowUp"];
  const conclusionStatuses = ["Acted upon", "Partly acted upon", "No related change found", "Not enough evidence", "Teacher review needed", "No action requested"];
  const validConclusions = (value: unknown, expectedPoints: Array<{ id: string }>) => {
    if (!Array.isArray(value) || value.length !== expectedPoints.length) return false;
    const points = value.map((item) => item && typeof item === "object" && !Array.isArray(item) && typeof (item as Record<string, unknown>).feedbackPointId === "string"
      ? (item as Record<string, unknown>).feedbackPointId as string
      : "");
    return new Set(points).size === points.length
      && value.every((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const conclusion = item as Record<string, unknown>;
      return typeof conclusion.feedbackPointId === "string" && Boolean(conclusion.feedbackPointId.trim())
        && typeof conclusion.feedbackPoint === "string" && Boolean(conclusion.feedbackPoint.trim())
        && Array.isArray(conclusion.evidenceReferenceIds)
        && Array.isArray(conclusion.evidenceReferences)
        && typeof conclusion.conclusion === "string" && Boolean(conclusion.conclusion.trim())
        && typeof conclusion.status === "string" && conclusionStatuses.includes(conclusion.status)
        && !/[.!?]\s+[A-Z]/.test(conclusion.conclusion);
      });
  };
  return requiredText.every((key) => typeof record[key] === "string" && Boolean((record[key] as string).trim()))
    && requiredInsightText.every((key) => typeof insightRecord[key] === "string" && Boolean((insightRecord[key] as string).trim()))
    && Array.isArray(insightRecord.nextSteps) && insightRecord.nextSteps.length > 0
    && Array.isArray(insightRecord.cautions) && insightRecord.cautions.length > 0
    && validConclusions(record.feedbackOneConclusions, answerResponse.feedbackOnePoints)
    && validConclusions(record.feedbackTwoConclusions, answerResponse.feedbackTwoPoints);
}

function developmentAnalysisResponse(session: {
  developmentAnalysisReport: Record<string, unknown> | null;
  developmentAnalysisStatus: string | null;
  developmentAnalysisGeneratedAt: Date | null;
  developmentAnalysisSourceHash: string | null;
  developmentAnalysisError: string | null;
}) {
  const validReport = isCurrentDevelopmentAnalysisReport(session.developmentAnalysisReport);
  return {
    report: session.developmentAnalysisReport,
    status: session.developmentAnalysisReport && !validReport
      ? "requires_regeneration"
      : validReport
      ? "ready"
      : session.developmentAnalysisStatus ?? "missing",
    generatedAt: session.developmentAnalysisGeneratedAt,
    sourceHash: session.developmentAnalysisSourceHash,
    error: session.developmentAnalysisError,
  };
}

const auditReportQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  action: z.string().trim().min(1).max(160).optional(),
  teacherId: z.preprocess(
    (value) => value === "" || value === undefined ? undefined : value,
    z.coerce.number().int().positive().optional(),
  ),
});

type AuditReportFilters = z.infer<typeof auditReportQuery>;

const teacherDirectoryQuery = z.object({
  q: z.string().trim().max(120).optional().default(""),
  status: z.enum(["all", "active", "suspended", "deleted"]).optional().default("active"),
  approvalStatus: z.enum(["all", "pending", "approved", "rejected"]).optional().default("all"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sort: z.enum(["name", "createdAt", "status"]).optional().default("name"),
  direction: z.enum(["asc", "desc"]).optional().default("asc"),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});

type TeacherDirectoryFilters = z.infer<typeof teacherDirectoryQuery>;

const RejectTeacherApprovalBody = z.object({
  reason: z.string().trim().min(1).max(1000),
});

function parseUtcDate(value: string, label: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new Error(`${label} must be a valid date`);
  }
  return date;
}

function getAuditReportDateRange(filters: AuditReportFilters) {
  const from = filters.from ? parseUtcDate(filters.from, "From date") : undefined;
  const to = filters.to ? parseUtcDate(filters.to, "To date") : undefined;
  if (from && to && from > to) {
    throw new Error("From date must be on or before the to date");
  }
  const toExclusive = to ? new Date(to.getTime() + 24 * 60 * 60 * 1000) : undefined;
  return { from, toExclusive };
}

function getTeacherDirectoryDateRange(filters: TeacherDirectoryFilters) {
  const from = filters.from ? parseUtcDate(filters.from, "From date") : undefined;
  const to = filters.to ? parseUtcDate(filters.to, "To date") : undefined;
  if (from && to && from > to) {
    throw new Error("From date must be on or before the to date");
  }
  const toExclusive = to ? new Date(to.getTime() + 24 * 60 * 60 * 1000) : undefined;
  return { from, toExclusive };
}

function getAuditReportWhere(organisationId: number, filters: AuditReportFilters) {
  const { from, toExclusive } = getAuditReportDateRange(filters);
  const conditions = [
    eq(auditLogTable.organisationId, organisationId),
    ne(auditLogTable.action, SCHOOL_AUDIT_REPORT_EXPORTED),
  ];
  if (from) conditions.push(gte(auditLogTable.createdAt, from));
  if (toExclusive) conditions.push(lt(auditLogTable.createdAt, toExclusive));
  if (filters.action) conditions.push(eq(auditLogTable.action, filters.action));
  if (filters.teacherId) conditions.push(eq(auditLogTable.teacherId, filters.teacherId));
  return and(...conditions);
}

function serialiseArchiveAccessAuditMetadata(action: string, metadata: unknown) {
  if (!DETAILED_ARCHIVE_ACCESS_ACTIONS.has(action) || !metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const data = metadata as Record<string, unknown>;
  if (
    !Number.isInteger(data.archiveId)
    || typeof data.scope !== "string"
    || typeof data.purpose !== "string"
    || data.requestingRole !== "master"
  ) {
    return null;
  }
  return {
    archiveId: data.archiveId as number,
    classId: Number.isInteger(data.classId) ? data.classId as number : null,
    sessionId: Number.isInteger(data.sessionId) ? data.sessionId as number : null,
    requestingRole: "master" as const,
    scope: data.scope as string,
    purpose: data.purpose as string,
  };
}

function archiveAccessAuditMetadataProjection() {
  return sql<unknown>`
    CASE WHEN ${auditLogTable.action} IN ('teacher.archived_student_record_viewed', 'teacher.archived_records_exported')
    THEN jsonb_build_object(
      'archiveId', ${auditLogTable.metadata} -> 'archiveId',
      'classId', ${auditLogTable.metadata} -> 'classId',
      'sessionId', ${auditLogTable.metadata} -> 'sessionId',
      'requestingRole', ${auditLogTable.metadata} -> 'requestingRole',
      'scope', ${auditLogTable.metadata} -> 'scope',
      'purpose', ${auditLogTable.metadata} -> 'purpose'
    )
    ELSE NULL
    END
  `;
}

function csvCell(value: string | number | Date | null | undefined): string {
  const text = value instanceof Date ? value.toISOString() : value == null ? "" : String(value);
  const spreadsheetSafe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${spreadsheetSafe.replaceAll('"', '""')}"`;
}

function buildAuditReportCsv(entries: Array<{
  action: string;
  ipAddress: string | null;
  createdAt: Date;
  teacherName: string | null;
  teacherEmail: string | null;
  archiveAccess: ReturnType<typeof serialiseArchiveAccessAuditMetadata>;
}>): string {
  const header = ["Time (UTC)", "Action", "User", "Email", "IP address", "Archive ID", "Archive access scope", "Archive access purpose", "Requester role"];
  const rows = entries.map((entry) => [
    entry.createdAt,
    entry.action,
    entry.teacherName ?? "System",
    entry.teacherEmail,
    entry.ipAddress,
    entry.archiveAccess?.archiveId ?? null,
    entry.archiveAccess?.scope ?? null,
    entry.archiveAccess?.purpose ?? null,
    entry.archiveAccess?.requestingRole ?? null,
  ].map(csvCell).join(","));
  return [header.map(csvCell).join(","), ...rows].join("\r\n");
}

function generateClassCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function getOwnedClass(classId: number, teacherId: number) {
  const [cls] = await db
    .select()
    .from(classesTable)
    .where(and(
      eq(classesTable.id, classId),
      eq(classesTable.teacherId, teacherId),
      isNull(classesTable.deletionScheduledFor),
    ));
  return cls ?? null;
}

const classStudentParams = z.object({
  classId: z.coerce.number().int().positive(),
  sessionId: z.coerce.number().int().positive(),
});
const RecoverableDeletionBody = z.object({
  confirmation: z.literal("DELETE"),
});
const RestoreArchivedStudentBody = z.object({
  confirmation: z.literal("RESTORE TO ACTIVE RECORDS"),
});

function computeStageStatus(stage: string, contentJson: unknown, msgCount: number): "none" | "started" | "finished" {
  const c = (contentJson ?? {}) as Record<string, any>;
  const completion = c._studentCompletion;
  const hasDeclaration = completion && typeof completion === "object" && typeof completion.complete === "boolean";
  if (hasDeclaration && completion.complete === true) return "finished";
  const declaredIncomplete = hasDeclaration && completion.complete === false;
  switch (stage) {
    case "MAP": {
      const u = (c.taskUnderstanding ?? "").trim();
      const pk = (c.priorKnowledge ?? []).filter((p: string) => p?.trim());
      const kg = (c.knowledgeGaps ?? []).filter((g: string) => g?.trim());
      const eq2 = (c.enquiryQuestions ?? []).filter((q: string) => q?.trim());
      const researchPlan = Array.isArray(c.researchPlan) ? c.researchPlan : [];
      const planIsComplete = researchPlan.length > 0 && researchPlan.every((row: Record<string, any>) => {
        const investigation = typeof row?.investigation === "string" ? row.investigation.trim() : "";
        const sources = Array.isArray(row?.sources)
          ? row.sources.filter((source: unknown) => typeof source === "string" && source.trim())
          : [];
        const verificationSelections = Array.isArray(row?.verificationSelections)
          ? row.verificationSelections.filter((selection: unknown) => typeof selection === "string" && selection.trim())
          : [];
        const verification = typeof row?.verification === "string" ? row.verification.trim() : "";
        return Boolean(investigation && sources.length > 0 && (verificationSelections.length > 0 || verification));
      });
      if (!u && !pk.length && !eq2.length) return "none";
       if (u.length >= 20 && pk.length >= 2 && kg.length >= 3 && eq2.length >= 3 && planIsComplete) return declaredIncomplete ? "started" : "finished";
      return "started";
    }
    case "TORCH":
      if (msgCount === 0) return "none";
      return msgCount >= 6 && !declaredIncomplete ? "finished" : "started";
    case "RESEARCH": {
      const sources = (c.entries ?? []) as any[];
      if (!sources.some((s: any) => s.source || s.findings)) return "none";
      if (sources.some((s: any) => (s.source || s.title) && s.findings)) return declaredIncomplete ? "started" : "finished";
      return "started";
    }
    case "COMPASS": {
      const { check1, check2, check3, check4, check5 } = c;
      if (!check1 && !check2 && !check3 && !check4 && !check5) return "none";
      if (check1?.trim() && check2?.trim() && check3?.trim() && check4?.trim() && check5?.trim()) return declaredIncomplete ? "started" : "finished";
      return "started";
    }
    case "EMBED": {
      const { finalAnswer, q1, q2, q3, q4 } = c;
      const readableAnswer = typeof finalAnswer === "string" ? finalAnswerReadableText(finalAnswer) : "";
      if (!readableAnswer && !q1 && !q2 && !q3 && !q4) return "none";
      if (readableAnswer.trim() && q1?.trim() && q2?.trim() && q3?.trim() && q4?.trim()) return declaredIncomplete ? "started" : "finished";
      return "started";
    }
    default: return "none";
  }
}

function taskTemplateValues(
  body: ReturnType<typeof CreateTaskTemplateBody.parse>,
  teacher: NonNullable<Request["teacher"]>,
) {
  return {
    teacherId: teacher.id,
    organisationId: teacher.organisationId ?? null,
    title: body.title.trim(),
    subject: body.subject?.trim() || null,
    examBoard: body.examBoard?.trim() || null,
    question: body.question.trim(),
    notes: body.notes?.trim() || null,
    learningFramework: body.learningFramework ?? (body.knowledgeDimensions?.length && !body.bloomLevels?.length ? "knowledge_dimensions" : "bloom"),
    yearGroup: body.yearGroup?.trim() || null,
    bloomLevels: body.bloomLevels ?? [],
    knowledgeDimensions: body.knowledgeDimensions ?? [],
    dueDate: body.dueDate?.trim() || null,
    successCriteria: body.successCriteria ?? [],
    keyVocabulary: body.keyVocabulary ?? [],
    enabledStages: body.enabledStages ?? ["MAP", "TORCH", "COMPASS", "EMBED", "RESEARCH"],
    stageInstructions: body.stageInstructions ?? {},
    expectedLength: body.expectedLength?.trim() || null,
    resources: body.resources ?? [],
    status: body.status,
  } as const;
}

function taskFrameworkError(input: {
  learningFramework?: "bloom" | "knowledge_dimensions";
  bloomLevels?: string[];
  knowledgeDimensions?: string[];
}, requireSelection = false): string | null {
  const bloom = input.bloomLevels ?? [];
  const knowledge = input.knowledgeDimensions ?? [];
  const framework = input.learningFramework ?? (knowledge.length > 0 && bloom.length === 0 ? "knowledge_dimensions" : "bloom");
  if (bloom.length > 0 && knowledge.length > 0) return "Choose either Bloom's Taxonomy or Knowledge Dimensions, not both.";
  if (framework === "bloom" && knowledge.length > 0) return "Knowledge Dimensions cannot be selected for a Bloom's Taxonomy task.";
  if (framework === "knowledge_dimensions" && bloom.length > 0) return "Bloom's levels cannot be selected for a Knowledge Dimensions task.";
  if (requireSelection && framework === "bloom" && bloom.length === 0) return "Select at least one Bloom's Taxonomy level.";
  if (requireSelection && framework === "knowledge_dimensions" && knowledge.length === 0) return "Select at least one Knowledge Dimension.";
  return null;
}

function serialiseActivityLog(rows: Array<{
  id: number;
  loginSessionId: string | null;
  startedAt: Date;
  lastSeenAt: Date;
  endedAt: Date | null;
  activeStage: "MAP" | "TORCH" | "RESEARCH" | "COMPASS" | "EMBED" | null;
  pageDurations: Partial<Record<"MAP" | "TORCH" | "RESEARCH" | "COMPASS" | "EMBED", number>> | null;
}>) {
  const stages = ["MAP", "TORCH", "RESEARCH", "COMPASS", "EMBED"] as const;
  const pageTotals: Partial<Record<(typeof stages)[number], number>> = {};
  const entries = rows.map((row) => {
    const end = row.endedAt ?? row.lastSeenAt;
    const durationSeconds = Math.max(0, Math.floor((end.getTime() - row.startedAt.getTime()) / 1000));
    const entry = {
      id: row.id,
      startedAt: row.startedAt,
      lastSeenAt: row.lastSeenAt,
      endedAt: row.endedAt,
      activeStage: row.activeStage,
      durationSeconds,
      ...(row.pageDurations && typeof row.pageDurations === "object" ? {
        pageDurations: stages.map((stage) => ({
          stage,
          durationSeconds: Number.isInteger(row.pageDurations?.[stage]) && (row.pageDurations?.[stage] ?? 0) >= 0
            ? row.pageDurations?.[stage] ?? 0
            : 0,
        })),
      } : {}),
    };
    for (const stage of stages) {
      const seconds = row.pageDurations?.[stage];
      pageTotals[stage] = (pageTotals[stage] ?? 0) + (Number.isInteger(seconds) && (seconds ?? 0) >= 0 ? seconds ?? 0 : 0);
    }
    return entry;
  });
  const totalSeconds = entries.reduce((total, entry) => total + entry.durationSeconds, 0);
  const loginSessionDurations = new Map<string, number>();
  rows.forEach((row, index) => {
    if (!row.loginSessionId) return;
    loginSessionDurations.set(
      row.loginSessionId,
      (loginSessionDurations.get(row.loginSessionId) ?? 0) + entries[index].durationSeconds,
    );
  });
  const loginSessionsAvailable = rows.every((row) => row.loginSessionId !== null);
  const loginSessionCount = loginSessionsAvailable ? loginSessionDurations.size : null;
  const loginDurations = [...loginSessionDurations.values()];
  return {
    entries,
    summary: {
      totalSessions: entries.length,
      totalSeconds,
      averageSeconds: entries.length ? Math.round(totalSeconds / entries.length) : 0,
      loginSessionsAvailable,
      loginSessionCount,
      averageLoginSessionSeconds: loginSessionCount && loginSessionCount > 0
        ? Math.round(totalSeconds / loginSessionCount)
        : loginSessionsAvailable ? 0 : null,
      longestLoginSessionSeconds: loginSessionsAvailable && loginDurations.length
        ? Math.max(...loginDurations)
        : loginSessionsAvailable ? 0 : null,
      pageDurations: stages.map((stage) => ({
        stage,
        durationSeconds: pageTotals[stage] ?? 0,
      })),
    },
  };
}

function clipActivityRows(
  rows: Array<{
    id: number;
    loginSessionId: string | null;
    startedAt: Date;
    lastSeenAt: Date;
    endedAt: Date | null;
    activeStage: "MAP" | "TORCH" | "RESEARCH" | "COMPASS" | "EMBED" | null;
    pageDurations: Partial<Record<"MAP" | "TORCH" | "RESEARCH" | "COMPASS" | "EMBED", number>> | null;
  }>,
  boundary: Date,
  side: "before" | "after",
) {
  const boundaryMs = boundary.getTime();
  return rows.flatMap((row) => {
    const startMs = row.startedAt.getTime();
    const endMs = (row.endedAt ?? row.lastSeenAt).getTime();
    const overlapStartMs = side === "before" ? startMs : Math.max(startMs, boundaryMs);
    const overlapEndMs = side === "before" ? Math.min(endMs, boundaryMs) : endMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || overlapEndMs <= overlapStartMs) return [];
    const originalDurationMs = Math.max(1, endMs - startMs);
    const proportion = (overlapEndMs - overlapStartMs) / originalDurationMs;
    const pageDurations = row.pageDurations
      ? Object.fromEntries(Object.entries(row.pageDurations).map(([stage, seconds]) => [
        stage,
        Number.isInteger(seconds) && (seconds ?? 0) >= 0 ? Math.floor((seconds ?? 0) * proportion) : 0,
      ])) as Partial<Record<"MAP" | "TORCH" | "RESEARCH" | "COMPASS" | "EMBED", number>>
      : row.pageDurations;
    return [{
      ...row,
      startedAt: new Date(overlapStartMs),
      lastSeenAt: new Date(overlapEndMs),
      endedAt: new Date(overlapEndMs),
      pageDurations,
    }];
  });
}

const CLASS_ACTIVITY_STAGES = ["MAP", "TORCH", "RESEARCH", "COMPASS", "EMBED"] as const;

async function loadTeacherClassActivity(classId: number, teacherId: number) {
  const [classRecord] = await db
    .select({
      id: classesTable.id,
      name: classesTable.name,
      subject: classesTable.subject,
    })
    .from(classesTable)
    .where(and(eq(classesTable.id, classId), eq(classesTable.teacherId, teacherId)));
  if (!classRecord) return null;

  const [task] = await db.select({
    title: tasksTable.title,
    question: tasksTable.question,
  }).from(tasksTable).where(eq(tasksTable.classId, classId));

  const sessions = await db
    .select({
      id: studentSessionsTable.id,
      studentName: studentSessionsTable.studentName,
    })
    .from(studentSessionsTable)
    .where(and(
      eq(studentSessionsTable.classId, classId),
      isNull(studentSessionsTable.deletionScheduledFor),
    ))
    .orderBy(asc(studentSessionsTable.studentName));

  const sessionIds = sessions.map((session) => session.id);
  const activityRows = sessionIds.length > 0
    ? await db
      .select({
        id: studentActivitySessionsTable.id,
        studentSessionId: studentActivitySessionsTable.studentSessionId,
        loginSessionId: studentActivitySessionsTable.loginSessionId,
        startedAt: studentActivitySessionsTable.startedAt,
        lastSeenAt: studentActivitySessionsTable.lastSeenAt,
        endedAt: studentActivitySessionsTable.endedAt,
        activeStage: studentActivitySessionsTable.activeStage,
        pageDurations: studentActivitySessionsTable.pageDurations,
      })
      .from(studentActivitySessionsTable)
      .where(inArray(studentActivitySessionsTable.studentSessionId, sessionIds))
      .orderBy(desc(studentActivitySessionsTable.startedAt))
    : [];

  const studentNames = new Map(sessions.map((session) => [session.id, session.studentName]));
  const entries = activityRows.map((row) => {
    const end = row.endedAt ?? row.lastSeenAt;
    const durationSeconds = Math.max(0, Math.floor((end.getTime() - row.startedAt.getTime()) / 1000));
    const pageDurations = CLASS_ACTIVITY_STAGES.map((stage) => ({
      stage,
      durationSeconds: Number.isInteger((row.pageDurations as any)?.[stage]) && ((row.pageDurations as any)?.[stage] ?? 0) >= 0
        ? (row.pageDurations as any)[stage] ?? 0
        : 0,
    }));
    return {
      id: row.id,
      studentSessionId: row.studentSessionId,
      loginSessionId: row.loginSessionId,
      studentName: studentNames.get(row.studentSessionId) ?? "Unknown student",
      startedAt: row.startedAt,
      lastSeenAt: row.lastSeenAt,
      endedAt: row.endedAt,
      activeStage: row.activeStage,
      durationSeconds,
      pageDurations,
    };
  });

  const entriesByStudent = new Map<number, typeof entries>();
  for (const entry of entries) {
    const current = entriesByStudent.get(entry.studentSessionId) ?? [];
    current.push(entry);
    entriesByStudent.set(entry.studentSessionId, current);
  }

  const students = sessions.map((session) => {
    const studentEntries = entriesByStudent.get(session.id) ?? [];
    const stageSeconds = Object.fromEntries(
      CLASS_ACTIVITY_STAGES.map((stage) => [
        stage,
        studentEntries.reduce(
          (total, entry) => total + (entry.pageDurations.find((page) => page.stage === stage)?.durationSeconds ?? 0),
          0,
        ),
      ]),
    ) as Record<(typeof CLASS_ACTIVITY_STAGES)[number], number>;
    const durations = studentEntries.map((entry) => entry.durationSeconds);
    const totalSeconds = durations.reduce((total, seconds) => total + seconds, 0);
    const loginSessionDurations = new Map<string, number>();
    for (const entry of studentEntries) {
      if (!entry.loginSessionId) continue;
      loginSessionDurations.set(entry.loginSessionId, (loginSessionDurations.get(entry.loginSessionId) ?? 0) + entry.durationSeconds);
    }
    const loginSessionsAvailable = studentEntries.every((entry) => entry.loginSessionId !== null);
    const loginSessionCount = loginSessionsAvailable ? loginSessionDurations.size : null;
    const groupedLoginDurations = [...loginSessionDurations.values()];
    const sortedStageDurations = [...CLASS_ACTIVITY_STAGES].sort((a, b) => stageSeconds[b] - stageSeconds[a]);
    return {
      id: session.id,
      studentName: session.studentName,
      totalSessions: studentEntries.length,
      totalSeconds,
      averageSessionSeconds: studentEntries.length ? Math.round(totalSeconds / studentEntries.length) : 0,
      longestSessionSeconds: durations.length ? Math.max(...durations) : 0,
      shortestSessionSeconds: durations.length ? Math.min(...durations) : 0,
      loginSessionsAvailable,
      loginSessionCount,
      averageLoginSessionSeconds: loginSessionCount && loginSessionCount > 0 ? Math.round(totalSeconds / loginSessionCount) : loginSessionsAvailable ? 0 : null,
      longestLoginSessionSeconds: loginSessionsAvailable && groupedLoginDurations.length ? Math.max(...groupedLoginDurations) : loginSessionsAvailable ? 0 : null,
      dominantStage: totalSeconds > 0 && stageSeconds[sortedStageDurations[0]] > 0 ? sortedStageDurations[0] : null,
      stageDurations: CLASS_ACTIVITY_STAGES.map((stage) => ({ stage, durationSeconds: stageSeconds[stage] })),
    };
  });

  const totalSeconds = entries.reduce((total, entry) => total + entry.durationSeconds, 0);
  const classLoginSessionDurations = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.loginSessionId) continue;
    classLoginSessionDurations.set(entry.loginSessionId, (classLoginSessionDurations.get(entry.loginSessionId) ?? 0) + entry.durationSeconds);
  }
  const loginSessionsAvailable = entries.every((entry) => entry.loginSessionId !== null);
  const loginSessionCount = loginSessionsAvailable ? classLoginSessionDurations.size : null;
  const classGroupedLoginDurations = [...classLoginSessionDurations.values()];
  const sortedStudentTotals = students.map((student) => student.totalSeconds).sort((a, b) => a - b);
  const medianStudentSeconds = sortedStudentTotals.length > 0
    ? sortedStudentTotals.length % 2 === 1
      ? sortedStudentTotals[Math.floor(sortedStudentTotals.length / 2)]
      : Math.round((sortedStudentTotals[sortedStudentTotals.length / 2 - 1] + sortedStudentTotals[sortedStudentTotals.length / 2]) / 2)
    : 0;
  const studentsByTime = [...students].sort((a, b) => b.totalSeconds - a.totalSeconds || a.studentName.localeCompare(b.studentName));
  const stageStats = CLASS_ACTIVITY_STAGES.map((stage) => {
    const stageTotal = students.reduce(
      (total, student) => total + (student.stageDurations.find((item) => item.stage === stage)?.durationSeconds ?? 0),
      0,
    );
    const studentsWithStageTime = students.filter((student) => (student.stageDurations.find((item) => item.stage === stage)?.durationSeconds ?? 0) > 0);
    const ranked = [...studentsWithStageTime].sort((a, b) => {
      const aSeconds = a.stageDurations.find((item) => item.stage === stage)?.durationSeconds ?? 0;
      const bSeconds = b.stageDurations.find((item) => item.stage === stage)?.durationSeconds ?? 0;
      return bSeconds - aSeconds || a.studentName.localeCompare(b.studentName);
    });
    return {
      stage,
      totalSeconds: stageTotal,
      averageStudentSeconds: students.length ? Math.round(stageTotal / students.length) : 0,
      sharePercent: totalSeconds ? Math.round((stageTotal / totalSeconds) * 100) : 0,
      highestStudent: ranked[0]
        ? { id: ranked[0].id, studentName: ranked[0].studentName, seconds: ranked[0].stageDurations.find((item) => item.stage === stage)?.durationSeconds ?? 0 }
        : null,
      lowestStudent: ranked.length
        ? { id: ranked[ranked.length - 1].id, studentName: ranked[ranked.length - 1].studentName, seconds: ranked[ranked.length - 1].stageDurations.find((item) => item.stage === stage)?.durationSeconds ?? 0 }
        : null,
    };
  });

  return {
    class: classRecord,
    task: task ?? null,
    summary: {
      studentCount: students.length,
      activeStudentCount: students.filter((student) => student.totalSeconds > 0).length,
      totalSessions: entries.length,
      totalSeconds,
      averageSessionSeconds: entries.length ? Math.round(totalSeconds / entries.length) : 0,
      loginSessionsAvailable,
      loginSessionCount,
      averageLoginSessionSeconds: loginSessionCount && loginSessionCount > 0 ? Math.round(totalSeconds / loginSessionCount) : loginSessionsAvailable ? 0 : null,
      longestLoginSessionSeconds: loginSessionsAvailable && classGroupedLoginDurations.length ? Math.max(...classGroupedLoginDurations) : loginSessionsAvailable ? 0 : null,
      averageStudentSeconds: students.length ? Math.round(totalSeconds / students.length) : 0,
      medianStudentSeconds,
      topStudent: studentsByTime[0] ? { id: studentsByTime[0].id, studentName: studentsByTime[0].studentName, seconds: studentsByTime[0].totalSeconds } : null,
      bottomStudent: studentsByTime[studentsByTime.length - 1]
        ? { id: studentsByTime[studentsByTime.length - 1].id, studentName: studentsByTime[studentsByTime.length - 1].studentName, seconds: studentsByTime[studentsByTime.length - 1].totalSeconds }
        : null,
      stageStats,
    },
    students,
    entries,
  };
}

router.post("/teacher/classes", requireTeacher, async (req, res): Promise<void> => {
  const parsed = CreateClassBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  let code: string = "";
  let attempts = 0;
  do {
    code = generateClassCode();
    const [existing] = await db
      .select({ id: classesTable.id })
      .from(classesTable)
      .where(eq(classesTable.code, code));
    if (!existing) break;
    attempts++;
  } while (attempts < 10);

  const [cls] = await db
    .insert(classesTable)
    .values({ teacherId: req.teacher!.id, name: parsed.data.name, subject: parsed.data.subject ?? null, code })
    .returning();

  res.status(201).json(ListClassesResponseItem.parse(cls));
});

router.get("/teacher/classes", requireTeacher, async (req, res): Promise<void> => {
  const classes = await db
    .select()
    .from(classesTable)
    .where(and(
      eq(classesTable.teacherId, req.teacher!.id),
      isNull(classesTable.deletionScheduledFor),
      isNull(classesTable.archivedAt),
    ))
    .orderBy(classesTable.createdAt);

  res.json(classes.map((c) => ListClassesResponseItem.parse(c)));
});

router.get("/teacher/dashboard/overview", requireTeacher, async (req, res): Promise<void> => {
  const teacherId = req.teacher!.id;
  const ownedClasses = await db
    .select({
      id: classesTable.id,
      name: classesTable.name,
      subject: classesTable.subject,
      code: classesTable.code,
      taskTitle: tasksTable.title,
      dueDate: tasksTable.dueDate,
      formativeAssessmentDate: tasksTable.formativeAssessmentDate,
      summativeAssessmentDate: tasksTable.summativeAssessmentDate,
      enabledStages: tasksTable.enabledStages,
    })
    .from(classesTable)
    .leftJoin(tasksTable, eq(tasksTable.classId, classesTable.id))
    .where(and(
      eq(classesTable.teacherId, teacherId),
      isNull(classesTable.archivedAt),
      isNull(classesTable.deletionScheduledFor),
    ))
    .orderBy(asc(classesTable.name));

  const classIds = ownedClasses.map((cls) => cls.id);
  if (classIds.length === 0) {
    res.json(GetTeacherDashboardOverviewResponse.parse({
      totalClasses: 0,
      totalStudents: 0,
      pendingApprovals: 0,
      completedStudents: 0,
      inProgressStudents: 0,
       readyForFormativeClasses: 0,
       readyForSummativeClasses: 0,
       notStartedStudents: 0,
       readyToAssessStudents: 0,
       nearlyCompleteStudents: 0,
       needsNudgeStudents: 0,
       activeThisWeekStudents: 0,
       dueSoonTasks: 0,
      attentionDetails: {
        readyToAssess: [],
         readyForFormative: [],
         readyForSummative: [],
         notStarted: [],
        nearlyComplete: [],
        teachingAttention: [],
        activeThisWeek: [],
        dueSoon: [],
      },
      classes: [],
    }));
    return;
  }

  const sessions = await db
    .select({
      id: studentSessionsTable.id,
      classId: studentSessionsTable.classId,
      studentName: studentSessionsTable.studentName,
      registrationStatus: studentSessionsTable.registrationStatus,
    })
    .from(studentSessionsTable)
    .where(and(
      inArray(studentSessionsTable.classId, classIds),
      isNull(studentSessionsTable.deletionScheduledFor),
    ));
  const approvedSessionIds = sessions
    .filter((session) => session.registrationStatus === "approved")
    .map((session) => session.id);

  const [stageRows, messageCounts, activityRows] = approvedSessionIds.length
    ? await Promise.all([
        db
          .select({
            sessionId: stageEntriesTable.sessionId,
            stage: stageEntriesTable.stage,
            contentJson: stageEntriesTable.contentJson,
            updatedAt: stageEntriesTable.updatedAt,
          })
          .from(stageEntriesTable)
          .where(inArray(stageEntriesTable.sessionId, approvedSessionIds))
          .orderBy(desc(stageEntriesTable.updatedAt)),
        db
          .select({
            sessionId: chatMessagesTable.sessionId,
            count: sql<number>`count(*)::int`,
          })
          .from(chatMessagesTable)
          .where(inArray(chatMessagesTable.sessionId, approvedSessionIds))
          .groupBy(chatMessagesTable.sessionId),
        db
          .select({
            sessionId: studentActivitySessionsTable.studentSessionId,
            latestActivityAt: sql<Date>`max(${studentActivitySessionsTable.lastSeenAt})`,
          })
          .from(studentActivitySessionsTable)
          .where(inArray(studentActivitySessionsTable.studentSessionId, approvedSessionIds))
          .groupBy(studentActivitySessionsTable.studentSessionId),
      ])
    : [[], [], []];

  const sessionsByClass = new Map<number, typeof sessions>();
  sessions.forEach((session) => {
    const group = sessionsByClass.get(session.classId) ?? [];
    group.push(session);
    sessionsByClass.set(session.classId, group);
  });
  const stagesBySession = new Map<number, Map<string, typeof stageRows[number]>>();
  stageRows.forEach((entry) => {
    const stages = stagesBySession.get(entry.sessionId) ?? new Map();
    if (!stages.has(entry.stage)) stages.set(entry.stage, entry);
    stagesBySession.set(entry.sessionId, stages);
  });
  const messagesBySession = new Map(messageCounts.map((row) => [row.sessionId, row.count]));
  const activityBySession = new Map(activityRows.map((row) => [row.sessionId, row.latestActivityAt]));
  const readyToAssessDetails: Array<Record<string, unknown>> = [];
  const readyForFormativeDetails: Array<Record<string, unknown>> = [];
  const readyForSummativeDetails: Array<Record<string, unknown>> = [];
  const nearlyCompleteDetails: Array<Record<string, unknown>> = [];
  const teachingAttentionDetails: Array<Record<string, unknown>> = [];
  const notStartedDetails: Array<Record<string, unknown>> = [];
  const activeThisWeekDetails: Array<Record<string, unknown>> = [];
  const assessmentRows = approvedSessionIds.length
    ? await db
      .select({
        sessionId: teacherFeedbackTable.sessionId,
        grade: teacherFeedbackTable.grade,
        comment: teacherFeedbackTable.comment,
      })
      .from(teacherFeedbackTable)
      .where(and(
        inArray(teacherFeedbackTable.sessionId, approvedSessionIds),
        eq(teacherFeedbackTable.stage, "OVERALL"),
      ))
    : [];
  const assessedSessionIds = new Set(
    assessmentRows
      .filter((row) => Boolean(row.grade || row.comment?.trim()))
      .map((row) => row.sessionId),
  );
  const activeThisWeekSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const classMetrics = ownedClasses.map((cls) => {
    const classSessions = sessionsByClass.get(cls.id) ?? [];
    const approved = classSessions.filter((session) => session.registrationStatus === "approved");
    let completedCount = 0;
    let inProgressCount = 0;
    let readyToAssessCount = 0;
    let nearlyCompleteCount = 0;
    let needsNudgeCount = 0;
    let activeThisWeekCount = 0;
    let latestActivityAt: Date | null = null;

    approved.forEach((session) => {
      const stages = stagesBySession.get(session.id) ?? new Map();
      const stageValues = [...stages.values()];
      const requiredStages = Array.isArray(cls.enabledStages) && cls.enabledStages.length > 0
        ? cls.enabledStages
        : ["MAP", "TORCH", "RESEARCH", "COMPASS", "EMBED"];
      const isComplete = requiredStages.every((stage) =>
        (stages.get(stage)?.contentJson as Record<string, any> | null)?._studentCompletion?.complete === true,
      );
      const isStarted = [...stages.values()].some((entry) =>
        computeStageStatus(entry.stage, entry.contentJson, messagesBySession.get(session.id) ?? 0) !== "none",
      ) || (messagesBySession.get(session.id) ?? 0) > 0;
      const finishedStages = [...stages.values()]
        .filter((entry) =>
          computeStageStatus(entry.stage, entry.contentJson, messagesBySession.get(session.id) ?? 0) === "finished",
        )
        .map((entry) => entry.stage);
      const needsAttention = !isStarted || (!isComplete && finishedStages.length <= 2);
      if (isComplete) completedCount++;
      else if (isStarted) inProgressCount++;
      if (isComplete && !assessedSessionIds.has(session.id)) readyToAssessCount++;
      if (!isComplete && finishedStages.length >= 4) nearlyCompleteCount++;
      if (needsAttention) needsNudgeCount++;

      const stageActivity = [...stages.values()].reduce<Date | null>(
        (latest, entry) => !latest || entry.updatedAt > latest ? entry.updatedAt : latest,
        null,
      );
      const activity = activityBySession.get(session.id) ?? null;
      const sessionLatest = activity && (!stageActivity || activity > stageActivity) ? activity : stageActivity;
      if (sessionLatest && (!latestActivityAt || sessionLatest > latestActivityAt)) latestActivityAt = sessionLatest;
      if (sessionLatest && sessionLatest >= activeThisWeekSince) activeThisWeekCount++;

      const detailBase = {
        sessionId: session.id,
        classId: cls.id,
        className: cls.name,
        studentName: session.studentName,
        taskTitle: cls.taskTitle,
        lastActivityAt: sessionLatest?.toISOString() ?? null,
        completionDate: stageActivity?.toISOString() ?? null,
        dueDate: cls.dueDate,
      };
      if (isComplete && !assessedSessionIds.has(session.id)) {
        readyToAssessDetails.push({
          ...detailBase,
          kind: "ready_to_assess",
          reason: "Completed climb awaiting review",
          stage: "Final Answer",
          missingFeedback: true,
        });
      }
      if (!isComplete) {
        if (finishedStages.length >= 4) {
          const nextStage = ["MAP", "TORCH", "RESEARCH", "COMPASS", "EMBED"].find((stage) => !finishedStages.includes(stage)) ?? null;
          nearlyCompleteDetails.push({
            ...detailBase,
            kind: "nearly_complete",
            reason: "One stage remains before the climb is complete",
            stage: nextStage,
            missingFeedback: false,
          });
        }
      }
      if (needsAttention) {
        const nextStage = ["MAP", "TORCH", "RESEARCH", "COMPASS", "EMBED"].find((stage) => !finishedStages.includes(stage)) ?? null;
        teachingAttentionDetails.push({
          ...detailBase,
          kind: "teaching_attention",
          reason: !isStarted
            ? "No work started"
            : `${finishedStages.length} sections completed; teaching attention needed`,
          stage: nextStage,
          missingFeedback: false,
        });
      }
      if (!isStarted) {
        notStartedDetails.push({
          ...detailBase,
          kind: "not_started",
          reason: "No work started",
          stage: null,
          missingFeedback: false,
        });
      }
      if (sessionLatest && sessionLatest >= activeThisWeekSince) {
        activeThisWeekDetails.push({
          ...detailBase,
          kind: "active_this_week",
          reason: "Recent recorded interaction",
          stage: [...stages.values()]
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]?.stage ?? null,
          missingFeedback: false,
        });
      }
    });

    const nextAction = classSessions.length === 0
      ? "Invite students"
      : classSessions.some((session) => session.registrationStatus === "pending")
        ? `Review ${classSessions.filter((session) => session.registrationStatus === "pending").length} registration${classSessions.filter((session) => session.registrationStatus === "pending").length === 1 ? "" : "s"}`
        : needsNudgeCount > 0
          ? `Review ${needsNudgeCount} student${needsNudgeCount === 1 ? "" : "s"} needing attention`
          : nearlyCompleteCount > 0
            ? `Review ${nearlyCompleteCount} nearly complete`
            : readyToAssessCount > 0
              ? `Assess ${readyToAssessCount} completed climb${readyToAssessCount === 1 ? "" : "s"}`
              : "Monitor progress";

    return {
      ...cls,
      enrolledCount: approved.length,
      pendingApprovals: classSessions.filter((session) => session.registrationStatus === "pending").length,
      completedCount,
      inProgressCount,
      notStartedCount: Math.max(0, approved.length - completedCount - inProgressCount),
      readyToAssessCount,
      nearlyCompleteCount,
      needsNudgeCount,
      activeThisWeekCount,
      progressPercent: approved.length ? Math.round((completedCount / approved.length) * 100) : 0,
      nextAction,
      latestActivityAt,
    };
  });

  const today = new Date().toISOString().slice(0, 10);
  const readyForFormativeClasses = ownedClasses.filter((cls) =>
    Boolean(cls.formativeAssessmentDate)
    && cls.formativeAssessmentDate! <= today
    && (!cls.dueDate || cls.dueDate >= today),
  );
  const readyForSummativeClasses = ownedClasses.filter((cls) =>
    Boolean(cls.dueDate) && cls.dueDate! < today,
  );
  for (const cls of readyForFormativeClasses) {
    readyForFormativeDetails.push({
      kind: "ready_for_formative",
      sessionId: null,
      classId: cls.id,
      className: cls.name,
      studentName: null,
      taskTitle: cls.taskTitle,
      reason: `Formative assessment date reached${cls.formativeAssessmentDate ? ` on ${formatDateOnly(cls.formativeAssessmentDate)}` : ""}`,
      stage: null,
      lastActivityAt: null,
      completionDate: null,
      dueDate: cls.formativeAssessmentDate,
      missingFeedback: false,
    });
  }
  for (const cls of readyForSummativeClasses) {
    readyForSummativeDetails.push({
      kind: "ready_for_summative",
      sessionId: null,
      classId: cls.id,
      className: cls.name,
      studentName: null,
      taskTitle: cls.taskTitle,
      reason: `Task completion date passed${cls.dueDate ? ` on ${formatDateOnly(cls.dueDate)}` : ""}`,
      stage: null,
      lastActivityAt: null,
      completionDate: null,
      dueDate: cls.dueDate,
      missingFeedback: false,
    });
  }

  const now = new Date();
  const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const dueSoonDetails: Array<Record<string, unknown>> = [];
  let dueSoonTasks = 0;
  for (const cls of ownedClasses) {
    const assessmentDates = [
      { label: "Formative assessment", value: cls.formativeAssessmentDate },
      { label: "Task completion", value: cls.dueDate },
    ];
    for (const assessmentDate of assessmentDates) {
      if (!assessmentDate.value) continue;
      const due = new Date(`${assessmentDate.value}T23:59:59Z`);
      if (Number.isNaN(due.getTime()) || due < now || due > nextWeek) continue;
      dueSoonTasks++;
      dueSoonDetails.push({
        kind: "due_soon",
        sessionId: null,
        classId: cls.id,
        className: cls.name,
        studentName: null,
        taskTitle: cls.taskTitle,
        reason: `${assessmentDate.label} on ${formatDateOnly(assessmentDate.value)}`,
        stage: null,
        lastActivityAt: null,
        completionDate: null,
        dueDate: assessmentDate.value,
        missingFeedback: false,
      });
    }
  }

  res.json(GetTeacherDashboardOverviewResponse.parse({
    totalClasses: classMetrics.length,
    totalStudents: classMetrics.reduce((sum, cls) => sum + cls.enrolledCount, 0),
    pendingApprovals: classMetrics.reduce((sum, cls) => sum + cls.pendingApprovals, 0),
    completedStudents: classMetrics.reduce((sum, cls) => sum + cls.completedCount, 0),
    inProgressStudents: classMetrics.reduce((sum, cls) => sum + cls.inProgressCount, 0),
    readyForFormativeClasses: readyForFormativeClasses.length,
    readyForSummativeClasses: readyForSummativeClasses.length,
    notStartedStudents: notStartedDetails.length,
    readyToAssessStudents: classMetrics.reduce((sum, cls) => sum + cls.readyToAssessCount, 0),
    nearlyCompleteStudents: classMetrics.reduce((sum, cls) => sum + cls.nearlyCompleteCount, 0),
    needsNudgeStudents: classMetrics.reduce((sum, cls) => sum + cls.needsNudgeCount, 0),
    activeThisWeekStudents: classMetrics.reduce((sum, cls) => sum + cls.activeThisWeekCount, 0),
    dueSoonTasks,
    attentionDetails: {
      readyToAssess: readyToAssessDetails,
      readyForFormative: readyForFormativeDetails,
      readyForSummative: readyForSummativeDetails,
      notStarted: notStartedDetails,
      nearlyComplete: nearlyCompleteDetails,
      teachingAttention: teachingAttentionDetails,
      activeThisWeek: activeThisWeekDetails,
      dueSoon: dueSoonDetails,
    },
    classes: classMetrics,
  }));
});

router.get("/teacher/task-templates", requireTeacher, async (req, res): Promise<void> => {
  const templates = await db
    .select()
    .from(taskTemplatesTable)
    .where(eq(taskTemplatesTable.teacherId, req.teacher!.id))
    .orderBy(desc(taskTemplatesTable.updatedAt));
  res.json(templates.map((template) => ListTaskTemplatesResponseItem.parse(template)));
});

router.post("/teacher/task-templates", requireTeacher, async (req, res): Promise<void> => {
  const body = CreateTaskTemplateBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (body.data.dueDate && !isValidTaskDueDate(body.data.dueDate)) {
    res.status(400).json({ error: "Due date must be a valid calendar date." });
    return;
  }
  if (body.data.status === "ready" && !body.data.question.trim()) {
    res.status(400).json({ error: "A ready assignment must include a task question." });
    return;
  }
  const frameworkError = taskFrameworkError(body.data);
  if (frameworkError) {
    res.status(400).json({ error: frameworkError });
    return;
  }
  const [template] = await db
    .insert(taskTemplatesTable)
    .values(taskTemplateValues(body.data, req.teacher!))
    .returning();
  res.status(201).json(CreateTaskTemplateResponse.parse(template));
});

router.put("/teacher/task-templates/:templateId", requireTeacher, async (req, res): Promise<void> => {
  const params = UpdateTaskTemplateParams.safeParse(req.params);
  const body = UpdateTaskTemplateBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid template input." });
    return;
  }
  if (body.data.dueDate && !isValidTaskDueDate(body.data.dueDate)) {
    res.status(400).json({ error: "Due date must be a valid calendar date." });
    return;
  }
  if (body.data.status === "ready" && !body.data.question.trim()) {
    res.status(400).json({ error: "A ready assignment must include a task question." });
    return;
  }
  const frameworkError = taskFrameworkError(body.data);
  if (frameworkError) {
    res.status(400).json({ error: frameworkError });
    return;
  }
  const [template] = await db
    .update(taskTemplatesTable)
    .set({ ...taskTemplateValues(body.data, req.teacher!), updatedAt: new Date() })
    .where(and(
      eq(taskTemplatesTable.id, params.data.templateId),
      eq(taskTemplatesTable.teacherId, req.teacher!.id),
    ))
    .returning();
  if (!template) {
    res.status(404).json({ error: "Assignment template not found." });
    return;
  }
  res.json(UpdateTaskTemplateResponse.parse(template));
});

router.delete("/teacher/task-templates/:templateId", requireTeacher, async (req, res): Promise<void> => {
  const params = DeleteTaskTemplateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [deleted] = await db
    .delete(taskTemplatesTable)
    .where(and(
      eq(taskTemplatesTable.id, params.data.templateId),
      eq(taskTemplatesTable.teacherId, req.teacher!.id),
    ))
    .returning({ id: taskTemplatesTable.id });
  if (!deleted) {
    res.status(404).json({ error: "Assignment template not found." });
    return;
  }
  res.status(204).end();
});

router.post("/teacher/task-templates/:templateId/duplicate", requireTeacher, async (req, res): Promise<void> => {
  const params = DuplicateTaskTemplateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [source] = await db
    .select()
    .from(taskTemplatesTable)
    .where(and(
      eq(taskTemplatesTable.id, params.data.templateId),
      eq(taskTemplatesTable.teacherId, req.teacher!.id),
    ));
  if (!source) {
    res.status(404).json({ error: "Assignment template not found." });
    return;
  }
  const [duplicate] = await db
    .insert(taskTemplatesTable)
    .values({
      ...source,
      id: undefined,
      title: `Copy of ${source.title}`.slice(0, 250),
      status: "draft",
      createdAt: undefined,
      updatedAt: undefined,
    })
    .returning();
  res.status(201).json(DuplicateTaskTemplateResponse.parse(duplicate));
});

router.post("/teacher/task-templates/:templateId/apply", requireTeacher, async (req, res): Promise<void> => {
  const params = ApplyTaskTemplateParams.safeParse(req.params);
  const body = ApplyTaskTemplateBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid apply request." });
    return;
  }
  const classIds = [...new Set(body.data.classIds)];
  const [template] = await db
    .select()
    .from(taskTemplatesTable)
    .where(and(
      eq(taskTemplatesTable.id, params.data.templateId),
      eq(taskTemplatesTable.teacherId, req.teacher!.id),
    ));
  if (!template) {
    res.status(404).json({ error: "Assignment template not found." });
    return;
  }
  if (template.status !== "ready" || !template.question.trim()) {
    res.status(409).json({ error: "Mark this assignment ready before applying it to a class." });
    return;
  }
  const applied = await db.transaction(async (tx) => {
    const eligibleClasses = await tx
      .select({ id: classesTable.id })
      .from(classesTable)
      .where(and(
        inArray(classesTable.id, classIds),
        eq(classesTable.teacherId, req.teacher!.id),
        isNull(classesTable.archivedAt),
        isNull(classesTable.deletionScheduledFor),
      ))
      .orderBy(asc(classesTable.id))
      .for("update");
    if (eligibleClasses.length !== classIds.length) return false;

    for (const cls of eligibleClasses) {
      const [existing] = await tx
        .select({
          dueDate: tasksTable.dueDate,
          lateEditingAllowed: tasksTable.lateEditingAllowed,
        })
        .from(tasksTable)
        .where(eq(tasksTable.classId, cls.id))
        .for("update");
      const lateEditingAllowed = existing?.dueDate === template.dueDate
        ? existing.lateEditingAllowed
        : false;
      const values = {
        classId: cls.id,
        title: template.title,
        subject: template.subject,
        examBoard: template.examBoard,
        question: template.question,
        notes: template.notes,
        learningFramework: template.learningFramework,
        yearGroup: template.yearGroup,
        bloomLevels: template.bloomLevels,
        knowledgeDimensions: template.knowledgeDimensions,
        dueDate: template.dueDate,
        lateEditingAllowed,
        successCriteria: template.successCriteria,
        keyVocabulary: template.keyVocabulary,
        enabledStages: template.enabledStages,
        stageInstructions: template.stageInstructions,
        expectedLength: template.expectedLength,
        resources: template.resources,
      };
      await tx
        .insert(tasksTable)
        .values(values)
        .onConflictDoUpdate({
          target: tasksTable.classId,
          set: { ...values, updatedAt: new Date() },
        });
    }
    return true;
  });
  if (!applied) {
    res.status(404).json({ error: "One or more active classes could not be found." });
    return;
  }

  res.json(ApplyTaskTemplateResponse.parse({ appliedClassIds: classIds }));
});

router.get("/teacher/archive", requireTeacher, async (req, res): Promise<void> => {
  const teacher = req.teacher!;
  const deletionScope = teacher.schoolAdminRole === "master" && teacher.organisationId
    ? eq(teachersTable.organisationId, teacher.organisationId)
    : eq(classesTable.teacherId, teacher.id);
  const archivedClassScope = teacher.schoolAdminRole === "master" && teacher.organisationId
    ? inArray(
        classesTable.teacherId,
        db.select({ id: teachersTable.id })
          .from(teachersTable)
          .where(eq(teachersTable.organisationId, teacher.organisationId)),
      )
    : eq(classesTable.teacherId, teacher.id);

  const [archivedClasses, archivedStudentRecords, scheduledDeletions, scheduledStudentRecords] = await Promise.all([
    db
      .select({
        id: classesTable.id,
        teacherId: classesTable.teacherId,
        name: classesTable.name,
        subject: classesTable.subject,
        code: classesTable.code,
        createdAt: classesTable.createdAt,
        archivedAt: classesTable.archivedAt,
        archiveExpiresAt: classesTable.archiveExpiresAt,
        archiveLifecycleStatus: classesTable.archiveLifecycleStatus,
        archiveExpiryWarningSentAt: classesTable.archiveExpiryWarningSentAt,
        studentCount: sql<number>`(
          select count(*)::int
          from ${studentSessionsTable}
          where ${studentSessionsTable.classId} = ${classesTable.id}
        )`,
      })
      .from(classesTable)
      .where(and(
        archivedClassScope,
        isNotNull(classesTable.archivedAt),
        isNull(classesTable.deletionScheduledFor),
      ))
      .orderBy(desc(classesTable.archivedAt)),
    db
      .select({
        id: studentSessionsTable.id,
        studentName: studentSessionsTable.studentName,
        classId: classesTable.id,
        className: classesTable.name,
        archivedAt: studentSessionsTable.archivedAt,
      })
      .from(studentSessionsTable)
      .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
      .where(and(
        archivedClassScope,
        isNull(classesTable.archivedAt),
        isNull(classesTable.deletionScheduledFor),
        isNotNull(studentSessionsTable.archivedAt),
        isNull(studentSessionsTable.deletionScheduledFor),
      ))
      .orderBy(desc(studentSessionsTable.archivedAt)),
    db
      .select({
        id: classesTable.id,
        name: classesTable.name,
        subject: classesTable.subject,
        teacherId: teachersTable.id,
        teacherName: teachersTable.name,
        deletionScheduledFor: classesTable.deletionScheduledFor,
        deletionReason: classesTable.deletionReason,
        studentCount: sql<number>`(
          select count(*)::int
          from ${studentSessionsTable}
          where ${studentSessionsTable.classId} = ${classesTable.id}
        )`,
      })
      .from(classesTable)
      .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
      .where(and(
        deletionScope,
        isNotNull(classesTable.deletionScheduledFor),
      ))
      .orderBy(asc(classesTable.deletionScheduledFor)),
    db
      .select({
        id: studentSessionsTable.id,
        studentName: studentSessionsTable.studentName,
        classId: classesTable.id,
        className: classesTable.name,
        teacherId: teachersTable.id,
        teacherName: teachersTable.name,
        deletionScheduledFor: studentSessionsTable.deletionScheduledFor,
      })
      .from(studentSessionsTable)
      .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
      .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
      .where(and(
        deletionScope,
        isNull(classesTable.deletionScheduledFor),
        isNotNull(studentSessionsTable.deletionScheduledFor),
      ))
      .orderBy(asc(studentSessionsTable.deletionScheduledFor)),
  ]);

  res.json(ListTeacherArchiveResponse.parse({
    warningWindowDays: ARCHIVE_EXPIRY_WARNING_DAYS,
    archivedClasses,
    archivedStudentRecords,
    scheduledDeletions: scheduledDeletions.map((cls) => ({
      ...cls,
      canRestoreAsSchoolMaster: teacher.schoolAdminRole === "master",
    })),
    scheduledStudentRecords: scheduledStudentRecords.map((record) => ({
      ...record,
      canRestoreAsSchoolMaster: teacher.schoolAdminRole === "master",
    })),
  }));
});

// Scheduled deletion has a dedicated recovery surface. Normal class and
// student routes must not expose or mutate a record merely because an older
// handler checked teacher ownership without its lifecycle state.
router.use(
  "/teacher/classes/:classId",
  requireTeacher,
  async (req, res, next): Promise<void> => {
    const classId = Number(req.params.classId);
    if (!Number.isInteger(classId) || classId <= 0) {
      res.status(400).json({ error: "Invalid class ID" });
      return;
    }
    // req.path is relative to this mounted middleware, excludes both the
    // /api mount prefix and query string, and is safe for a narrow allowlist.
    const pathname = req.path;
    const studentRestorePattern = /^\/students\/\d+\/restore-deletion$/;
    const archiveRestorePattern = /^\/students\/\d+\/restore-archive$/;
    if (req.method === "POST" && (
      pathname === "/restore-deletion"
      || pathname === "/restore-archive"
      || studentRestorePattern.test(pathname)
      || archiveRestorePattern.test(pathname)
    )) {
      next();
      return;
    }
    const cls = await getOwnedClass(classId, req.teacher!.id);
    if (!cls) {
      res.status(404).json({ error: "Class not found" });
      return;
    }
    const archiveRecoveryPattern = /^\/students\/\d+\/restore-deletion$/;
    const canMutateArchivedClass = req.method === "GET"
      || (req.method === "POST" && (pathname === "/unarchive" || pathname === "/restore-deletion" || archiveRecoveryPattern.test(pathname)));
    if (cls.archivedAt && !canMutateArchivedClass) {
      res.status(409).json({ error: "Archived classes are read-only. Reopen the class before changing its content." });
      return;
    }
    next();
  },
);

router.use(
  "/teacher/classes/:classId/students/:sessionId",
  requireTeacher,
  async (req, res, next): Promise<void> => {
    if (req.params.sessionId === "bulk-review") {
      next();
      return;
    }
    const classId = Number(req.params.classId);
    const sessionId = Number(req.params.sessionId);
    if (!Number.isInteger(classId) || classId <= 0 || !Number.isInteger(sessionId) || sessionId <= 0) {
      res.status(400).json({ error: "Invalid class or student ID" });
      return;
    }
    const pathname = req.path;
    // Only the two dedicated recovery-management endpoints own their locked
    // lookup. Other DELETE routes (including rejected-registration cleanup)
    // remain subject to the active-record lifecycle guard.
    if (
      (req.method === "DELETE" && pathname === "/")
      || (req.method === "POST" && (pathname === "/restore-deletion" || pathname === "/restore-archive"))
    ) {
      next();
      return;
    }
    const [record] = await db
      .select({ id: studentSessionsTable.id })
      .from(studentSessionsTable)
      .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
      .where(and(
        eq(studentSessionsTable.id, sessionId),
        eq(studentSessionsTable.classId, classId),
        eq(classesTable.teacherId, req.teacher!.id),
        isNull(classesTable.deletionScheduledFor),
        isNull(studentSessionsTable.deletionScheduledFor),
      ));
    if (!record) {
      res.status(404).json({ error: "Student record not found" });
      return;
    }
    next();
  },
);

router.post("/teacher/classes/:classId/regenerate-code", requireTeacher, async (req, res): Promise<void> => {
  const classId = Number(req.params.classId);
  if (!Number.isInteger(classId) || classId <= 0) {
    res.status(400).json({ error: "Invalid class ID" });
    return;
  }
  const cls = await getOwnedClass(classId, req.teacher!.id);
  if (!cls) {
    res.status(404).json({ error: "Class not found" });
    return;
  }
  if (cls.archivedAt) {
    res.status(409).json({ error: "Archived classes cannot receive a new join code." });
    return;
  }

  let code = "";
  for (let attempts = 0; attempts < 10; attempts++) {
    const candidate = generateClassCode();
    const [existing] = await db.select({ id: classesTable.id }).from(classesTable).where(eq(classesTable.code, candidate));
    if (!existing) {
      code = candidate;
      break;
    }
  }
  if (!code) {
    res.status(503).json({ error: "Could not generate a new class code. Please try again." });
    return;
  }

  const [updated] = await db
    .update(classesTable)
    .set({ code })
    .where(eq(classesTable.id, cls.id))
    .returning();
  await logAudit({ teacherId: req.teacher!.id, action: "class_code_regenerated", metadata: { classId: cls.id } });
  res.json({ id: updated.id, code: updated.code });
});

router.post("/teacher/classes/:classId/archive", requireTeacher, async (req, res): Promise<void> => {
  const classId = Number(req.params.classId);
  if (!Number.isInteger(classId) || classId <= 0) {
    res.status(400).json({ error: "Invalid class ID" });
    return;
  }
  const archived = await db.transaction(async (tx) => {
    const [cls] = await tx
      .select()
      .from(classesTable)
      .where(and(eq(classesTable.id, classId), eq(classesTable.teacherId, req.teacher!.id)))
      .for("update");
    if (!cls) return null;
    if (cls.archivedAt) return { archivedAt: cls.archivedAt, changed: false };
    const now = new Date();
    const lifecycle = req.teacher!.organisationId
      ? await getOrganisationLifecycleDays(req.teacher!.organisationId)
      : { archiveRetentionDays: 30, deletionRecoveryDays: 30 };
    const [updated] = await tx
      .update(classesTable)
      .set({
        archivedAt: now,
        archiveExpiresAt: new Date(now.getTime() + lifecycle.archiveRetentionDays * 24 * 60 * 60 * 1000),
        archiveLifecycleStatus: "archived",
      })
      .where(eq(classesTable.id, cls.id))
      .returning();
    return { archivedAt: updated.archivedAt, changed: true };
  });
  if (!archived) {
    res.status(404).json({ error: "Class not found" });
    return;
  }
  if (archived.changed) {
    await logAudit({ teacherId: req.teacher!.id, action: "class_archived", metadata: { classId } });
  }
  res.json({ archivedAt: archived.archivedAt });
});

router.post("/teacher/classes/:classId/unarchive", requireTeacher, async (req, res): Promise<void> => {
  const classId = Number(req.params.classId);
  if (!Number.isInteger(classId) || classId <= 0) {
    res.status(400).json({ error: "Invalid class ID" });
    return;
  }
  const cls = await getOwnedClass(classId, req.teacher!.id);
  if (!cls) {
    res.status(404).json({ error: "Class not found" });
    return;
  }
  await db.update(classesTable).set({
    archivedAt: null,
    archiveExpiresAt: null,
    archiveLifecycleStatus: "active",
    archiveExpiryNotifiedAt: null,
    archiveExpiryWarningAttemptedAt: null,
    archiveExpiryWarningSentAt: null,
  }).where(eq(classesTable.id, cls.id));
  await logAudit({ teacherId: req.teacher!.id, action: "class_unarchived", metadata: { classId: cls.id } });
  res.status(204).end();
});

router.get("/teacher/classes/:classId", requireTeacher, async (req, res): Promise<void> => {
  const params = GetClassParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [cls] = await db
    .select()
    .from(classesTable)
    .where(
      and(
        eq(classesTable.id, params.data.classId),
        eq(classesTable.teacherId, req.teacher!.id),
        isNull(classesTable.deletionScheduledFor),
      ),
    );

  if (!cls) {
    res.status(404).json({ error: "Class not found" });
    return;
  }

  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(studentSessionsTable)
    .where(eq(studentSessionsTable.classId, params.data.classId));

  res.json(
    GetClassResponse.parse({
      ...cls,
      studentCount: countResult?.count ?? 0,
    }),
  );
});

router.put("/teacher/classes/:classId", requireTeacher, async (req, res): Promise<void> => {
  const params = GetClassParams.safeParse(req.params);
  const body = UpdateClassBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Enter a class name and an optional subject." });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(classesTable)
      .where(and(
        eq(classesTable.id, params.data.classId),
        eq(classesTable.teacherId, req.teacher!.id),
        isNull(classesTable.deletionScheduledFor),
      ))
      .for("update");
    if (!current) return { kind: "missing" as const };
    if (current.archivedAt) return { kind: "archived" as const };

    const [updated] = await tx
      .update(classesTable)
      .set({
        name: body.data.name.trim(),
        subject: body.data.subject?.trim() || null,
      })
      .where(eq(classesTable.id, current.id))
      .returning();
    if (!updated) return { kind: "changed" as const };

    const [countResult] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(studentSessionsTable)
      .where(eq(studentSessionsTable.classId, updated.id));

    await tx.insert(auditLogTable).values({
      organisationId: req.teacher!.organisationId,
      teacherId: req.teacher!.id,
      action: "class_details_updated_by_teacher",
      metadata: {
        classId: updated.id,
        previousName: current.name,
        previousSubject: current.subject,
        name: updated.name,
        subject: updated.subject,
      },
      ipAddress: req.ip,
    });

    return {
      kind: "updated" as const,
      class: {
        ...updated,
        studentCount: countResult?.count ?? 0,
      },
    };
  });

  if (result.kind === "missing") {
    res.status(404).json({ error: "Class not found" });
    return;
  }
  if (result.kind === "archived") {
    res.status(409).json({ error: "Archived classes are read-only. Reopen the class before editing it." });
    return;
  }
  if (result.kind === "changed") {
    res.status(409).json({ error: "This class changed while it was being edited. Refresh and try again." });
    return;
  }
  res.json(GetClassResponse.parse(result.class));
});

router.delete("/teacher/classes/:classId", requireTeacher, async (req, res): Promise<void> => {
  const params = DeleteClassParams.safeParse(req.params);
  const body = RecoverableDeletionBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Type DELETE to schedule this class for deletion." });
    return;
  }
  const classId = params.data.classId;
  const lifecycle = req.teacher!.organisationId
    ? await getOrganisationLifecycleDays(req.teacher!.organisationId)
    : { archiveRetentionDays: 30, deletionRecoveryDays: 30 };
  const result = await db.transaction(async (tx) => {
    const [cls] = await tx
      .select({
        id: classesTable.id,
        name: classesTable.name,
        archivedAt: classesTable.archivedAt,
        deletionScheduledFor: classesTable.deletionScheduledFor,
      })
      .from(classesTable)
      .where(and(eq(classesTable.id, classId), eq(classesTable.teacherId, req.teacher!.id)))
      .for("update");
    if (!cls) return { kind: "missing" as const };
    if (cls.deletionScheduledFor) return { kind: "already-scheduled" as const, scheduledFor: cls.deletionScheduledFor };
    if (cls.archivedAt) return { kind: "archived" as const };
    const archivedRecords = await tx
      .select({ id: studentSessionsTable.id })
      .from(studentSessionsTable)
      .where(and(
        eq(studentSessionsTable.classId, classId),
        isNotNull(studentSessionsTable.archivedAt),
      ))
      .for("update");
    if (archivedRecords.length) return { kind: "contains-archives" as const };
    const now = new Date();
    const scheduledFor = new Date(now.getTime() + lifecycle.deletionRecoveryDays * 24 * 60 * 60 * 1000);
    const [updated] = await tx
      .update(classesTable)
      .set({
        archivedAt: now,
        deletionRequestedAt: now,
        deletionScheduledFor: scheduledFor,
        deletionRequestedBy: req.teacher!.id,
        deletionReason: "teacher_requested",
      })
      .where(and(eq(classesTable.id, classId), isNull(classesTable.deletionScheduledFor)))
      .returning({ id: classesTable.id });
    if (!updated) return { kind: "changed" as const };
    await tx
      .update(studentSessionsTable)
      .set({
        deletionRequestedAt: now,
        deletionScheduledFor: scheduledFor,
        deletionRequestedBy: req.teacher!.id,
        deletionReason: "teacher_requested",
      })
      .where(eq(studentSessionsTable.classId, classId));
    await tx
      .update(studentActivitySessionsTable)
      .set({
        endedAt: sql`${studentActivitySessionsTable.lastSeenAt}`,
        endReason: "deletion_requested",
      })
      .where(and(
        isNull(studentActivitySessionsTable.endedAt),
        inArray(
          studentActivitySessionsTable.studentSessionId,
          tx.select({ id: studentSessionsTable.id })
            .from(studentSessionsTable)
            .where(eq(studentSessionsTable.classId, classId)),
        ),
      ));
    await tx.insert(auditLogTable).values({
      organisationId: req.teacher!.organisationId,
      teacherId: req.teacher!.id,
      action: "class_deletion_requested_by_teacher",
      metadata: { classId, className: cls.name, deletionScheduledFor: scheduledFor.toISOString() },
      ipAddress: req.ip,
    });
    return { kind: "scheduled" as const, scheduledFor };
  });
  if (result.kind === "missing") {
    res.status(404).json({ error: "Class not found" });
    return;
  }
  if (result.kind === "archived") {
    res.status(409).json({ error: "Archived classes are retained separately. Reopen the class before choosing Delete." });
    return;
  }
  if (result.kind === "contains-archives") {
    res.status(409).json({
      error: "This class contains archived student records. Archive is retained separately and cannot be included in a teacher deletion.",
    });
    return;
  }
  if (result.kind === "changed") {
    res.status(409).json({ error: "This class changed while deletion was being scheduled. Refresh and try again." });
    return;
  }
  res.json({
    ok: true,
    deletionScheduledFor: result.scheduledFor,
    alreadyScheduled: result.kind === "already-scheduled",
  });
});

router.post("/teacher/classes/:classId/restore-deletion", requireTeacher, async (req, res): Promise<void> => {
  const params = DeleteClassParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const result = await db.transaction(async (tx) => {
    const now = new Date();
    const [cls] = await tx
      .select({ id: classesTable.id, deletionScheduledFor: classesTable.deletionScheduledFor })
      .from(classesTable)
      .where(and(
        eq(classesTable.id, params.data.classId),
        eq(classesTable.teacherId, req.teacher!.id),
      ))
      .for("update");
    if (!cls || !cls.deletionScheduledFor) return { kind: "missing" as const };
    if (cls.deletionScheduledFor <= now) {
      return { kind: "expired" as const, deletionScheduledFor: cls.deletionScheduledFor };
    }
    await tx.update(classesTable).set({
      archivedAt: null,
      archiveExpiresAt: null,
      archiveLifecycleStatus: "active",
      archiveExpiryNotifiedAt: null,
      archiveExpiryWarningAttemptedAt: null,
      archiveExpiryWarningSentAt: null,
      deletionRequestedAt: null,
      deletionScheduledFor: null,
      deletionRequestedBy: null,
      deletionReason: null,
    }).where(eq(classesTable.id, cls.id));
    await tx.update(studentSessionsTable).set({
      deletionRequestedAt: null,
      deletionScheduledFor: null,
      deletionRequestedBy: null,
      deletionReason: null,
    }).where(eq(studentSessionsTable.classId, cls.id));
    await tx.insert(auditLogTable).values({
      organisationId: req.teacher!.organisationId,
      teacherId: req.teacher!.id,
      action: "class_deletion_restored_by_teacher",
      metadata: { classId: cls.id },
      ipAddress: req.ip,
    });
    return { kind: "restored" as const };
  });
  if (result.kind === "missing") {
    res.status(404).json({ error: "No pending deletion was found for this class." });
    return;
  }
  if (result.kind === "expired") {
    res.status(409).json({
      error: `The recovery period expired on ${result.deletionScheduledFor.toISOString()}; this class was not restored.`,
      deletionScheduledFor: result.deletionScheduledFor,
    });
    return;
  }
  res.json({ ok: true, restored: true });
});

async function saveOwnedClassTask(
  classId: number,
  teacherId: number,
  input: z.infer<typeof UpsertClassTaskBody>,
) {
  return db.transaction(async (tx) => {
    const [cls] = await tx
      .select({ id: classesTable.id })
      .from(classesTable)
      .where(and(eq(classesTable.id, classId), eq(classesTable.teacherId, teacherId)))
      .for("update");
    if (!cls) return null;

    const [existing] = await tx
      .select({
        dueDate: tasksTable.dueDate,
        lateEditingAllowed: tasksTable.lateEditingAllowed,
      })
      .from(tasksTable)
      .where(eq(tasksTable.classId, classId))
      .for("update");
    const nextDueDate = input.dueDate ?? null;
    const lateEditingAllowed = existing?.dueDate === nextDueDate
      ? existing.lateEditingAllowed
      : false;
    const values = {
      classId,
      title: input.title,
      subject: input.subject?.trim() || null,
      examBoard: input.examBoard?.trim() || null,
      question: input.question,
      notes: input.notes ?? null,
      learningFramework: input.learningFramework ?? (input.knowledgeDimensions?.length && !input.bloomLevels?.length ? "knowledge_dimensions" : "bloom"),
      yearGroup: input.yearGroup?.trim() || null,
      bloomLevels: input.bloomLevels ?? [],
      knowledgeDimensions: input.knowledgeDimensions ?? [],
      dueDate: nextDueDate,
      formativeAssessmentDate: input.formativeAssessmentDate ?? null,
      summativeAssessmentDate: null,
      lateEditingAllowed,
      successCriteria: input.successCriteria ?? [],
      keyVocabulary: input.keyVocabulary ?? [],
      enabledStages: input.enabledStages ?? ["MAP", "TORCH", "COMPASS", "EMBED", "RESEARCH"],
      stageInstructions: input.stageInstructions ?? {},
      expectedLength: input.expectedLength ?? null,
      resources: input.resources ?? [],
    };
    const [task] = await tx
      .insert(tasksTable)
      .values(values)
      .onConflictDoUpdate({
        target: tasksTable.classId,
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    return task;
  });
}

router.get(
  "/teacher/classes/:classId/task",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = GetClassTaskParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [cls] = await db
      .select({ id: classesTable.id })
      .from(classesTable)
      .where(and(eq(classesTable.id, params.data.classId), eq(classesTable.teacherId, req.teacher!.id)));
    if (!cls) {
      res.status(404).json({ error: "Class not found" });
      return;
    }
    const [task] = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.classId, params.data.classId));
    if (!task) {
      res.status(404).json({ error: "No task set" });
      return;
    }
    res.json(GetClassTaskResponse.parse(withTaskDeadlineState(task)));
  },
);

router.get(
  "/teacher/classes/:classId/students/:sessionId/messages",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = ListTeacherStudentMessagesParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const result = await db.transaction(async (tx) => {
      const [student] = await tx
        .select({ sessionId: studentSessionsTable.id })
        .from(studentSessionsTable)
        .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
        .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
        .innerJoin(organisationsTable, eq(teachersTable.organisationId, organisationsTable.id))
        .where(and(
          eq(studentSessionsTable.id, params.data.sessionId),
          eq(studentSessionsTable.classId, params.data.classId),
          eq(classesTable.teacherId, req.teacher!.id),
          eq(studentSessionsTable.registrationStatus, "approved"),
          isNull(classesTable.archivedAt),
          isNull(classesTable.deletionScheduledFor),
          isNull(studentSessionsTable.archivedAt),
          isNull(studentSessionsTable.deletionScheduledFor),
          eq(organisationsTable.active, true),
          isNull(organisationsTable.deletedAt),
        ));
      if (!student) return null;
      await tx.update(teacherMessagesTable)
        .set({ teacherReadAt: new Date() })
        .where(and(
          eq(teacherMessagesTable.studentSessionId, student.sessionId),
          eq(teacherMessagesTable.senderType, "student"),
          isNull(teacherMessagesTable.teacherReadAt),
        ));
      const messages = await tx.select({
        id: teacherMessagesTable.id,
        teacherId: teacherMessagesTable.teacherId,
        senderType: teacherMessagesTable.senderType,
        content: teacherMessagesTable.content,
        createdAt: teacherMessagesTable.createdAt,
        teacherReadAt: teacherMessagesTable.teacherReadAt,
        studentReadAt: teacherMessagesTable.studentReadAt,
      }).from(teacherMessagesTable)
        .where(eq(teacherMessagesTable.studentSessionId, student.sessionId))
        .orderBy(asc(teacherMessagesTable.createdAt), asc(teacherMessagesTable.id));
      return { messages, unreadCount: 0 };
    });
    if (!result) {
      res.status(404).json({ error: "Class or student not found" });
      return;
    }
    res.json(ListTeacherStudentMessagesResponse.parse(result));
  },
);

router.get(
  "/teacher/classes/:classId/students/:sessionId/messages/report.pdf",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = ListTeacherStudentMessagesParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const messages = await db.transaction(async (tx) => {
      const [student] = await tx
        .select({ sessionId: studentSessionsTable.id })
        .from(studentSessionsTable)
        .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
        .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
        .innerJoin(organisationsTable, eq(teachersTable.organisationId, organisationsTable.id))
        .where(and(
          eq(studentSessionsTable.id, params.data.sessionId),
          eq(studentSessionsTable.classId, params.data.classId),
          eq(classesTable.teacherId, req.teacher!.id),
          eq(studentSessionsTable.registrationStatus, "approved"),
          isNull(classesTable.archivedAt),
          isNull(classesTable.deletionScheduledFor),
          isNull(studentSessionsTable.archivedAt),
          isNull(studentSessionsTable.deletionScheduledFor),
          eq(organisationsTable.active, true),
          isNull(organisationsTable.deletedAt),
        ));
      if (!student) return null;
      return tx.select({
        senderType: teacherMessagesTable.senderType,
        content: teacherMessagesTable.content,
        createdAt: teacherMessagesTable.createdAt,
      }).from(teacherMessagesTable)
        .where(eq(teacherMessagesTable.studentSessionId, student.sessionId))
        .orderBy(asc(teacherMessagesTable.createdAt), asc(teacherMessagesTable.id));
    });
    if (messages === null) {
      res.status(404).json({ error: "Class or student not found" });
      return;
    }
    const pdf = await renderTeacherMessagesPdf(messages.map((message) => ({
      sender: message.senderType === "teacher" ? "Teacher" : "Student",
      createdAt: message.createdAt,
      content: message.content,
    })));
    res.status(200)
      .type("application/pdf")
      .set("Content-Disposition", 'attachment; filename="student-messages.pdf"')
      .send(pdf);
  },
);

router.post(
  "/teacher/classes/:classId/students/:sessionId/messages",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = SendTeacherMessageParams.safeParse(req.params);
    const body = SendTeacherMessageBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const content = body.data.content.trim();
    if (!content) {
      res.status(400).json({ error: "Message content cannot be empty" });
      return;
    }

    const result = await db.transaction(async (tx) => {
      const [student] = await tx
        .select({
          sessionId: studentSessionsTable.id,
          organisationId: organisationsTable.id,
          teacherId: teachersTable.id,
          lockedAt: studentSessionsTable.lockedAt,
          dueDate: tasksTable.dueDate,
          lateEditingAllowed: tasksTable.lateEditingAllowed,
        })
        .from(studentSessionsTable)
        .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
        .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
        .innerJoin(organisationsTable, eq(teachersTable.organisationId, organisationsTable.id))
        .leftJoin(tasksTable, eq(tasksTable.classId, classesTable.id))
        .where(and(
          eq(studentSessionsTable.id, params.data.sessionId),
          eq(studentSessionsTable.classId, params.data.classId),
          eq(classesTable.teacherId, req.teacher!.id),
          isNull(classesTable.archivedAt),
          isNull(classesTable.deletionScheduledFor),
          isNull(studentSessionsTable.archivedAt),
          isNull(studentSessionsTable.deletionScheduledFor),
          eq(studentSessionsTable.registrationStatus, "approved"),
          eq(organisationsTable.active, true),
          isNull(organisationsTable.deletedAt),
        ));
      if (!student) return null;
      if (student.lockedAt) {
        return { blocked: "This Climb is locked. Messages can be read, but no new messages can be sent." };
      }
      if (student.dueDate && getTaskDeadlineState(student.dueDate, student.lateEditingAllowed).deadlineClosed) {
        return { blocked: "This task is closed. Messages can be read, but no new messages can be sent." };
      }

      const [message] = await tx.insert(teacherMessagesTable).values({
        studentSessionId: student.sessionId,
        teacherId: student.teacherId,
        senderType: "teacher",
        content,
      }).returning();
      if (!message) return null;
      await tx.insert(auditLogTable).values({
        organisationId: student.organisationId,
        teacherId: req.teacher!.id,
        action: "teacher_message.sent",
        metadata: {
          classId: params.data.classId,
          studentSessionId: student.sessionId,
          messageId: message.id,
        },
        ipAddress: req.ip,
      });
      return message;
    });

    if (!result) {
      res.status(404).json({ error: "Class or student not found" });
      return;
    }
    if ("blocked" in result) {
      res.status(403).json({ error: result.blocked });
      return;
    }
    res.status(201).json(SendTeacherMessageResponse.parse(result));
  },
);

router.put(
  "/teacher/classes/:classId/task",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = UpsertClassTaskParams.safeParse(req.params);
    const body = UpsertClassTaskBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    if (body.data.dueDate && !isValidTaskDueDate(body.data.dueDate)) {
      res.status(400).json({ error: "Due date must be a valid calendar date." });
      return;
    }
    const frameworkError = taskFrameworkError(body.data);
    if (frameworkError) {
      res.status(400).json({ error: frameworkError });
      return;
    }
    const task = await saveOwnedClassTask(params.data.classId, req.teacher!.id, body.data);
    if (!task) {
      res.status(404).json({ error: "Class not found" });
      return;
    }
    res.json(UpsertClassTaskResponse.parse(withTaskDeadlineState(task)));
  },
);

router.post(
  "/teacher/classes/:classId/task/generate",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = GenerateClassTaskSuggestionParams.safeParse(req.params);
    const body = GenerateClassTaskSuggestionBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Enter a title and subject, choose one framework and its options, then select a year group." });
      return;
    }
    const frameworkError = taskFrameworkError(body.data, true);
    if (frameworkError) {
      res.status(400).json({ error: frameworkError });
      return;
    }
    const [cls] = await db
      .select({
        id: classesTable.id,
        subject: classesTable.subject,
        archivedAt: classesTable.archivedAt,
      })
      .from(classesTable)
      .where(and(eq(classesTable.id, params.data.classId), eq(classesTable.teacherId, req.teacher!.id)));
    if (!cls) {
      res.status(404).json({ error: "Class not found." });
      return;
    }
    if (cls.archivedAt) {
      res.status(409).json({ error: "Archived classes cannot generate new task content." });
      return;
    }
    const researchAllowed = await admitTaskResearchRequest({
      teacherId: req.teacher!.id,
      organisationId: req.teacher!.organisationId,
      classId: params.data.classId,
      ipAddress: req.ip ?? null,
    });
    if (!researchAllowed) {
      res.status(429).json({ error: "You have generated several task drafts recently. Please wait a few minutes before trying again." });
      return;
    }
    let orgConfig: OrgAiConfig | null = null;
    if (req.teacher!.organisationId) {
      const [org] = await db
        .select({
          aiProvider: organisationsTable.aiProvider,
          aiKeyEncrypted: organisationsTable.aiKeyEncrypted,
          azureEndpoint: organisationsTable.azureEndpoint,
          aiDataProcessingAcknowledged: organisationsTable.aiDataProcessingAcknowledged,
          aiDataRetentionNoTrainingConfirmed: organisationsTable.aiDataRetentionNoTrainingConfirmed,
          aiSchoolPoliciesConfirmed: organisationsTable.aiSchoolPoliciesConfirmed,
          aiDataProcessingRegion: organisationsTable.aiDataProcessingRegion,
        })
        .from(organisationsTable)
        .where(eq(organisationsTable.id, req.teacher!.organisationId));
      if (org) orgConfig = org;
    }
    try {
      const suggestion = await generateTaskSuggestion({
        title: body.data.title,
        subject: body.data.subject,
        examBoard: body.data.examBoard?.trim() || null,
        question: body.data.question?.trim() || null,
        learningFramework: body.data.learningFramework,
        yearGroup: body.data.yearGroup,
        bloomLevels: body.data.bloomLevels ?? [],
        knowledgeDimensions: body.data.knowledgeDimensions ?? [],
      }, orgConfig);
      await logAudit({
        organisationId: req.teacher!.organisationId,
        teacherId: req.teacher!.id,
        action: "class_task_suggestion_generated",
        metadata: {
          classId: params.data.classId,
          learningFramework: body.data.learningFramework,
          yearGroup: body.data.yearGroup,
          subject: body.data.subject,
          examBoard: body.data.examBoard?.trim() || null,
           researchStatus: suggestion.researchStatus,
           researchSourceCount: suggestion.resourceSuggestions.length,
        },
        ipAddress: req.ip,
      });
      res.json(GenerateClassTaskSuggestionResponse.parse(suggestion));
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI task generation is temporarily unavailable.";
      const unavailable = message.startsWith("AI is not configured") || message.startsWith("AI is unavailable");
      req.log.warn({ err: error, classId: params.data.classId }, "Could not generate class task suggestion");
      res.status(unavailable ? 403 : 503).json({ error: message });
    }
  },
);

router.post(
  "/teacher/classes/:classId/task/reopen",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = GetClassTaskParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const task = await db.transaction(async (tx) => {
      const [cls] = await tx
        .select({ id: classesTable.id })
        .from(classesTable)
        .where(and(
          eq(classesTable.id, params.data.classId),
          eq(classesTable.teacherId, req.teacher!.id),
        ))
        .for("update");
      if (!cls) return null;
      const [reopened] = await tx
        .update(tasksTable)
        .set({ lateEditingAllowed: true, updatedAt: new Date() })
        .where(eq(tasksTable.classId, params.data.classId))
        .returning();
      return reopened ?? null;
    });
    if (!task) {
      res.status(404).json({ error: "Class task not found" });
      return;
    }
    await logAudit({
      organisationId: req.teacher!.organisationId,
      teacherId: req.teacher!.id,
      action: "class_task_deadline_reopened",
      metadata: { classId: params.data.classId, dueDate: task.dueDate },
      ipAddress: req.ip,
    });
    res.json(GetClassTaskResponse.parse(withTaskDeadlineState(task)));
  },
);

router.post(
  "/teacher/classes/:classId/task/close",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = GetClassTaskParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const task = await db.transaction(async (tx) => {
      const [cls] = await tx
        .select({ id: classesTable.id })
        .from(classesTable)
        .where(and(
          eq(classesTable.id, params.data.classId),
          eq(classesTable.teacherId, req.teacher!.id),
        ))
        .for("update");
      if (!cls) return null;
      const [closed] = await tx
        .update(tasksTable)
        .set({ lateEditingAllowed: false, updatedAt: new Date() })
        .where(eq(tasksTable.classId, params.data.classId))
        .returning();
      return closed ?? null;
    });
    if (!task) {
      res.status(404).json({ error: "Class task not found" });
      return;
    }
    await logAudit({
      organisationId: req.teacher!.organisationId,
      teacherId: req.teacher!.id,
      action: "class_task_late_editing_closed",
      metadata: { classId: params.data.classId, dueDate: task.dueDate },
      ipAddress: req.ip,
    });
    res.json(GetClassTaskResponse.parse(withTaskDeadlineState(task)));
  },
);

function activitySeconds(row: {
  pageDurations: Partial<Record<string, number>> | null;
  startedAt: Date;
  endedAt: Date | null;
}): number {
  const pageSeconds = Object.values(row.pageDurations ?? {}).reduce<number>(
    (sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0),
    0,
  );
  if (pageSeconds > 0) return Math.round(pageSeconds);
  if (row.endedAt) return Math.max(0, Math.round((row.endedAt.getTime() - row.startedAt.getTime()) / 1000));
  return 0;
}

async function loadClassJourneyRecords(classId: number, teacherId: number): Promise<{
  classRow: {
    id: number;
    name: string;
    classJourneyAnalysisReport: unknown;
    classJourneyAnalysisStatus: string | null;
    classJourneyAnalysisGeneratedAt: Date | null;
    classJourneyAnalysisSourceHash: string | null;
    classJourneyAnalysisError: string | null;
  };
  task: { title: string } | null;
  records: ClassJourneyStudentRecord[];
}> {
  const [classRow] = await db
    .select({
      id: classesTable.id,
      name: classesTable.name,
      classJourneyAnalysisReport: classesTable.classJourneyAnalysisReport,
      classJourneyAnalysisStatus: classesTable.classJourneyAnalysisStatus,
      classJourneyAnalysisGeneratedAt: classesTable.classJourneyAnalysisGeneratedAt,
      classJourneyAnalysisSourceHash: classesTable.classJourneyAnalysisSourceHash,
      classJourneyAnalysisError: classesTable.classJourneyAnalysisError,
    })
    .from(classesTable)
    .where(and(eq(classesTable.id, classId), eq(classesTable.teacherId, teacherId)));
  if (!classRow) throw new Error("CLASS_NOT_FOUND");

  const [task] = await db
    .select({ title: tasksTable.title })
    .from(tasksTable)
    .where(eq(tasksTable.classId, classId));
  const sessions = await db
    .select({
      id: studentSessionsTable.id,
      studentName: studentSessionsTable.studentName,
      studentInsights: studentSessionsTable.studentInsights,
      answerFeedbackAttempts: studentSessionsTable.answerFeedbackAttempts,
    })
    .from(studentSessionsTable)
    .where(and(
      eq(studentSessionsTable.classId, classId),
      eq(studentSessionsTable.registrationStatus, "approved"),
      isNull(studentSessionsTable.deletionScheduledFor),
    ));
  const sessionIds = sessions.map((session) => session.id);
  const snapshots = sessionIds.length
    ? await db.select().from(developmentSnapshotsTable).where(inArray(developmentSnapshotsTable.sessionId, sessionIds))
    : [];
  const thinkingChoiceEvents = sessionIds.length
    ? await db.select({
      sessionId: thinkingChoiceEventsTable.sessionId,
      researchId: thinkingChoiceEventsTable.researchId,
      classId: thinkingChoiceEventsTable.classId,
      optionName: thinkingChoiceEventsTable.optionName,
      questionId: thinkingChoiceEventsTable.questionId,
      eventType: thinkingChoiceEventsTable.eventType,
      occurredAt: thinkingChoiceEventsTable.occurredAt,
      afterFormativeFeedback: thinkingChoiceEventsTable.afterFormativeFeedback,
      conversationTurn: thinkingChoiceEventsTable.conversationTurn,
      firstUseOrder: thinkingChoiceEventsTable.firstUseOrder,
    }).from(thinkingChoiceEventsTable).where(inArray(thinkingChoiceEventsTable.sessionId, sessionIds))
    : [];
  const activityRows = sessionIds.length
    ? await db.select({
      studentSessionId: studentActivitySessionsTable.studentSessionId,
      startedAt: studentActivitySessionsTable.startedAt,
      lastSeenAt: studentActivitySessionsTable.lastSeenAt,
      endedAt: studentActivitySessionsTable.endedAt,
      pageDurations: studentActivitySessionsTable.pageDurations,
    }).from(studentActivitySessionsTable).where(inArray(studentActivitySessionsTable.studentSessionId, sessionIds))
    : [];
  const snapshotsBySession = new Map<number, any[]>();
  for (const snapshot of snapshots) {
    snapshotsBySession.set(snapshot.sessionId, [...(snapshotsBySession.get(snapshot.sessionId) ?? []), snapshot]);
  }
  const thinkingChoicesBySession = new Map<number, typeof thinkingChoiceEvents>();
  for (const event of thinkingChoiceEvents) {
    thinkingChoicesBySession.set(event.sessionId, [...(thinkingChoicesBySession.get(event.sessionId) ?? []), event]);
  }
  const activityBySession = new Map<number, typeof activityRows>();
  for (const row of activityRows) {
    activityBySession.set(row.studentSessionId, [...(activityBySession.get(row.studentSessionId) ?? []), row]);
  }
  const feedbackRows = sessionIds.length
    ? await db.select({
      sessionId: teacherFeedbackTable.sessionId,
      stage: teacherFeedbackTable.stage,
      formativeComment: teacherFeedbackTable.formativeComment,
      studentAcknowledged: teacherFeedbackTable.studentAcknowledged,
    }).from(teacherFeedbackTable).where(and(
      inArray(teacherFeedbackTable.sessionId, sessionIds),
      ne(teacherFeedbackTable.stage, "OVERALL"),
    ))
    : [];
  const actionedStagesBySession = new Map<number, string[]>();
  for (const row of feedbackRows) {
    if (!row.studentAcknowledged || !row.formativeComment.trim()) continue;
    actionedStagesBySession.set(row.sessionId, [
      ...(actionedStagesBySession.get(row.sessionId) ?? []),
      row.stage,
    ]);
  }

  return {
    classRow,
    task: task ?? null,
    records: sessions.map((session): ClassJourneyStudentRecord => {
      const sessionSnapshots = snapshotsBySession.get(session.id) ?? [];
      const formative = sessionSnapshots.find((snapshot) => snapshot.snapshotKind === "climb_formative");
      const activity = activityBySession.get(session.id) ?? [];
      return {
        sessionId: session.id,
        studentName: session.studentName,
        studentInsights: session.studentInsights ?? {},
        snapshots: sessionSnapshots,
        answerFeedbackAttempts: session.answerFeedbackAttempts ?? [],
        formativeFeedbackActionedStages: actionedStagesBySession.get(session.id) ?? [],
        activity: {
          sessions: activity.length,
          seconds: activity.reduce((sum, row) => sum + activitySeconds(row), 0),
          afterFormative: Boolean(formative && activity.some((row) => row.lastSeenAt > formative.createdAt)),
        },
        thinkingChoiceEvents: thinkingChoicesBySession.get(session.id) ?? [],
      };
    }),
  };
}

function journeyReportWithFindings(
  deterministic: ReturnType<typeof buildClassJourneyEvidence>,
  qualitative: Awaited<ReturnType<typeof synthesiseClassJourneyAnalysis>>,
  generatedAt: string,
) {
  const {
    qualitativeEvidence: _qualitativeEvidence,
    ...report
  } = deterministic;
  return {
    ...report,
    generatedAt,
    formativeToSummativeChanges: {
      ...report.formativeToSummativeChanges,
      findings: qualitative.formativeToSummativeChanges,
    },
    responseToFormativeFeedback: {
      ...report.responseToFormativeFeedback,
      findings: qualitative.responseToFormativeFeedback,
    },
    responseToAiFeedback: {
      ...report.responseToAiFeedback,
      findings: qualitative.responseToAiFeedback,
    },
    classSimilarities: qualitative.classSimilarities,
    notableDifferences: qualitative.notableDifferences,
    reflectionAndFuturePlanning: qualitative.reflectionAndFuturePlanning,
  };
}

function csvValue(value: unknown): string {
  return `"${String(value ?? "").replace(/"/g, "\"\"")}"`;
}

function classJourneyCsv(report: Record<string, unknown>): string {
  const rows: Array<[string, string, unknown]> = [
    ["Evidence coverage", "Total students", (report.evidenceCoverage as any)?.totalStudents],
    ["Evidence coverage", "Students with both insights", (report.evidenceCoverage as any)?.studentsWithBothInsights],
    ["Evidence coverage", "Comparable students", (report.evidenceCoverage as any)?.denominator],
    ["Evidence coverage", "Awaiting comparable evidence", (report.evidenceCoverage as any)?.awaitingComparableEvidence],
    ["Formative-to-summative changes", "Changed stage counts", JSON.stringify((report.formativeToSummativeChanges as any)?.changedStageCounts ?? {})],
    ["Response to formative feedback", "Status counts", JSON.stringify((report.responseToFormativeFeedback as any)?.statusCounts ?? {})],
    ["Feedback marked as actioned", "Total", `${(report.feedbackMarkedAsActioned as any)?.total ?? 0} of ${(report.feedbackMarkedAsActioned as any)?.denominator ?? 0}`],
    ["Feedback marked as actioned", "Related later change", `${(report.feedbackMarkedAsActioned as any)?.relatedLaterChange ?? 0} of ${(report.feedbackMarkedAsActioned as any)?.denominator ?? 0}`],
    ["Feedback marked as actioned", "Partial related later change", `${(report.feedbackMarkedAsActioned as any)?.partialRelatedLaterChange ?? 0} of ${(report.feedbackMarkedAsActioned as any)?.denominator ?? 0}`],
    ["Feedback marked as actioned", "No related change found", `${(report.feedbackMarkedAsActioned as any)?.noRelatedChangeFound ?? 0} of ${(report.feedbackMarkedAsActioned as any)?.denominator ?? 0}`],
    ["Feedback marked as actioned", "Insufficient evidence", `${(report.feedbackMarkedAsActioned as any)?.insufficientEvidence ?? 0} of ${(report.feedbackMarkedAsActioned as any)?.denominator ?? 0}`],
    ["Response to AI feedback", "Status counts", JSON.stringify((report.responseToAiFeedback as any)?.statusCounts ?? {})],
    ["Activity context", "Students with activity after formative", (report.activityContext as any)?.studentsWithActivityAfterFormative],
    ["Activity context", "Total recorded sessions", (report.activityContext as any)?.totalRecordedSessions],
    ["Activity context", "Total recorded seconds", (report.activityContext as any)?.totalRecordedSeconds],
    ["Thinking Choices Across the Class", "Students by option count", JSON.stringify((report.thinkingChoicesAcrossClass as any)?.studentsByOptionCount ?? {})],
    ["Thinking Choices Across the Class", "Option popularity", JSON.stringify((report.thinkingChoicesAcrossClass as any)?.optionPopularity ?? {})],
    ["Thinking Choices Across the Class", "Most common first choice", (report.thinkingChoicesAcrossClass as any)?.mostCommonFirstChoice],
    ["Thinking Choices Across the Class", "Broadened after formative feedback", (report.thinkingChoicesAcrossClass as any)?.studentsWhoBroadenedAfterFeedback],
    ["Thinking Choices Across the Class", "Total submitted use before formative feedback", (report.thinkingChoicesAcrossClass as any)?.totalPreFeedbackUse],
    ["Thinking Choices Across the Class", "Total submitted use after formative feedback", (report.thinkingChoicesAcrossClass as any)?.totalPostFeedbackUse],
    ["Thinking Choices Across the Class", "Transitions", JSON.stringify((report.thinkingChoicesAcrossClass as any)?.transitions ?? [])],
    ["Thinking Choices Across the Class", "Immediate multi-option students", (report.thinkingChoicesAcrossClass as any)?.immediateMultiOptionStudents],
    ["Thinking Choices Across the Class", "Gradual option students", (report.thinkingChoicesAcrossClass as any)?.gradualOptionStudents],
  ];
  for (const [section, key, items] of [
    ["Formative-to-summative changes", "Finding", (report.formativeToSummativeChanges as any)?.findings],
    ["Response to formative feedback", "Finding", (report.responseToFormativeFeedback as any)?.findings],
    ["Response to AI feedback", "Finding", (report.responseToAiFeedback as any)?.findings],
    ["Class similarities", "Finding", report.classSimilarities],
    ["Notable differences", "Finding", report.notableDifferences],
    ["Reflection and future planning", "Finding", report.reflectionAndFuturePlanning],
    ["Evidence limitations", "Limitation", report.evidenceLimitations],
  ] as Array<[string, string, unknown]>) {
    if (Array.isArray(items)) items.forEach((item) => rows.push([section, key, item]));
  }
  const eventExport = (report.thinkingChoicesAcrossClass as any)?.eventExport;
  if (Array.isArray(eventExport)) {
    for (const event of eventExport) {
      rows.push([
        "Thinking Choice Events",
        "Event",
        JSON.stringify({
          researchId: event.researchId,
          classId: event.classId,
          optionName: event.optionName,
          questionId: event.questionId,
          eventType: event.eventType,
          occurredAt: event.occurredAt,
          stage: event.stage,
          conversationTurn: event.conversationTurn,
          afterFormativeFeedback: event.afterFormativeFeedback,
          firstUseOrder: event.firstUseOrder,
        }),
      ]);
    }
  }
  return [
    ["Section", "Item", "Value"].map(csvValue).join(","),
    ...rows.map((row) => row.map(csvValue).join(",")),
  ].join("\r\n");
}

router.get(
  "/teacher/classes/:classId/class-journey-analysis",
  requireTeacher,
  async (req, res): Promise<void> => {
    const classId = Number(req.params.classId);
    if (!Number.isInteger(classId)) {
      res.status(400).json({ error: "Invalid class." });
      return;
    }
    try {
      const loaded = await loadClassJourneyRecords(classId, req.teacher!.id);
      const deterministic = buildClassJourneyEvidence(loaded.records);
      res.json({
        class: { id: loaded.classRow.id, name: loaded.classRow.name },
        task: loaded.task,
        status: loaded.classRow.classJourneyAnalysisStatus ?? "not_generated",
        generatedAt: loaded.classRow.classJourneyAnalysisGeneratedAt,
        sourceHash: loaded.classRow.classJourneyAnalysisSourceHash,
        error: loaded.classRow.classJourneyAnalysisError,
        report: loaded.classRow.classJourneyAnalysisReport
          ? {
            ...(loaded.classRow.classJourneyAnalysisReport as Record<string, unknown>),
            feedbackMarkedAsActioned: deterministic.feedbackMarkedAsActioned,
          }
          : null,
        evidence: {
          ...deterministic.evidenceCoverage,
          evidenceLimitations: deterministic.evidenceLimitations,
        },
      });
    } catch (error) {
      res.status(error instanceof Error && error.message === "CLASS_NOT_FOUND" ? 404 : 500)
        .json({ error: error instanceof Error && error.message === "CLASS_NOT_FOUND" ? "Class not found." : "Class Journey Analysis is unavailable." });
    }
  },
);

router.post(
  "/teacher/classes/:classId/class-journey-analysis/generate",
  requireTeacher,
  async (req, res): Promise<void> => {
    const classId = Number(req.params.classId);
    if (!Number.isInteger(classId)) {
      res.status(400).json({ error: "Invalid class." });
      return;
    }
    const regenerate = req.body?.regenerate === true;
    try {
      const loaded = await loadClassJourneyRecords(classId, req.teacher!.id);
      if (loaded.classRow.classJourneyAnalysisStatus === "generating") {
        res.status(409).json({ error: "This Class Journey Analysis is already being generated." });
        return;
      }
      if (loaded.classRow.classJourneyAnalysisReport && !regenerate) {
        res.status(409).json({ error: "A Class Journey Analysis already exists. Confirm regeneration to make one new AI request." });
        return;
      }
      const deterministic = buildClassJourneyEvidence(loaded.records);
      if (deterministic.evidenceCoverage.denominator < 1) {
        res.status(409).json({
          error: "At least one student must have both saved Student Insights and comparable preserved formative and summative work.",
          evidence: deterministic.evidenceCoverage,
        });
        return;
      }
      const sourceHash = classJourneySourceHash(deterministic.qualitativeEvidence);
      const claimed = await db.update(classesTable).set({
        classJourneyAnalysisStatus: "generating",
        classJourneyAnalysisError: null,
      }).where(and(
        eq(classesTable.id, classId),
        eq(classesTable.teacherId, req.teacher!.id),
        or(isNull(classesTable.classJourneyAnalysisStatus), ne(classesTable.classJourneyAnalysisStatus, "generating")),
        ...(regenerate ? [] : [isNull(classesTable.classJourneyAnalysisReport)]),
      )).returning({ id: classesTable.id });
      if (!claimed.length) {
        res.status(409).json({ error: "This Class Journey Analysis changed while you were preparing it. Refresh and try again." });
        return;
      }

      let orgConfig: OrgAiConfig | null = null;
      if (req.teacher!.organisationId) {
        const [org] = await db
          .select({
            aiProvider: organisationsTable.aiProvider,
            aiKeyEncrypted: organisationsTable.aiKeyEncrypted,
            azureEndpoint: organisationsTable.azureEndpoint,
            aiDataProcessingAcknowledged: organisationsTable.aiDataProcessingAcknowledged,
            aiDataRetentionNoTrainingConfirmed: organisationsTable.aiDataRetentionNoTrainingConfirmed,
            aiSchoolPoliciesConfirmed: organisationsTable.aiSchoolPoliciesConfirmed,
            aiDataProcessingRegion: organisationsTable.aiDataProcessingRegion,
          })
          .from(organisationsTable)
          .where(eq(organisationsTable.id, req.teacher!.organisationId));
        if (org) orgConfig = org;
      }

      try {
        const qualitative = await synthesiseClassJourneyAnalysis({
          className: loaded.classRow.name,
          taskTitle: loaded.task?.title ?? "Untitled task",
          evidence: deterministic.qualitativeEvidence,
        }, orgConfig);
        const generatedAt = new Date().toISOString();
        const report = journeyReportWithFindings(deterministic, qualitative, generatedAt);
        await db.update(classesTable).set({
          classJourneyAnalysisReport: report,
          classJourneyAnalysisStatus: "complete",
          classJourneyAnalysisGeneratedAt: new Date(generatedAt),
          classJourneyAnalysisSourceHash: sourceHash,
          classJourneyAnalysisError: null,
        }).where(and(eq(classesTable.id, classId), eq(classesTable.teacherId, req.teacher!.id)));
        await logAudit({
          organisationId: req.teacher!.organisationId,
          teacherId: req.teacher!.id,
          action: "class_journey_analysis_generated",
          metadata: { classId, denominator: deterministic.evidenceCoverage.denominator, regenerate },
          ipAddress: req.ip,
        });
        res.json({ status: "complete", generatedAt, sourceHash, report });
      } catch (error) {
        await db.update(classesTable).set({
          classJourneyAnalysisStatus: "error",
          classJourneyAnalysisError: "Class Journey Analysis could not be generated. No report was replaced.",
        }).where(and(eq(classesTable.id, classId), eq(classesTable.teacherId, req.teacher!.id)));
        req.log.warn({ err: error, classId }, "Class Journey Analysis generation failed");
        res.status(502).json({ error: error instanceof Error ? error.message : "Class Journey Analysis could not be generated." });
      }
    } catch (error) {
      res.status(error instanceof Error && error.message === "CLASS_NOT_FOUND" ? 404 : 500)
        .json({ error: error instanceof Error && error.message === "CLASS_NOT_FOUND" ? "Class not found." : "Class Journey Analysis is unavailable." });
    }
  },
);

router.get(
  "/teacher/classes/:classId/class-journey-analysis/report.csv",
  requireTeacher,
  async (req, res): Promise<void> => {
    const classId = Number(req.params.classId);
    if (!Number.isInteger(classId)) { res.status(400).json({ error: "Invalid class." }); return; }
    const loaded = await loadClassJourneyRecords(classId, req.teacher!.id).catch(() => null);
    const storedReport = loaded?.classRow.classJourneyAnalysisReport;
    if (!loaded) { res.status(404).json({ error: "Class not found." }); return; }
    if (!storedReport || typeof storedReport !== "object" || Array.isArray(storedReport)) {
      res.status(404).json({ error: "Generate the Class Journey Analysis before downloading it." });
      return;
    }
    const report = {
      ...(storedReport as Record<string, unknown>),
      feedbackMarkedAsActioned: buildClassJourneyEvidence(loaded.records).feedbackMarkedAsActioned,
    };
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${loaded.classRow.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-class-journey-analysis.csv"`);
    res.send(classJourneyCsv(report as Record<string, unknown>));
  },
);

router.get(
  "/teacher/classes/:classId/class-journey-analysis/report.pdf",
  requireTeacher,
  async (req, res): Promise<void> => {
    const classId = Number(req.params.classId);
    if (!Number.isInteger(classId)) { res.status(400).json({ error: "Invalid class." }); return; }
    const loaded = await loadClassJourneyRecords(classId, req.teacher!.id).catch(() => null);
    const storedReport = loaded?.classRow.classJourneyAnalysisReport;
    if (!loaded) { res.status(404).json({ error: "Class not found." }); return; }
    if (!storedReport || typeof storedReport !== "object" || Array.isArray(storedReport)) {
      res.status(404).json({ error: "Generate the Class Journey Analysis before downloading it." });
      return;
    }
    const report = {
      ...(storedReport as Record<string, unknown>),
      feedbackMarkedAsActioned: buildClassJourneyEvidence(loaded.records).feedbackMarkedAsActioned,
    };
    const pdf = await renderClassJourneyAnalysisPdf({
      className: loaded.classRow.name,
      taskTitle: loaded.task?.title ?? "Untitled task",
      report: report as any,
    });
    res.type("application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${loaded.classRow.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-class-journey-analysis.pdf"`);
    res.send(pdf);
  },
);

router.get(
  "/teacher/classes/:classId/development-analysis",
  requireTeacher,
  async (req, res): Promise<void> => {
    const classId = Number(req.params.classId);
    const owned = await getOwnedClass(classId, req.teacher!.id);
    if (!owned) { res.status(404).json({ error: "Class not found" }); return; }
    const sessions = await db.select({
      id: studentSessionsTable.id,
      studentName: studentSessionsTable.studentName,
      answerFeedbackAttempts: studentSessionsTable.answerFeedbackAttempts,
      developmentAnalysisReport: studentSessionsTable.developmentAnalysisReport,
      developmentAnalysisStatus: studentSessionsTable.developmentAnalysisStatus,
    }).from(studentSessionsTable).where(and(
      eq(studentSessionsTable.classId, classId),
      eq(studentSessionsTable.registrationStatus, "approved"),
      isNull(studentSessionsTable.deletionScheduledFor),
    ));
    const sessionIds = sessions.map((session) => session.id);
    const snapshots = sessionIds.length > 0
      ? await db.select().from(developmentSnapshotsTable).where(inArray(developmentSnapshotsTable.sessionId, sessionIds))
      : [];
    const snapshotsBySession = new Map<number, typeof snapshots>();
    for (const snapshot of snapshots) {
      const current = snapshotsBySession.get(snapshot.sessionId) ?? [];
      current.push(snapshot);
      snapshotsBySession.set(snapshot.sessionId, current);
    }
    const records = sessions.map((session) => ({
      sessionId: session.id,
      studentName: session.studentName,
      snapshots: snapshotsBySession.get(session.id) ?? [],
      attempts: persistedTeacherAnswerFeedbackAttempts(session.answerFeedbackAttempts),
      report: session.developmentAnalysisReport,
      status: session.developmentAnalysisStatus,
    }));
    const analyses = records.map((record) => buildDevelopmentAnalysis(record.snapshots, record.attempts ?? []));
    const byKind = (kind: "climb_formative" | "climb_summative" | "answer_assessment_finalisation") =>
      analyses.filter((analysis) => analysis.snapshots.some((snapshot) => snapshot.snapshotKind === kind)).length;
    const comparableClimbs = analyses.filter((analysis) => analysis.comparisons.climb.available);
    const comparableAnswers = analyses.filter((analysis) => {
      const answers = analysis.comparisons.finalAnswers.filter((answer) => answer.answer !== null);
      return answers.length >= 2;
    });
    const aggregate = buildDevelopmentClassAggregate(records);
    res.json({
      totalEligibleStudents: sessionIds.length,
      snapshotAvailability: {
        climbFormative: byKind("climb_formative"),
        climbSummative: byKind("climb_summative"),
        answerAssessmentFinalisation: byKind("answer_assessment_finalisation"),
      },
      comparableClimbs: comparableClimbs.length,
      climbsWithChangedStages: comparableClimbs.filter((analysis) => analysis.comparisons.climb.changedStages.length > 0).length,
      studentsWithComparableAnswers: comparableAnswers.length,
      answersChanged: comparableAnswers.filter((analysis) => analysis.comparisons.answerComparisons.some((comparison) => comparison.changed)).length,
      ...aggregate,
    });
  },
);

router.get(
  "/teacher/classes/:classId/students",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = ListClassStudentsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { classId } = params.data;

    const [cls] = await db
      .select({ id: classesTable.id })
      .from(classesTable)
      .where(
        and(
          eq(classesTable.id, classId),
          eq(classesTable.teacherId, req.teacher!.id),
          isNull(classesTable.deletionScheduledFor),
        ),
      );

    if (!cls) {
      res.status(404).json({ error: "Class not found" });
      return;
    }

    const sessions = await db
      .select()
      .from(studentSessionsTable)
      .where(and(
        eq(studentSessionsTable.classId, classId),
        isNull(studentSessionsTable.deletionScheduledFor),
      ))
      .orderBy(studentSessionsTable.createdAt);

    if (sessions.length === 0) { res.json([]); return; }

    const sessionIds = sessions.map((s) => s.id);

    const allStageRows = await db
      .select({ sessionId: stageEntriesTable.sessionId, stage: stageEntriesTable.stage, contentJson: stageEntriesTable.contentJson, updatedAt: stageEntriesTable.updatedAt })
      .from(stageEntriesTable)
      .where(inArray(stageEntriesTable.sessionId, sessionIds))
      .orderBy(desc(stageEntriesTable.updatedAt));

    const msgCountRows = await db
      .select({ sessionId: chatMessagesTable.sessionId, count: sql<number>`count(*)::int` })
      .from(chatMessagesTable)
      .where(inArray(chatMessagesTable.sessionId, sessionIds))
      .groupBy(chatMessagesTable.sessionId);

    const msgCountMap = new Map<number, number>(msgCountRows.map((r) => [r.sessionId, r.count]));
    const unreadStudentMessageRows = await db
      .select({
        sessionId: teacherMessagesTable.studentSessionId,
        count: sql<number>`count(*)::int`,
      })
      .from(teacherMessagesTable)
      .where(and(
        inArray(teacherMessagesTable.studentSessionId, sessionIds),
        eq(teacherMessagesTable.senderType, "student"),
        isNull(teacherMessagesTable.teacherReadAt),
      ))
      .groupBy(teacherMessagesTable.studentSessionId);
    const unreadStudentMessageCountMap = new Map<number, number>(
      unreadStudentMessageRows.map((row) => [row.sessionId, row.count]),
    );
    const actionedFeedbackRows = await db
      .select({
        sessionId: teacherFeedbackTable.sessionId,
        stage: teacherFeedbackTable.stage,
      })
      .from(teacherFeedbackTable)
      .where(and(
        inArray(teacherFeedbackTable.sessionId, sessionIds),
        eq(teacherFeedbackTable.studentAcknowledged, true),
        sql`btrim(${teacherFeedbackTable.formativeComment}) <> ''`,
        ne(teacherFeedbackTable.stage, "OVERALL"),
      ));
    const actionedFeedbackStagesBySession = new Map<number, string[]>();
    for (const row of actionedFeedbackRows) {
      actionedFeedbackStagesBySession.set(row.sessionId, [
        ...(actionedFeedbackStagesBySession.get(row.sessionId) ?? []),
        row.stage,
      ]);
    }
    const finalisedRows = await db
      .select({ sessionId: developmentSnapshotsTable.sessionId })
      .from(developmentSnapshotsTable)
      .where(and(
        inArray(developmentSnapshotsTable.sessionId, sessionIds),
        eq(developmentSnapshotsTable.snapshotKind, "climb_summative"),
      ));
    const finalisedSessionIds = new Set(finalisedRows.map((row) => row.sessionId));

    const stageRowsBySession = new Map<number, typeof allStageRows>();
    for (const row of allStageRows) {
      const arr = stageRowsBySession.get(row.sessionId) ?? [];
      arr.push(row);
      stageRowsBySession.set(row.sessionId, arr);
    }

    const summaries = sessions.map((session) => {
      const stageRows = stageRowsBySession.get(session.id) ?? [];
      const latestStage = stageRows[0]?.stage ?? null;
      const completedStages = stageRows.map((r) => r.stage);
      const msgCount = msgCountMap.get(session.id) ?? 0;
      const stageStatuses: Record<string, "none" | "started" | "finished"> = {};
      const stageCompletionWarnings: Record<string, boolean> = {};
      for (const row of stageRows) {
        stageStatuses[row.stage] = computeStageStatus(row.stage, row.contentJson, msgCount);
        const completion = (row.contentJson as Record<string, any> | null)?._studentCompletion;
        stageCompletionWarnings[row.stage] = completion?.complete === true && completion?.sectionsMissing === true;
      }
      const isStarted = Object.values(stageStatuses).some((status) => status !== "none") || msgCount > 0;
      const hasStudentDeclaration = stageRows.some((row) => {
        const completion = (row.contentJson as Record<string, any> | null)?._studentCompletion;
        return completion && typeof completion.complete === "boolean";
      });
      const isComplete = hasStudentDeclaration
        ? ["MAP", "TORCH", "RESEARCH", "COMPASS", "EMBED"].every((stage) => {
          const row = stageRows.find((entry) => entry.stage === stage);
          return (row?.contentJson as Record<string, any> | null)?._studentCompletion?.complete === true;
        })
        : stageStatuses.EMBED === "finished";
      const finishedStageCount = Object.values(stageStatuses).filter((status) => status === "finished").length;
      const needsAttention = session.registrationStatus === "approved"
        && (!isStarted || (!isComplete && finishedStageCount <= 2));
      const attentionReason = needsAttention
        ? !isStarted
          ? "No work started"
          : `${finishedStageCount} sections completed; teaching attention needed`
        : null;
      return ListClassStudentsResponseItem.parse({
        id: session.id,
        classId: session.classId,
        studentName: session.studentName,
        registrationStatus: session.registrationStatus,
        registrationReviewedAt: session.registrationReviewedAt,
        createdAt: session.createdAt,
        lockedAt: session.lockedAt,
        lockedBy: session.lockedBy,
        isFinalised: finalisedSessionIds.has(session.id),
        archivedAt: session.archivedAt,
        retentionUntil: session.retentionUntil,
        latestStage,
        completedStages,
        stageStatuses,
        stageCompletionWarnings,
        formativeFeedbackActionedStages: actionedFeedbackStagesBySession.get(session.id) ?? [],
        needsAttention,
        attentionReason,
        unreadStudentMessageCount: unreadStudentMessageCountMap.get(session.id) ?? 0,
      });
    });

    res.json(summaries);
  },
);

router.get(
  "/teacher/classes/:classId/task",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = GetClassTaskParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { classId } = params.data;

    const [cls] = await db
      .select({ id: classesTable.id })
      .from(classesTable)
      .where(and(eq(classesTable.id, classId), eq(classesTable.teacherId, req.teacher!.id)));

    if (!cls) {
      res.status(404).json({ error: "Class not found" });
      return;
    }

    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.classId, classId));

    if (!task) {
      res.status(404).json({ error: "No task set" });
      return;
    }

    res.json(GetClassTaskResponse.parse(withTaskDeadlineState(task)));
  },
);

router.put(
  "/teacher/classes/:classId/task",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = UpsertClassTaskParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const body = UpsertClassTaskBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    if (body.data.dueDate && !isValidTaskDueDate(body.data.dueDate)) {
      res.status(400).json({ error: "Due date must be a valid calendar date." });
      return;
    }
    const task = await saveOwnedClassTask(params.data.classId, req.teacher!.id, body.data);
    if (!task) {
      res.status(404).json({ error: "Class not found" });
      return;
    }
    res.json(UpsertClassTaskResponse.parse(withTaskDeadlineState(task)));
  },
);

router.get(
  "/teacher/classes/:classId/students/:sessionId",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = GetStudentDetailParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { classId, sessionId } = params.data;

    const [cls] = await db
      .select({ id: classesTable.id })
      .from(classesTable)
      .where(
        and(
          eq(classesTable.id, classId),
          eq(classesTable.teacherId, req.teacher!.id),
          isNull(classesTable.deletionScheduledFor),
        ),
      );

    if (!cls) {
      res.status(404).json({ error: "Class not found" });
      return;
    }

    const [session] = await db
      .select()
      .from(studentSessionsTable)
      .where(
        and(
          eq(studentSessionsTable.id, sessionId),
          eq(studentSessionsTable.classId, classId),
          isNull(studentSessionsTable.deletionScheduledFor),
        ),
      );

    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const stageEntries = await db
      .select()
      .from(stageEntriesTable)
      .where(eq(stageEntriesTable.sessionId, sessionId))
      .orderBy(desc(stageEntriesTable.updatedAt));
    const actionedFeedbackRows = await db
      .select({ stage: teacherFeedbackTable.stage })
      .from(teacherFeedbackTable)
      .where(and(
        eq(teacherFeedbackTable.sessionId, sessionId),
        eq(teacherFeedbackTable.studentAcknowledged, true),
        sql`btrim(${teacherFeedbackTable.formativeComment}) <> ''`,
        ne(teacherFeedbackTable.stage, "OVERALL"),
      ));

    const latestStage = stageEntries[0]?.stage ?? null;
    const completedStages = stageEntries.map((e) => e.stage);

    const chatMessages = await db
      .select()
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.sessionId, sessionId))
      .orderBy(chatMessagesTable.createdAt);
    const answerFeedbackAttempts = persistedTeacherAnswerFeedbackAttempts(session.answerFeedbackAttempts);
    const developmentSnapshots = await db.select().from(developmentSnapshotsTable)
      .where(eq(developmentSnapshotsTable.sessionId, sessionId))
      .orderBy(asc(developmentSnapshotsTable.createdAt));
    const activityRows = await db.select({
      startedAt: studentActivitySessionsTable.startedAt,
      lastSeenAt: studentActivitySessionsTable.lastSeenAt,
      endedAt: studentActivitySessionsTable.endedAt,
      activeStage: studentActivitySessionsTable.activeStage,
      pageDurations: studentActivitySessionsTable.pageDurations,
    }).from(studentActivitySessionsTable)
      .where(eq(studentActivitySessionsTable.studentSessionId, sessionId))
      .orderBy(asc(studentActivitySessionsTable.startedAt));
    const thinkingChoiceEvents = await db.select({
      optionName: thinkingChoiceEventsTable.optionName,
      questionId: thinkingChoiceEventsTable.questionId,
      eventType: thinkingChoiceEventsTable.eventType,
      occurredAt: thinkingChoiceEventsTable.occurredAt,
      afterFormativeFeedback: thinkingChoiceEventsTable.afterFormativeFeedback,
    }).from(thinkingChoiceEventsTable)
      .where(eq(thinkingChoiceEventsTable.sessionId, sessionId))
      .orderBy(asc(thinkingChoiceEventsTable.occurredAt));
    const formativeSnapshot = developmentSnapshots.find((snapshot) => snapshot.snapshotKind === "climb_formative");
    const summativeSnapshot = developmentSnapshots.find((snapshot) => snapshot.snapshotKind === "climb_summative");
    const refreshedInsights = refreshStudentInsightEvidence(
      session.studentInsights,
      session.answerFeedbackAttempts,
      finalAnswerFromSnapshot(developmentSnapshots.find((snapshot) => snapshot.snapshotKind === "answer_assessment_finalisation") as any),
    );
    const progressInsights = progressSinceFormativeInsight(refreshedInsights, formativeSnapshot, summativeSnapshot);
    const derivedInsights = attachStudentInsightActivityComparison(
      progressInsights,
      formativeSnapshot,
      summativeSnapshot,
      activityRows,
      chatMessages,
      answerFeedbackAttempts.length,
    );
    const thinkingChoices = {
      ...analyseThinkingChoices(thinkingChoiceEvents),
      summary: thinkingChoicesText(thinkingChoiceEvents),
    };
    const attachStageEvidenceProfile = (insight: unknown, snapshot: typeof formativeSnapshot) => {
      if (!insight || typeof insight !== "object" || Array.isArray(insight)) return insight;
      const record = insight as Record<string, unknown>;
      return Array.isArray(record.stageEvidenceProfile)
        ? record
        : { ...record, stageEvidenceProfile: fallbackStageEvidenceProfile(snapshot?.payload) };
    };
    const insightsWithThinkingChoices = derivedInsights && typeof derivedInsights === "object"
      ? {
          ...(derivedInsights as Record<string, unknown>),
          formative: derivedInsights && typeof (derivedInsights as any).formative === "object"
            ? { ...attachStageEvidenceProfile((derivedInsights as any).formative, formativeSnapshot) as object, thinkingChoices }
            : (derivedInsights as any).formative,
          summative: derivedInsights && typeof (derivedInsights as any).summative === "object"
            ? { ...attachStageEvidenceProfile((derivedInsights as any).summative, summativeSnapshot) as object, thinkingChoices }
            : (derivedInsights as any).summative,
        }
      : derivedInsights;

    const msgCount = chatMessages.filter((m) => m.role === "user").length;
    const stageStatuses: Record<string, "none" | "started" | "finished"> = {};
    const stageCompletionWarnings: Record<string, boolean> = {};
    for (const entry of stageEntries) {
      stageStatuses[entry.stage] = computeStageStatus(entry.stage, entry.contentJson, msgCount);
      const completion = (entry.contentJson as Record<string, any> | null)?._studentCompletion;
      stageCompletionWarnings[entry.stage] = completion?.complete === true && completion?.sectionsMissing === true;
    }
    const [{ unreadStudentMessageCount }] = await db
      .select({ unreadStudentMessageCount: sql<number>`count(*)::int` })
      .from(teacherMessagesTable)
      .where(and(
        eq(teacherMessagesTable.studentSessionId, sessionId),
        eq(teacherMessagesTable.senderType, "student"),
        isNull(teacherMessagesTable.teacherReadAt),
      ));
    const isStarted = Object.values(stageStatuses).some((status) => status !== "none") || msgCount > 0;
    const isComplete = stageStatuses.EMBED === "finished";
    const finishedStageCount = Object.values(stageStatuses).filter((status) => status === "finished").length;
    const needsAttention = session.registrationStatus === "approved"
      && (!isStarted || (!isComplete && finishedStageCount <= 2));
    const attentionReason = needsAttention
      ? !isStarted
        ? "No work started"
        : `${finishedStageCount} sections completed; teaching attention needed`
      : null;

    res.json(
      GetStudentDetailResponse.parse({
        session: {
          id: session.id,
          classId: session.classId,
          studentName: session.studentName,
          registrationStatus: session.registrationStatus,
          registrationReviewedAt: session.registrationReviewedAt,
          createdAt: session.createdAt,
          lockedAt: session.lockedAt,
          lockedBy: session.lockedBy,
          isFinalised: Boolean(summativeSnapshot),
          archivedAt: session.archivedAt,
          retentionUntil: session.retentionUntil,
          latestStage,
          completedStages,
          stageStatuses,
          stageCompletionWarnings,
          formativeFeedbackActionedStages: actionedFeedbackRows.map((row) => row.stage),
          needsAttention,
          attentionReason,
          unreadStudentMessageCount: unreadStudentMessageCount ?? 0,
        },
        stageEntries: stageEntries.map((e) =>
          GetStudentStagesResponseItem.parse(e),
        ),
        chatMessages,
        answerFeedbackAttempts,
         developmentAnalysis: {
           ...buildDevelopmentAnalysis(developmentSnapshots, answerFeedbackAttempts),
             studentInsights: insightsWithThinkingChoices,
           latestReport: session.developmentAnalysisReport,
            latestStatus: session.developmentAnalysisReport && !isCurrentDevelopmentAnalysisReport(session.developmentAnalysisReport)
              ? "requires_regeneration"
              : session.developmentAnalysisReport
             ? "ready"
             : session.developmentAnalysisStatus ?? "missing",
           latestGeneratedAt: session.developmentAnalysisGeneratedAt,
           latestError: session.developmentAnalysisError,
           // Direct aliases keep the latest-only report easy for clients to consume.
           report: session.developmentAnalysisReport,
            status: session.developmentAnalysisReport && !isCurrentDevelopmentAnalysisReport(session.developmentAnalysisReport)
              ? "requires_regeneration"
              : session.developmentAnalysisReport
             ? "ready"
             : session.developmentAnalysisStatus ?? "missing",
           generatedAt: session.developmentAnalysisGeneratedAt,
           error: session.developmentAnalysisError,
            assessmentFinalised: developmentSnapshots.some((snapshot) => snapshot.snapshotKind === "answer_assessment_finalisation"),
         },
      }),
    );
  },
);

router.post(
  "/teacher/classes/:classId/students/:sessionId/development-analysis/analyse",
  requireTeacher,
  async (req, res): Promise<void> => {
    if (req.teacher!.isItAdmin) {
      res.status(403).json({ error: "School IT administrators do not have routine access to student development analysis." });
      return;
    }
    const classId = Number(req.params.classId);
    const sessionId = Number(req.params.sessionId);
    if (!Number.isInteger(classId) || !Number.isInteger(sessionId) || classId < 1 || sessionId < 1) {
      res.status(400).json({ error: "Invalid class or session." });
      return;
    }
    const [ownedClass] = await db.select({ id: classesTable.id }).from(classesTable).where(and(
      eq(classesTable.id, classId),
      eq(classesTable.teacherId, req.teacher!.id),
      isNull(classesTable.deletionScheduledFor),
    ));
    if (!ownedClass) {
      res.status(404).json({ error: "Class not found" });
      return;
    }
    const [session] = await db.select({
      id: studentSessionsTable.id,
      lockedAt: studentSessionsTable.lockedAt,
      archivedAt: studentSessionsTable.archivedAt,
    }).from(studentSessionsTable).where(and(
      eq(studentSessionsTable.id, sessionId),
      eq(studentSessionsTable.classId, classId),
      isNull(studentSessionsTable.deletionScheduledFor),
    ));
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (session.archivedAt) {
      res.status(409).json({ error: "Archived student records are read-only." });
      return;
    }
    if (!session.lockedAt) {
      res.status(409).json({ error: "Development analysis is available after summative assessment finalisation." });
      return;
    }
    const result = await runDevelopmentAnalysis(
      classId,
      sessionId,
      req.teacher!.organisationId,
    );
    if (result.kind === "not-eligible") {
      res.status(409).json({ error: "Development analysis is available after summative assessment finalisation." });
      return;
    }
    if (result.kind === "not-found" || !result.report) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (result.kind === "failed") {
      res.status(503).json(result.report);
      return;
    }
    res.json(result.report);
  },
);

router.get(
  "/teacher/classes/:classId/students/:sessionId/development-analysis/report.pdf",
  requireTeacher,
  async (req, res): Promise<void> => {
    if (req.teacher!.isItAdmin) {
      res.status(403).json({ error: "School IT administrators do not have routine access to student development analysis." });
      return;
    }
    const classId = Number(req.params.classId);
    const sessionId = Number(req.params.sessionId);
    if (!Number.isInteger(classId) || !Number.isInteger(sessionId) || classId < 1 || sessionId < 1) {
      res.status(400).json({ error: "Invalid class or session." });
      return;
    }
    const [ownedClass] = await db.select({ id: classesTable.id }).from(classesTable).where(and(
      eq(classesTable.id, classId),
      eq(classesTable.teacherId, req.teacher!.id),
      isNull(classesTable.deletionScheduledFor),
    ));
    if (!ownedClass) {
      res.status(404).json({ error: "Class not found" });
      return;
    }
    const [session] = await db.select({
      id: studentSessionsTable.id,
      studentName: studentSessionsTable.studentName,
      answerFeedbackAttempts: studentSessionsTable.answerFeedbackAttempts,
      developmentAnalysisReport: studentSessionsTable.developmentAnalysisReport,
      developmentAnalysisGeneratedAt: studentSessionsTable.developmentAnalysisGeneratedAt,
    }).from(studentSessionsTable).where(and(
      eq(studentSessionsTable.id, sessionId),
      eq(studentSessionsTable.classId, classId),
      isNull(studentSessionsTable.deletionScheduledFor),
    ));
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (!session.developmentAnalysisReport) {
      res.status(404).json({ error: "Generate the development report before downloading it." });
      return;
    }
    if (!isCurrentDevelopmentAnalysisReport(session.developmentAnalysisReport)) {
      res.status(409).json({ error: "This report was generated from incomplete evidence and needs to be regenerated." });
      return;
    }
    const [task, snapshots] = await Promise.all([
      db.select({ title: tasksTable.title }).from(tasksTable).where(eq(tasksTable.classId, classId)).then((rows) => rows[0]),
      db.select().from(developmentSnapshotsTable)
        .where(eq(developmentSnapshotsTable.sessionId, sessionId))
        .orderBy(asc(developmentSnapshotsTable.createdAt)),
    ]);
    const attempts = persistedTeacherAnswerFeedbackAttempts(session.answerFeedbackAttempts);
    const deterministic = buildDevelopmentAnalysis(snapshots, attempts);
    const pdf = await renderDevelopmentAnalysisPdf({
      studentName: session.studentName,
      taskTitle: task?.title ?? "Assisted Climb task",
      generatedAt: session.developmentAnalysisGeneratedAt,
      report: session.developmentAnalysisReport as any,
      comparisons: deterministic.comparisons,
    });
    const safeName = session.studentName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "student";
    res.status(200)
      .type("application/pdf")
      .set("Content-Disposition", `attachment; filename="development-report-${safeName}.pdf"`)
      .send(pdf);
  },
);

router.get(
  "/teacher/classes/:classId/students/:sessionId/activity",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = GetTeacherStudentActivityParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (req.teacher!.isItAdmin) {
      res.status(403).json({ error: "School IT administrators do not have routine access to student activity." });
      return;
    }
    const { classId, sessionId } = params.data;
    const [student] = await db
      .select({ id: studentSessionsTable.id })
      .from(studentSessionsTable)
      .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
      .where(
        and(
          eq(studentSessionsTable.id, sessionId),
          eq(studentSessionsTable.classId, classId),
          eq(classesTable.teacherId, req.teacher!.id),
        ),
      );
    if (!student) {
      res.status(404).json({ error: "Student not found" });
      return;
    }
    const rows = await db
      .select({
        id: studentActivitySessionsTable.id,
        loginSessionId: studentActivitySessionsTable.loginSessionId,
        startedAt: studentActivitySessionsTable.startedAt,
        lastSeenAt: studentActivitySessionsTable.lastSeenAt,
        endedAt: studentActivitySessionsTable.endedAt,
        activeStage: studentActivitySessionsTable.activeStage,
        pageDurations: studentActivitySessionsTable.pageDurations,
      })
      .from(studentActivitySessionsTable)
      .where(eq(studentActivitySessionsTable.studentSessionId, student.id))
      .orderBy(desc(studentActivitySessionsTable.startedAt));
    await logAudit({
      organisationId: req.teacher!.organisationId,
      teacherId: req.teacher!.id,
      action: "student_activity_viewed",
      metadata: { classId, sessionId },
    });
    res.json(GetTeacherStudentActivityResponse.parse(serialiseActivityLog(rows)));
  },
);

router.post(
  "/teacher/classes/:classId/students/:sessionId/activity/analyze",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = GetTeacherStudentActivityParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (req.teacher!.isItAdmin) {
      res.status(403).json({ error: "School IT administrators do not have routine access to student activity." });
      return;
    }
    const { classId, sessionId } = params.data;
    const [student] = await db
      .select({ id: studentSessionsTable.id })
      .from(studentSessionsTable)
      .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
      .where(and(
        eq(studentSessionsTable.id, sessionId),
        eq(studentSessionsTable.classId, classId),
        eq(classesTable.teacherId, req.teacher!.id),
      ));
    if (!student) {
      res.status(404).json({ error: "Student not found" });
      return;
    }

    const rows = await db
      .select({
        id: studentActivitySessionsTable.id,
        loginSessionId: studentActivitySessionsTable.loginSessionId,
        startedAt: studentActivitySessionsTable.startedAt,
        lastSeenAt: studentActivitySessionsTable.lastSeenAt,
        endedAt: studentActivitySessionsTable.endedAt,
        activeStage: studentActivitySessionsTable.activeStage,
        pageDurations: studentActivitySessionsTable.pageDurations,
      })
      .from(studentActivitySessionsTable)
      .where(eq(studentActivitySessionsTable.studentSessionId, student.id))
      .orderBy(desc(studentActivitySessionsTable.startedAt));
    const activity = serialiseActivityLog(rows);
    if (activity.summary.totalSessions === 0) {
      res.status(409).json({ error: "No recorded activity is available for this student yet." });
      return;
    }

    let orgConfigForActivity: OrgAiConfig | null = null;
    if (req.teacher!.organisationId) {
      const [orgRow] = await db
        .select({
          aiProvider: organisationsTable.aiProvider,
          aiKeyEncrypted: organisationsTable.aiKeyEncrypted,
          azureEndpoint: organisationsTable.azureEndpoint,
          aiDataProcessingAcknowledged: organisationsTable.aiDataProcessingAcknowledged,
          aiDataRetentionNoTrainingConfirmed: organisationsTable.aiDataRetentionNoTrainingConfirmed,
          aiSchoolPoliciesConfirmed: organisationsTable.aiSchoolPoliciesConfirmed,
          aiDataProcessingRegion: organisationsTable.aiDataProcessingRegion,
        })
        .from(organisationsTable)
        .where(eq(organisationsTable.id, req.teacher!.organisationId));
      if (orgRow) orgConfigForActivity = orgRow;
    }

    try {
      const result = await synthesiseStudentActivityInsights({
        totalSessions: activity.summary.totalSessions,
        totalSeconds: activity.summary.totalSeconds,
        averageSeconds: activity.summary.averageSeconds,
        stageStats: activity.summary.pageDurations.map((stage) => ({
          stage: stage.stage,
          totalSeconds: stage.durationSeconds,
          sharePercent: activity.summary.totalSeconds
            ? Math.round((stage.durationSeconds / activity.summary.totalSeconds) * 100)
            : 0,
        })),
        sessionDurations: activity.entries.map((entry) => entry.durationSeconds),
      }, orgConfigForActivity);
      await logAudit({
        organisationId: req.teacher!.organisationId,
        teacherId: req.teacher!.id,
        action: "student_activity_ai_analysed",
        metadata: { classId, sessionId },
        ipAddress: req.ip,
      });
      res.json({ ...result, generatedAt: new Date().toISOString() });
    } catch {
      res.status(502).json({ error: "Activity analysis is temporarily unavailable." });
    }
  },
);

router.post(
  "/teacher/classes/:classId/students/:sessionId/generate-student-insight",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = GetTeacherStudentActivityParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (req.teacher!.isItAdmin) {
      res.status(403).json({ error: "School IT administrators do not have routine access to student activity." });
      return;
    }

    const { classId, sessionId } = params.data;
    const phase = req.body?.phase === "summative" ? "summative" : req.body?.phase === "formative" ? "formative" : null;
    if (!phase) {
      res.status(400).json({ error: "Choose formative or summative insight." });
      return;
    }
    const [student] = await db
      .select()
      .from(studentSessionsTable)
      .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
      .where(and(
        eq(studentSessionsTable.id, sessionId),
        eq(studentSessionsTable.classId, classId),
        eq(classesTable.teacherId, req.teacher!.id),
      ));
    if (!student) {
      res.status(404).json({ error: "Student not found" });
      return;
    }
    if (student.student_sessions.archivedAt) {
      res.status(409).json({ error: "Archived student records cannot be used for AI insight." });
      return;
    }
    const existingInsights = student.student_sessions.studentInsights
      && typeof student.student_sessions.studentInsights === "object"
      && !Array.isArray(student.student_sessions.studentInsights)
      ? student.student_sessions.studentInsights as Record<string, unknown>
      : {};
    if (existingInsights[phase]) {
      res.status(409).json({ error: `The ${phase} Student Insight has already been generated and cannot be replaced.` });
      return;
    }
    if (phase === "formative" && student.student_sessions.lockedAt) {
      res.status(409).json({ error: "You can no longer generate a Formative Student Insight because summative assessment has been given." });
      return;
    }
    if (phase === "summative" && !existingInsights.formative) {
      res.status(409).json({ error: "You do not yet have a Formative Student Insight. Generate it before summative assessment is finalised." });
      return;
    }
    if (phase === "summative" && !student.student_sessions.lockedAt) {
      res.status(409).json({ error: "The Summative Student Insight is available after summative assessment has been given and the Climb is finalised." });
      return;
    }

    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.classId, classId));
    const stageEntries = await db
      .select()
      .from(stageEntriesTable)
      .where(eq(stageEntriesTable.sessionId, sessionId));
    const chatMessages = await db
      .select()
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.sessionId, sessionId))
      .orderBy(chatMessagesTable.createdAt);
    const insightSnapshots = await db
      .select()
      .from(developmentSnapshotsTable)
      .where(eq(developmentSnapshotsTable.sessionId, sessionId))
      .orderBy(asc(developmentSnapshotsTable.createdAt));
    const formativeSnapshot = insightSnapshots.find((snapshot) => snapshot.snapshotKind === "climb_formative");
    const summativeSnapshot = insightSnapshots.find((snapshot) => snapshot.snapshotKind === "climb_summative");
    if (phase === "summative" && (!formativeSnapshot || !summativeSnapshot)) {
      res.status(409).json({ error: "A preserved formative and summative assessment are required for a progress comparison." });
      return;
    }
    const feedbackRows = await db
      .select({
        id: teacherFeedbackTable.id,
        stage: teacherFeedbackTable.stage,
        comment: teacherFeedbackTable.formativeComment,
        studentAcknowledged: teacherFeedbackTable.studentAcknowledged,
        updatedAt: teacherFeedbackTable.updatedAt,
      })
      .from(teacherFeedbackTable)
      .where(and(
        eq(teacherFeedbackTable.sessionId, sessionId),
        ne(teacherFeedbackTable.stage, "OVERALL"),
      ));
    const activityRows = await db
      .select({
        id: studentActivitySessionsTable.id,
        loginSessionId: studentActivitySessionsTable.loginSessionId,
        startedAt: studentActivitySessionsTable.startedAt,
        lastSeenAt: studentActivitySessionsTable.lastSeenAt,
        endedAt: studentActivitySessionsTable.endedAt,
        activeStage: studentActivitySessionsTable.activeStage,
        pageDurations: studentActivitySessionsTable.pageDurations,
      })
      .from(studentActivitySessionsTable)
      .where(eq(studentActivitySessionsTable.studentSessionId, sessionId))
      .orderBy(desc(studentActivitySessionsTable.startedAt));
    const activity = serialiseActivityLog(activityRows);
    const insightActivityRows = phase === "formative" && formativeSnapshot
      ? clipActivityRows(activityRows, formativeSnapshot.createdAt, "before")
      : activityRows;
    const insightActivity = serialiseActivityLog(insightActivityRows);
    const latestFormative = feedbackRows
      .filter((feedback) => feedback.comment.trim())
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
    const acknowledgementByStage = new Map(feedbackRows.map((feedback) => [feedback.stage, feedback.studentAcknowledged]));
    const insightFormativeFeedback = phase === "summative"
      ? preservedFormativeFeedback(formativeSnapshot).map((feedback) => ({
        ...feedback,
        studentAcknowledged: acknowledgementByStage.get(feedback.stage) === true,
      }))
      : feedbackRows.map((feedback) => ({
        stage: feedback.stage,
        comment: feedback.comment,
        studentAcknowledged: feedback.studentAcknowledged,
        updatedAt: feedback.updatedAt?.toISOString() ?? null,
      })).filter((feedback) => feedback.comment.trim());
    const activityAfterLatestFormative = phase === "summative"
      ? Boolean(
        formativeSnapshot
        && activityRows.some((row) => row.lastSeenAt > formativeSnapshot.createdAt),
      )
      : Boolean(
        latestFormative && activityRows.some((row) => row.lastSeenAt > latestFormative.updatedAt),
      );
    const finalAnswerSnapshot = insightSnapshots.find((snapshot) => snapshot.snapshotKind === "answer_assessment_finalisation");
    const finalAnswer = finalAnswerSnapshot ? finalAnswerFromSnapshot(finalAnswerSnapshot as any) : null;
    const persistedAnswerOne = phase === "summative" ? persistedTeacherAnswerFeedbackAttempts(student.student_sessions.answerFeedbackAttempts) : [];
    const answerResponse = phase === "summative"
      ? {
        answerVersions: [
          { id: "answer-one", excerpt: (persistedAnswerOne[0]?.answerSnapshot ?? "").slice(0, 700) },
          { id: "answer-two", excerpt: (persistedAnswerOne[1]?.answerSnapshot ?? "").slice(0, 700) },
          { id: "final-answer", excerpt: (finalAnswer ?? "").slice(0, 700) },
        ],
        feedbackOnePoints: compactFeedbackPoints(persistedAnswerOne[0]?.feedback ?? null, "feedback-one"),
        feedbackTwoPoints: compactFeedbackPoints(persistedAnswerOne[1]?.feedback ?? null, "feedback-two"),
        evidenceReferences: compactEvidenceReferences([
          {
            from: "answer one",
            to: "answer two",
           laterText: persistedAnswerOne[1]?.answerSnapshot ?? "",
            ...compareFinalAnswers(persistedAnswerOne[0]?.answerSnapshot ?? null, persistedAnswerOne[1]?.answerSnapshot ?? null),
          },
          {
            from: "answer two",
            to: "final answer",
           laterText: finalAnswer ?? "",
            ...compareFinalAnswers(persistedAnswerOne[1]?.answerSnapshot ?? null, finalAnswer),
          },
          {
            from: "answer one",
            to: "final answer",
           laterText: finalAnswer ?? "",
            ...compareFinalAnswers(persistedAnswerOne[0]?.answerSnapshot ?? null, finalAnswer),
          },
        ]),
        formativeFeedbackAvailable: insightFormativeFeedback.length > 0,
      }
      : undefined;

    const formativePayloadEntries = Array.isArray(formativeSnapshot?.payload?.stageEntries)
      ? formativeSnapshot.payload.stageEntries as Array<{ id?: number; stage?: string; contentJson?: unknown }>
      : [];
    const formativePayloadMessages = Array.isArray(formativeSnapshot?.payload?.chatMessages)
      ? formativeSnapshot.payload.chatMessages as Array<{ id?: number; role?: string; content?: string }>
      : [];
    const insightStageEntries = phase === "formative" ? formativePayloadEntries : stageEntries;
    const insightChatMessages = phase === "formative" ? formativePayloadMessages : chatMessages;
    const stages = (["MAP", "TORCH", "RESEARCH", "COMPASS", "EMBED"] as const).map((stage) => {
      const entry = insightStageEntries.find((item) => item.stage === stage);
      const content = (entry?.contentJson ?? {}) as any;
      let text = "";
      if (stage === "MAP") {
        const parts: string[] = [];
        if (content.taskUnderstanding?.trim()) parts.push(`Task understanding: ${content.taskUnderstanding.slice(0, 500)}`);
        if (Array.isArray(content.priorKnowledge) && content.priorKnowledge.length) parts.push(`Prior knowledge: ${content.priorKnowledge.filter((item: unknown) => typeof item === "string" && item.trim()).join("; ")}`);
        if (Array.isArray(content.knowledgeGaps) && content.knowledgeGaps.length) parts.push(`Knowledge gaps: ${content.knowledgeGaps.filter((item: unknown) => typeof item === "string" && item.trim()).join("; ")}`);
        if (Array.isArray(content.enquiryQuestions) && content.enquiryQuestions.length) parts.push(`Enquiry questions: ${content.enquiryQuestions.filter((item: unknown) => typeof item === "string" && item.trim()).join("; ")}`);
        text = parts.join("\n");
      } else if (stage === "TORCH") {
        text = insightChatMessages
          .slice(0, 24)
          .map((message) => `${message.role === "user" ? "Student" : "AI"}: ${(message.content ?? "").slice(0, 400)}`)
          .join("\n");
      } else if (stage === "RESEARCH") {
        text = (Array.isArray(content.entries) ? content.entries : [])
          .filter((item: any) => item && (item.source || item.title || item.findings || item.importantPoints))
          .slice(0, 8)
          .map((item: any) => `Source: ${item.title || item.source || item.url || "untitled"}\nLearning: ${(item.findings || item.importantPoints || "").slice(0, 400)}\nReliability: ${(item.reliability || "").slice(0, 240)}\nEffect on thinking: ${(item.usage || "").slice(0, 240)}`)
          .join("\n\n");
      } else if (stage === "COMPASS") {
        text = [
          ["In own words", content.check1],
          ["Challenge", content.check2],
          ["Least confident", content.check3],
          ["Evidence balance", content.check4],
          ["Ready to write", content.check5],
        ]
          .filter(([, value]) => typeof value === "string" && value.trim())
          .map(([label, value]) => `${label}: ${value}`)
          .join("\n");
      } else {
        text = [
          ["Final answer", typeof content.finalAnswer === "string" ? finalAnswerReadableText(content.finalAnswer) : content.finalAnswer],
          ["Changed understanding", content.q1],
          ["Own thinking", content.q2],
          ["AI help reflection", content.q3],
          ["What not to trust", content.q4],
        ]
          .filter(([, value]) => typeof value === "string" && value.trim())
          .map(([label, value]) => `${label}: ${value}`)
          .join("\n");
      }
      const completion = content?._studentCompletion;
      const visited = Boolean(entry);
      const markedComplete = completion?.complete === true;
      const substantiveEvidenceRecorded = Boolean(text.trim());
      return {
        stage,
        visited,
        markedComplete,
        substantiveEvidenceRecorded,
        content: text || "No substantive recorded evidence is available for this stage.",
      };
    });

    const numericIds = (items: unknown[]) => items.flatMap((item) => {
      if (!item || typeof item !== "object" || !("id" in item)) return [];
      const id = (item as { id?: unknown }).id;
      return typeof id === "number" ? [id] : [];
    });
    const researchContent = insightStageEntries.find((item) => item.stage === "RESEARCH")?.contentJson as { entries?: unknown[] } | undefined;
    const researchEntries = Array.isArray(researchContent?.entries) ? researchContent.entries : [];
    const answerSourceLengths = phase === "summative"
      ? [
        persistedAnswerOne[0]?.answerSnapshot?.length ?? 0,
        persistedAnswerOne[1]?.answerSnapshot?.length ?? 0,
        finalAnswer?.length ?? 0,
      ]
      : [];
    const evidenceBoundary = {
      statement: "This insight uses recorded stage work, AI conversations, activity sessions, feedback records, and saved responses available at the insight point. Some content was excerpted before analysis; absence of recorded evidence does not confirm that an activity did not occur.",
      messages: {
        available: insightChatMessages.length,
        supplied: Math.min(insightChatMessages.length, 24),
        maxItems: 24,
        maxCharactersPerMessage: 400,
        limited: insightChatMessages.length > 24 || insightChatMessages.some((message) => (message.content ?? "").length > 400),
      },
      researchEntries: {
        available: researchEntries.length,
        supplied: Math.min(researchEntries.length, 8),
        maxItems: 8,
        limited: researchEntries.length > 8,
      },
      stageEvidence: {
        maxCharactersPerStage: 2_400,
        limited: stages.some((stage) => stage.content.length >= 2_400),
      },
      answers: {
        available: answerSourceLengths.filter((length) => length > 0).length,
        maxCharactersPerAnswerExcerpt: 700,
        limited: answerSourceLengths.some((length) => length > 700),
      },
      feedback: {
        maxCharactersPerComment: 900,
        limited: insightFormativeFeedback.some((feedback) => feedback.comment.length > 900),
      },
      supportingMaterialsExcludedFromProviderPayload: true,
    };
    const sectionLabels: Record<string, string> = {
      MAP: "MAP",
      TORCH: "TORCH",
      RESEARCH: "Research",
      COMPASS: "COMPASS",
      EMBED: "Final Answer",
    };
    const activitySectionTiming = insightActivity.summary.pageDurations.map((entry) => ({
      stage: entry.stage,
      label: sectionLabels[entry.stage] ?? entry.stage,
      recordedSeconds: entry.durationSeconds,
    }));
    const sourceRecordIds = {
      formativeSnapshotId: formativeSnapshot?.id ?? null,
      summativeSnapshotId: summativeSnapshot?.id ?? null,
      answerAssessmentFinalisationSnapshotId: finalAnswerSnapshot?.id ?? null,
      stageEntryIds: numericIds(insightStageEntries),
      chatMessageIds: numericIds(insightChatMessages),
      activitySessionIds: activityRows.map((row) => row.id),
      teacherFeedbackIds: feedbackRows.map((row) => row.id),
    };

    let orgConfigForInsight: OrgAiConfig | null = null;
    if (req.teacher!.organisationId) {
      const [orgRow] = await db
        .select({
          aiProvider: organisationsTable.aiProvider,
          aiKeyEncrypted: organisationsTable.aiKeyEncrypted,
          azureEndpoint: organisationsTable.azureEndpoint,
          aiDataProcessingAcknowledged: organisationsTable.aiDataProcessingAcknowledged,
          aiDataRetentionNoTrainingConfirmed: organisationsTable.aiDataRetentionNoTrainingConfirmed,
          aiSchoolPoliciesConfirmed: organisationsTable.aiSchoolPoliciesConfirmed,
          aiDataProcessingRegion: organisationsTable.aiDataProcessingRegion,
        })
        .from(organisationsTable)
        .where(eq(organisationsTable.id, req.teacher!.organisationId));
      if (orgRow) orgConfigForInsight = orgRow;
    }
    try {
      const result = await synthesiseStudentInsight({
        phase,
        studentName: student.student_sessions.studentName,
        taskTitle: task?.title ?? "Untitled task",
        taskQuestion: task?.question ?? "",
        frameworkContext: {
          learningFramework: task?.learningFramework,
          bloomLevels: (task?.bloomLevels as string[] | null) ?? [],
          knowledgeDimensions: (task?.knowledgeDimensions as string[] | null) ?? [],
        },
        stages,
        activity: {
          totalSessions: insightActivity.summary.totalSessions,
          totalSeconds: insightActivity.summary.totalSeconds,
          averageSeconds: insightActivity.summary.averageSeconds,
          stageStats: insightActivity.summary.pageDurations.map((stage) => ({
            stage: stage.stage,
            totalSeconds: stage.durationSeconds,
            sharePercent: insightActivity.summary.totalSeconds
              ? Math.round((stage.durationSeconds / insightActivity.summary.totalSeconds) * 100)
              : 0,
          })),
          activityAfterLatestFormative,
        },
        aiUsage: {
          studentMessages: insightChatMessages.filter((message) => message.role === "user").length,
          assistantMessages: insightChatMessages.filter((message) => message.role === "assistant").length,
        },
         formativeFeedback: insightFormativeFeedback,
         savedFormativeInsight: phase === "summative" ? {
           generatedAt: typeof (existingInsights.formative as any)?.generatedAt === "string"
             ? (existingInsights.formative as any).generatedAt
             : null,
           strengths: Array.isArray((existingInsights.formative as any)?.strengths)
             ? (existingInsights.formative as any).strengths.slice(0, 3)
             : [],
           developmentNeeds: Array.isArray((existingInsights.formative as any)?.nextSteps)
             ? (existingInsights.formative as any).nextSteps.slice(0, 3)
             : [],
           cautions: Array.isArray((existingInsights.formative as any)?.cautions)
             ? (existingInsights.formative as any).cautions.slice(0, 2)
             : [],
         } : undefined,
         answerResponse,
        progression: phase === "summative" ? (() => {
          const comparison = compareClimbSnapshots(formativeSnapshot as any, summativeSnapshot as any);
          const formativeMessages = Array.isArray(formativeSnapshot?.payload?.chatMessages)
            ? formativeSnapshot.payload.chatMessages
            : [];
          const summativeMessages = Array.isArray(summativeSnapshot?.payload?.chatMessages)
            ? summativeSnapshot.payload.chatMessages
            : [];
          return {
            comparisonAvailable: comparison.available,
            formativeGeneratedAt: (existingInsights.formative as any)?.generatedAt ?? formativeSnapshot?.createdAt?.toISOString() ?? null,
            changedStages: comparison.changedStageDetails ?? [],
            unchangedStages: comparison.unchangedStages ?? [],
            sourceChanges: comparison.sourceChanges ?? {},
            additionalTorchInteractions: comparison.torchInteractions?.added ?? [],
            additionalStudentAiMessages: Math.max(0,
              summativeMessages.filter((message: any) => message?.role === "user").length
              - formativeMessages.filter((message: any) => message?.role === "user").length),
            additionalAssistantAiMessages: Math.max(0,
              summativeMessages.filter((message: any) => message?.role === "assistant").length
              - formativeMessages.filter((message: any) => message?.role === "assistant").length),
          };
        })() : undefined,
      }, orgConfigForInsight);
      const generatedAt = new Date().toISOString();
      const generatedInsight = {
        ...result,
        ...(phase === "summative" ? {
          formativeFeedbackConclusions: (result.formativeFeedbackConclusions ?? []).map((conclusion) => {
            const feedback = insightFormativeFeedback.find((item) => item.stage === conclusion.feedbackStage);
            return {
              ...conclusion,
              feedback: feedback?.comment ?? "",
              studentAcknowledged: feedback?.studentAcknowledged === true,
            };
          }),
          teacherReviewNotes: (result.formativeFeedbackConclusions ?? [])
            .filter((conclusion) =>
              conclusion.status === "no_related_change"
              && insightFormativeFeedback.some((feedback) =>
                feedback.stage === conclusion.feedbackStage && feedback.studentAcknowledged === true),
            )
            .map(() => "Teacher review: The student marked this feedback as actioned, but no related change was found in the recorded later work."),
        } : {}),
        ...(phase === "summative" && result.responseToAiFeedback
          ? { responseToAiFeedback: joinStudentInsightResponse(result.responseToAiFeedback, answerResponse as any) }
          : {}),
        phase,
        purposeVersion: "journey-v2",
        generatedAt,
        provenance: {
          phase,
          generatedAt,
          promptVersion: result.promptVersion,
          aiProvider: result.aiProvider,
          model: result.model,
          formativeSnapshotId: sourceRecordIds.formativeSnapshotId,
          summativeSnapshotId: sourceRecordIds.summativeSnapshotId,
          sourceRecordIds,
        },
        evidenceBoundary,
        stageEvidenceProfile: stages.map((stage) => {
          const assessment = result.stageAssessments.find((item) => item.stage === stage.stage);
          return {
            stage: stage.stage,
            visited: stage.visited,
            markedComplete: stage.markedComplete,
            substantiveEvidenceRecorded: stage.substantiveEvidenceRecorded,
            learningEvidenceStatus: assessment?.learningEvidenceStatus ?? "not_assessable",
            learningEvidence: assessment?.evidence ?? "Learning evidence was not separately assessed in this saved report.",
          };
        }),
        activitySectionTiming,
        metrics: {
          totalSessions: insightActivity.summary.totalSessions,
          totalSeconds: insightActivity.summary.totalSeconds,
          averageSeconds: insightActivity.summary.averageSeconds,
          loginSessionsAvailable: insightActivity.summary.loginSessionsAvailable,
          loginSessionCount: insightActivity.summary.loginSessionCount,
          averageLoginSessionSeconds: insightActivity.summary.averageLoginSessionSeconds,
          longestLoginSessionSeconds: insightActivity.summary.longestLoginSessionSeconds,
          studentMessages: insightChatMessages.filter((message) => message.role === "user").length,
          assistantMessages: insightChatMessages.filter((message) => message.role === "assistant").length,
          activityAfterLatestFormative,
        },
        ...(phase === "summative" ? {
          activityComparison: buildStudentInsightActivityComparison(
            formativeSnapshot,
            summativeSnapshot,
            activityRows,
            chatMessages,
            persistedAnswerOne.length,
            typeof (existingInsights.formative as any)?.generatedAt === "string"
              ? (existingInsights.formative as any).generatedAt
              : null,
          ),
        } : {}),
      };
       if (phase === "summative" && (!hasVerifiedSummativeStudentInsight(generatedInsight, answerResponse as any)
         || !hasCompleteStudentInsightFeedbackCoverage(generatedInsight, answerResponse as any))) {
         throw new Error("Summative Student Insight did not pass the Response to AI feedback verification.");
       }
      const saved = await db.update(studentSessionsTable)
        .set({ studentInsights: { ...existingInsights, [phase]: generatedInsight } })
        .where(and(
          eq(studentSessionsTable.id, sessionId),
          sql`${studentSessionsTable.studentInsights} -> ${phase} IS NULL`,
        ))
        .returning({ id: studentSessionsTable.id });
      if (!saved.length) {
        res.status(409).json({ error: `The ${phase} Student Insight has already been generated and cannot be replaced.` });
        return;
      }
      await logAudit({
        organisationId: req.teacher!.organisationId,
        teacherId: req.teacher!.id,
        action: "student_insight_generated",
        metadata: { classId, sessionId, phase },
        ipAddress: req.ip,
      });
      res.json(generatedInsight);
    } catch (error: any) {
      if (error instanceof StudentInsightTruncationError) {
        res.status(502).json({ error: error.message });
        return;
      }
      req.log.error({
        err: {
          name: typeof error?.name === "string" ? error.name : "Error",
          message: typeof error?.message === "string" ? error.message : "Unknown Student Insight failure",
        },
        classId,
        sessionId,
        phase,
      }, "Student Insight generation failed");
      res.status(502).json({ error: "Student insight is temporarily unavailable." });
    }
  },
);

router.get(
  "/teacher/classes/:classId/students/:sessionId/student-insight/:phase/report.pdf",
  requireTeacher,
  async (req, res): Promise<void> => {
    if (req.teacher!.isItAdmin) {
      res.status(403).json({ error: "School IT administrators do not have routine access to Student Insights." });
      return;
    }
    const classId = Number(req.params.classId);
    const sessionId = Number(req.params.sessionId);
    const phase = req.params.phase === "formative" || req.params.phase === "summative"
      ? req.params.phase
      : null;
    if (!Number.isInteger(classId) || !Number.isInteger(sessionId) || !phase) {
      res.status(400).json({ error: "Invalid class, session, or Student Insight phase." });
      return;
    }
    const [student] = await db
      .select({
        studentName: studentSessionsTable.studentName,
        studentInsights: studentSessionsTable.studentInsights,
        answerFeedbackAttempts: studentSessionsTable.answerFeedbackAttempts,
      })
      .from(studentSessionsTable)
      .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
      .where(and(
        eq(studentSessionsTable.id, sessionId),
        eq(studentSessionsTable.classId, classId),
        eq(classesTable.teacherId, req.teacher!.id),
        isNull(studentSessionsTable.deletionScheduledFor),
      ));
    if (!student) {
      res.status(404).json({ error: "Student not found." });
      return;
    }
    const insights = student.studentInsights && typeof student.studentInsights === "object"
      ? student.studentInsights as Record<string, unknown>
      : {};
    const reportSnapshots = await db.select().from(developmentSnapshotsTable)
      .where(eq(developmentSnapshotsTable.sessionId, sessionId));
    const reportActivity = phase === "summative"
      ? await db.select({
        startedAt: studentActivitySessionsTable.startedAt,
        lastSeenAt: studentActivitySessionsTable.lastSeenAt,
        endedAt: studentActivitySessionsTable.endedAt,
        activeStage: studentActivitySessionsTable.activeStage,
        pageDurations: studentActivitySessionsTable.pageDurations,
      }).from(studentActivitySessionsTable)
        .where(eq(studentActivitySessionsTable.studentSessionId, sessionId))
        .orderBy(asc(studentActivitySessionsTable.startedAt))
      : [];
    const reportThinkingChoiceEvents = await db.select({
      optionName: thinkingChoiceEventsTable.optionName,
      questionId: thinkingChoiceEventsTable.questionId,
      eventType: thinkingChoiceEventsTable.eventType,
      occurredAt: thinkingChoiceEventsTable.occurredAt,
      afterFormativeFeedback: thinkingChoiceEventsTable.afterFormativeFeedback,
      conversationTurn: thinkingChoiceEventsTable.conversationTurn,
      firstUseOrder: thinkingChoiceEventsTable.firstUseOrder,
    }).from(thinkingChoiceEventsTable)
      .where(eq(thinkingChoiceEventsTable.sessionId, sessionId))
      .orderBy(asc(thinkingChoiceEventsTable.occurredAt));
    const finalisationSnapshot = reportSnapshots.find((snapshot) => snapshot.snapshotKind === "answer_assessment_finalisation");
    const formativeSnapshot = reportSnapshots.find((snapshot) => snapshot.snapshotKind === "climb_formative");
    const summativeSnapshot = reportSnapshots.find((snapshot) => snapshot.snapshotKind === "climb_summative");
    const hydratedInsights = phase === "summative"
      ? attachStudentInsightActivityComparison(
        progressSinceFormativeInsight(
        refreshStudentInsightEvidence(insights, student.answerFeedbackAttempts, finalAnswerFromSnapshot(finalisationSnapshot as any)),
        formativeSnapshot,
        summativeSnapshot,
        ),
        formativeSnapshot,
        summativeSnapshot,
        reportActivity,
        Array.isArray(summativeSnapshot?.payload?.chatMessages) ? summativeSnapshot.payload.chatMessages : [],
        persistedTeacherAnswerFeedbackAttempts(student.answerFeedbackAttempts).length,
      )
      : insights;
    const storedInsight = (hydratedInsights as Record<string, unknown>)[phase];
    if (!storedInsight || typeof storedInsight !== "object" || Array.isArray(storedInsight)) {
      res.status(404).json({ error: `Generate the ${phase} Student Insight before downloading it.` });
      return;
    }
    const insightSnapshot = phase === "formative" ? formativeSnapshot : summativeSnapshot;
    const insight = {
      ...(storedInsight as Record<string, unknown>),
      ...(!Array.isArray((storedInsight as Record<string, unknown>).stageEvidenceProfile)
        ? { stageEvidenceProfile: fallbackStageEvidenceProfile(insightSnapshot?.payload) }
        : {}),
      thinkingChoices: {
        ...analyseThinkingChoices(reportThinkingChoiceEvents),
        summary: thinkingChoicesText(reportThinkingChoiceEvents),
      },
    };
    const [task] = await db.select({ title: tasksTable.title }).from(tasksTable).where(eq(tasksTable.classId, classId));
    const pdf = await renderStudentInsightPdf({
      studentName: student.studentName,
      taskTitle: task?.title ?? "Assisted Climb task",
      insight: insight as any,
    });
    const safeName = student.studentName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "student";
    res.status(200)
      .type("application/pdf")
      .set("Content-Disposition", `attachment; filename="${phase}-student-insight-${safeName}.pdf"`)
      .send(pdf);
  },
);

router.post(
  "/teacher/classes/:classId/students/:sessionId/reset-pin",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = ResetStudentPinParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { classId, sessionId } = params.data;

    const [cls] = await db
      .select({ id: classesTable.id })
      .from(classesTable)
      .where(
        and(
          eq(classesTable.id, classId),
          eq(classesTable.teacherId, req.teacher!.id),
        ),
      );

    if (!cls) {
      res.status(404).json({ error: "Class not found" });
      return;
    }

    const [session] = await db
      .select({ id: studentSessionsTable.id })
      .from(studentSessionsTable)
      .where(
        and(
          eq(studentSessionsTable.id, sessionId),
          eq(studentSessionsTable.classId, classId),
        ),
      );

    if (!session) {
      res.status(404).json({ error: "Student not found" });
      return;
    }

    await db
      .update(studentSessionsTable)
      .set({
        pinHash: null,
        failedPinAttempts: 0,
        pinLockedUntil: null,
        sessionNonce: randomUUID(),
      })
      .where(eq(studentSessionsTable.id, sessionId));

    await logAudit({
      organisationId: req.teacher!.organisationId,
      teacherId: req.teacher!.id,
      action: "student_pin_reset",
      metadata: { classId, sessionId },
      ipAddress: req.ip,
    });
    res.status(204).end();
  },
);

router.post(
  "/teacher/classes/:classId/students/:sessionId/unlock-pin",
  requireTeacher,
  async (req, res): Promise<void> => {
    const classId = Number(req.params.classId);
    const sessionId = Number(req.params.sessionId);
    if (isNaN(classId) || isNaN(sessionId)) {
      res.status(400).json({ error: "Invalid IDs" });
      return;
    }

    const [cls] = await db
      .select({ id: classesTable.id })
      .from(classesTable)
      .where(and(eq(classesTable.id, classId), eq(classesTable.teacherId, req.teacher!.id)));

    if (!cls) {
      res.status(404).json({ error: "Class not found" });
      return;
    }

    const [session] = await db
      .select({ id: studentSessionsTable.id })
      .from(studentSessionsTable)
      .where(and(eq(studentSessionsTable.id, sessionId), eq(studentSessionsTable.classId, classId)));

    if (!session) {
      res.status(404).json({ error: "Student not found" });
      return;
    }

    await db
      .update(studentSessionsTable)
      .set({ failedPinAttempts: 0, pinLockedUntil: null })
      .where(eq(studentSessionsTable.id, sessionId));

    await logAudit({
      organisationId: req.teacher!.organisationId,
      teacherId: req.teacher!.id,
      action: "student_pin_unlocked",
      metadata: { classId, sessionId },
      ipAddress: req.ip,
    });
    res.json({ ok: true });
  },
);

router.post(
  "/teacher/classes/:classId/students/bulk-review",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = BulkReviewStudentRegistrationsParams.safeParse(req.params);
    const body = BulkReviewStudentRegistrationsBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Choose at least one pending student registration." });
      return;
    }
    const sessionIds = [...new Set(body.data.sessionIds)];
    const [cls] = await db
      .select({ id: classesTable.id })
      .from(classesTable)
      .where(and(
        eq(classesTable.id, params.data.classId),
        eq(classesTable.teacherId, req.teacher!.id),
        isNull(classesTable.deletionScheduledFor),
      ));
    if (!cls) {
      res.status(404).json({ error: "Class not found." });
      return;
    }

    const updatedSessionIds = await db.transaction(async (tx) => {
      const reviewedAt = new Date();
      const reviewed = await tx
        .update(studentSessionsTable)
        .set(body.data.decision === "approve"
          ? {
              registrationStatus: "approved",
              registrationReviewedAt: reviewedAt,
              registrationReviewedBy: req.teacher!.id,
            }
          : {
              registrationStatus: "rejected",
              registrationReviewedAt: reviewedAt,
              registrationReviewedBy: req.teacher!.id,
              sessionNonce: randomUUID(),
            })
        .where(and(
          eq(studentSessionsTable.classId, params.data.classId),
          inArray(studentSessionsTable.id, sessionIds),
          eq(studentSessionsTable.registrationStatus, "pending"),
          isNull(studentSessionsTable.deletionScheduledFor),
        ))
        .returning({ id: studentSessionsTable.id });

      if (reviewed.length) {
        await tx.insert(auditLogTable).values({
          organisationId: req.teacher!.organisationId,
          teacherId: req.teacher!.id,
          action: body.data.decision === "approve"
            ? "student.registrations_bulk_approved"
            : "student.registrations_bulk_rejected",
          metadata: {
            classId: params.data.classId,
            count: reviewed.length,
            requestedCount: sessionIds.length,
          },
          ipAddress: req.ip,
        });
      }
      return reviewed.map((row) => row.id);
    });

    res.json(BulkReviewStudentRegistrationsResponse.parse({
      decision: body.data.decision,
      updatedSessionIds,
    }));
  },
);

router.post(
  "/teacher/classes/:classId/students/:sessionId/approve",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = ApproveStudentRegistrationParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid class or student ID" });
      return;
    }
    const { classId, sessionId } = params.data;
    const [student] = await db
      .update(studentSessionsTable)
      .set({
        registrationStatus: "approved",
        registrationReviewedAt: new Date(),
        registrationReviewedBy: req.teacher!.id,
      })
      .where(and(
        eq(studentSessionsTable.id, sessionId),
        eq(studentSessionsTable.classId, classId),
        eq(studentSessionsTable.registrationStatus, "pending"),
        sql`EXISTS (SELECT 1 FROM classes WHERE classes.id = ${classId} AND classes.teacher_id = ${req.teacher!.id})`,
      ))
      .returning({ id: studentSessionsTable.id });
    if (!student) {
      res.status(404).json({ error: "Pending student registration not found" });
      return;
    }
    await logAudit({
      organisationId: req.teacher!.organisationId,
      teacherId: req.teacher!.id,
      action: "student_registration_approved",
      metadata: { classId, sessionId },
      ipAddress: req.ip,
    });
    res.json(ApproveStudentRegistrationResponse.parse({ ok: true, registrationStatus: "approved" }));
  },
);

router.post(
  "/teacher/classes/:classId/students/:sessionId/reject",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = RejectStudentRegistrationParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid class or student ID" });
      return;
    }
    const { classId, sessionId } = params.data;
    const [student] = await db
      .update(studentSessionsTable)
      .set({
        registrationStatus: "rejected",
        registrationReviewedAt: new Date(),
        registrationReviewedBy: req.teacher!.id,
        sessionNonce: randomUUID(),
      })
      .where(and(
        eq(studentSessionsTable.id, sessionId),
        eq(studentSessionsTable.classId, classId),
        eq(studentSessionsTable.registrationStatus, "pending"),
        sql`EXISTS (SELECT 1 FROM classes WHERE classes.id = ${classId} AND classes.teacher_id = ${req.teacher!.id})`,
      ))
      .returning({ id: studentSessionsTable.id });
    if (!student) {
      res.status(404).json({ error: "Pending student registration not found" });
      return;
    }
    await logAudit({
      organisationId: req.teacher!.organisationId,
      teacherId: req.teacher!.id,
      action: "student_registration_rejected",
      metadata: { classId, sessionId },
      ipAddress: req.ip,
    });
    res.json(RejectStudentRegistrationResponse.parse({ ok: true, registrationStatus: "rejected" }));
  },
);

router.delete(
  "/teacher/classes/:classId/students/:sessionId/rejection",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = DeleteRejectedStudentRegistrationParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid class or student ID" });
      return;
    }
    const { classId, sessionId } = params.data;
    const deleted = await db.transaction(async (tx) => {
      const [removed] = await tx
        .delete(studentSessionsTable)
        .where(and(
          eq(studentSessionsTable.id, sessionId),
          eq(studentSessionsTable.classId, classId),
          eq(studentSessionsTable.registrationStatus, "rejected"),
          sql`EXISTS (SELECT 1 FROM classes WHERE classes.id = ${classId} AND classes.teacher_id = ${req.teacher!.id})`,
        ))
        .returning({ id: studentSessionsTable.id });
      if (!removed) return null;
      await recordDeletionTombstones(tx, [{ entityType: "student_record", entityId: removed.id }]);
      await tx.insert(auditLogTable).values({
        organisationId: req.teacher!.organisationId,
        teacherId: req.teacher!.id,
        action: "student_rejected_registration_deleted",
        metadata: { classId, sessionId },
        ipAddress: req.ip,
      });
      return removed;
    });
    if (!deleted) {
      res.status(404).json({ error: "Rejected student registration not found" });
      return;
    }
    res.status(204).end();
  },
);

router.post("/teacher/classes/:classId/students/:sessionId/lock-assessment", requireTeacher, async (req, res): Promise<void> => {
  const params = classStudentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid class or student ID" });
    return;
  }
  const { classId, sessionId } = params.data;
  const locked = await db.transaction(async (tx) => {
    const [cls] = await tx.select({ id: classesTable.id })
      .from(classesTable)
      .where(and(eq(classesTable.id, classId), eq(classesTable.teacherId, req.teacher!.id)))
      .for("update");
    if (!cls) return null;
    const [student] = await tx.select({
      id: studentSessionsTable.id,
      lockedAt: studentSessionsTable.lockedAt,
      archivedAt: studentSessionsTable.archivedAt,
      deletionScheduledFor: studentSessionsTable.deletionScheduledFor,
    })
      .from(studentSessionsTable)
      .where(and(eq(studentSessionsTable.id, sessionId), eq(studentSessionsTable.classId, classId)))
      .for("update");
    if (!student) return false;
    if (student.archivedAt) return "archived" as const;
    if (student.deletionScheduledFor) return "deleting" as const;
    if (student.lockedAt) return { lockedAt: student.lockedAt };
    const [updated] = await tx.update(studentSessionsTable)
      .set({ lockedAt: new Date(), lockedBy: req.teacher!.id })
      .where(eq(studentSessionsTable.id, sessionId))
      .returning({ lockedAt: studentSessionsTable.lockedAt });
    return updated;
  });
  if (locked === null) {
    res.status(404).json({ error: "Class not found" });
    return;
  }
  if (locked === false) {
    res.status(404).json({ error: "Student not found" });
    return;
  }
  if (locked === "archived") {
    res.status(409).json({ error: "Archived student records are read-only." });
    return;
  }
  if (locked === "deleting") {
    res.status(409).json({ error: "Student records scheduled for deletion cannot be locked." });
    return;
  }
  await logAudit({ teacherId: req.teacher!.id, action: "student_assessment_locked", metadata: { classId, sessionId } });
  res.json(locked);
});

router.post("/teacher/classes/:classId/students/:sessionId/unlock-assessment", requireTeacher, async (req, res): Promise<void> => {
  const params = classStudentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid class or student ID" });
    return;
  }
  const { classId, sessionId } = params.data;
  const unlocked = await db.transaction(async (tx) => {
    const [cls] = await tx.select({ id: classesTable.id, archivedAt: classesTable.archivedAt })
      .from(classesTable)
      .where(and(
        eq(classesTable.id, classId),
        eq(classesTable.teacherId, req.teacher!.id),
        isNull(classesTable.deletionScheduledFor),
      ))
      .for("update");
    if (!cls) return { kind: "class-not-found" as const };
    if (cls.archivedAt) return { kind: "class-archived" as const };
    const [student] = await tx.select({
      id: studentSessionsTable.id,
      lockedAt: studentSessionsTable.lockedAt,
      archivedAt: studentSessionsTable.archivedAt,
      deletionScheduledFor: studentSessionsTable.deletionScheduledFor,
    })
      .from(studentSessionsTable)
      .where(and(eq(studentSessionsTable.id, sessionId), eq(studentSessionsTable.classId, classId)))
      .for("update");
    if (!student) return { kind: "student-not-found" as const };
    if (student.archivedAt) return { kind: "archived" as const };
    if (student.deletionScheduledFor) return { kind: "deleting" as const };
    const [summativeSnapshot] = await tx.select({ id: developmentSnapshotsTable.id })
      .from(developmentSnapshotsTable)
      .where(and(
        eq(developmentSnapshotsTable.sessionId, sessionId),
        eq(developmentSnapshotsTable.snapshotKind, "climb_summative"),
      ));
    if (summativeSnapshot) return { kind: "finalised" as const };
    if (!student.lockedAt) return { kind: "already-unlocked" as const };
    await tx.update(studentSessionsTable)
      .set({ lockedAt: null, lockedBy: null })
      .where(and(
        eq(studentSessionsTable.id, sessionId),
        eq(studentSessionsTable.lockedAt, student.lockedAt),
      ));
    await tx.insert(auditLogTable).values({
      organisationId: req.teacher!.organisationId,
      teacherId: req.teacher!.id,
      action: "student_assessment_unlocked",
      metadata: { classId, sessionId },
      ipAddress: req.ip,
    });
    return { kind: "unlocked" as const };
  });
  if (unlocked.kind === "class-not-found") {
    res.status(404).json({ error: "Class not found" });
    return;
  }
  if (unlocked.kind === "student-not-found") {
    res.status(404).json({ error: "Student not found" });
    return;
  }
  if (unlocked.kind === "class-archived" || unlocked.kind === "archived") {
    res.status(409).json({ error: "Archived student records are read-only." });
    return;
  }
  if (unlocked.kind === "deleting") {
    res.status(409).json({ error: "Student records scheduled for deletion cannot be unlocked." });
    return;
  }
  if (unlocked.kind === "finalised") {
    res.status(409).json({ error: "The climb is complete and cannot be unlocked." });
    return;
  }
  res.status(204).end();
});

async function configuredStudentArchiveRetentionDays(tx: any, organisationId: number | null | undefined): Promise<number> {
  return configuredArchiveRetentionDays(
    tx,
    organisationId,
    "student_learning_records",
    DEFAULT_STUDENT_RECORD_RETENTION_DAYS,
  );
}

async function configuredArchiveRetentionDays(
  tx: any,
  organisationId: number | null | undefined,
  dataCategory: (typeof RETENTION_CATEGORIES)[number],
  fallbackDays: number,
): Promise<number> {
  if (!organisationId) return fallbackDays;
  const [exception] = await tx
    .select({ retentionDays: organisationRetentionPoliciesTable.retentionDays })
    .from(organisationRetentionPoliciesTable)
    .where(and(
      eq(organisationRetentionPoliciesTable.organisationId, organisationId),
      eq(organisationRetentionPoliciesTable.dataCategory, dataCategory),
    ));
  if (exception) return exception.retentionDays;
  const [defaultPolicy] = await tx
    .select({ retentionDays: organisationRetentionDefaultsTable.retentionDays })
    .from(organisationRetentionDefaultsTable)
    .where(eq(organisationRetentionDefaultsTable.organisationId, organisationId));
  return defaultPolicy?.retentionDays ?? fallbackDays;
}

router.post("/teacher/classes/:classId/students/:sessionId/archive", requireTeacher, async (req, res): Promise<void> => {
  const params = classStudentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid class or student ID" });
    return;
  }
  const { classId, sessionId } = params.data;
  const archived = await db.transaction(async (tx) => {
    const [cls] = await tx
      .select({ id: classesTable.id })
      .from(classesTable)
      .where(and(eq(classesTable.id, classId), eq(classesTable.teacherId, req.teacher!.id)))
      .for("update");
    if (!cls) return { kind: "class-not-found" as const };
    const [student] = await tx
      .select({
        id: studentSessionsTable.id,
        studentName: studentSessionsTable.studentName,
        lockedAt: studentSessionsTable.lockedAt,
        archivedAt: studentSessionsTable.archivedAt,
        retentionUntil: studentSessionsTable.retentionUntil,
      })
      .from(studentSessionsTable)
      .where(and(eq(studentSessionsTable.id, sessionId), eq(studentSessionsTable.classId, classId)))
      .for("update");
    if (!student) return { kind: "student-not-found" as const };
    if (student.archivedAt && student.retentionUntil) {
      return {
        kind: "already-archived" as const,
        archivedAt: student.archivedAt,
        retentionUntil: student.retentionUntil,
      };
    }
    if (!student.lockedAt) return { kind: "not-finalised" as const };
    const [overallAssessment] = await tx
      .select({
        grade: teacherFeedbackTable.grade,
        comment: teacherFeedbackTable.comment,
      })
      .from(teacherFeedbackTable)
      .where(and(
        eq(teacherFeedbackTable.sessionId, student.id),
        eq(teacherFeedbackTable.stage, "OVERALL"),
      ));
    if (!overallAssessment?.grade || !overallAssessment.comment.trim()) {
      return { kind: "not-finalised" as const };
    }
    const now = new Date();
    const retentionDays = await configuredStudentArchiveRetentionDays(tx, req.teacher!.organisationId);
    const retentionUntil = new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);
    const [updated] = await tx.update(studentSessionsTable)
      .set({
        archivedAt: now,
        retentionUntil,
        archivedBy: req.teacher!.id,
      })
      .where(and(
        eq(studentSessionsTable.id, student.id),
        isNull(studentSessionsTable.archivedAt),
      ))
      .returning({
        archivedAt: studentSessionsTable.archivedAt,
        retentionUntil: studentSessionsTable.retentionUntil,
      });
    if (!updated?.archivedAt || !updated.retentionUntil) {
      return { kind: "changed" as const };
    }
    await tx
      .update(studentActivitySessionsTable)
      .set({
        endedAt: sql`${studentActivitySessionsTable.lastSeenAt}`,
        endReason: "archived",
      })
      .where(and(
        eq(studentActivitySessionsTable.studentSessionId, student.id),
        isNull(studentActivitySessionsTable.endedAt),
      ));
    await tx.insert(auditLogTable).values({
      organisationId: req.teacher!.organisationId,
      teacherId: req.teacher!.id,
      action: "student_record_archived",
      metadata: {
        classId,
        sessionId,
        studentName: student.studentName,
        retentionUntil: updated.retentionUntil.toISOString(),
        retentionDays,
      },
      ipAddress: req.ip,
    });
    return {
      kind: "archived" as const,
      archivedAt: updated.archivedAt,
      retentionUntil: updated.retentionUntil,
    };
  });
  if (archived.kind === "class-not-found") {
    res.status(404).json({ error: "Class not found" });
    return;
  }
  if (archived.kind === "student-not-found") {
    res.status(404).json({ error: "Student not found" });
    return;
  }
  if (archived.kind === "not-finalised") {
    res.status(409).json({ error: "Finalise the student's summative assessment before archiving their record." });
    return;
  }
  if (archived.kind === "changed") {
    res.status(409).json({ error: "This record changed while it was being archived. Refresh and try again." });
    return;
  }
  res.json({
    ok: true,
    archivedAt: archived.archivedAt,
    retentionUntil: archived.retentionUntil,
  });
});

router.post("/teacher/classes/:classId/students/:sessionId/restore-archive", requireTeacher, async (req, res): Promise<void> => {
  const params = classStudentParams.safeParse(req.params);
  const body = RestoreArchivedStudentBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Type RESTORE TO ACTIVE RECORDS to restore this archived student record." });
    return;
  }

  const { classId, sessionId } = params.data;
  const actor = req.teacher!;
  const orgId = actor.organisationId;
  const restored = await db.transaction(async (tx) => {
    // The policy lock serialises this lifecycle change with retention/control
    // mutations. The class and student locks below then revalidate the exact
    // ownership and lifecycle state being restored.
    if (orgId) await acquireRetentionPolicyMutationLock(tx, orgId);
    const [cls] = await tx
      .select({
        id: classesTable.id,
        teacherId: classesTable.teacherId,
        organisationId: teachersTable.organisationId,
        archivedAt: classesTable.archivedAt,
        deletionScheduledFor: classesTable.deletionScheduledFor,
      })
      .from(classesTable)
      .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
      .where(eq(classesTable.id, classId))
      .for("update");
    if (!cls) return { kind: "missing" as const };

    const isOwner = cls.teacherId === actor.id;
    const isSameOrganisationSchoolMaster = Boolean(
      actor.schoolAdminRole === "master"
      && orgId
      && cls.organisationId === orgId,
    );
    if (!isOwner && !isSameOrganisationSchoolMaster) return { kind: "missing" as const };
    if (cls.archivedAt || cls.deletionScheduledFor) return { kind: "class-lifecycle" as const };

    const [record] = await tx
      .select({
        id: studentSessionsTable.id,
        classId: studentSessionsTable.classId,
        archivedAt: studentSessionsTable.archivedAt,
        archiveExpiresAt: studentSessionsTable.archiveExpiresAt,
        archiveLifecycleStatus: studentSessionsTable.archiveLifecycleStatus,
        archiveExpiryNotifiedAt: studentSessionsTable.archiveExpiryNotifiedAt,
        retentionUntil: studentSessionsTable.retentionUntil,
        archivedBy: studentSessionsTable.archivedBy,
        deletionWarningAttemptedAt: studentSessionsTable.deletionWarningAttemptedAt,
        deletionWarningSentAt: studentSessionsTable.deletionWarningSentAt,
        deletionRequestedAt: studentSessionsTable.deletionRequestedAt,
        deletionScheduledFor: studentSessionsTable.deletionScheduledFor,
      })
      .from(studentSessionsTable)
      .where(and(
        eq(studentSessionsTable.id, sessionId),
        eq(studentSessionsTable.classId, classId),
      ))
      .for("update");
    if (!record) return { kind: "missing" as const };
    if (!record.archivedAt) return { kind: "not-archived" as const };
    if (
      record.archiveLifecycleStatus === "pending_deletion"
      || record.deletionRequestedAt
      || record.deletionScheduledFor
    ) {
      return { kind: "pending-deletion" as const };
    }

    if (orgId) {
      const controls = await tx
        .select({
          id: studentDataRequestControlsTable.id,
          kind: studentDataRequestControlsTable.kind,
          reasonCategory: studentDataRequestControlsTable.reasonCategory,
          affectedDataCategories: studentDataRequestControlsTable.affectedDataCategories,
          processingLimits: studentDataRequestControlsTable.processingLimits,
        })
        .from(studentDataRequestControlsTable)
        .where(and(
          eq(studentDataRequestControlsTable.organisationId, orgId),
          eq(studentDataRequestControlsTable.lifecycleState, "active"),
          or(
            eq(studentDataRequestControlsTable.affectedStudentSessionId, record.id),
            eq(studentDataRequestControlsTable.affectedClassId, record.classId),
          ),
        ))
        .for("update");
      const blockingControls = controls.filter((control) =>
        control.kind === "legal_hold"
        || control.kind === "safeguarding_hold"
        || control.kind === "restriction",
      );
      if (blockingControls.length) {
        return {
          kind: "controlled" as const,
          controls: blockingControls.map(({ id, kind, reasonCategory, affectedDataCategories }) => ({
            id,
            kind,
            reasonCategory,
            affectedDataCategories,
          })),
        };
      }
    }

    const now = new Date();
    const [updated] = await tx
      .update(studentSessionsTable)
      .set({
        archivedAt: null,
        archiveExpiresAt: null,
        archiveLifecycleStatus: "active",
        archiveExpiryNotifiedAt: null,
        deletionWarningAttemptedAt: null,
        deletionWarningSentAt: null,
        retentionUntil: null,
        archivedBy: null,
      })
      .where(and(
        eq(studentSessionsTable.id, record.id),
        isNotNull(studentSessionsTable.archivedAt),
        ne(studentSessionsTable.archiveLifecycleStatus, "pending_deletion"),
        isNull(studentSessionsTable.deletionRequestedAt),
        isNull(studentSessionsTable.deletionScheduledFor),
      ))
      .returning({ id: studentSessionsTable.id });
    if (!updated) return { kind: "changed" as const };

    await tx.insert(auditLogTable).values({
      organisationId: cls.organisationId,
      teacherId: actor.id,
      action: "student_record_archive_restored",
      metadata: {
        actorId: actor.id,
        classId: cls.id,
        sessionId: record.id,
        context: "student_archive_restore",
        previousArchivedAt: record.archivedAt.toISOString(),
        previousRetentionUntil: record.retentionUntil?.toISOString() ?? null,
      },
      ipAddress: req.ip,
    });
    return { kind: "restored" as const, restoredAt: now };
  });

  if (restored.kind === "missing") {
    res.status(404).json({ error: "Archived student record not found." });
    return;
  }
  if (restored.kind === "not-archived") {
    res.status(409).json({ error: "Only archived student records can be restored to active records." });
    return;
  }
  if (restored.kind === "pending-deletion") {
    res.status(409).json({ error: "Pending-deletion student records must use the deletion recovery endpoint." });
    return;
  }
  if (restored.kind === "class-lifecycle") {
    res.status(409).json({ error: "The class is archived or scheduled for deletion; this record cannot be restored." });
    return;
  }
  if (restored.kind === "controlled") {
    res.status(409).json({
      error: "Restoration is blocked by an active legal hold, safeguarding hold, or processing restriction.",
      blockReason: "active_control",
      controls: restored.controls,
    });
    return;
  }
  if (restored.kind === "changed") {
    res.status(409).json({ error: "This archived student record changed while it was being restored. Refresh and try again." });
    return;
  }
  res.json({
    ok: true,
    restored: true,
    classId,
    sessionId,
    restoredAt: restored.restoredAt,
  });
});

router.delete("/teacher/classes/:classId/students/:sessionId", requireTeacher, async (req, res): Promise<void> => {
  const params = classStudentParams.safeParse(req.params);
  const body = RecoverableDeletionBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Type DELETE to schedule this student record for deletion." });
    return;
  }
  const { classId, sessionId } = params.data;
  const lifecycle = req.teacher!.organisationId
    ? await getOrganisationLifecycleDays(req.teacher!.organisationId)
    : { archiveRetentionDays: 30, deletionRecoveryDays: 30 };
  const result = await db.transaction(async (tx) => {
    const [cls] = await tx
      .select({
        id: classesTable.id,
        deletionScheduledFor: classesTable.deletionScheduledFor,
      })
      .from(classesTable)
      .where(and(eq(classesTable.id, classId), eq(classesTable.teacherId, req.teacher!.id)))
      .for("update");
    if (!cls) return { kind: "class-missing" as const };
    if (cls.deletionScheduledFor) return { kind: "class-scheduled" as const };
    const [student] = await tx
      .select({
        id: studentSessionsTable.id,
        studentName: studentSessionsTable.studentName,
        archivedAt: studentSessionsTable.archivedAt,
        deletionScheduledFor: studentSessionsTable.deletionScheduledFor,
      })
      .from(studentSessionsTable)
      .where(and(
        eq(studentSessionsTable.id, sessionId),
        eq(studentSessionsTable.classId, classId),
      ))
      .for("update");
    if (!student) return { kind: "student-missing" as const };
    if (student.archivedAt) return { kind: "archived" as const };
    if (student.deletionScheduledFor) return { kind: "already-scheduled" as const, scheduledFor: student.deletionScheduledFor };
    const now = new Date();
    const scheduledFor = new Date(now.getTime() + lifecycle.deletionRecoveryDays * 24 * 60 * 60 * 1000);
    const [updated] = await tx
      .update(studentSessionsTable)
      .set({
        deletionRequestedAt: now,
        deletionScheduledFor: scheduledFor,
        deletionRequestedBy: req.teacher!.id,
        deletionReason: "teacher_requested",
      })
      .where(and(
        eq(studentSessionsTable.id, student.id),
        isNull(studentSessionsTable.deletionScheduledFor),
      ))
      .returning({ id: studentSessionsTable.id });
    if (!updated) return { kind: "changed" as const };
    await tx.update(studentActivitySessionsTable)
      .set({
        endedAt: sql`${studentActivitySessionsTable.lastSeenAt}`,
        endReason: "deletion_requested",
      })
      .where(and(
        eq(studentActivitySessionsTable.studentSessionId, student.id),
        isNull(studentActivitySessionsTable.endedAt),
      ));
    await tx.insert(auditLogTable).values({
      organisationId: req.teacher!.organisationId,
      teacherId: req.teacher!.id,
      action: "student_record_deletion_requested_by_teacher",
      metadata: { classId, sessionId, studentName: student.studentName, deletionScheduledFor: scheduledFor.toISOString() },
      ipAddress: req.ip,
    });
    return { kind: "scheduled" as const, scheduledFor };
  });
  if (result.kind === "class-missing" || result.kind === "student-missing") {
    res.status(404).json({ error: result.kind === "class-missing" ? "Class not found" : "Student not found" });
    return;
  }
  if (result.kind === "class-scheduled") {
    res.status(409).json({ error: "This class is already scheduled for deletion." });
    return;
  }
  if (result.kind === "archived") {
    res.status(409).json({ error: "Archived records are retained separately and cannot be deleted by a class teacher." });
    return;
  }
  if (result.kind === "changed") {
    res.status(409).json({ error: "This student record changed while deletion was being scheduled. Refresh and try again." });
    return;
  }
  res.json({
    ok: true,
    deletionScheduledFor: result.scheduledFor,
    alreadyScheduled: result.kind === "already-scheduled",
  });
});

router.post("/teacher/classes/:classId/students/:sessionId/restore-deletion", requireTeacher, async (req, res): Promise<void> => {
  const params = classStudentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid class or student ID" });
    return;
  }
  const { classId, sessionId } = params.data;
  const restored = await db.transaction(async (tx) => {
    const now = new Date();
    const [cls] = await tx
      .select({ id: classesTable.id, deletionScheduledFor: classesTable.deletionScheduledFor })
      .from(classesTable)
      .where(and(eq(classesTable.id, classId), eq(classesTable.teacherId, req.teacher!.id)))
      .for("update");
    if (!cls) return { kind: "missing" as const };
    if (cls.deletionScheduledFor && cls.deletionScheduledFor <= now) {
      return { kind: "expired" as const, deletionScheduledFor: cls.deletionScheduledFor };
    }
    if (cls.deletionScheduledFor) return { kind: "missing" as const };
    const [record] = await tx
      .select({ id: studentSessionsTable.id, deletionScheduledFor: studentSessionsTable.deletionScheduledFor })
      .from(studentSessionsTable)
      .where(and(eq(studentSessionsTable.id, sessionId), eq(studentSessionsTable.classId, classId)))
      .for("update");
    if (!record?.deletionScheduledFor) return { kind: "missing" as const };
    if (record.deletionScheduledFor <= now) {
      return { kind: "expired" as const, deletionScheduledFor: record.deletionScheduledFor };
    }
    await tx.update(studentSessionsTable).set({
      deletionRequestedAt: null,
      deletionScheduledFor: null,
      deletionRequestedBy: null,
      deletionReason: null,
    }).where(eq(studentSessionsTable.id, record.id));
    await tx.insert(auditLogTable).values({
      organisationId: req.teacher!.organisationId,
      teacherId: req.teacher!.id,
      action: "student_record_deletion_restored_by_teacher",
      metadata: { classId, sessionId },
      ipAddress: req.ip,
    });
    return { kind: "restored" as const };
  });
  if (restored.kind === "missing") {
    res.status(404).json({ error: "No pending deletion was found for this student record." });
    return;
  }
  if (restored.kind === "expired") {
    res.status(409).json({
      error: `The recovery period expired on ${restored.deletionScheduledFor.toISOString()}; this Student record was not restored.`,
      deletionScheduledFor: restored.deletionScheduledFor,
    });
    return;
  }
  res.json({ ok: true, restored: true });
});

router.get("/teacher/deletion-requests", requireTeacher, async (req, res): Promise<void> => {
  const [classes, studentRecords] = await Promise.all([
    db.select({
      id: classesTable.id,
      name: classesTable.name,
      subject: classesTable.subject,
      deletionScheduledFor: classesTable.deletionScheduledFor,
    })
      .from(classesTable)
      .where(and(
        eq(classesTable.teacherId, req.teacher!.id),
        isNotNull(classesTable.deletionScheduledFor),
      ))
      .orderBy(asc(classesTable.deletionScheduledFor)),
    db.select({
      id: studentSessionsTable.id,
      studentName: studentSessionsTable.studentName,
      classId: classesTable.id,
      className: classesTable.name,
      deletionScheduledFor: studentSessionsTable.deletionScheduledFor,
    })
      .from(studentSessionsTable)
      .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
      .where(and(
        eq(classesTable.teacherId, req.teacher!.id),
        isNull(classesTable.deletionScheduledFor),
        isNotNull(studentSessionsTable.deletionScheduledFor),
      ))
      .orderBy(asc(studentSessionsTable.deletionScheduledFor)),
  ]);
  res.json({ classes, studentRecords });
});

router.get(
  "/teacher/classes/:classId/torch-stats",
  requireTeacher,
  async (req, res): Promise<void> => {
    const classId = Number(req.params.classId);
    if (isNaN(classId)) { res.status(400).json({ error: "Invalid class ID" }); return; }

    const [cls] = await db.select({ id: classesTable.id, teacherId: classesTable.teacherId })
      .from(classesTable).where(eq(classesTable.id, classId));
    if (!cls || cls.teacherId !== req.teacher!.id) { res.status(404).json({ error: "Class not found" }); return; }

    const rows = await db
      .select({
        content: chatMessagesTable.content,
        bloomLevel: chatMessagesTable.bloomLevel,
        role: chatMessagesTable.role,
        sessionId: studentSessionsTable.id,
        studentName: studentSessionsTable.studentName,
      })
      .from(chatMessagesTable)
      .innerJoin(studentSessionsTable, eq(chatMessagesTable.sessionId, studentSessionsTable.id))
      .where(and(eq(studentSessionsTable.classId, classId), eq(chatMessagesTable.role, "user")));

    const byStudentMap = new Map<number, { sessionId: number; studentName: string; messages: { content: string; bloomLevel: string | null }[] }>();
    for (const row of rows) {
      if (!byStudentMap.has(row.sessionId)) {
        byStudentMap.set(row.sessionId, { sessionId: row.sessionId, studentName: row.studentName, messages: [] });
      }
      byStudentMap.get(row.sessionId)!.messages.push({ content: row.content, bloomLevel: row.bloomLevel });
    }

    const platformPolicy = await getPlatformRetentionDefaults();
    res.json({
      platformPolicy,
      messages: rows.map((r) => ({ content: r.content, bloomLevel: r.bloomLevel, role: r.role })),
      byStudent: Array.from(byStudentMap.values()),
    });
  },
);

// ── Teaching Insights ─────────────────────────────────────────────────────────

router.get(
  "/teacher/classes/:classId/activity",
  requireTeacher,
  async (req, res): Promise<void> => {
    const classId = Number(req.params.classId);
    if (!Number.isInteger(classId) || classId <= 0) {
      res.status(400).json({ error: "Invalid class ID" });
      return;
    }
    if (req.teacher!.isItAdmin) {
      res.status(403).json({ error: "School IT administrators do not have routine access to student activity." });
      return;
    }
    const report = await loadTeacherClassActivity(classId, req.teacher!.id);
    if (!report) {
      res.status(404).json({ error: "Class not found" });
      return;
    }
    await logAudit({
      organisationId: req.teacher!.organisationId,
      teacherId: req.teacher!.id,
      action: "class_activity_viewed",
      metadata: { classId },
      ipAddress: req.ip,
    });
    res.json(report);
  },
);

router.post(
  "/teacher/classes/:classId/activity/analyze",
  requireTeacher,
  async (req, res): Promise<void> => {
    const classId = Number(req.params.classId);
    if (!Number.isInteger(classId) || classId <= 0) {
      res.status(400).json({ error: "Invalid class ID" });
      return;
    }
    if (req.teacher!.isItAdmin) {
      res.status(403).json({ error: "School IT administrators do not have routine access to student activity." });
      return;
    }
    const report = await loadTeacherClassActivity(classId, req.teacher!.id);
    if (!report) {
      res.status(404).json({ error: "Class not found" });
      return;
    }
    if (report.summary.totalSessions === 0) {
      res.status(409).json({ error: "No recorded activity is available for this class yet." });
      return;
    }

    let orgConfigForActivity: OrgAiConfig | null = null;
    if (req.teacher!.organisationId) {
      const [orgRow] = await db
        .select({
          aiProvider: organisationsTable.aiProvider,
          aiKeyEncrypted: organisationsTable.aiKeyEncrypted,
          azureEndpoint: organisationsTable.azureEndpoint,
          aiDataProcessingAcknowledged: organisationsTable.aiDataProcessingAcknowledged,
          aiDataRetentionNoTrainingConfirmed: organisationsTable.aiDataRetentionNoTrainingConfirmed,
          aiSchoolPoliciesConfirmed: organisationsTable.aiSchoolPoliciesConfirmed,
          aiDataProcessingRegion: organisationsTable.aiDataProcessingRegion,
        })
        .from(organisationsTable)
        .where(eq(organisationsTable.id, req.teacher!.organisationId));
      if (orgRow) orgConfigForActivity = orgRow;
    }

    try {
      const result = await synthesiseClassActivityInsights({
        studentCount: report.summary.studentCount,
        activeStudentCount: report.summary.activeStudentCount,
        totalSessions: report.summary.totalSessions,
        totalSeconds: report.summary.totalSeconds,
        averageSessionSeconds: report.summary.averageSessionSeconds,
        averageStudentSeconds: report.summary.averageStudentSeconds,
        medianStudentSeconds: report.summary.medianStudentSeconds,
        stageStats: report.summary.stageStats.map((stage) => ({
          stage: stage.stage,
          totalSeconds: stage.totalSeconds,
          averageStudentSeconds: stage.averageStudentSeconds,
          sharePercent: stage.sharePercent,
        })),
        studentTotals: report.students.map((student) => student.totalSeconds),
      }, orgConfigForActivity);
      res.json({ ...result, generatedAt: new Date().toISOString() });
    } catch {
      res.status(502).json({ error: "Activity analysis is temporarily unavailable." });
    }
  },
);

router.get(
  "/teacher/classes/:classId/class-insights",
  requireTeacher,
  async (req, res): Promise<void> => {
    const classId = Number(req.params.classId);
    if (isNaN(classId)) { res.status(400).json({ error: "Invalid class ID" }); return; }

    const [cls] = await db.select({
      id: classesTable.id,
      lastInsights: classesTable.lastInsights,
      lastInsightsAt: classesTable.lastInsightsAt,
      insightsHistory: classesTable.insightsHistory,
    }).from(classesTable)
      .where(and(eq(classesTable.id, classId), eq(classesTable.teacherId, req.teacher!.id)));
    if (!cls) { res.status(404).json({ error: "Class not found" }); return; }
    const insightsHistory = normaliseClassInsightsHistory(cls.insightsHistory, cls.lastInsights, cls.lastInsightsAt);

    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.classId, classId));
    const sessions = await db.select().from(studentSessionsTable)
      .where(eq(studentSessionsTable.classId, classId));
    const sessionIds = sessions.map(s => s.id);

    if (sessionIds.length === 0) {
      res.json({ task: task ?? null, students: [], torchMessages: [], answerSamples: [], gradeDistribution: {}, assessedCount: 0, lastInsights: cls.lastInsights ?? null, lastInsightsAt: cls.lastInsightsAt ?? null, insightsHistory });
      return;
    }

    const allEntries = await db.select({ sessionId: stageEntriesTable.sessionId, stage: stageEntriesTable.stage, contentJson: stageEntriesTable.contentJson })
      .from(stageEntriesTable)
      .where(sql`${stageEntriesTable.sessionId} = ANY(${sql.raw(`ARRAY[${sessionIds.join(",")}]`)})`);

    const torchMessages = await db.select({ content: chatMessagesTable.content, sessionId: chatMessagesTable.sessionId, role: chatMessagesTable.role })
      .from(chatMessagesTable)
      .where(and(
        sql`${chatMessagesTable.sessionId} = ANY(${sql.raw(`ARRAY[${sessionIds.join(",")}]`)})`,
        eq(chatMessagesTable.role, "user"),
      ));

    const feedbackRows = await db.select().from(teacherFeedbackTable)
      .where(sql`${teacherFeedbackTable.sessionId} = ANY(${sql.raw(`ARRAY[${sessionIds.join(",")}]`)})`);

    // Index entries and message counts per session for stageStatuses computation
    const entriesBySession = new Map<number, { stage: string; contentJson: unknown }[]>();
    const answerSamples: string[] = [];
    for (const entry of allEntries) {
      const list = entriesBySession.get(entry.sessionId) ?? [];
      list.push({ stage: entry.stage, contentJson: entry.contentJson });
      entriesBySession.set(entry.sessionId, list);
      if (entry.stage === "EMBED") {
        const content = entry.contentJson as any;
        if (content?.finalAnswer) answerSamples.push(finalAnswerReadableText(content.finalAnswer));
      }
    }

    const msgCountBySession = new Map<number, number>();
    for (const m of torchMessages) {
      msgCountBySession.set(m.sessionId, (msgCountBySession.get(m.sessionId) ?? 0) + 1);
    }

    const students = sessions.map(s => {
      const entries = entriesBySession.get(s.id) ?? [];
      const msgCount = msgCountBySession.get(s.id) ?? 0;
      const stageStatuses: Record<string, "none" | "started" | "finished"> = {};
      for (const { stage, contentJson } of entries) {
        stageStatuses[stage] = computeStageStatus(stage, contentJson, msgCount);
      }
      // Stages with no entry at all are "none" (default via undefined lookup)
      return { id: s.id, studentName: s.studentName, stageStatuses };
    });

    const gradeDistribution: Record<string, Record<string, number>> = {};
    const assessedSessions = new Set<number>();
    for (const fb of feedbackRows) {
      if (fb.stage === "OVERALL" || !fb.grade) continue;
      if (!gradeDistribution[fb.stage]) gradeDistribution[fb.stage] = {};
      gradeDistribution[fb.stage][fb.grade] = (gradeDistribution[fb.stage][fb.grade] ?? 0) + 1;
      assessedSessions.add(fb.sessionId);
    }

    res.json({
      task: task ?? null,
      students,
      torchMessages,
      answerSamples,
      gradeDistribution,
      assessedCount: assessedSessions.size,
      lastInsights: cls.lastInsights ?? null,
      lastInsightsAt: cls.lastInsightsAt ?? null,
      insightsHistory,
    });
  },
);

router.post(
  "/teacher/classes/:classId/class-insights/synthesize",
  requireTeacher,
  async (req, res): Promise<void> => {
    const classId = Number(req.params.classId);
    if (isNaN(classId)) { res.status(400).json({ error: "Invalid class ID" }); return; }

    const [cls] = await db.select({ id: classesTable.id }).from(classesTable)
      .where(and(eq(classesTable.id, classId), eq(classesTable.teacherId, req.teacher!.id)));
    if (!cls) { res.status(404).json({ error: "Class not found" }); return; }

    const {
      questionTypeCounts,
      totalMessages,
      torchSamples,
      stageCompletion,
      studentCount,
      learningFramework,
      bloomLevels,
      knowledgeDimensions,
    } =
      req.body as {
        questionTypeCounts: Record<string, number>;
        totalMessages: number;
        torchSamples: string[];
        stageCompletion: Record<string, number>;
        studentCount: number;
        learningFramework?: "bloom" | "knowledge_dimensions";
        bloomLevels?: string[];
        knowledgeDimensions?: string[];
      };

    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.classId, classId));
    const sessions = await db.select({ id: studentSessionsTable.id }).from(studentSessionsTable)
      .where(eq(studentSessionsTable.classId, classId));
    const sessionIds = sessions.map(s => s.id);

    const answerSamples: string[] = [];
    const mapSamples: string[] = [];
    const compassSamples: string[] = [];

    if (sessionIds.length > 0) {
      const writtenEntries = await db.select({ stage: stageEntriesTable.stage, contentJson: stageEntriesTable.contentJson })
        .from(stageEntriesTable)
        .where(and(
          sql`${stageEntriesTable.sessionId} = ANY(${sql.raw(`ARRAY[${sessionIds.join(",")}]`)})`,
          sql`${stageEntriesTable.stage} = ANY(ARRAY['MAP','COMPASS','EMBED'])`,
        ));
      for (const e of writtenEntries) {
        const c = e.contentJson as any;
        if (e.stage === "EMBED" && c?.finalAnswer) {
          answerSamples.push(finalAnswerReadableText(c.finalAnswer));
        } else if (e.stage === "MAP") {
          const parts = [c?.taskUnderstanding, c?.priorKnowledge, c?.whatIWantToFind].filter((v): v is string => typeof v === "string" && v.trim().length > 0).map(s => s.trim());
          if (parts.length) mapSamples.push(parts.join(" | ").slice(0, 400));
        } else if (e.stage === "COMPASS") {
          const parts = [c?.check1, c?.check2, c?.check3, c?.check4, c?.check5].filter((v): v is string => typeof v === "string" && v.trim().length > 0).map(s => s.trim());
          if (parts.length) compassSamples.push(parts.join(" | ").slice(0, 500));
        }
      }
    }

    const feedbackRows = sessionIds.length > 0
      ? await db.select().from(teacherFeedbackTable)
          .where(sql`${teacherFeedbackTable.sessionId} = ANY(${sql.raw(`ARRAY[${sessionIds.join(",")}]`)})`)
      : [];

    const gradeDistribution: Record<string, Record<string, number>> = {};
    const assessedSessions = new Set<number>();
    for (const fb of feedbackRows) {
      if (fb.stage === "OVERALL" || !fb.grade) continue;
      if (!gradeDistribution[fb.stage]) gradeDistribution[fb.stage] = {};
      gradeDistribution[fb.stage][fb.grade] = (gradeDistribution[fb.stage][fb.grade] ?? 0) + 1;
      assessedSessions.add(fb.sessionId);
    }

    let orgConfigForInsights: OrgAiConfig | null = null;
    if (req.teacher!.organisationId) {
      const [orgRow] = await db
        .select({ aiProvider: organisationsTable.aiProvider, aiKeyEncrypted: organisationsTable.aiKeyEncrypted, azureEndpoint: organisationsTable.azureEndpoint, aiDataProcessingAcknowledged: organisationsTable.aiDataProcessingAcknowledged, aiDataRetentionNoTrainingConfirmed: organisationsTable.aiDataRetentionNoTrainingConfirmed, aiSchoolPoliciesConfirmed: organisationsTable.aiSchoolPoliciesConfirmed, aiDataProcessingRegion: organisationsTable.aiDataProcessingRegion })
        .from(organisationsTable)
        .where(eq(organisationsTable.id, req.teacher!.organisationId));
      if (orgRow) orgConfigForInsights = orgRow;
    }

    let result: Awaited<ReturnType<typeof synthesiseClassInsights>>;
    try {
      result = await synthesiseClassInsights({
        taskTitle: task?.title ?? "Untitled",
        taskQuestion: task?.question ?? "",
        learningFramework: task?.learningFramework ?? learningFramework ?? "bloom",
        bloomLevels: (task?.bloomLevels as string[] | null) ?? bloomLevels ?? [],
        knowledgeDimensions: (task?.knowledgeDimensions as string[] | null) ?? knowledgeDimensions ?? [],
        studentCount,
        stageCompletion,
        questionTypeCounts,
        totalMessages,
        torchSamples,
        answerSamples,
        mapSamples,
        compassSamples,
        gradeDistribution,
        assessedCount: assessedSessions.size,
      }, orgConfigForInsights);
    } catch (error) {
      const message = error instanceof Error && error.message === "Teaching Insights analysis returned incomplete structured output."
        ? "Teaching Insights analysis returned incomplete data. Please try again."
        : error instanceof Error
          ? error.message
          : "Teaching Insights analysis is temporarily unavailable. Please try again.";
      res.status(502).json({ error: message });
      return;
    }

    const generatedAt = new Date();
    const historyEntry: StoredClassInsight = {
      ...result,
      generatedAt: generatedAt.toISOString(),
    };

    // Persist the latest result and append to the history atomically so
    // concurrent insight runs cannot overwrite each other's reports.
    const persisted = await db.transaction(async (tx) => {
      const [current] = await tx.select({
        lastInsights: classesTable.lastInsights,
        lastInsightsAt: classesTable.lastInsightsAt,
        insightsHistory: classesTable.insightsHistory,
      }).from(classesTable)
        .where(and(eq(classesTable.id, classId), eq(classesTable.teacherId, req.teacher!.id)))
        .for("update");
      if (!current) return false;
      const history = normaliseClassInsightsHistory(current.insightsHistory, current.lastInsights, current.lastInsightsAt);
      await tx.update(classesTable)
        .set({
          lastInsights: result as any,
          lastInsightsAt: generatedAt,
          insightsHistory: [...history, historyEntry],
        })
        .where(eq(classesTable.id, classId));
      return true;
    });
    if (!persisted) {
      res.status(404).json({ error: "Class not found" });
      return;
    }

    res.json(historyEntry);
  },
);

// ── Teacher Feedback ──────────────────────────────────────────────────────────

router.post(
  "/teacher/classes/:classId/students/:sessionId/feedback/finalise-formative",
  requireTeacher,
  async (req, res): Promise<void> => {
    const classId = Number(req.params.classId);
    const sessionId = Number(req.params.sessionId);
    const result = await db.transaction(async (tx) => {
      const [cls] = await tx.select({ id: classesTable.id }).from(classesTable)
        .where(and(
          eq(classesTable.id, classId),
          eq(classesTable.teacherId, req.teacher!.id),
          isNull(classesTable.deletionScheduledFor),
        ))
        .for("update");
      if (!cls) return { kind: "class-not-found" as const };
      const [session] = await tx.select({ id: studentSessionsTable.id, archivedAt: studentSessionsTable.archivedAt, deletionScheduledFor: studentSessionsTable.deletionScheduledFor })
        .from(studentSessionsTable)
        .where(and(
          eq(studentSessionsTable.id, sessionId),
          eq(studentSessionsTable.classId, classId),
          isNull(studentSessionsTable.deletionScheduledFor),
        ))
        .for("update");
      if (!session) return { kind: "session-not-found" as const };
      if (session.archivedAt) return { kind: "archived" as const };
      const [existing] = await tx.select({ id: developmentSnapshotsTable.id })
        .from(developmentSnapshotsTable)
        .where(and(
          eq(developmentSnapshotsTable.sessionId, sessionId),
          eq(developmentSnapshotsTable.snapshotKind, "climb_formative"),
        ));
      if (existing) return { kind: "captured" as const, id: existing.id };
      const payload = await loadClimbSnapshotPayload(tx, sessionId);
      const [inserted] = await tx.insert(developmentSnapshotsTable).values({
        sessionId,
        snapshotKind: "climb_formative",
        payload: payload as unknown as Record<string, unknown>,
        triggerEvent: "formative_feedback_finalised",
        teacherId: req.teacher!.id,
      }).onConflictDoNothing({
        target: [developmentSnapshotsTable.sessionId, developmentSnapshotsTable.snapshotKind],
      }).returning({ id: developmentSnapshotsTable.id });
      return { kind: "captured" as const, id: inserted?.id ?? null };
    });
    if (result.kind === "class-not-found") { res.status(404).json({ error: "Class not found" }); return; }
    if (result.kind === "session-not-found") { res.status(404).json({ error: "Session not found" }); return; }
    if (result.kind === "archived") { res.status(409).json({ error: "Archived student records are read-only." }); return; }
    res.json({ ok: true, id: result.id });
  },
);

router.get(
  "/teacher/classes/:classId/students/:sessionId/feedback",
  requireTeacher,
  async (req, res): Promise<void> => {
    const { classId, sessionId } = req.params;
    const [cls] = await db.select({ id: classesTable.id }).from(classesTable)
      .where(and(
        eq(classesTable.id, Number(classId)),
        eq(classesTable.teacherId, req.teacher!.id),
        isNull(classesTable.deletionScheduledFor),
      ));
    if (!cls) { res.status(404).json({ error: "Class not found" }); return; }

    const [session] = await db.select({
      id: studentSessionsTable.id,
      lockedAt: studentSessionsTable.lockedAt,
      archivedAt: studentSessionsTable.archivedAt,
    }).from(studentSessionsTable)
      .where(and(
        eq(studentSessionsTable.id, Number(sessionId)),
        eq(studentSessionsTable.classId, Number(classId)),
        isNull(studentSessionsTable.deletionScheduledFor),
      ));
    if (!session) { res.status(404).json({ error: "Session not found" }); return; }

    const rows = await db.select().from(teacherFeedbackTable)
      .where(eq(teacherFeedbackTable.sessionId, Number(sessionId)));

    const byStage: Record<string, { grade: string | null; comment: string; formativeComment: string; studentAcknowledged: boolean }> = {};
    for (const row of rows) {
      byStage[row.stage] = {
        grade: row.grade ?? null,
        comment: row.comment,
        formativeComment: row.formativeComment,
        studentAcknowledged: row.studentAcknowledged,
      };
    }
    res.json(byStage);
  },
);

router.put(
  "/teacher/classes/:classId/students/:sessionId/feedback/:stage",
  requireTeacher,
  async (req, res): Promise<void> => {
    const classId = String(req.params.classId);
    const sessionId = String(req.params.sessionId);
    const stage = String(req.params.stage);
    const { grade, comment, formativeComment } = req.body as { grade?: string | null; comment?: string; formativeComment?: string };

    type GradeVal = "emerging" | "developing" | "secure" | "exceeding";
    const gradeVal = (grade ?? null) as GradeVal | null;
    const commentVal = comment ?? "";
    const formativeVal = formativeComment ?? "";
    const outcome = await db.transaction(async (tx) => {
      const [cls] = await tx.select({ id: classesTable.id }).from(classesTable)
        .where(and(
          eq(classesTable.id, Number(classId)),
          eq(classesTable.teacherId, req.teacher!.id),
          isNull(classesTable.deletionScheduledFor),
        ))
        .for("update");
      if (!cls) return { kind: "class-not-found" as const };
      const [session] = await tx.select({
        id: studentSessionsTable.id,
        lockedAt: studentSessionsTable.lockedAt,
        archivedAt: studentSessionsTable.archivedAt,
      }).from(studentSessionsTable)
        .where(and(
          eq(studentSessionsTable.id, Number(sessionId)),
          eq(studentSessionsTable.classId, Number(classId)),
          isNull(studentSessionsTable.deletionScheduledFor),
        ))
        .for("update");
      if (!session) return { kind: "session-not-found" as const };
      if (session.archivedAt) return { kind: "archived" as const };

      const [existing] = await tx.select({ id: teacherFeedbackTable.id }).from(teacherFeedbackTable)
        .where(and(eq(teacherFeedbackTable.sessionId, Number(sessionId)), eq(teacherFeedbackTable.stage, stage)));
      if (existing) {
        await tx.update(teacherFeedbackTable)
          .set({ grade: gradeVal, comment: commentVal, formativeComment: formativeVal, updatedAt: new Date() })
          .where(eq(teacherFeedbackTable.id, existing.id));
      } else {
        await tx.insert(teacherFeedbackTable).values({
          sessionId: Number(sessionId),
          stage,
          grade: gradeVal,
          comment: commentVal,
          formativeComment: formativeVal,
        });
      }

      let finalisedAt: Date | null = null;
      let assessmentComplete: boolean | undefined;
      let missingSummativeStages: string[] = [];
      if (stage === "OVERALL" && gradeVal && commentVal.trim()) {
         const summativeRows = await tx.select({
           stage: teacherFeedbackTable.stage,
           grade: teacherFeedbackTable.grade,
           comment: teacherFeedbackTable.comment,
         }).from(teacherFeedbackTable).where(and(
           eq(teacherFeedbackTable.sessionId, session.id),
           inArray(teacherFeedbackTable.stage, [...SUMMATIVE_FEEDBACK_STAGES]),
         ));
         const savedStages = new Map(summativeRows.map((row) => [row.stage, row]));
         missingSummativeStages = SUMMATIVE_FEEDBACK_STAGES.filter((summativeStage) => {
           const row = savedStages.get(summativeStage);
           return !row?.grade || !row.comment.trim();
         });
         assessmentComplete = missingSummativeStages.length === 0;
         if (!assessmentComplete) {
           return { kind: "updated" as const, finalisedAt: null, assessmentComplete, missingSummativeStages };
         }
        const [existingSummativeSnapshot] = await tx.select({ id: developmentSnapshotsTable.id })
          .from(developmentSnapshotsTable)
          .where(and(
            eq(developmentSnapshotsTable.sessionId, session.id),
            eq(developmentSnapshotsTable.snapshotKind, "climb_summative"),
          ));
        if (!existingSummativeSnapshot) {
          if (!session.lockedAt) {
            const [finalised] = await tx.update(studentSessionsTable)
              .set({ lockedAt: new Date(), lockedBy: req.teacher!.id })
              .where(and(
                eq(studentSessionsTable.id, session.id),
                isNull(studentSessionsTable.lockedAt),
                isNull(studentSessionsTable.archivedAt),
              ))
              .returning({ lockedAt: studentSessionsTable.lockedAt });
            finalisedAt = finalised?.lockedAt ?? null;
          } else {
            finalisedAt = session.lockedAt;
          }
          if (finalisedAt) {
            await tx.insert(auditLogTable).values({
              organisationId: req.teacher!.organisationId,
              teacherId: req.teacher!.id,
              action: "student_summative_assessment_finalised",
              metadata: { classId: Number(classId), sessionId: Number(sessionId) },
              ipAddress: req.ip,
            });
            const climbPayload = await loadClimbSnapshotPayload(tx, Number(sessionId));
            await tx.insert(developmentSnapshotsTable).values({
              sessionId: Number(sessionId),
              snapshotKind: "climb_summative",
              payload: climbPayload as unknown as Record<string, unknown>,
              triggerEvent: "assessment_finalised",
              teacherId: req.teacher!.id,
            }).onConflictDoNothing({
              target: [developmentSnapshotsTable.sessionId, developmentSnapshotsTable.snapshotKind],
            });
            const embed = (climbPayload.stageEntries as Array<Record<string, unknown>>)
              .find((entry) => entry.stage === "EMBED");
            const embedContent = embed?.contentJson;
            const finalAnswer = embedContent && typeof embedContent === "object" && !Array.isArray(embedContent)
              ? (embedContent as Record<string, unknown>).finalAnswer
              : null;
            await tx.insert(developmentSnapshotsTable).values({
              sessionId: Number(sessionId),
              snapshotKind: "answer_assessment_finalisation",
              payload: { finalAnswer: typeof finalAnswer === "string" ? finalAnswer : "", version: 3 },
              triggerEvent: "assessment_finalised",
              teacherId: req.teacher!.id,
            }).onConflictDoNothing({
              target: [developmentSnapshotsTable.sessionId, developmentSnapshotsTable.snapshotKind],
            });
          }
        }
      }
      return { kind: "updated" as const, finalisedAt, assessmentComplete, missingSummativeStages };
    });
    if (outcome.kind === "class-not-found") { res.status(404).json({ error: "Class not found" }); return; }
    if (outcome.kind === "session-not-found") { res.status(404).json({ error: "Session not found" }); return; }
    if (outcome.kind === "archived") { res.status(409).json({ error: "Archived student records are read-only." }); return; }
    // The assessment lock/snapshot transaction is already committed. The
    // consolidated Summative Student Insight owns the routine AI request.
    // Development Report data and its explicit historical route remain
    // available, but finalisation must not trigger a second AI call.
    res.json({
      ok: true,
      finalisedAt: outcome.finalisedAt,
      assessmentComplete: outcome.assessmentComplete,
      missingSummativeStages: outcome.missingSummativeStages,
    });
  },
);

router.post(
  "/teacher/classes/:classId/students/:sessionId/feedback/synthesize",
  requireTeacher,
  async (req, res): Promise<void> => {
    const { classId, sessionId } = req.params;

    const [cls] = await db.select({ id: classesTable.id }).from(classesTable)
      .where(and(eq(classesTable.id, Number(classId)), eq(classesTable.teacherId, req.teacher!.id)));
    if (!cls) { res.status(404).json({ error: "Class not found" }); return; }

    const [session] = await db.select().from(studentSessionsTable)
      .where(and(
        eq(studentSessionsTable.id, Number(sessionId)),
        eq(studentSessionsTable.classId, Number(classId)),
      ));
    if (!session) { res.status(404).json({ error: "Session not found" }); return; }
    if (session.archivedAt) { res.status(409).json({ error: "Archived student records cannot be used for AI assessment." }); return; }

    const [task] = await db.select().from(tasksTable)
      .where(eq(tasksTable.classId, Number(classId)));

    const feedbackRows = await db.select().from(teacherFeedbackTable)
      .where(eq(teacherFeedbackTable.sessionId, Number(sessionId)));

    const stageEntries = await db.select().from(stageEntriesTable)
      .where(eq(stageEntriesTable.sessionId, Number(sessionId)));

    const chatMessages = await db.select().from(chatMessagesTable)
      .where(eq(chatMessagesTable.sessionId, Number(sessionId)))
      .orderBy(chatMessagesTable.createdAt);

    const stageFeedbacks = ["MAP", "TORCH", "COMPASS", "EMBED", "RESEARCH"].map((stage) => {
      const fb = feedbackRows.find((r) => r.stage === stage);
      const entry = stageEntries.find((e) => e.stage === stage);
      const c = (entry?.contentJson ?? {}) as any;
      let studentContent = "";

      if (stage === "MAP") {
        const parts: string[] = [];
        if (c.taskUnderstanding?.trim()) parts.push(`Task understanding: ${c.taskUnderstanding.slice(0, 400)}`);
        const pk = (c.priorKnowledge ?? []).filter((s: string) => s?.trim());
        if (pk.length) parts.push(`Prior knowledge: ${pk.join("; ")}`);
        const kg = (c.knowledgeGaps ?? []).filter((s: string) => s?.trim());
        if (kg.length) parts.push(`Knowledge gaps: ${kg.join("; ")}`);
        const eq = (c.enquiryQuestions ?? []).filter((s: string) => s?.trim());
        if (eq.length) parts.push(`Enquiry questions: ${eq.join("; ")}`);
        studentContent = parts.join("\n");
      } else if (stage === "TORCH") {
        const sample = chatMessages
          .filter((m) => m.role === "user")
          .slice(0, 8)
          .map((m) => m.content.slice(0, 150))
          .join(" | ");
        studentContent = sample ? `${chatMessages.filter(m => m.role === "user").length} questions asked. Samples: ${sample}` : "";
      } else if (stage === "RESEARCH") {
        const sources: any[] = c.entries ?? [];
        studentContent = sources
          .filter((s: any) => s.source || s.title || s.findings)
          .slice(0, 4)
          .map((s: any) => `${s.title || s.source || "untitled"}: ${(s.findings ?? "").slice(0, 150)}`)
          .join(" | ");
      } else if (stage === "COMPASS") {
        const parts: string[] = [];
        if (c.check1?.trim()) parts.push(`In own words: ${c.check1.slice(0, 200)}`);
        if (c.check2?.trim()) parts.push(`Challenge: ${c.check2.slice(0, 200)}`);
        if (c.check3?.trim()) parts.push(`Least confident: ${c.check3.slice(0, 200)}`);
        if (c.check4?.trim()) parts.push(`Evidence balance: ${c.check4.slice(0, 150)}`);
        if (c.check5?.trim()) parts.push(`Ready to write: ${c.check5.slice(0, 150)}`);
        studentContent = parts.join("\n");
      } else if (stage === "EMBED") {
        const parts: string[] = [];
        if (c.finalAnswer?.trim()) parts.push(`Final answer: ${c.finalAnswer.slice(0, 400)}`);
        if (c.q1?.trim()) parts.push(`Changed understanding: ${c.q1.slice(0, 200)}`);
        if (c.q2?.trim()) parts.push(`Own thinking: ${c.q2.slice(0, 200)}`);
        if (c.q3?.trim()) parts.push(`AI help reflection: ${c.q3.slice(0, 150)}`);
        if (c.q4?.trim()) parts.push(`What not to trust: ${c.q4.slice(0, 150)}`);
        studentContent = parts.join("\n");
      }

      return {
        stage,
        grade: fb?.grade ?? null,
        comment: fb?.comment ?? "",
        formativeComment: fb?.formativeComment ?? "",
        studentContent,
      };
    });

    let orgConfig: OrgAiConfig | null = null;
    if (req.teacher!.organisationId) {
      const [org] = await db
        .select({ aiProvider: organisationsTable.aiProvider, aiKeyEncrypted: organisationsTable.aiKeyEncrypted, azureEndpoint: organisationsTable.azureEndpoint, aiDataProcessingAcknowledged: organisationsTable.aiDataProcessingAcknowledged, aiDataRetentionNoTrainingConfirmed: organisationsTable.aiDataRetentionNoTrainingConfirmed, aiSchoolPoliciesConfirmed: organisationsTable.aiSchoolPoliciesConfirmed, aiDataProcessingRegion: organisationsTable.aiDataProcessingRegion })
        .from(organisationsTable)
        .where(eq(organisationsTable.id, req.teacher!.organisationId));
      if (org) orgConfig = org;
    }

    const result = await synthesiseAssessment(
      session.studentName,
      task?.title ?? "Untitled task",
      task?.question ?? "",
      stageFeedbacks,
      orgConfig,
      {
        learningFramework: task?.learningFramework,
        bloomLevels: (task?.bloomLevels as string[] | null) ?? [],
        knowledgeDimensions: (task?.knowledgeDimensions as string[] | null) ?? [],
      },
    );

    res.json(result);
  },
);

// ── Generate Formative Feedback ───────────────────────────────────────────────

router.post(
  "/teacher/classes/:classId/students/:sessionId/generate-formative-feedback",
  requireTeacher,
  async (req, res): Promise<void> => {
    const { classId, sessionId } = req.params;

    const [cls] = await db.select({ id: classesTable.id }).from(classesTable)
      .where(and(eq(classesTable.id, Number(classId)), eq(classesTable.teacherId, req.teacher!.id)));
    if (!cls) { res.status(404).json({ error: "Class not found" }); return; }

    const [session] = await db.select().from(studentSessionsTable)
      .where(and(
        eq(studentSessionsTable.id, Number(sessionId)),
        eq(studentSessionsTable.classId, Number(classId)),
      ));
    if (!session) { res.status(404).json({ error: "Session not found" }); return; }
    if (session.archivedAt) { res.status(409).json({ error: "Archived student records cannot be used for AI feedback." }); return; }

    const [task] = await db.select().from(tasksTable)
      .where(eq(tasksTable.classId, Number(classId)));

    const stageEntries = await db.select().from(stageEntriesTable)
      .where(eq(stageEntriesTable.sessionId, Number(sessionId)));

    const chatMessages = await db.select().from(chatMessagesTable)
      .where(eq(chatMessagesTable.sessionId, Number(sessionId)))
      .orderBy(chatMessagesTable.createdAt);

    // Build human-readable content summaries per stage
    const stageInputs = (["MAP", "TORCH", "COMPASS", "RESEARCH", "EMBED"] as const).map((stage) => {
      const entry = stageEntries.find((e) => e.stage === stage);
      const c = (entry?.contentJson ?? {}) as any;
      let content = "";

      if (stage === "MAP") {
        const parts: string[] = [];
        if (c.taskUnderstanding?.trim()) parts.push(`Task understanding: ${c.taskUnderstanding.slice(0, 400)}`);
        const pk = (c.priorKnowledge ?? []).filter((s: string) => s?.trim());
        if (pk.length) parts.push(`Prior knowledge: ${pk.join("; ")}`);
        const kg = (c.knowledgeGaps ?? []).filter((s: string) => s?.trim());
        if (kg.length) parts.push(`Knowledge gaps: ${kg.join("; ")}`);
        const eq = (c.enquiryQuestions ?? []).filter((s: string) => s?.trim());
        if (eq.length) parts.push(`Enquiry questions: ${eq.join("; ")}`);
        content = parts.join("\n");
      } else if (stage === "TORCH") {
        const sample = chatMessages.slice(0, 20)
          .map((m) => `${m.role === "user" ? "Student" : "AI"}: ${m.content.slice(0, 200)}`)
          .join("\n");
        content = sample;
      } else if (stage === "RESEARCH") {
        const sources: any[] = c.entries ?? [];
        content = sources
          .filter((s: any) => s.source || s.title || s.findings)
          .slice(0, 6)
          .map((s: any) => `Source: ${s.title || s.source || s.url || "untitled"}\nFindings: ${(s.findings ?? "").slice(0, 200)}`)
          .join("\n\n");
      } else if (stage === "COMPASS") {
        const parts: string[] = [];
        if (c.check1?.trim()) parts.push(`Verified: ${c.check1.slice(0, 200)}`);
        if (c.check2?.trim()) parts.push(`Alternative view: ${c.check2.slice(0, 200)}`);
        if (c.check3?.trim()) parts.push(`Bias check: ${c.check3.slice(0, 200)}`);
        if (c.check4?.trim()) parts.push(`Evidence balance: ${c.check4.slice(0, 200)}`);
        if (c.check5?.trim()) parts.push(`Reliability: ${c.check5.slice(0, 200)}`);
        content = parts.join("\n");
      } else if (stage === "EMBED") {
        const parts: string[] = [];
        if (c.q1?.trim()) parts.push(`Q1: ${c.q1.slice(0, 200)}`);
        if (c.q2?.trim()) parts.push(`Q2: ${c.q2.slice(0, 200)}`);
        if (c.q3?.trim()) parts.push(`Q3: ${c.q3.slice(0, 200)}`);
        if (c.q4?.trim()) parts.push(`Q4: ${c.q4.slice(0, 200)}`);
        if (c.finalAnswer?.trim()) parts.push(`Final answer: ${c.finalAnswer.slice(0, 400)}`);
        content = parts.join("\n");
      }

      return { stage, content };
    });

    let orgConfig: OrgAiConfig | null = null;
    if (req.teacher!.organisationId) {
      const [org] = await db
        .select({ aiProvider: organisationsTable.aiProvider, aiKeyEncrypted: organisationsTable.aiKeyEncrypted, azureEndpoint: organisationsTable.azureEndpoint, aiDataProcessingAcknowledged: organisationsTable.aiDataProcessingAcknowledged, aiDataRetentionNoTrainingConfirmed: organisationsTable.aiDataRetentionNoTrainingConfirmed, aiSchoolPoliciesConfirmed: organisationsTable.aiSchoolPoliciesConfirmed, aiDataProcessingRegion: organisationsTable.aiDataProcessingRegion })
        .from(organisationsTable)
        .where(eq(organisationsTable.id, req.teacher!.organisationId));
      if (org) orgConfig = org;
    }

    const result = await generateFormativeFeedback(
      task?.title ?? "Untitled task",
      task?.question ?? "",
      task?.notes ?? "",
      stageInputs,
      orgConfig,
      {
        learningFramework: task?.learningFramework,
        bloomLevels: (task?.bloomLevels as string[] | null) ?? [],
        knowledgeDimensions: (task?.knowledgeDimensions as string[] | null) ?? [],
      },
    );

    res.json(result);
  },
);

// ── Generate Summative Feedback Per Stage ────────────────────────────────────

router.post(
  "/teacher/classes/:classId/students/:sessionId/generate-summative-per-stage",
  requireTeacher,
  async (req, res): Promise<void> => {
    const { classId, sessionId } = req.params;

    const [cls] = await db.select({ id: classesTable.id }).from(classesTable)
      .where(and(eq(classesTable.id, Number(classId)), eq(classesTable.teacherId, req.teacher!.id)));
    if (!cls) { res.status(404).json({ error: "Class not found" }); return; }

    const [session] = await db.select().from(studentSessionsTable)
      .where(and(
        eq(studentSessionsTable.id, Number(sessionId)),
        eq(studentSessionsTable.classId, Number(classId)),
      ));
    if (!session) { res.status(404).json({ error: "Session not found" }); return; }
    if (session.archivedAt) { res.status(409).json({ error: "Archived student records cannot be used for AI assessment." }); return; }
    const existingInsights = session.studentInsights
      && typeof session.studentInsights === "object"
      && !Array.isArray(session.studentInsights)
      ? session.studentInsights as Record<string, unknown>
      : {};
    if (!existingInsights.formative) {
      res.status(409).json({ error: "Generate the Formative Student Insight before generating summative feedback." });
      return;
    }

    const [task] = await db.select().from(tasksTable)
      .where(eq(tasksTable.classId, Number(classId)));

    const feedbackRows = await db.select().from(teacherFeedbackTable)
      .where(eq(teacherFeedbackTable.sessionId, Number(sessionId)));

    const stageEntries = await db.select().from(stageEntriesTable)
      .where(eq(stageEntriesTable.sessionId, Number(sessionId)));

    const chatMessages = await db.select().from(chatMessagesTable)
      .where(eq(chatMessagesTable.sessionId, Number(sessionId)))
      .orderBy(chatMessagesTable.createdAt);

    const stageInputs = (["MAP", "TORCH", "COMPASS", "RESEARCH", "EMBED"] as const).map((stage) => {
      const entry = stageEntries.find((e) => e.stage === stage);
      const c = (entry?.contentJson ?? {}) as any;
      let content = "";

      if (stage === "MAP") {
        const parts: string[] = [];
        if (c.taskUnderstanding?.trim()) parts.push(`Task understanding: ${c.taskUnderstanding.slice(0, 400)}`);
        const pk = (c.priorKnowledge ?? []).filter((s: string) => s?.trim());
        if (pk.length) parts.push(`Prior knowledge: ${pk.join("; ")}`);
        const kg = (c.knowledgeGaps ?? []).filter((s: string) => s?.trim());
        if (kg.length) parts.push(`Knowledge gaps: ${kg.join("; ")}`);
        const eq2 = (c.enquiryQuestions ?? []).filter((s: string) => s?.trim());
        if (eq2.length) parts.push(`Enquiry questions: ${eq2.join("; ")}`);
        content = parts.join("\n");
      } else if (stage === "TORCH") {
        const userMsgs = chatMessages.filter((m) => m.role === "user");
        const sample = userMsgs.slice(0, 10).map((m) => m.content.slice(0, 200)).join(" | ");
        content = sample ? `${userMsgs.length} questions asked. Sample questions: ${sample}` : "";
      } else if (stage === "RESEARCH") {
        const sources: any[] = c.entries ?? [];
        content = sources
          .filter((s: any) => s.source || s.title || s.findings)
          .slice(0, 5)
          .map((s: any) => `Source: ${s.title || s.source || "untitled"}\nFindings: ${(s.findings ?? "").slice(0, 200)}`)
          .join("\n\n");
      } else if (stage === "COMPASS") {
        const parts: string[] = [];
        if (c.check1?.trim()) parts.push(`In own words: ${c.check1.slice(0, 200)}`);
        if (c.check2?.trim()) parts.push(`Challenge to thinking: ${c.check2.slice(0, 200)}`);
        if (c.check3?.trim()) parts.push(`Least confident: ${c.check3.slice(0, 200)}`);
        if (c.check4?.trim()) parts.push(`Evidence balance: ${c.check4.slice(0, 150)}`);
        if (c.check5?.trim()) parts.push(`Ready to write: ${c.check5.slice(0, 150)}`);
        content = parts.join("\n");
      } else if (stage === "EMBED") {
        const parts: string[] = [];
        if (c.finalAnswer?.trim()) parts.push(`Final answer: ${c.finalAnswer.slice(0, 500)}`);
        if (c.q1?.trim()) parts.push(`Changed understanding: ${c.q1.slice(0, 200)}`);
        if (c.q2?.trim()) parts.push(`Own thinking: ${c.q2.slice(0, 200)}`);
        if (c.q3?.trim()) parts.push(`AI help reflection: ${c.q3.slice(0, 150)}`);
        if (c.q4?.trim()) parts.push(`What not to trust: ${c.q4.slice(0, 150)}`);
        content = parts.join("\n");
      }

      return { stage, content };
    });

    let orgConfig: OrgAiConfig | null = null;
    if (req.teacher!.organisationId) {
      const [org] = await db
        .select({ aiProvider: organisationsTable.aiProvider, aiKeyEncrypted: organisationsTable.aiKeyEncrypted, azureEndpoint: organisationsTable.azureEndpoint, aiDataProcessingAcknowledged: organisationsTable.aiDataProcessingAcknowledged, aiDataRetentionNoTrainingConfirmed: organisationsTable.aiDataRetentionNoTrainingConfirmed, aiSchoolPoliciesConfirmed: organisationsTable.aiSchoolPoliciesConfirmed, aiDataProcessingRegion: organisationsTable.aiDataProcessingRegion })
        .from(organisationsTable)
        .where(eq(organisationsTable.id, req.teacher!.organisationId));
      if (org) orgConfig = org;
    }

    const result = await generateSummativePerStage(
      task?.title ?? "Untitled task",
      task?.question ?? "",
      task?.notes ?? "",
      stageInputs,
      orgConfig,
      {
        learningFramework: task?.learningFramework,
        bloomLevels: (task?.bloomLevels as string[] | null) ?? [],
        knowledgeDimensions: (task?.knowledgeDimensions as string[] | null) ?? [],
      },
    );

    const generatedStageFeedbacks = stageInputs.map((stageInput) => {
      const generated = result[stageInput.stage];
      const savedFeedback = feedbackRows.find((row) => row.stage === stageInput.stage);
      return {
        stage: stageInput.stage,
        grade: generated?.grade ?? null,
        comment: generated?.comment ?? "",
        formativeComment: savedFeedback?.formativeComment ?? "",
        studentContent: stageInput.content,
      };
    });
    const overall = await synthesiseAssessment(
      session.studentName,
      task?.title ?? "Untitled task",
      task?.question ?? "",
      generatedStageFeedbacks,
      orgConfig,
      {
        learningFramework: task?.learningFramework,
        bloomLevels: (task?.bloomLevels as string[] | null) ?? [],
        knowledgeDimensions: (task?.knowledgeDimensions as string[] | null) ?? [],
      },
    );

    res.json({ ...result, OVERALL: overall });
  },
);

// ── School administration ─────────────────────────────────────────────────────

function requireSchoolAdmin(req: Request, res: Response, next: NextFunction): void {
  const teacher = (req as any).teacher;
  if (!teacher?.isItAdmin || !["master", "subadmin"].includes(teacher.schoolAdminRole)) {
    res.status(403).json({ error: "School administrator access required" });
    return;
  }
  next();
}

function requireSchoolMaster(req: Request, res: Response, next: NextFunction): void {
  if ((req as any).teacher?.schoolAdminRole !== "master") {
    res.status(403).json({ error: "School Admin access required for this setting" });
    return;
  }
  next();
}

function requireLeadSchoolAdministrator(req: Request, res: Response, next: NextFunction): void {
  const teacher = (req as any).teacher;
  if (!teacher?.isItAdmin || teacher.schoolAdminRole !== "master") {
    res.status(403).json({ error: "School Admin access required" });
    return;
  }
  next();
}

const PermanentStudentRecordDeletionBody = z.object({
  confirmation: z.literal("PERMANENTLY DELETE"),
});

router.post(
  "/teacher/org/student-records/:sessionId/permanent-delete",
  requireTeacher,
  requireSchoolMaster,
  async (req, res): Promise<void> => {
    const sessionId = Number(req.params.sessionId);
    const orgId = req.teacher!.organisationId;
    const parsed = PermanentStudentRecordDeletionBody.safeParse(req.body);
    if (!Number.isInteger(sessionId) || sessionId <= 0 || !orgId || !parsed.success) {
      res.status(400).json({ error: "Type PERMANENTLY DELETE to confirm final deletion." });
      return;
    }

    const outcome = await db.transaction(async (tx) => {
      // This lock is shared with retention-policy updates so a new legal hold
      // cannot race a manual deletion.
      await acquireRetentionPolicyMutationLock(tx, orgId);
      const [record] = await tx
        .select({
          id: studentSessionsTable.id,
          classId: studentSessionsTable.classId,
          archivedAt: studentSessionsTable.archivedAt,
          retentionUntil: studentSessionsTable.retentionUntil,
        })
        .from(studentSessionsTable)
        .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
        .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
        .where(and(
          eq(studentSessionsTable.id, sessionId),
          eq(teachersTable.organisationId, orgId),
        ))
        .for("update");
      if (!record) return { kind: "missing" as const };
      if (!record.archivedAt || !record.retentionUntil) return { kind: "not-archived" as const };

      const activeControls = await tx
        .select({
          id: studentDataRequestControlsTable.id,
          kind: studentDataRequestControlsTable.kind,
          reasonCategory: studentDataRequestControlsTable.reasonCategory,
          affectedDataCategories: studentDataRequestControlsTable.affectedDataCategories,
          processingLimits: studentDataRequestControlsTable.processingLimits,
        })
        .from(studentDataRequestControlsTable)
        .where(and(
          eq(studentDataRequestControlsTable.organisationId, orgId),
          eq(studentDataRequestControlsTable.lifecycleState, "active"),
          or(
            eq(studentDataRequestControlsTable.affectedStudentSessionId, record.id),
            eq(studentDataRequestControlsTable.affectedClassId, record.classId),
          ),
        ));
      const deletionControls = activeControls.filter((control) =>
        control.kind !== "restriction" || control.processingLimits.includes("deletion")
      );
      if (deletionControls.length) {
        return {
          kind: "controlled" as const,
          controls: deletionControls.map(({ id, kind, reasonCategory, affectedDataCategories }) => ({
            id,
            kind,
            reasonCategory,
            affectedDataCategories,
          })),
        };
      }

      const [[exception], [defaultPolicy]] = await Promise.all([
        tx.select()
          .from(organisationRetentionPoliciesTable)
          .where(and(
            eq(organisationRetentionPoliciesTable.organisationId, orgId),
            eq(organisationRetentionPoliciesTable.dataCategory, "student_learning_records"),
          )),
        tx.select()
          .from(organisationRetentionDefaultsTable)
          .where(eq(organisationRetentionDefaultsTable.organisationId, orgId)),
      ]);
      const policy = exception ?? defaultPolicy;
      if (!policy) return { kind: "blocked" as const, reason: "policy_not_scheduled" };
      const blockReason = getRetentionBlockReason(policy);
      if (blockReason) return { kind: "blocked" as const, reason: blockReason };

      const now = new Date();
      await tx.insert(studentRecordDeletionEvidenceTable).values({
        organisationId: orgId,
        deletedStudentSessionId: record.id,
        classId: record.classId,
        archivedAt: record.archivedAt,
        retentionUntil: record.retentionUntil,
        applicationRecordsPurgedAt: now,
        deletionReason: "school_master_requested",
        deletedByTeacherId: req.teacher!.id,
      });
      await tx.insert(auditLogTable).values({
        organisationId: orgId,
        teacherId: req.teacher!.id,
        action: "student_record_permanently_deleted_by_school_master",
        metadata: {
          studentSessionId: record.id,
          classId: record.classId,
          archivedAt: record.archivedAt.toISOString(),
          retentionUntil: record.retentionUntil.toISOString(),
        },
        ipAddress: req.ip,
      });
      await recordDeletionTombstones(tx, [{ entityType: "student_record", entityId: record.id }], now);
      await tx.delete(studentSessionsTable).where(eq(studentSessionsTable.id, record.id));
      return { kind: "purged" as const, purgedAt: now };
    });

    if (outcome.kind === "missing") {
      res.status(404).json({ error: "Archived student record not found." });
      return;
    }
    if (outcome.kind === "not-archived") {
      res.status(409).json({ error: "Only archived student records can be permanently deleted." });
      return;
    }
    if (outcome.kind === "controlled") {
      res.status(409).json({
        error: "Permanent deletion is blocked by an active request control.",
        blockReason: "active_control",
        controls: outcome.controls,
      });
      return;
    }
    if (outcome.kind === "blocked") {
      res.status(409).json({
        error: "The school's student learning-record retention policy currently blocks permanent deletion.",
        blockReason: outcome.reason,
      });
      return;
    }
    res.json({ ok: true, permanentlyDeleted: true, applicationRecordsPurgedAt: outcome.purgedAt });
  },
);

router.get(
  "/teacher/org/deletion-requests",
  requireTeacher,
  requireSchoolMaster,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation" });
      return;
    }
    const [classes, studentRecords] = await Promise.all([
      db.select({
        id: classesTable.id,
        name: classesTable.name,
        subject: classesTable.subject,
        teacherId: teachersTable.id,
        teacherName: teachersTable.name,
        deletionScheduledFor: classesTable.deletionScheduledFor,
        deletionReason: classesTable.deletionReason,
      })
        .from(classesTable)
        .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
        .where(and(
          eq(teachersTable.organisationId, orgId),
          isNotNull(classesTable.deletionScheduledFor),
        ))
        .orderBy(asc(classesTable.deletionScheduledFor)),
      db.select({
        id: studentSessionsTable.id,
        studentName: studentSessionsTable.studentName,
        classId: classesTable.id,
        className: classesTable.name,
        teacherId: teachersTable.id,
        teacherName: teachersTable.name,
        deletionScheduledFor: studentSessionsTable.deletionScheduledFor,
      })
        .from(studentSessionsTable)
        .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
        .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
        .where(and(
          eq(teachersTable.organisationId, orgId),
          isNull(classesTable.deletionScheduledFor),
          isNotNull(studentSessionsTable.deletionScheduledFor),
        ))
        .orderBy(asc(studentSessionsTable.deletionScheduledFor)),
    ]);
    res.json({ classes, studentRecords });
  },
);

router.post(
  "/teacher/org/deletion-requests/classes/:classId/restore",
  requireTeacher,
  requireSchoolMaster,
  async (req, res): Promise<void> => {
    const classId = Number(req.params.classId);
    const orgId = req.teacher!.organisationId;
    if (!Number.isInteger(classId) || classId <= 0 || !orgId) {
      res.status(400).json({ error: "Invalid class" });
      return;
    }
    const restored = await db.transaction(async (tx) => {
      const now = new Date();
      const [cls] = await tx
        .select({
          id: classesTable.id,
          teacherId: classesTable.teacherId,
          deletionScheduledFor: classesTable.deletionScheduledFor,
          ownerStatus: teachersTable.accountStatus,
        })
        .from(classesTable)
        .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
        .where(and(eq(classesTable.id, classId), eq(teachersTable.organisationId, orgId)))
        .for("update");
      if (!cls?.deletionScheduledFor) return { kind: "missing" as const };
      if (cls.deletionScheduledFor <= now) {
        return { kind: "expired" as const, deletionScheduledFor: cls.deletionScheduledFor };
      }
      // A departure deletion disables its owner. Give the restored class to
      // the active School Master in the same transaction so recovery cannot
      // produce a class that no active teacher can see or manage.
      const restoredTeacherId = cls.ownerStatus === "active" ? cls.teacherId : req.teacher!.id;
      await tx.update(classesTable).set({
        teacherId: restoredTeacherId,
        archivedAt: null,
        archiveExpiresAt: null,
        archiveLifecycleStatus: "active",
        archiveExpiryNotifiedAt: null,
        archiveExpiryWarningAttemptedAt: null,
        archiveExpiryWarningSentAt: null,
        deletionRequestedAt: null,
        deletionScheduledFor: null,
        deletionRequestedBy: null,
        deletionReason: null,
      }).where(eq(classesTable.id, cls.id));
      await tx.update(studentSessionsTable).set({
        deletionRequestedAt: null,
        deletionScheduledFor: null,
        deletionRequestedBy: null,
        deletionReason: null,
      }).where(eq(studentSessionsTable.classId, cls.id));
      await tx.insert(auditLogTable).values({
        organisationId: orgId,
        teacherId: req.teacher!.id,
        action: "class_deletion_restored_by_school_master",
        metadata: { classId: cls.id, restoredTeacherId, ownershipTransferred: restoredTeacherId !== cls.teacherId },
        ipAddress: req.ip,
      });
      return { kind: "restored" as const, restoredTeacherId };
    });
    if (restored.kind === "missing") {
      res.status(404).json({ error: "No pending deletion was found for this class." });
      return;
    }
    if (restored.kind === "expired") {
      res.status(409).json({
        error: `The recovery period expired on ${restored.deletionScheduledFor.toISOString()}; this class was not restored.`,
        deletionScheduledFor: restored.deletionScheduledFor,
      });
      return;
    }
    res.json({ ok: true, restored: true, restoredTeacherId: restored.restoredTeacherId });
  },
);

router.post(
  "/teacher/org/deletion-requests/students/:sessionId/restore",
  requireTeacher,
  requireSchoolMaster,
  async (req, res): Promise<void> => {
    const sessionId = Number(req.params.sessionId);
    const orgId = req.teacher!.organisationId;
    if (!Number.isInteger(sessionId) || sessionId <= 0 || !orgId) {
      res.status(400).json({ error: "Invalid student record" });
      return;
    }
    const restored = await db.transaction(async (tx) => {
      const now = new Date();
      const [record] = await tx
        .select({
          id: studentSessionsTable.id,
          classId: studentSessionsTable.classId,
          deletionScheduledFor: studentSessionsTable.deletionScheduledFor,
          classDeletionScheduledFor: classesTable.deletionScheduledFor,
        })
        .from(studentSessionsTable)
        .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
        .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
        .where(and(
          eq(studentSessionsTable.id, sessionId),
          eq(teachersTable.organisationId, orgId),
        ))
        .for("update");
      if (!record?.deletionScheduledFor || record.classDeletionScheduledFor) return { kind: "missing" as const };
      if (record.deletionScheduledFor <= now) {
        return { kind: "expired" as const, deletionScheduledFor: record.deletionScheduledFor };
      }
      await tx.update(studentSessionsTable).set({
        deletionRequestedAt: null,
        deletionScheduledFor: null,
        deletionRequestedBy: null,
        deletionReason: null,
      }).where(eq(studentSessionsTable.id, record.id));
      await tx.insert(auditLogTable).values({
        organisationId: orgId,
        teacherId: req.teacher!.id,
        action: "student_record_deletion_restored_by_school_master",
        metadata: { classId: record.classId, sessionId: record.id },
        ipAddress: req.ip,
      });
      return { kind: "restored" as const };
    });
    if (restored.kind === "missing") {
      res.status(404).json({ error: "No pending deletion was found for this student record." });
      return;
    }
    if (restored.kind === "expired") {
      res.status(409).json({
        error: `The recovery period expired on ${restored.deletionScheduledFor.toISOString()}; this Student record was not restored.`,
        deletionScheduledFor: restored.deletionScheduledFor,
      });
      return;
    }
    res.json({ ok: true, restored: true });
  },
);

const DepartureClassAction = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("transfer"),
    classId: z.coerce.number().int().positive(),
    replacementTeacherId: z.coerce.number().int().positive(),
  }),
  z.object({
    action: z.literal("archive"),
    classId: z.coerce.number().int().positive(),
    reason: z.string().trim().min(3).max(500).optional(),
  }),
]);

/*
 * `actions` is the current contract.  The two legacy forms are intentionally
 * accepted here so an older School Master client cannot accidentally remove
 * access without dealing with every class.
 */
const TeacherDepartureBody = z.union([
  z.object({
    actions: z.array(DepartureClassAction).max(100),
    confirmation: z.literal("REMOVE ACCESS"),
  }).transform((value) => ({ ...value, legacyArchiveAll: false, legacyReplacementTeacherId: null })),
  z.object({
    outcome: z.literal("transfer"),
    transfers: z.array(z.object({
      classId: z.coerce.number().int().positive(),
      replacementTeacherId: z.coerce.number().int().positive(),
    })).max(100).optional(),
    replacementTeacherId: z.coerce.number().int().positive().optional(),
    confirmation: z.literal("REMOVE ACCESS"),
  }).refine((value) => Boolean(value.transfers?.length || value.replacementTeacherId), {
    message: "Provide a class transfer list or a replacement teacher.",
  }).transform((value) => ({
    confirmation: value.confirmation,
    actions: (value.transfers ?? []).map((transfer) => ({
      action: "transfer" as const,
      classId: transfer.classId,
      replacementTeacherId: transfer.replacementTeacherId,
    })),
    legacyArchiveAll: false,
    legacyReplacementTeacherId: value.replacementTeacherId ?? null,
  })),
  z.object({
    outcome: z.literal("archive"),
    reason: z.string().trim().min(3).max(500).optional(),
    confirmation: z.literal("REMOVE ACCESS"),
  }).transform((value) => ({
    confirmation: value.confirmation,
    actions: [] as Array<z.infer<typeof DepartureClassAction>>,
    legacyArchiveAll: true,
    legacyReplacementTeacherId: null,
    reason: value.reason,
  })),
]);

const TransferOrganisationClassBody = z.object({
  replacementTeacherId: z.coerce.number().int().positive(),
  confirmation: z.literal("TRANSFER CLASS"),
});

const ArchivedClassActionBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("restore"),
    teacherId: z.coerce.number().int().positive(),
  }),
  z.object({
    action: z.literal("schedule-deletion"),
    confirmation: z.literal("DELETE"),
  }),
]);

const ArchivedDetailedAccessBody = z.object({
  purpose: z.string().trim().min(10).max(500),
  confirmation: z.literal(true),
});

async function recordDetailedArchiveAccess(opts: {
  archiveId: number;
  organisationId: number;
  teacherId: number;
  action: string;
  metadata: Record<string, unknown>;
  ipAddress: string | null | undefined;
}): Promise<{ kind: "recorded" } | { kind: "missing" } | { kind: "expired"; retentionUntil: Date }> {
  return db.transaction(async (tx) => {
    const [archive] = await tx
      .select({
        retentionUntil: teacherRecordArchivesTable.retentionUntil,
      })
      .from(teacherRecordArchivesTable)
      .where(and(
        eq(teacherRecordArchivesTable.id, opts.archiveId),
        eq(teacherRecordArchivesTable.organisationId, opts.organisationId),
      ))
      .for("update");
    if (!archive) return { kind: "missing" as const };
    if (archive.retentionUntil.getTime() <= Date.now()) {
      return { kind: "expired" as const, retentionUntil: archive.retentionUntil };
    }

    await tx.insert(auditLogTable).values({
      organisationId: opts.organisationId,
      teacherId: opts.teacherId,
      action: opts.action,
      metadata: { ...opts.metadata, archiveId: opts.archiveId },
      ipAddress: opts.ipAddress ?? null,
    });
    return { kind: "recorded" as const };
  });
}

const PermanentArchiveDeletionBody = z.object({
  confirmation: z.literal("PERMANENTLY DELETE"),
});

function backupStorageLifecycleForDeletion(deletedAt: Date): {
  status: "pending_configuration" | "expiry_pending";
  expiryAt: Date | null;
  evidenceReference: string | null;
} {
  const retentionDays = Number(process.env.AWS_BACKUP_STORAGE_RETENTION_DAYS);
  const evidenceReference = process.env.AWS_BACKUP_LIFECYCLE_EVIDENCE_REFERENCE?.trim() || null;
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650 || !evidenceReference) {
    return { status: "pending_configuration", expiryAt: null, evidenceReference: null };
  }
  return {
    status: "expiry_pending",
    expiryAt: new Date(deletedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000),
    evidenceReference,
  };
}

function serialiseBackupStorageLifecycle(record: {
  backupStorageLifecycleStatus: "pending_configuration" | "expiry_pending" | "verified";
  backupStorageExpiryAt: Date | null;
  backupStorageEvidenceReference: string | null;
  backupStorageVerifiedAt: Date | null;
}) {
  // Passing the expected expiry is not proof that AWS has completed deletion.
  // An authorised operator must persist an explicit independent verification.
  const status = record.backupStorageLifecycleStatus === "verified"
    ? "verified"
    : "pending";
  return {
    status,
    configured: record.backupStorageLifecycleStatus !== "pending_configuration",
    expiresAt: record.backupStorageExpiryAt,
    verifiedAt: record.backupStorageVerifiedAt,
  };
}

function canManageDeparture(actor: typeof teachersTable.$inferSelect, target: {
  id: number;
  schoolAdminRole: "master" | "subadmin" | null;
}): string | null {
  if (target.id === actor.id) return "You cannot manage your own departure record.";
  if (target.schoolAdminRole === "master") return "The School Admin account is managed by CIG administration.";
  if (target.schoolAdminRole === "subadmin" && actor.schoolAdminRole !== "master") {
    return "Only the School Admin can manage a School Sub-admin account.";
  }
  return null;
}

// Existing organisation settings are governance-sensitive. Keep the route
// declarations explicit below while retaining this alias for their shared guard.
const requireItAdmin = requireSchoolMaster;

const boundedProcedureText = z.string().trim().min(3).max(2000);
function isValidDateOnly(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

const validDateOnly = z.string().refine(isValidDateOnly, "Enter a valid calendar date in YYYY-MM-DD format.");
const SchoolDataRequestProcedureBody = z.object({
  privacyContactName: z.string().trim().min(2).max(200),
  privacyContactEmail: z.string().trim().email().max(320),
  secureTransferMethod: boundedProcedureText,
  privacyInformationLink: z.string().trim().url().max(2000),
  safeguardingContactName: z.string().trim().min(2).max(200),
  safeguardingContactEmail: z.string().trim().email().max(320),
  checksCompleted: z.array(z.enum([
    "dpia",
    "dpa",
    "privacy_information",
    "data_flow_and_security",
    "safeguarding_and_online_safety",
    "acceptable_use",
    "research_ethics_and_consent",
  ])).length(7),
  conditionsOrRestrictions: z.string().trim().max(2000),
  reviewDate: validDateOnly.optional(),
  finalConfirmation: z.literal(true),
  approvedByName: z.string().trim().min(2).max(200),
  approvedByRole: z.string().trim().min(2).max(200),
  approvalDate: validDateOnly,
}).superRefine((value, ctx) => {
  const today = new Date().toISOString().slice(0, 10);
  if (value.approvalDate > today) {
    ctx.addIssue({ code: "custom", path: ["approvalDate"], message: "The approval date cannot be in the future." });
  }
});

function serialiseSchoolDataRequestProcedure(
  procedure: typeof organisationDataRequestProceduresTable.$inferSelect,
  approvals: Array<typeof organisationDataRequestApprovalsTable.$inferSelect>,
) {
  const schoolMaster = approvals.find((item) => item.role === "school_master");
  let privacyContactName = procedure.privacyContact;
  let privacyContactEmail = "";
  try {
    const contact = JSON.parse(procedure.privacyContact) as { name?: unknown; email?: unknown };
    if (typeof contact.name === "string") privacyContactName = contact.name;
    if (typeof contact.email === "string") privacyContactEmail = contact.email;
  } catch {
    // Older published snapshots stored the contact as plain text.
  }
  return {
    id: procedure.id,
    organisationId: procedure.organisationId,
    privacyContactName,
    privacyContactEmail,
    safeguardingContactName: procedure.safeguardingContactName ?? "",
    safeguardingContactEmail: procedure.safeguardingContactEmail ?? "",
    checksCompleted: Array.isArray(procedure.checksCompleted) ? procedure.checksCompleted : [],
    conditionsOrRestrictions: procedure.conditionsOrRestrictions ?? "",
    reviewDate: procedure.reviewDate ?? null,
    finalConfirmation: Boolean(procedure.finalConfirmation),
    secureTransferMethod: procedure.secureTransferRoute,
    privacyInformationLink: procedure.privacyMaterialsLink,
    schoolApprovalConfirmed: Boolean(schoolMaster),
    approvedByName: schoolMaster?.approverName ?? "",
    approvedByRole: schoolMaster?.approverRole ?? "",
    approvalDate: schoolMaster?.approvedOn ?? procedure.approvedAt.toISOString().slice(0, 10),
    approvedAt: procedure.approvedAt,
    updatedAt: procedure.updatedAt,
  };
}

router.get(
  "/teacher/org/data-request-procedure",
  requireTeacher,
  requireSchoolMaster,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }
    const [publication] = await db
      .select({ snapshot: organisationDataRequestPublicationsTable.snapshot })
      .from(organisationDataRequestPublicationsTable)
      .where(eq(organisationDataRequestPublicationsTable.organisationId, orgId))
      .orderBy(desc(organisationDataRequestPublicationsTable.publishedAt), desc(organisationDataRequestPublicationsTable.id))
      .limit(1);
    if (!publication) {
      res.json({ procedure: null });
      return;
    }
    res.json({ procedure: publication.snapshot });
  },
);

router.put(
  "/teacher/org/data-request-procedure",
  requireTeacher,
  requireSchoolMaster,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    const parsed = SchoolDataRequestProcedureBody.safeParse(req.body);
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    try {
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${orgId}, 125)`);
        const now = new Date();
        const values = {
          organisationId: orgId,
          privacyContact: JSON.stringify({
            name: parsed.data.privacyContactName,
            email: parsed.data.privacyContactEmail,
          }),
          safeguardingContactName: parsed.data.safeguardingContactName,
          safeguardingContactEmail: parsed.data.safeguardingContactEmail,
          checksCompleted: parsed.data.checksCompleted,
          conditionsOrRestrictions: parsed.data.conditionsOrRestrictions,
          reviewDate: parsed.data.reviewDate ?? null,
          finalConfirmation: parsed.data.finalConfirmation,
          secureTransferRoute: parsed.data.secureTransferMethod,
          // These legacy columns remain non-null for existing deployments. They are
          // intentionally not part of the active pilot record.
          safeguardingContact: "",
          incidentEscalationContact: "",
          complaintRoute: "",
          responseTargets: "",
          retentionSchedule: "",
          staffPublicationLocation: "",
          privacyMaterialsLink: parsed.data.privacyInformationLink,
           procedureVersion: "pilot-approval-v2",
          nextReviewDate: parsed.data.approvalDate,
          approvedAt: now,
          publishedAt: now,
          updatedByTeacherId: req.teacher!.id,
          updatedAt: now,
        };
        const [existing] = await tx
          .select({ id: organisationDataRequestProceduresTable.id })
          .from(organisationDataRequestProceduresTable)
          .where(eq(organisationDataRequestProceduresTable.organisationId, orgId));
        const [procedure] = existing
          ? await tx.update(organisationDataRequestProceduresTable)
            .set(values)
            .where(eq(organisationDataRequestProceduresTable.id, existing.id))
            .returning()
          : await tx.insert(organisationDataRequestProceduresTable).values(values).returning();

        await tx.delete(organisationDataRequestApprovalsTable)
          .where(eq(organisationDataRequestApprovalsTable.procedureId, procedure.id));
        const approvalValues = [{
          role: "school_master" as const,
          approverName: parsed.data.approvedByName,
          approverRole: parsed.data.approvedByRole,
          // The existing table requires a reference column. The active form does
          // not collect one; this fixed internal marker is never returned.
          evidenceReference: "school_approval_record",
          approvedOn: parsed.data.approvalDate,
          decision: "approved",
          nextReviewDate: parsed.data.approvalDate,
        }];
        const approvals = await tx.insert(organisationDataRequestApprovalsTable).values(
          approvalValues.map((approval) => ({ procedureId: procedure.id, ...approval })),
        ).returning();
        const snapshot = serialiseSchoolDataRequestProcedure(procedure, approvals);
        const [publication] = await tx.insert(organisationDataRequestPublicationsTable).values({
          organisationId: orgId,
          procedureId: procedure.id,
          procedureVersion: procedure.procedureVersion,
          snapshot,
          publishedByTeacherId: req.teacher!.id,
          publishedAt: now,
        }).returning({ id: organisationDataRequestPublicationsTable.id });
        await tx.insert(auditLogTable).values({
          organisationId: orgId,
          teacherId: req.teacher!.id,
          action: "organisation.data_request_procedure_saved",
          metadata: {
            procedureId: procedure.id,
            publicationId: publication.id,
            approvalRole: "school_master",
          },
          ipAddress: req.ip,
        });
        return snapshot;
      });
      res.json(result);
    } catch (error) {
      req.log.error({ err: error }, "School approval record could not be saved");
      res.status(503).json({ error: "The school approval record could not be saved because its audit record could not be stored." });
    }
  },
);

const StudentDataRequestBody = z.object({
  studentSessionId: z.coerce.number().int().positive(),
  requestType: z.enum(["access", "correction", "deletion"]),
  reason: z.string().trim().min(3).max(2000),
  approvalBasis: z.string().trim().min(3).max(2000).optional(),
});

const StudentDataRequestUpdateBody = z.object({
  status: z.enum(["open", "in_review", "completed", "refused", "escalated"]),
  outcome: z.string().trim().min(3).max(2000).optional(),
  approvalBasis: z.string().trim().min(3).max(2000).optional(),
});

const StudentDataRequestIdParams = z.object({
  id: z.coerce.number().int().positive(),
});

const STUDENT_DATA_CONTROL_DATA_CATEGORIES = [
  "identity",
  "learning",
  "activity",
  "feedback",
  "ai_conversations",
] as const;

const StudentDataRequestControlBody = z.object({
  kind: z.enum(studentDataRequestControlKinds),
  reasonCategory: z.enum(studentDataRequestControlReasonCategories),
  reasonSummary: z.string().trim().min(3).max(160).regex(/^[^\r\n]+$/),
  affectedDataCategories: z.array(z.enum(STUDENT_DATA_CONTROL_DATA_CATEGORIES)).min(1).max(5),
  accessLimits: z.array(z.enum(studentDataRequestControlAccessLimits)).max(4).default([]),
  processingLimits: z.array(z.enum(studentDataRequestControlProcessingLimits)).max(4).default([]),
  startDate: validDateOnly,
  reviewDate: validDateOnly,
  expiryDate: validDateOnly.nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.reviewDate < value.startDate) {
    ctx.addIssue({ code: "custom", path: ["reviewDate"], message: "Review date cannot be before the start date." });
  }
  if (value.expiryDate && value.expiryDate < value.reviewDate) {
    ctx.addIssue({ code: "custom", path: ["expiryDate"], message: "Expiry date cannot be before the review date." });
  }
  if (value.kind === "restriction" && value.accessLimits.length === 0 && value.processingLimits.length === 0) {
    ctx.addIssue({ code: "custom", path: ["processingLimits"], message: "A restriction must identify at least one access or processing limit." });
  }
});

const StudentDataRequestControlActionBody = z.object({
  action: z.enum(["review", "expire", "lift"]),
  note: z.string().trim().min(3).max(240).regex(/^[^\r\n]+$/),
});

const StudentDataRequestControlIdParams = z.object({
  id: z.coerce.number().int().positive(),
  controlId: z.coerce.number().int().positive(),
});

const studentDataRequestQuery = z.object({
  q: z.string().trim().max(120).optional().default(""),
});

const STUDENT_DATA_REQUEST_TRANSITIONS = {
  open: ["open", "in_review", "completed", "refused", "escalated"],
  in_review: ["in_review", "completed", "refused", "escalated"],
  escalated: ["escalated", "completed", "refused"],
  completed: [],
  refused: [],
} as const;

function canTransitionStudentDataRequest(
  current: keyof typeof STUDENT_DATA_REQUEST_TRANSITIONS,
  next: keyof typeof STUDENT_DATA_REQUEST_TRANSITIONS,
): boolean {
  return STUDENT_DATA_REQUEST_TRANSITIONS[current].includes(next as never);
}

function serialiseStudentDataRequest(row: {
  id: number;
  studentSessionId: number | null;
  studentNameSnapshot: string;
  classIdSnapshot: number | null;
  classNameSnapshot: string;
  requestType: string;
  reason: string;
  approvalBasis: string | null;
  status: string;
  outcome: string | null;
  createdByTeacherId: number | null;
  reviewedByTeacherId: number | null;
  exportCount: number;
  lastExportedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  currentStudentName: string | null;
  currentClassId: number | null;
  currentClassName: string | null;
}) {
  return {
    id: row.id,
    studentSessionId: row.studentSessionId,
    studentName: row.currentStudentName ?? row.studentNameSnapshot,
    classId: row.currentClassId ?? row.classIdSnapshot,
    className: row.currentClassName ?? row.classNameSnapshot,
    requestType: row.requestType,
    reason: row.reason,
    approvalBasis: row.approvalBasis,
    status: row.status,
    outcome: row.outcome,
    createdByTeacherId: row.createdByTeacherId,
    reviewedByTeacherId: row.reviewedByTeacherId,
    exportCount: row.exportCount,
    lastExportedAt: row.lastExportedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

function serialiseStudentDataRequestControl(
  control: typeof studentDataRequestControlsTable.$inferSelect,
  events: Array<typeof studentDataRequestControlEventsTable.$inferSelect>,
) {
  return {
    id: control.id,
    requestId: control.requestId,
    accountableOwnerTeacherId: control.accountableOwnerTeacherId,
    affectedStudentSessionId: control.affectedStudentSessionId,
    affectedClassId: control.affectedClassId,
    affectedDataCategories: control.affectedDataCategories,
    kind: control.kind,
    reasonCategory: control.reasonCategory,
    reasonSummary: control.reasonSummary,
    accessLimits: control.accessLimits,
    processingLimits: control.processingLimits,
    startDate: control.startDate,
    reviewDate: control.reviewDate,
    expiryDate: control.expiryDate,
    lifecycleState: control.lifecycleState,
    lastReviewedAt: control.lastReviewedAt,
    endedAt: control.endedAt,
    createdAt: control.createdAt,
    updatedAt: control.updatedAt,
    events: events.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      note: event.note,
      lifecycleState: event.lifecycleState,
      actorTeacherId: event.actorTeacherId,
      occurredAt: event.occurredAt,
    })),
  };
}

router.get(
  "/teacher/org/student-data-request-controls",
  requireTeacher,
  requireLeadSchoolAdministrator,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }
    const controls = await db
      .select()
      .from(studentDataRequestControlsTable)
      .where(eq(studentDataRequestControlsTable.organisationId, orgId))
      .orderBy(desc(studentDataRequestControlsTable.createdAt));
    const events = await db
      .select()
      .from(studentDataRequestControlEventsTable)
      .where(eq(studentDataRequestControlEventsTable.organisationId, orgId))
      .orderBy(asc(studentDataRequestControlEventsTable.occurredAt));
    const eventsByControl = new Map<number, Array<typeof studentDataRequestControlEventsTable.$inferSelect>>();
    for (const event of events) {
      const current = eventsByControl.get(event.controlId) ?? [];
      current.push(event);
      eventsByControl.set(event.controlId, current);
    }
    res.json({
      items: controls.map((control) => serialiseStudentDataRequestControl(control, eventsByControl.get(control.id) ?? [])),
    });
  },
);

router.post(
  "/teacher/org/student-data-requests/:id/controls",
  requireTeacher,
  requireLeadSchoolAdministrator,
  async (req, res): Promise<void> => {
    const params = StudentDataRequestIdParams.safeParse(req.params);
    const parsed = StudentDataRequestControlBody.safeParse(req.body);
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }
    if (!params.success || !parsed.success) {
      const error = !params.success
        ? params.error.message
        : !parsed.success
          ? parsed.error.message
          : "Invalid control";
      res.status(400).json({ error });
      return;
    }
    const categoryForKind: Record<string, string[]> = {
      restriction: ["accuracy_dispute", "objection", "safeguarding", "other"],
      legal_hold: ["legal_claim", "complaint", "investigation", "retention_duty", "other"],
      safeguarding_hold: ["safeguarding", "complaint", "investigation", "other"],
    };
    if (!categoryForKind[parsed.data.kind].includes(parsed.data.reasonCategory)) {
      res.status(400).json({ error: "The reason category does not match the control kind." });
      return;
    }

    try {
      const result = await db.transaction(async (tx) => {
        await acquireRetentionPolicyMutationLock(tx, orgId);
        const [request] = await tx
          .select({
            id: studentDataRequestsTable.id,
            studentSessionId: studentDataRequestsTable.studentSessionId,
            classIdSnapshot: studentDataRequestsTable.classIdSnapshot,
          })
          .from(studentDataRequestsTable)
          .where(and(
            eq(studentDataRequestsTable.id, params.data.id),
            eq(studentDataRequestsTable.organisationId, orgId),
          ))
          .for("update");
        if (!request) return null;
        const now = new Date();
        const startDate = new Date(`${parsed.data.startDate}T00:00:00.000Z`);
        const reviewDate = new Date(`${parsed.data.reviewDate}T00:00:00.000Z`);
        const expiryDate = parsed.data.expiryDate
          ? new Date(`${parsed.data.expiryDate}T00:00:00.000Z`)
          : null;
        const processingLimits = parsed.data.kind === "restriction"
          ? parsed.data.processingLimits
          : Array.from(new Set([...parsed.data.processingLimits, "deletion"]));
        const [control] = await tx.insert(studentDataRequestControlsTable).values({
          organisationId: orgId,
          requestId: request.id,
          accountableOwnerTeacherId: req.teacher!.id,
          affectedStudentSessionId: request.studentSessionId,
          affectedClassId: request.classIdSnapshot,
          affectedDataCategories: parsed.data.affectedDataCategories,
          kind: parsed.data.kind,
          reasonCategory: parsed.data.reasonCategory,
          reasonSummary: parsed.data.reasonSummary,
          accessLimits: parsed.data.accessLimits,
          processingLimits,
          startDate,
          reviewDate,
          expiryDate,
          lifecycleState: "active",
          createdAt: now,
          updatedAt: now,
        }).returning();
        await tx.insert(studentDataRequestControlEventsTable).values({
          organisationId: orgId,
          controlId: control.id,
          eventType: "applied",
          note: parsed.data.reasonSummary,
          lifecycleState: "active",
          actorTeacherId: req.teacher!.id,
          occurredAt: now,
        });
        await tx.insert(auditLogTable).values({
          organisationId: orgId,
          teacherId: req.teacher!.id,
          action: "student_data_request_control.applied",
          metadata: {
            controlId: control.id,
            requestId: request.id,
            kind: control.kind,
            reasonCategory: control.reasonCategory,
            affectedStudentSessionId: control.affectedStudentSessionId,
            affectedClassId: control.affectedClassId,
            affectedDataCategories: control.affectedDataCategories,
            accessLimits: control.accessLimits,
            processingLimits: control.processingLimits,
            startDate: control.startDate.toISOString(),
            reviewDate: control.reviewDate.toISOString(),
            expiryDate: control.expiryDate?.toISOString() ?? null,
          },
          ipAddress: req.ip,
        });
        return control;
      });
      if (!result) {
        res.status(404).json({ error: "Student data request not found" });
        return;
      }
      res.status(201).json(serialiseStudentDataRequestControl(result, []));
    } catch (error) {
      req.log.error({ err: error }, "Student data request control could not be applied");
      res.status(503).json({ error: "The control could not be saved because its audit record could not be stored." });
    }
  },
);

router.patch(
  "/teacher/org/student-data-requests/:id/controls/:controlId",
  requireTeacher,
  requireLeadSchoolAdministrator,
  async (req, res): Promise<void> => {
    const params = StudentDataRequestControlIdParams.safeParse(req.params);
    const parsed = StudentDataRequestControlActionBody.safeParse(req.body);
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }
    if (!params.success || !parsed.success) {
      const error = !params.success
        ? params.error.message
        : !parsed.success
          ? parsed.error.message
          : "Invalid control action";
      res.status(400).json({ error });
      return;
    }
    try {
      const result = await db.transaction(async (tx) => {
        await acquireRetentionPolicyMutationLock(tx, orgId);
        const [control] = await tx
          .select()
          .from(studentDataRequestControlsTable)
          .where(and(
            eq(studentDataRequestControlsTable.id, params.data.controlId),
            eq(studentDataRequestControlsTable.requestId, params.data.id),
            eq(studentDataRequestControlsTable.organisationId, orgId),
          ))
          .for("update");
        if (!control) return { kind: "missing" as const };
        if (control.lifecycleState !== "active") return { kind: "finalised" as const };
        const now = new Date();
        let nextState: "active" | "expired" | "lifted" = control.lifecycleState;
        if (parsed.data.action === "expire") {
          if (!control.expiryDate || control.expiryDate > now) return { kind: "not_due" as const };
          nextState = "expired";
        } else if (parsed.data.action === "lift") {
          nextState = "lifted";
        }
        const eventType = parsed.data.action === "review"
          ? "reviewed"
          : parsed.data.action === "expire"
            ? "expired"
            : "lifted";
        await tx.insert(studentDataRequestControlEventsTable).values({
          organisationId: orgId,
          controlId: control.id,
          eventType,
          note: parsed.data.note,
          lifecycleState: nextState,
          actorTeacherId: req.teacher!.id,
          occurredAt: now,
        });
        const [updated] = await tx.update(studentDataRequestControlsTable)
          .set({
            lifecycleState: nextState,
            lastReviewedAt: parsed.data.action === "review" ? now : control.lastReviewedAt,
            endedAt: parsed.data.action === "review" ? control.endedAt : now,
            updatedAt: now,
          })
          .where(and(
            eq(studentDataRequestControlsTable.id, control.id),
            eq(studentDataRequestControlsTable.lifecycleState, "active"),
          ))
          .returning();
        if (!updated) return { kind: "finalised" as const };
        await tx.insert(auditLogTable).values({
          organisationId: orgId,
          teacherId: req.teacher!.id,
          action: `student_data_request_control.${parsed.data.action}`,
          metadata: {
            controlId: updated.id,
            requestId: updated.requestId,
            kind: updated.kind,
            reasonCategory: updated.reasonCategory,
            lifecycleState: updated.lifecycleState,
            eventType: parsed.data.action === "review" ? "reviewed" : parsed.data.action,
            affectedDataCategories: updated.affectedDataCategories,
          },
          ipAddress: req.ip,
        });
        const events = await tx.select().from(studentDataRequestControlEventsTable)
          .where(eq(studentDataRequestControlEventsTable.controlId, updated.id))
          .orderBy(asc(studentDataRequestControlEventsTable.occurredAt));
        return { kind: "updated" as const, control: updated, events };
      });
      if (result.kind === "missing") {
        res.status(404).json({ error: "Student data request control not found" });
        return;
      }
      if (result.kind === "finalised") {
        res.status(409).json({ error: "This control has already ended; its evidence is read-only." });
        return;
      }
      if (result.kind === "not_due") {
        res.status(409).json({ error: "A control can only be expired after its recorded expiry date." });
        return;
      }
      res.json(serialiseStudentDataRequestControl(result.control, result.events));
    } catch (error) {
      req.log.error({ err: error }, "Student data request control could not be updated");
      res.status(503).json({ error: "The control could not be updated because its audit record could not be stored." });
    }
  },
);

router.get(
  "/teacher/org/student-data-request-students",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    const parsed = studentDataRequestQuery.safeParse(req.query);
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const conditions = [
      eq(teachersTable.organisationId, orgId),
    ];
    if (parsed.data.q) {
      conditions.push(ilike(studentSessionsTable.studentName, `%${parsed.data.q}%`));
    }
    const students = await db
      .select({
        id: studentSessionsTable.id,
        studentName: studentSessionsTable.studentName,
        classId: classesTable.id,
        className: classesTable.name,
        classArchivedAt: classesTable.archivedAt,
      })
      .from(studentSessionsTable)
      .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
      .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
      .where(and(...conditions))
      .orderBy(asc(studentSessionsTable.studentName), asc(classesTable.name))
      .limit(100);

    res.json(students);
  },
);

router.get(
  "/teacher/org/student-data-requests",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }

    const rows = await db
      .select({
        id: studentDataRequestsTable.id,
        studentSessionId: studentDataRequestsTable.studentSessionId,
        studentNameSnapshot: studentDataRequestsTable.studentNameSnapshot,
        classIdSnapshot: studentDataRequestsTable.classIdSnapshot,
        classNameSnapshot: studentDataRequestsTable.classNameSnapshot,
        requestType: studentDataRequestsTable.requestType,
        reason: studentDataRequestsTable.reason,
        approvalBasis: studentDataRequestsTable.approvalBasis,
        status: studentDataRequestsTable.status,
        outcome: studentDataRequestsTable.outcome,
        createdByTeacherId: studentDataRequestsTable.createdByTeacherId,
        reviewedByTeacherId: studentDataRequestsTable.reviewedByTeacherId,
        exportCount: studentDataRequestsTable.exportCount,
        lastExportedAt: studentDataRequestsTable.lastExportedAt,
        createdAt: studentDataRequestsTable.createdAt,
        updatedAt: studentDataRequestsTable.updatedAt,
        completedAt: studentDataRequestsTable.completedAt,
        currentStudentName: studentSessionsTable.studentName,
        currentClassId: classesTable.id,
        currentClassName: classesTable.name,
      })
      .from(studentDataRequestsTable)
      .leftJoin(studentSessionsTable, eq(studentDataRequestsTable.studentSessionId, studentSessionsTable.id))
      .leftJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
      .where(eq(studentDataRequestsTable.organisationId, orgId))
      .orderBy(desc(studentDataRequestsTable.createdAt))
      .limit(200);

    res.json({ items: rows.map(serialiseStudentDataRequest) });
  },
);

router.post(
  "/teacher/org/student-data-requests",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    const parsed = StudentDataRequestBody.safeParse(req.body);
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    if (["correction", "deletion"].includes(parsed.data.requestType) && !parsed.data.approvalBasis) {
      res.status(400).json({ error: "Correction and deletion requests require the school's documented approval or retention basis." });
      return;
    }

    try {
      const created = await db.transaction(async (tx) => {
        const [student] = await tx
          .select({
            id: studentSessionsTable.id,
            studentName: studentSessionsTable.studentName,
            classId: classesTable.id,
            className: classesTable.name,
          })
          .from(studentSessionsTable)
          .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
          .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
          .where(and(
            eq(studentSessionsTable.id, parsed.data.studentSessionId),
            eq(teachersTable.organisationId, orgId),
          ));
        if (!student) return null;

        const [request] = await tx
          .insert(studentDataRequestsTable)
          .values({
            organisationId: orgId,
            studentSessionId: student.id,
            studentNameSnapshot: student.studentName,
            classIdSnapshot: student.classId,
            classNameSnapshot: student.className,
            requestType: parsed.data.requestType,
            reason: parsed.data.reason,
            approvalBasis: parsed.data.approvalBasis ?? null,
            createdByTeacherId: req.teacher!.id,
          })
          .returning();
        await tx.insert(auditLogTable).values({
          organisationId: orgId,
          teacherId: req.teacher!.id,
          action: "student_data_request.created",
          metadata: {
            requestId: request.id,
            studentSessionId: student.id,
            requestType: request.requestType,
            reason: request.reason,
            approvalBasis: request.approvalBasis,
          },
          ipAddress: req.ip,
        });
        return request;
      });

      if (!created) {
        res.status(404).json({ error: "Student not found in this school" });
        return;
      }
      res.status(201).json(serialiseStudentDataRequest({
        ...created,
        currentStudentName: created.studentNameSnapshot,
        currentClassId: created.classIdSnapshot,
        currentClassName: created.classNameSnapshot,
      }));
    } catch (error) {
      req.log.error({ err: error }, "Student data request could not be created");
      res.status(503).json({ error: "The request could not be saved because its audit record could not be stored." });
    }
  },
);

router.patch(
  "/teacher/org/student-data-requests/:id",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    const params = StudentDataRequestIdParams.safeParse(req.params);
    const parsed = StudentDataRequestUpdateBody.safeParse(req.body);
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    try {
      const updated = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(studentDataRequestsTable)
          .where(and(
            eq(studentDataRequestsTable.id, params.data.id),
            eq(studentDataRequestsTable.organisationId, orgId),
          ))
          .for("update");
        if (!existing) return { kind: "missing" as const };
        if (existing.status === "completed" || existing.status === "refused") {
          return { kind: "finalised" as const };
        }
        if (!canTransitionStudentDataRequest(existing.status, parsed.data.status)) {
          return { kind: "transition_not_allowed" as const };
        }

        const approvalBasis = parsed.data.approvalBasis ?? existing.approvalBasis;
        if (
          (existing.requestType === "correction" || existing.requestType === "deletion" || parsed.data.status === "refused")
          && !approvalBasis
        ) {
          return { kind: "basis_required" as const };
        }
        const terminal = ["completed", "refused", "escalated"].includes(parsed.data.status);
        if (terminal && !(parsed.data.outcome ?? existing.outcome)) {
          return { kind: "outcome_required" as const };
        }

        const [request] = await tx
          .update(studentDataRequestsTable)
          .set({
            status: parsed.data.status,
            outcome: parsed.data.outcome ?? existing.outcome,
            approvalBasis,
            reviewedByTeacherId: req.teacher!.id,
            updatedAt: new Date(),
            completedAt: terminal ? new Date() : existing.completedAt,
          })
          .where(eq(studentDataRequestsTable.id, existing.id))
          .returning();
        await tx.insert(auditLogTable).values({
          organisationId: orgId,
          teacherId: req.teacher!.id,
          action: "student_data_request.updated",
          metadata: {
            requestId: request.id,
            studentSessionId: request.studentSessionId,
            previous: {
              status: existing.status,
              outcome: existing.outcome,
              approvalBasis: existing.approvalBasis,
            },
            current: {
              status: request.status,
              outcome: request.outcome,
              approvalBasis: request.approvalBasis,
            },
          },
          ipAddress: req.ip,
        });
        return { kind: "updated" as const, request };
      });

      if (updated.kind === "missing") {
        res.status(404).json({ error: "Student data request not found" });
        return;
      }
      if (updated.kind === "basis_required") {
        res.status(400).json({ error: "This path requires the school's documented approval or retention basis." });
        return;
      }
      if (updated.kind === "finalised") {
        res.status(409).json({ error: "Completed and refused requests are final. Record a new request if a further decision is needed." });
        return;
      }
      if (updated.kind === "transition_not_allowed") {
        res.status(409).json({ error: "This request cannot move back to an earlier review stage." });
        return;
      }
      if (updated.kind === "outcome_required") {
        res.status(400).json({ error: "Completed, refused, and escalated requests require a documented outcome." });
        return;
      }
      const request = updated.request;
      res.json(serialiseStudentDataRequest({
        ...request,
        currentStudentName: request.studentNameSnapshot,
        currentClassId: request.classIdSnapshot,
        currentClassName: request.classNameSnapshot,
      }));
    } catch (error) {
      req.log.error({ err: error }, "Student data request could not be updated");
      res.status(503).json({ error: "The request could not be updated because its audit record could not be stored." });
    }
  },
);

router.get(
  "/teacher/org/student-data-requests/:id/export",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    const exportFormat = req.query.format === "readable" ? "readable" : "data";
    const exportId = typeof req.query.exportId === "string" ? req.query.exportId : null;
    const params = StudentDataRequestIdParams.safeParse(req.params);
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (exportId && !z.string().uuid().safeParse(exportId).success) {
      res.status(400).json({ error: "exportId must be a valid UUID" });
      return;
    }

    try {
      const result = await db.transaction(async (tx) => {
        await acquireRetentionPolicyMutationLock(tx, orgId);
        const [request] = await tx
          .select()
          .from(studentDataRequestsTable)
          .where(and(
            eq(studentDataRequestsTable.id, params.data.id),
            eq(studentDataRequestsTable.organisationId, orgId),
          ))
          .for("update");
        if (!request) return { kind: "missing" as const };
        if (request.status === "refused") return { kind: "refused" as const };
        const exportType = exportFormat === "readable" ? "readable_student_record" : "data_files";
        const existingExport = exportId
          ? await tx
            .select({ id: auditLogTable.id })
            .from(auditLogTable)
            .where(and(
              eq(auditLogTable.organisationId, orgId),
              eq(auditLogTable.action, "student_data_request.exported"),
              sql`${auditLogTable.metadata} ->> 'requestId' = ${String(request.id)}`,
              sql`${auditLogTable.metadata} ->> 'exportId' = ${exportId}`,
              sql`${auditLogTable.metadata} ->> 'exportType' = ${exportType}`,
            ))
            .limit(1)
          : [];
        const shouldRecordExport = existingExport.length === 0;

        const activeControls = await tx
          .select({
            id: studentDataRequestControlsTable.id,
            kind: studentDataRequestControlsTable.kind,
            reasonCategory: studentDataRequestControlsTable.reasonCategory,
            affectedDataCategories: studentDataRequestControlsTable.affectedDataCategories,
            accessLimits: studentDataRequestControlsTable.accessLimits,
            processingLimits: studentDataRequestControlsTable.processingLimits,
          })
          .from(studentDataRequestControlsTable)
          .where(and(
            eq(studentDataRequestControlsTable.organisationId, orgId),
            eq(studentDataRequestControlsTable.lifecycleState, "active"),
            or(
              eq(studentDataRequestControlsTable.requestId, request.id),
              eq(studentDataRequestControlsTable.affectedStudentSessionId, request.studentSessionId ?? -1),
              eq(studentDataRequestControlsTable.affectedClassId, request.classIdSnapshot ?? -1),
            ),
          ));
        const exportControls = activeControls.filter((control) =>
          control.accessLimits.includes("export") || control.processingLimits.includes("export")
        );
        if (exportControls.length) {
          return {
            kind: "controlled" as const,
            controls: exportControls.map(({ id, kind, reasonCategory, affectedDataCategories }) => ({
              id,
              kind,
              reasonCategory,
              affectedDataCategories,
            })),
          };
        }

        const [student] = await tx
          .select({
            id: studentSessionsTable.id,
            studentName: studentSessionsTable.studentName,
            createdAt: studentSessionsTable.createdAt,
            registrationStatus: studentSessionsTable.registrationStatus,
            lockedAt: studentSessionsTable.lockedAt,
            archivedAt: studentSessionsTable.archivedAt,
            retentionUntil: studentSessionsTable.retentionUntil,
            answerFeedbackAttempts: studentSessionsTable.answerFeedbackAttempts,
             studentInsights: studentSessionsTable.studentInsights,
             developmentAnalysisReport: studentSessionsTable.developmentAnalysisReport,
             developmentAnalysisGeneratedAt: studentSessionsTable.developmentAnalysisGeneratedAt,
             developmentAnalysisStatus: studentSessionsTable.developmentAnalysisStatus,
            classId: classesTable.id,
            className: classesTable.name,
            subject: classesTable.subject,
            teacherName: teachersTable.name,
            schoolName: organisationsTable.name,
            taskId: tasksTable.id,
            taskTitle: tasksTable.title,
             taskSubject: tasksTable.subject,
            taskQuestion: tasksTable.question,
            taskNotes: tasksTable.notes,
            taskSuccessCriteria: tasksTable.successCriteria,
             taskKeyVocabulary: tasksTable.keyVocabulary,
             taskExpectedLength: tasksTable.expectedLength,
             taskEnabledStages: tasksTable.enabledStages,
             taskFormativeAssessmentDate: tasksTable.formativeAssessmentDate,
             taskSummativeAssessmentDate: tasksTable.summativeAssessmentDate,
            taskResources: tasksTable.resources,
            taskCreatedAt: tasksTable.createdAt,
            taskDueDate: tasksTable.dueDate,
          })
          .from(studentSessionsTable)
          .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
          .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
          .innerJoin(organisationsTable, eq(teachersTable.organisationId, organisationsTable.id))
          .leftJoin(tasksTable, eq(tasksTable.classId, classesTable.id))
          .where(and(
            eq(studentSessionsTable.id, request.studentSessionId ?? -1),
            eq(teachersTable.organisationId, orgId),
          ));
        if (!student) return { kind: "student_unavailable" as const };

        const requestHistoryRows = await tx
          .select({
            action: auditLogTable.action,
            createdAt: auditLogTable.createdAt,
            metadata: auditLogTable.metadata,
          })
          .from(auditLogTable)
          .where(and(
            eq(auditLogTable.organisationId, orgId),
            sql`${auditLogTable.metadata} ->> 'requestId' = ${String(request.id)}`,
          ))
          .orderBy(asc(auditLogTable.createdAt), asc(auditLogTable.id));
        const requestHistory = requestHistoryRows.map((event) => {
          const metadata = isRecord(event.metadata) ? event.metadata : {};
          const current = isRecord(metadata.current) ? metadata.current : {};
          return {
            action: event.action.replace(/^student_data_request\./, ""),
            createdAt: event.createdAt,
            exportType: typeof metadata.exportType === "string" ? metadata.exportType : null,
            status: typeof current.status === "string" ? current.status : null,
            outcome: typeof current.outcome === "string" ? current.outcome : null,
          };
        });
        const answerFeedbackAttempts = exportTeacherAnswerFeedbackAttempts(student.answerFeedbackAttempts);
        const [stageEntries, activitySessions, feedback, chatMessages, teacherMessages] = await Promise.all([
          tx.select({
            id: stageEntriesTable.id,
            stage: stageEntriesTable.stage,
            contentJson: stageEntriesTable.contentJson,
            updatedAt: stageEntriesTable.updatedAt,
          }).from(stageEntriesTable).where(eq(stageEntriesTable.sessionId, student.id)).orderBy(asc(stageEntriesTable.stage)),
          tx.select({
            id: studentActivitySessionsTable.id,
            loginSessionId: studentActivitySessionsTable.loginSessionId,
            startedAt: studentActivitySessionsTable.startedAt,
            lastSeenAt: studentActivitySessionsTable.lastSeenAt,
            endedAt: studentActivitySessionsTable.endedAt,
            activeStage: studentActivitySessionsTable.activeStage,
            pageDurations: studentActivitySessionsTable.pageDurations,
            endReason: studentActivitySessionsTable.endReason,
          }).from(studentActivitySessionsTable).where(eq(studentActivitySessionsTable.studentSessionId, student.id)).orderBy(asc(studentActivitySessionsTable.startedAt)),
          tx.select({
            stage: teacherFeedbackTable.stage,
            grade: teacherFeedbackTable.grade,
            comment: teacherFeedbackTable.comment,
            formativeComment: teacherFeedbackTable.formativeComment,
            studentAcknowledged: teacherFeedbackTable.studentAcknowledged,
            updatedAt: teacherFeedbackTable.updatedAt,
          }).from(teacherFeedbackTable).where(eq(teacherFeedbackTable.sessionId, student.id)).orderBy(asc(teacherFeedbackTable.stage)),
          tx.select({
            id: chatMessagesTable.id,
            role: chatMessagesTable.role,
            content: chatMessagesTable.content,
            bloomLevel: chatMessagesTable.bloomLevel,
            createdAt: chatMessagesTable.createdAt,
          }).from(chatMessagesTable).where(and(
            eq(chatMessagesTable.sessionId, student.id),
            ne(chatMessagesTable.role, "system"),
          )).orderBy(asc(chatMessagesTable.createdAt)),
          tx.select({
            id: teacherMessagesTable.id,
            teacherId: teacherMessagesTable.teacherId,
            senderType: teacherMessagesTable.senderType,
            content: teacherMessagesTable.content,
            createdAt: teacherMessagesTable.createdAt,
            teacherReadAt: teacherMessagesTable.teacherReadAt,
            studentReadAt: teacherMessagesTable.studentReadAt,
          }).from(teacherMessagesTable)
            .where(eq(teacherMessagesTable.studentSessionId, student.id))
            .orderBy(asc(teacherMessagesTable.createdAt), asc(teacherMessagesTable.id)),
        ]);
        const snapshots = await tx.select({
          id: developmentSnapshotsTable.id,
          snapshotKind: developmentSnapshotsTable.snapshotKind,
          payload: developmentSnapshotsTable.payload,
          triggerEvent: developmentSnapshotsTable.triggerEvent,
          teacherId: developmentSnapshotsTable.teacherId,
          createdAt: developmentSnapshotsTable.createdAt,
        }).from(developmentSnapshotsTable)
          .where(eq(developmentSnapshotsTable.sessionId, student.id))
          .orderBy(asc(developmentSnapshotsTable.createdAt));
        const finalisationSnapshot = snapshots.find((snapshot) => snapshot.snapshotKind === "answer_assessment_finalisation");
        const answerVersions = [
          ...answerFeedbackAttempts.map((attempt, index) => ({
            version: index + 1,
            label: `Final answer version ${index + 1}`,
            answer: attempt.answerSnapshot,
            feedback: attempt.feedback,
            createdAt: attempt.createdAt,
          })),
          ...(finalisationSnapshot && typeof finalAnswerFromSnapshot(finalisationSnapshot as any) === "string"
            ? [{
              version: answerFeedbackAttempts.length + 1,
              label: "Final answer at assessment finalisation",
              answer: finalAnswerFromSnapshot(finalisationSnapshot as any),
              feedback: null,
              createdAt: finalisationSnapshot.createdAt,
            }]
            : []),
        ];
        const activity = serialiseActivityLog(activitySessions);
        const firstActivity = activity.entries[0];
        const lastActivity = activity.entries.at(-1);
        const generatedAt = new Date();
          const payload = {
          exportVersion: "2",
          generatedAt,
          periodCovered: firstActivity?.startedAt && lastActivity?.lastSeenAt
            ? `${firstActivity.startedAt.toISOString()} – ${lastActivity.lastSeenAt.toISOString()}`
            : null,
          request: {
            id: request.id,
            requestType: request.requestType,
            status: request.status,
             createdAt: request.createdAt,
             updatedAt: request.updatedAt,
             completedAt: request.completedAt,
          },
          student: {
            id: student.id,
            name: student.studentName,
            createdAt: student.createdAt,
            registrationStatus: student.registrationStatus,
            lockedAt: student.lockedAt,
            archivedAt: student.archivedAt,
            retentionUntil: student.retentionUntil,
            class: {
              id: student.classId,
              name: student.className,
              subject: student.subject,
            },
          },
          school: { name: student.schoolName },
          teacher: { name: student.teacherName },
          task: student.taskId ? {
            id: student.taskId,
            title: student.taskTitle,
             subject: student.taskSubject ?? student.subject,
            question: student.taskQuestion,
            instructions: student.taskNotes ?? null,
            successCriteria: student.taskSuccessCriteria ?? [],
             keyVocabulary: student.taskKeyVocabulary ?? [],
             expectedLength: student.taskExpectedLength,
             enabledStages: student.taskEnabledStages ?? [],
             formativeAssessmentDate: student.taskFormativeAssessmentDate,
             summativeAssessmentDate: student.taskSummativeAssessmentDate,
            resources: student.taskResources ?? [],
            assignmentDate: student.taskCreatedAt,
            deadline: student.taskDueDate,
            completionStatus: student.lockedAt ? "Complete and locked" : "In progress or not yet locked",
          } : null,
          learning: { stageEntries },
          activity,
          feedback,
          aiConversations: chatMessages,
          teacherMessages,
           answerFeedbackAttempts,
           answerVersions,
           studentInsights: student.studentInsights ?? {},
           developmentAnalysis: {
             report: student.developmentAnalysisStatus === "ready" && isRecord(student.developmentAnalysisReport)
               ? student.developmentAnalysisReport
               : null,
             status: student.developmentAnalysisStatus,
             generatedAt: student.developmentAnalysisGeneratedAt,
           },
           requestHistory,
          developmentSnapshots: snapshots,
           includedCategories: ["identity", "task", "learning", "activity", "feedback", "ai_conversations", "answer_versions", "student_insights", "development_analysis", "development_snapshots", "teacher_messages", "request_history"],
          excluded: [
            "passwords, PINs, MFA secrets, recovery codes, and API keys",
            "hidden system prompts and developer instructions",
            "private class/task configuration not shown in the student or teacher views",
            "other students and other schools",
            "unrelated security and infrastructure logs",
          ],
        };
        const pdf = exportFormat === "readable"
          ? await renderStudentDataExportPdf(payload)
          : null;

        if (shouldRecordExport) {
          await tx.update(studentDataRequestsTable)
            .set({
              exportCount: sql`${studentDataRequestsTable.exportCount} + 1`,
              lastExportedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(and(
              eq(studentDataRequestsTable.id, request.id),
              eq(studentDataRequestsTable.organisationId, orgId),
            ));
          await tx.insert(auditLogTable).values({
            organisationId: orgId,
            teacherId: req.teacher!.id,
            action: "student_data_request.exported",
            metadata: {
              requestId: request.id,
              studentSessionId: student.id,
              exportType,
              ...(exportId ? { exportId } : {}),
               includedCategories: ["identity", "task", "learning", "activity", "feedback", "ai_conversations", "development_snapshots", "teacher_messages"],
            },
            ipAddress: req.ip,
          });
        }
        return {
          kind: "export" as const,
          payload,
          pdf,
        };
      });
      if (result.kind === "missing") {
        res.status(404).json({ error: "Student data request not found" });
        return;
      }
      if (result.kind === "refused") {
        res.status(409).json({ error: "A refused request cannot produce a student data export." });
        return;
      }
      if (result.kind === "controlled") {
        res.status(409).json({
          error: "This export is paused by an active request control whose scope includes export.",
          blockReason: "active_control",
          controls: result.controls,
        });
        return;
      }
      if (result.kind === "student_unavailable") {
        res.status(409).json({ error: "The student record is no longer available for export." });
        return;
      }
      if (exportFormat === "readable") {
        res.status(200)
          .type("application/pdf")
          .set("Content-Disposition", `attachment; filename="student-record-${params.data.id}.pdf"`)
          .send(result.pdf);
        return;
      }
      res.status(200)
        .type("application/json")
        .set("Content-Disposition", `attachment; filename="student-data-request-${params.data.id}.json"`)
        .json(result.payload);
    } catch (error) {
      req.log.error({ err: error }, "Student data export audit could not be stored");
      res.status(503).json({ error: "The export was not prepared because its audit record could not be stored." });
    }
  },
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const INSIGHT_STAGE_NAMES = ["MAP", "TORCH", "RESEARCH", "COMPASS", "EMBED"] as const;

function hasSubstantiveStageEvidence(contentJson: unknown): boolean {
  if (!isRecord(contentJson)) return false;
  return Object.entries(contentJson).some(([key, value]) => {
    if (key === "_studentCompletion" || value === null || value === undefined) return false;
    if (typeof value === "string") return Boolean(value.trim());
    if (Array.isArray(value)) {
      return value.some((item) => typeof item === "string"
        ? Boolean(item.trim())
        : item !== null && item !== undefined);
    }
    return typeof value === "object" ? Object.keys(value as object).length > 0 : Boolean(value);
  });
}

function fallbackStageEvidenceProfile(payload: unknown) {
  const sourceEntries = isRecord(payload) && Array.isArray(payload.stageEntries) ? payload.stageEntries : [];
  return INSIGHT_STAGE_NAMES.map((stage) => {
    const entry = sourceEntries.find((item) => isRecord(item) && item.stage === stage);
    const contentJson = isRecord(entry) ? entry.contentJson : undefined;
    const markedComplete = isRecord(contentJson)
      && isRecord(contentJson._studentCompletion)
      && contentJson._studentCompletion.complete === true;
    const substantiveEvidenceRecorded = hasSubstantiveStageEvidence(contentJson);
    return {
      stage,
      visited: Boolean(entry),
      markedComplete,
      substantiveEvidenceRecorded,
      learningEvidenceStatus: "not_assessable",
      learningEvidence: substantiveEvidenceRecorded
        ? "Learning evidence was not separately assessed in this previously generated report."
        : "No substantive recorded evidence was available for a learning judgement.",
    };
  });
}

function safeComplianceAuditEvent(event: { action: string; metadata: unknown; createdAt: Date }): Record<string, unknown> {
  const metadata = isRecord(event.metadata) ? event.metadata : {};
  const base = { action: event.action, createdAt: event.createdAt };

  if (event.action === "organisation.ai_data_processing_acknowledged") {
    return {
      ...base,
      provider: metadata.aiProvider === "gemini" || metadata.aiProvider === "azure" ? metadata.aiProvider : "recorded",
      policyVersionRecorded: typeof metadata.dataProcessingPolicyVersion === "string" && metadata.dataProcessingPolicyVersion.length > 0,
      evidenceReferenceRecorded: typeof metadata.dataProcessingEvidenceReference === "string" && metadata.dataProcessingEvidenceReference.length > 0,
      processingRegionRecorded: typeof metadata.dataProcessingRegion === "string" && metadata.dataProcessingRegion.length > 0,
      retentionAndNoTrainingConfirmed: metadata.dataRetentionNoTrainingConfirmed === true,
      schoolPoliciesConfirmed: metadata.schoolPoliciesConfirmed === true,
      reviewDateRecorded: typeof metadata.dataProcessingReviewDate === "string",
    };
  }

  if (event.action === "organisation.ai_connection_disabled") {
    return {
      ...base,
      previousProvider: metadata.previousAiProvider === "gemini" || metadata.previousAiProvider === "azure"
        ? metadata.previousAiProvider
        : "recorded",
      credentialRemoved: metadata.credentialRemoved === true,
      reason: typeof metadata.reason === "string" && metadata.reason.length > 0 ? metadata.reason : null,
    };
  }

  if (event.action === "organisation.retention_default_updated") {
    return {
      ...base,
      scope: "school_wide_default",
      retentionDays: typeof metadata.retentionDays === "number" ? metadata.retentionDays : null,
      deletionStatus: typeof metadata.deletionStatus === "string" && ["retained", "scheduled", "under_review"].includes(metadata.deletionStatus)
        ? metadata.deletionStatus
        : "recorded",
      reviewDateRecorded: metadata.reviewDate !== undefined,
    };
  }

  if (event.action === "organisation.retention_policy_updated") {
    return {
      ...base,
      scope: "category_exception",
      dataCategory: typeof metadata.dataCategory === "string" && RETENTION_CATEGORIES.includes(metadata.dataCategory as (typeof RETENTION_CATEGORIES)[number])
        ? metadata.dataCategory
        : "recorded",
      retentionDays: typeof metadata.retentionDays === "number" ? metadata.retentionDays : null,
      deletionStatus: typeof metadata.deletionStatus === "string" && ["retained", "scheduled", "under_review"].includes(metadata.deletionStatus)
        ? metadata.deletionStatus
        : "recorded",
      reviewDateRecorded: metadata.reviewDate !== undefined,
    };
  }

  if (event.action === "organisation.retention_policy_removed") {
    return {
      ...base,
      scope: "category_exception",
      dataCategory: typeof metadata.dataCategory === "string" && RETENTION_CATEGORIES.includes(metadata.dataCategory as (typeof RETENTION_CATEGORIES)[number])
        ? metadata.dataCategory
        : "recorded",
      change: "removed",
    };
  }

  if (event.action === "organisation.retention_operator_verified") {
    return {
      ...base,
      dataCategory: typeof metadata.dataCategory === "string" ? metadata.dataCategory : "recorded",
      verification: "recorded",
    };
  }

  if (event.action === "organisation.retention_records_processed" || event.action === "organisation.retention_enforcement_blocked") {
    return {
      ...base,
      dataCategory: typeof metadata.dataCategory === "string" && RETENTION_CATEGORIES.includes(metadata.dataCategory as (typeof RETENTION_CATEGORIES)[number])
        ? metadata.dataCategory
        : "recorded",
      outcome: metadata.outcome === "deleted" || metadata.outcome === "anonymised" || metadata.outcome === "blocked"
        ? metadata.outcome
        : "recorded",
      recordsAffected: typeof metadata.recordsAffected === "number" ? metadata.recordsAffected : 0,
      blockedReason: metadata.blockedReason === "legal_hold" || metadata.blockedReason === "missing_operator_verification" || metadata.blockedReason === "policy_not_scheduled"
        ? metadata.blockedReason
        : null,
    };
  }

  return {
    ...base,
    provider: metadata.aiProvider === "gemini" || metadata.aiProvider === "azure" ? metadata.aiProvider : "recorded",
    reason: metadata.reason === "platform_configuration_changed" ? metadata.reason : "recorded",
  };
}

router.get(
  "/teacher/org/ai-settings",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }

    const [org] = await db
      .select({
        aiProvider: organisationsTable.aiProvider,
        aiKeyEncrypted: organisationsTable.aiKeyEncrypted,
        azureEndpoint: organisationsTable.azureEndpoint,
        aiDataProcessingAcknowledged: organisationsTable.aiDataProcessingAcknowledged,
        aiDataProcessingAcknowledgedAt: organisationsTable.aiDataProcessingAcknowledgedAt,
        dataProcessingApproverRecorded: sql<boolean>`${organisationsTable.aiDataProcessingAcknowledgedByTeacherId} IS NOT NULL`,
        aiDataProcessingPolicyVersion: organisationsTable.aiDataProcessingPolicyVersion,
        aiDataProcessingEvidenceReference: organisationsTable.aiDataProcessingEvidenceReference,
        aiDataProcessingRegion: organisationsTable.aiDataProcessingRegion,
        aiDataRetentionNoTrainingConfirmed: organisationsTable.aiDataRetentionNoTrainingConfirmed,
        aiSchoolPoliciesConfirmed: organisationsTable.aiSchoolPoliciesConfirmed,
        aiDataProcessingReviewDate: organisationsTable.aiDataProcessingReviewDate,
        researchProcessingBlocked: organisationsTable.researchProcessingBlocked,
      })
      .from(organisationsTable)
      .where(eq(organisationsTable.id, orgId));

    if (!org) {
      res.status(404).json({ error: "Organisation not found" });
      return;
    }

    const masked = org.aiKeyEncrypted ? maskApiKey(decrypt(org.aiKeyEncrypted)) : null;

    res.json({
      configured: !!org.aiKeyEncrypted,
      aiProvider: org.aiProvider,
      aiKeyMasked: masked,
      azureEndpoint: org.azureEndpoint,
      dataProcessingAcknowledged: org.aiDataProcessingAcknowledged,
      dataProcessingAcknowledgedAt: org.aiDataProcessingAcknowledgedAt,
      dataProcessingApproverRecorded: org.dataProcessingApproverRecorded,
      dataProcessingPolicyVersion: org.aiDataProcessingPolicyVersion,
      dataProcessingEvidenceReference: org.aiDataProcessingEvidenceReference,
      dataProcessingRegion: org.aiDataProcessingRegion,
      dataRetentionNoTrainingConfirmed: org.aiDataRetentionNoTrainingConfirmed,
      schoolPoliciesConfirmed: org.aiSchoolPoliciesConfirmed,
      dataProcessingReviewDate: org.aiDataProcessingReviewDate,
      researchProcessingBlocked: org.researchProcessingBlocked,
    });
  },
);

const UpdateOrgAiSettingsBody = z.object({
  aiProvider: z.enum(["gemini", "azure"]),
  aiKey: z.string().min(1),
  azureEndpoint: z.string().trim().url().optional(),
  dataProcessingAcknowledged: z.literal(true),
  dataProcessingRegionConfirmed: z.literal(true),
  dataProcessingPolicyVersion: z.string().trim().max(160).optional(),
  dataProcessingEvidenceReference: z.string().trim().max(500).optional(),
  dataProcessingRegion: z.literal("UK"),
  dataRetentionNoTrainingConfirmed: z.literal(true),
  // Accepted for compatibility with older clients, but no longer required.
  schoolPoliciesConfirmed: z.literal(true).optional(),
  dataProcessingReviewDate: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().date().optional(),
  ),
});

router.put(
  "/teacher/org/ai-settings",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const parsed = UpdateOrgAiSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }

    const {
      aiProvider,
      aiKey,
      azureEndpoint,
      dataProcessingPolicyVersion,
      dataProcessingEvidenceReference,
      dataProcessingRegion,
      schoolPoliciesConfirmed,
      dataProcessingReviewDate,
    } = parsed.data;

    if (aiProvider === "azure" && !azureEndpoint) {
      res.status(400).json({ error: "azureEndpoint required for Azure provider" });
      return;
    }

    const encrypted = encrypt(aiKey);
    const approvalRecordedAt = new Date();
    const reviewDate = dataProcessingReviewDate
      ? new Date(`${dataProcessingReviewDate}T00:00:00.000Z`)
      : null;

    let org;
    try {
      org = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select({
            aiProvider: organisationsTable.aiProvider,
            aiKeyEncrypted: organisationsTable.aiKeyEncrypted,
            azureEndpoint: organisationsTable.azureEndpoint,
            aiDataProcessingAcknowledged: organisationsTable.aiDataProcessingAcknowledged,
          })
          .from(organisationsTable)
          .where(eq(organisationsTable.id, orgId));

        const credentialChanged = existing?.aiKeyEncrypted
          ? decrypt(existing.aiKeyEncrypted) !== aiKey
          : Boolean(existing?.aiKeyEncrypted) !== Boolean(aiKey);
        const configurationChanged = Boolean(existing?.aiDataProcessingAcknowledged) && (
          existing?.aiProvider !== aiProvider
          || (existing?.azureEndpoint ?? null) !== (azureEndpoint ?? null)
          || credentialChanged
        );

        if (configurationChanged) {
          await tx.insert(auditLogTable).values({
            organisationId: orgId,
            teacherId: req.teacher!.id,
            action: "organisation.ai_data_processing_revoked",
            metadata: { reason: "provider_or_credential_changed", aiProvider },
            ipAddress: req.ip,
          });
        }

        const [updated] = await tx
          .update(organisationsTable)
          .set({
            aiProvider,
            aiKeyEncrypted: encrypted,
            azureEndpoint: azureEndpoint ?? null,
            aiDataProcessingAcknowledged: true,
            aiDataProcessingAcknowledgedAt: approvalRecordedAt,
            aiDataProcessingAcknowledgedByTeacherId: req.teacher!.id,
            aiDataProcessingPolicyVersion: dataProcessingPolicyVersion || null,
            aiDataProcessingEvidenceReference: dataProcessingEvidenceReference || null,
            aiDataProcessingRegion: dataProcessingRegion,
            aiDataRetentionNoTrainingConfirmed: true,
            // This older evidence flag is not part of the three required
            // confirmations. Preserve it only when an older client explicitly
            // supplies it, otherwise do not carry it into a new approval.
            aiSchoolPoliciesConfirmed: schoolPoliciesConfirmed === true,
            aiDataProcessingReviewDate: reviewDate,
          })
          .where(eq(organisationsTable.id, orgId))
          .returning({
            id: organisationsTable.id,
            aiProvider: organisationsTable.aiProvider,
            aiDataProcessingAcknowledged: organisationsTable.aiDataProcessingAcknowledged,
            aiDataProcessingAcknowledgedAt: organisationsTable.aiDataProcessingAcknowledgedAt,
            aiDataProcessingReviewDate: organisationsTable.aiDataProcessingReviewDate,
          });
        if (!updated) return null;
        await tx.insert(auditLogTable).values({
          organisationId: orgId,
          teacherId: req.teacher!.id,
          action: "organisation.ai_data_processing_acknowledged",
          metadata: {
            aiProvider,
            dataProcessingPolicyVersion,
            dataProcessingEvidenceReference,
            dataProcessingRegion,
            dataProcessingRegionConfirmed: true,
            dataRetentionNoTrainingConfirmed: true,
            schoolPoliciesConfirmed: schoolPoliciesConfirmed === true,
            dataProcessingReviewDate,
            approvalRecordedAt,
          },
          ipAddress: req.ip,
        });
        return updated;
      });
    } catch {
      res.status(503).json({ error: "AI approval could not be saved because its audit record could not be stored." });
      return;
    }

    if (!org) {
      res.status(404).json({ error: "Organisation not found" });
      return;
    }

    res.json({
      configured: true,
      aiProvider: org.aiProvider,
      aiKeyMasked: maskApiKey(aiKey),
      dataProcessingAcknowledged: org.aiDataProcessingAcknowledged,
      dataProcessingAcknowledgedAt: org.aiDataProcessingAcknowledgedAt,
      dataProcessingReviewDate: org.aiDataProcessingReviewDate,
    });
  },
);

router.delete(
  "/teacher/org/ai-settings",
  requireTeacher,
  requireLeadSchoolAdministrator,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }

    let disabled: { previousAiProvider: string | null } | null;
    try {
      disabled = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select({
            aiProvider: organisationsTable.aiProvider,
            aiKeyEncrypted: organisationsTable.aiKeyEncrypted,
          })
          .from(organisationsTable)
          .where(eq(organisationsTable.id, orgId))
          .for("update");

        if (!existing) return null;

        await tx
          .update(organisationsTable)
          .set({
            aiProvider: null,
            aiKeyEncrypted: null,
            azureEndpoint: null,
            aiDataProcessingAcknowledged: false,
            aiDataProcessingAcknowledgedAt: null,
            aiDataProcessingAcknowledgedByTeacherId: null,
            aiDataProcessingPolicyVersion: null,
            aiDataProcessingEvidenceReference: null,
            aiDataProcessingRegion: null,
            aiDataRetentionNoTrainingConfirmed: false,
            aiSchoolPoliciesConfirmed: false,
            aiDataProcessingReviewDate: null,
          })
          .where(eq(organisationsTable.id, orgId));

        await tx.insert(auditLogTable).values({
          organisationId: orgId,
          teacherId: req.teacher!.id,
          action: "organisation.ai_connection_disabled",
          metadata: {
            previousAiProvider: existing.aiProvider,
            credentialRemoved: Boolean(existing.aiKeyEncrypted),
            reason: "school_master_requested",
          },
          ipAddress: req.ip,
        });

        return { previousAiProvider: existing.aiProvider };
      });
    } catch {
      res.status(503).json({ error: "AI connection could not be disabled because its audit record could not be stored." });
      return;
    }

    if (!disabled) {
      res.status(404).json({ error: "Organisation not found" });
      return;
    }

    res.json({
      configured: false,
      aiProvider: null,
      aiKeyMasked: null,
      azureEndpoint: null,
      dataProcessingAcknowledged: false,
      dataProcessingAcknowledgedAt: null,
      dataProcessingApproverRecorded: false,
      dataProcessingPolicyVersion: null,
      dataProcessingEvidenceReference: null,
      dataProcessingRegion: null,
      dataRetentionNoTrainingConfirmed: false,
      schoolPoliciesConfirmed: false,
      dataProcessingReviewDate: null,
    });
  },
);

const UpdateRetentionPolicyBody = z.object({
  retentionDays: z.coerce.number().int().min(1).max(36_500),
  archiveRetentionDays: z.coerce.number().int().min(1).max(36_500).optional(),
  deletionRecoveryDays: z.coerce.number().int().min(1).max(36_500).optional(),
  applyToExistingArchived: z.boolean().optional().default(false),
  reviewDate: z.string().date(),
  deletionStatus: z.enum(["retained", "scheduled", "under_review"]),
  notes: z.string().trim().max(1_000).optional(),
  legalHold: z.boolean().optional(),
});

function serialiseRetentionPolicy(policy: {
  id: number;
  dataCategory?: string;
  retentionDays: number;
  archiveRetentionDays?: number;
  deletionRecoveryDays?: number;
  reviewDate: Date;
  deletionStatus: string;
  notes: string | null;
  legalHold: boolean;
  operatorVerifiedAt: Date | null;
  operatorVerifiedByTeacherId: number | null;
  updatedByTeacherId: number | null;
  createdAt: Date;
  updatedAt: Date;
}, dataCategory: string, label: string) {
  const blockReason = getRetentionBlockReason(policy);
  return {
    ...policy,
    dataCategory,
    label,
    executionStatus: blockReason ? "blocked" : "ready",
    blockReason,
  };
}

router.get(
  "/teacher/org/retention-policy",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }

    const [[defaultPolicy], exceptions] = await Promise.all([
      db
        .select()
        .from(organisationRetentionDefaultsTable)
        .where(eq(organisationRetentionDefaultsTable.organisationId, orgId)),
      db
        .select()
        .from(organisationRetentionPoliciesTable)
        .where(eq(organisationRetentionPoliciesTable.organisationId, orgId))
        .orderBy(organisationRetentionPoliciesTable.dataCategory),
    ]);

    const platformPolicy = await getPlatformRetentionDefaults();
    res.json({
      platformPolicy,
      defaultPolicy: defaultPolicy
        ? serialiseRetentionPolicy(defaultPolicy, "school_wide_default", "School-wide default")
        : null,
      exceptions: exceptions.map((policy) => serialiseRetentionPolicy(
        policy,
        policy.dataCategory,
        retentionCategoryLabels[policy.dataCategory as keyof typeof retentionCategoryLabels] ?? policy.dataCategory,
      )),
    });
  },
);

router.put(
  "/teacher/org/retention-policy/default",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    const parsed = UpdateRetentionPolicyBody.safeParse(req.body);
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const platformPolicy = await getPlatformRetentionDefaults();
    const requestedArchiveDays = parsed.data.archiveRetentionDays ?? platformPolicy.archiveRetentionDays;
    if (requestedArchiveDays < platformPolicy.minimumDays || requestedArchiveDays > platformPolicy.maximumDays) {
      res.status(400).json({ error: `Archive retention must be between ${platformPolicy.minimumDays} and ${platformPolicy.maximumDays} days.` });
      return;
    }

    const values = {
      retentionDays: parsed.data.retentionDays,
      // Legacy clients may still send category-retention values outside the
      // archive lifecycle allowlist. Keep those values compatible while the
      // new archive setting defaults to an approved period.
      archiveRetentionDays: requestedArchiveDays,
      deletionRecoveryDays: parsed.data.deletionRecoveryDays ?? 30,
      reviewDate: new Date(`${parsed.data.reviewDate}T00:00:00.000Z`),
      deletionStatus: parsed.data.deletionStatus,
      notes: parsed.data.notes || null,
      legalHold: parsed.data.legalHold ?? false,
      operatorVerifiedAt: null,
      operatorVerifiedByTeacherId: null,
      updatedByTeacherId: req.teacher!.id,
      updatedAt: new Date(),
    };
    let policy;
    try {
      policy = await db.transaction(async (tx) => {
        await acquireRetentionPolicyMutationLock(tx, orgId);
        const [previous] = await tx.select().from(organisationRetentionDefaultsTable)
          .where(eq(organisationRetentionDefaultsTable.organisationId, orgId)).for("update");
        const [updated] = await tx.insert(organisationRetentionDefaultsTable)
          .values({ organisationId: orgId, ...values })
          .onConflictDoUpdate({
            target: organisationRetentionDefaultsTable.organisationId,
            set: values,
          })
          .returning();
        let existingArchivesUpdated = 0;
        if (parsed.data.applyToExistingArchived) {
          const recalculatedExpiry = sql<Date>`${classesTable.archivedAt} + (${requestedArchiveDays} * interval '1 day')`;
          const changed = await tx.update(classesTable).set({
            archiveExpiresAt: recalculatedExpiry,
            archiveExpiryWarningAttemptedAt: null,
            archiveExpiryWarningSentAt: null,
          }).where(and(
            isNotNull(classesTable.archivedAt),
            isNull(classesTable.deletionScheduledFor),
            inArray(classesTable.teacherId, tx.select({ id: teachersTable.id }).from(teachersTable).where(eq(teachersTable.organisationId, orgId))),
            sql`${classesTable.archiveExpiresAt} IS DISTINCT FROM ${recalculatedExpiry}`,
          )).returning({ id: classesTable.id });
          existingArchivesUpdated = changed.length;
        }
        await tx.insert(auditLogTable).values({
          organisationId: orgId,
          teacherId: req.teacher!.id,
          action: "organisation.retention_default_updated",
          metadata: {
            scope: "school_wide_default",
            retentionDays: updated.retentionDays,
            archiveRetentionDays: updated.archiveRetentionDays,
            deletionRecoveryDays: updated.deletionRecoveryDays,
            reviewDate: updated.reviewDate,
            deletionStatus: updated.deletionStatus,
            legalHold: updated.legalHold,
            operatorVerificationReset: true,
            actorRole: "school_master",
            previousSetting: previous ? {
              archiveRetentionDays: previous.archiveRetentionDays,
              deletionRecoveryDays: previous.deletionRecoveryDays,
            } : null,
            newSetting: {
              archiveRetentionDays: updated.archiveRetentionDays,
              deletionRecoveryDays: updated.deletionRecoveryDays,
            },
            changedAt: new Date().toISOString(),
            affectedSchoolId: orgId,
            applyToExistingArchived: parsed.data.applyToExistingArchived,
            existingArchivesUpdated,
          },
          ipAddress: req.ip,
        });
        return updated;
      });
    } catch {
      res.status(503).json({ error: "Default retention policy could not be saved because its audit record could not be stored." });
      return;
    }

    res.json(serialiseRetentionPolicy(policy, "school_wide_default", "School-wide default"));
  },
);

router.get(
  "/teacher/org/retention-policies",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }
    const policies = await db
      .select()
      .from(organisationRetentionPoliciesTable)
      .where(eq(organisationRetentionPoliciesTable.organisationId, orgId))
      .orderBy(organisationRetentionPoliciesTable.dataCategory);
    res.json(policies.map((policy) => serialiseRetentionPolicy(
      policy,
      policy.dataCategory,
      retentionCategoryLabels[policy.dataCategory as keyof typeof retentionCategoryLabels] ?? policy.dataCategory,
    )));
  },
);

router.post(
  "/teacher/org/retention-policy/default/verify",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }
    try {
      const policy = await db.transaction(async (tx) => {
        await acquireRetentionPolicyMutationLock(tx, orgId);
        const [updated] = await tx.update(organisationRetentionDefaultsTable)
          .set({
            operatorVerifiedAt: new Date(),
            operatorVerifiedByTeacherId: req.teacher!.id,
            updatedAt: new Date(),
          })
          .where(eq(organisationRetentionDefaultsTable.organisationId, orgId))
          .returning();
        if (!updated) return null;
        await tx.insert(auditLogTable).values({
          organisationId: orgId,
          teacherId: req.teacher!.id,
          action: "organisation.retention_operator_verified",
          metadata: { scope: "school_wide_default", dataCategory: "school_wide_default" },
          ipAddress: req.ip,
        });
        return updated;
      });
      if (!policy) {
        res.status(404).json({ error: "Save the school-wide default retention policy before verifying it." });
        return;
      }
      res.json(serialiseRetentionPolicy(policy, "school_wide_default", "School-wide default"));
    } catch {
      res.status(503).json({ error: "Retention operator verification could not be saved because its audit record could not be stored." });
    }
  },
);

router.post(
  "/teacher/org/retention-policies/:category/verify",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    const category = String(req.params.category);
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }
    if (!RETENTION_CATEGORIES.includes(category as (typeof RETENTION_CATEGORIES)[number])) {
      res.status(400).json({ error: "Unknown retention data category" });
      return;
    }
    try {
      const policy = await db.transaction(async (tx) => {
        await acquireRetentionPolicyMutationLock(tx, orgId);
        const [updated] = await tx.update(organisationRetentionPoliciesTable)
          .set({
            operatorVerifiedAt: new Date(),
            operatorVerifiedByTeacherId: req.teacher!.id,
            updatedAt: new Date(),
          })
          .where(and(
            eq(organisationRetentionPoliciesTable.organisationId, orgId),
            eq(organisationRetentionPoliciesTable.dataCategory, category),
          ))
          .returning();
        if (!updated) return null;
        await tx.insert(auditLogTable).values({
          organisationId: orgId,
          teacherId: req.teacher!.id,
          action: "organisation.retention_operator_verified",
          metadata: { scope: "category_exception", dataCategory: category },
          ipAddress: req.ip,
        });
        return updated;
      });
      if (!policy) {
        res.status(404).json({ error: "Retention exception not found" });
        return;
      }
      res.json(serialiseRetentionPolicy(
        policy,
        category,
        retentionCategoryLabels[category as keyof typeof retentionCategoryLabels],
      ));
    } catch {
      res.status(503).json({ error: "Retention operator verification could not be saved because its audit record could not be stored." });
    }
  },
);

router.post(
  "/teacher/org/retention-policy/run",
  requireTeacher,
  requireItAdmin,
  async (_req, res): Promise<void> => {
    res.status(410).json({
      error: "Automatic retention processing is disabled. Archived records stay retained until a School Admin explicitly selects and confirms permanent deletion.",
    });
  },
);

router.delete(
  "/teacher/org/retention-policies/:category",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    const category = String(req.params.category);
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }
    if (!RETENTION_CATEGORIES.includes(category as (typeof RETENTION_CATEGORIES)[number])) {
      res.status(400).json({ error: "Unknown retention data category" });
      return;
    }

    let result;
    try {
      result = await db.transaction(async (tx) => {
        await acquireRetentionPolicyMutationLock(tx, orgId);
        const [defaultPolicy] = await tx
          .select({ id: organisationRetentionDefaultsTable.id })
          .from(organisationRetentionDefaultsTable)
          .where(eq(organisationRetentionDefaultsTable.organisationId, orgId));
        if (!defaultPolicy) return { status: "default_missing" as const };
        const [removed] = await tx
          .delete(organisationRetentionPoliciesTable)
          .where(and(
            eq(organisationRetentionPoliciesTable.organisationId, orgId),
            eq(organisationRetentionPoliciesTable.dataCategory, category),
          ))
          .returning();
        if (!removed) return { status: "not_found" as const };
        await tx.insert(auditLogTable).values({
          organisationId: orgId,
          teacherId: req.teacher!.id,
          action: "organisation.retention_policy_removed",
          metadata: { dataCategory: category, scope: "category_exception" },
          ipAddress: req.ip,
        });
        return { status: "removed" as const };
      });
    } catch {
      res.status(503).json({ error: "Retention exception could not be removed because its audit record could not be stored." });
      return;
    }
    if (result.status === "default_missing") {
      res.status(409).json({ error: "Save the school-wide default retention policy before removing a category exception." });
      return;
    }
    if (result.status === "not_found") {
      res.status(404).json({ error: "Retention exception not found" });
      return;
    }
    res.status(204).end();
  },
);

router.put(
  "/teacher/org/retention-policies/:category",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    const category = String(req.params.category);
    const parsed = UpdateRetentionPolicyBody.safeParse(req.body);
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }
    if (!RETENTION_CATEGORIES.includes(category as (typeof RETENTION_CATEGORIES)[number])) {
      res.status(400).json({ error: "Unknown retention data category" });
      return;
    }
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const values = {
      retentionDays: parsed.data.retentionDays,
      reviewDate: new Date(`${parsed.data.reviewDate}T00:00:00.000Z`),
      deletionStatus: parsed.data.deletionStatus,
      notes: parsed.data.notes || null,
      legalHold: parsed.data.legalHold ?? false,
      operatorVerifiedAt: null,
      operatorVerifiedByTeacherId: null,
      updatedByTeacherId: req.teacher!.id,
      updatedAt: new Date(),
    };
    let policy;
    try {
      policy = await db.transaction(async (tx) => {
        await acquireRetentionPolicyMutationLock(tx, orgId);
        const [defaultPolicy] = await tx
          .select({ id: organisationRetentionDefaultsTable.id })
          .from(organisationRetentionDefaultsTable)
          .where(eq(organisationRetentionDefaultsTable.organisationId, orgId));
        if (!defaultPolicy) return null;
        const [existing] = await tx
          .select({ id: organisationRetentionPoliciesTable.id })
          .from(organisationRetentionPoliciesTable)
          .where(and(
            eq(organisationRetentionPoliciesTable.organisationId, orgId),
            eq(organisationRetentionPoliciesTable.dataCategory, category),
          ));
        const [updated] = existing
          ? await tx.update(organisationRetentionPoliciesTable)
            .set(values)
            .where(eq(organisationRetentionPoliciesTable.id, existing.id))
            .returning()
          : await tx.insert(organisationRetentionPoliciesTable)
            .values({ organisationId: orgId, dataCategory: category, ...values })
            .returning();
        await tx.insert(auditLogTable).values({
          organisationId: orgId,
          teacherId: req.teacher!.id,
          action: "organisation.retention_policy_updated",
          metadata: {
            dataCategory: category,
            retentionDays: updated.retentionDays,
            reviewDate: updated.reviewDate,
            deletionStatus: updated.deletionStatus,
            legalHold: updated.legalHold,
            operatorVerificationReset: true,
          },
          ipAddress: req.ip,
        });
        return updated;
      });
    } catch {
      res.status(503).json({ error: "Retention policy could not be saved because its audit record could not be stored." });
      return;
    }
    if (!policy) {
      res.status(409).json({ error: "Save the school-wide default retention policy before adding a category exception." });
      return;
    }
    res.json(serialiseRetentionPolicy(
      policy,
      category,
      retentionCategoryLabels[category as keyof typeof retentionCategoryLabels],
    ));
  },
);

router.get(
  "/teacher/org/research-governance",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }
    const [org] = await db
      .select({
        researchProcessingBlocked: organisationsTable.researchProcessingBlocked,
        researchGovernanceReference: organisationsTable.researchGovernanceReference,
        researchGovernanceReviewDate: organisationsTable.researchGovernanceReviewDate,
      })
      .from(organisationsTable)
      .where(eq(organisationsTable.id, orgId));
    if (!org) {
      res.status(404).json({ error: "Organisation not found" });
      return;
    }
    res.json({
      ...org,
      status: org.researchProcessingBlocked ? "blocked" : "configured",
      requirements: [
        "Approved research protocol and ethics approval",
        "Parent/carer consent and student assent process",
        "Pseudonymisation and research access procedure",
        "Withdrawal and anonymised publication procedure",
      ],
    });
  },
);

// ── IT Admin — Invite Code ─────────────────────────────────────────────────────

router.get(
  "/teacher/org/invite-code",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }
    const [org] = await db
      .select({ teacherInviteCode: organisationsTable.teacherInviteCode })
      .from(organisationsTable)
      .where(eq(organisationsTable.id, orgId));
    if (!org) {
      res.status(404).json({ error: "Organisation not found" });
      return;
    }
    res.json({ inviteCode: org.teacherInviteCode });
  },
);

router.post(
  "/teacher/org/invite-code/rotate",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }
    const { randomBytes } = await import("crypto");
    const newCode = randomBytes(4).toString("hex").toUpperCase();
    const [org] = await db
      .update(organisationsTable)
      .set({ teacherInviteCode: newCode })
      .where(eq(organisationsTable.id, orgId))
      .returning({ teacherInviteCode: organisationsTable.teacherInviteCode });
    if (!org) {
      res.status(404).json({ error: "Organisation not found" });
      return;
    }
    await logAudit({
      organisationId: orgId,
      teacherId: req.teacher!.id,
      action: "org.invite_code_rotated",
      ipAddress: req.ip,
    });
    res.json({ inviteCode: org.teacherInviteCode });
  },
);

// ── IT Admin — Allowed Email Domains ──────────────────────────────────────────

router.get(
  "/teacher/org/email-domains",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }
    const [org] = await db
      .select({ allowedEmailDomains: organisationsTable.allowedEmailDomains })
      .from(organisationsTable)
      .where(eq(organisationsTable.id, orgId));
    if (!org) {
      res.status(404).json({ error: "Organisation not found" });
      return;
    }
    res.json({ allowedEmailDomains: org.allowedEmailDomains ?? [] });
  },
);

const UpdateEmailDomainsBody = z.object({
  allowedEmailDomains: z.array(
    z.string().regex(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, "Enter a valid domain (e.g. school.edu.au)")
  ),
});

router.put(
  "/teacher/org/email-domains",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }
    const parsed = UpdateEmailDomainsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid domains" });
      return;
    }
    const domains = parsed.data.allowedEmailDomains.map((d) => d.toLowerCase().replace(/^@/, ""));
    const [org] = await db
      .update(organisationsTable)
      .set({ allowedEmailDomains: domains.length > 0 ? domains : null })
      .where(eq(organisationsTable.id, orgId))
      .returning({ allowedEmailDomains: organisationsTable.allowedEmailDomains });
    if (!org) {
      res.status(404).json({ error: "Organisation not found" });
      return;
    }
    await logAudit({
      organisationId: orgId,
      teacherId: req.teacher!.id,
      action: "org.email_domains_updated",
      metadata: { domains },
      ipAddress: req.ip,
    });
    res.json({ allowedEmailDomains: org.allowedEmailDomains ?? [] });
  },
);

// ── Remove (block) student from class ─────────────────────────────────────────

router.delete(
  "/teacher/class/:classId/student/:sessionId",
  requireTeacher,
  async (req, res): Promise<void> => {
    const classId = Number(req.params.classId);
    const sessionId = Number(req.params.sessionId);

    const [cls] = await db
      .select({ teacherId: classesTable.teacherId })
      .from(classesTable)
      .where(and(eq(classesTable.id, classId), eq(classesTable.teacherId, req.teacher!.id)));

    if (!cls) {
      res.status(404).json({ error: "Class not found or access denied" });
      return;
    }

    const [updated] = await db
      .update(studentSessionsTable)
      .set({ isBlocked: true, sessionNonce: randomUUID() })
      .where(and(eq(studentSessionsTable.id, sessionId), eq(studentSessionsTable.classId, classId)))
      .returning({ id: studentSessionsTable.id, studentName: studentSessionsTable.studentName });

    if (!updated) {
      res.status(404).json({ error: "Student not found" });
      return;
    }

    await logAudit({
      organisationId: req.teacher!.organisationId,
      teacherId: req.teacher!.id,
      action: "student.removed",
      metadata: { classId, sessionId, studentName: updated.studentName },
      ipAddress: req.ip,
    });

    res.json({ ok: true });
  },
);

// ── TOTP setup / enable / disable ─────────────────────────────────────────────

router.get("/teacher/totp/setup", requireTeacher, async (_req, res): Promise<void> => {
  res.status(410).json({ error: "Authenticator setup is required during sign-in. Sign out and use a recovery code if you need to replace a device." });
});

const TotpEnableBody = z.object({ code: z.string().min(6).max(8) });

router.post("/teacher/totp/enable", requireTeacher, async (_req, res): Promise<void> => {
  res.status(410).json({ error: "Authenticator setup is required during sign-in." });
});

const TotpDisableBody = z.object({ code: z.string().min(6).max(8) });

router.post("/teacher/totp/disable", requireTeacher, async (_req, res): Promise<void> => {
  res.status(400).json({ error: "Authenticator protection is required for every teacher account and cannot be disabled." });
});

// ── Audit log (IT admin only) ─────────────────────────────────────────────────

router.get(
  "/teacher/audit-log/report",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation" });
      return;
    }

    const parsed = auditReportQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid report filters" });
      return;
    }

    let where;
    try {
      where = getAuditReportWhere(orgId, parsed.data);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid report dates" });
      return;
    }

    const [items, countRows, actionRows] = await Promise.all([
      db
        .select({
          id: auditLogTable.id,
          action: auditLogTable.action,
          archiveAccessMetadata: archiveAccessAuditMetadataProjection(),
          ipAddress: auditLogTable.ipAddress,
          createdAt: auditLogTable.createdAt,
          teacherName: teachersTable.name,
          teacherEmail: teachersTable.email,
        })
        .from(auditLogTable)
        .leftJoin(teachersTable, eq(auditLogTable.teacherId, teachersTable.id))
        .where(where)
        .orderBy(desc(auditLogTable.createdAt))
        .limit(SCHOOL_AUDIT_REPORT_LIMIT),
      db
        .select({ matchingCount: sql<number>`count(*)` })
        .from(auditLogTable)
        .where(where),
      db
        .select({ action: auditLogTable.action })
        .from(auditLogTable)
        .where(and(
          eq(auditLogTable.organisationId, orgId),
          ne(auditLogTable.action, SCHOOL_AUDIT_REPORT_EXPORTED),
        ))
        .groupBy(auditLogTable.action)
        .orderBy(asc(auditLogTable.action)),
    ]);

    const matchingCount = Number(countRows[0]?.matchingCount ?? 0);
    res.json({
      items: items.map(({ archiveAccessMetadata, ...item }) => ({
        ...item,
        archiveAccess: serialiseArchiveAccessAuditMetadata(item.action, archiveAccessMetadata),
      })),
      matchingCount,
      truncated: matchingCount > items.length,
      limit: SCHOOL_AUDIT_REPORT_LIMIT,
      actions: actionRows.map((row) => row.action),
    });
  },
);

router.get(
  "/teacher/audit-log/report/export",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation" });
      return;
    }

    const parsed = auditReportQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid report filters" });
      return;
    }

    let where;
    try {
      where = getAuditReportWhere(orgId, parsed.data);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid report dates" });
      return;
    }

    const entries = await db
      .select({
        action: auditLogTable.action,
        archiveAccessMetadata: archiveAccessAuditMetadataProjection(),
        ipAddress: auditLogTable.ipAddress,
        createdAt: auditLogTable.createdAt,
        teacherName: teachersTable.name,
        teacherEmail: teachersTable.email,
      })
      .from(auditLogTable)
      .leftJoin(teachersTable, eq(auditLogTable.teacherId, teachersTable.id))
      .where(where)
      .orderBy(desc(auditLogTable.createdAt))
      .limit(SCHOOL_AUDIT_REPORT_LIMIT);

    await logAudit({
      organisationId: orgId,
      teacherId: req.teacher!.id,
      action: SCHOOL_AUDIT_REPORT_EXPORTED,
      metadata: {
        from: parsed.data.from ?? null,
        to: parsed.data.to ?? null,
        action: parsed.data.action ?? null,
        teacherId: parsed.data.teacherId ?? null,
        exportedEventCount: entries.length,
      },
      ipAddress: req.ip,
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="school-security-audit-report.csv"');
    res.setHeader("Cache-Control", "no-store");
    res.send(buildAuditReportCsv(entries.map(({ archiveAccessMetadata, ...entry }) => ({
      ...entry,
      archiveAccess: serialiseArchiveAccessAuditMetadata(entry.action, archiveAccessMetadata),
    }))));
  },
);

router.get(
  "/teacher/audit-log",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation" });
      return;
    }

    const entries = await db
      .select({
        id: auditLogTable.id,
        action: auditLogTable.action,
        metadata: auditLogTable.metadata,
        ipAddress: auditLogTable.ipAddress,
        createdAt: auditLogTable.createdAt,
        teacherName: teachersTable.name,
        teacherEmail: teachersTable.email,
      })
      .from(auditLogTable)
      .leftJoin(teachersTable, eq(auditLogTable.teacherId, teachersTable.id))
      .where(eq(auditLogTable.organisationId, orgId))
      .orderBy(desc(auditLogTable.createdAt))
      .limit(200);

    res.json(entries);
  },
);

router.get(
  "/teacher/org/compliance-evidence",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }

    const [orgRows, defaultPolicies, policies, approvalEvents, teacherCount, classCount] = await Promise.all([
      db
        .select({
          id: organisationsTable.id,
          name: organisationsTable.name,
          aiProvider: organisationsTable.aiProvider,
          aiDataProcessingAcknowledged: organisationsTable.aiDataProcessingAcknowledged,
          aiDataProcessingAcknowledgedAt: organisationsTable.aiDataProcessingAcknowledgedAt,
          dataProcessingApproverRecorded: sql<boolean>`${organisationsTable.aiDataProcessingAcknowledgedByTeacherId} IS NOT NULL`,
          aiDataProcessingPolicyVersion: organisationsTable.aiDataProcessingPolicyVersion,
          aiDataProcessingEvidenceReference: organisationsTable.aiDataProcessingEvidenceReference,
          aiDataProcessingRegion: organisationsTable.aiDataProcessingRegion,
          aiDataRetentionNoTrainingConfirmed: organisationsTable.aiDataRetentionNoTrainingConfirmed,
          aiSchoolPoliciesConfirmed: organisationsTable.aiSchoolPoliciesConfirmed,
          aiDataProcessingReviewDate: organisationsTable.aiDataProcessingReviewDate,
          azureEndpointConfigured: sql<boolean>`${organisationsTable.azureEndpoint} IS NOT NULL`,
          researchProcessingBlocked: organisationsTable.researchProcessingBlocked,
          researchGovernanceReference: organisationsTable.researchGovernanceReference,
          researchGovernanceReviewDate: organisationsTable.researchGovernanceReviewDate,
        })
        .from(organisationsTable)
        .where(eq(organisationsTable.id, orgId)),
      db
        .select()
        .from(organisationRetentionDefaultsTable)
        .where(eq(organisationRetentionDefaultsTable.organisationId, orgId)),
      db
        .select()
        .from(organisationRetentionPoliciesTable)
        .where(eq(organisationRetentionPoliciesTable.organisationId, orgId))
        .orderBy(organisationRetentionPoliciesTable.dataCategory),
      db
        .select({
          action: auditLogTable.action,
          metadata: auditLogTable.metadata,
          createdAt: auditLogTable.createdAt,
        })
        .from(auditLogTable)
        .where(and(
          eq(auditLogTable.organisationId, orgId),
          sql`(${auditLogTable.action} LIKE 'organisation.ai_%' OR ${auditLogTable.action} IN (
            'organisation.retention_default_updated',
            'organisation.retention_policy_updated',
            'organisation.retention_policy_removed',
            'organisation.retention_operator_verified',
            'organisation.retention_records_processed',
            'organisation.retention_enforcement_blocked'
          ))`,
        ))
        .orderBy(desc(auditLogTable.createdAt))
        .limit(200),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(teachersTable)
        .where(eq(teachersTable.organisationId, orgId)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(classesTable)
        .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
        .where(eq(teachersTable.organisationId, orgId)),
    ]);

    const [org] = orgRows;
    const [defaultPolicy] = defaultPolicies;
    if (!org) {
      res.status(404).json({ error: "Organisation not found" });
      return;
    }

    const format = req.query.format === "html" ? "html" : "json";

    try {
      await db.insert(auditLogTable).values({
        organisationId: orgId,
        teacherId: req.teacher!.id,
        action: "organisation.compliance_evidence_exported",
        metadata: { format },
        ipAddress: req.ip,
      });
    } catch {
      res.status(503).json({ error: "Evidence export is temporarily unavailable because its audit record could not be stored." });
      return;
    }

    const report = {
      reportVersion: "1.0",
      generatedAt: new Date().toISOString(),
      scope: "Organisation-level security and compliance evidence. This report intentionally excludes API keys, credentials, reset tokens, student names, student work, chat content, and IP addresses.",
      organisation: { id: org.id, name: org.name, teacherCount: teacherCount[0]?.count ?? 0, classCount: classCount[0]?.count ?? 0 },
      aiProcessing: {
        provider: org.aiProvider,
        endpointConfigured: org.azureEndpointConfigured,
        acknowledged: org.aiDataProcessingAcknowledged,
        acknowledgedAt: org.aiDataProcessingAcknowledgedAt,
        approverRecorded: org.dataProcessingApproverRecorded,
        policyVersionRecorded: Boolean(org.aiDataProcessingPolicyVersion),
        evidenceReferenceRecorded: Boolean(org.aiDataProcessingEvidenceReference),
        processingRegionRecorded: Boolean(org.aiDataProcessingRegion),
        retentionAndNoTrainingConfirmed: org.aiDataRetentionNoTrainingConfirmed,
        schoolPoliciesConfirmed: org.aiSchoolPoliciesConfirmed,
        reviewDate: org.aiDataProcessingReviewDate,
      },
      researchProcessing: {
        status: org.researchProcessingBlocked ? "blocked_pending_governance" : "configured",
        governanceReferenceRecorded: Boolean(org.researchGovernanceReference),
        reviewDate: org.researchGovernanceReviewDate,
        requirements: [
          "Approved research protocol and ethics approval",
          "Parent/carer consent and student assent process",
          "Pseudonymisation and research access procedure",
          "Withdrawal and anonymised publication procedure",
        ],
      },
      retentionPolicies: [
        ...(defaultPolicy ? [{
          scope: "school_wide_default",
          dataCategory: "school_wide_default",
          label: "School-wide default",
          retentionDays: defaultPolicy.retentionDays,
          reviewDate: defaultPolicy.reviewDate,
          deletionStatus: defaultPolicy.deletionStatus,
          legalHold: defaultPolicy.legalHold,
          operatorVerified: Boolean(defaultPolicy.operatorVerifiedAt),
          executionStatus: getRetentionBlockReason(defaultPolicy) ? "blocked" : "ready",
          blockReason: getRetentionBlockReason(defaultPolicy),
          notesRecorded: Boolean(defaultPolicy.notes),
          updatedAt: defaultPolicy.updatedAt,
        }] : []),
        ...policies.map((policy) => ({
          scope: "category_exception",
          dataCategory: policy.dataCategory,
          label: retentionCategoryLabels[policy.dataCategory as keyof typeof retentionCategoryLabels] ?? policy.dataCategory,
          retentionDays: policy.retentionDays,
          reviewDate: policy.reviewDate,
          deletionStatus: policy.deletionStatus,
          legalHold: policy.legalHold,
          operatorVerified: Boolean(policy.operatorVerifiedAt),
          executionStatus: getRetentionBlockReason(policy) ? "blocked" : "ready",
          blockReason: getRetentionBlockReason(policy),
          notesRecorded: Boolean(policy.notes),
          updatedAt: policy.updatedAt,
        })),
      ],
      dataInventory: [
        { category: "Teacher account records", purpose: "School administration, authentication, permissions, and audit", access: "Authorised teachers and school IT administrators" },
        { category: "Student learning records", purpose: "Class participation, assessment, and completed climb records", access: "Student, class teacher, and authorised school staff" },
        { category: "AI conversations", purpose: "School learning support where school AI approval is active", access: "Student and authorised class/school staff" },
        { category: "Security audit events", purpose: "Security monitoring, investigation, and compliance evidence", access: "School IT administrators" },
      ],
      securityControls: [
        { control: "Teacher multi-factor authentication", status: "implemented" },
        { control: "Origin protection for state-changing requests", status: "implemented" },
        { control: "Rate limiting for high-risk authentication routes", status: "implemented" },
        { control: "School-managed AI approval gate", status: "implemented" },
        { control: "AI prompt minimisation and identifier redaction", status: "implemented" },
      ],
      approvalAndRetentionHistory: approvalEvents.map(safeComplianceAuditEvent),
      externalVerificationRequired: [
        "AWS hosting, firewall, backup, monitoring, TLS, and recovery evidence",
        "School/provider data-processing agreement, retention/no-training, and processing location evidence",
        "School DPIA, privacy notices, safeguarding, and research governance sign-off",
      ],
    };

    res.setHeader("Cache-Control", "no-store");
    if (format === "html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=assisted-climb-compliance-evidence.html");
      res.send(renderComplianceEvidenceHtml(report));
      return;
    }

    res.setHeader("Content-Disposition", "attachment; filename=assisted-climb-compliance-evidence.json");
    res.json(report);
  },
);

type ComplianceEvidenceHtmlData = {
  reportVersion: string;
  generatedAt: string;
  organisation: { name: string; teacherCount: number; classCount: number };
  aiProcessing: {
    provider: string | null;
    acknowledged: boolean;
    acknowledgedAt: Date | null;
    approverRecorded: boolean;
    policyVersionRecorded: boolean;
    evidenceReferenceRecorded: boolean;
    processingRegionRecorded: boolean;
    retentionAndNoTrainingConfirmed: boolean;
    schoolPoliciesConfirmed: boolean;
    reviewDate: Date | null;
  };
  researchProcessing: { status: string; requirements: string[] };
  retentionPolicies: Array<{ scope: string; label: string; retentionDays: number; reviewDate: Date; deletionStatus: string }>;
  dataInventory: Array<{ category: string; purpose: string; access: string }>;
  securityControls: Array<{ control: string; status: string }>;
  approvalAndRetentionHistory: Array<Record<string, unknown>>;
  externalVerificationRequired: string[];
};

function escapeEvidenceHtml(value: unknown): string {
  return String(value ?? "Not recorded").replace(/[&<>"']/g, (character) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!
  ));
}

function formatEvidenceDate(value: Date | string | null): string {
  if (!value) return "Not recorded";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "Not recorded" : date.toISOString().slice(0, 10);
}

function evidenceStatus(value: boolean): string {
  return value
    ? `<span class="status ok">Recorded</span>`
    : `<span class="status missing">Not recorded</span>`;
}

function renderComplianceEvidenceHtml(report: ComplianceEvidenceHtmlData): string {
  const provider = report.aiProcessing.provider === "gemini"
    ? "Google Gemini"
    : report.aiProcessing.provider === "azure"
      ? "Microsoft Azure OpenAI"
      : "No provider selected";
  const missingEvidence = [
    !report.aiProcessing.schoolPoliciesConfirmed && "School policy and procedure confirmation",
    !report.aiProcessing.processingRegionRecorded && "Processing location",
    !report.aiProcessing.retentionAndNoTrainingConfirmed && "Retention and no-training confirmation",
    report.retentionPolicies.length === 0 && "School retention schedule",
  ].filter(Boolean) as string[];
  const retentionSection = report.retentionPolicies.length
    ? `<table><thead><tr><th>Scope</th><th>Data category</th><th>Retention</th><th>Review date</th><th>Status</th></tr></thead><tbody>${report.retentionPolicies.map((policy) => `<tr><td>${policy.scope === "school_wide_default" ? "School-wide default" : "Category exception"}</td><td>${escapeEvidenceHtml(policy.label)}</td><td>${policy.retentionDays} days</td><td>${formatEvidenceDate(policy.reviewDate)}</td><td>${escapeEvidenceHtml(policy.deletionStatus)}</td></tr>`).join("")}</tbody></table>`
    : `<p class="notice">No retention rules have been recorded in The Assisted Climb. This does not prove the school has no retention policy; it means the policy is not yet recorded here.</p>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Compliance evidence report — ${escapeEvidenceHtml(report.organisation.name)}</title>
<style>
body{margin:0;background:#f6f6f2;color:#242424;font-family:Arial,Helvetica,sans-serif;line-height:1.5}main{max-width:900px;margin:0 auto;padding:32px 18px}header,section{background:#fff;border:1px solid #deded8;border-radius:18px;padding:24px;margin-bottom:16px}h1{margin:4px 0 8px;font-size:28px}h2{margin:0 0 8px;font-size:19px}.eyebrow,.muted{color:#686862;font-size:12px}.eyebrow{text-transform:uppercase;letter-spacing:.16em}.banner,.notice{border-radius:12px;padding:14px 16px;background:#fff5d6;border:1px solid #ead685}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:16px}.metric{border:1px solid #e4e4de;border-radius:12px;padding:12px}.metric strong{display:block;font-size:20px;margin-top:4px}table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #ecece7;vertical-align:top}th{font-size:11px;color:#686862;text-transform:uppercase;letter-spacing:.05em}.status{display:inline-block;border-radius:99px;padding:3px 9px;font-size:11px;font-weight:bold}.ok{color:#176b2d;background:#e7f6ea}.missing{color:#865700;background:#fff1c5}.toolbar{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}.toolbar button{border:1px solid #c9c9c2;border-radius:10px;background:#fff;color:#242424;padding:10px 14px;font-weight:700;cursor:pointer}.toolbar button.primary{border-color:#242424;background:#242424;color:#fff}li{margin:7px 0}footer{color:#686862;font-size:12px;padding:4px 6px 20px}@media print{body{background:#fff}main{padding:0}.toolbar{display:none}header,section{break-inside:avoid}}
</style></head><body><main>
<header><div class="eyebrow">The Assisted Climb · Compliance evidence</div><h1>School security and privacy evidence report</h1><p><strong>${escapeEvidenceHtml(report.organisation.name)}</strong></p><p class="muted">Generated ${formatEvidenceDate(report.generatedAt)} · Report version ${escapeEvidenceHtml(report.reportVersion)}</p><div class="banner"><strong>${missingEvidence.length ? "Action or evidence is still required" : "Recorded evidence is up to date"}</strong><br>${missingEvidence.length ? "Use the evidence-to-complete list below before relying on this report for a formal review." : "The application has recorded the controls and governance information shown below."}</div><div class="toolbar" id="report-actions"><button class="primary" id="download-report" type="button">Download this report</button><button id="print-report" type="button">Print report</button></div></header>
<section><h2>What this report is</h2><p>This is a plain-English summary of the security and privacy information recorded in The Assisted Climb for this school. It can support a school, DPO, local authority, or auditor review.</p><p class="muted">It is not a GDPR certificate, legal advice, a data-processing agreement, or independent proof of AWS or provider controls.</p><div class="grid"><div class="metric"><span class="muted">Teachers</span><strong>${report.organisation.teacherCount}</strong></div><div class="metric"><span class="muted">Classes</span><strong>${report.organisation.classCount}</strong></div><div class="metric"><span class="muted">AI provider</span><strong>${escapeEvidenceHtml(provider)}</strong></div><div class="metric"><span class="muted">Recorded history</span><strong>${report.approvalAndRetentionHistory.length}</strong></div></div></section>
<section><h2>AI provider approval</h2><table><tbody><tr><th>Provider</th><td>${escapeEvidenceHtml(provider)}</td></tr><tr><th>School authorisation</th><td>${evidenceStatus(report.aiProcessing.approverRecorded)}</td></tr><tr><th>Processing approval</th><td>${evidenceStatus(report.aiProcessing.acknowledged)}</td></tr><tr><th>Approval date</th><td>${formatEvidenceDate(report.aiProcessing.acknowledgedAt)}</td></tr><tr><th>School confirms its policies are in place</th><td>${evidenceStatus(report.aiProcessing.schoolPoliciesConfirmed)}</td></tr><tr><th>Provider terms and no-training confirmation</th><td>${evidenceStatus(report.aiProcessing.retentionAndNoTrainingConfirmed)}</td></tr><tr><th>Processing location</th><td>${evidenceStatus(report.aiProcessing.processingRegionRecorded)}</td></tr><tr><th>School record reference (optional)</th><td>${report.aiProcessing.evidenceReferenceRecorded ? "Provided" : "Not provided"}</td></tr><tr><th>Next review date</th><td>${formatEvidenceDate(report.aiProcessing.reviewDate)}</td></tr></tbody></table><p class="muted">A school record reference is simply the school’s own pointer to this approval, such as a DPIA or DPA number. The platform does not check it.</p>${missingEvidence.length ? `<div class="notice"><strong>Evidence to complete:</strong><ul>${missingEvidence.map((item) => `<li>${escapeEvidenceHtml(item)}</li>`).join("")}</ul></div>` : ""}</section>
<section><h2>Retention schedule</h2><p>These are the retention rules recorded in the application.</p>${retentionSection}</section>
<section><h2>Information covered</h2><table><thead><tr><th>Category</th><th>Purpose</th><th>Access</th></tr></thead><tbody>${report.dataInventory.map((item) => `<tr><td>${escapeEvidenceHtml(item.category)}</td><td>${escapeEvidenceHtml(item.purpose)}</td><td>${escapeEvidenceHtml(item.access)}</td></tr>`).join("")}</tbody></table></section>
<section><h2>Application security controls</h2><p>These are controls provided by the application itself.</p><ul>${report.securityControls.map((item) => `<li><strong>${escapeEvidenceHtml(item.control)}</strong> — ${escapeEvidenceHtml(item.status)}</li>`).join("")}</ul></section>
<section><h2>Research processing</h2><p><strong>${report.researchProcessing.status === "blocked_pending_governance" ? "Research processing is blocked pending separate governance approval." : "Research processing is configured."}</strong></p><p class="muted">Normal school use is separate from research use.</p><ul>${report.researchProcessing.requirements.map((item) => `<li>${escapeEvidenceHtml(item)}</li>`).join("")}</ul></section>
<section><h2>Evidence to verify outside the application</h2><p>These items require evidence from the school, AWS operator, provider, DPO, local authority, or legal adviser:</p><ol>${report.externalVerificationRequired.map((item) => `<li>${escapeEvidenceHtml(item)}</li>`).join("")}</ol></section>
<footer>This report intentionally excludes API keys, credentials, reset tokens, student names, student work, chat content, and IP addresses. It is an evidence summary for review, not a statement of legal compliance.</footer>
<script>
document.getElementById("download-report").addEventListener("click", function () {
  const file = new Blob(["<!doctype html>\\n", document.documentElement.outerHTML], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = "assisted-climb-compliance-evidence.html";
  link.click();
  URL.revokeObjectURL(url);
});
document.getElementById("print-report").addEventListener("click", function () { window.print(); });
</script>
</main></body></html>`;
}

// ── List teachers in org (IT admin only) ──────────────────────────────────────

router.get(
  "/teacher/org/teachers",
  requireTeacher,
  requireSchoolAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation" });
      return;
    }

    const parsed = teacherDirectoryQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Use valid teacher search, status, date, sorting, and pagination filters." });
      return;
    }

    const { q, status, approvalStatus, from, to, sort, direction, page, pageSize } = parsed.data;
    let fromDate: Date | undefined;
    let toExclusive: Date | undefined;
    try {
      ({ from: fromDate, toExclusive } = getTeacherDirectoryDateRange(parsed.data));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid teacher directory dates" });
      return;
    }

    const conditions = [
      eq(teachersTable.organisationId, orgId),
      q ? sql`(${teachersTable.name} ILIKE ${`%${q}%`} OR ${teachersTable.email} ILIKE ${`%${q}%`})` : undefined,
      status !== "all" ? eq(teachersTable.accountStatus, status) : undefined,
      approvalStatus !== "all" ? eq(teachersTable.approvalStatus, approvalStatus) : undefined,
      fromDate ? gte(teachersTable.createdAt, fromDate) : undefined,
      toExclusive ? lt(teachersTable.createdAt, toExclusive) : undefined,
    ].filter(Boolean);
    const where = and(...conditions);
    const sortColumn = sort === "createdAt"
      ? teachersTable.createdAt
      : sort === "status"
        ? teachersTable.accountStatus
        : teachersTable.name;
    const sortOrder = direction === "desc" ? desc(sortColumn) : asc(sortColumn);

    const [teachers, countRows] = await Promise.all([
      db
        .select({
          id: teachersTable.id,
          name: teachersTable.name,
          email: teachersTable.email,
          isItAdmin: teachersTable.isItAdmin,
          schoolAdminRole: teachersTable.schoolAdminRole,
          accountStatus: teachersTable.accountStatus,
          accountStatusChangedAt: teachersTable.accountStatusChangedAt,
          approvalStatus: teachersTable.approvalStatus,
          approvalReviewedAt: teachersTable.approvalReviewedAt,
          approvalReviewedBy: teachersTable.approvalReviewedBy,
          approvalReason: teachersTable.approvalReason,
          totpEnabled: teachersTable.totpEnabled,
          mustChangePassword: teachersTable.mustChangePassword,
          failedLoginAttempts: teachersTable.failedLoginAttempts,
          lockedUntil: teachersTable.lockedUntil,
          createdAt: teachersTable.createdAt,
        })
        .from(teachersTable)
        .where(where)
        .orderBy(sortOrder, asc(teachersTable.name), asc(teachersTable.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(teachersTable)
        .where(where),
    ]);

    const total = Number(countRows[0]?.total ?? 0);
    res.json(ListOrganisationTeachersResponse.parse({
      items: teachers,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    }));
  },
);

router.post(
  "/teacher/org/teacher/:id/approve",
  requireTeacher,
  requireSchoolAdmin,
  async (req, res): Promise<void> => {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0 || targetId === req.teacher!.id) {
      res.status(400).json({ error: "Invalid teacher approval request" });
      return;
    }
    const result = await db.transaction(async (tx) => {
      const [actor] = await tx.select().from(teachersTable).where(eq(teachersTable.id, req.teacher!.id)).for("update");
      if (!actor?.organisationId || actor.accountStatus !== "active" || actor.approvalStatus !== "approved" || !actor.isItAdmin || !["master", "subadmin"].includes(actor.schoolAdminRole ?? "")) {
        return { ok: false as const, status: 403, error: "School administrator access required" };
      }
      const [target] = await tx.select({ schoolAdminRole: teachersTable.schoolAdminRole }).from(teachersTable)
        .where(and(eq(teachersTable.id, targetId), eq(teachersTable.organisationId, actor.organisationId))).for("update");
      if (!target) return { ok: false as const, status: 404, error: "Teacher not found in your organisation" };
      if (target.schoolAdminRole && actor.schoolAdminRole !== "master") return { ok: false as const, status: 403, error: "Only the School Admin can review a school administrator account." };
      const [approved] = await tx.update(teachersTable).set({
        approvalStatus: "approved", approvalReviewedAt: new Date(), approvalReviewedBy: actor.id, approvalReason: null,
      }).where(and(eq(teachersTable.id, targetId), eq(teachersTable.organisationId, actor.organisationId), eq(teachersTable.approvalStatus, "pending"), eq(teachersTable.accountStatus, "active"))).returning({ id: teachersTable.id });
      if (!approved) return { ok: false as const, status: 409, error: "This teacher is no longer awaiting approval." };
      await tx.insert(auditLogTable).values({ organisationId: actor.organisationId, teacherId: actor.id, action: "teacher.approved", metadata: { targetTeacherId: targetId }, ipAddress: req.ip });
      return { ok: true as const };
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ ok: true, approvalStatus: "approved" });
  },
);

router.post(
  "/teacher/org/teacher/:id/reject",
  requireTeacher,
  requireSchoolAdmin,
  async (req, res): Promise<void> => {
    const targetId = Number(req.params.id);
    const parsed = RejectTeacherApprovalBody.safeParse(req.body);
    if (!Number.isInteger(targetId) || targetId <= 0 || targetId === req.teacher!.id || !parsed.success) {
      res.status(400).json({ error: "Provide a reason when rejecting a teacher registration." });
      return;
    }
    const result = await db.transaction(async (tx) => {
      const [actor] = await tx.select().from(teachersTable).where(eq(teachersTable.id, req.teacher!.id)).for("update");
      if (!actor?.organisationId || actor.accountStatus !== "active" || actor.approvalStatus !== "approved" || !actor.isItAdmin || !["master", "subadmin"].includes(actor.schoolAdminRole ?? "")) return { ok: false as const, status: 403, error: "School administrator access required" };
      const [target] = await tx.select({ schoolAdminRole: teachersTable.schoolAdminRole }).from(teachersTable).where(and(eq(teachersTable.id, targetId), eq(teachersTable.organisationId, actor.organisationId))).for("update");
      if (!target) return { ok: false as const, status: 404, error: "Teacher not found in your organisation" };
      if (target.schoolAdminRole && actor.schoolAdminRole !== "master") return { ok: false as const, status: 403, error: "Only the School Admin can review a school administrator account." };
      const [rejected] = await tx.update(teachersTable).set({
        approvalStatus: "rejected", approvalReviewedAt: new Date(), approvalReviewedBy: actor.id, approvalReason: parsed.data.reason,
      }).where(and(eq(teachersTable.id, targetId), eq(teachersTable.organisationId, actor.organisationId), eq(teachersTable.approvalStatus, "pending"), eq(teachersTable.accountStatus, "active"))).returning({ id: teachersTable.id });
      if (!rejected) return { ok: false as const, status: 409, error: "This teacher is no longer awaiting approval." };
      await tx.insert(auditLogTable).values({ organisationId: actor.organisationId, teacherId: actor.id, action: "teacher.rejected", metadata: { targetTeacherId: targetId, reason: parsed.data.reason }, ipAddress: req.ip });
      return { ok: true as const };
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ ok: true, approvalStatus: "rejected" });
  },
);

router.get(
  "/teacher/org/teacher/:id/departure-summary",
  requireTeacher,
  requireSchoolMaster,
  async (req, res): Promise<void> => {
    const targetId = Number(req.params.id);
    const orgId = req.teacher!.organisationId;
    if (!Number.isInteger(targetId) || targetId <= 0 || !orgId) {
      res.status(400).json({ error: "Invalid teacher account" });
      return;
    }

    const [target] = await db
      .select({
        id: teachersTable.id,
        name: teachersTable.name,
        email: teachersTable.email,
        schoolAdminRole: teachersTable.schoolAdminRole,
        accountStatus: teachersTable.accountStatus,
      })
      .from(teachersTable)
      .where(and(eq(teachersTable.id, targetId), eq(teachersTable.organisationId, orgId)));
    if (!target) {
      res.status(404).json({ error: "Teacher not found in your organisation" });
      return;
    }
    const denied = canManageDeparture(req.teacher!, target);
    if (denied) {
      res.status(403).json({ error: denied });
      return;
    }
    if (target.accountStatus === "deleted") {
      res.status(409).json({ error: "This teacher already has access removed. Review any existing archive instead." });
      return;
    }

    const classes = await db
      .select({
        id: classesTable.id,
        name: classesTable.name,
        subject: classesTable.subject,
        archivedAt: classesTable.archivedAt,
      })
      .from(classesTable)
      .where(eq(classesTable.teacherId, target.id))
      .orderBy(classesTable.createdAt);
    const classIds = classes.map((entry) => entry.id);
    const [studentCount] = classIds.length
      ? await db.select({ count: sql<number>`count(*)::int` }).from(studentSessionsTable)
        .where(inArray(studentSessionsTable.classId, classIds))
      : [{ count: 0 }];

    res.json({
      teacher: target,
      classes,
      studentCount: studentCount?.count ?? 0,
    });
  },
);

router.post(
  "/teacher/org/teacher/:id/departure",
  requireTeacher,
  requireSchoolMaster,
  async (req, res): Promise<void> => {
    const targetId = Number(req.params.id);
    const orgId = req.teacher!.organisationId;
    const parsed = TeacherDepartureBody.safeParse(req.body);
    if (!Number.isInteger(targetId) || targetId <= 0 || !orgId || !parsed.success) {
      res.status(400).json({ error: "Choose a valid transfer or archive outcome and confirm access removal." });
      return;
    }
    const archiveRequested = parsed.data.legacyArchiveAll
      || parsed.data.actions.some((action) => action.action === "archive");
    const archiveLifecycle = archiveRequested
      ? await getOrganisationLifecycleDays(orgId)
      : null;

    const result = await db.transaction(async (tx) => {
      const [target] = await tx
        .select({
          id: teachersTable.id,
          name: teachersTable.name,
          schoolAdminRole: teachersTable.schoolAdminRole,
          accountStatus: teachersTable.accountStatus,
        })
        .from(teachersTable)
        .where(and(eq(teachersTable.id, targetId), eq(teachersTable.organisationId, orgId)))
        .for("update");
      if (!target) return { kind: "missing" as const };
      const denied = canManageDeparture(req.teacher!, target);
      if (denied) return { kind: "denied" as const, error: denied };
      if (target.accountStatus === "deleted") return { kind: "changed" as const };

      const classes = await tx
        .select({ id: classesTable.id, name: classesTable.name, archivedAt: classesTable.archivedAt })
        .from(classesTable)
        .where(eq(classesTable.teacherId, target.id))
        .for("update");
      const now = new Date();
      const actions = parsed.data.legacyArchiveAll
        ? classes.map((cls) => ({ action: "archive" as const, classId: cls.id, reason: "reason" in parsed.data ? parsed.data.reason : undefined }))
        : parsed.data.legacyReplacementTeacherId
          ? classes.map((cls) => ({
            action: "transfer" as const,
            classId: cls.id,
            replacementTeacherId: parsed.data.legacyReplacementTeacherId!,
          }))
          : parsed.data.actions;
      const actionByClassId = new Map(actions.map((action) => [action.classId, action]));
      const actionsCoverEveryClass = actionByClassId.size === actions.length
        && actionByClassId.size === classes.length
        && classes.every((cls) => actionByClassId.has(cls.id));
      if (!actionsCoverEveryClass) return { kind: "actions-invalid" as const };
      const archiveReason = ("reason" in parsed.data ? parsed.data.reason : undefined)
        ?? actions.find((action) => action.action === "archive")?.reason
        ?? "teacher_departure";

      const transferActions = actions.filter((action) => action.action === "transfer");
      if (transferActions.some((action) => action.replacementTeacherId === target.id)) {
        return { kind: "replacement-invalid" as const };
      }
      const replacementIds = [...new Set(transferActions.map((action) => action.replacementTeacherId))];
      let activeReplacementById = new Map<number, { id: number; name: string }>();
      if (replacementIds.length) {
        const replacements = await tx
          .select({
            id: teachersTable.id,
            name: teachersTable.name,
            accountStatus: teachersTable.accountStatus,
          })
          .from(teachersTable)
          .where(and(
            eq(teachersTable.organisationId, orgId),
            inArray(teachersTable.id, replacementIds),
          ))
          .for("update");
        activeReplacementById = new Map(
          replacements
            .filter((replacement) => replacement.accountStatus === "active")
            .map((replacement) => [replacement.id, replacement]),
        );
        if (activeReplacementById.size !== replacementIds.length) return { kind: "replacement-invalid" as const };
      }

      const retentionUntil = new Date(
        now.getTime() + (archiveLifecycle?.archiveRetentionDays ?? 30) * 24 * 60 * 60 * 1000,
      );
      const transferredClassIds: number[] = [];
      const archivedClassIds: number[] = [];
      for (const cls of classes) {
        const action = actionByClassId.get(cls.id)!;
        if (action.action === "transfer") {
          await tx.update(classesTable)
            .set({ teacherId: action.replacementTeacherId })
            .where(and(eq(classesTable.id, cls.id), eq(classesTable.teacherId, target.id)));
          transferredClassIds.push(cls.id);
        } else {
          await tx.update(classesTable)
            .set({
            archivedAt: now,
            archiveExpiresAt: retentionUntil,
            archiveLifecycleStatus: "archived",
            archiveExpiryNotifiedAt: null,
            archiveExpiryWarningAttemptedAt: null,
            archiveExpiryWarningSentAt: null,
            deletionRequestedAt: null,
            deletionScheduledFor: null,
            deletionRequestedBy: null,
            deletionReason: null,
            })
            .where(and(eq(classesTable.id, cls.id), eq(classesTable.teacherId, target.id)));
          archivedClassIds.push(cls.id);
        }
      }
      if (archivedClassIds.length) {
        await tx.update(studentActivitySessionsTable)
          .set({
            endedAt: sql`${studentActivitySessionsTable.lastSeenAt}`,
            endReason: "teacher_departure_archived",
          })
          .where(and(
            isNull(studentActivitySessionsTable.endedAt),
            inArray(
              studentActivitySessionsTable.studentSessionId,
              tx.select({ id: studentSessionsTable.id })
                .from(studentSessionsTable)
                .where(inArray(studentSessionsTable.classId, archivedClassIds)),
            ),
          ));
      }
      if (archivedClassIds.length) {
        const [existingArchive] = await tx
          .select({ id: teacherRecordArchivesTable.id })
          .from(teacherRecordArchivesTable)
          .where(eq(teacherRecordArchivesTable.teacherId, target.id))
          .for("update");
        if (existingArchive) {
          await tx.update(teacherRecordArchivesTable).set({
            retentionUntil,
            reason: archiveReason,
            archivedAt: now,
            archivedByTeacherId: req.teacher!.id,
          }).where(eq(teacherRecordArchivesTable.id, existingArchive.id));
        } else {
          await tx.insert(teacherRecordArchivesTable).values({
            organisationId: orgId,
            teacherId: target.id,
            retentionUntil,
            reason: archiveReason,
            archivedAt: now,
            archivedByTeacherId: req.teacher!.id,
          });
        }
      }
      await tx.update(teachersTable).set({
        accountStatus: "deleted",
        accountStatusChangedAt: now,
        mustChangePassword: false,
        passwordResetToken: null,
        passwordResetExpiresAt: null,
      }).where(eq(teachersTable.id, target.id));
      if (transferredClassIds.length) {
        await tx.insert(auditLogTable).values({
          organisationId: orgId,
          teacherId: req.teacher!.id,
          action: "teacher.departure_records_transferred",
          metadata: {
            departingTeacherId: target.id,
            transferredClassIds,
            transfers: transferredClassIds.map((classId) => {
              const action = actionByClassId.get(classId);
              return {
                classId,
                replacementTeacherId: action?.action === "transfer" ? action.replacementTeacherId : null,
              };
            }),
          },
          ipAddress: req.ip,
        });
      }
      if (archivedClassIds.length) {
        await tx.insert(auditLogTable).values({
          organisationId: orgId,
          teacherId: req.teacher!.id,
          action: "teacher.departure_classes_archived",
          metadata: {
            departingTeacherId: target.id,
            archivedClassIds,
            archivedClassCount: archivedClassIds.length,
            retentionDays: archiveLifecycle!.archiveRetentionDays,
            retentionUntil: retentionUntil.toISOString(),
          },
          ipAddress: req.ip,
        });
      }
      await tx.insert(auditLogTable).values({
        organisationId: orgId,
        teacherId: req.teacher!.id,
        action: "teacher.departure_completed",
        metadata: {
          departingTeacherId: target.id,
          archivedClassIds,
          transferredClassIds,
        },
        ipAddress: req.ip,
      });
      return {
        kind: archivedClassIds.length ? "archived" as const : "transferred" as const,
        classCount: classes.length,
        archivedClassIds,
        transferredClassIds,
        ...(archivedClassIds.length ? {
          retentionDays: archiveLifecycle!.archiveRetentionDays,
          retentionUntil,
        } : {}),
      };
    });

    if (result.kind === "missing") {
      res.status(404).json({ error: "Teacher not found in your organisation" });
      return;
    }
    if (result.kind === "denied") {
      res.status(403).json({ error: result.error });
      return;
    }
    if (result.kind === "changed") {
      res.status(409).json({ error: "This teacher’s departure record changed. Refresh and try again." });
      return;
    }
    if (result.kind === "replacement-invalid" || result.kind === "actions-invalid") {
      res.status(400).json({ error: "Choose an active replacement teacher in this school." });
      return;
    }
    await terminateTeacherSessions(targetId);
    res.json({ ok: true, ...result });
  },
);

router.post(
  "/teacher/org/classes/:classId/transfer",
  requireTeacher,
  requireSchoolMaster,
  async (req, res): Promise<void> => {
    const classId = Number(req.params.classId);
    const orgId = req.teacher!.organisationId;
    const parsed = TransferOrganisationClassBody.safeParse(req.body);
    if (!Number.isInteger(classId) || classId <= 0 || !orgId || !parsed.success) {
      res.status(400).json({ error: "Choose an active replacement teacher and confirm the class transfer." });
      return;
    }
    const result = await db.transaction(async (tx) => {
      const [actor] = await tx.select({ id: teachersTable.id, accountStatus: teachersTable.accountStatus })
        .from(teachersTable).where(eq(teachersTable.id, req.teacher!.id)).for("update");
      if (!actor || actor.accountStatus !== "active") return { kind: "denied" as const };
      const [cls] = await tx.select({
        id: classesTable.id,
        name: classesTable.name,
        teacherId: classesTable.teacherId,
        archivedAt: classesTable.archivedAt,
        deletionScheduledFor: classesTable.deletionScheduledFor,
      }).from(classesTable).innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
        .where(and(eq(classesTable.id, classId), eq(teachersTable.organisationId, orgId))).for("update");
      if (!cls) return { kind: "missing" as const };
      if (cls.archivedAt) return { kind: "archived" as const };
      if (cls.deletionScheduledFor) return { kind: "scheduled" as const };
      const [source] = await tx.select({ accountStatus: teachersTable.accountStatus })
        .from(teachersTable).where(eq(teachersTable.id, cls.teacherId)).for("update");
      if (!source || source.accountStatus !== "active") return { kind: "source-inactive" as const };
      if (cls.teacherId === parsed.data.replacementTeacherId) return { kind: "invalid-target" as const };
      const [replacement] = await tx.select({
        id: teachersTable.id,
        name: teachersTable.name,
        accountStatus: teachersTable.accountStatus,
      }).from(teachersTable).where(and(
        eq(teachersTable.id, parsed.data.replacementTeacherId),
        eq(teachersTable.organisationId, orgId),
      )).for("update");
      if (!replacement || replacement.accountStatus !== "active") return { kind: "invalid-target" as const };
      const [updated] = await tx.update(classesTable).set({ teacherId: replacement.id })
        .where(and(eq(classesTable.id, classId), eq(classesTable.teacherId, cls.teacherId))).returning({ id: classesTable.id });
      if (!updated) return { kind: "changed" as const };
      await tx.insert(auditLogTable).values({
        organisationId: orgId,
        teacherId: req.teacher!.id,
        action: "teacher.class_transferred",
        metadata: { classId, previousTeacherId: cls.teacherId, replacementTeacherId: replacement.id },
        ipAddress: req.ip,
      });
      return { kind: "transferred" as const, classId, replacementTeacherId: replacement.id, replacementName: replacement.name };
    });
    if (result.kind === "denied") {
      res.status(403).json({ error: "School administrator access required" });
      return;
    }
    if (result.kind === "missing") {
      res.status(404).json({ error: "Class not found in your organisation" });
      return;
    }
    if (result.kind === "archived") {
      res.status(409).json({ error: "Archived classes cannot be transferred." });
      return;
    }
    if (result.kind === "scheduled") {
      res.status(409).json({ error: "Classes scheduled for deletion cannot be transferred." });
      return;
    }
    if (result.kind === "source-inactive") {
      res.status(409).json({ error: "The current class owner is not active." });
      return;
    }
    if (result.kind === "invalid-target") {
      res.status(400).json({ error: "Choose another active teacher in this organisation." });
      return;
    }
    if (result.kind === "changed") {
      res.status(409).json({ error: "This class changed while it was being transferred. Refresh and try again." });
      return;
    }
    res.json({ ok: true, ...result });
  },
);

router.get(
  "/teacher/org/record-archives",
  requireTeacher,
  requireSchoolMaster,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation" });
      return;
    }
    const lifecycle = await getOrganisationLifecycleDays(orgId);
    const archives = await db
      .select({
        id: teacherRecordArchivesTable.id,
        teacherId: teacherRecordArchivesTable.teacherId,
        teacherName: teachersTable.name,
        teacherEmail: teachersTable.email,
        accountStatus: teachersTable.accountStatus,
        accountStatusChangedAt: teachersTable.accountStatusChangedAt,
        retentionUntil: teacherRecordArchivesTable.retentionUntil,
        reason: teacherRecordArchivesTable.reason,
        archivedAt: teacherRecordArchivesTable.archivedAt,
        classCount: sql<number>`count(${classesTable.id})::int`,
        classNames: sql<string[]>`coalesce(array_agg(${classesTable.name} order by ${classesTable.name}) filter (where ${classesTable.id} is not null), '{}')`,
      })
      .from(teacherRecordArchivesTable)
      .innerJoin(teachersTable, eq(teacherRecordArchivesTable.teacherId, teachersTable.id))
      .leftJoin(classesTable, eq(classesTable.teacherId, teacherRecordArchivesTable.teacherId))
      .where(eq(teacherRecordArchivesTable.organisationId, orgId))
      .groupBy(
        teacherRecordArchivesTable.id,
        teacherRecordArchivesTable.teacherId,
        teachersTable.name,
        teachersTable.email,
        teachersTable.accountStatus,
        teachersTable.accountStatusChangedAt,
        teacherRecordArchivesTable.retentionUntil,
        teacherRecordArchivesTable.reason,
        teacherRecordArchivesTable.archivedAt,
      )
      .orderBy(asc(teacherRecordArchivesTable.retentionUntil));
    res.json({
      items: archives.map((archive) => ({
        ...archive,
        accountRecoveryUntil: archive.accountStatus === "deleted" && archive.accountStatusChangedAt
          ? new Date(archive.accountStatusChangedAt.getTime() + lifecycle.deletionRecoveryDays * 24 * 60 * 60 * 1000)
          : null,
      })),
    });
  },
);

router.get(
  "/teacher/org/record-archives/deletion-evidence",
  requireTeacher,
  requireSchoolMaster,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation" });
      return;
    }
    const evidence = await db
      .select({
        id: teacherRecordDeletionEvidenceTable.id,
        deletedTeacherId: teacherRecordDeletionEvidenceTable.deletedTeacherId,
        archiveId: teacherRecordDeletionEvidenceTable.archiveId,
        applicationRecordsPurgedAt: teacherRecordDeletionEvidenceTable.applicationRecordsPurgedAt,
        managedFileObjectsStatus: teacherRecordDeletionEvidenceTable.managedFileObjectsStatus,
        backupStorageLifecycleStatus: teacherRecordDeletionEvidenceTable.backupStorageLifecycleStatus,
        backupStorageExpiryAt: teacherRecordDeletionEvidenceTable.backupStorageExpiryAt,
        backupStorageEvidenceReference: teacherRecordDeletionEvidenceTable.backupStorageEvidenceReference,
        backupStorageVerifiedAt: teacherRecordDeletionEvidenceTable.backupStorageVerifiedAt,
      })
      .from(teacherRecordDeletionEvidenceTable)
      .where(eq(teacherRecordDeletionEvidenceTable.organisationId, orgId))
      .orderBy(desc(teacherRecordDeletionEvidenceTable.applicationRecordsPurgedAt));

    res.json({
      items: evidence.map((entry) => ({
        id: entry.id,
        deletedTeacherId: entry.deletedTeacherId,
        archiveId: entry.archiveId,
        applicationRecordsPurgedAt: entry.applicationRecordsPurgedAt,
        managedFileObjectsStatus: entry.managedFileObjectsStatus,
        backupStorage: serialiseBackupStorageLifecycle(entry),
      })),
    });
  },
);

router.post(
  "/teacher/org/record-archives/:archiveId/classes/:classId/action",
  requireTeacher,
  requireSchoolMaster,
  async (req, res): Promise<void> => {
    const archiveId = Number(req.params.archiveId);
    const classId = Number(req.params.classId);
    const orgId = req.teacher!.organisationId;
    const parsed = ArchivedClassActionBody.safeParse(req.body);
    if (!Number.isInteger(archiveId) || archiveId <= 0 || !Number.isInteger(classId) || classId <= 0 || !orgId || !parsed.success) {
      res.status(400).json({ error: "Choose a valid archived-class action." });
      return;
    }
    const result = await db.transaction(async (tx) => {
      await acquireRetentionPolicyMutationLock(tx, orgId);
      const [archive] = await tx.select({
        id: teacherRecordArchivesTable.id,
        teacherId: teacherRecordArchivesTable.teacherId,
        retentionUntil: teacherRecordArchivesTable.retentionUntil,
      }).from(teacherRecordArchivesTable).where(and(
        eq(teacherRecordArchivesTable.id, archiveId),
        eq(teacherRecordArchivesTable.organisationId, orgId),
      )).for("update");
      if (!archive) return { kind: "missing" as const };
      if (archive.retentionUntil.getTime() <= Date.now()) {
        return { kind: "expired" as const, retentionUntil: archive.retentionUntil };
      }
      const [cls] = await tx.select({
        id: classesTable.id,
        name: classesTable.name,
        teacherId: classesTable.teacherId,
        archivedAt: classesTable.archivedAt,
        archiveLegalHold: classesTable.archiveLegalHold,
        deletionScheduledFor: classesTable.deletionScheduledFor,
      }).from(classesTable).where(and(
        eq(classesTable.id, classId),
        eq(classesTable.teacherId, archive.teacherId),
      )).for("update");
      if (!cls) return { kind: "class-missing" as const };
      if (!cls.archivedAt) return { kind: "not-archived" as const };

      if (parsed.data.action === "restore") {
        const [replacement] = await tx.select({
          id: teachersTable.id,
          name: teachersTable.name,
          accountStatus: teachersTable.accountStatus,
        }).from(teachersTable).where(and(
          eq(teachersTable.id, parsed.data.teacherId),
          eq(teachersTable.organisationId, orgId),
        )).for("update");
        if (!replacement || replacement.accountStatus !== "active") return { kind: "invalid-target" as const };
        const now = new Date();
        const [updated] = await tx.update(classesTable).set({
          teacherId: replacement.id,
          archivedAt: null,
          archiveExpiresAt: null,
          archiveLifecycleStatus: "active",
          archiveExpiryNotifiedAt: null,
          archiveExpiryWarningAttemptedAt: null,
          archiveExpiryWarningSentAt: null,
          deletionRequestedAt: null,
          deletionScheduledFor: null,
          deletionRequestedBy: null,
          deletionReason: null,
        }).where(and(eq(classesTable.id, cls.id), eq(classesTable.teacherId, archive.teacherId))).returning({ id: classesTable.id });
        if (!updated) return { kind: "changed" as const };
        await tx.update(studentSessionsTable).set({
          deletionRequestedAt: null,
          deletionScheduledFor: null,
          deletionRequestedBy: null,
          deletionReason: null,
        }).where(eq(studentSessionsTable.classId, cls.id));
        const [remaining] = await tx.select({ count: sql<number>`count(*)::int` })
          .from(classesTable).where(eq(classesTable.teacherId, archive.teacherId));
        if (Number(remaining?.count ?? 0) === 0) {
          await tx.delete(teacherRecordArchivesTable).where(eq(teacherRecordArchivesTable.id, archive.id));
        }
        await tx.insert(auditLogTable).values({
          organisationId: orgId,
          teacherId: req.teacher!.id,
          action: "teacher.archived_class_restored",
          metadata: { archiveId, classId, previousTeacherId: archive.teacherId, replacementTeacherId: replacement.id },
          ipAddress: req.ip,
        });
        return { kind: "restored" as const, classId, replacementTeacherId: replacement.id, archiveRemoved: Number(remaining?.count ?? 0) === 0, restoredAt: now };
      }

      if (cls.deletionScheduledFor) {
        return { kind: "already-scheduled" as const, deletionScheduledFor: cls.deletionScheduledFor };
      }
      if (cls.archiveLegalHold) return { kind: "legal-hold" as const };
      const students = await tx.select({ id: studentSessionsTable.id })
        .from(studentSessionsTable).where(eq(studentSessionsTable.classId, cls.id)).for("update");
      const blockingControl = await findBlockingStudentDataControl(tx, orgId, "deletion", {
        classIds: [cls.id],
        studentSessionIds: students.map((student) => student.id),
      });
      if (blockingControl) return { kind: "active-control" as const, controlId: blockingControl.id };
      const lifecycle = await getOrganisationLifecycleDays(orgId);
      const now = new Date();
      const deletionScheduledFor = new Date(now.getTime() + lifecycle.deletionRecoveryDays * 24 * 60 * 60 * 1000);
      const [updated] = await tx.update(classesTable).set({
        deletionRequestedAt: now,
        deletionScheduledFor,
        deletionRequestedBy: req.teacher!.id,
        deletionReason: "archive_retention_expired",
      }).where(and(eq(classesTable.id, cls.id), isNull(classesTable.deletionScheduledFor))).returning({ id: classesTable.id });
      if (!updated) return { kind: "changed" as const };
      await tx.update(studentSessionsTable).set({
        deletionRequestedAt: now,
        deletionScheduledFor,
        deletionRequestedBy: req.teacher!.id,
        deletionReason: "archive_retention_expired",
      }).where(eq(studentSessionsTable.classId, cls.id));
      await tx.update(studentActivitySessionsTable).set({
        endedAt: sql`${studentActivitySessionsTable.lastSeenAt}`,
        endReason: "deletion_requested",
      }).where(and(
        isNull(studentActivitySessionsTable.endedAt),
        inArray(studentActivitySessionsTable.studentSessionId, students.map((student) => student.id)),
      ));
      await tx.insert(auditLogTable).values({
        organisationId: orgId,
        teacherId: req.teacher!.id,
        action: "teacher.archived_class_deletion_scheduled",
        metadata: { archiveId, classId, studentIds: students.map((student) => student.id), deletionScheduledFor: deletionScheduledFor.toISOString() },
        ipAddress: req.ip,
      });
      return { kind: "scheduled" as const, classId, deletionScheduledFor };
    });
    if (result.kind === "missing" || result.kind === "class-missing") {
      res.status(404).json({ error: result.kind === "missing" ? "Archive not found" : "Class is not in this archive." });
      return;
    }
    if (result.kind === "expired") {
      res.status(409).json({ error: "This archive is no longer available.", retentionUntil: result.retentionUntil });
      return;
    }
    if (result.kind === "not-archived") {
      res.status(409).json({ error: "This class is not archived." });
      return;
    }
    if (result.kind === "invalid-target") {
      res.status(400).json({ error: "Choose an active teacher in this organisation." });
      return;
    }
    if (result.kind === "already-scheduled") {
      res.status(409).json({ error: "This class is already scheduled for deletion.", deletionScheduledFor: result.deletionScheduledFor });
      return;
    }
    if (result.kind === "legal-hold") {
      res.status(409).json({ error: "This class is protected by a legal hold and cannot be scheduled for deletion.", blockReason: "legal_hold" });
      return;
    }
    if (result.kind === "active-control") {
      res.status(409).json({ error: "This class cannot be deleted while a request-linked restriction or hold is active.", blockReason: "active_control", controlId: result.controlId });
      return;
    }
    if (result.kind === "changed") {
      res.status(409).json({ error: "This archived class changed while it was being updated. Refresh and try again." });
      return;
    }
    res.json({ ok: true, ...result });
  },
);

router.get(
  "/teacher/org/record-archives/:archiveId",
  requireTeacher,
  requireSchoolMaster,
  async (req, res): Promise<void> => {
    const archiveId = Number(req.params.archiveId);
    const orgId = req.teacher!.organisationId;
    if (!Number.isInteger(archiveId) || archiveId <= 0 || !orgId) {
      res.status(400).json({ error: "Invalid archive ID" });
      return;
    }
    const lifecycle = await getOrganisationLifecycleDays(orgId);

    const [archive] = await db
      .select({
        id: teacherRecordArchivesTable.id,
        teacherId: teacherRecordArchivesTable.teacherId,
        teacherName: teachersTable.name,
        teacherEmail: teachersTable.email,
        accountStatus: teachersTable.accountStatus,
        accountStatusChangedAt: teachersTable.accountStatusChangedAt,
        retentionUntil: teacherRecordArchivesTable.retentionUntil,
        reason: teacherRecordArchivesTable.reason,
        archivedAt: teacherRecordArchivesTable.archivedAt,
      })
      .from(teacherRecordArchivesTable)
      .innerJoin(teachersTable, eq(teacherRecordArchivesTable.teacherId, teachersTable.id))
      .where(and(
        eq(teacherRecordArchivesTable.id, archiveId),
        eq(teacherRecordArchivesTable.organisationId, orgId),
      ));

    if (!archive) {
      res.status(404).json({ error: "Archive not found" });
      return;
    }
    if (archive.retentionUntil.getTime() <= Date.now()) {
      res.status(409).json({
        error: "This archive is no longer available after its recorded archive end date.",
        retentionUntil: archive.retentionUntil,
      });
      return;
    }

    const classes = await db
      .select({
        id: classesTable.id,
        name: classesTable.name,
        subject: classesTable.subject,
        archivedAt: classesTable.archivedAt,
      })
      .from(classesTable)
      .where(eq(classesTable.teacherId, archive.teacherId))
      .orderBy(asc(classesTable.name));
    const classIds = classes.map((cls) => cls.id);
    const sessions = classIds.length
      ? await db.select({
        id: studentSessionsTable.id,
        classId: studentSessionsTable.classId,
        createdAt: studentSessionsTable.createdAt,
      }).from(studentSessionsTable).where(inArray(studentSessionsTable.classId, classIds)).orderBy(studentSessionsTable.createdAt)
      : [];

    const sessionIds = sessions.map((session) => session.id);
    const [stageRows, messageCounts] = sessionIds.length
      ? await Promise.all([
        db.select({
          sessionId: stageEntriesTable.sessionId,
        }).from(stageEntriesTable).where(inArray(stageEntriesTable.sessionId, sessionIds)),
        db.select({
          sessionId: chatMessagesTable.sessionId,
          count: sql<number>`count(*)::int`,
        }).from(chatMessagesTable).where(inArray(chatMessagesTable.sessionId, sessionIds)).groupBy(chatMessagesTable.sessionId),
      ])
      : [[], []];

    const messageCountBySession = new Map<number, number>(messageCounts.map((row) => [row.sessionId, row.count]));
    const stageCountBySession = new Map<number, number>();
    for (const row of stageRows) {
      stageCountBySession.set(row.sessionId, (stageCountBySession.get(row.sessionId) ?? 0) + 1);
    }
    const sessionsByClass = new Map<number, typeof sessions>();
    for (const session of sessions) {
      const current = sessionsByClass.get(session.classId) ?? [];
      current.push(session);
      sessionsByClass.set(session.classId, current);
    }

    await logAudit({
      organisationId: orgId,
      teacherId: req.teacher!.id,
      action: "teacher.archived_records_viewed",
      metadata: {
        archiveId: archive.id,
        archivedTeacherId: archive.teacherId,
        requestingRole: req.teacher!.schoolAdminRole,
        scope: "archive_summary",
      },
      ipAddress: req.ip,
    });

    res.json({
      id: archive.id,
      teacherId: archive.teacherId,
      teacherName: archive.teacherName,
      teacherEmail: archive.teacherEmail,
      accountStatus: archive.accountStatus,
      accountStatusChangedAt: archive.accountStatusChangedAt,
      reason: archive.reason,
      accountRecoveryUntil: archive.accountStatus === "deleted" && archive.accountStatusChangedAt
        ? new Date(archive.accountStatusChangedAt.getTime() + lifecycle.deletionRecoveryDays * 24 * 60 * 60 * 1000)
        : null,
      retentionUntil: archive.retentionUntil,
      archivedAt: archive.archivedAt,
      classCount: classes.length,
      classNames: classes.map((cls) => cls.name),
      classes: classes.map((cls) => {
        const classSessions = sessionsByClass.get(cls.id) ?? [];
        return {
          ...cls,
          studentRecordCount: classSessions.length,
          stageEntryCount: classSessions.reduce(
            (total, session) => total + (stageCountBySession.get(session.id) ?? 0),
            0,
          ),
          chatMessageCount: classSessions.reduce(
            (total, session) => total + (messageCountBySession.get(session.id) ?? 0),
            0,
          ),
          students: classSessions.map((session, index) => ({
            id: session.id,
            label: `Student record ${index + 1}`,
            createdAt: session.createdAt,
          })),
        };
      }),
    });
  },
);

router.post(
  "/teacher/org/record-archives/:archiveId/classes/:classId/students/:sessionId",
  requireTeacher,
  requireSchoolMaster,
  async (req, res): Promise<void> => {
    const archiveId = Number(req.params.archiveId);
    const classId = Number(req.params.classId);
    const sessionId = Number(req.params.sessionId);
    const orgId = req.teacher!.organisationId;
    if (![archiveId, classId, sessionId].every((value) => Number.isInteger(value) && value > 0) || !orgId) {
      res.status(400).json({ error: "Invalid archived record ID" });
      return;
    }
    const access = ArchivedDetailedAccessBody.safeParse(req.body);
    if (!access.success) {
      res.status(400).json({
        error: "A purpose statement and explicit confirmation are required to view detailed archived student work and chats.",
      });
      return;
    }

    const [archiveClass] = await db
      .select({
        archiveId: teacherRecordArchivesTable.id,
        classId: classesTable.id,
        teacherId: teachersTable.id,
        retentionUntil: teacherRecordArchivesTable.retentionUntil,
      })
      .from(teacherRecordArchivesTable)
      .innerJoin(teachersTable, eq(teacherRecordArchivesTable.teacherId, teachersTable.id))
      .innerJoin(classesTable, eq(classesTable.teacherId, teachersTable.id))
      .where(and(
        eq(teacherRecordArchivesTable.id, archiveId),
        eq(teacherRecordArchivesTable.organisationId, orgId),
        eq(classesTable.id, classId),
      ));
    if (!archiveClass) {
      res.status(404).json({ error: "Archived class not found" });
      return;
    }
    if (archiveClass.retentionUntil.getTime() <= Date.now()) {
      res.status(409).json({
        error: "This archive is no longer available after its recorded archive end date.",
        retentionUntil: archiveClass.retentionUntil,
      });
      return;
    }

    const [session] = await db
      .select()
      .from(studentSessionsTable)
      .where(and(eq(studentSessionsTable.id, sessionId), eq(studentSessionsTable.classId, classId)));
    if (!session) {
      res.status(404).json({ error: "Archived student record not found" });
      return;
    }
    const heldControlLock = await holdStudentDataControlLock(orgId, "export", {
      studentSessionIds: [sessionId],
      classIds: [classId],
    });
    if (heldControlLock.blockingControl) {
      await heldControlLock.release();
      res.status(409).json({
        error: "This archived record cannot be viewed while a request-linked export restriction is active.",
        blockReason: "active_control",
        controlId: heldControlLock.blockingControl.id,
      });
      return;
    }
    try {
    const [stageEntries, chatMessages] = await Promise.all([
      db.select().from(stageEntriesTable).where(eq(stageEntriesTable.sessionId, sessionId)).orderBy(desc(stageEntriesTable.updatedAt)),
      db.select().from(chatMessagesTable).where(eq(chatMessagesTable.sessionId, sessionId)).orderBy(chatMessagesTable.createdAt),
    ]);
    const msgCount = chatMessages.filter((message) => message.role === "user").length;
    const stageStatuses: Record<string, "none" | "started" | "finished"> = {};
    for (const entry of stageEntries) {
      stageStatuses[entry.stage] = computeStageStatus(entry.stage, entry.contentJson, msgCount);
    }

    let auditOutcome: Awaited<ReturnType<typeof recordDetailedArchiveAccess>>;
    try {
      auditOutcome = await recordDetailedArchiveAccess({
        archiveId,
        organisationId: orgId,
        teacherId: req.teacher!.id,
        action: "teacher.archived_student_record_viewed",
        metadata: {
          classId,
          sessionId,
          requestingRole: req.teacher!.schoolAdminRole,
          scope: "student_work_and_chat",
          purpose: access.data.purpose,
        },
        ipAddress: req.ip,
      });
    } catch {
      res.status(503).json({
        error: "Detailed archive access is temporarily unavailable because its audit record could not be stored.",
      });
      return;
    }
    if (auditOutcome.kind === "missing") {
      res.status(404).json({ error: "Archive not found" });
      return;
    }
    if (auditOutcome.kind === "expired") {
      res.status(409).json({
        error: "This archive is no longer available after its recorded archive end date.",
        retentionUntil: auditOutcome.retentionUntil,
      });
      return;
    }

    res.json({
      session: {
        id: session.id,
        classId: session.classId,
        studentName: session.studentName,
        createdAt: session.createdAt,
        lockedAt: session.lockedAt,
        lockedBy: session.lockedBy,
        latestStage: stageEntries[0]?.stage ?? null,
        completedStages: stageEntries.map((entry) => entry.stage),
        stageStatuses,
      },
      stageEntries,
      chatMessages,
    });
    } finally {
      await heldControlLock.release();
    }
  },
);

router.post(
  "/teacher/org/record-archives/:archiveId/export",
  requireTeacher,
  requireSchoolMaster,
  async (req, res): Promise<void> => {
    const archiveId = Number(req.params.archiveId);
    const orgId = req.teacher!.organisationId;
    if (!Number.isInteger(archiveId) || archiveId <= 0 || !orgId) {
      res.status(400).json({ error: "Invalid archive ID" });
      return;
    }
    const access = ArchivedDetailedAccessBody.safeParse(req.body);
    if (!access.success) {
      res.status(400).json({
        error: "A purpose statement and explicit confirmation are required to export detailed archived student work and chats.",
      });
      return;
    }

    const [archive] = await db
      .select({
        id: teacherRecordArchivesTable.id,
        teacherId: teacherRecordArchivesTable.teacherId,
        teacherName: teachersTable.name,
        retentionUntil: teacherRecordArchivesTable.retentionUntil,
        reason: teacherRecordArchivesTable.reason,
        archivedAt: teacherRecordArchivesTable.archivedAt,
      })
      .from(teacherRecordArchivesTable)
      .innerJoin(teachersTable, eq(teacherRecordArchivesTable.teacherId, teachersTable.id))
      .where(and(
        eq(teacherRecordArchivesTable.id, archiveId),
        eq(teacherRecordArchivesTable.organisationId, orgId),
      ));
    if (!archive) {
      res.status(404).json({ error: "Archive not found" });
      return;
    }
    if (archive.retentionUntil.getTime() <= Date.now()) {
      res.status(409).json({
        error: "This archive is no longer available after its recorded archive end date.",
        retentionUntil: archive.retentionUntil,
      });
      return;
    }

    const classes = await db
      .select({
        id: classesTable.id,
        name: classesTable.name,
        subject: classesTable.subject,
        createdAt: classesTable.createdAt,
        archivedAt: classesTable.archivedAt,
      })
      .from(classesTable)
      .where(eq(classesTable.teacherId, archive.teacherId))
      .orderBy(asc(classesTable.name));
    const classIds = classes.map((cls) => cls.id);
    const sessions = classIds.length
      ? await db.select({
        id: studentSessionsTable.id,
        classId: studentSessionsTable.classId,
        studentName: studentSessionsTable.studentName,
        createdAt: studentSessionsTable.createdAt,
        lockedAt: studentSessionsTable.lockedAt,
        lockedBy: studentSessionsTable.lockedBy,
      }).from(studentSessionsTable).where(inArray(studentSessionsTable.classId, classIds))
      : [];
    const sessionIds = sessions.map((session) => session.id);
    const heldControlLock = await holdStudentDataControlLock(orgId, "export", {
      studentSessionIds: sessionIds,
      classIds,
    });
    if (heldControlLock.blockingControl) {
      await heldControlLock.release();
      res.status(409).json({
        error: "This archive cannot be exported while a request-linked export restriction is active.",
        blockReason: "active_control",
        controlId: heldControlLock.blockingControl.id,
      });
      return;
    }
    try {
    const [tasks, stageEntries, chatMessages, feedback, activity] = await Promise.all([
      classIds.length
        ? db.select().from(tasksTable).where(inArray(tasksTable.classId, classIds))
        : Promise.resolve([] as Array<typeof tasksTable.$inferSelect>),
      sessionIds.length
        ? db.select().from(stageEntriesTable).where(inArray(stageEntriesTable.sessionId, sessionIds))
        : Promise.resolve([] as Array<typeof stageEntriesTable.$inferSelect>),
      sessionIds.length
        ? db.select().from(chatMessagesTable).where(inArray(chatMessagesTable.sessionId, sessionIds))
        : Promise.resolve([] as Array<typeof chatMessagesTable.$inferSelect>),
      sessionIds.length
        ? db.select().from(teacherFeedbackTable).where(inArray(teacherFeedbackTable.sessionId, sessionIds))
        : Promise.resolve([] as Array<typeof teacherFeedbackTable.$inferSelect>),
      sessionIds.length
        ? db.select().from(studentActivitySessionsTable).where(inArray(studentActivitySessionsTable.studentSessionId, sessionIds))
        : Promise.resolve([] as Array<typeof studentActivitySessionsTable.$inferSelect>),
    ]);
    const sessionsByClass = new Map<number, typeof sessions>();
    for (const session of sessions) {
      const entries = sessionsByClass.get(session.classId) ?? [];
      entries.push(session);
      sessionsByClass.set(session.classId, entries);
    }
    const taskByClass = new Map(tasks.map((task) => [task.classId, task]));

    let auditOutcome: Awaited<ReturnType<typeof recordDetailedArchiveAccess>>;
    try {
      auditOutcome = await recordDetailedArchiveAccess({
        archiveId: archive.id,
        organisationId: orgId,
        teacherId: req.teacher!.id,
        action: "teacher.archived_records_exported",
        metadata: {
          archivedTeacherId: archive.teacherId,
          classCount: classes.length,
          requestingRole: req.teacher!.schoolAdminRole,
          scope: "student_work_and_chat_export",
          purpose: access.data.purpose,
        },
        ipAddress: req.ip,
      });
    } catch {
      res.status(503).json({
        error: "Detailed archive export is temporarily unavailable because its audit record could not be stored.",
      });
      return;
    }
    if (auditOutcome.kind === "missing") {
      res.status(404).json({ error: "Archive not found" });
      return;
    }
    if (auditOutcome.kind === "expired") {
      res.status(409).json({
        error: "This archive is no longer available after its recorded archive end date.",
        retentionUntil: auditOutcome.retentionUntil,
      });
      return;
    }
    res.setHeader("Content-Disposition", `attachment; filename="archived-teacher-records-${archive.id}.json"`);
    res.json({
      exportedAt: new Date().toISOString(),
      archive,
      classes: classes.map((cls) => ({
        ...cls,
        task: taskByClass.get(cls.id) ?? null,
        students: (sessionsByClass.get(cls.id) ?? []).map((session) => ({
          ...session,
          stageEntries: stageEntries.filter((entry) => entry.sessionId === session.id),
          chatMessages: chatMessages.filter((message) => message.sessionId === session.id),
          feedback: feedback.filter((entry) => entry.sessionId === session.id),
          activity: activity.filter((entry) => entry.studentSessionId === session.id),
        })),
      })),
    });
    } finally {
      await heldControlLock.release();
    }
  },
);

router.post(
  "/teacher/org/record-archives/:archiveId/permanent-delete",
  requireTeacher,
  requireSchoolMaster,
  async (req, res): Promise<void> => {
    const archiveId = Number(req.params.archiveId);
    const orgId = req.teacher!.organisationId;
    const parsed = PermanentArchiveDeletionBody.safeParse(req.body);
    if (!Number.isInteger(archiveId) || archiveId <= 0 || !orgId || !parsed.success) {
      res.status(400).json({ error: "Type PERMANENTLY DELETE to confirm final deletion." });
      return;
    }

    const outcome = await db.transaction(async (tx) => {
      await acquireRetentionPolicyMutationLock(tx, orgId);
      const [archive] = await tx
        .select({
          id: teacherRecordArchivesTable.id,
          teacherId: teacherRecordArchivesTable.teacherId,
          retentionUntil: teacherRecordArchivesTable.retentionUntil,
        })
        .from(teacherRecordArchivesTable)
        .where(and(
          eq(teacherRecordArchivesTable.id, archiveId),
          eq(teacherRecordArchivesTable.organisationId, orgId),
        ))
        .for("update");
      if (!archive) return { kind: "missing" as const };
      if (archive.retentionUntil.getTime() > Date.now()) {
        return { kind: "retained" as const, retentionUntil: archive.retentionUntil };
      }

      const [teacherToPurge] = await tx
        .select({
          id: teachersTable.id,
          schoolAdminRole: teachersTable.schoolAdminRole,
        })
        .from(teachersTable)
        .where(and(eq(teachersTable.id, archive.teacherId), eq(teachersTable.organisationId, orgId)))
        .for("update");
      if (!teacherToPurge) return { kind: "missing" as const };
      const denied = canManageDeparture(req.teacher!, teacherToPurge);
      if (denied) return { kind: "denied" as const, error: denied };

      const now = new Date();
      const backupStorageLifecycle = backupStorageLifecycleForDeletion(now);
      const classesToPurge = await tx.select({ id: classesTable.id })
        .from(classesTable).where(eq(classesTable.teacherId, teacherToPurge.id)).for("update");
      const studentsToPurge = classesToPurge.length
        ? await tx.select({ id: studentSessionsTable.id }).from(studentSessionsTable)
          .where(inArray(studentSessionsTable.classId, classesToPurge.map((cls) => cls.id))).for("update")
        : [];
      const blockingControl = await findBlockingStudentDataControl(tx, orgId, "deletion", {
        classIds: classesToPurge.map((cls) => cls.id),
        studentSessionIds: studentsToPurge.map((student) => student.id),
      });
      if (blockingControl) {
        return { kind: "active_control" as const, controlId: blockingControl.id };
      }
      await recordDeletionTombstones(tx, [
        { entityType: "teacher", entityId: teacherToPurge.id },
        ...classesToPurge.map((cls) => ({ entityType: "class" as const, entityId: cls.id })),
        ...studentsToPurge.map((student) => ({ entityType: "student_record" as const, entityId: student.id })),
      ], now);
      const [deletionEvidence] = await tx.insert(teacherRecordDeletionEvidenceTable).values({
        organisationId: orgId,
        deletedTeacherId: archive.teacherId,
        archiveId: archive.id,
        applicationRecordsPurgedAt: now,
        managedFileObjectsStatus: "not_applicable",
        backupStorageLifecycleStatus: backupStorageLifecycle.status,
        backupStorageExpiryAt: backupStorageLifecycle.expiryAt,
        backupStorageEvidenceReference: backupStorageLifecycle.evidenceReference,
        deletedByTeacherId: req.teacher!.id,
      }).returning({
        applicationRecordsPurgedAt: teacherRecordDeletionEvidenceTable.applicationRecordsPurgedAt,
        managedFileObjectsStatus: teacherRecordDeletionEvidenceTable.managedFileObjectsStatus,
        backupStorageLifecycleStatus: teacherRecordDeletionEvidenceTable.backupStorageLifecycleStatus,
        backupStorageExpiryAt: teacherRecordDeletionEvidenceTable.backupStorageExpiryAt,
        backupStorageEvidenceReference: teacherRecordDeletionEvidenceTable.backupStorageEvidenceReference,
        backupStorageVerifiedAt: teacherRecordDeletionEvidenceTable.backupStorageVerifiedAt,
      });
      await tx.insert(auditLogTable).values({
        organisationId: orgId,
        teacherId: req.teacher!.id,
        action: "teacher.archive_permanently_deleted",
        metadata: {
          archiveId: archive.id,
          purgedTeacherId: archive.teacherId,
          retentionUntil: archive.retentionUntil.toISOString(),
        },
        ipAddress: req.ip,
      });
      await tx.delete(teachersTable).where(and(
        eq(teachersTable.id, teacherToPurge.id),
        eq(teachersTable.organisationId, orgId),
      ));
      return {
        kind: "purged" as const,
        teacherId: archive.teacherId,
        deletionEvidence: {
          applicationRecordsPurgedAt: deletionEvidence.applicationRecordsPurgedAt,
          managedFileObjectsStatus: deletionEvidence.managedFileObjectsStatus,
          backupStorage: serialiseBackupStorageLifecycle(deletionEvidence),
        },
      };
    });

    if (outcome.kind === "missing") {
      res.status(404).json({ error: "Archive not found" });
      return;
    }
    if (outcome.kind === "denied") {
      res.status(403).json({ error: outcome.error });
      return;
    }
    if (outcome.kind === "retained") {
      res.status(409).json({
        error: "This archive must be kept until its recorded archive end date.",
        retentionUntil: outcome.retentionUntil,
      });
      return;
    }
    if (outcome.kind === "active_control") {
      res.status(409).json({
        error: "This archive cannot be deleted while a request-linked restriction or hold is active.",
        blockReason: "active_control",
        controlId: outcome.controlId,
      });
      return;
    }

    await terminateTeacherSessions(outcome.teacherId);
    res.json({ ok: true, permanentlyDeleted: true, deletionEvidence: outcome.deletionEvidence });
  },
);

router.post(
  "/teacher/org/teacher/:id/restore",
  requireTeacher,
  requireSchoolMaster,
  async (req, res): Promise<void> => {
    const targetId = Number(req.params.id);
    const orgId = req.teacher!.organisationId;
    if (!Number.isInteger(targetId) || targetId <= 0 || !orgId || targetId === req.teacher!.id) {
      res.status(400).json({ error: "Invalid teacher restore request." });
      return;
    }
    const result = await db.transaction(async (tx) => {
      const [actor] = await tx.select({
        id: teachersTable.id,
        accountStatus: teachersTable.accountStatus,
        schoolAdminRole: teachersTable.schoolAdminRole,
      }).from(teachersTable).where(and(
        eq(teachersTable.id, req.teacher!.id),
        eq(teachersTable.organisationId, orgId),
      )).for("update");
      if (!actor || actor.accountStatus !== "active" || actor.schoolAdminRole !== "master") {
        return { kind: "denied" as const };
      }
      const [target] = await tx.select({
        id: teachersTable.id,
        name: teachersTable.name,
        accountStatus: teachersTable.accountStatus,
        accountStatusChangedAt: teachersTable.accountStatusChangedAt,
        schoolAdminRole: teachersTable.schoolAdminRole,
      }).from(teachersTable).where(and(
        eq(teachersTable.id, targetId),
        eq(teachersTable.organisationId, orgId),
      )).for("update");
      if (!target) return { kind: "missing" as const };
      const denied = canManageDeparture(actor as typeof teachersTable.$inferSelect, target);
      if (denied) return { kind: "denied" as const, error: denied };
      if (target.accountStatus !== "deleted") return { kind: "not-deleted" as const };
      const lifecycle = await getOrganisationLifecycleDays(orgId);
      const recoveryUntil = target.accountStatusChangedAt
        ? new Date(target.accountStatusChangedAt.getTime() + lifecycle.deletionRecoveryDays * 24 * 60 * 60 * 1000)
        : null;
      if (!recoveryUntil || recoveryUntil.getTime() <= Date.now()) {
        return { kind: "expired" as const, recoveryUntil };
      }
      const [updated] = await tx.update(teachersTable).set({
        accountStatus: "active",
        accountStatusChangedAt: new Date(),
      }).where(and(
        eq(teachersTable.id, target.id),
        eq(teachersTable.accountStatus, "deleted"),
      )).returning({ id: teachersTable.id, accountStatus: teachersTable.accountStatus, accountStatusChangedAt: teachersTable.accountStatusChangedAt });
      if (!updated) return { kind: "changed" as const };
      const [owned] = await tx.select({ count: sql<number>`count(*)::int` })
        .from(classesTable).where(eq(classesTable.teacherId, target.id));
      let archiveRemoved = false;
      if (Number(owned?.count ?? 0) === 0) {
        const deleted = await tx.delete(teacherRecordArchivesTable).where(and(
          eq(teacherRecordArchivesTable.teacherId, target.id),
          eq(teacherRecordArchivesTable.organisationId, orgId),
        )).returning({ id: teacherRecordArchivesTable.id });
        archiveRemoved = deleted.length > 0;
      }
      await tx.insert(auditLogTable).values({
        organisationId: orgId,
        teacherId: req.teacher!.id,
        action: "teacher.account_restored",
        metadata: { targetTeacherId: target.id, recoveryUntil: recoveryUntil.toISOString(), archiveRemoved },
        ipAddress: req.ip,
      });
      return { kind: "restored" as const, teacher: updated, archiveRemoved };
    });
    if (result.kind === "denied") {
      res.status(403).json({ error: "Only an active School Master can restore a teacher account." });
      return;
    }
    if (result.kind === "missing") {
      res.status(404).json({ error: "Teacher not found in your organisation." });
      return;
    }
    if (result.kind === "not-deleted") {
      res.status(409).json({ error: "Only deleted teacher accounts can be restored." });
      return;
    }
    if (result.kind === "expired") {
      res.status(409).json({ error: "This teacher account is outside the organisation's recovery period.", accountRecoveryUntil: result.recoveryUntil });
      return;
    }
    if (result.kind === "changed") {
      res.status(409).json({ error: "This teacher account changed while it was being restored. Refresh and try again." });
      return;
    }
    res.json({ ok: true, restored: true, accountStatus: result.teacher.accountStatus, accountStatusChangedAt: result.teacher.accountStatusChangedAt, archiveRemoved: result.archiveRemoved });
  },
);

const TeacherAccountStatusBody = z.object({
  status: z.enum(["active", "suspended", "deleted"]),
});

router.patch(
  "/teacher/org/teacher/:id/status",
  requireTeacher,
  requireSchoolAdmin,
  async (req, res): Promise<void> => {
    const targetId = Number(req.params.id);
    const orgId = req.teacher!.organisationId;
    if (!Number.isInteger(targetId) || targetId <= 0 || !orgId) {
      res.status(400).json({ error: "Invalid teacher account" });
      return;
    }

    const parsed = TeacherAccountStatusBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Choose a valid account status." });
      return;
    }
    if (parsed.data.status === "deleted") {
      res.status(409).json({
        error: "Use the School Admin departure workflow to transfer or archive records before removing access.",
      });
      return;
    }
    const accountStatus = parsed.data.status;
    if (targetId === req.teacher!.id) {
      res.status(400).json({ error: "You cannot change your own account status." });
      return;
    }

    const [target] = await db
      .select({
        id: teachersTable.id,
        name: teachersTable.name,
        email: teachersTable.email,
        schoolAdminRole: teachersTable.schoolAdminRole,
        accountStatus: teachersTable.accountStatus,
      })
      .from(teachersTable)
      .where(and(eq(teachersTable.id, targetId), eq(teachersTable.organisationId, orgId)));

    if (!target) {
      res.status(404).json({ error: "Teacher not found in your organisation" });
      return;
    }
    if (target.schoolAdminRole === "master") {
      res.status(403).json({ error: "The School Admin account is managed by CIG administration." });
      return;
    }
    if (target.schoolAdminRole === "subadmin" && req.teacher!.schoolAdminRole !== "master") {
      res.status(403).json({ error: "Only the School Admin can manage a School Sub-admin account." });
      return;
    }
    if (target.accountStatus === "deleted") {
      res.status(409).json({ error: "Deleted teacher accounts cannot be restored or changed." });
      return;
    }
    if (target.accountStatus === parsed.data.status) {
      res.json({ ok: true, changed: false, accountStatus: target.accountStatus });
      return;
    }

    const [updated] = await db
      .update(teachersTable)
      .set({
        accountStatus,
        accountStatusChangedAt: new Date(),
      })
      .where(and(
        eq(teachersTable.id, targetId),
        eq(teachersTable.organisationId, orgId),
        eq(teachersTable.accountStatus, target.accountStatus),
      ))
      .returning({
        accountStatus: teachersTable.accountStatus,
        accountStatusChangedAt: teachersTable.accountStatusChangedAt,
      });

    if (!updated) {
      res.status(409).json({ error: "This teacher account changed. Refresh the page and try again." });
      return;
    }

    await terminateTeacherSessions(targetId);
    await logAudit({
      organisationId: orgId,
      teacherId: req.teacher!.id,
      action: accountStatus === "suspended" ? "teacher.account_suspended" : "teacher.account_restored",
      metadata: {
        forTeacherId: target.id,
        forTeacherEmail: target.email,
        previousStatus: target.accountStatus,
        accountStatus,
      },
      ipAddress: req.ip,
    });

    res.json({ ok: true, changed: true, accountStatus: updated.accountStatus, accountStatusChangedAt: updated.accountStatusChangedAt });
  },
);

// ── Generate password reset link for teacher (IT admin only) ──────────────────

router.post(
  "/teacher/org/teacher/:id/request-reset",
  requireTeacher,
  requireSchoolAdmin,
  async (req, res): Promise<void> => {
    const targetId = Number(req.params.id);
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation" });
      return;
    }

    const [target] = await db
      .select({
        id: teachersTable.id,
        email: teachersTable.email,
        organisationId: teachersTable.organisationId,
        schoolAdminRole: teachersTable.schoolAdminRole,
      })
      .from(teachersTable)
      .where(and(eq(teachersTable.id, targetId), eq(teachersTable.organisationId, orgId)));

    if (!target) {
      res.status(404).json({ error: "Teacher not found in your organisation" });
      return;
    }
    if (target.schoolAdminRole === "master") {
      res.status(403).json({ error: "The School Admin account is managed by CIG administration." });
      return;
    }
    if (target.schoolAdminRole === "subadmin" && req.teacher!.schoolAdminRole !== "master") {
      res.status(403).json({ error: "Only the School Admin can reset a School Sub-admin account." });
      return;
    }

    const { randomUUID } = await import("crypto");
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await db
      .update(teachersTable)
      .set({ passwordResetToken: hashPasswordResetToken(token), passwordResetExpiresAt: expiresAt, mustChangePassword: true })
      .where(eq(teachersTable.id, targetId));

    await logAudit({
      organisationId: orgId,
      teacherId: req.teacher!.id,
      action: "teacher.reset_link_generated",
      metadata: { forTeacherId: targetId, forTeacherEmail: target.email },
      ipAddress: req.ip,
    });

    res.json({ resetToken: token, expiresAt });
  },
);

// ── Unlock locked teacher account (IT admin only) ─────────────────────────────

router.post(
  "/teacher/org/teacher/:id/unlock",
  requireTeacher,
  requireSchoolAdmin,
  async (req, res): Promise<void> => {
    const targetId = Number(req.params.id);
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation" });
      return;
    }

    const [target] = await db
      .select({ id: teachersTable.id, email: teachersTable.email, schoolAdminRole: teachersTable.schoolAdminRole, accountStatus: teachersTable.accountStatus, approvalStatus: teachersTable.approvalStatus })
      .from(teachersTable)
      .where(and(eq(teachersTable.id, targetId), eq(teachersTable.organisationId, orgId)));

    if (!target) {
      res.status(404).json({ error: "Teacher not found in your organisation" });
      return;
    }
    if (target.schoolAdminRole === "master") {
      res.status(403).json({ error: "The School Admin account is managed by CIG administration." });
      return;
    }
    if (target.schoolAdminRole === "subadmin" && req.teacher!.schoolAdminRole !== "master") {
      res.status(403).json({ error: "Only the School Admin can unlock a School Sub-admin account." });
      return;
    }

    await db
      .update(teachersTable)
      .set({ failedLoginAttempts: 0, lockedUntil: null })
      .where(eq(teachersTable.id, targetId));

    await logAudit({
      organisationId: orgId,
      teacherId: req.teacher!.id,
      action: "teacher.account_unlocked",
      metadata: { forTeacherId: targetId, forTeacherEmail: target.email },
      ipAddress: req.ip,
    });

    res.json({ ok: true });
  },
);

// ── Reset teacher authenticator (IT admin only) ───────────────────────────────

router.post(
  "/teacher/org/teacher/:id/reset-mfa",
  requireTeacher,
  requireSchoolAdmin,
  async (req, res): Promise<void> => {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      res.status(400).json({ error: "Invalid teacher account" });
      return;
    }
    if (targetId === req.teacher!.id) {
      res.status(400).json({ error: "You cannot reset your own authenticator here." });
      return;
    }

    const result = await db.transaction(async (tx) => {
      const [actor] = await tx
        .select({
          organisationId: teachersTable.organisationId,
          isItAdmin: teachersTable.isItAdmin,
          schoolAdminRole: teachersTable.schoolAdminRole,
          accountStatus: teachersTable.accountStatus,
        })
        .from(teachersTable)
        .where(eq(teachersTable.id, req.teacher!.id))
        .for("update");
      if (
        !actor?.organisationId
        || actor.accountStatus !== "active"
        || !actor.isItAdmin
        || !["master", "subadmin"].includes(actor.schoolAdminRole ?? "")
      ) {
        return { ok: false as const, status: 403, error: "School administrator access required" };
      }

      const [target] = await tx
        .select({
          id: teachersTable.id,
          email: teachersTable.email,
          organisationId: teachersTable.organisationId,
          schoolAdminRole: teachersTable.schoolAdminRole,
          accountStatus: teachersTable.accountStatus,
        })
        .from(teachersTable)
        .where(eq(teachersTable.id, targetId))
        .for("update");

      if (!target || target.organisationId !== actor.organisationId) {
        return { ok: false as const, status: 404, error: "Teacher not found in your organisation" };
      }
      if (target.schoolAdminRole === "master") {
        return { ok: false as const, status: 403, error: "The School Admin account is managed by CIG administration." };
      }
      if (target.schoolAdminRole === "subadmin" && actor.schoolAdminRole !== "master") {
        return { ok: false as const, status: 403, error: "Only the School Admin can reset a School Sub-admin authenticator." };
      }
      if (target.accountStatus !== "active") {
        return { ok: false as const, status: 409, error: "Only active teacher accounts can have their authenticator reset." };
      }

      await resetTeacherTotpAndSessionsInTransaction(tx, target.id);
      return { ok: true as const, organisationId: actor.organisationId, target };
    });

    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    await logAudit({
      organisationId: result.organisationId,
      teacherId: req.teacher!.id,
      action: "teacher.totp_reset",
      metadata: {
        forTeacherId: result.target.id,
        forTeacherEmail: result.target.email,
        reason: "authenticator_device_recovery",
      },
      ipAddress: req.ip,
    });

    res.json({ ok: true, mfaReset: true, totpEnabled: false });
  },
);

// ── Appoint / remove School Sub-admin (School Master only) ─────────────────────

router.patch(
  "/teacher/org/teacher/:id/set-admin",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const targetId = Number(req.params.id);
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation" });
      return;
    }
    if (targetId === req.teacher!.id) {
      res.status(400).json({ error: "You cannot change your own admin status" });
      return;
    }
    const { schoolAdminRole } = req.body ?? {};
    if (schoolAdminRole !== "subadmin" && schoolAdminRole !== null) {
      res.status(400).json({ error: "schoolAdminRole must be 'subadmin' or null" });
      return;
    }

    const [target] = await db
      .select({ id: teachersTable.id, email: teachersTable.email, schoolAdminRole: teachersTable.schoolAdminRole })
      .from(teachersTable)
      .where(and(eq(teachersTable.id, targetId), eq(teachersTable.organisationId, orgId)));

    if (!target) {
      res.status(404).json({ error: "Teacher not found in your organisation" });
      return;
    }
    if (target.schoolAdminRole === "master") {
      res.status(403).json({ error: "The School Admin account is managed by CIG administration." });
      return;
    }

    const [updated] = await db
      .update(teachersTable)
      .set({
        isItAdmin: schoolAdminRole === "subadmin",
        schoolAdminRole,
      })
      .where(schoolAdminRole === "subadmin"
        ? and(eq(teachersTable.id, targetId), eq(teachersTable.accountStatus, "active"), eq(teachersTable.approvalStatus, "approved"))
        : eq(teachersTable.id, targetId))
      .returning({ id: teachersTable.id });
    if (!updated) {
      res.status(409).json({ error: "Only active, approved teacher accounts can be made School Sub-admins." });
      return;
    }

    await logAudit({
      organisationId: orgId,
      teacherId: req.teacher!.id,
      action: schoolAdminRole === "subadmin" ? "teacher.promoted_to_subadmin" : "teacher.demoted_from_subadmin",
      metadata: { forTeacherId: targetId, forTeacherEmail: target.email },
      ipAddress: req.ip,
    });

    res.json({ ok: true, isItAdmin: schoolAdminRole === "subadmin", schoolAdminRole });
  },
);

export default router;
