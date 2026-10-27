import { useState, useEffect, type ComponentType } from "react";
import { Link, useLocation } from "wouter";
import { apiFetch, apiFetchBlob, clearTeacherToken } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import {
  Archive,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  LockKeyhole,
  Mail,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";

interface OrgAiSettings {
  configured: boolean;
  aiProvider: string | null;
  azureEndpoint: string | null;
  dataProcessingAcknowledged: boolean;
  dataProcessingAcknowledgedAt: string | null;
  dataProcessingApproverRecorded: boolean;
  dataProcessingPolicyVersion: string | null;
  dataProcessingEvidenceReference: string | null;
  dataProcessingRegion: string | null;
  dataRetentionNoTrainingConfirmed: boolean;
  dataProcessingReviewDate: string | null;
  researchProcessingBlocked: boolean;
}

interface OrgTeacher {
  id: number;
  name: string;
  email: string;
  isItAdmin: boolean;
  schoolAdminRole: "master" | "subadmin" | null;
  canReviewSafeguarding: boolean;
  accountStatus: "active" | "suspended" | "deleted";
  accountStatusChangedAt: string | null;
  accountRecoveryUntil?: string | null;
  accountRecoveryEligible?: boolean;
  approvalStatus: "pending" | "approved" | "rejected";
  approvalReviewedAt: string | null;
  approvalReviewedBy: number | null;
  approvalReason: string | null;
  totpEnabled: boolean;
  mustChangePassword: boolean;
  failedLoginAttempts: number;
  lockedUntil: string | null;
  createdAt: string;
}

interface AuditEntry {
  id: number;
  action: string;
  ipAddress: string | null;
  createdAt: string;
  teacherName: string | null;
  teacherEmail: string | null;
  archiveAccess: {
    archiveId: number;
    classId: number | null;
    sessionId: number | null;
    requestingRole: "master";
    scope: string;
    purpose: string;
  } | null;
}

interface AuditReport {
  items: AuditEntry[];
  matchingCount: number;
  truncated: boolean;
  limit: number;
  actions: string[];
}

type TeacherDirectoryFilters = {
  q: string;
  status: "all" | "active" | "suspended" | "deleted";
  approvalStatus: "all" | "pending" | "approved" | "rejected";
  from: string;
  to: string;
  sort: "name" | "createdAt" | "status";
  direction: "asc" | "desc";
  page: number;
};

type TeacherDirectoryView = "active" | "suspended" | "pending" | "deleted" | "all";

interface RetentionPolicy {
  id: number;
  dataCategory: string;
  label: string;
  retentionDays: number;
  archiveRetentionDays?: number;
  deletionRecoveryDays?: number;
  reviewDate: string;
  deletionStatus: "retained" | "scheduled" | "under_review";
  notes: string | null;
  legalHold: boolean;
  operatorVerifiedAt: string | null;
  executionStatus: "ready" | "blocked";
  blockReason: "policy_not_scheduled" | "legal_hold" | "missing_operator_verification" | null;
  updatedAt: string;
}
interface PlatformRetentionPolicy {
  archiveRetentionDays: number;
  deletionRecoveryDays: number;
  minimumDays: number;
  maximumDays: number;
  standardChoices: number[];
}

interface DepartureSummary {
  teacher: Pick<OrgTeacher, "id" | "name" | "email" | "accountStatus">;
  classes: Array<{ id: number; name: string; subject: string | null; archivedAt: string | null }>;
  studentCount: number;
}

interface TeacherRecordArchive {
  id: number;
  retentionUntil: string;
  archivedAt: string;
  classCount: number;
  teacherId?: number | null;
  teacherName?: string | null;
  teacherEmail?: string | null;
  teacherAccountStatus?: string | null;
  accountStatusChangedAt?: string | null;
  accountRecoveryUntil?: string | null;
  reason?: string | null;
  classNames?: string[] | string | null;
}

interface TeacherRecordDeletionEvidence {
  id: number;
  deletedTeacherId: number;
  archiveId: number;
  applicationRecordsPurgedAt: string;
  managedFileObjectsStatus: "not_applicable" | "purged";
  backupStorage: {
    status: "pending" | "verified";
    configured: boolean;
    expiresAt: string | null;
    verifiedAt: string | null;
  };
}
interface RecoverableDeletionRequests {
  classes: Array<{
    id: number;
    name: string;
    subject: string | null;
    teacherId: number;
    teacherName: string;
    deletionScheduledFor: string;
    deletionReason: string | null;
  }>;
  studentRecords: Array<{
    id: number;
    studentName: string;
    classId: number;
    className: string;
    teacherId: number;
    teacherName: string;
    deletionScheduledFor: string;
  }>;
}
interface ArchivedStudentSummary {
  id: number;
  studentName: string;
  createdAt: string;
  lockedAt: string | null;
  lockedBy: number | null;
  latestStage: string | null;
  completedStages: string[];
  stageStatuses: Record<string, "none" | "started" | "finished">;
}

interface ArchivedStudentReference {
  id: number;
  label: string;
  createdAt: string;
}
interface ArchivedClassRecord {
  id: number;
  name: string;
  subject: string | null;
  archivedAt: string | null;
  studentRecordCount: number;
  stageEntryCount: number;
  chatMessageCount: number;
  students: ArchivedStudentReference[];
}

interface ArchivedRecordDetail extends TeacherRecordArchive {
  classes: ArchivedClassRecord[];
}

type DepartureAction = "archive" | "transfer";

interface ArchivedStudentDetail {
  session: ArchivedStudentSummary & { classId: number };
  stageEntries: Array<{ id: number; stage: string; contentJson: Record<string, unknown>; updatedAt: string }>;
  chatMessages: Array<{ id: number; role: string; content: string; createdAt: string }>;
}

type ArchivedAccessRequest =
  | { type: "student"; archive: ArchivedRecordDetail; cls: ArchivedClassRecord; student: ArchivedStudentReference }
  | { type: "export"; archive: TeacherRecordArchive };

interface StudentDataRequestStudent {
  id: number;
  studentName: string;
  classId: number;
  className: string;
  classArchivedAt: string | null;
}

const studentDataRequestTypeLabel = (requestType: StudentDataRequestType) => ({
  access: "Data copy requested",
  correction: "Correction requested",
  deletion: "Deletion requested",
}[requestType]);

const escapeStudentExportHtml = (value: unknown) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const readableStudentExportValue = (value: unknown) => {
  if (value === null || value === undefined || value === "") return "Not recorded";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

const studentExportStageTitles: Record<string, string> = {
  MAP: "Planning My Enquiry",
  TORCH: "Guided AI-Mediated Investigation",
  RESEARCH: "Sources & Research Notes",
  COMPASS: "Check Your Thinking",
  EMBED: "Final Answer & Reflection",
};

const studentExportLabels: Record<string, string> = {
  taskUnderstanding: "Understanding of the task",
  priorKnowledge: "What I already know",
  knowledgeGaps: "What I need to find out",
  enquiryQuestions: "Questions I want to answer",
  researchPlan: "Research plan",
  entries: "Research sources",
  finalAnswer: "Final answer",
  check1: "Say it in your own words",
  check2: "The strongest challenge to your thinking",
  check3: "Where you are least confident",
  check4: "Is your evidence balanced?",
  check5: "Are you ready to write?",
  q1: "What changed in your understanding?",
  q2: "Where did you do the thinking?",
  q3: "How did AI help your learning?",
  q4: "What did you decide not to trust?",
  investigation: "Investigation",
  sources: "Planned source types",
  plannedSource: "Planned source or link",
  actualSource: "Actual source used",
  verification: "Planned verification method",
  verificationSelections: "Verification methods",
  sourceType: "Source type",
  sourceDetails: "Source details or citation",
  findings: "What the student found",
  importantPoints: "What the student considered most important",
  combinedLearning: "What the student learned",
  reliability: "Trustworthiness evaluation",
  trustworthinessSelections: "Trustworthiness checks",
  usage: "Effect on the student's thinking",
  effectSelection: "Effect on thinking",
  isComplete: "Completion status",
  sourceOrigin: "Source origin",
  sourceId: "Source ID",
  addedAt: "Date and time added",
  mapContext: "Planning context",
  sourceProvenance: "Source provenance",
  originalSource: "Original source",
  role: "Role",
  content: "Message",
  bloomLevel: "Thinking level",
};

const readableStudentExportLabel = (key: string, stage?: string) => {
  if (stage === "MAP" && key === "q1") return "What is this task asking you to do?";
  if (stage === "MAP" && key === "q2") return "What do you already know about this topic?";
  if (stage === "MAP" && key === "q3") return "What might be difficult about this task?";
  if (stage === "MAP" && key === "q4") return "Break the task into its component parts.";
  if (stage === "MAP" && key === "q5") return "Plan your research.";
  return studentExportLabels[key] ?? key
    .replaceAll(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase());
};

const studentExportHasValue = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(studentExportHasValue);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).some(studentExportHasValue);
  return true;
};

const renderStudentExportNode = (value: unknown, label: string, stage?: string): string => {
  const heading = label ? `<h4 class="answer-label">${escapeStudentExportHtml(label)}</h4>` : "";
  if (!studentExportHasValue(value)) return "";
  if (Array.isArray(value)) {
    const primitiveItems = value.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item));
    return `<div class="answer-group">${heading}${primitiveItems
      ? `<ul class="answer-list">${value.filter(studentExportHasValue).map((item) => `<li>${escapeStudentExportHtml(readableStudentExportValue(item))}</li>`).join("")}</ul>`
      : value.filter(studentExportHasValue).map((item, index) => `<div class="nested-card">${renderStudentExportNode(item, `Item ${index + 1}`, stage)}</div>`).join("")}</div>`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => studentExportHasValue(entry));
    return `<div class="answer-group">${heading}<div class="answer-grid">${entries.length
      ? entries.map(([key, entry]) => renderStudentExportNode(entry, readableStudentExportLabel(key, stage), stage)).join("")
      : ""}</div></div>`;
  }
  return `<div class="answer-card">${heading}<div class="answer-value">${escapeStudentExportHtml(readableStudentExportValue(value))}</div></div>`;
};

const renderStudentExportAnswer = (
  label: string,
  value: unknown,
  options: { className?: string; valueClassName?: string } = {},
) => !studentExportHasValue(value) ? "" : `
  <div class="${options.className ?? "answer-card"}">
    <h4 class="answer-label">${escapeStudentExportHtml(label)}</h4>
    <div class="answer-value ${options.valueClassName ?? ""}">${escapeStudentExportHtml(readableStudentExportValue(value))}</div>
  </div>`;

const renderStudentExportListAnswer = (label: string, value: unknown, ordered = false) => {
  if (!Array.isArray(value) || !value.some(studentExportHasValue)) return "";
  const items = value.filter(studentExportHasValue);
  const listTag = ordered ? "ol" : "ul";
  return `<div class="answer-card">
    <h4 class="answer-label">${escapeStudentExportHtml(label)}</h4>
    <${listTag} class="answer-list">${items.map((item) => `<li>${escapeStudentExportHtml(readableStudentExportValue(item))}</li>`).join("")}</${listTag}>
  </div>`;
};

const renderStudentUnansweredPrompts = (labels: string[]) => labels.length === 0 ? "" : `
  <details class="unanswered-prompts">
    <summary>Unanswered prompts (${labels.length})</summary>
    <ul class="answer-list">${labels.map((label) => `<li>${escapeStudentExportHtml(label)}</li>`).join("")}</ul>
  </details>`;

const renderStudentAdditionalExportFields = (
  content: Record<string, any>,
  consumed: string[],
  stage?: string,
) => {
  const consumedSet = new Set(consumed);
  const additional = Object.entries(content).filter(([key, value]) => !consumedSet.has(key) && studentExportHasValue(value));
  return additional.length === 0 ? "" : `
    <details class="additional-content">
      <summary>Additional saved content (${additional.length})</summary>
      <div class="answer-grid">${additional.map(([key, value]) => renderStudentExportNode(value, readableStudentExportLabel(key, stage), stage)).join("")}</div>
    </details>`;
};

const renderStudentFeedbackExport = (feedback: Record<string, any> | undefined) => {
  if (!feedback) return "";
  return `<div class="feedback-panel">
    <h4>Teacher feedback</h4>
    ${renderStudentExportAnswer("Formative feedback", feedback.formativeComment, { className: "feedback-block" })}
    ${renderStudentExportAnswer("Summative grade", feedback.grade, { className: "feedback-block" })}
    ${renderStudentExportAnswer("Summative feedback", feedback.comment, { className: "feedback-block" })}
    <p class="meta">Student acknowledged: ${escapeStudentExportHtml(readableStudentExportValue(feedback.studentAcknowledged))} · Updated ${escapeStudentExportHtml(readableStudentExportValue(feedback.updatedAt))}</p>
    ${renderStudentAdditionalExportFields(feedback, ["grade", "comment", "formativeComment", "studentAcknowledged", "updatedAt"], "FEEDBACK")}
  </div>`;
};

const renderStudentStageStatus = (status: "Complete" | "In progress" | "Not started") =>
  `<span class="stage-status ${status.toLowerCase().replaceAll(" ", "-")}">${escapeStudentExportHtml(status)}</span>`;

const renderStudentMapExport = (content: Record<string, any>) => {
  const isNewFormat = "taskUnderstanding" in content
    || "priorKnowledge" in content
    || "knowledgeGaps" in content
    || "enquiryQuestions" in content
    || "researchPlan" in content;
  const fields = isNewFormat
    ? [
      ["Understanding of the task", content.taskUnderstanding, "text"],
      ["What I already know", content.priorKnowledge, "list"],
      ["What I need to find out", content.knowledgeGaps, "list"],
      ["Enquiry questions", content.enquiryQuestions, "ordered-list"],
    ] as const
    : [
      ["What is this task asking you to do?", content.q1, "text"],
      ["What do you already know about this topic?", content.q2, "text"],
      ["What might be difficult about this task?", content.q3, "text"],
      ["Break the task into its component parts.", content.q4, "text"],
      ["Plan your research.", content.q5, "text"],
    ] as const;
  const answers = fields.map(([label, value, kind]) =>
    kind === "list" ? renderStudentExportListAnswer(label, value)
      : kind === "ordered-list" ? renderStudentExportListAnswer(label, value, true)
        : renderStudentExportAnswer(label, value, { valueClassName: "long-answer" }),
  ).join("");
  const unanswered = fields.filter(([, value]) => !studentExportHasValue(value)).map(([label]) => label);
  const planRows = Array.isArray(content.researchPlan)
    ? content.researchPlan.filter(studentExportHasValue)
    : [];
  const plan = planRows.length ? `
    <div class="answer-group">
      <h4 class="answer-label">Research and verification plan</h4>
      <div class="plan-list">${planRows.map((row: any, index: number) => `
        <div class="plan-row">
          <p class="plan-number">${index + 1}</p>
          ${renderStudentExportAnswer("Investigate", row.investigation)}
          ${renderStudentExportListAnswer("Sources", row.sources)}
          ${renderStudentExportAnswer("Planned source or link", row.plannedSource)}
          ${renderStudentExportAnswer("Verify", row.verification)}
          ${renderStudentExportListAnswer("Verification methods", row.verificationSelections)}
          ${renderStudentAdditionalExportFields(row, ["id", "investigation", "sources", "plannedSource", "actualSource", "verification", "verificationSelections"], "MAP")}
        </div>`).join("")}</div>
    </div>` : "";
  const notes = renderStudentExportAnswer("Planning notes", content.notes, { valueClassName: "long-answer" });
  return `<div class="stage-content map-content">
    <div class="answer-grid">${answers}</div>
    ${plan}
    ${notes}
    ${renderStudentUnansweredPrompts(unanswered)}
    ${renderStudentAdditionalExportFields(content, [
      ...(isNewFormat ? ["taskUnderstanding", "priorKnowledge", "knowledgeGaps", "enquiryQuestions", "researchPlan", "notes"] : ["q1", "q2", "q3", "q4", "q5"]),
    ], "MAP")}
  </div>`;
};

const renderStudentTorchExport = (
  messages: any[],
  feedback?: Record<string, any>,
) => {
  const status = messages.length >= 6 ? "Complete" : messages.length > 0 ? "In progress" : "Not started";
  return `<article class="stage-card">
    <div class="stage-heading">
      <div>
        <p class="stage-eyebrow">TORCH</p>
        <h3>${escapeStudentExportHtml(studentExportStageTitles.TORCH)}</h3>
      </div>
      <div class="stage-heading-meta">
        ${renderStudentStageStatus(status)}
        <p class="meta">${messages.length} conversation message${messages.length === 1 ? "" : "s"}</p>
      </div>
    </div>
    <div class="stage-body">
      ${messages.length ? messages.map((message) => {
        const additional = renderStudentAdditionalExportFields(message, ["id", "role", "content", "createdAt", "bloomLevel"]);
        return `<div class="chat-message ${message.role === "user" ? "student" : ""}">
          <p class="meta">${escapeStudentExportHtml(readableStudentExportValue(message.createdAt))} · ${escapeStudentExportHtml(readableStudentExportValue(message.role))}${message.bloomLevel ? ` · Bloom level ${escapeStudentExportHtml(message.bloomLevel)}` : ""}</p>
          <div class="answer-value long-answer">${escapeStudentExportHtml(readableStudentExportValue(message.content))}</div>
          ${additional}
        </div>`;
      }).join("") : '<p class="empty">No TORCH conversation recorded.</p>'}
      ${renderStudentUnansweredPrompts(messages.length < 6 ? ["A guided investigation normally contains at least six messages."] : [])}
      ${renderStudentFeedbackExport(feedback)}
    </div>
  </article>`;
};

const renderStudentResearchSourceExport = (source: Record<string, any>, index: number) => {
  const sourceText = source.actualSource || source.source || source.title || source.url;
  const sourceDetails = source.sourceDetails || source.citation;
  const mapContext = source.mapContext && typeof source.mapContext === "object" ? source.mapContext : null;
  const origin = source.sourceOrigin === "plan" || mapContext
    ? "From my Research Plan"
    : source.sourceOrigin === "teacher" || source.sourceProvenance?.type === "teacher"
      ? "Teacher-provided source"
      : source.sourceOrigin === "during-research" ? "Added during research" : "Origin not recorded";
  const planContent = mapContext ? `
    <details class="planned-context">
      <summary>My original plan</summary>
      <div class="answer-grid">
        ${renderStudentExportAnswer("What to investigate", mapContext.investigation)}
        ${renderStudentExportListAnswer("Planned source types", mapContext.sourceTypes)}
        ${renderStudentExportAnswer("Planned source or link", mapContext.plannedSource)}
        ${renderStudentExportListAnswer("How to verify", mapContext.verificationSelections)}
        ${renderStudentExportAnswer("Verification notes", mapContext.verification)}
        ${renderStudentExportAnswer("Added to Research Log", mapContext.addedAt)}
        ${renderStudentAdditionalExportFields(mapContext, ["investigation", "sourceTypes", "plannedSource", "verificationSelections", "verification", "addedAt"], "MAP")}
      </div>
    </details>` : "";
  const unanswered = [
    ["What they learned", source.findings || source.importantPoints || source.combinedLearning],
    ["Can you trust it?", source.reliability],
    ["How did it affect their thinking?", source.usage],
  ].filter(([, value]) => !studentExportHasValue(value)).map(([label]) => label as string);
  const additional = renderStudentAdditionalExportFields(source, [
    "id", "source", "title", "url", "actualSource", "sourceType", "sourceDetails", "citation",
    "sourceOrigin", "sourceProvenance", "findings", "importantPoints", "combinedLearning",
    "reliability", "trustworthinessSelections", "usage", "effectSelection", "addedAt",
    "isComplete", "mapContext",
  ], "RESEARCH");
  return `<details class="research-source" ${index === 0 ? "open" : ""}>
    <summary>
      <div>
        <p class="source-kicker">Source ${index + 1}</p>
        <p class="source-title">${escapeStudentExportHtml(readableStudentExportValue(sourceText || "Source name not recorded"))}</p>
        <div class="source-badges">
          <span class="badge origin">${escapeStudentExportHtml(origin)}</span>
          <span class="badge ${source.isComplete ? "complete" : "in-progress"}">${source.isComplete ? "Complete" : "In progress"}</span>
        </div>
      </div>
      <span class="review-label">Review source <span aria-hidden="true">↓</span></span>
    </summary>
    <div class="source-body">
      ${renderStudentExportAnswer("Source", sourceText, { valueClassName: "long-answer" })}
      ${renderStudentExportAnswer("Actual source type", source.sourceType)}
      ${renderStudentExportAnswer("How to find this source", sourceDetails, { className: "answer-card source-details", valueClassName: "long-answer" })}
      ${renderStudentExportNode(source.sourceProvenance, "Source provenance", "RESEARCH")}
      ${planContent}
      <div class="research-prompts">
        ${renderStudentExportAnswer("What did they learn?", source.findings, { valueClassName: "long-answer" })}
        ${renderStudentExportAnswer("What did they consider most important?", source.importantPoints, { valueClassName: "long-answer" })}
        ${renderStudentExportAnswer("Combined learning", source.combinedLearning, { valueClassName: "long-answer" })}
        ${renderStudentExportListAnswer("Trustworthiness checks", source.trustworthinessSelections)}
        ${renderStudentExportAnswer("Trustworthiness evaluation", source.reliability, { valueClassName: "long-answer" })}
        ${renderStudentExportAnswer("Effect on thinking", source.effectSelection)}
        ${renderStudentExportAnswer("How it affected their thinking", source.usage, { valueClassName: "long-answer" })}
      </div>
      ${renderStudentExportAnswer("Added to Research Log", source.addedAt)}
      ${renderStudentUnansweredPrompts(unanswered)}
      ${additional}
    </div>
  </details>`;
};

const renderStudentResearchExport = (content: Record<string, any>, feedback?: Record<string, any>) => {
  const sources = Array.isArray(content.entries) ? content.entries.filter((entry: any) => entry && typeof entry === "object") : [];
  const started = sources.some(studentExportHasValue);
  const complete = sources.some((source: any) => studentExportHasValue(source.source || source.title || source.url) && studentExportHasValue(source.findings || source.importantPoints || source.combinedLearning));
  return `<article class="stage-card">
    <div class="stage-heading">
      <div>
        <p class="stage-eyebrow">RESEARCH</p>
        <h3>${escapeStudentExportHtml(studentExportStageTitles.RESEARCH)}</h3>
      </div>
      <div class="stage-heading-meta">
        ${renderStudentStageStatus(complete ? "Complete" : started ? "In progress" : "Not started")}
        <p class="meta">${sources.length} source${sources.length === 1 ? "" : "s"} logged</p>
      </div>
    </div>
    <div class="stage-body">
      ${sources.length ? sources.map(renderStudentResearchSourceExport).join("") : '<p class="empty">No sources logged yet.</p>'}
      ${renderStudentUnansweredPrompts(sources.length === 0 ? ["Add a source to the Research Log."] : [])}
      ${renderStudentAdditionalExportFields(content, ["entries"], "RESEARCH")}
      ${renderStudentFeedbackExport(feedback)}
    </div>
  </article>`;
};

const renderStudentCompassExport = (content: Record<string, any>, feedback?: Record<string, any>) => {
  const prompts = [
    ["Say it in your own words", content.check1],
    ["The strongest challenge to your thinking", content.check2],
    ["Where you are least confident", content.check3],
    ["Is your evidence balanced?", content.check4],
    ["Are you ready to write?", content.check5],
  ] as const;
  const started = prompts.some(([, value]) => studentExportHasValue(value));
  const complete = prompts.every(([, value]) => studentExportHasValue(value));
  return `<article class="stage-card">
    <div class="stage-heading">
      <div><p class="stage-eyebrow">COMPASS</p><h3>${escapeStudentExportHtml(studentExportStageTitles.COMPASS)}</h3></div>
      ${renderStudentStageStatus(complete ? "Complete" : started ? "In progress" : "Not started")}
    </div>
    <div class="stage-body">
      <div class="answer-grid compass-grid">${prompts.map(([label, value]) => renderStudentExportAnswer(label, value, { valueClassName: "long-answer" })).join("")}</div>
      ${renderStudentUnansweredPrompts(prompts.filter(([, value]) => !studentExportHasValue(value)).map(([label]) => label))}
      ${renderStudentAdditionalExportFields(content, ["check1", "check2", "check3", "check4", "check5"], "COMPASS")}
      ${renderStudentFeedbackExport(feedback)}
    </div>
  </article>`;
};

const renderStudentEmbedExport = (content: Record<string, any>, feedback?: Record<string, any>) => {
  const reflections = [
    ["What changed in your understanding?", content.q1],
    ["Where did you do the thinking?", content.q2],
    ["How did AI help your learning?", content.q3],
    ["What did you decide not to trust?", content.q4],
  ] as const;
  const started = studentExportHasValue(content.finalAnswer) || reflections.some(([, value]) => studentExportHasValue(value));
  const complete = studentExportHasValue(content.finalAnswer) && reflections.every(([, value]) => studentExportHasValue(value));
  return `<article class="stage-card">
    <div class="stage-heading">
      <div><p class="stage-eyebrow">Final Answer</p><h3>${escapeStudentExportHtml(studentExportStageTitles.EMBED)}</h3></div>
      ${renderStudentStageStatus(complete ? "Complete" : started ? "In progress" : "Not started")}
    </div>
    <div class="stage-body">
      ${renderStudentExportAnswer("Final answer", content.finalAnswer, { className: "final-answer", valueClassName: "long-answer" })}
      <div class="answer-grid reflection-grid">${reflections.map(([label, value]) => renderStudentExportAnswer(label, value, { valueClassName: "long-answer" })).join("")}</div>
      ${renderStudentUnansweredPrompts([
        ...(!studentExportHasValue(content.finalAnswer) ? ["Final answer"] : []),
        ...reflections.filter(([, value]) => !studentExportHasValue(value)).map(([label]) => label),
      ])}
      ${renderStudentAdditionalExportFields(content, ["finalAnswer", "q1", "q2", "q3", "q4"], "EMBED")}
      ${renderStudentFeedbackExport(feedback)}
    </div>
  </article>`;
};

const studentExportMapStatus = (content: Record<string, any>): "Complete" | "In progress" | "Not started" => {
  const isNewFormat = "taskUnderstanding" in content
    || "priorKnowledge" in content
    || "knowledgeGaps" in content
    || "enquiryQuestions" in content
    || "researchPlan" in content;
  const started = isNewFormat
    ? [content.taskUnderstanding, content.priorKnowledge, content.knowledgeGaps, content.enquiryQuestions, content.researchPlan, content.notes].some(studentExportHasValue)
    : ["q1", "q2", "q3", "q4", "q5"].some((key) => studentExportHasValue(content[key]));
  const complete = isNewFormat
    ? String(content.taskUnderstanding ?? "").trim().length >= 20
      && Array.isArray(content.priorKnowledge) && content.priorKnowledge.filter(studentExportHasValue).length >= 2
      && Array.isArray(content.knowledgeGaps) && content.knowledgeGaps.filter(studentExportHasValue).length >= 3
      && Array.isArray(content.enquiryQuestions) && content.enquiryQuestions.filter(studentExportHasValue).length >= 3
    : ["q1", "q2", "q3", "q4", "q5"].every((key) => studentExportHasValue(content[key]));
  return complete ? "Complete" : started ? "In progress" : "Not started";
};

const renderStudentStageExport = (
  entry: Record<string, any>,
  feedback?: Record<string, any>,
) => {
  const stage = String(entry.stage ?? "Stage");
  const content = entry.contentJson && typeof entry.contentJson === "object"
    ? entry.contentJson as Record<string, any>
    : {};
  if (stage === "RESEARCH") return renderStudentResearchExport(content, feedback);
  if (stage === "COMPASS") return renderStudentCompassExport(content, feedback);
  if (stage === "EMBED") return renderStudentEmbedExport(content, feedback);
  const status = stage === "MAP" ? studentExportMapStatus(content) : studentExportHasValue(content) ? "In progress" : "Not started";
  return `<article class="stage-card">
    <div class="stage-heading">
      <div><p class="stage-eyebrow">${escapeStudentExportHtml(stage)}</p><h3>${escapeStudentExportHtml(studentExportStageTitles[stage] ?? stage)}</h3></div>
      <div class="stage-heading-meta">${renderStudentStageStatus(status)}<p class="meta">Updated ${escapeStudentExportHtml(readableStudentExportValue(entry.updatedAt))} · Stage record ${escapeStudentExportHtml(readableStudentExportValue(entry.id))}</p></div>
    </div>
    <div class="stage-body">${renderStudentMapExport(content)}${renderStudentFeedbackExport(feedback)}</div>
  </article>`;
};

const readableStudentDataExport = (data: unknown) => {
  const exportData = (data && typeof data === "object" ? data : {}) as Record<string, any>;
  const request = exportData.request ?? {};
  const student = exportData.student ?? {};
  const studentClass = student.class ?? {};
  const learningEntries = Array.isArray(exportData.learning?.stageEntries) ? exportData.learning.stageEntries : [];
  const activity = exportData.activity ?? {};
  const activityEntries = Array.isArray(activity.entries)
    ? activity.entries
    : Array.isArray(activity.sessions) ? activity.sessions : [];
  const activitySummary = activity.summary ?? {};
  const feedback = Array.isArray(exportData.feedback) ? exportData.feedback : [];
  const aiConversations = Array.isArray(exportData.aiConversations) ? exportData.aiConversations : [];
  const answerFeedbackAttempts = Array.isArray(exportData.answerFeedbackAttempts) ? exportData.answerFeedbackAttempts : [];
  const field = (label: string, value: unknown) => `
    <div class="field">
      <dt>${escapeStudentExportHtml(label)}</dt>
      <dd>${escapeStudentExportHtml(readableStudentExportValue(value))}</dd>
    </div>`;
  const formatDuration = (seconds: unknown) => {
    const total = typeof seconds === "number" && Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
    const minutes = Math.floor(total / 60);
    const remainingSeconds = total % 60;
    return minutes ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
  };
  const listOrEmpty = (items: unknown[], render: (item: any) => string) =>
    items.length ? items.map(render).join("") : '<p class="empty">None recorded.</p>';
  const feedbackByStage = Object.fromEntries(
    feedback
      .filter((item: any) => item && typeof item.stage === "string")
      .map((item: any) => [item.stage, item]),
  ) as Record<string, Record<string, any>>;
  const stageEntryByStage = Object.fromEntries(
    learningEntries
      .filter((entry: any) => entry && typeof entry.stage === "string")
      .map((entry: any) => [entry.stage, entry]),
  ) as Record<string, Record<string, any>>;
  const climbStages = ["MAP", "TORCH", "RESEARCH", "COMPASS", "EMBED"];

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Student data export — ${escapeStudentExportHtml(student.name || "Student")}</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; background: #f5f5f4; color: #171717; line-height: 1.5; }
      main { max-width: 960px; margin: 0 auto; padding: 40px 20px 64px; }
      header, section { background: #fff; border: 1px solid #e5e5e5; border-radius: 18px; padding: 24px; margin-top: 20px; }
      header { margin-top: 0; border-top: 5px solid #0369a1; }
      h1 { margin: 0 0 6px; font-size: 28px; line-height: 1.2; }
      h2 { margin: 0 0 16px; font-size: 20px; }
      h3 { margin: 0 0 10px; font-size: 16px; }
      p { margin: 8px 0; }
      .intro, .meta, .empty { color: #525252; }
      .meta { font-size: 13px; }
      dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin: 0; }
      .field { min-width: 0; }
      dt { color: #737373; font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
      dd { margin: 3px 0 0; overflow-wrap: anywhere; white-space: pre-wrap; }
      article { border-top: 1px solid #e5e5e5; padding: 16px 0; }
      article:first-of-type { border-top: 0; padding-top: 0; }
      .stage-card { overflow: hidden; padding: 0; border: 1px solid #e5e5e5; border-radius: 16px; background: #fff; }
      .stage-card + .stage-card { margin-top: 16px; }
      .stage-heading { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 20px 22px; border-bottom: 1px solid #e5e5e5; }
      .stage-heading h3 { margin: 0; font-size: 20px; letter-spacing: -.01em; }
      .stage-eyebrow { margin: 0 0 5px; color: #737373; font-size: 11px; font-weight: 700; letter-spacing: .2em; }
      .stage-heading-meta { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 10px; }
      .stage-status { display: inline-flex; align-items: center; border-radius: 999px; padding: 5px 10px; font-size: 11px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; }
      .stage-status.complete { color: #166534; background: #dcfce7; border: 1px solid #bbf7d0; }
      .stage-status.in-progress { color: #92400e; background: #fef3c7; border: 1px solid #fde68a; }
      .stage-status.not-started { color: #737373; background: #f5f5f4; border: 1px solid #e7e5e4; }
      .stage-body { padding: 22px; background: #fafafa; }
      .stage-content { display: grid; gap: 16px; }
      .answer-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
      .answer-group { min-width: 0; }
      .answer-group + .answer-group { margin-top: 16px; }
      .answer-card, .nested-card { min-width: 0; padding: 15px; border: 1px solid #e5e5e5; border-radius: 14px; background: #fff; }
      .nested-card { margin-top: 12px; }
      .answer-label { margin: 0 0 8px; color: #737373; font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
      .answer-value { min-height: 24px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; }
      .long-answer { line-height: 1.65; }
      .answer-list { margin: 0; padding-left: 22px; }
      .answer-list li { margin: 5px 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; }
      .plan-list, .research-prompts { display: grid; gap: 12px; }
      .plan-row { display: grid; grid-template-columns: 30px repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; align-items: start; padding: 14px; border: 1px solid #e5e5e5; border-radius: 14px; background: #fff; }
      .plan-row .answer-card { border: 0; padding: 0; }
      .plan-number { margin: 2px 0 0; color: #737373; font-size: 13px; font-weight: 800; }
      .unanswered-prompts, .additional-content, .planned-context { margin-top: 16px; border: 1px dashed #d4d4d4; border-radius: 12px; background: #fff; }
      .unanswered-prompts summary, .additional-content summary, .planned-context summary { cursor: pointer; list-style: none; padding: 12px 14px; color: #737373; font-size: 13px; font-weight: 700; }
      .unanswered-prompts summary::-webkit-details-marker, .additional-content summary::-webkit-details-marker, .planned-context summary::-webkit-details-marker, .research-source summary::-webkit-details-marker { display: none; }
      .unanswered-prompts summary::before, .additional-content summary::before, .planned-context summary::before { content: "＋"; display: inline-block; margin-right: 7px; color: #a3a3a3; }
      .unanswered-prompts[open] summary::before, .additional-content[open] summary::before, .planned-context[open] summary::before { content: "−"; }
      .unanswered-prompts .answer-list, .additional-content > .answer-grid, .planned-context > .answer-grid { padding: 0 14px 14px; }
      .additional-content > .answer-grid { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
      .chat-message { max-width: 760px; margin: 14px 0; padding: 14px 17px; border: 1px solid #e5e5e5; border-radius: 18px; background: #fff; }
      .chat-message.student { margin-left: auto; border-color: #171717; background: #171717; color: #fff; }
      .chat-message.student .meta { color: #d4d4d4; }
      .research-source { overflow: hidden; margin: 12px 0; border: 1px solid #e5e5e5; border-radius: 14px; background: #fff; }
      .research-source > summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; cursor: pointer; list-style: none; padding: 16px; }
      .research-source > summary::after { content: "⌄"; color: #737373; font-size: 18px; }
      .research-source[open] > summary::after { transform: rotate(180deg); }
      .source-kicker { margin: 0; color: #a3a3a3; font-size: 11px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
      .source-title { margin: 4px 0 8px; color: #262626; font-size: 15px; font-weight: 700; overflow-wrap: anywhere; }
      .source-badges { display: flex; flex-wrap: wrap; gap: 6px; }
      .badge { display: inline-flex; border-radius: 999px; padding: 4px 8px; font-size: 11px; font-weight: 700; }
      .badge.origin { color: #78350f; background: #fef3c7; border: 1px solid #fde68a; }
      .badge.complete { color: #166534; background: #dcfce7; border: 1px solid #bbf7d0; }
      .badge.in-progress { color: #92400e; background: #fffbeb; border: 1px solid #fde68a; }
      .review-label { flex: none; color: #525252; font-size: 12px; font-weight: 700; }
      .source-body { display: grid; gap: 14px; border-top: 1px solid #e5e5e5; padding: 16px; }
      .source-details { border-color: #bae6fd; background: #f0f9ff; }
      .planned-context { margin: 0; border-color: #ddd6fe; background: #faf5ff; }
      .final-answer { border-color: #ddd6fe; background: #f5f3ff; }
      .final-answer .answer-label { color: #7c3aed; }
      .reflection-grid, .compass-grid { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
      .feedback-panel { margin-top: 22px; padding: 20px; border-top: 1px solid #e5e5e5; background: #f5f5f4; }
      .feedback-panel h4 { margin: 0 0 14px; font-size: 15px; }
      .feedback-block { margin-top: 12px; padding: 14px; border: 1px solid #e5e5e5; border-radius: 12px; background: #fff; }
      .message { white-space: pre-wrap; overflow-wrap: anywhere; background: #fafafa; border-radius: 10px; padding: 12px; }
      .excluded { color: #525252; font-size: 13px; }
      @media (max-width: 620px) { main { padding: 20px 12px 40px; } header, section { padding: 16px; border-radius: 14px; } .stage-heading, .research-source > summary { padding: 14px; } .stage-body { padding: 14px; } .plan-row { grid-template-columns: 1fr; } .plan-number { display: none; } .review-label { display: none; } }
      @media print { body { background: #fff; } main { max-width: none; padding: 0; } header, section { border-color: #d4d4d4; break-inside: avoid; } article { break-inside: avoid; } .unanswered-prompts, .additional-content, .planned-context { break-inside: avoid; } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>Student data export</h1>
        <p class="intro">Readable school-scoped copy of the student data included in this request.</p>
        <p class="meta">Generated ${escapeStudentExportHtml(readableStudentExportValue(exportData.generatedAt))} · Export version ${escapeStudentExportHtml(readableStudentExportValue(exportData.exportVersion))}</p>
      </header>

      <section>
        <h2>Request and student</h2>
        <dl>
          ${field("Request ID", request.id)}
          ${field("Request type", request.requestType)}
          ${field("Request status", request.status)}
          ${field("Student name", student.name)}
          ${field("Student record ID", student.id)}
          ${field("Student record created", student.createdAt)}
          ${field("Registration status", student.registrationStatus)}
          ${field("Assessment status", student.lockedAt ? "Locked" : "Open")}
          ${field("Archived at", student.archivedAt)}
          ${field("Retention until", student.retentionUntil)}
          ${field("Class", studentClass.name)}
          ${field("Class ID", studentClass.id)}
          ${field("Subject", studentClass.subject)}
        </dl>
      </section>

      <section>
        <h2>Student climb</h2>
        ${climbStages.map((stage) => stage === "TORCH"
          ? renderStudentTorchExport(aiConversations, feedbackByStage[stage])
          : renderStudentStageExport(
            stageEntryByStage[stage] ?? { stage, id: null, updatedAt: null, contentJson: {} },
            feedbackByStage[stage],
          )).join("")}
      </section>

      <section>
        <h2>Activity</h2>
        <dl>
          ${field("Recorded activity periods", activitySummary.totalSessions)}
          ${field("Total recorded activity", formatDuration(activitySummary.totalSeconds))}
          ${field("Average recorded session", formatDuration(activitySummary.averageSeconds))}
        </dl>
        <div class="answer-grid" style="margin-top: 16px;">
          ${listOrEmpty(activityEntries, (session) => `
          <article>
            <dl>
              ${field("Activity session ID", session.id)}
              ${field("Started", session.startedAt)}
              ${field("Last seen", session.lastSeenAt)}
              ${field("Ended", session.endedAt)}
              ${field("Active stage", session.activeStage)}
              ${field("Session duration", formatDuration(session.durationSeconds))}
              ${field("End reason", session.endReason)}
            </dl>
            <div class="answer-group" style="margin-top: 14px;">
              <h4 class="answer-label">Time spent on each climb stage</h4>
              <div class="answer-grid">
                ${listOrEmpty(Array.isArray(session.pageDurations) ? session.pageDurations : [], (page) => `
                  <div class="answer-card">
                    <div class="answer-label">${escapeStudentExportHtml(page.stage)}</div>
                    <div class="answer-value">${escapeStudentExportHtml(formatDuration(page.durationSeconds))}</div>
                  </div>`)}
              </div>
            </div>
          </article>`)}
        </div>
        ${Array.isArray(activitySummary.pageDurations) && activitySummary.pageDurations.length ? `
          <div class="answer-group" style="margin-top: 16px;">
            <h4 class="answer-label">Total time on each climb stage</h4>
            <div class="answer-grid">
              ${activitySummary.pageDurations.map((page: any) => `
                <div class="answer-card">
                  <div class="answer-label">${escapeStudentExportHtml(page.stage)}</div>
                  <div class="answer-value">${escapeStudentExportHtml(formatDuration(page.durationSeconds))}</div>
                </div>`).join("")}
            </div>
          </div>` : ""}
      </section>

      <section>
        <h2>Overall assessment</h2>
        ${renderStudentFeedbackExport(feedbackByStage.OVERALL) || '<p class="empty">No overall assessment recorded.</p>'}
      </section>

      <section>
        <h2>Final-answer feedback</h2>
        ${listOrEmpty(answerFeedbackAttempts, (attempt) => renderStudentExportNode(attempt, "Feedback attempt"))}
      </section>

      <section>
        <h2>Not included</h2>
        <p class="excluded">${(Array.isArray(exportData.excluded) ? exportData.excluded : []).map((item: unknown) => escapeStudentExportHtml(item)).join(" · ") || "No exclusions recorded."}</p>
      </section>
    </main>
  </body>
</html>`;
};

type SchoolDataRequestProcedureForm = {
  privacyContactName: string;
  privacyContactEmail: string;
  secureTransferMethod: string;
  privacyInformationLink: string;
  safeguardingContactName: string;
  safeguardingContactEmail: string;
  checksCompleted: string[];
  conditionsOrRestrictions: string;
  reviewDate: string;
  finalConfirmation: boolean;
  approvedByName: string;
  approvedByRole: string;
  approvalDate: string;
};
type SchoolDataRequestProcedure = {
  id: number;
  privacyContactName: string;
  privacyContactEmail: string;
  secureTransferMethod: string;
  privacyInformationLink: string;
  safeguardingContactName?: string;
  safeguardingContactEmail?: string;
  checksCompleted?: string[];
  conditionsOrRestrictions?: string;
  reviewDate?: string | null;
  finalConfirmation?: boolean;
  schoolApprovalConfirmed?: boolean;
  approvedByName: string;
  approvedByRole: string;
  approvalDate: string;
  approvedAt: string;
  updatedAt: string;
};

const emptySchoolDataRequestProcedureForm = (): SchoolDataRequestProcedureForm => ({
  privacyContactName: "",
  privacyContactEmail: "",
  secureTransferMethod: "",
  privacyInformationLink: "",
  safeguardingContactName: "",
  safeguardingContactEmail: "",
  checksCompleted: [],
  conditionsOrRestrictions: "",
  reviewDate: "",
  finalConfirmation: false,
  approvedByName: "",
  approvedByRole: "",
  approvalDate: "",
});

const schoolPilotChecks = [
  { value: "dpia", label: "The school has completed and approved its DPIA covering use of the e-Assisted Climb platform." },
  { value: "dpa", label: "The Data Processing Agreement between the school and CIG has been signed." },
  { value: "privacy_information", label: "The school’s privacy information has been updated or confirmed as covering use of the platform." },
  { value: "data_flow_and_security", label: "The school has reviewed the platform’s data flow, retention, deletion, subprocessors and security arrangements." },
  { value: "safeguarding_and_online_safety", label: "The school has completed its safeguarding and online-safety review." },
  { value: "acceptable_use", label: "Appropriate staff and student acceptable-use arrangements are in place." },
  { value: "research_ethics_and_consent", label: "The school has separately confirmed the research ethics, participant-information and consent arrangements required for this pilot." },
] as const;

function schoolDataRequestProcedureFormFromStored(procedure: SchoolDataRequestProcedure): SchoolDataRequestProcedureForm {
  const legacyProcedure = procedure as SchoolDataRequestProcedure & {
    privacyContact?: string;
    secureTransferRoute?: string;
    privacyMaterialsLink?: string;
    finalSchoolApproval?: { approverName?: string; approverRole?: string; approvalDate?: string };
  };
  return {
    privacyContactName: procedure.privacyContactName || legacyProcedure.privacyContact || "",
    privacyContactEmail: procedure.privacyContactEmail || "",
    secureTransferMethod: procedure.secureTransferMethod || legacyProcedure.secureTransferRoute || "",
    privacyInformationLink: procedure.privacyInformationLink || legacyProcedure.privacyMaterialsLink || "",
    safeguardingContactName: procedure.safeguardingContactName || "",
    safeguardingContactEmail: procedure.safeguardingContactEmail || "",
    checksCompleted: Array.isArray(procedure.checksCompleted) ? procedure.checksCompleted : [],
    conditionsOrRestrictions: procedure.conditionsOrRestrictions || "",
    reviewDate: procedure.reviewDate?.slice(0, 10) ?? "",
    finalConfirmation: procedure.finalConfirmation ?? false,
    approvedByName: procedure.approvedByName ?? legacyProcedure.finalSchoolApproval?.approverName ?? "",
    approvedByRole: procedure.approvedByRole ?? legacyProcedure.finalSchoolApproval?.approverRole ?? "",
    approvalDate: procedure.approvalDate ?? legacyProcedure.finalSchoolApproval?.approvalDate ?? procedure.approvedAt?.slice(0, 10) ?? "",
  };
}

const retentionCategories = [
  { value: "student_learning_records", label: "Student learning records" },
  { value: "ai_conversations", label: "AI conversations" },
  { value: "student_activity", label: "Student activity" },
  { value: "completed_climbs", label: "Completed climbs" },
  { value: "teacher_account_records", label: "Teacher account records" },
  { value: "security_audit_logs", label: "Security audit logs" },
];

function formatDeletionRecoveryPeriod(days: number) {
  if (days === 180) return "6-month";
  if (days === 365) return "1-year";
  return `${days}-day`;
}

type SettingsArea = "home" | "teachers" | "privacy" | "records" | "security";

const settingsAreaMeta: Record<Exclude<SettingsArea, "home">, {
  label: string;
  eyebrow: string;
  description: string;
}> = {
  teachers: {
    label: "Manage Teachers",
    eyebrow: "School administration",
    description: "Registration, account access, recovery and teacher departures.",
  },
  privacy: {
    label: "Privacy and Student Data",
    eyebrow: "School governance",
    description: "School approval records and individual Student data requests.",
  },
  records: {
    label: "Archived and Permanently deleted records",
    eyebrow: "Records lifecycle",
    description: "Read-only archives, recovery windows, holds and permanent deletion.",
  },
  security: {
    label: "Platform and Security",
    eyebrow: "Account and platform controls",
    description: "AI, email, evidence, audit, MFA, password and session controls.",
  },
};

function SettingsAreaCard({
  icon: Icon,
  title,
  description,
  status,
  actionLabel,
  onClick,
  tone = "neutral",
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  status: string;
  actionLabel: "Manage" | "View";
  onClick: () => void;
  tone?: "neutral" | "blue" | "amber" | "green";
}) {
  const toneClasses = {
    neutral: "border-neutral-200 bg-white hover:border-neutral-400",
    blue: "border-sky-200 bg-sky-50/40 hover:border-sky-400",
    amber: "border-amber-200 bg-amber-50/40 hover:border-amber-400",
    green: "border-emerald-200 bg-emerald-50/30 hover:border-emerald-400",
  }[tone];
  const iconClasses = {
    neutral: "bg-neutral-900 text-white",
    blue: "bg-sky-700 text-white",
    amber: "bg-amber-700 text-white",
    green: "bg-emerald-700 text-white",
  }[tone];

  return (
    <article className={`flex min-h-[220px] flex-col rounded-[1.75rem] border p-6 shadow-sm transition-colors ${toneClasses}`}>
      <div className="flex items-start justify-between gap-4">
        <span className={`flex h-11 w-11 items-center justify-center rounded-2xl ${iconClasses}`}>
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <span className="rounded-full bg-white/80 px-3 py-1 text-xs font-medium text-neutral-600 shadow-sm">
          {status}
        </span>
      </div>
      <div className="mt-6">
        <h2 className="text-lg font-semibold tracking-tight text-neutral-950">{title}</h2>
        <p className="mt-2 text-sm leading-6 text-neutral-600">{description}</p>
      </div>
      <button
        type="button"
        onClick={onClick}
        className="mt-auto flex items-center gap-2 pt-6 text-sm font-semibold text-neutral-900 transition-colors hover:text-sky-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2"
      >
        {actionLabel}
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </button>
    </article>
  );
}

export default function TeacherSettings() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [teacher, setTeacher] = useState<any>(null);
  const [settingsArea, setSettingsArea] = useState<SettingsArea>("home");
  const [aiSettings, setAiSettings] = useState<OrgAiSettings | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiDisableLoading, setAiDisableLoading] = useState(false);
  const [aiForm, setAiForm] = useState({ aiProvider: null as "gemini" | "azure" | null, aiKey: "", azureEndpoint: "" });
  const [aiApprovals, setAiApprovals] = useState({ schoolAuthorised: false, termsAccepted: false, ukProcessingConfirmed: false });
  const [aiCompliance, setAiCompliance] = useState({ policyVersion: "", evidenceReference: "", reviewDate: "" });
  const [showAiForm, setShowAiForm] = useState(false);
  const [retentionPolicies, setRetentionPolicies] = useState<RetentionPolicy[]>([]);
  const [retentionDefaultPolicy, setRetentionDefaultPolicy] = useState<RetentionPolicy | null>(null);
  const [platformRetentionPolicy, setPlatformRetentionPolicy] = useState<PlatformRetentionPolicy>({
    archiveRetentionDays: 30,
    deletionRecoveryDays: 30,
    minimumDays: 1,
    maximumDays: 3650,
    standardChoices: [30, 60, 90, 180, 365],
  });
  const [retentionDefaultForm, setRetentionDefaultForm] = useState({
    retentionDays: "30",
    archiveRetentionDays: "30",
    deletionRecoveryDays: "30",
    applyToExistingArchived: false,
    reviewDate: "",
    deletionStatus: "retained" as RetentionPolicy["deletionStatus"],
    notes: "",
    legalHold: false,
  });
  const [retentionExceptionForm, setRetentionExceptionForm] = useState({
    category: "student_learning_records",
    retentionDays: "30",
    reviewDate: "",
    deletionStatus: "retained" as RetentionPolicy["deletionStatus"],
    notes: "",
    legalHold: false,
  });
  const [retentionSaving, setRetentionSaving] = useState(false);
  const [retentionExceptionFormOpen, setRetentionExceptionFormOpen] = useState(false);
  const [removingRetentionException, setRemovingRetentionException] = useState<string | null>(null);
  const [retentionAction, setRetentionAction] = useState<string | null>(null);
  const [evidenceExporting, setEvidenceExporting] = useState(false);
  const [schoolDataRequestProcedure, setSchoolDataRequestProcedure] = useState<SchoolDataRequestProcedure | null>(null);
  const [schoolDataRequestProcedureForm, setSchoolDataRequestProcedureForm] = useState(emptySchoolDataRequestProcedureForm);
  const [schoolDataRequestProcedureSaving, setSchoolDataRequestProcedureSaving] = useState(false);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [rotatingCode, setRotatingCode] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);

  // IT admin: teacher list
  const [orgTeachers, setOrgTeachers] = useState<OrgTeacher[]>([]);
  const [teacherDirectoryFilters, setTeacherDirectoryFilters] = useState<TeacherDirectoryFilters>({
    q: "",
    status: "active",
    approvalStatus: "approved",
    from: "",
    to: "",
    sort: "name",
    direction: "asc",
    page: 1,
  });
  const [teacherDirectoryFiltersOpen, setTeacherDirectoryFiltersOpen] = useState(false);
  const [showTeacherDirectoryResults, setShowTeacherDirectoryResults] = useState(false);
  const [teacherDirectoryTotal, setTeacherDirectoryTotal] = useState(0);
  const [teacherDirectoryTotalPages, setTeacherDirectoryTotalPages] = useState(1);
  const [pendingTeacherCount, setPendingTeacherCount] = useState(0);
  const [teacherDirectoryCounts, setTeacherDirectoryCounts] = useState({
    active: 0,
    suspended: 0,
    pending: 0,
    deleted: 0,
    all: 0,
  });
  const [teacherDirectoryLoading, setTeacherDirectoryLoading] = useState(false);
  const [teacherDirectoryError, setTeacherDirectoryError] = useState<string | null>(null);
  const [resetLinks, setResetLinks] = useState<Record<number, string>>({});
  const [generatingReset, setGeneratingReset] = useState<number | null>(null);
  const [unlocking, setUnlocking] = useState<number | null>(null);
  const [resettingMfa, setResettingMfa] = useState<number | null>(null);
  const [togglingAdmin, setTogglingAdmin] = useState<number | null>(null);
  const [safeguardingReviewerSaving, setSafeguardingReviewerSaving] = useState<number | null>(null);
  const [safeguardingReviewerConfirming, setSafeguardingReviewerConfirming] = useState<number | null>(null);
  const [safeguardingReviewerConfirmed, setSafeguardingReviewerConfirmed] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState<number | null>(null);
  const [reviewingApproval, setReviewingApproval] = useState<number | null>(null);
  const [departureSummary, setDepartureSummary] = useState<DepartureSummary | null>(null);
  const [departureLoading, setDepartureLoading] = useState<number | null>(null);
  const [departureSaving, setDepartureSaving] = useState(false);
  const [replacementTeachers, setReplacementTeachers] = useState<OrgTeacher[]>([]);
  const [departureActions, setDepartureActions] = useState<Record<number, DepartureAction>>({});
  const [departureForm, setDepartureForm] = useState({
    reason: "",
  });
  const [transferAssignments, setTransferAssignments] = useState<Record<number, string>>({});
  const [classTransferSummary, setClassTransferSummary] = useState<DepartureSummary | null>(null);
  const [classTransferTeachers, setClassTransferTeachers] = useState<OrgTeacher[]>([]);
  const [classTransferClassId, setClassTransferClassId] = useState("");
  const [classTransferTeacherId, setClassTransferTeacherId] = useState("");
  const [classTransferLoading, setClassTransferLoading] = useState<number | null>(null);
  const [classTransferSaving, setClassTransferSaving] = useState(false);
  const [recordArchives, setRecordArchives] = useState<TeacherRecordArchive[]>([]);
  const [recordArchivesLoading, setRecordArchivesLoading] = useState(false);
  const [recordArchiveSearch, setRecordArchiveSearch] = useState("");
  const [showRecordArchiveResults, setShowRecordArchiveResults] = useState(true);
  const [recordDeletionEvidence, setRecordDeletionEvidence] = useState<TeacherRecordDeletionEvidence[]>([]);
  const [recordDeletionEvidenceLoading, setRecordDeletionEvidenceLoading] = useState(false);
  const [recoverableDeletionRequests, setRecoverableDeletionRequests] = useState<RecoverableDeletionRequests>({ classes: [], studentRecords: [] });
  const [recoverableDeletionRequestsLoading, setRecoverableDeletionRequestsLoading] = useState(false);
  const [restoringRecoverableDeletion, setRestoringRecoverableDeletion] = useState<string | null>(null);
  const [archiveExporting, setArchiveExporting] = useState<number | null>(null);
  const [permanentlyDeletingArchive, setPermanentlyDeletingArchive] = useState<number | null>(null);
  const [recordArchiveDetail, setRecordArchiveDetail] = useState<ArchivedRecordDetail | null>(null);
  const [recordArchiveDetailLoading, setRecordArchiveDetailLoading] = useState<number | null>(null);
  const [archiveClassAssignments, setArchiveClassAssignments] = useState<Record<number, string>>({});
  const [archiveClassAction, setArchiveClassAction] = useState<string | null>(null);
  const [archivedStudentDetail, setArchivedStudentDetail] = useState<ArchivedStudentDetail | null>(null);
  const teacherArchiveRetentionDays = retentionPolicies.find(
    (policy) => policy.dataCategory === "teacher_account_records",
  )?.retentionDays ?? retentionDefaultPolicy?.retentionDays ?? 365;
  const [archivedStudentLoading, setArchivedStudentLoading] = useState<number | null>(null);
  const [archiveAccessRequest, setArchiveAccessRequest] = useState<ArchivedAccessRequest | null>(null);
  const [archiveAccessPurpose, setArchiveAccessPurpose] = useState("");
  const [archiveAccessConfirmed, setArchiveAccessConfirmed] = useState(false);
  const [archiveAccessSubmitting, setArchiveAccessSubmitting] = useState(false);
  const [studentDataRequests, setStudentDataRequests] = useState<StudentDataRequest[]>([]);
  const [studentDataRequestsLoading, setStudentDataRequestsLoading] = useState(false);
  const [studentDataRequestStudents, setStudentDataRequestStudents] = useState<StudentDataRequestStudent[]>([]);
  const [studentDataRequestStudentSearch, setStudentDataRequestStudentSearch] = useState("");
  const [studentDataRequestSelectedStudentLabel, setStudentDataRequestSelectedStudentLabel] = useState("");
  const [studentDataRequestStudentLoading, setStudentDataRequestStudentLoading] = useState(false);
  const [studentDataRequestSaving, setStudentDataRequestSaving] = useState(false);
  const [studentDataRequestUpdating, setStudentDataRequestUpdating] = useState<number | null>(null);
  const [studentDataRequestExporting, setStudentDataRequestExporting] = useState<number | null>(null);
  const [openStudentDataRequestId, setOpenStudentDataRequestId] = useState<number | null>(null);
  const [studentDataRequestControls, setStudentDataRequestControls] = useState<StudentDataRequestControl[]>([]);
  const [studentDataRequestControlsLoading, setStudentDataRequestControlsLoading] = useState(false);
  const [studentDataRequestControlSaving, setStudentDataRequestControlSaving] = useState(false);
  const [studentDataRequestControlAction, setStudentDataRequestControlAction] = useState<number | null>(null);
  const [studentDataRequestControlForm, setStudentDataRequestControlForm] = useState({
    requestId: "",
    kind: "restriction" as StudentDataRequestControl["kind"],
    reasonCategory: "accuracy_dispute" as StudentDataRequestControl["reasonCategory"],
    reasonSummary: "",
    affectedDataCategories: ["learning"] as string[],
    accessLimits: [] as string[],
    processingLimits: ["deletion"] as string[],
    startDate: new Date().toISOString().slice(0, 10),
    reviewDate: "",
    expiryDate: "",
  });
  const [studentDataRequestForm, setStudentDataRequestForm] = useState({
    studentSessionId: "",
    requestType: "access" as StudentDataRequestType,
    reason: "",
    approvalBasis: "",
  });
  const [studentDataRequestUpdates, setStudentDataRequestUpdates] = useState<Record<number, {
    status: StudentDataRequestStatus;
    outcome: string;
    approvalBasis: string;
  }>>({});

  // IT admin: security audit report
  const [auditReport, setAuditReport] = useState<AuditReport | null>(null);
  const [showAuditReport, setShowAuditReport] = useState(false);
  const [auditReportLoading, setAuditReportLoading] = useState(false);
  const [auditReportDownloading, setAuditReportDownloading] = useState(false);
  const [auditReportFilters, setAuditReportFilters] = useState({
    from: "",
    to: "",
    action: "",
    teacherId: "",
  });

  // Change password
  const [cpForm, setCpForm] = useState({ current: "", next: "", confirm: "" });
  const [cpLoading, setCpLoading] = useState(false);
  const [cpSuccess, setCpSuccess] = useState(false);
  const [hibpWarning, setHibpWarning] = useState<string | null>(null);
  const [acceptHibpWarning, setAcceptHibpWarning] = useState(false);

  // IT admin: SMTP / email status
  const [smtpConfigured, setSmtpConfigured] = useState<boolean | null>(null);
  const [testEmailSending, setTestEmailSending] = useState(false);
  const [testEmailResult, setTestEmailResult] = useState<{ ok: boolean; message: string } | null>(null);

  // IT admin: email domain allowlist
  const [allowedDomains, setAllowedDomains] = useState<string[]>([]);
  const [domainsLoaded, setDomainsLoaded] = useState(false);
  const [newDomain, setNewDomain] = useState("");
  const [domainError, setDomainError] = useState("");
  const [savingDomains, setSavingDomains] = useState(false);

  const teacherDirectoryUrl = (filters: TeacherDirectoryFilters) => {
    const params = new URLSearchParams({
      status: filters.status,
      approvalStatus: filters.approvalStatus,
      sort: filters.sort,
      direction: filters.direction,
      page: String(filters.page),
      pageSize: "25",
    });
    if (filters.q.trim()) params.set("q", filters.q.trim());
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    return `/teacher/org/teachers?${params.toString()}`;
  };

  const loadTeacherDirectory = async (filters = teacherDirectoryFilters) => {
    setTeacherDirectoryLoading(true);
    setTeacherDirectoryError(null);
    try {
      const data = await apiFetch(teacherDirectoryUrl(filters));
      const items = Array.isArray(data) ? data : data.items;
      setOrgTeachers(Array.isArray(items) ? items : []);
      setTeacherDirectoryTotal(Array.isArray(data) ? items.length : data.total);
      setTeacherDirectoryTotalPages(Array.isArray(data) ? 1 : data.totalPages);
    } catch (err: any) {
      setTeacherDirectoryError(err.message ?? "Teacher accounts could not be loaded.");
      throw err;
    } finally {
      setTeacherDirectoryLoading(false);
    }
  };

  const loadPendingTeacherCount = async () => {
    try {
      const data = await apiFetch("/teacher/org/teachers?status=active&approvalStatus=pending&page=1&pageSize=1");
      setPendingTeacherCount(Array.isArray(data) ? data.length : data.total);
    } catch {
      // The directory request below still reports any actionable loading error.
    }
  };

  const loadTeacherDirectoryCounts = async () => {
    const count = async (
      status: TeacherDirectoryFilters["status"],
      approvalStatus: TeacherDirectoryFilters["approvalStatus"],
    ) => {
      const data = await apiFetch(`/teacher/org/teachers?status=${status}&approvalStatus=${approvalStatus}&page=1&pageSize=1`);
      return Array.isArray(data) ? data.length : Number(data.total ?? 0);
    };
    try {
      const [active, suspended, pending, deleted, all] = await Promise.all([
        count("active", "approved"),
        count("suspended", "all"),
        count("active", "pending"),
        count("deleted", "all"),
        count("all", "all"),
      ]);
      setTeacherDirectoryCounts({ active, suspended, pending, deleted, all });
      setPendingTeacherCount(pending);
    } catch {
      // The directory request still reports any actionable loading error.
    }
  };

  const selectTeacherDirectoryView = (view: TeacherDirectoryView) => {
    const next: TeacherDirectoryFilters = {
      ...teacherDirectoryFilters,
      q: "",
      status: view === "pending" ? "active" : view,
      approvalStatus: view === "pending" ? "pending" : view === "active" ? "approved" : "all",
      page: 1,
    };
    setTeacherDirectoryFilters(next);
    setShowTeacherDirectoryResults(true);
    loadTeacherDirectory(next).catch(() => undefined);
  };

  const loadRecordArchives = async () => {
    setRecordArchivesLoading(true);
    try {
      const data = await apiFetch("/teacher/org/record-archives");
      setRecordArchives(Array.isArray(data) ? data : data.items ?? []);
    } catch (err: any) {
      toast({ title: "Archived records could not be loaded", description: err.message, variant: "destructive" });
    } finally {
      setRecordArchivesLoading(false);
    }
  };

  const loadRecoverableDeletionRequests = async () => {
    setRecoverableDeletionRequestsLoading(true);
    try {
      const data = await apiFetch("/teacher/org/deletion-requests");
      setRecoverableDeletionRequests({
        classes: Array.isArray(data?.classes) ? data.classes : [],
        studentRecords: Array.isArray(data?.studentRecords) ? data.studentRecords : [],
      });
    } catch (err: any) {
      toast({ title: "Pending deletions could not be loaded", description: err.message, variant: "destructive" });
    } finally {
      setRecoverableDeletionRequestsLoading(false);
    }
  };

  const loadRecordDeletionEvidence = async () => {
    setRecordDeletionEvidenceLoading(true);
    try {
      const data = await apiFetch("/teacher/org/record-archives/deletion-evidence");
      setRecordDeletionEvidence(Array.isArray(data) ? data : data.items ?? []);
    } catch (err: any) {
      toast({ title: "Final deletion evidence could not be loaded", description: err.message, variant: "destructive" });
    } finally {
      setRecordDeletionEvidenceLoading(false);
    }
  };

  const loadStudentDataRequests = async () => {
    setStudentDataRequestsLoading(true);
    try {
      const data = await apiFetch("/teacher/org/student-data-requests");
      const items = Array.isArray(data) ? data : data.items ?? [];
      setStudentDataRequests(items);
      setStudentDataRequestUpdates(Object.fromEntries(
        items.map((request: StudentDataRequest) => [request.id, {
          status: request.status,
          outcome: request.outcome ?? "",
          approvalBasis: request.approvalBasis ?? "",
        }]),
      ));
    } catch (err: any) {
      toast({ title: "Student data requests could not be loaded", description: err.message, variant: "destructive" });
    } finally {
      setStudentDataRequestsLoading(false);
    }
  };

  const loadStudentDataRequestStudents = async (query = studentDataRequestStudentSearch) => {
    setStudentDataRequestStudentLoading(true);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      const data = await apiFetch(`/teacher/org/student-data-request-students${params.size ? `?${params}` : ""}`);
      setStudentDataRequestStudents(Array.isArray(data) ? data : data.items ?? []);
    } catch (err: any) {
      toast({ title: "Student search could not be completed", description: err.message, variant: "destructive" });
    } finally {
      setStudentDataRequestStudentLoading(false);
    }
  };

  const loadStudentDataRequestControls = async () => {
    setStudentDataRequestControlsLoading(true);
    try {
      const data = await apiFetch("/teacher/org/student-data-request-controls");
      setStudentDataRequestControls(data.items ?? []);
    } catch (err: any) {
      toast({ title: "Restriction and hold evidence could not be loaded", description: err.message, variant: "destructive" });
    } finally {
      setStudentDataRequestControlsLoading(false);
    }
  };

  const selectStudentDataRequestStudent = (student: StudentDataRequestStudent) => {
    setStudentDataRequestForm((current) => ({ ...current, studentSessionId: String(student.id) }));
    setStudentDataRequestSelectedStudentLabel(
      `${student.studentName} — ${student.className}${student.classArchivedAt ? " (archived class)" : ""}`,
    );
    setStudentDataRequestStudentSearch(student.studentName);
    setStudentDataRequestStudents([]);
  };

  const handleCreateStudentDataRequest = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!studentDataRequestForm.studentSessionId) {
      toast({ title: "Choose the student this request concerns", variant: "destructive" });
      return;
    }
    const approvalBasis = studentDataRequestForm.approvalBasis.trim();
    if (studentDataRequestForm.requestType !== "access" && !approvalBasis) {
      toast({
        title: "School approval or reason is required",
        description: "Record who approved this action or why the information must be corrected, deleted or retained.",
        variant: "destructive",
      });
      return;
    }
    setStudentDataRequestSaving(true);
    try {
      await apiFetch("/teacher/org/student-data-requests", {
        method: "POST",
        body: JSON.stringify({
          studentSessionId: Number(studentDataRequestForm.studentSessionId),
          requestType: studentDataRequestForm.requestType,
          reason: studentDataRequestForm.reason,
          approvalBasis: approvalBasis || undefined,
        }),
      });
      setStudentDataRequestForm({
        studentSessionId: "",
        requestType: "access",
        reason: "",
        approvalBasis: "",
      });
      setStudentDataRequestStudentSearch("");
      setStudentDataRequestSelectedStudentLabel("");
      setStudentDataRequestStudents([]);
      await loadStudentDataRequests();
      toast({ title: "Student data request recorded", description: "The request and its audit entry have been saved." });
    } catch (err: any) {
      toast({ title: "Student data request could not be saved", description: err.message, variant: "destructive" });
    } finally {
      setStudentDataRequestSaving(false);
    }
  };

  const handleUpdateStudentDataRequest = async (request: StudentDataRequest) => {
    const update = studentDataRequestUpdates[request.id] ?? {
      status: request.status,
      outcome: request.outcome ?? "",
      approvalBasis: request.approvalBasis ?? "",
    };
    const terminal = ["completed", "refused", "escalated"].includes(update.status);
    if (terminal && !update.outcome.trim()) {
      toast({ title: "Outcome required", description: "Completed, refused, and escalated requests need a recorded outcome.", variant: "destructive" });
      return;
    }
    setStudentDataRequestUpdating(request.id);
    try {
      await apiFetch(`/teacher/org/student-data-requests/${request.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: update.status,
          outcome: update.outcome.trim() || undefined,
          approvalBasis: update.approvalBasis.trim() || undefined,
        }),
      });
      await loadStudentDataRequests();
      toast({ title: "Student data request updated" });
    } catch (err: any) {
      toast({ title: "Student data request could not be updated", description: err.message, variant: "destructive" });
    } finally {
      setStudentDataRequestUpdating(null);
    }
  };

  const handleExportStudentDataRequest = async (request: StudentDataRequest, format: "readable" | "data") => {
    setStudentDataRequestExporting(request.id);
    try {
      const exportId = crypto.randomUUID();
      const path = `/teacher/org/student-data-requests/${request.id}/export?format=${format}&exportId=${exportId}`;
      const blob = format === "readable"
        ? await apiFetchBlob(path)
        : new Blob([JSON.stringify(await apiFetch(path), null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = format === "readable"
        ? `student-record-${request.id}.pdf`
        : `student-data-request-${request.id}.json`;
      link.click();
      URL.revokeObjectURL(url);
      await loadStudentDataRequests();
      toast({
        title: format === "readable" ? "Readable student record downloaded" : "Student data files downloaded",
        description: "This school-scoped export has been recorded in the audit history.",
      });
    } catch (err: any) {
      toast({ title: "Student data export could not be prepared", description: err.message, variant: "destructive" });
    } finally {
      setStudentDataRequestExporting(null);
    }
  };

  const handleCreateStudentDataRequestControl = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!studentDataRequestControlForm.requestId || !studentDataRequestControlForm.reviewDate) {
      toast({ title: "Request and review date are required", variant: "destructive" });
      return;
    }
    setStudentDataRequestControlSaving(true);
    try {
      await apiFetch(`/teacher/org/student-data-requests/${studentDataRequestControlForm.requestId}/controls`, {
        method: "POST",
        body: JSON.stringify({
          ...studentDataRequestControlForm,
          requestId: undefined,
          expiryDate: studentDataRequestControlForm.expiryDate || null,
        }),
      });
      setStudentDataRequestControlForm((current) => ({
        ...current,
        requestId: "",
        reasonSummary: "",
        reviewDate: "",
        expiryDate: "",
      }));
      await loadStudentDataRequestControls();
      toast({ title: "Request control applied", description: "The control, event, and audit evidence were recorded together." });
    } catch (err: any) {
      toast({ title: "Request control could not be applied", description: err.message, variant: "destructive" });
    } finally {
      setStudentDataRequestControlSaving(false);
    }
  };

  const handleStudentDataRequestControlAction = async (
    control: StudentDataRequestControl,
    action: "review" | "expire" | "lift",
  ) => {
    if (!control.requestId) return;
    const note = window.prompt(
      action === "review"
        ? "Record the review outcome without student content or safeguarding narrative."
        : `Record why this control is being ${action === "expire" ? "confirmed expired" : "lifted"}.`,
    );
    if (!note?.trim()) return;
    setStudentDataRequestControlAction(control.id);
    try {
      await apiFetch(`/teacher/org/student-data-requests/${control.requestId}/controls/${control.id}`, {
        method: "PATCH",
        body: JSON.stringify({ action, note: note.trim() }),
      });
      await loadStudentDataRequestControls();
      toast({ title: action === "review" ? "Review recorded" : action === "expire" ? "Expiry confirmed" : "Control lifted" });
    } catch (err: any) {
      toast({ title: "Control action could not be recorded", description: err.message, variant: "destructive" });
    } finally {
      setStudentDataRequestControlAction(null);
    }
  };

  const handleViewArchivedRecords = async (archive: TeacherRecordArchive) => {
    setRecordArchiveDetailLoading(archive.id);
    setArchivedStudentDetail(null);
    try {
      const detail = await apiFetch(`/teacher/org/record-archives/${archive.id}`);
      setRecordArchiveDetail(detail);
      setArchiveClassAssignments(
        Object.fromEntries((detail.classes ?? []).map((cls: ArchivedClassRecord) => [cls.id, ""])),
      );
    } catch (err: any) {
      toast({ title: "Archived records could not be opened", description: err.message, variant: "destructive" });
    } finally {
      setRecordArchiveDetailLoading(null);
    }
  };

  const refreshArchiveDetail = async (archiveId: number) => {
    const detail = await apiFetch(`/teacher/org/record-archives/${archiveId}`);
    setRecordArchiveDetail(detail);
    setArchiveClassAssignments(
      Object.fromEntries((detail.classes ?? []).map((cls: ArchivedClassRecord) => [cls.id, ""])),
    );
  };

  const restoreArchivedClass = async (archive: ArchivedRecordDetail, cls: ArchivedClassRecord) => {
    const replacementTeacherId = archiveClassAssignments[cls.id];
    if (!replacementTeacherId) {
      toast({ title: "Choose a destination teacher", variant: "destructive" });
      return;
    }
    const actionKey = `restore-${cls.id}`;
    setArchiveClassAction(actionKey);
    try {
      await apiFetch(`/teacher/org/record-archives/${archive.id}/classes/${cls.id}/action`, {
        method: "POST",
        body: JSON.stringify({ action: "restore", teacherId: Number(replacementTeacherId) }),
      });
      await Promise.all([loadRecordArchives(), loadTeacherDirectory()]);
      if (archive.classes.length > 1) {
        await refreshArchiveDetail(archive.id);
      } else {
        setRecordArchiveDetail(null);
      }
      toast({ title: "Archived class restored", description: `${cls.name} is assigned to its selected destination teacher.` });
    } catch (err: any) {
      toast({ title: "Archived class could not be restored", description: err.message, variant: "destructive" });
    } finally {
      setArchiveClassAction(null);
    }
  };

  const scheduleArchivedClassDeletion = async (archive: ArchivedRecordDetail, cls: ArchivedClassRecord) => {
    if (!window.confirm(`Schedule ${cls.name} for permanent application-record deletion? It will remain recoverable for ${platformRetentionPolicy.deletionRecoveryDays || 30} days, until the displayed deadline.`)) return;
    const actionKey = `delete-${cls.id}`;
    setArchiveClassAction(actionKey);
    try {
      await apiFetch(`/teacher/org/record-archives/${archive.id}/classes/${cls.id}/action`, {
        method: "POST",
        body: JSON.stringify({ action: "schedule-deletion", confirmation: "DELETE" }),
      });
      await Promise.all([loadRecordArchives(), loadRecoverableDeletionRequests(), loadTeacherDirectory(), refreshArchiveDetail(archive.id)]);
      toast({ title: "Class deletion scheduled", description: `The class can be recovered for ${platformRetentionPolicy.deletionRecoveryDays || 30} days before permanent application-record deletion.` });
    } catch (err: any) {
      toast({ title: "Class deletion could not be scheduled", description: err.message, variant: "destructive" });
    } finally {
      setArchiveClassAction(null);
    }
  };

  const runRecordArchiveSearch = (event: React.FormEvent) => {
    event.preventDefault();
    setShowRecordArchiveResults(true);
  };

  const showAllRecordArchives = () => {
    setRecordArchiveSearch("");
    setShowRecordArchiveResults(true);
  };

  const requestArchivedStudentAccess = (archive: ArchivedRecordDetail, cls: ArchivedClassRecord, student: ArchivedStudentReference) => {
    setArchiveAccessPurpose("");
    setArchiveAccessConfirmed(false);
    setArchiveAccessRequest({ type: "student", archive, cls, student });
  };

  const handleSubmitArchiveAccess = async (event: React.FormEvent) => {
    event.preventDefault();
    const request = archiveAccessRequest;
    if (!request) return;
    setArchiveAccessSubmitting(true);
    try {
      const accessBody = JSON.stringify({
        purpose: archiveAccessPurpose.trim(),
        confirmation: archiveAccessConfirmed,
      });
      if (request.type === "student") {
        setArchivedStudentLoading(request.student.id);
        const detail = await apiFetch(`/teacher/org/record-archives/${request.archive.id}/classes/${request.cls.id}/students/${request.student.id}`, {
          method: "POST",
          body: accessBody,
        });
        setArchivedStudentDetail(detail);
        setArchiveAccessRequest(null);
      } else {
        setArchiveExporting(request.archive.id);
        const data = await apiFetch(`/teacher/org/record-archives/${request.archive.id}/export`, {
          method: "POST",
          body: accessBody,
        });
        const file = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(file);
        const link = document.createElement("a");
        link.href = url;
        link.download = `archived-teacher-records-${request.archive.id}.json`;
        link.click();
        URL.revokeObjectURL(url);
        setArchiveAccessRequest(null);
        toast({ title: "Archived records downloaded", description: "This detailed school-scoped download has been recorded in the audit log." });
      }
    } catch (err: any) {
      toast({
        title: request.type === "student" ? "Student record could not be opened" : "Archived records could not be downloaded",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setArchivedStudentLoading(null);
      setArchiveExporting(null);
      setArchiveAccessSubmitting(false);
    }
  };

  useEffect(() => {
    apiFetch("/auth/me")
      .then((t) => {
        setTeacher(t);
        if (t.schoolAdminRole === "master") {
          return Promise.all([
            apiFetch("/teacher/org/ai-settings").then(setAiSettings).catch(() => null),
            apiFetch("/teacher/org/data-request-procedure").then((data) => {
              const procedure = data.procedure as SchoolDataRequestProcedure | null;
              setSchoolDataRequestProcedure(procedure);
              if (procedure) {
                 setSchoolDataRequestProcedureForm(schoolDataRequestProcedureFormFromStored(procedure));
              }
            }).catch(() => null),
            apiFetch("/teacher/org/retention-policy").then((data) => {
              const defaultPolicy = data.defaultPolicy as RetentionPolicy | null;
              setRetentionDefaultPolicy(defaultPolicy);
              setRetentionPolicies(data.exceptions ?? []);
              if (data.platformPolicy) setPlatformRetentionPolicy(data.platformPolicy);
              if (defaultPolicy) {
                const archiveDays = defaultPolicy.archiveRetentionDays ?? defaultPolicy.retentionDays;
                setRetentionDefaultForm({
                  retentionDays: String(defaultPolicy.retentionDays),
                  archiveRetentionDays: String(archiveDays),
                  deletionRecoveryDays: String(defaultPolicy.deletionRecoveryDays ?? 30),
                  applyToExistingArchived: false,
                  reviewDate: defaultPolicy.reviewDate.slice(0, 10),
                  deletionStatus: defaultPolicy.deletionStatus,
                  notes: defaultPolicy.notes ?? "",
                  legalHold: defaultPolicy.legalHold,
                });
              } else {
                const archiveDays = data.platformPolicy?.archiveRetentionDays ?? 30;
                setRetentionDefaultForm((current) => ({
                  ...current,
                  retentionDays: String(archiveDays),
                  archiveRetentionDays: String(archiveDays),
                  deletionRecoveryDays: String(data.platformPolicy?.deletionRecoveryDays ?? 30),
                }));
              }
            }).catch(() => null),
            apiFetch("/teacher/org/invite-code").then((d: any) => setInviteCode(d.inviteCode)).catch(() => null),
            loadTeacherDirectory().catch(() => null),
            loadTeacherDirectoryCounts(),
            loadRecordArchives(),
            loadRecordDeletionEvidence(),
            loadRecoverableDeletionRequests(),
            loadStudentDataRequests(),
            loadStudentDataRequestStudents(""),
            loadStudentDataRequestControls(),
            apiFetch("/teacher/org/email-domains").then((d: any) => { setAllowedDomains(d.allowedEmailDomains ?? []); setDomainsLoaded(true); }).catch(() => null),
            apiFetch("/auth/email-status").then((d: any) => setSmtpConfigured(d.configured)).catch(() => null),
          ]).then(() => undefined);
        }
        if (t.schoolAdminRole === "subadmin") {
          return Promise.all([
            loadTeacherDirectory().catch(() => undefined),
            loadTeacherDirectoryCounts(),
          ]).then(() => undefined);
        }
        return null;
      })
      .catch(() => setLocation("/teacher/login"))
      .finally(() => setLoading(false));
  }, [setLocation]);

  const persistAllowedDomains = async (domains: string[], successTitle: string) => {
    setSavingDomains(true);
    try {
      const result = await apiFetch("/teacher/org/email-domains", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedEmailDomains: domains }),
      });
      setAllowedDomains(result.allowedEmailDomains ?? []);
      toast({ title: successTitle });
      return true;
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
      return false;
    } finally {
      setSavingDomains(false);
    }
  };

  const handleAddDomain = async () => {
    const raw = newDomain.trim().toLowerCase().replace(/^@/, "");
    if (!raw) return;
    if (!/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(raw)) {
      setDomainError("Enter a valid domain, e.g. school.edu.au");
      return;
    }
    if (allowedDomains.includes(raw)) {
      setDomainError("Domain already in the list");
      return;
    }
    const saved = await persistAllowedDomains([...allowedDomains, raw], "Domain added");
    if (saved) {
      setNewDomain("");
      setDomainError("");
    }
  };

  const handleRemoveDomain = async (domain: string) => {
    await persistAllowedDomains(allowedDomains.filter((d) => d !== domain), "Domain removed");
  };

  const handleCopyCode = () => {
    if (!inviteCode) return;
    navigator.clipboard.writeText(inviteCode);
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 2000);
  };

  const handleRotateCode = async () => {
    if (!confirm("This will invalidate the current invite code. Teachers who haven't registered yet will need the new code. Continue?")) return;
    setRotatingCode(true);
    try {
      const result = await apiFetch("/teacher/org/invite-code/rotate", { method: "POST" });
      setInviteCode(result.inviteCode);
      toast({ title: "Invite code rotated" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setRotatingCode(false);
    }
  };

  const handleSignOut = async () => {
    try { await apiFetch("/auth/logout", { method: "POST" }); } catch {}
    clearTeacherToken();
    setLocation("/");
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cpForm.next !== cpForm.confirm) {
      toast({ title: "Passwords don't match", variant: "destructive" });
      return;
    }
    setCpLoading(true);
    setCpSuccess(false);
    try {
      const result = await apiFetch("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: cpForm.current,
          newPassword: cpForm.next,
          acceptHibpWarning,
        }),
      });
      setCpSuccess(true);
      setCpForm({ current: "", next: "", confirm: "" });
      clearTeacherToken();
      toast({
        title: "Password updated",
        description: result?.warning
          ? "Password updated. The breach check was unavailable, so choose a different password if you are unsure this one is unique."
          : "For your security, sign in again with your new password.",
      });
      setLocation("/teacher/login");
    } catch (err: any) {
      if (err.code === "HIBP_UNAVAILABLE") {
        setHibpWarning(err.warning ?? err.message);
        setAcceptHibpWarning(false);
        return;
      }
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setCpLoading(false);
    }
  };

  const clearAiDraft = () => {
    setAiForm({ aiProvider: null, aiKey: "", azureEndpoint: "" });
    setAiApprovals({ schoolAuthorised: false, termsAccepted: false, ukProcessingConfirmed: false });
    setAiCompliance({ policyVersion: "", evidenceReference: "", reviewDate: "" });
  };

  const handleSaveAiSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!aiForm.aiProvider) {
      toast({ title: "Choose an AI provider", description: "Select Google Gemini or Microsoft Azure OpenAI before saving.", variant: "destructive" });
      return;
    }
    setAiLoading(true);
    try {
      const body: any = {
        aiProvider: aiForm.aiProvider,
        aiKey: aiForm.aiKey,
        dataProcessingAcknowledged: aiApprovals.schoolAuthorised,
        dataProcessingRegion: "UK",
        dataProcessingRegionConfirmed: aiApprovals.ukProcessingConfirmed,
        dataRetentionNoTrainingConfirmed: aiApprovals.termsAccepted,
      };
      if (aiCompliance.policyVersion.trim()) body.dataProcessingPolicyVersion = aiCompliance.policyVersion.trim();
      if (aiCompliance.evidenceReference.trim()) body.dataProcessingEvidenceReference = aiCompliance.evidenceReference.trim();
      if (aiCompliance.reviewDate) body.dataProcessingReviewDate = aiCompliance.reviewDate;
      if (aiForm.aiProvider === "azure" && aiForm.azureEndpoint) body.azureEndpoint = aiForm.azureEndpoint;
      await apiFetch("/teacher/org/ai-settings", { method: "PUT", body: JSON.stringify(body) });
      clearAiDraft();
      setShowAiForm(false);
      setAiSettings(await apiFetch("/teacher/org/ai-settings"));
      toast({ title: "AI provider approved and saved" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setAiLoading(false);
    }
  };

  const handleDisableAiSettings = async () => {
    if (!window.confirm(
      "Disable AI connection?\n\n"
      + "The school's AI features will immediately stop working.\n"
      + "The stored API key will be permanently removed from the active database.\n"
      + "This does not revoke the key with Google or Microsoft; revoke it in the provider portal if it should no longer work.\n"
      + "The school will have to enter a new API key and complete all confirmations again to reactivate AI.\n"
      + "Student work and existing learning records will not be deleted.",
    )) {
      return;
    }

    setAiDisableLoading(true);
    try {
      await apiFetch("/teacher/org/ai-settings", {
        method: "DELETE",
        body: JSON.stringify({}),
      });
      clearAiDraft();
      setShowAiForm(false);
      setAiSettings(await apiFetch("/teacher/org/ai-settings"));
      toast({
        title: "AI connection disabled",
        description: "The stored API key was removed. Re-enter a key and complete all confirmations to enable AI again.",
      });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setAiDisableLoading(false);
    }
  };

  const handleSaveSchoolDataRequestProcedure = async (event: React.FormEvent) => {
    event.preventDefault();
    setSchoolDataRequestProcedureSaving(true);
    try {
      const result = await apiFetch("/teacher/org/data-request-procedure", {
        method: "PUT",
        body: JSON.stringify(schoolDataRequestProcedureForm),
      }) as SchoolDataRequestProcedure;
      setSchoolDataRequestProcedure(result);
      setSchoolDataRequestProcedureForm(schoolDataRequestProcedureFormFromStored(result));
      toast({
        title: schoolDataRequestProcedure ? "School approval updated" : "School approval saved",
        description: "The school-scoped approval record was written to the audit history.",
      });
    } catch (err: any) {
      toast({ title: "Unable to publish the procedure", description: err.message, variant: "destructive" });
    } finally {
      setSchoolDataRequestProcedureSaving(false);
    }
  };

  const showAiApprovalForm = () => {
    setAiForm({
      aiProvider: null,
      aiKey: "",
      azureEndpoint: aiSettings?.azureEndpoint ?? "",
    });
    setAiCompliance({
      policyVersion: aiSettings?.dataProcessingPolicyVersion ?? "",
      evidenceReference: aiSettings?.dataProcessingEvidenceReference ?? "",
      reviewDate: aiSettings?.dataProcessingReviewDate?.slice(0, 10) ?? "",
    });
    setAiApprovals({ schoolAuthorised: false, termsAccepted: false, ukProcessingConfirmed: false });
    setShowAiForm(true);
  };

  const handleSaveRetentionDefault = async (event: React.FormEvent) => {
    event.preventDefault();
    if (retentionDefaultForm.applyToExistingArchived && !window.confirm(
      "Apply this retention period to existing archived classes as well? Their archive-expiry dates will be recalculated before the policy is saved.",
    )) return;

    const archiveRetentionDays = Number(retentionDefaultForm.archiveRetentionDays);
    setRetentionSaving(true);
    try {
      const policy = await apiFetch("/teacher/org/retention-policy/default", {
        method: "PUT",
        body: JSON.stringify({
          retentionDays: archiveRetentionDays,
          archiveRetentionDays,
          deletionRecoveryDays: Number(retentionDefaultForm.deletionRecoveryDays),
          applyToExistingArchived: retentionDefaultForm.applyToExistingArchived,
          reviewDate: retentionDefaultForm.reviewDate || new Date().toISOString().slice(0, 10),
          deletionStatus: "retained",
          notes: retentionDefaultForm.notes || undefined,
          legalHold: retentionDefaultForm.legalHold,
        }),
      });
      setRetentionDefaultPolicy(policy);
      const savedArchiveDays = policy.archiveRetentionDays ?? archiveRetentionDays;
      setRetentionDefaultForm((current) => ({
        ...current,
        retentionDays: String(savedArchiveDays),
        archiveRetentionDays: String(savedArchiveDays),
        deletionRecoveryDays: String(policy.deletionRecoveryDays ?? 30),
        applyToExistingArchived: false,
      }));
      toast({ title: "Default retention policy saved" });
    } catch (err: any) {
      toast({ title: "Unable to save default retention policy", description: err.message, variant: "destructive" });
    } finally {
      setRetentionSaving(false);
    }
  };

  const handleSaveRetentionException = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!retentionExceptionForm.notes.trim()) {
      toast({ title: "Exception reason required", description: "Explain why this category needs a different retention rule.", variant: "destructive" });
      return;
    }
    setRetentionSaving(true);
    try {
      const policy = await apiFetch(`/teacher/org/retention-policies/${retentionExceptionForm.category}`, {
        method: "PUT",
        body: JSON.stringify({
          retentionDays: Number(retentionExceptionForm.retentionDays),
          reviewDate: retentionExceptionForm.reviewDate || new Date().toISOString().slice(0, 10),
          deletionStatus: retentionExceptionForm.deletionStatus,
          notes: retentionExceptionForm.notes.trim(),
          legalHold: retentionExceptionForm.legalHold,
        }),
      });
      setRetentionPolicies((existing) => {
        const rest = existing.filter((item) => item.dataCategory !== policy.dataCategory);
        return [...rest, policy].sort((a, b) => a.label.localeCompare(b.label));
      });
      setRetentionExceptionFormOpen(false);
      toast({ title: "Retention exception saved" });
    } catch (err: any) {
      toast({ title: "Unable to save retention exception", description: err.message, variant: "destructive" });
    } finally {
      setRetentionSaving(false);
    }
  };

  const startRetentionException = (policy?: RetentionPolicy) => {
    const source = policy ?? retentionDefaultPolicy;
    setRetentionExceptionForm({
      category: policy?.dataCategory ?? retentionCategories.find((category) => !retentionPolicies.some((item) => item.dataCategory === category.value))?.value ?? retentionCategories[0].value,
      retentionDays: String(source?.retentionDays ?? 365),
      reviewDate: source?.reviewDate.slice(0, 10) ?? "",
      deletionStatus: source?.deletionStatus ?? "retained",
      notes: policy?.notes ?? "",
      legalHold: policy?.legalHold ?? false,
    });
    setRetentionExceptionFormOpen(true);
  };

  const handleRemoveRetentionException = async (policy: RetentionPolicy) => {
    if (!retentionDefaultPolicy) return;
    if (!confirm(`Remove the ${policy.label} exception? This category will use the school-wide default policy. No records will be deleted.`)) return;
    setRemovingRetentionException(policy.dataCategory);
    try {
      await apiFetch(`/teacher/org/retention-policies/${policy.dataCategory}`, { method: "DELETE" });
      setRetentionPolicies((existing) => existing.filter((item) => item.dataCategory !== policy.dataCategory));
      toast({ title: "Retention exception removed", description: `${policy.label} now uses the school-wide default.` });
    } catch (err: any) {
      toast({ title: "Unable to remove retention exception", description: err.message, variant: "destructive" });
    } finally {
      setRemovingRetentionException(null);
    }
  };

  const replaceRetentionPolicy = (policy: RetentionPolicy) => {
    if (policy.dataCategory === "school_wide_default") {
      setRetentionDefaultPolicy(policy);
      return;
    }
    setRetentionPolicies((existing) => existing.map((item) => item.dataCategory === policy.dataCategory ? policy : item));
  };

  const handleVerifyRetentionPolicy = async (policy: RetentionPolicy) => {
    const label = policy.dataCategory === "school_wide_default" ? "default" : policy.dataCategory;
    setRetentionAction(`verify:${policy.dataCategory}`);
    try {
      const endpoint = policy.dataCategory === "school_wide_default"
        ? "/teacher/org/retention-policy/default/verify"
        : `/teacher/org/retention-policies/${policy.dataCategory}/verify`;
      const updated = await apiFetch(endpoint, { method: "POST" }) as RetentionPolicy;
      replaceRetentionPolicy(updated);
      toast({ title: "Retention operator verification recorded" });
    } catch (err: any) {
      toast({ title: "Unable to verify retention policy", description: err.message, variant: "destructive" });
    } finally {
      setRetentionAction(null);
    }
  };

  const handleExportEvidence = async (format: "html" | "json" = "html") => {
    setEvidenceExporting(true);
    try {
      const isReadableReport = format === "html";
      const report = await apiFetch(`/teacher/org/compliance-evidence${isReadableReport ? "?format=html" : ""}`, {
        headers: { Accept: isReadableReport ? "text/html" : "application/json" },
      });
      const file = new Blob(
        [isReadableReport ? report as string : JSON.stringify(report, null, 2)],
        { type: isReadableReport ? "text/html;charset=utf-8" : "application/json" },
      );
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = `assisted-climb-compliance-evidence.${format}`;
      link.click();
      URL.revokeObjectURL(url);
      toast({ title: isReadableReport ? "Readable compliance report downloaded" : "Technical evidence export downloaded" });
    } catch (err: any) {
      toast({ title: "Unable to export evidence", description: err.message, variant: "destructive" });
    } finally {
      setEvidenceExporting(false);
    }
  };

  // IT admin: generate reset link
  const handleGenerateReset = async (teacherId: number) => {
    setGeneratingReset(teacherId);
    try {
      const result = await apiFetch(`/teacher/org/teacher/${teacherId}/request-reset`, { method: "POST" });
      const url = `${window.location.origin}/reset-password?token=${result.resetToken}`;
      setResetLinks((prev) => ({ ...prev, [teacherId]: url }));
      toast({ title: "Reset link generated", description: "Copy the link and share it securely with the teacher." });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setGeneratingReset(null);
    }
  };

  const handleUnlock = async (teacherId: number) => {
    setUnlocking(teacherId);
    try {
      await apiFetch(`/teacher/org/teacher/${teacherId}/unlock`, { method: "POST" });
      setOrgTeachers((prev) => prev.map((t) => t.id === teacherId ? { ...t, failedLoginAttempts: 0, lockedUntil: null } : t));
      toast({ title: "Account unlocked" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setUnlocking(null);
    }
  };

  const handleResetMfa = async (t: OrgTeacher) => {
    if (!window.confirm(
      `Reset ${t.name}'s authenticator? Their current authenticator and recovery codes will stop working, all active sessions will be signed out, and they must enrol a new authenticator before accessing the account again.`,
    )) return;

    setResettingMfa(t.id);
    try {
      await apiFetch(`/teacher/org/teacher/${t.id}/reset-mfa`, { method: "POST" });
      setOrgTeachers((prev) => prev.map((entry) => entry.id === t.id ? { ...entry, totpEnabled: false } : entry));
      toast({
        title: "Authenticator reset",
        description: `${t.name} must enrol a replacement authenticator at their next sign-in.`,
      });
    } catch (err: any) {
      toast({ title: "Unable to reset authenticator", description: err.message, variant: "destructive" });
    } finally {
      setResettingMfa(null);
    }
  };

  const handleToggleAdmin = async (t: OrgTeacher) => {
    setTogglingAdmin(t.id);
    try {
      const schoolAdminRole = t.schoolAdminRole === "subadmin" ? null : "subadmin";
      const result = await apiFetch(`/teacher/org/teacher/${t.id}/set-admin`, {
        method: "PATCH",
        body: JSON.stringify({ schoolAdminRole }),
      });
      setOrgTeachers((prev) => prev.map((o) => o.id === t.id
        ? { ...o, isItAdmin: result.isItAdmin, schoolAdminRole: result.schoolAdminRole }
        : o));
      toast({ title: schoolAdminRole ? "School Sub-admin appointed" : "School Sub-admin removed", description: t.name });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setTogglingAdmin(null);
    }
  };

  const handleSafeguardingReviewerChange = async (t: OrgTeacher, canReviewSafeguarding: boolean) => {
    setSafeguardingReviewerSaving(t.id);
    try {
      await apiFetch(`/teacher/org/teacher/${t.id}/safeguarding-reviewer`, {
        method: "PUT",
        body: JSON.stringify({
          canReviewSafeguarding,
          ...(canReviewSafeguarding
            ? {
                confirmation: "I confirm that this member of staff is authorised by the school to review safeguarding concerns within e-Assisted Climb.",
              }
            : {}),
        }),
      });
      setOrgTeachers((current) => current.map((entry) => (
        entry.id === t.id ? { ...entry, canReviewSafeguarding } : entry
      )));
      setSafeguardingReviewerConfirming(null);
      setSafeguardingReviewerConfirmed(false);
      toast({
        title: canReviewSafeguarding ? "Safeguarding reviewer assigned" : "Reviewer access removed",
        description: t.name,
      });
    } catch (error: any) {
      toast({
        title: "Unable to update safeguarding reviewer access",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setSafeguardingReviewerSaving(null);
    }
  };

  const handleStatusChange = async (t: OrgTeacher, status: "active" | "suspended" | "deleted") => {
    if (status === "deleted") {
      await handleStartDeparture(t);
      return;
    }
    if (status === "suspended") {
      if (!window.confirm(`Suspend ${t.name}'s account? They will be signed out and unable to log in until restored.`)) return;
    } else if (!window.confirm(`Restore ${t.name}'s account and allow them to sign in again?`)) {
      return;
    }

    setUpdatingStatus(t.id);
    try {
      await apiFetch(`/teacher/org/teacher/${t.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      const next = status === "suspended"
        ? {
            ...teacherDirectoryFilters,
            q: "",
            status: "suspended" as const,
            approvalStatus: "all" as const,
            page: 1,
          }
        : teacherDirectoryFilters;
      if (status === "suspended") setSettingsArea("teachers");
      setTeacherDirectoryFilters(next);
      setShowTeacherDirectoryResults(true);
      await Promise.all([loadTeacherDirectory(next), loadTeacherDirectoryCounts()]);
      toast({
        title: status === "suspended" ? "Teacher account suspended" : "Teacher account restored",
        description: status === "suspended" ? "Find this account under Suspended in Teacher Accounts." : undefined,
      });
    } catch (err: any) {
      toast({ title: "Unable to update account", description: err.message, variant: "destructive" });
    } finally {
      setUpdatingStatus(null);
    }
  };

  const handleRestoreDeletedTeacher = async (t: OrgTeacher) => {
    if (t.accountRecoveryEligible === false) return;
    setUpdatingStatus(t.id);
    try {
      await apiFetch(`/teacher/org/teacher/${t.id}/restore`, { method: "POST" });
      const next = { ...teacherDirectoryFilters, status: "deleted" as const, approvalStatus: "all" as const, page: 1 };
      setTeacherDirectoryFilters(next);
      setShowTeacherDirectoryResults(true);
      await Promise.all([loadTeacherDirectory(next), loadTeacherDirectoryCounts(), loadRecordArchives()]);
      toast({ title: "Teacher account restored", description: `${t.name} can sign in again.` });
    } catch (err: any) {
      toast({ title: "Unable to restore teacher account", description: err.message, variant: "destructive" });
    } finally {
      setUpdatingStatus(null);
    }
  };

  const handleApproval = async (t: OrgTeacher, decision: "approve" | "reject") => {
    const reason = decision === "reject" ? window.prompt(`Why is ${t.name}'s registration being rejected?`) : null;
    if (decision === "reject" && !reason?.trim()) return;
    setReviewingApproval(t.id);
    try {
      await apiFetch(`/teacher/org/teacher/${t.id}/${decision}`, {
        method: "POST",
        body: JSON.stringify(decision === "reject" ? { reason: reason!.trim() } : {}),
      });
      await Promise.all([loadTeacherDirectory(), loadTeacherDirectoryCounts()]);
      toast({ title: decision === "approve" ? "Teacher account approved" : "Teacher registration rejected" });
    } catch (err: any) {
      toast({ title: "Unable to review registration", description: err.message, variant: "destructive" });
    } finally {
      setReviewingApproval(null);
    }
  };

  const handleStartDeparture = async (t: OrgTeacher) => {
    setDepartureLoading(t.id);
    try {
      const [summary, teachers] = await Promise.all([
        apiFetch(`/teacher/org/teacher/${t.id}/departure-summary`),
        apiFetch("/teacher/org/teachers?status=active&sort=name&direction=asc&page=1&pageSize=100"),
      ]);
      const items = Array.isArray(teachers) ? teachers : teachers.items ?? [];
      setDepartureSummary(summary);
      setReplacementTeachers(items.filter((entry: OrgTeacher) => entry.id !== t.id && entry.accountStatus === "active"));
      setTransferAssignments(
        Object.fromEntries(
          (summary.classes ?? []).map((cls: DepartureSummary["classes"][number]) => [cls.id, ""]),
        ),
      );
      setDepartureActions(
        Object.fromEntries(
          (summary.classes ?? []).map((cls: DepartureSummary["classes"][number]) => [cls.id, "archive"]),
        ),
      );
      setDepartureForm({
        reason: "",
      });
    } catch (err: any) {
      toast({ title: "Departure options could not be loaded", description: err.message, variant: "destructive" });
    } finally {
      setDepartureLoading(null);
    }
  };

  const handleStartClassTransfer = async (t: OrgTeacher) => {
    setClassTransferLoading(t.id);
    try {
      const [summary, teachers] = await Promise.all([
        apiFetch(`/teacher/org/teacher/${t.id}/departure-summary`),
        apiFetch("/teacher/org/teachers?status=active&sort=name&direction=asc&page=1&pageSize=100"),
      ]);
      const items = Array.isArray(teachers) ? teachers : teachers.items ?? [];
      const activeTeachers = items.filter((entry: OrgTeacher) => entry.id !== t.id && entry.accountStatus === "active");
      setClassTransferSummary(summary);
      setClassTransferTeachers(activeTeachers);
      setClassTransferClassId("");
      setClassTransferTeacherId("");
    } catch (err: any) {
      toast({ title: "Class transfer options could not be loaded", description: err.message, variant: "destructive" });
    } finally {
      setClassTransferLoading(null);
    }
  };

  const handleTransferClass = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!classTransferSummary || !classTransferClassId || !classTransferTeacherId) return;
    const cls = classTransferSummary.classes.find((item) => item.id === Number(classTransferClassId));
    const destination = classTransferTeachers.find((item) => item.id === Number(classTransferTeacherId));
    if (!cls || !destination) return;
    setClassTransferSaving(true);
    try {
      await apiFetch(`/teacher/org/classes/${cls.id}/transfer`, {
        method: "POST",
        body: JSON.stringify({
          replacementTeacherId: Number(classTransferTeacherId),
          confirmation: "TRANSFER CLASS",
        }),
      });
      setClassTransferSummary(null);
      await Promise.all([loadTeacherDirectory(), loadRecordArchives()]);
      toast({ title: "Class transferred", description: `${cls.name} is now assigned to ${destination.name}.` });
    } catch (err: any) {
      toast({ title: "Class could not be transferred", description: err.message, variant: "destructive" });
    } finally {
      setClassTransferSaving(false);
    }
  };

  const handleSaveDeparture = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!departureSummary) return;
    if (departureSummary.classes.some((cls) => !departureActions[cls.id])) {
      toast({ title: "Choose Archive or Transfer for every class", variant: "destructive" });
      return;
    }
    if (
      departureSummary.classes.some((cls) => departureActions[cls.id] === "transfer" && !transferAssignments[cls.id])
    ) {
      toast({ title: "Choose a replacement for every class", variant: "destructive" });
      return;
    }
    const message = `Remove ${departureSummary.teacher.name}'s access and apply the selected action to every listed class?`;
    if (!window.confirm(message)) return;

    setDepartureSaving(true);
    try {
      const body = {
        actions: departureSummary.classes.map((cls) => ({
          classId: cls.id,
          action: departureActions[cls.id],
          ...(departureActions[cls.id] === "transfer"
            ? { replacementTeacherId: Number(transferAssignments[cls.id]) }
            : {}),
        })),
        confirmation: "REMOVE ACCESS",
      };
      const result = await apiFetch(`/teacher/org/teacher/${departureSummary.teacher.id}/departure`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setDepartureSummary(null);
      await Promise.all([loadTeacherDirectory(), loadRecordArchives(), loadRecordDeletionEvidence(), loadRecoverableDeletionRequests()]);
      toast({
        title: "Departure actions saved and access removed",
        description: (result.accountRecoveryUntil ?? result.recoveryUntil)
          ? `Account access removed; recovery is available until ${new Date(result.accountRecoveryUntil ?? result.recoveryUntil).toLocaleDateString("en-GB")}.`
          : "Account access removed; recovery remains available during the platform recovery period.",
      });
    } catch (err: any) {
      toast({ title: "Departure changes could not be saved", description: err.message, variant: "destructive" });
    } finally {
      setDepartureSaving(false);
    }
  };

  const restoreRecoverableDeletion = async (kind: "class" | "student", id: number) => {
    setRestoringRecoverableDeletion(`${kind}-${id}`);
    try {
      await apiFetch(
        kind === "class"
          ? `/teacher/org/deletion-requests/classes/${id}/restore`
          : `/teacher/org/deletion-requests/students/${id}/restore`,
        { method: "POST" },
      );
      await Promise.all([loadRecoverableDeletionRequests(), loadTeacherDirectory()]);
      toast({ title: kind === "class" ? "Class deletion restored" : "Student record deletion restored" });
    } catch (err: any) {
      toast({ title: "Could not restore deletion", description: err.message, variant: "destructive" });
    } finally {
      setRestoringRecoverableDeletion(null);
    }
  };

  const handlePermanentArchiveDelete = async (archive: TeacherRecordArchive) => {
    const confirmation = window.prompt(
      `This permanently removes archived record #${archive.id} from the central application record. This cannot be undone. It does not directly access AWS backups or snapshots.\n\nType PERMANENTLY DELETE to continue.`,
    );
    if (confirmation !== "PERMANENTLY DELETE") return;
    setPermanentlyDeletingArchive(archive.id);
    try {
      const result = await apiFetch(`/teacher/org/record-archives/${archive.id}/permanent-delete`, {
        method: "POST",
        body: JSON.stringify({ confirmation }),
      });
      await Promise.all([loadTeacherDirectory(), loadRecordArchives(), loadRecordDeletionEvidence()]);
      toast({
        title: "Application records permanently deleted",
        description: result.deletionEvidence?.backupStorage?.status === "verified"
          ? "AWS backup/storage lifecycle evidence is verified."
          : "AWS backup/storage expiry remains pending; this application does not claim AWS data is fully erased.",
      });
    } catch (err: any) {
      toast({ title: "Permanent deletion could not be completed", description: err.message, variant: "destructive" });
    } finally {
      setPermanentlyDeletingArchive(null);
    }
  };

  const requestArchivedExport = (archive: TeacherRecordArchive) => {
    setArchiveAccessPurpose("");
    setArchiveAccessConfirmed(false);
    setArchiveAccessRequest({ type: "export", archive });
  };

  const handleTestEmail = async () => {
    setTestEmailSending(true);
    setTestEmailResult(null);
    try {
      await apiFetch("/auth/test-email", { method: "POST" });
      setTestEmailResult({ ok: true, message: `Test email sent to ${teacher?.email}. Check your inbox.` });
    } catch (err: any) {
      setTestEmailResult({ ok: false, message: err.message ?? "Failed to send test email" });
    } finally {
      setTestEmailSending(false);
    }
  };

  const auditReportQuery = () => {
    const params = new URLSearchParams();
    if (auditReportFilters.from) params.set("from", auditReportFilters.from);
    if (auditReportFilters.to) params.set("to", auditReportFilters.to);
    if (auditReportFilters.action) params.set("action", auditReportFilters.action);
    if (auditReportFilters.teacherId) params.set("teacherId", auditReportFilters.teacherId);
    const query = params.toString();
    return query ? `?${query}` : "";
  };

  const runAuditReport = async () => {
    setAuditReportLoading(true);
    try {
      const report = await apiFetch(`/teacher/audit-log/report${auditReportQuery()}`) as AuditReport;
      setAuditReport(report);
    } catch (err: any) {
      toast({ title: "Report could not be prepared", description: err.message, variant: "destructive" });
    } finally {
      setAuditReportLoading(false);
    }
  };

  const runTeacherSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const next = { ...teacherDirectoryFilters, page: 1 };
    setTeacherDirectoryFilters(next);
    setShowTeacherDirectoryResults(true);
    try {
      await loadTeacherDirectory(next);
    } catch (err: any) {
      toast({ title: "Teacher search failed", description: err.message, variant: "destructive" });
    }
  };

  const showAllTeacherAccounts = async () => {
    const next = {
      ...teacherDirectoryFilters,
      q: "",
      status: "all" as const,
      approvalStatus: "all" as const,
      page: 1,
    };
    setTeacherDirectoryFilters(next);
    setShowTeacherDirectoryResults(true);
    try {
      await loadTeacherDirectory(next);
    } catch {
      // loadTeacherDirectory already records the visible directory error.
    }
  };

  const showPendingTeacherAccounts = async () => {
    const next: TeacherDirectoryFilters = {
      ...teacherDirectoryFilters,
      q: "",
      status: "active",
      approvalStatus: "pending",
      page: 1,
    };
    setTeacherDirectoryFilters(next);
    setShowTeacherDirectoryResults(true);
    try {
      await loadTeacherDirectory(next);
    } catch {
      // loadTeacherDirectory already records the visible directory error.
    }
  };

  const updateTeacherDirectoryFilter = <K extends keyof TeacherDirectoryFilters>(
    key: K,
    value: TeacherDirectoryFilters[K],
  ) => {
    setTeacherDirectoryFilters((current) => ({ ...current, [key]: value, page: 1 }));
  };

  const handleToggleAuditReport = async () => {
    if (showAuditReport) {
      setShowAuditReport(false);
      return;
    }
    setShowAuditReport(true);
    await runAuditReport();
  };

  const downloadAuditReport = async () => {
    if (!auditReport?.items.length) return;
    setAuditReportDownloading(true);
    try {
      const csv = await apiFetch(`/teacher/audit-log/report/export${auditReportQuery()}`, {
        headers: { Accept: "text/csv" },
      }) as string;
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "school-security-audit-report.csv";
      link.click();
      URL.revokeObjectURL(url);
      toast({ title: "Security report downloaded", description: "The download has been recorded in the school audit history." });
    } catch (err: any) {
      toast({ title: "Download could not be prepared", description: err.message, variant: "destructive" });
    } finally {
      setAuditReportDownloading(false);
    }
  };

  if (loading) return null;

  const isLocked = (t: OrgTeacher) => t.lockedUntil && new Date(t.lockedUntil) > new Date();
  const isSchoolMaster = teacher?.schoolAdminRole === "master";
  const isSchoolAdmin = isSchoolMaster || teacher?.schoolAdminRole === "subadmin";
  const schoolRoleLabel = isSchoolMaster ? "School Admin" : teacher?.schoolAdminRole === "subadmin" ? "School Sub-admin" : null;

  if (!isSchoolAdmin) {
    return (
      <div className="min-h-[100dvh] bg-neutral-50 text-neutral-900 font-sans">
        <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/90 backdrop-blur">
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
            <div className="flex items-center gap-2 text-sm">
              <Link href="/teacher/dashboard" className="text-neutral-500 transition-colors hover:text-black">Dashboard</Link>
              <span className="text-neutral-300">/</span>
              <span className="font-medium">Account</span>
            </div>
            <div className="flex min-w-0 items-center gap-4 text-sm">
              <span className="hidden truncate text-neutral-600 sm:block">{teacher?.name}</span>
              <button onClick={handleSignOut} className="shrink-0 text-neutral-500 transition-colors hover:text-black">Sign Out</button>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
          <div className="border-b border-neutral-200 pb-7">
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-400">Account</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Change password</h1>
            <p className="mt-2 text-sm text-neutral-600">Update the password used to sign in to your teacher account.</p>
          </div>

          <section className="mt-6 rounded-[2rem] border border-neutral-200 bg-white p-6 shadow-sm sm:p-8" aria-labelledby="change-password-heading">
            <h2 id="change-password-heading" className="text-xl font-semibold">Change password</h2>
            <form onSubmit={handleChangePassword} className="mt-6 max-w-sm space-y-4">
              <div>
                <label htmlFor="account-current-password" className="mb-2 block text-sm font-medium">Current password</label>
                <input
                  id="account-current-password"
                  required
                  type="password"
                  autoComplete="current-password"
                  value={cpForm.current}
                  onChange={(event) => setCpForm({ ...cpForm, current: event.target.value })}
                  className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                  placeholder="Your current password"
                />
              </div>
              <div>
                <label htmlFor="account-new-password" className="mb-2 block text-sm font-medium">New password</label>
                <input
                  id="account-new-password"
                  required
                  type="password"
                  autoComplete="new-password"
                  value={cpForm.next}
                  onChange={(event) => {
                    setCpForm({ ...cpForm, next: event.target.value });
                    setHibpWarning(null);
                    setAcceptHibpWarning(false);
                  }}
                  minLength={12}
                  className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                  placeholder="At least 12 characters"
                />
              </div>
              <div>
                <label htmlFor="account-confirm-password" className="mb-2 block text-sm font-medium">Confirm new password</label>
                <input
                  id="account-confirm-password"
                  required
                  type="password"
                  autoComplete="new-password"
                  value={cpForm.confirm}
                  onChange={(event) => setCpForm({ ...cpForm, confirm: event.target.value })}
                  minLength={12}
                  className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                  placeholder="Same password again"
                />
              </div>
              {hibpWarning && (
                <div role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  <p className="font-medium">Breach check temporarily unavailable</p>
                  <p className="mt-1">{hibpWarning}</p>
                  <label className="mt-3 flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={acceptHibpWarning}
                      onChange={(event) => setAcceptHibpWarning(event.target.checked)}
                      className="mt-0.5"
                    />
                    <span>I understand and want to continue with this password.</span>
                  </label>
                </div>
              )}
              <button
                type="submit"
                disabled={cpLoading || Boolean(hibpWarning && !acceptHibpWarning)}
                className="rounded-2xl bg-black px-6 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {cpLoading ? "Saving…" : "Update password"}
              </button>
            </form>
          </section>
        </main>
      </div>
    );
  }

  const teacherDirectoryStatusLabel = teacherDirectoryFilters.approvalStatus === "pending"
    ? "awaiting approval"
    : teacherDirectoryFilters.status === "all"
      ? "teacher"
      : teacherDirectoryFilters.status;
  const selectedTeacherDirectoryView: TeacherDirectoryView = teacherDirectoryFilters.approvalStatus === "pending"
    ? "pending"
    : teacherDirectoryFilters.status === "suspended"
      ? "suspended"
      : teacherDirectoryFilters.status === "deleted"
        ? "deleted"
      : teacherDirectoryFilters.status === "all"
        ? "all"
        : "active";
  const hasTeacherDirectoryFilters = Boolean(
    teacherDirectoryFilters.q.trim()
    || teacherDirectoryFilters.status !== "active"
    || teacherDirectoryFilters.approvalStatus !== "all"
    || teacherDirectoryFilters.from
    || teacherDirectoryFilters.to
    || teacherDirectoryFilters.sort !== "name"
    || teacherDirectoryFilters.direction !== "asc",
  );
  const normalizedArchiveSearch = recordArchiveSearch.trim().toLowerCase();
  const filteredRecordArchives = normalizedArchiveSearch
    ? recordArchives.filter((archive) => [
      String(archive.id),
      archive.teacherName ?? "",
      archive.teacherEmail ?? "",
      archive.reason ?? "",
      ...(Array.isArray(archive.classNames) ? archive.classNames : archive.classNames ? [archive.classNames] : []),
    ].some((value) => value.toLowerCase().includes(normalizedArchiveSearch)))
    : recordArchives;
  const availableRetentionExceptionCategories = retentionCategories.filter(
    (category) => category.value === retentionExceptionForm.category
      || !retentionPolicies.some((policy) => policy.dataCategory === category.value),
  );
  const canManageTeacherAccount = (target: OrgTeacher) => {
    if (!isSchoolAdmin || target.id === teacher?.id || target.schoolAdminRole === "master" || target.accountStatus === "deleted") return false;
    return isSchoolMaster || target.schoolAdminRole !== "subadmin";
  };
  const teacherRecoveryDeadline = (target: OrgTeacher) => {
    if (target.accountRecoveryUntil) return new Date(target.accountRecoveryUntil);
    if (!target.accountStatusChangedAt) return null;
    const deadline = new Date(target.accountStatusChangedAt);
    deadline.setDate(deadline.getDate() + (platformRetentionPolicy.deletionRecoveryDays || 30));
    return deadline;
  };
  const archiveAccountRecoveryDeadline = (archive: TeacherRecordArchive) => {
    if (archive.accountRecoveryUntil) return new Date(archive.accountRecoveryUntil);
    if (!archive.accountStatusChangedAt) return null;
    const deadline = new Date(archive.accountStatusChangedAt);
    deadline.setDate(deadline.getDate() + (platformRetentionPolicy.deletionRecoveryDays || 30));
    return deadline;
  };
  const isAccountRecoveryEligible = (target: OrgTeacher) => (
    target.accountRecoveryEligible !== false
    && (!teacherRecoveryDeadline(target) || teacherRecoveryDeadline(target)!.getTime() > Date.now())
  );
  const archiveDestinationTeachers = (replacementTeachers.length ? replacementTeachers : orgTeachers)
    .filter((target) => target.accountStatus === "active");
  const previewArchiveDays = Number(retentionDefaultForm.archiveRetentionDays);
  const previewDeletionRecoveryDays = Number(retentionDefaultForm.deletionRecoveryDays);
  const previewArchiveExpiry = Number.isFinite(previewArchiveDays) && previewArchiveDays > 0
    ? new Date(Date.now() + previewArchiveDays * 86400000)
    : null;
  const previewFinalDeletion = previewArchiveExpiry && Number.isFinite(previewDeletionRecoveryDays) && previewDeletionRecoveryDays > 0
    ? new Date(previewArchiveExpiry.getTime() + previewDeletionRecoveryDays * 86400000)
    : null;
  const formatRetentionPreviewDate = (date: Date | null) => date
    ? date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : "—";

  return (
    <div className="min-h-[100dvh] overflow-x-hidden bg-neutral-50 text-neutral-900 font-sans">
      <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-3">
          <div className="flex shrink-0 items-center gap-2 text-sm">
            <Link href="/teacher/dashboard" className="text-neutral-500 hover:text-black transition-colors">Dashboard</Link>
            <span className="text-neutral-300">/</span>
            <span className="font-medium">Settings</span>
          </div>
          <div className="flex min-w-0 items-center gap-2 sm:gap-6 text-sm">
            <span className="flex min-w-0 items-center gap-2 text-neutral-600">
              <span className="hidden truncate sm:inline">{teacher?.name}</span>
              {schoolRoleLabel && (
                <span className="shrink-0 px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">{schoolRoleLabel}</span>
              )}
            </span>
            <button onClick={handleSignOut} className="shrink-0 whitespace-nowrap hover:text-black transition-colors text-neutral-500">Sign Out</button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6 sm:py-12">
        <div className="flex flex-col gap-5 border-b border-neutral-200 pb-7 sm:flex-row sm:items-end sm:justify-between">
          <div>
            {settingsArea !== "home" && (
              <button
                type="button"
                onClick={() => setSettingsArea("home")}
                className="mb-3 inline-flex items-center gap-2 text-sm font-medium text-neutral-500 transition-colors hover:text-neutral-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2"
              >
                <span aria-hidden="true">←</span>
                Settings home
              </button>
            )}
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-400">
              {settingsArea === "home" ? "School administration" : settingsAreaMeta[settingsArea].eyebrow}
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-neutral-950">
              {settingsArea === "home" ? "School Admin settings" : settingsAreaMeta[settingsArea].label}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-600">
              {settingsArea === "home"
                ? "Manage your school’s people, data responsibilities, records lifecycle and platform controls."
                : settingsAreaMeta[settingsArea].description}
            </p>
          </div>
          {schoolRoleLabel && (
            <span className="w-fit shrink-0 rounded-full bg-blue-100 px-3 py-1.5 text-xs font-medium text-blue-700">{schoolRoleLabel}</span>
          )}
        </div>

        {settingsArea === "home" && (
          <>
            <section aria-labelledby="settings-areas-heading">
              <div className="mb-4">
                <h2 id="settings-areas-heading" className="text-lg font-semibold text-neutral-950">Choose an area</h2>
                <p className="mt-1 text-sm text-neutral-600">School Admin controls stay separate from centrally managed platform services.</p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <SettingsAreaCard
                  icon={Users}
                  title="Manage Teachers"
                  description="Review registrations, manage teacher access, recover accounts and handle departures."
                  status={pendingTeacherCount > 0 ? `${pendingTeacherCount} awaiting approval` : "No approvals waiting"}
                  actionLabel="Manage"
                  tone={pendingTeacherCount > 0 ? "amber" : "blue"}
                  onClick={() => setSettingsArea("teachers")}
                />
                {isSchoolMaster && (
                  <SettingsAreaCard
                    icon={ShieldCheck}
                    title="Privacy and Student Data"
                    description="Keep the school approval record separate from individual Student data requests and controls."
                    status={studentDataRequests.filter((request) => request.status === "open" || request.status === "in_review").length > 0
                      ? `${studentDataRequests.filter((request) => request.status === "open" || request.status === "in_review").length} open requests`
                      : schoolDataRequestProcedure ? "Approval recorded" : "Approval needs recording"}
                    actionLabel="Manage"
                    tone={schoolDataRequestProcedure ? "green" : "amber"}
                    onClick={() => setSettingsArea("privacy")}
                  />
                )}
                {isSchoolMaster && (
                  <SettingsAreaCard
                    icon={Archive}
                    title="Archived and Permanently deleted records"
                    description="Review protected archives, Pending deletion recovery, retention periods and scoped holds."
                    status={recoverableDeletionRequests.classes.length + recoverableDeletionRequests.studentRecords.length > 0
                      ? `${recoverableDeletionRequests.classes.length + recoverableDeletionRequests.studentRecords.length} in recovery`
                      : retentionDefaultPolicy ? "Retention configured" : "CIG default applies"}
                    actionLabel="Manage"
                    tone={recoverableDeletionRequests.classes.length + recoverableDeletionRequests.studentRecords.length > 0 ? "amber" : "neutral"}
                    onClick={() => setSettingsArea("records")}
                  />
                )}
                <SettingsAreaCard
                  icon={LockKeyhole}
                  title="Platform and Security"
                  description="Review AI governance, centrally managed email, evidence, audit, MFA, password and session controls."
                  status={isSchoolMaster && aiSettings?.configured ? "AI configured" : "Security controls"}
                  actionLabel="Manage"
                  tone="neutral"
                  onClick={() => setSettingsArea("security")}
                />
              </div>
            </section>

            <section aria-labelledby="settings-status-heading" className="rounded-[1.75rem] border border-neutral-200 bg-white p-6 shadow-sm">
              <div className="mb-4">
                <p className="text-xs uppercase tracking-[0.2em] text-neutral-400">At a glance</p>
                <h2 id="settings-status-heading" className="mt-1 text-lg font-semibold text-neutral-950">School settings status</h2>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <button type="button" onClick={() => setSettingsArea("teachers")} className="rounded-2xl border border-neutral-100 bg-neutral-50 p-4 text-left transition-colors hover:border-sky-200 hover:bg-sky-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-600">
                  <p className="text-xs font-medium uppercase tracking-[0.14em] text-neutral-400">Teacher approvals</p>
                  <p className="mt-2 text-2xl font-semibold text-neutral-950">{pendingTeacherCount}</p>
                  <p className="mt-1 text-xs text-neutral-600">{pendingTeacherCount === 1 ? "registration waiting" : "registrations waiting"}</p>
                </button>
                {isSchoolMaster && (
                  <button type="button" onClick={() => setSettingsArea("privacy")} className="rounded-2xl border border-neutral-100 bg-neutral-50 p-4 text-left transition-colors hover:border-sky-200 hover:bg-sky-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-600">
                    <p className="text-xs font-medium uppercase tracking-[0.14em] text-neutral-400">Student data requests</p>
                    <p className="mt-2 text-2xl font-semibold text-neutral-950">{studentDataRequests.filter((request) => request.status === "open" || request.status === "in_review").length}</p>
                    <p className="mt-1 text-xs text-neutral-600">open or in review</p>
                  </button>
                )}
                {isSchoolMaster && (
                  <button type="button" onClick={() => setSettingsArea("records")} className="rounded-2xl border border-neutral-100 bg-neutral-50 p-4 text-left transition-colors hover:border-sky-200 hover:bg-sky-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-600">
                    <p className="text-xs font-medium uppercase tracking-[0.14em] text-neutral-400">Pending deletion</p>
                    <p className="mt-2 text-2xl font-semibold text-neutral-950">{recoverableDeletionRequests.classes.length + recoverableDeletionRequests.studentRecords.length}</p>
                    <p className="mt-1 text-xs text-neutral-600">records in recovery</p>
                  </button>
                )}
                <button type="button" onClick={() => setSettingsArea("security")} className="rounded-2xl border border-neutral-100 bg-neutral-50 p-4 text-left transition-colors hover:border-sky-200 hover:bg-sky-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-600">
                  <p className="text-xs font-medium uppercase tracking-[0.14em] text-neutral-400">AI and security</p>
                  <p className="mt-2 text-lg font-semibold text-neutral-950">{isSchoolMaster && aiSettings?.configured ? "Configured" : "Review controls"}</p>
                  <p className="mt-1 text-xs text-neutral-600">School Admin visibility</p>
                </button>
              </div>
            </section>

            {/* Profile card */}
            <div className="rounded-[1.75rem] border border-neutral-200 bg-white p-6 shadow-sm sm:p-8">
              <h2 className="text-lg font-semibold text-neutral-950">Account</h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-xs text-neutral-500">Name</p>
                  <p className="mt-1 font-medium [overflow-wrap:anywhere]">{teacher?.name}</p>
                </div>
                <div>
                  <p className="text-xs text-neutral-500">Email</p>
                  <p className="mt-1 font-medium [overflow-wrap:anywhere]">{teacher?.email}</p>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Invite code (IT admin only) */}
        {settingsArea === "teachers" && isSchoolMaster && inviteCode !== null && (
          <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm space-y-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-1">Teacher Invite Code</p>
              <p className="text-sm text-neutral-600">Teachers enter this when they register.</p>
            </div>
            <div className="flex min-w-0 flex-col items-start gap-3 sm:flex-row sm:items-center">
              <span className="min-w-0 max-w-full font-mono text-2xl font-semibold tracking-widest [overflow-wrap:anywhere]">{inviteCode}</span>
              <button
                onClick={handleCopyCode}
                className="shrink-0 rounded-xl border border-neutral-200 px-3 py-1.5 text-xs hover:bg-neutral-50 transition-colors"
              >
                {codeCopied ? "✓ Copied" : "Copy"}
              </button>
            </div>
            <div className="pt-1 border-t border-neutral-100">
              <button
                onClick={handleRotateCode}
                disabled={rotatingCode}
                className="rounded-2xl border border-red-200 text-red-600 px-4 py-2 text-sm hover:bg-red-50 transition-colors disabled:opacity-50"
              >
                {rotatingCode ? "Rotating…" : "Rotate code (invalidates current)"}
              </button>
              <p className="text-xs text-neutral-400 mt-2">Existing teacher accounts are unaffected — only new registrations need the new code.</p>
            </div>
          </div>
        )}

        {/* Email domain allowlist (IT admin only) */}
        {settingsArea === "teachers" && isSchoolMaster && domainsLoaded && (
          <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm space-y-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-1">Allowed Email Domains</p>
              <p className="text-sm text-neutral-600">
                {allowedDomains.length === 0
                  ? "No restriction — anyone with the invite code can register. Add a domain to limit registration to school email addresses."
                  : "Only email addresses from these domains can register with your invite code."}
              </p>
            </div>

            {allowedDomains.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {allowedDomains.map((d) => (
                  <span key={d} className="inline-flex items-center gap-1.5 rounded-full bg-neutral-100 px-3 py-1 text-sm font-mono">
                    @{d}
                    <button
                      type="button"
                      onClick={() => handleRemoveDomain(d)}
                      disabled={savingDomains}
                      className="text-neutral-400 hover:text-red-500 transition-colors leading-none"
                      aria-label={`Remove ${d}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="flex gap-2 items-start">
              <div className="flex-1">
                <input
                  type="text"
                  value={newDomain}
                  onChange={(e) => { setNewDomain(e.target.value); setDomainError(""); }}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAddDomain(); } }}
                  placeholder="school.edu.au"
                  className="w-full rounded-2xl border border-neutral-200 px-4 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-neutral-300"
                />
                {domainError && <p className="text-xs text-red-500 mt-1">{domainError}</p>}
              </div>
              <button
                type="button"
                onClick={handleAddDomain}
                disabled={savingDomains}
                className="rounded-2xl border border-neutral-200 px-4 py-2 text-sm hover:bg-neutral-50 transition-colors disabled:opacity-50"
              >
                {savingDomains ? "Adding…" : "Add"}
              </button>
            </div>

            <div className="pt-1 border-t border-neutral-100">
              <p className="text-xs text-neutral-400">
                {allowedDomains.length === 0 ? "Add a domain to restrict registration by school email." : `${allowedDomains.length} domain${allowedDomains.length !== 1 ? "s" : ""} will be enforced.`}
              </p>
            </div>
          </div>
        )}

        {/* Teachers list (IT admin only) */}
        {settingsArea === "teachers" && isSchoolAdmin && (
          <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-1">Teacher Accounts</p>
                <p className="text-sm text-neutral-500">
                  {teacherDirectoryTotal} {teacherDirectoryStatusLabel} account{teacherDirectoryTotal === 1 ? "" : "s"}
                </p>
              </div>
            </div>
            <div
              className={`rounded-2xl border px-4 py-4 ${
                pendingTeacherCount > 0
                  ? "border-amber-200 bg-amber-50"
                  : "border-neutral-200 bg-neutral-50"
              }`}
              data-testid="teacher-approval-summary"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <span
                    className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                      pendingTeacherCount > 0 ? "bg-amber-200 text-amber-900" : "bg-neutral-200 text-neutral-600"
                    }`}
                    aria-hidden="true"
                  >
                    {pendingTeacherCount}
                  </span>
                  <div>
                    <p className={`text-sm font-semibold ${pendingTeacherCount > 0 ? "text-amber-950" : "text-neutral-700"}`}>
                      {pendingTeacherCount > 0
                        ? `${pendingTeacherCount} teacher${pendingTeacherCount === 1 ? "" : "s"} waiting for approval`
                        : "No teachers waiting for approval"}
                    </p>
                    <p className={`mt-0.5 text-xs ${pendingTeacherCount > 0 ? "text-amber-800" : "text-neutral-500"}`}>
                      {pendingTeacherCount > 0
                        ? "Review these registrations before they can access their classrooms."
                        : "New teacher registrations will appear here after they complete setup."}
                    </p>
                  </div>
                </div>
                {pendingTeacherCount > 0 && (
                  <button
                    type="button"
                    onClick={showPendingTeacherAccounts}
                    disabled={teacherDirectoryLoading}
                    className="shrink-0 rounded-xl bg-amber-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-amber-800 disabled:opacity-50"
                  >
                    {teacherDirectoryLoading ? "Loading…" : "Review waiting teachers"}
                  </button>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Teacher account views" role="tablist">
              {([
                ["active", "Active", teacherDirectoryCounts.active],
                ["suspended", "Suspended", teacherDirectoryCounts.suspended],
                ["pending", "Awaiting approval", teacherDirectoryCounts.pending],
                ["deleted", "Account access removed", teacherDirectoryCounts.deleted],
                ["all", "All accounts", teacherDirectoryCounts.all],
              ] as const).map(([view, label, count]) => (
                <button
                  key={view}
                  type="button"
                  role="tab"
                  aria-selected={selectedTeacherDirectoryView === view}
                  onClick={() => selectTeacherDirectoryView(view)}
                  disabled={teacherDirectoryLoading}
                  className={`rounded-xl border px-3 py-2.5 text-left text-xs transition-colors disabled:opacity-50 ${
                    selectedTeacherDirectoryView === view
                      ? "border-neutral-900 bg-neutral-900 text-white"
                      : "border-neutral-200 bg-neutral-50 text-neutral-700 hover:bg-neutral-100"
                  }`}
                >
                  <span className="block font-semibold">{label}</span>
                  <span className={`mt-0.5 block ${selectedTeacherDirectoryView === view ? "text-neutral-300" : "text-neutral-500"}`}>
                    {count} account{count === 1 ? "" : "s"}
                  </span>
                </button>
              ))}
            </div>
            <form onSubmit={runTeacherSearch} className="space-y-3">
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  value={teacherDirectoryFilters.q}
                  onChange={(e) => updateTeacherDirectoryFilter("q", e.target.value)}
                  className="min-w-0 flex-1 rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-300"
                  placeholder="Search by name or email"
                  aria-label="Search teacher accounts"
                />
                <button type="submit" className="rounded-xl bg-neutral-900 px-5 py-3 text-sm font-medium text-white hover:bg-neutral-700 transition-colors disabled:opacity-50" disabled={teacherDirectoryLoading}>
                  {teacherDirectoryLoading ? "Searching…" : "Search"}
                </button>
              </div>
              <details
                open={teacherDirectoryFiltersOpen}
                onToggle={(event) => setTeacherDirectoryFiltersOpen(event.currentTarget.open)}
                className="rounded-2xl border border-neutral-200 bg-neutral-50"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-neutral-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-inset">
                  <span>More filters</span>
                  <span className="text-xs font-normal text-neutral-500">
                    {hasTeacherDirectoryFilters ? "Filters applied" : "Status, dates and sorting"}
                  </span>
                </summary>
                <div className="grid gap-3 border-t border-neutral-200 p-4 sm:grid-cols-2">
                  <label className="text-xs font-medium text-neutral-600">
                    Account status
                    <select
                      value={teacherDirectoryFilters.status}
                      onChange={(e) => updateTeacherDirectoryFilter("status", e.target.value as TeacherDirectoryFilters["status"])}
                      className="mt-1 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm font-normal text-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-300"
                      aria-label="Filter teacher accounts by status"
                    >
                      <option value="all">All statuses</option>
                      <option value="active">Active</option>
                      <option value="suspended">Suspended</option>
                      <option value="deleted">Account access removed</option>
                    </select>
                  </label>
                  <label className="text-xs font-medium text-neutral-600">
                    Approval
                    <select
                      value={teacherDirectoryFilters.approvalStatus}
                      onChange={(e) => updateTeacherDirectoryFilter("approvalStatus", e.target.value as TeacherDirectoryFilters["approvalStatus"])}
                      className="mt-1 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm font-normal text-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-300"
                    >
                      <option value="all">All approval states</option>
                      <option value="pending">Awaiting approval</option>
                      <option value="approved">Approved</option>
                      <option value="rejected">Rejected</option>
                    </select>
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="text-xs font-medium text-neutral-600">
                      Created from
                      <input
                        type="date"
                        value={teacherDirectoryFilters.from}
                        onChange={(e) => updateTeacherDirectoryFilter("from", e.target.value)}
                        className="mt-1 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm font-normal text-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-300"
                        aria-label="Teacher accounts created from"
                      />
                    </label>
                    <label className="text-xs font-medium text-neutral-600">
                      Created to
                      <input
                        type="date"
                        value={teacherDirectoryFilters.to}
                        onChange={(e) => updateTeacherDirectoryFilter("to", e.target.value)}
                        className="mt-1 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm font-normal text-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-300"
                        aria-label="Teacher accounts created to"
                      />
                    </label>
                  </div>
                  <label className="text-xs font-medium text-neutral-600">
                    Sort by
                    <select
                      value={teacherDirectoryFilters.sort}
                      onChange={(e) => updateTeacherDirectoryFilter("sort", e.target.value as TeacherDirectoryFilters["sort"])}
                      className="mt-1 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm font-normal text-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-300"
                      aria-label="Sort teacher accounts by"
                    >
                      <option value="name">Name</option>
                      <option value="createdAt">Created date</option>
                      <option value="status">Status</option>
                    </select>
                  </label>
                  <label className="text-xs font-medium text-neutral-600">
                    Direction
                    <select
                      value={teacherDirectoryFilters.direction}
                      onChange={(e) => updateTeacherDirectoryFilter("direction", e.target.value as TeacherDirectoryFilters["direction"])}
                      className="mt-1 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm font-normal text-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-300"
                      aria-label="Sort teacher accounts direction"
                    >
                      <option value="asc">Ascending</option>
                      <option value="desc">Descending</option>
                    </select>
                  </label>
                  <div className="flex flex-wrap justify-end gap-2 sm:col-span-2">
                    {hasTeacherDirectoryFilters && (
                      <button
                        type="button"
                        className="rounded-xl border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 transition-colors disabled:opacity-50"
                        disabled={teacherDirectoryLoading}
                        onClick={() => {
                           const next: TeacherDirectoryFilters = { q: "", status: "active", approvalStatus: "approved", from: "", to: "", sort: "name", direction: "asc", page: 1 };
                          setTeacherDirectoryFilters(next);
                          loadTeacherDirectory(next).catch(() => undefined);
                        }}
                      >
                        Reset filters
                      </button>
                    )}
                    <button
                      type="submit"
                      className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
                      disabled={teacherDirectoryLoading}
                    >
                      {teacherDirectoryLoading ? "Searching…" : "Search with these filters"}
                    </button>
                  </div>
                </div>
              </details>
            </form>
            {teacherDirectoryError ? (
              <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{teacherDirectoryError}</p>
            ) : (
              !showTeacherDirectoryResults ? (
                <div className="rounded-2xl border border-dashed border-neutral-200 bg-neutral-50 px-4 py-5 text-center">
                  <p className="text-sm text-neutral-600">Search for a teacher account to see matching results.</p>
                  <button
                    type="button"
                    onClick={showAllTeacherAccounts}
                    disabled={teacherDirectoryLoading}
                    className="mt-3 rounded-xl border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 transition-colors disabled:opacity-50"
                  >
                    {teacherDirectoryLoading ? "Loading accounts…" : "Show all accounts"}
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-neutral-500">
                      {teacherDirectoryFilters.q.trim()
                        ? `Showing results for “${teacherDirectoryFilters.q.trim()}”`
                        : "Showing all matching accounts"}
                    </p>
                    <button
                      type="button"
                      onClick={() => setShowTeacherDirectoryResults(false)}
                      className="text-xs font-medium text-neutral-500 hover:text-neutral-900 transition-colors"
                    >
                      Hide results
                    </button>
                  </div>
                  {teacherDirectoryLoading && orgTeachers.length === 0 ? (
                    <p className="text-sm text-neutral-500">Loading teacher accounts…</p>
                  ) : orgTeachers.length === 0 ? (
                    <p className="text-sm text-neutral-500">No teacher accounts match these filters.</p>
                  ) : (
                    <div className="divide-y divide-neutral-100">
              {orgTeachers.map((t) => (
                <article key={t.id} className="py-5 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <div>
                      <p className="font-medium text-sm">
                        {t.name}
                        {t.schoolAdminRole && <span className="ml-2 text-xs text-blue-600 font-normal">{t.schoolAdminRole === "master" ? "School Admin" : "School Sub-admin"}</span>}
                        {t.canReviewSafeguarding && (
                          <span
                            data-testid={`status-safeguarding-reviewer-${t.id}`}
                            className="ml-2 text-xs text-emerald-700 font-normal"
                          >
                            Safeguarding Reviewer
                          </span>
                        )}
                        {t.accountStatus === "active" && t.mustChangePassword && <span className="ml-2 text-xs text-amber-600 font-normal">Must change password</span>}
                        {t.accountStatus === "active" && !t.totpEnabled && <span className="ml-2 text-xs text-amber-600 font-normal">Authenticator setup required</span>}
                        {t.accountStatus === "active" && isLocked(t) && <span className="ml-2 text-xs text-red-600 font-normal">Locked</span>}
                         {t.approvalStatus === "pending" && <span className="ml-2 text-xs text-amber-600 font-normal">Awaiting approval</span>}
                         {t.approvalStatus === "rejected" && <span className="ml-2 text-xs text-red-600 font-normal">Registration rejected</span>}
                        {t.accountStatus !== "active" && <span className={`ml-2 text-xs font-normal ${t.accountStatus === "deleted" ? "text-neutral-500" : "text-orange-600"}`}>{t.accountStatus === "deleted" ? "Account access removed" : "Suspended"}</span>}
                      </p>
                       <p className="text-xs text-neutral-400 mt-0.5">{t.email} · Created {new Date(t.createdAt).toLocaleDateString("en-GB")}</p>
                       {t.accountStatus === "deleted" && (
                         <p className="mt-2 text-xs text-neutral-500">
                           {t.accountStatusChangedAt && <>Access removed {new Date(t.accountStatusChangedAt).toLocaleDateString("en-GB")}. </>}
                           {teacherRecoveryDeadline(t)
                             ? <>Account recovery available until <strong>{teacherRecoveryDeadline(t)!.toLocaleDateString("en-GB")}</strong>.</>
                             : "Account recovery deadline is not available."}
                         </p>
                       )}
                    </div>
                   {t.approvalStatus === "rejected" && t.approvalReason && <p className="mt-2 text-xs text-red-700">Rejection reason: {t.approvalReason}</p>}
                   {t.approvalStatus === "pending" && canManageTeacherAccount(t) && (
                     <div className="mt-3 flex gap-2">
                       <button onClick={() => handleApproval(t, "approve")} disabled={reviewingApproval === t.id} className="rounded-xl border border-emerald-200 px-3 py-1.5 text-xs text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
                         {reviewingApproval === t.id ? "Saving…" : "Approve"}
                       </button>
                       <button onClick={() => handleApproval(t, "reject")} disabled={reviewingApproval === t.id} className="rounded-xl border border-red-200 px-3 py-1.5 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50">Reject</button>
                     </div>
                   )}
                    {t.accountStatus === "deleted" && isSchoolMaster && (
                      <div className="mt-3">
                        <button
                          type="button"
                          data-testid={`button-restore-teacher-${t.id}`}
                          onClick={() => handleRestoreDeletedTeacher(t)}
                          disabled={updatingStatus === t.id || !isAccountRecoveryEligible(t)}
                          className="rounded-xl border border-emerald-200 px-3 py-1.5 text-xs text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {updatingStatus === t.id ? "Restoring…" : isAccountRecoveryEligible(t) ? "Restore account" : "Recovery window ended"}
                        </button>
                      </div>
                    )}
                  </div>
                  {canManageTeacherAccount(t) && (
                    <details className="group mt-4 w-full rounded-2xl border border-neutral-200 bg-neutral-50">
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-400 transition-colors hover:bg-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-inset">
                        <span>Account controls</span>
                        <span className="shrink-0 normal-case tracking-normal text-neutral-500">
                          <span className="group-open:hidden">Show actions</span>
                          <span className="hidden group-open:inline">Hide actions</span>
                        </span>
                      </summary>
                      <div className="border-t border-neutral-200 px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                      {t.accountStatus === "active" && isLocked(t) && canManageTeacherAccount(t) && (
                        <button
                          onClick={() => handleUnlock(t.id)}
                          disabled={unlocking === t.id}
                          className="rounded-xl border border-amber-200 text-amber-700 px-3 py-1.5 text-xs hover:bg-amber-50 transition-colors disabled:opacity-50"
                        >
                          {unlocking === t.id ? "Unlocking…" : "Unlock"}
                        </button>
                      )}
                      {canManageTeacherAccount(t) && (
                        <>
                          {isSchoolMaster && (
                            <button
                              onClick={() => handleToggleAdmin(t)}
                              disabled={togglingAdmin === t.id}
                              className={`rounded-xl border px-3 py-1.5 text-xs transition-colors disabled:opacity-50 ${t.schoolAdminRole === "subadmin" ? "border-blue-200 text-blue-700 hover:bg-blue-50" : "border-neutral-200 text-neutral-600 hover:bg-neutral-50"}`}
                            >
                              {togglingAdmin === t.id ? "Saving…" : t.schoolAdminRole === "subadmin" ? "Remove Sub-admin" : "Make Sub-admin"}
                            </button>
                          )}
                          {isSchoolMaster && (t.canReviewSafeguarding || (t.accountStatus === "active" && t.approvalStatus === "approved")) && (
                            t.canReviewSafeguarding ? (
                              <button
                                type="button"
                                data-testid={`button-remove-safeguarding-reviewer-${t.id}`}
                                onClick={() => void handleSafeguardingReviewerChange(t, false)}
                                disabled={safeguardingReviewerSaving === t.id}
                                className="rounded-xl border border-rose-200 px-3 py-1.5 text-xs text-rose-700 transition-colors hover:bg-rose-50 disabled:opacity-50"
                              >
                                {safeguardingReviewerSaving === t.id ? "Saving…" : "Remove reviewer access"}
                              </button>
                            ) : safeguardingReviewerConfirming === t.id ? (
                              <div className="basis-full rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                                <label className="flex items-start gap-2 text-xs leading-5 text-emerald-950">
                                  <input
                                    type="checkbox"
                                    data-testid={`checkbox-authorize-safeguarding-reviewer-${t.id}`}
                                    checked={safeguardingReviewerConfirmed}
                                    onChange={(event) => setSafeguardingReviewerConfirmed(event.target.checked)}
                                    className="mt-0.5"
                                  />
                                  <span>I confirm that this member of staff is authorised by the school to review safeguarding concerns within e-Assisted Climb.</span>
                                </label>
                                <div className="mt-3 flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    data-testid={`button-confirm-safeguarding-reviewer-${t.id}`}
                                    onClick={() => void handleSafeguardingReviewerChange(t, true)}
                                    disabled={!safeguardingReviewerConfirmed || safeguardingReviewerSaving === t.id}
                                    className="rounded-xl bg-emerald-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    {safeguardingReviewerSaving === t.id ? "Saving…" : "Confirm reviewer assignment"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSafeguardingReviewerConfirming(null);
                                      setSafeguardingReviewerConfirmed(false);
                                    }}
                                    disabled={safeguardingReviewerSaving === t.id}
                                    className="rounded-xl border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-white disabled:opacity-50"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <button
                                type="button"
                                data-testid={`button-assign-safeguarding-reviewer-${t.id}`}
                                onClick={() => {
                                  setSafeguardingReviewerConfirming(t.id);
                                  setSafeguardingReviewerConfirmed(false);
                                }}
                                disabled={safeguardingReviewerSaving === t.id}
                                className="rounded-xl border border-emerald-200 px-3 py-1.5 text-xs text-emerald-800 transition-colors hover:bg-emerald-50 disabled:opacity-50"
                              >
                                Make Safeguarding Reviewer
                              </button>
                            )
                          )}
                          <button
                            onClick={() => handleGenerateReset(t.id)}
                            disabled={generatingReset === t.id || resettingMfa === t.id}
                            className="rounded-xl border border-neutral-200 px-3 py-1.5 text-xs hover:bg-neutral-50 transition-colors disabled:opacity-50"
                          >
                            {generatingReset === t.id ? "Generating…" : "Reset password"}
                          </button>
                          {t.accountStatus === "active" ? (
                            <>
                              <button
                                onClick={() => handleResetMfa(t)}
                                disabled={resettingMfa === t.id}
                                className="rounded-xl border border-amber-200 text-amber-700 px-3 py-1.5 text-xs hover:bg-amber-50 transition-colors disabled:opacity-50"
                                data-testid={`button-reset-mfa-${t.id}`}
                              >
                                {resettingMfa === t.id ? "Resetting…" : "Reset authenticator"}
                              </button>
                              <button
                                onClick={() => handleStatusChange(t, "suspended")}
                                disabled={updatingStatus === t.id}
                                className="rounded-xl border border-orange-200 text-orange-700 px-3 py-1.5 text-xs hover:bg-orange-50 transition-colors disabled:opacity-50"
                              >
                                {updatingStatus === t.id ? "Saving…" : "Suspend"}
                              </button>
                              {isSchoolMaster && (
                                <button
                                  onClick={() => handleStartDeparture(t)}
                                  disabled={departureLoading === t.id}
                                  className="rounded-xl border border-red-200 text-red-700 px-3 py-1.5 text-xs hover:bg-red-50 transition-colors disabled:opacity-50"
                                >
                                  {departureLoading === t.id ? "Loading…" : "Manage departure"}
                                </button>
                              )}
                               {isSchoolMaster && (
                                 <button
                                   type="button"
                                   data-testid={`button-transfer-classes-${t.id}`}
                                   onClick={() => handleStartClassTransfer(t)}
                                   disabled={classTransferLoading === t.id}
                                   className="rounded-xl border border-sky-200 text-sky-700 px-3 py-1.5 text-xs hover:bg-sky-50 transition-colors disabled:opacity-50"
                                 >
                                   {classTransferLoading === t.id ? "Loading…" : "Transfer classes"}
                                 </button>
                               )}
                            </>
                          ) : t.accountStatus === "suspended" ? (
                            <>
                              <button
                                onClick={() => handleStatusChange(t, "active")}
                                disabled={updatingStatus === t.id}
                                className="rounded-xl border border-emerald-200 text-emerald-700 px-3 py-1.5 text-xs hover:bg-emerald-50 transition-colors disabled:opacity-50"
                              >
                                {updatingStatus === t.id ? "Saving…" : "Restore"}
                              </button>
                              {isSchoolMaster && (
                                <button
                                  onClick={() => handleStartDeparture(t)}
                                  disabled={departureLoading === t.id}
                                  className="rounded-xl border border-red-200 text-red-700 px-3 py-1.5 text-xs hover:bg-red-50 transition-colors disabled:opacity-50"
                                >
                                  {departureLoading === t.id ? "Loading…" : "Manage departure"}
                                </button>
                              )}
                            </>
                          ) : null}
                        </>
                      )}
                        </div>
                      </div>
                    </details>
                  )}
                  {resetLinks[t.id] && (
                    <div className="mt-2 p-3 rounded-xl bg-amber-50 border border-amber-200">
                      <p className="text-xs text-amber-700 font-medium mb-1">Share this link securely (expires in 1 hour):</p>
                      <div className="flex items-center gap-2">
                        <input
                          readOnly
                          value={resetLinks[t.id]}
                          className="text-xs font-mono flex-1 bg-transparent border-0 outline-none text-neutral-700 truncate"
                        />
                        <button
                          onClick={() => { navigator.clipboard.writeText(resetLinks[t.id]); toast({ title: "Copied" }); }}
                          className="text-xs text-amber-700 hover:text-amber-900 shrink-0"
                        >
                          Copy
                        </button>
                      </div>
                    </div>
                  )}
                </article>
              ))}
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-4 border-t border-neutral-100 pt-4 text-sm text-neutral-500">
                    <span>Page {teacherDirectoryFilters.page} of {teacherDirectoryTotalPages} · {teacherDirectoryTotal} matching</span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="rounded-xl border border-neutral-200 px-3 py-1.5 text-xs hover:bg-neutral-50 transition-colors disabled:opacity-50"
                        disabled={teacherDirectoryLoading || teacherDirectoryFilters.page <= 1}
                        onClick={() => {
                          const next = { ...teacherDirectoryFilters, page: teacherDirectoryFilters.page - 1 };
                          setTeacherDirectoryFilters(next);
                          loadTeacherDirectory(next).catch(() => undefined);
                        }}
                      >
                        Previous
                      </button>
                      <button
                        type="button"
                        className="rounded-xl border border-neutral-200 px-3 py-1.5 text-xs hover:bg-neutral-50 transition-colors disabled:opacity-50"
                        disabled={teacherDirectoryLoading || teacherDirectoryFilters.page >= teacherDirectoryTotalPages}
                        onClick={() => {
                          const next = { ...teacherDirectoryFilters, page: teacherDirectoryFilters.page + 1 };
                          setTeacherDirectoryFilters(next);
                          loadTeacherDirectory(next).catch(() => undefined);
                        }}
                      >
                        Next
                      </button>
                    </div>
                  </div>
                </>
              )
            )}
          </div>
        )}

        {settingsArea === "privacy" && isSchoolMaster && (
          <details className="group rounded-[2rem] border border-neutral-200 bg-white shadow-sm" data-testid="school-data-request-procedure-section">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-8 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-inset">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-1">School Pilot Approval</p>
                <p className="text-sm text-neutral-600">Record the school’s internal approval for use of the e‑Assisted Climb platform in this research pilot. Do not enter passwords, access tokens, identity documents, confidential documents or signed links.</p>
              </div>
              <span className="shrink-0 rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">Manage</span>
            </summary>
            <div className="border-t border-neutral-100 p-8">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">School Pilot Approval</h2>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-medium ${schoolDataRequestProcedure ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`} data-testid="school-data-request-procedure-status">
                  {schoolDataRequestProcedure ? "Approved" : "Not recorded"}
                </span>
              </div>

              {schoolDataRequestProcedure && (
                <p className="mt-4 rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-950">
                  Approved by {schoolDataRequestProcedure.approvedByName} ({schoolDataRequestProcedure.approvedByRole}) on {new Date(`${schoolDataRequestProcedure.approvalDate}T12:00:00`).toLocaleDateString("en-GB")}.
                </p>
              )}

              <form onSubmit={handleSaveSchoolDataRequestProcedure} className="mt-6 space-y-6">
                <fieldset className="space-y-4">
                  <legend className="text-sm font-semibold">DPO or privacy contact</legend>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="block text-sm font-medium">
                      Name
                      <input required minLength={2} maxLength={200} value={schoolDataRequestProcedureForm.privacyContactName} onChange={(event) => setSchoolDataRequestProcedureForm({ ...schoolDataRequestProcedureForm, privacyContactName: event.target.value })} className="mt-2 w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm" />
                    </label>
                    <label className="block text-sm font-medium">
                      Email address
                      <input required type="email" maxLength={320} value={schoolDataRequestProcedureForm.privacyContactEmail} onChange={(event) => setSchoolDataRequestProcedureForm({ ...schoolDataRequestProcedureForm, privacyContactEmail: event.target.value })} className="mt-2 w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm" />
                    </label>
                  </div>
                </fieldset>

                <label className="block border-t border-neutral-100 pt-6 text-sm font-medium">
                  Secure transfer method
                  <textarea required minLength={3} maxLength={2000} rows={3} value={schoolDataRequestProcedureForm.secureTransferMethod} onChange={(event) => setSchoolDataRequestProcedureForm({ ...schoolDataRequestProcedureForm, secureTransferMethod: event.target.value })} placeholder="Short description of the school’s approved secure method" className="mt-2 w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm" />
                  <span className="mt-1 block text-xs font-normal leading-5 text-neutral-500">Do not enter passwords, access tokens, identity documents or signed links.</span>
                </label>

                <label className="block border-t border-neutral-100 pt-6 text-sm font-medium">
                  School privacy information
                  <input required type="url" maxLength={2000} value={schoolDataRequestProcedureForm.privacyInformationLink} onChange={(event) => setSchoolDataRequestProcedureForm({ ...schoolDataRequestProcedureForm, privacyInformationLink: event.target.value })} placeholder="https://school.example/privacy" className="mt-2 w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm" />
                  <span className="mt-1 block text-xs font-normal leading-5 text-neutral-500">Link to the relevant school privacy notice or privacy information.</span>
                </label>

                <fieldset className="space-y-4 border-t border-neutral-100 pt-6">
                  <legend className="text-sm font-semibold">Safeguarding contact</legend>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="block text-sm font-medium">
                      Designated Safeguarding Lead or safeguarding contact name
                      <input required minLength={2} maxLength={200} value={schoolDataRequestProcedureForm.safeguardingContactName} onChange={(event) => setSchoolDataRequestProcedureForm({ ...schoolDataRequestProcedureForm, safeguardingContactName: event.target.value })} className="mt-2 w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm" />
                    </label>
                    <label className="block text-sm font-medium">
                      Safeguarding contact email address
                      <input required type="email" maxLength={320} value={schoolDataRequestProcedureForm.safeguardingContactEmail} onChange={(event) => setSchoolDataRequestProcedureForm({ ...schoolDataRequestProcedureForm, safeguardingContactEmail: event.target.value })} className="mt-2 w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm" />
                    </label>
                  </div>
                </fieldset>

                <fieldset className="space-y-3 border-t border-neutral-100 pt-6">
                  <legend className="text-sm font-semibold">Checks completed</legend>
                  {schoolPilotChecks.map((check) => (
                    <label key={check.value} className="flex items-start gap-3 rounded-2xl border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-800">
                      <input
                        required
                        type="checkbox"
                        checked={schoolDataRequestProcedureForm.checksCompleted.includes(check.value)}
                        onChange={(event) => setSchoolDataRequestProcedureForm({
                          ...schoolDataRequestProcedureForm,
                          checksCompleted: event.target.checked
                            ? [...schoolDataRequestProcedureForm.checksCompleted, check.value]
                            : schoolDataRequestProcedureForm.checksCompleted.filter((value) => value !== check.value),
                        })}
                        className="mt-0.5"
                      />
                      <span>{check.label}</span>
                    </label>
                  ))}
                </fieldset>

                <label className="block border-t border-neutral-100 pt-6 text-sm font-medium">
                  Conditions or restrictions <span className="font-normal text-neutral-500">(optional)</span>
                  <textarea maxLength={2000} rows={4} value={schoolDataRequestProcedureForm.conditionsOrRestrictions} onChange={(event) => setSchoolDataRequestProcedureForm({ ...schoolDataRequestProcedureForm, conditionsOrRestrictions: event.target.value })} placeholder="Record any limitations, outstanding actions or conditions attached to the approval." className="mt-2 w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm" />
                  <span className="mt-1 block text-xs font-normal leading-5 text-neutral-500">Do not upload or paste confidential documents.</span>
                </label>

                <fieldset className="space-y-4 border-t border-neutral-100 pt-6">
                  <legend className="text-sm font-semibold">School approval</legend>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <label className="block text-sm font-medium">
                      Name of person confirming approval
                      <input required minLength={2} maxLength={200} value={schoolDataRequestProcedureForm.approvedByName} onChange={(event) => setSchoolDataRequestProcedureForm({ ...schoolDataRequestProcedureForm, approvedByName: event.target.value })} className="mt-2 w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm" />
                    </label>
                    <label className="block text-sm font-medium">
                      Role
                      <input required minLength={2} maxLength={200} value={schoolDataRequestProcedureForm.approvedByRole} onChange={(event) => setSchoolDataRequestProcedureForm({ ...schoolDataRequestProcedureForm, approvedByRole: event.target.value })} className="mt-2 w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm" />
                    </label>
                    <label className="block text-sm font-medium">
                      Date of approval
                      <input required type="date" max={new Date().toISOString().slice(0, 10)} value={schoolDataRequestProcedureForm.approvalDate} onChange={(event) => setSchoolDataRequestProcedureForm({ ...schoolDataRequestProcedureForm, approvalDate: event.target.value })} className="mt-2 w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm" />
                    </label>
                  </div>
                  <label className="block text-sm font-medium">
                    Review date <span className="font-normal text-neutral-500">(optional)</span>
                    <input type="date" value={schoolDataRequestProcedureForm.reviewDate} onChange={(event) => setSchoolDataRequestProcedureForm({ ...schoolDataRequestProcedureForm, reviewDate: event.target.value })} className="mt-2 w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm sm:max-w-xs" />
                  </label>
                  <label className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                    <input required type="checkbox" checked={schoolDataRequestProcedureForm.finalConfirmation} onChange={(event) => setSchoolDataRequestProcedureForm({ ...schoolDataRequestProcedureForm, finalConfirmation: event.target.checked })} className="mt-0.5" />
                    <span>I confirm that the school has completed its internal data-protection, safeguarding and governance checks and has approved use of the e-Assisted Climb platform for this research pilot, subject to any conditions recorded above.</span>
                  </label>
                </fieldset>

                <button disabled={schoolDataRequestProcedureSaving} className="rounded-2xl bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50" data-testid="save-school-data-request-procedure">
                  {schoolDataRequestProcedureSaving ? "Saving…" : schoolDataRequestProcedure ? "Save changes" : "Save school approval"}
                </button>
              </form>
            </div>
          </details>
        )}

        {settingsArea === "records" && isSchoolMaster && (
          <details open className="group rounded-[2rem] border border-red-200 bg-red-50/40 shadow-sm" data-testid="scheduled-deletions-panel">
            <summary className="flex cursor-pointer list-none items-start justify-between gap-4 p-8 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-red-700">Pending deletion</p>
                <h2 className="mt-1 text-xl font-semibold text-red-950">{formatDeletionRecoveryPeriod(Number(retentionDefaultForm.deletionRecoveryDays) || 30)} recovery period</h2>
                 <p className="mt-2 max-w-3xl text-sm leading-6 text-red-950/75">Delete is separate from Archive. These classes and records are unavailable now, but a School Admin can restore them before the stated deadline. Application-record deletion does not itself prove deletion from backups or external providers.</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-red-800">
                  {recoverableDeletionRequests.classes.length + recoverableDeletionRequests.studentRecords.length} pending
                </span>
                <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full border border-red-200 bg-white text-lg leading-none text-red-800 transition-transform group-open:rotate-180">⌄</span>
              </div>
            </summary>
            <div className="border-t border-red-200/80 px-8 pb-8 pt-5">
              {recoverableDeletionRequestsLoading ? (
                <p className="text-sm text-red-900/70">Loading scheduled deletions…</p>
              ) : recoverableDeletionRequests.classes.length === 0 && recoverableDeletionRequests.studentRecords.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-red-200 bg-white/70 p-4 text-sm text-red-900/70">No class or student records are currently awaiting deletion.</p>
              ) : (
                <>
                  {recoverableDeletionRequests.classes.map((cls) => (
                    <div key={`delete-class-${cls.id}`} className="flex flex-col gap-3 rounded-2xl border border-red-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-sm text-neutral-700"><strong>{cls.name}</strong>{cls.subject ? ` · ${cls.subject}` : ""}<br /><span className="text-xs text-neutral-500">{cls.teacherName} · deletion on {new Date(cls.deletionScheduledFor).toLocaleDateString("en-GB")}</span></p>
                      <button type="button" onClick={() => restoreRecoverableDeletion("class", cls.id)} disabled={restoringRecoverableDeletion === `class-${cls.id}`} className="rounded-xl border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50 disabled:opacity-50">
                        {restoringRecoverableDeletion === `class-${cls.id}` ? "Restoring…" : "Restore class"}
                      </button>
                    </div>
                  ))}
                  {recoverableDeletionRequests.studentRecords.map((record) => (
                    <div key={`delete-student-${record.id}`} className="flex flex-col gap-3 rounded-2xl border border-red-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-sm text-neutral-700"><strong>{record.studentName}</strong> · {record.className}<br /><span className="text-xs text-neutral-500">{record.teacherName} · deletion on {new Date(record.deletionScheduledFor).toLocaleDateString("en-GB")}</span></p>
                      <button type="button" onClick={() => restoreRecoverableDeletion("student", record.id)} disabled={restoringRecoverableDeletion === `student-${record.id}`} className="rounded-xl border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50 disabled:opacity-50">
                        {restoringRecoverableDeletion === `student-${record.id}` ? "Restoring…" : "Restore record"}
                      </button>
                    </div>
                  ))}
                </>
              )}
            </div>
          </details>
        )}

        {settingsArea === "records" && isSchoolMaster && (
          <details open className="group rounded-[2rem] bg-white border border-neutral-200 shadow-sm">
             <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-8 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-1">Archived Teacher Records</p>
                <p className="text-sm text-neutral-600">Read-only departures remain here until their recorded archive end date.</p>
              </div>
               <div className="flex shrink-0 items-center gap-2">
                 <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
                   {recordArchives.length} {recordArchives.length === 1 ? "account" : "accounts"}
                 </span>
                 <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full border border-neutral-200 bg-white text-lg leading-none text-neutral-600 transition-transform group-open:rotate-180">⌄</span>
               </div>
            </summary>
            <div className="border-t border-neutral-100 px-8 pb-8 pt-6">
              <p className="mb-5 rounded-xl border border-sky-100 bg-sky-50 px-4 py-3 text-sm text-sky-950">
                Archived records are kept securely and become read-only. Records pending deletion can be restored until the date shown.
              </p>
              <p className="mb-5 text-sm text-neutral-600">Permanent deletion removes the live central records and cannot be undone.</p>
              {recordArchivesLoading ? (
                <p className="text-sm text-neutral-500">Loading archived records…</p>
              ) : recordArchives.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-500">No teacher records are currently archived.</p>
              ) : (
                <>
                  <form onSubmit={runRecordArchiveSearch} className="space-y-3">
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <label className="relative block min-w-0 flex-1">
                         <span className="sr-only">Search archived records by teacher, class, or archive ID</span>
                        <Search aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
                        <input
                          type="search"
                          value={recordArchiveSearch}
                          onChange={(event) => setRecordArchiveSearch(event.target.value)}
                           placeholder="Search by teacher, class, or archive ID…"
                          className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 py-3 pl-11 pr-4 text-sm outline-none transition-colors placeholder:text-neutral-400 focus:border-neutral-400 focus:bg-white focus:ring-2 focus:ring-neutral-100"
                        />
                      </label>
                      <button
                        type="submit"
                        className="rounded-2xl bg-neutral-900 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-neutral-700"
                      >
                        Search
                      </button>
                    </div>
                  </form>
                   {!showRecordArchiveResults ? (
                    <div className="mt-4 rounded-2xl border border-dashed border-neutral-200 bg-neutral-50 px-4 py-5 text-center">
                      <p className="text-sm text-neutral-600">Archived teacher records are shown below. Use search to narrow the list.</p>
                      <button
                        type="button"
                        onClick={showAllRecordArchives}
                        className="mt-3 rounded-xl border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100"
                      >
                        Show all accounts
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="mt-4 flex items-center justify-between gap-3">
                        <p className="text-xs text-neutral-500">
                          {recordArchiveSearch.trim()
                            ? `Showing records matching “${recordArchiveSearch.trim()}”`
                            : "Showing all archived records"}
                        </p>
                      </div>
                      {filteredRecordArchives.length === 0 ? (
                        <p className="mt-4 rounded-2xl border border-dashed border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-500">
                          No archived records match “{recordArchiveSearch}”.
                        </p>
                      ) : (
                        <div className="mt-4 divide-y divide-neutral-100">
                           {filteredRecordArchives.map((archive) => {
                            const canPermanentlyDelete = new Date(archive.retentionUntil).getTime() <= Date.now();
                            return (
                              <article key={archive.id} className="py-4 first:pt-0 last:pb-0">
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                  <div>
                                     <p className="font-medium text-sm">{archive.teacherName || "Archived teacher"} · Archived record #{archive.id}</p>
                                     {archive.teacherEmail && <p className="mt-1 text-xs text-neutral-500">{archive.teacherEmail}</p>}
                                    <p className="mt-1 text-xs text-neutral-500">
                                      {archive.classCount} archived class{archive.classCount === 1 ? "" : "es"} · Archived {new Date(archive.archivedAt).toLocaleDateString("en-GB")}
                                    </p>
                                     {archive.classNames && (
                                       <p className="mt-1 text-xs text-neutral-600">Classes: {Array.isArray(archive.classNames) ? archive.classNames.join(", ") : archive.classNames}</p>
                                     )}
                                     {archive.reason && <p className="mt-1 text-xs text-neutral-500">Reason: {archive.reason}</p>}
                                     {(archive.accountStatusChangedAt || archive.accountRecoveryUntil || archive.teacherAccountStatus) && (
                                       <p className="mt-1 text-xs text-neutral-500">
                                         Teacher account: {archive.teacherAccountStatus === "deleted" ? "Account access removed" : archive.teacherAccountStatus ?? "Account access removed"}
                                         {archive.accountStatusChangedAt ? ` · status changed ${new Date(archive.accountStatusChangedAt).toLocaleDateString("en-GB")}` : ""}
                                         {archiveAccountRecoveryDeadline(archive) ? ` · recovery until ${archiveAccountRecoveryDeadline(archive)!.toLocaleDateString("en-GB")}` : ""}
                                       </p>
                                     )}
                                  </div>
                                  <div className="shrink-0 sm:text-right">
                                    <p className={`text-xs font-medium ${canPermanentlyDelete ? "text-red-700" : "text-neutral-500"}`}>
                                      {canPermanentlyDelete
                                        ? "Ready for permanent deletion"
                                        : `Retained until ${new Date(archive.retentionUntil).toLocaleDateString("en-GB")}`}
                                    </p>
                                    <div className="mt-2 flex flex-wrap gap-2 sm:justify-end">
                                      <button
                                        type="button"
                                        onClick={() => handleViewArchivedRecords(archive)}
                                        disabled={recordArchiveDetailLoading === archive.id}
                                        className="rounded-xl border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-50 disabled:opacity-50"
                                      >
                                        {recordArchiveDetailLoading === archive.id ? "Opening…" : "View records"}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => requestArchivedExport(archive)}
                                        disabled={archiveExporting === archive.id}
                                        className="rounded-xl border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-50 disabled:opacity-50"
                                      >
                                        {archiveExporting === archive.id ? "Preparing…" : "Download records"}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handlePermanentArchiveDelete(archive)}
                                        disabled={!canPermanentlyDelete || permanentlyDeletingArchive === archive.id}
                                        className="rounded-xl border border-red-200 px-3 py-1.5 text-xs text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                                      >
                                        {permanentlyDeletingArchive === archive.id ? "Deleting…" : "Permanently delete"}
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              </article>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
              <div className="mt-6 border-t border-neutral-100 pt-5">
                <p className="text-xs uppercase tracking-[0.2em] text-neutral-400">Final deletion lifecycle</p>
                <p className="mt-1 text-xs text-neutral-500">Application records and AWS backup/storage expiry are tracked separately. A pending backup state is not a claim of full AWS erasure.</p>
                {recordDeletionEvidenceLoading ? (
                  <p className="mt-3 text-sm text-neutral-500">Loading final deletion evidence…</p>
                ) : recordDeletionEvidence.length === 0 ? (
                  <p className="mt-3 text-sm text-neutral-500">No archived teacher records have been permanently deleted.</p>
                ) : (
                  <div className="mt-3 space-y-3">
                    {recordDeletionEvidence.map((evidence) => (
                      <article key={evidence.id} className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4 text-sm">
                        <p className="font-medium text-neutral-800">Application records purged {new Date(evidence.applicationRecordsPurgedAt).toLocaleDateString("en-GB")}</p>
                        <p className="mt-1 text-xs text-neutral-500">
                          Managed file objects: {evidence.managedFileObjectsStatus === "not_applicable" ? "none are stored by this application" : "purged"}.
                        </p>
                        <p className={`mt-2 text-xs font-medium ${evidence.backupStorage.status === "verified" ? "text-emerald-700" : "text-amber-700"}`}>
                          AWS backup/storage expiry: {evidence.backupStorage.status === "verified"
                            ? `verified${evidence.backupStorage.verifiedAt ? ` on ${new Date(evidence.backupStorage.verifiedAt).toLocaleDateString("en-GB")}` : ""}`
                            : evidence.backupStorage.configured && evidence.backupStorage.expiresAt
                              ? `pending until ${new Date(evidence.backupStorage.expiresAt).toLocaleDateString("en-GB")}`
                              : "pending — deployment lifecycle evidence has not been recorded"}
                        </p>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </details>
        )}

        {recordArchiveDetail && (
          <div className="fixed inset-0 z-[100] flex items-end bg-black/40 p-4 sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-label="Archived teacher records">
            <div className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-[2rem] bg-white p-6 shadow-2xl sm:p-8">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-neutral-400">Archived teacher records</p>
                  <h2 className="mt-1 text-xl font-semibold">Archived record #{recordArchiveDetail.id}</h2>
                  <p className="mt-1 text-sm text-neutral-500">
                    Read-only until {new Date(recordArchiveDetail.retentionUntil).toLocaleDateString("en-GB")}
                  </p>
                  <p className="mt-1 text-sm text-neutral-600">
                    {recordArchiveDetail.teacherName || "Archived teacher"}
                    {recordArchiveDetail.teacherEmail ? ` · ${recordArchiveDetail.teacherEmail}` : ""}
                    {recordArchiveDetail.reason ? ` · ${recordArchiveDetail.reason}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-neutral-500">
                    Account status: {recordArchiveDetail.teacherAccountStatus === "deleted" ? "Account access removed" : recordArchiveDetail.teacherAccountStatus ?? "Account access removed"}
                    {recordArchiveDetail.accountStatusChangedAt ? ` · changed ${new Date(recordArchiveDetail.accountStatusChangedAt).toLocaleDateString("en-GB")}` : ""}
                    {archiveAccountRecoveryDeadline(recordArchiveDetail) ? ` · recovery until ${archiveAccountRecoveryDeadline(recordArchiveDetail)!.toLocaleDateString("en-GB")}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => { setRecordArchiveDetail(null); setArchivedStudentDetail(null); }}
                  className="rounded-xl px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100"
                >
                  Close
                </button>
              </div>

              {archivedStudentDetail ? (
                <div className="mt-6">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-100 pb-4">
                    <div>
                      <p className="text-xs uppercase tracking-[0.16em] text-neutral-400">Student record · Read only</p>
                      <h3 className="mt-1 text-lg font-semibold">{archivedStudentDetail.session.studentName}</h3>
                      <p className="mt-1 text-xs text-neutral-500">Joined {new Date(archivedStudentDetail.session.createdAt).toLocaleDateString("en-GB")}</p>
                    </div>
                    <button type="button" onClick={() => setArchivedStudentDetail(null)} className="rounded-xl border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50">
                      Back to archived classes
                    </button>
                  </div>

                  <section className="mt-5">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-400">Learning stages</p>
                    {archivedStudentDetail.stageEntries.length === 0 ? (
                      <p className="mt-2 text-sm text-neutral-500">No stage work was recorded for this student.</p>
                    ) : (
                      <div className="mt-3 space-y-3">
                        {archivedStudentDetail.stageEntries.map((entry) => (
                          <article key={entry.id} className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
                            <div className="flex items-center justify-between gap-3">
                              <p className="text-sm font-medium">{entry.stage}</p>
                              <p className="text-xs text-neutral-400">Updated {new Date(entry.updatedAt).toLocaleDateString("en-GB")}</p>
                            </div>
                            <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-white p-3 text-xs leading-relaxed text-neutral-700">
                              {JSON.stringify(entry.contentJson, null, 2)}
                            </pre>
                          </article>
                        ))}
                      </div>
                    )}
                  </section>

                  <section className="mt-6">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-400">AI conversation history</p>
                    {archivedStudentDetail.chatMessages.length === 0 ? (
                      <p className="mt-2 text-sm text-neutral-500">No AI conversation was retained for this student.</p>
                    ) : (
                      <div className="mt-3 space-y-2">
                        {archivedStudentDetail.chatMessages.map((message) => (
                          <article key={message.id} className={`rounded-2xl border p-4 text-sm ${message.role === "user" ? "border-neutral-200 bg-white" : "border-amber-100 bg-amber-50/60"}`}>
                            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.12em] text-neutral-400">{message.role === "user" ? "Student" : "Assistant"}</p>
                            <p className="whitespace-pre-wrap text-neutral-700">{message.content}</p>
                          </article>
                        ))}
                      </div>
                    )}
                  </section>
                </div>
              ) : (
                <div className="mt-6 space-y-4">
                  <p className="rounded-2xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-950">
                    This summary intentionally hides student names, work, and chats. Restoring a class assigns it to an active teacher; scheduling deletion starts a separate {platformRetentionPolicy.deletionRecoveryDays || 30}-day recovery period for application records.
                  </p>
                  {recordArchiveDetail.classes.length === 0 ? (
                    <p className="rounded-2xl border border-dashed border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-500">No classes were retained in this archive.</p>
                  ) : (
                    recordArchiveDetail.classes.map((cls) => (
                      <section key={cls.id} className="rounded-2xl border border-neutral-200 p-5">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <h3 className="text-base font-semibold">{cls.name}{cls.subject ? ` · ${cls.subject}` : ""}</h3>
                          </div>
                          <p className="text-xs text-neutral-400">{cls.studentRecordCount} student record{cls.studentRecordCount === 1 ? "" : "s"}</p>
                        </div>
                        <p className="mt-3 text-xs text-neutral-500">
                          {cls.stageEntryCount} work update{cls.stageEntryCount === 1 ? "" : "s"} · {cls.chatMessageCount} chat message{cls.chatMessageCount === 1 ? "" : "s"}
                        </p>
                        <div className="mt-4 rounded-xl border border-sky-100 bg-sky-50/50 p-3">
                          <label className="block text-xs font-medium text-neutral-700">
                            Destination active teacher
                            <select
                              data-testid={`select-archive-destination-${cls.id}`}
                              value={archiveClassAssignments[cls.id] ?? ""}
                              onChange={(event) => setArchiveClassAssignments((current) => ({ ...current, [cls.id]: event.target.value }))}
                              className="mt-1 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm font-normal"
                            >
                              <option value="">Choose a teacher to restore and assign</option>
                              {archiveDestinationTeachers.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.email}</option>)}
                            </select>
                          </label>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <button type="button" data-testid={`button-restore-archived-class-${cls.id}`} onClick={() => restoreArchivedClass(recordArchiveDetail, cls)} disabled={archiveClassAction === `restore-${cls.id}`} className="rounded-xl bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-50">
                              {archiveClassAction === `restore-${cls.id}` ? "Restoring…" : "Restore and assign"}
                            </button>
                            <button type="button" data-testid={`button-schedule-deletion-${cls.id}`} onClick={() => scheduleArchivedClassDeletion(recordArchiveDetail, cls)} disabled={archiveClassAction === `delete-${cls.id}`} className="rounded-xl border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50">
                              {archiveClassAction === `delete-${cls.id}` ? "Scheduling…" : "Schedule deletion"}
                            </button>
                          </div>
                          <p className="mt-2 text-xs leading-5 text-neutral-500">
                            Schedule deletion is separate from restore. Records remain recoverable for {platformRetentionPolicy.deletionRecoveryDays || 30} configured days, until the deadline returned by the platform.
                          </p>
                        </div>
                        {cls.students.length === 0 ? (
                          <p className="mt-4 text-sm text-neutral-500">No student records were retained for this class.</p>
                        ) : (
                          <ul className="mt-4 divide-y divide-neutral-100 border-y border-neutral-100">
                            {cls.students.map((student) => (
                              <li key={student.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                                <div>
                                  <p className="text-sm font-medium">{student.label}</p>
                                  <p className="mt-1 text-xs text-neutral-500">
                                    Created {new Date(student.createdAt).toLocaleDateString("en-GB")} · Detailed contents hidden by default
                                  </p>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => requestArchivedStudentAccess(recordArchiveDetail, cls, student)}
                                  disabled={archivedStudentLoading === student.id}
                                  className="rounded-xl border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
                                >
                                  {archivedStudentLoading === student.id ? "Opening…" : "Request detailed access"}
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </section>
                    ))
                  )}
                </div>
              )}
            </div>

            <div className="hidden" aria-hidden="true">
              <div>
                <h3 className="text-sm font-semibold">Restriction and hold evidence</h3>
                <p className="mt-1 text-xs leading-5 text-neutral-500">
                   Only the School Admin can apply, review, expire, or lift these controls. Holds always pause deletion, but do not automatically block a lawful access export. Restrictions pause only the access or processing selected below.
                </p>
              </div>

              <form onSubmit={handleCreateStudentDataRequestControl} className="space-y-4 rounded-2xl border border-neutral-200 p-5">
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="text-sm font-medium">
                    Request
                    <select
                      required
                      value={studentDataRequestControlForm.requestId}
                      onChange={(event) => setStudentDataRequestControlForm({ ...studentDataRequestControlForm, requestId: event.target.value })}
                      className="mt-2 w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm"
                      data-testid="student-data-control-request"
                    >
                      <option value="">Choose a request</option>
                      {studentDataRequests.map((request) => (
                        <option key={request.id} value={request.id}>Request #{request.id} · {request.requestType} · {request.className}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm font-medium">
                    Control kind
                    <select
                      value={studentDataRequestControlForm.kind}
                      onChange={(event) => {
                        const kind = event.target.value as StudentDataRequestControl["kind"];
                        setStudentDataRequestControlForm({
                          ...studentDataRequestControlForm,
                          kind,
                          reasonCategory: kind === "restriction" ? "accuracy_dispute" : kind === "legal_hold" ? "legal_claim" : "safeguarding",
                          processingLimits: kind === "restriction" ? studentDataRequestControlForm.processingLimits : ["deletion"],
                        });
                      }}
                      className="mt-2 w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm"
                    >
                      <option value="restriction">Processing restriction</option>
                      <option value="legal_hold">Legal hold</option>
                      <option value="safeguarding_hold">Safeguarding hold</option>
                    </select>
                  </label>
                  <label className="text-sm font-medium">
                    Reason category
                    <select
                      value={studentDataRequestControlForm.reasonCategory}
                      onChange={(event) => setStudentDataRequestControlForm({
                        ...studentDataRequestControlForm,
                        reasonCategory: event.target.value as StudentDataRequestControl["reasonCategory"],
                      })}
                      className="mt-2 w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm"
                    >
                      {["accuracy_dispute", "objection", "legal_claim", "complaint", "investigation", "safeguarding", "retention_duty", "other"].map((category) => (
                        <option key={category} value={category}>{category.replaceAll("_", " ")}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="block text-sm font-medium">
                  Minimal reason reference
                  <textarea
                    required
                    minLength={3}
                    maxLength={160}
                    rows={2}
                    value={studentDataRequestControlForm.reasonSummary}
                    onChange={(event) => setStudentDataRequestControlForm({ ...studentDataRequestControlForm, reasonSummary: event.target.value })}
                    placeholder="Reference the decision or restricted case record; do not paste student work, chats, identity documents, or safeguarding detail."
                    className="mt-2 w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm"
                  />
                </label>
                <div className="grid gap-4 sm:grid-cols-3">
                  <fieldset>
                    <legend className="text-sm font-medium">Data categories</legend>
                    {["identity", "learning", "activity", "feedback", "ai_conversations"].map((category) => (
                      <label key={category} className="mt-2 flex items-center gap-2 text-xs text-neutral-600">
                        <input
                          type="checkbox"
                          checked={studentDataRequestControlForm.affectedDataCategories.includes(category)}
                          onChange={(event) => setStudentDataRequestControlForm({
                            ...studentDataRequestControlForm,
                            affectedDataCategories: event.target.checked
                              ? [...studentDataRequestControlForm.affectedDataCategories, category]
                              : studentDataRequestControlForm.affectedDataCategories.filter((item) => item !== category),
                          })}
                        />
                        {category.replaceAll("_", " ")}
                      </label>
                    ))}
                  </fieldset>
                  <fieldset>
                    <legend className="text-sm font-medium">Access limits</legend>
                    {["export"].map((limit) => (
                      <label key={limit} className="mt-2 flex items-center gap-2 text-xs text-neutral-600">
                        <input
                          type="checkbox"
                          checked={studentDataRequestControlForm.accessLimits.includes(limit)}
                          onChange={(event) => setStudentDataRequestControlForm({
                            ...studentDataRequestControlForm,
                            accessLimits: event.target.checked
                              ? [...studentDataRequestControlForm.accessLimits, limit]
                              : studentDataRequestControlForm.accessLimits.filter((item) => item !== limit),
                          })}
                        />
                        {limit.replaceAll("_", " ")}
                      </label>
                    ))}
                  </fieldset>
                  <fieldset>
                    <legend className="text-sm font-medium">Processing limits</legend>
                    {["deletion", "export"].map((limit) => (
                      <label key={limit} className="mt-2 flex items-center gap-2 text-xs text-neutral-600">
                        <input
                          type="checkbox"
                          disabled={limit === "deletion" && studentDataRequestControlForm.kind !== "restriction"}
                          checked={studentDataRequestControlForm.processingLimits.includes(limit)}
                          onChange={(event) => setStudentDataRequestControlForm({
                            ...studentDataRequestControlForm,
                            processingLimits: event.target.checked
                              ? [...studentDataRequestControlForm.processingLimits, limit]
                              : studentDataRequestControlForm.processingLimits.filter((item) => item !== limit),
                          })}
                        />
                        {limit.replaceAll("_", " ")}
                      </label>
                    ))}
                  </fieldset>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="text-sm font-medium">Start date<input required type="date" value={studentDataRequestControlForm.startDate} onChange={(event) => setStudentDataRequestControlForm({ ...studentDataRequestControlForm, startDate: event.target.value })} className="mt-2 w-full rounded-2xl border border-neutral-200 px-4 py-3" /></label>
                  <label className="text-sm font-medium">Review date<input required type="date" value={studentDataRequestControlForm.reviewDate} onChange={(event) => setStudentDataRequestControlForm({ ...studentDataRequestControlForm, reviewDate: event.target.value })} className="mt-2 w-full rounded-2xl border border-neutral-200 px-4 py-3" /></label>
                  <label className="text-sm font-medium">Optional expiry date<input type="date" value={studentDataRequestControlForm.expiryDate} onChange={(event) => setStudentDataRequestControlForm({ ...studentDataRequestControlForm, expiryDate: event.target.value })} className="mt-2 w-full rounded-2xl border border-neutral-200 px-4 py-3" /></label>
                </div>
                <button disabled={studentDataRequestControlSaving} className="rounded-2xl bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50" data-testid="apply-student-data-control">
                  {studentDataRequestControlSaving ? "Applying…" : "Apply control"}
                </button>
              </form>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h4 className="text-sm font-semibold">Active and historical controls</h4>
                  <button type="button" onClick={() => void loadStudentDataRequestControls()} disabled={studentDataRequestControlsLoading} className="rounded-2xl border border-neutral-300 px-4 py-2 text-sm disabled:opacity-50">Refresh</button>
                </div>
                {studentDataRequestControls.length === 0 ? (
                  <p className="rounded-2xl bg-neutral-50 p-4 text-sm text-neutral-500">No request-linked controls have been recorded.</p>
                ) : studentDataRequestControls.map((control) => {
                  const now = new Date();
                  const reviewOverdue = control.lifecycleState === "active" && new Date(control.reviewDate) < now;
                  const expiryDue = Boolean(control.expiryDate && new Date(control.expiryDate) <= now);
                  return (
                    <div key={control.id} className="rounded-2xl border border-neutral-200 p-5" data-testid={`student-data-control-${control.id}`}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold capitalize">{control.kind.replaceAll("_", " ")} · request #{control.requestId ?? "removed"}</p>
                          <p className="mt-1 text-xs text-neutral-500">Owner account #{control.accountableOwnerTeacherId ?? "removed"} · applied {new Date(control.createdAt).toLocaleDateString("en-GB")}</p>
                        </div>
                        <span className={`rounded-full px-3 py-1 text-xs font-medium ${reviewOverdue ? "bg-red-100 text-red-800" : control.lifecycleState === "active" ? "bg-amber-100 text-amber-900" : "bg-neutral-100 text-neutral-700"}`}>
                          {reviewOverdue ? "Review overdue" : control.lifecycleState}
                        </span>
                      </div>
                      <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
                        <div><dt className="font-medium uppercase tracking-wide text-neutral-400">Reason</dt><dd className="mt-1">{control.reasonCategory.replaceAll("_", " ")} · {control.reasonSummary}</dd></div>
                        <div><dt className="font-medium uppercase tracking-wide text-neutral-400">Scope</dt><dd className="mt-1">Student ref #{control.affectedStudentSessionId ?? "removed"} · class ref #{control.affectedClassId ?? "removed"} · {control.affectedDataCategories.join(", ")}</dd></div>
                        <div><dt className="font-medium uppercase tracking-wide text-neutral-400">Limits</dt><dd className="mt-1">Access: {control.accessLimits.join(", ") || "none"} · Processing: {control.processingLimits.join(", ") || "none"}</dd></div>
                        <div><dt className="font-medium uppercase tracking-wide text-neutral-400">Dates</dt><dd className="mt-1">Review {new Date(control.reviewDate).toLocaleDateString("en-GB")} · expiry {control.expiryDate ? new Date(control.expiryDate).toLocaleDateString("en-GB") : "not set"}</dd></div>
                      </dl>
                      {control.lifecycleState === "active" && (
                        <div className="mt-4 flex flex-wrap gap-2">
                          <button type="button" disabled={studentDataRequestControlAction === control.id} onClick={() => void handleStudentDataRequestControlAction(control, "review")} className="rounded-2xl border border-neutral-300 px-4 py-2 text-xs">Record review</button>
                          {expiryDue && <button type="button" disabled={studentDataRequestControlAction === control.id} onClick={() => void handleStudentDataRequestControlAction(control, "expire")} className="rounded-2xl border border-amber-300 px-4 py-2 text-xs text-amber-900">Confirm expiry</button>}
                          <button type="button" disabled={studentDataRequestControlAction === control.id} onClick={() => void handleStudentDataRequestControlAction(control, "lift")} className="rounded-2xl border border-red-300 px-4 py-2 text-xs text-red-800">Lift control</button>
                        </div>
                      )}
                      <ol className="mt-4 space-y-2 border-t border-neutral-100 pt-3 text-xs text-neutral-600">
                        {control.events.map((event) => <li key={event.id}><span className="font-medium capitalize">{event.eventType}</span> by account #{event.actorTeacherId ?? "removed"} on {new Date(event.occurredAt).toLocaleDateString("en-GB")} — {event.note}</li>)}
                      </ol>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {archiveAccessRequest && (
          <div className="fixed inset-0 z-[110] flex items-end bg-black/50 p-4 sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-label="Request detailed archive access">
            <form onSubmit={handleSubmitArchiveAccess} className="w-full max-w-xl rounded-[2rem] bg-white p-6 shadow-2xl sm:p-8">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-neutral-400">Protected archive access</p>
                  <h2 className="mt-1 text-xl font-semibold">
                    {archiveAccessRequest.type === "student" ? "View detailed student work and chats" : "Download detailed archive records"}
                  </h2>
                  <p className="mt-2 text-sm text-neutral-600">
                    {archiveAccessRequest.type === "student"
                      ? `${archiveAccessRequest.student.label} is currently hidden by default.`
                      : "This download includes student names, work, chat history, feedback, and activity records."}
                    {" "}State the school purpose before continuing. Your role, scope, and purpose will be recorded.
                  </p>
                </div>
                <button type="button" onClick={() => setArchiveAccessRequest(null)} disabled={archiveAccessSubmitting} className="rounded-xl px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 disabled:opacity-50">
                  Close
                </button>
              </div>
              <label className="mt-6 block text-sm font-medium text-neutral-800">
                Why is this detailed access needed?
                <textarea
                  required
                  minLength={10}
                  maxLength={500}
                  rows={4}
                  value={archiveAccessPurpose}
                  onChange={(event) => setArchiveAccessPurpose(event.target.value)}
                   placeholder="For example: safeguarding review requested by the School Admin."
                  className="mt-2 w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm outline-none transition-colors focus:border-neutral-500 focus:ring-2 focus:ring-neutral-100"
                />
              </label>
              <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-2xl border border-amber-100 bg-amber-50 p-4 text-sm text-amber-950">
                <input type="checkbox" checked={archiveAccessConfirmed} onChange={(event) => setArchiveAccessConfirmed(event.target.checked)} className="mt-0.5 h-4 w-4" />
                <span>I confirm that this detailed access is necessary for the stated school purpose and that I will handle the information securely.</span>
              </label>
              <div className="mt-6 flex flex-wrap justify-end gap-3">
                <button type="button" onClick={() => setArchiveAccessRequest(null)} disabled={archiveAccessSubmitting} className="rounded-xl border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50">
                  Cancel
                </button>
                <button type="submit" disabled={archiveAccessSubmitting || archiveAccessPurpose.trim().length < 10 || !archiveAccessConfirmed} className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50">
                  {archiveAccessSubmitting ? "Recording access…" : archiveAccessRequest.type === "student" ? "Confirm and view details" : "Confirm and download"}
                </button>
              </div>
            </form>
          </div>
        )}

        {classTransferSummary && (
          <div className="fixed inset-0 z-[100] flex items-end bg-black/40 p-4 sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-label="Transfer a class">
            <form onSubmit={handleTransferClass} className="w-full max-w-xl rounded-[2rem] bg-white p-6 shadow-2xl sm:p-8">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-sky-700">Class ownership</p>
                  <h2 className="mt-1 text-xl font-semibold">Transfer a class</h2>
                  <p className="mt-2 text-sm text-neutral-600">This changes only the selected class assignment. The teacher’s account status is not changed.</p>
                </div>
                <button type="button" onClick={() => setClassTransferSummary(null)} disabled={classTransferSaving} className="rounded-xl px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100">Close</button>
              </div>
              {classTransferSummary.classes.length === 0 ? (
                <p className="mt-6 rounded-xl border border-dashed border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-500">This teacher has no active classes to transfer.</p>
              ) : (
                <div className="mt-6 space-y-4">
                  <label className="block text-sm font-medium">
                    Class
                    <select required value={classTransferClassId} onChange={(event) => setClassTransferClassId(event.target.value)} className="mt-2 w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm font-normal">
                      <option value="">Choose one class</option>
                      {classTransferSummary.classes.map((cls) => <option key={cls.id} value={cls.id}>{cls.name}{cls.subject ? ` · ${cls.subject}` : ""}</option>)}
                    </select>
                  </label>
                  <label className="block text-sm font-medium">
                    Active destination teacher
                    <select required value={classTransferTeacherId} onChange={(event) => setClassTransferTeacherId(event.target.value)} className="mt-2 w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm font-normal">
                      <option value="">Choose an active teacher</option>
                      {classTransferTeachers.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.email}</option>)}
                    </select>
                  </label>
                </div>
              )}
              <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button type="button" onClick={() => setClassTransferSummary(null)} disabled={classTransferSaving} className="rounded-xl border border-neutral-200 px-4 py-2 text-sm hover:bg-neutral-50">Cancel</button>
                <button type="submit" disabled={classTransferSaving || classTransferSummary.classes.length === 0} className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50">{classTransferSaving ? "Transferring…" : "Transfer class"}</button>
              </div>
            </form>
          </div>
        )}

        {departureSummary && (
          <div className="fixed inset-0 z-[100] flex items-end bg-black/40 p-4 sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-label="Manage departing teacher records">
            <form onSubmit={handleSaveDeparture} className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-[2rem] bg-white p-6 shadow-2xl sm:p-8">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-neutral-400">Departing teacher</p>
                  <h2 className="mt-1 text-xl font-semibold">{departureSummary.teacher.name}</h2>
                  <p className="mt-1 text-sm text-neutral-500">{departureSummary.classes.length} class{departureSummary.classes.length === 1 ? "" : "es"} · {departureSummary.studentCount} student record{departureSummary.studentCount === 1 ? "" : "s"}</p>
                </div>
                <button type="button" onClick={() => setDepartureSummary(null)} disabled={departureSaving} className="rounded-xl px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100">Close</button>
              </div>

              <div className="mt-5 rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-400">Classes affected</p>
                {departureSummary.classes.length === 0 ? (
                  <p className="mt-2 text-sm text-neutral-500">This teacher has no classes to transfer or archive.</p>
                ) : (
                  <ul className="mt-2 space-y-1 text-sm text-neutral-700">
                    {departureSummary.classes.map((cls) => <li key={cls.id}>{cls.name}{cls.subject ? ` · ${cls.subject}` : ""}</li>)}
                  </ul>
                )}
              </div>

              <fieldset className="mt-5 space-y-3">
                <legend className="text-sm font-medium">Choose an action for each class</legend>
                <p className="text-xs leading-5 text-neutral-500">
                  The teacher’s access is removed after this submission. Account access can be recovered until the deadline returned by the platform.
                </p>
                {departureSummary.classes.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-500">This teacher has no classes to transfer or archive.</p>
                ) : departureSummary.classes.map((cls) => {
                  const action = departureActions[cls.id] ?? "archive";
                  return (
                    <div key={cls.id} className={`rounded-xl border p-3 ${action === "archive" ? "border-amber-200 bg-amber-50/60" : "border-neutral-200 bg-neutral-50"}`}>
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <span className="text-sm font-medium">{cls.name}{cls.subject ? ` · ${cls.subject}` : ""}</span>
                        <div className="flex flex-wrap gap-2" role="group" aria-label={`Action for ${cls.name}`}>
                          <button type="button" data-testid={`button-archive-class-${cls.id}`} onClick={() => setDepartureActions((current) => ({ ...current, [cls.id]: "archive" }))} className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${action === "archive" ? "border-amber-700 bg-amber-700 text-white" : "border-neutral-300 bg-white text-neutral-700"}`}>Archive</button>
                          <button type="button" data-testid={`button-transfer-departing-class-${cls.id}`} onClick={() => setDepartureActions((current) => ({ ...current, [cls.id]: "transfer" }))} className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${action === "transfer" ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-300 bg-white text-neutral-700"}`}>Transfer</button>
                        </div>
                      </div>
                      {action === "transfer" ? (
                        <label className="mt-3 block text-xs font-medium text-neutral-700">
                          Replacement active teacher
                          <select required value={transferAssignments[cls.id] ?? ""} onChange={(event) => setTransferAssignments((current) => ({ ...current, [cls.id]: event.target.value }))} className="mt-1 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm font-normal">
                            <option value="">Choose an active teacher</option>
                            {replacementTeachers.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.email}</option>)}
                          </select>
                        </label>
                      ) : (
                        <p className="mt-2 text-xs leading-5 text-amber-950">Read-only in the protected archive for the configured retention period; this is separate from scheduled deletion.</p>
                      )}
                    </div>
                  );
                })}
              </fieldset>

              <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button type="button" onClick={() => setDepartureSummary(null)} disabled={departureSaving} className="rounded-xl border border-neutral-200 px-4 py-2 text-sm hover:bg-neutral-50">Cancel</button>
                <button type="submit" disabled={departureSaving} className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50">
                  {departureSaving ? "Saving…" : "Save actions and remove access"}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* AI Configuration */}
        {settingsArea === "security" && (isSchoolMaster ? (
          <details className="group rounded-[2rem] bg-white border border-neutral-200 shadow-sm">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-8 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-inset">
              <span className="text-xs uppercase tracking-[0.2em] text-neutral-400">AI Configuration</span>
              <span className="shrink-0 rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">Manage</span>
            </summary>
            <div className="space-y-4 border-t border-neutral-100 p-8">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-1">Provider and approval</p>
                <p className="text-sm text-neutral-600">Choose a supported provider, then record your school's approval before external AI can be used. You can leave external AI off.</p>
              </div>
              {aiSettings && !showAiForm && (
                <div className="flex flex-wrap justify-end gap-2">
                  <button
                    onClick={showAiApprovalForm}
                    className="rounded-2xl border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50 transition-colors"
                  >
                    {aiSettings.configured ? "Update provider" : "Configure provider"}
                  </button>
                  {aiSettings.configured && (
                    <button
                      type="button"
                      onClick={handleDisableAiSettings}
                      disabled={aiDisableLoading}
                      className="rounded-2xl border border-red-200 px-4 py-2 text-sm text-red-700 hover:bg-red-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {aiDisableLoading ? "Disabling…" : "Disable AI connection"}
                    </button>
                  )}
                </div>
              )}
            </div>

            {aiSettings?.configured && aiSettings.dataProcessingAcknowledged && !showAiForm ? (
              <div className="rounded-2xl bg-neutral-50 border border-neutral-100 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                  <p className="text-sm font-medium">
                     {aiSettings.aiProvider === "gemini" ? "Google Gemini" : aiSettings.aiProvider === "azure" ? "Microsoft Azure OpenAI" : "Unsupported provider"} — configured
                  </p>
                </div>
                 <dl className="grid grid-cols-1 gap-2 pt-2 text-xs text-neutral-500 sm:grid-cols-2">
                   <div><dt className="text-neutral-400">Processing region</dt><dd className="font-medium text-neutral-700">{aiSettings.dataProcessingRegion ?? "Not recorded"}</dd></div>
                   <div><dt className="text-neutral-400">Approval recorded</dt><dd className="font-medium text-neutral-700">{aiSettings.dataProcessingAcknowledgedAt ? new Date(aiSettings.dataProcessingAcknowledgedAt).toLocaleDateString("en-GB") : "Not recorded"}</dd></div>
                 </dl>
               </div>
            ) : aiSettings && !aiSettings.configured && !showAiForm ? (
              <div className="rounded-2xl bg-neutral-50 border border-neutral-100 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-neutral-400 shrink-0" />
                  <p className="text-sm font-medium">No external AI is enabled</p>
                </div>
                <p className="pl-4 text-sm text-neutral-600">Student and teacher learning data will stay in the school system until a supported provider is configured and approved.</p>
              </div>
            ) : aiSettings?.configured && !showAiForm ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
                  <p className="text-sm font-medium text-amber-950">Provider configured — approval required</p>
                </div>
                 <p className="pl-4 text-sm text-amber-900">External AI remains blocked until the School Admin records all three required confirmations.</p>
              </div>
            ) : (
              (
                <form onSubmit={handleSaveAiSettings} className="space-y-4 pt-2">
                  <div>
                    <label className="block text-sm font-medium mb-2">AI provider</label>
                    <div className="flex gap-3">
                      {(["gemini", "azure"] as const).map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setAiForm({ ...aiForm, aiProvider: p })}
                          className={`flex-1 rounded-2xl border py-2.5 text-sm font-medium transition-colors ${
                            aiForm.aiProvider === p ? "border-black bg-black text-white" : "border-neutral-200 hover:border-neutral-400"
                          }`}
                        >
                       {p === "gemini" ? "Google Gemini" : "Microsoft Azure OpenAI"}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">{aiForm.aiProvider === "gemini" ? "Google Gemini API key" : aiForm.aiProvider === "azure" ? "Microsoft Azure OpenAI API key" : "API key"}</label>
                    <input
                      required
                      type="password"
                      value={aiForm.aiKey}
                      onChange={(e) => setAiForm({ ...aiForm, aiKey: e.target.value })}
                      placeholder="Paste your API key here"
                      className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10 font-mono text-sm"
                    />
                  </div>
                  {aiForm.aiProvider === "azure" && (
                    <div>
                      <label className="block text-sm font-medium mb-2">Azure Endpoint</label>
                      <input
                        required
                        type="url"
                        value={aiForm.azureEndpoint}
                        onChange={(e) => setAiForm({ ...aiForm, azureEndpoint: e.target.value })}
                        placeholder="https://your-resource.openai.azure.com"
                        className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10 text-sm"
                      />
                      <p className="mt-1 text-xs text-neutral-500">
                        Deploy the model in Azure with the deployment name <span className="font-mono">gpt-4o</span>. Enter the resource endpoint only, without an API path.
                      </p>
                    </div>
                  )}
                  <div className="space-y-3">
                    <p className="text-sm font-medium">School approval</p>
                    <label className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                      <input
                        type="checkbox"
                        checked={aiApprovals.schoolAuthorised}
                        onChange={(event) => setAiApprovals({ ...aiApprovals, schoolAuthorised: event.target.checked })}
                        className="mt-1 h-4 w-4"
                      />
                      <span>I am authorised by this school to enable {aiForm.aiProvider === "gemini" ? "Google Gemini" : aiForm.aiProvider === "azure" ? "Microsoft Azure OpenAI" : "the selected provider"}.</span>
                    </label>
                    <label className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                      <input
                        type="checkbox"
                        checked={aiApprovals.termsAccepted}
                        onChange={(event) => setAiApprovals({ ...aiApprovals, termsAccepted: event.target.checked })}
                        className="mt-1 h-4 w-4"
                      />
                      <span>The school has reviewed and accepted this provider's data-processing, retention, and no-training terms.</span>
                    </label>
                    <label className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                      <input
                        type="checkbox"
                        checked={aiApprovals.ukProcessingConfirmed}
                        onChange={(event) => setAiApprovals({ ...aiApprovals, ukProcessingConfirmed: event.target.checked })}
                        className="mt-1 h-4 w-4"
                      />
                      <span>I confirm that this school's approved processing region is the United Kingdom (UK).</span>
                    </label>
                    <p className="px-1 text-xs text-neutral-500">These confirmations do not replace the school’s own governance responsibilities. The Assisted Climb does not check these policies.</p>
                  </div>
                   <details className="rounded-2xl border border-neutral-200 p-4">
                     <summary className="cursor-pointer text-sm font-medium">Advanced evidence (optional)</summary>
                    <div className="mt-4 space-y-4">
                      <div>
                          <label className="block text-sm font-medium mb-2">Provider terms or policy version</label>
                        <input
                          value={aiCompliance.policyVersion}
                          onChange={(event) => setAiCompliance({ ...aiCompliance, policyVersion: event.target.value })}
                          placeholder="e.g. DPA v3.2"
                          className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                        />
                      </div>
                       <div>
                         <label className="block text-sm font-medium mb-2">Terms review date</label>
                         <input
                           type="date"
                           value={aiCompliance.reviewDate}
                           onChange={(event) => setAiCompliance({ ...aiCompliance, reviewDate: event.target.value })}
                           className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                         />
                         <p className="mt-1 text-xs text-neutral-500">Optional: the date the school reviewed the provider terms. The approval timestamp is recorded by the server.</p>
                       </div>
                      <div>
                        <label className="block text-sm font-medium mb-2">School record reference</label>
                        <input
                          value={aiCompliance.evidenceReference}
                          onChange={(event) => setAiCompliance({ ...aiCompliance, evidenceReference: event.target.value })}
                          placeholder="e.g. DPIA or DPA reference"
                          className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                        />
                        <p className="mt-1 text-xs text-neutral-500">Optional: a reference to where the school keeps its own approval record. The platform does not check it.</p>
                      </div>
                    </div>
                  </details>
                  <div className="flex gap-3">
                    <button
                      type="submit"
                       disabled={aiLoading || !aiForm.aiProvider || !aiApprovals.schoolAuthorised || !aiApprovals.termsAccepted || !aiApprovals.ukProcessingConfirmed}
                      className="rounded-2xl bg-black text-white px-6 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                    >
                       {aiLoading ? "Saving…" : "Save and approve provider"}
                    </button>
                    {showAiForm && (
                      <button
                        type="button"
                        onClick={() => {
                          clearAiDraft();
                          setShowAiForm(false);
                        }}
                        className="rounded-2xl border border-neutral-300 px-6 py-2.5 text-sm hover:bg-neutral-50 transition-colors"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                    <p className="text-xs text-neutral-400">The key is encrypted before storage and is never returned to the browser after submission or shown to teachers or students. AI stays unavailable until these three confirmations are saved. Changing the provider or key requires fresh approval. Replacing or disabling a key does not revoke it with Google or Microsoft; revoke it in the provider portal when no longer needed.</p>
                </form>
              )
            )}
            </div>
          </details>
        ) : (
          <details className="group rounded-[2rem] bg-white border border-neutral-200 shadow-sm">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-8 text-xs uppercase tracking-[0.2em] text-neutral-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-inset">
              <span>AI Configuration</span>
              <span className="shrink-0 rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium normal-case tracking-normal text-neutral-600">View</span>
            </summary>
            <div className="border-t border-neutral-100 p-8">
              <p className="text-sm text-neutral-600">AI is configured by your school's School Admin.</p>
            </div>
          </details>
        ))}

        {settingsArea === "privacy" && isSchoolMaster && (
          <details className="group rounded-[2rem] bg-white border border-neutral-200 shadow-sm" data-testid="student-data-request-section">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-8 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-inset">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-1">Student Data Requests</p>
               <p className="text-sm text-neutral-600">Record and manage requests received about an individual student’s platform data, including requests to access, correct or delete information.</p>
              </div>
              <span className="shrink-0 rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">Manage</span>
            </summary>
            <div className="border-t border-neutral-100 p-8 space-y-6">
             <p className="text-sm text-neutral-600">Record and manage requests received about an individual student’s platform data, including requests to access, correct or delete information.</p>
             <p className="text-sm text-neutral-600">If you are unsure how to respond, refer the request to the school’s Data Protection Officer.</p>
             <details className="rounded-2xl border border-neutral-200 bg-neutral-50 p-5">
               <summary className="cursor-pointer text-sm font-semibold text-neutral-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-600">Before responding to a request</summary>
               <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-5 text-neutral-700">
                 <li>Confirm the identity and authority of the person making the request.</li>
                 <li>Ask the school’s Data Protection Officer for advice if the correct response is unclear or disputed.</li>
                 <li>Refer safeguarding concerns to the school’s safeguarding lead.</li>
                 <li>Do not delete information subject to a hold, complaint, investigation or retention requirement.</li>
               </ul>
             </details>

            <form onSubmit={handleCreateStudentDataRequest} className="space-y-4 rounded-2xl border border-neutral-200 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">Record a new request</h3>
                   <p className="mt-1 text-xs leading-5 text-neutral-500">Record what the student, parent, carer or authorised representative has asked the school to do.</p>
                </div>
              </div>
               <div className="space-y-4">
                <div className="relative min-w-0">
                   <label className="mb-2 block text-sm font-medium" htmlFor="student-data-request-student-search">Which student is the request about?</label>
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                    <input
                      id="student-data-request-student-search"
                      value={studentDataRequestStudentSearch}
                      onChange={(event) => {
                        setStudentDataRequestStudentSearch(event.target.value);
                        setStudentDataRequestForm((current) => ({ ...current, studentSessionId: "" }));
                        setStudentDataRequestSelectedStudentLabel("");
                        setStudentDataRequestStudents([]);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void loadStudentDataRequestStudents();
                        }
                      }}
                      maxLength={120}
                      placeholder="Search by student name"
                      className="min-w-0 flex-1 rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm"
                      data-testid="student-data-request-student-search"
                      aria-required="true"
                    />
                    <button
                      type="button"
                      onClick={() => void loadStudentDataRequestStudents()}
                      disabled={studentDataRequestStudentLoading || !studentDataRequestStudentSearch.trim()}
                      className="max-w-full rounded-2xl border border-neutral-300 bg-white px-4 py-3 text-sm font-medium hover:bg-neutral-100 disabled:opacity-50"
                      data-testid="student-data-request-search"
                    >
                      {studentDataRequestStudentLoading ? "Searching…" : "Search"}
                    </button>
                  </div>
                  {studentDataRequestSelectedStudentLabel && (
                    <p className="mt-2 text-xs font-medium text-emerald-700">Selected: {studentDataRequestSelectedStudentLabel}</p>
                  )}
                  {studentDataRequestStudentSearch.trim() && !studentDataRequestForm.studentSessionId && (
                    <div
                      className="absolute left-0 right-0 top-full z-10 mt-2 max-h-56 overflow-y-auto rounded-2xl border border-neutral-200 bg-white p-2 shadow-lg"
                      role="listbox"
                      aria-label="Student search results"
                    >
                      {studentDataRequestStudentLoading ? (
                        <p className="px-3 py-2 text-sm text-neutral-500">Searching…</p>
                      ) : studentDataRequestStudents.length === 0 ? (
                        <p className="px-3 py-2 text-sm text-neutral-500">No students found. Try another name.</p>
                      ) : (
                        studentDataRequestStudents.map((student) => (
                          <button
                            key={student.id}
                            type="button"
                            role="option"
                            onClick={() => selectStudentDataRequestStudent(student)}
                            className="block w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-neutral-50"
                            data-testid={`student-data-request-option-${student.id}`}
                          >
                            <span className="font-medium text-neutral-800">{student.studentName}</span>
                            <span className="ml-2 text-xs text-neutral-500">
                              {student.className}{student.classArchivedAt ? " (archived class)" : ""}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                  <p className="mt-2 text-xs leading-5 text-neutral-500">Search by name, then choose the matching student and class. Results are limited to this school.</p>
                </div>
                <div className="min-w-0">
                   <label className="mb-2 block text-sm font-medium">What has been requested?</label>
                  <select
                    value={studentDataRequestForm.requestType}
                    onChange={(event) => {
                      const requestType = event.target.value as StudentDataRequestType;
                      setStudentDataRequestForm({
                        ...studentDataRequestForm,
                        requestType,
                        approvalBasis: requestType === "access" ? "" : studentDataRequestForm.approvalBasis,
                      });
                    }}
                    className="block w-full max-w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm"
                    data-testid="student-data-request-type"
                  >
                     <option value="access">Provide a copy of the student’s data</option>
                     <option value="correction">Correct the student’s data</option>
                     <option value="deletion">Delete the student’s data</option>
                  </select>
                </div>
              </div>
              {studentDataRequestForm.requestType !== "access" && (
                <div>
                  <label className="mb-2 block text-sm font-medium" htmlFor="student-data-request-approval-basis">
                    School approval or reason
                  </label>
                  <p className="mb-2 text-xs leading-5 text-neutral-500">
                    Record who approved this action or why the information must be corrected, deleted or retained.
                  </p>
                  <textarea
                    id="student-data-request-approval-basis"
                    required
                    minLength={3}
                    maxLength={2000}
                    rows={3}
                    value={studentDataRequestForm.approvalBasis}
                    onChange={(event) => setStudentDataRequestForm({
                      ...studentDataRequestForm,
                      approvalBasis: event.target.value,
                    })}
                    placeholder="Record the approval or reason"
                    className="w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm"
                    data-testid="student-data-request-approval-basis"
                  />
                </div>
              )}
              <div>
                 <label className="mb-2 block text-sm font-medium">What has the person asked for?</label>
                <textarea
                  required
                  minLength={3}
                  maxLength={2000}
                  rows={3}
                  value={studentDataRequestForm.reason}
                  onChange={(event) => setStudentDataRequestForm({ ...studentDataRequestForm, reason: event.target.value })}
                   placeholder="Record the request in their own words or provide a short, accurate summary."
                  className="w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm"
                  data-testid="student-data-request-reason"
                />
              </div>
              <button
                disabled={studentDataRequestSaving}
                className="rounded-2xl bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
                data-testid="create-student-data-request"
              >
                {studentDataRequestSaving ? "Recording…" : "Record request"}
              </button>
            </form>

            <div className="space-y-3 border-t border-neutral-100 pt-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">Existing requests</h3>
                  <p className="mt-1 text-xs leading-5 text-neutral-500">Each change and download is recorded in the school audit history. A request stays visible even if the student’s active record has later been removed.</p>
                </div>
                <button
                  type="button"
                  onClick={() => void loadStudentDataRequests()}
                  disabled={studentDataRequestsLoading}
                  className="rounded-2xl border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50 disabled:opacity-50"
                >
                  {studentDataRequestsLoading ? "Refreshing…" : "Refresh"}
                </button>
              </div>
              {studentDataRequestsLoading && !studentDataRequests.length ? (
                <p className="text-sm text-neutral-500">Loading requests…</p>
              ) : studentDataRequests.length === 0 ? (
                <p className="rounded-2xl bg-neutral-50 p-4 text-sm text-neutral-500">No student data requests have been recorded for this school.</p>
              ) : (
                <div className="space-y-4">
                   {studentDataRequests.map((request) => {
                     const update = studentDataRequestUpdates[request.id] ?? {
                       status: request.status,
                       outcome: request.outcome ?? "",
                       approvalBasis: request.approvalBasis ?? "",
                     };
                     const isOpen = openStudentDataRequestId === request.id;
                     const isFinalRequest = request.status === "completed" || request.status === "refused";
                     const requestControls = studentDataRequestControls.filter((control) => control.requestId === request.id);
                     return (
                       <article key={request.id} className="rounded-2xl border border-neutral-200 p-4" data-testid={`student-data-request-${request.id}`}>
                         <div className="flex flex-wrap items-center justify-between gap-3">
                           <div className="min-w-0">
                             <p className="font-semibold">{request.studentName}</p>
                             <p className="mt-1 text-xs text-neutral-500">{request.className} · {studentDataRequestTypeLabel(request.requestType)} · received {new Date(request.createdAt).toLocaleDateString("en-GB")}</p>
                           </div>
                           <div className="flex items-center gap-2">
                             <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium capitalize text-neutral-700">{request.status.replace("_", " ")}</span>
                             <button
                               type="button"
                               onClick={() => setOpenStudentDataRequestId(isOpen ? null : request.id)}
                               aria-expanded={isOpen}
                               className="rounded-2xl border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-600"
                             >
                               {isOpen ? "Close request" : "Open request"}
                             </button>
                           </div>
                         </div>
                         {isOpen && (
                           <div className="mt-4 space-y-4 border-t border-neutral-100 pt-4">
                             <div>
                               <h4 className="text-sm font-semibold">Request details</h4>
                               <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                                 <div>
                                   <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">What was requested</dt>
                                   <dd className="mt-1 whitespace-pre-wrap text-neutral-700">{request.reason}</dd>
                                 </div>
                                 <div>
                                   <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">Request type</dt>
                                   <dd className="mt-1 text-neutral-700">{studentDataRequestTypeLabel(request.requestType)}</dd>
                                 </div>
                               </dl>
                             </div>
                             <div className="grid gap-3 sm:grid-cols-2">
                               <div>
                                 <label className="mb-2 block text-sm font-medium">Status</label>
                                 <select
                                   value={update.status}
                                   disabled={isFinalRequest}
                                   onChange={(event) => setStudentDataRequestUpdates((current) => ({
                                     ...current,
                                     [request.id]: { ...update, status: event.target.value as StudentDataRequestStatus },
                                   }))}
                                   className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm"
                                   data-testid={`student-data-request-status-${request.id}`}
                                 >
                                   <option value="open">Open</option>
                                   <option value="in_review">In review</option>
                                   <option value="completed">Completed</option>
                                   <option value="refused">Refused</option>
                                   <option value="escalated">Escalated</option>
                                 </select>
                               </div>
                               <div>
                                 <label className="mb-2 block text-sm font-medium">Outcome {["completed", "refused", "escalated"].includes(update.status) ? "(required)" : ""}</label>
                                 <textarea
                                   rows={2}
                                   maxLength={2000}
                                   value={update.outcome}
                                   disabled={isFinalRequest}
                                   onChange={(event) => setStudentDataRequestUpdates((current) => ({
                                     ...current,
                                     [request.id]: { ...update, outcome: event.target.value },
                                   }))}
                                   className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm"
                                   placeholder="Record what action was taken and when."
                                   data-testid={`student-data-request-outcome-${request.id}`}
                                 />
                               </div>
                             </div>
                             <div>
                               <label className="mb-2 block text-sm font-medium">Decision or retention reason</label>
                               <p className="mb-2 text-xs leading-5 text-neutral-500">Complete this when a decision has been made, particularly if information is not corrected or deleted.</p>
                               <textarea
                                 rows={2}
                                 maxLength={2000}
                                 value={update.approvalBasis}
                                 disabled={isFinalRequest}
                                 onChange={(event) => setStudentDataRequestUpdates((current) => ({
                                   ...current,
                                   [request.id]: { ...update, approvalBasis: event.target.value },
                                 }))}
                                 className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm"
                                 data-testid={`student-data-request-approval-basis-${request.id}`}
                               />
                             </div>
                             <div>
                               <h4 className="text-sm font-semibold">Export information</h4>
                               <div className="mt-2 flex flex-wrap items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => void handleExportStudentDataRequest(request, "readable")}
                                    disabled={studentDataRequestExporting === request.id || request.status === "refused" || !request.studentSessionId}
                                    className="rounded-2xl bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
                                    title={!request.studentSessionId ? "The active student record is no longer available for export." : undefined}
                                  >
                                    {studentDataRequestExporting === request.id ? "Preparing…" : "Download readable student record"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void handleExportStudentDataRequest(request, "data")}
                                    disabled={studentDataRequestExporting === request.id || request.status === "refused" || !request.studentSessionId}
                                    className="rounded-2xl border border-neutral-300 px-4 py-2.5 text-sm hover:bg-neutral-50 disabled:opacity-50"
                                    title={!request.studentSessionId ? "The active student record is no longer available for export." : undefined}
                                  >
                                    Download data files
                                  </button>
                                 <span className="text-xs text-neutral-500">
                                   {request.exportCount ? `${request.exportCount} export${request.exportCount === 1 ? "" : "s"} recorded` : "No export recorded"}
                                 </span>
                               </div>
                                <p className="mt-2 text-xs leading-5 text-neutral-500">The readable record is a paginated PDF. Data files provide the school-scoped technical JSON export. Store and share both securely.</p>
                             </div>
                             <div>
                               <h4 className="text-sm font-semibold">Any existing hold or restriction</h4>
                               {requestControls.length > 0 ? (
                                 <ul className="mt-2 space-y-2 text-sm text-neutral-700">
                                   {requestControls.map((control) => <li key={control.id}>{control.kind.replaceAll("_", " ")} · {control.lifecycleState}</li>)}
                                 </ul>
                               ) : (
                                 <p className="mt-2 text-sm text-neutral-500">None recorded.</p>
                               )}
                             </div>
                             <div className="flex flex-wrap items-center gap-2">
                               <button
                                 type="button"
                                 onClick={() => void handleUpdateStudentDataRequest(request)}
                                 disabled={studentDataRequestUpdating === request.id || isFinalRequest}
                                 className="rounded-2xl bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
                               >
                                 {studentDataRequestUpdating === request.id ? "Saving…" : "Save request update"}
                               </button>
                               {isFinalRequest && (
                                 <p className="text-xs leading-5 text-neutral-500">This final decision is read-only. Record a new request if the school needs to make a further decision.</p>
                               )}
                             </div>
                           </div>
                         )}
                       </article>
                     );
                   })}
                </div>
              )}
            </div>

             <details className="min-w-0 max-w-full overflow-hidden border-t border-neutral-100 pt-5" data-testid="student-data-request-controls">
               <summary className="flex cursor-pointer list-none items-start justify-between gap-4 rounded-2xl p-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-600">
                 <div>
                   <h3 className="text-sm font-semibold">DPO and safeguarding controls</h3>
                   <p className="mt-1 text-xs leading-5 text-neutral-500">Only use these controls following advice from the school’s Data Protection Officer, safeguarding lead or legal adviser.</p>
                 </div>
                 <span className="shrink-0 rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">Open advanced controls</span>
               </summary>
               <div className="mt-4 space-y-4">
              <div className="min-w-0 max-w-full space-y-4">
                <label className="block min-w-0 text-sm font-medium">
                  Select a data request
                  <select required data-testid="student-data-control-request" value={studentDataRequestControlForm.requestId} onChange={(event) => setStudentDataRequestControlForm({ ...studentDataRequestControlForm, requestId: event.target.value })} className="mt-2 block w-full max-w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm">
                    <option value="">Choose a request</option>
                    {studentDataRequests.map((request) => <option key={request.id} value={request.id}>#{request.id} · {request.requestType} · {request.studentName}</option>)}
                  </select>
                </label>
                {studentDataRequestControlForm.requestId ? (
                <form onSubmit={handleCreateStudentDataRequestControl} className="min-w-0 max-w-full space-y-4 overflow-hidden rounded-2xl border border-neutral-200 p-4 sm:p-5">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="min-w-0 text-sm font-medium">
                    Kind
                    <select value={studentDataRequestControlForm.kind} onChange={(event) => {
                      const kind = event.target.value as StudentDataRequestControl["kind"];
                      setStudentDataRequestControlForm({
                        ...studentDataRequestControlForm,
                        kind,
                        reasonCategory: kind === "restriction" ? "accuracy_dispute" : kind === "legal_hold" ? "legal_claim" : "safeguarding",
                        processingLimits: kind === "restriction" ? studentDataRequestControlForm.processingLimits : ["deletion"],
                      });
                    }} className="mt-2 block w-full max-w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm">
                      <option value="restriction">Processing restriction</option>
                      <option value="legal_hold">Legal hold</option>
                      <option value="safeguarding_hold">Safeguarding hold</option>
                    </select>
                  </label>
                  <label className="min-w-0 text-sm font-medium">
                    Reason category
                    <select value={studentDataRequestControlForm.reasonCategory} onChange={(event) => setStudentDataRequestControlForm({ ...studentDataRequestControlForm, reasonCategory: event.target.value as StudentDataRequestControl["reasonCategory"] })} className="mt-2 block w-full max-w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm">
                      {["accuracy_dispute", "objection", "legal_claim", "complaint", "investigation", "safeguarding", "retention_duty", "other"].map((category) => <option key={category} value={category}>{category.replaceAll("_", " ")}</option>)}
                    </select>
                  </label>
                </div>
                 <div className="rounded-2xl bg-neutral-50 p-4 text-sm leading-5 text-neutral-700">
                   <p>
                     {studentDataRequestControlForm.kind === "restriction"
                       ? "Temporarily limits selected uses of the student’s data while a concern or request is reviewed."
                       : studentDataRequestControlForm.kind === "legal_hold"
                         ? "Prevents selected information from being deleted while it is required for a legal claim, complaint, investigation or retention duty."
                         : "Prevents selected information from being deleted while it may be required for safeguarding purposes."}
                   </p>
                   <p className="mt-2">A hold pauses deletion. A restriction applies only to the processing activities selected below.</p>
                 </div>
                <label className="block text-sm font-medium">
                  Minimal reason reference
                  <textarea required minLength={3} maxLength={160} rows={2} value={studentDataRequestControlForm.reasonSummary} onChange={(event) => setStudentDataRequestControlForm({ ...studentDataRequestControlForm, reasonSummary: event.target.value })} placeholder="Reference the restricted case record; do not paste student work, chats, identity documents, or safeguarding detail." className="mt-2 w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm" />
                </label>
                <div className="grid gap-4 sm:grid-cols-3">
                  {[
                    { title: "Data categories", key: "affectedDataCategories", values: ["identity", "learning", "activity", "feedback", "ai_conversations"] },
                    { title: "Access limits", key: "accessLimits", values: ["export"] },
                    { title: "Processing limits", key: "processingLimits", values: ["deletion", "export"] },
                  ].map((group) => (
                    <fieldset key={group.key}>
                      <legend className="text-sm font-medium">{group.title}</legend>
                      {group.values.map((value) => {
                        const selected = studentDataRequestControlForm[group.key as "affectedDataCategories" | "accessLimits" | "processingLimits"];
                        const fixedHoldDeletion = group.key === "processingLimits" && value === "deletion" && studentDataRequestControlForm.kind !== "restriction";
                        return (
                          <label key={value} className="mt-2 flex items-center gap-2 text-xs text-neutral-600">
                            <input type="checkbox" disabled={fixedHoldDeletion} checked={selected.includes(value)} onChange={(event) => setStudentDataRequestControlForm({
                              ...studentDataRequestControlForm,
                              [group.key]: event.target.checked ? [...selected, value] : selected.filter((item) => item !== value),
                            })} />
                            {value.replaceAll("_", " ")}
                          </label>
                        );
                      })}
                    </fieldset>
                  ))}
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="text-sm font-medium">Start date<input required type="date" value={studentDataRequestControlForm.startDate} onChange={(event) => setStudentDataRequestControlForm({ ...studentDataRequestControlForm, startDate: event.target.value })} className="mt-2 w-full rounded-2xl border border-neutral-200 px-4 py-3" /></label>
                  <label className="text-sm font-medium">Review date<input required type="date" value={studentDataRequestControlForm.reviewDate} onChange={(event) => setStudentDataRequestControlForm({ ...studentDataRequestControlForm, reviewDate: event.target.value })} className="mt-2 w-full rounded-2xl border border-neutral-200 px-4 py-3" /></label>
                  <label className="text-sm font-medium">Optional expiry<input type="date" value={studentDataRequestControlForm.expiryDate} onChange={(event) => setStudentDataRequestControlForm({ ...studentDataRequestControlForm, expiryDate: event.target.value })} className="mt-2 w-full rounded-2xl border border-neutral-200 px-4 py-3" /></label>
                </div>
                <button disabled={studentDataRequestControlSaving} className="rounded-2xl bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50" data-testid="apply-student-data-control">
                  {studentDataRequestControlSaving ? "Applying…" : "Apply control"}
                </button>
              </form>
                ) : (
                  <p className="rounded-2xl border border-dashed border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-500">
                    Select a data request before entering a restriction or hold.
                  </p>
                )}
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h4 className="text-sm font-semibold">Active and historical controls</h4>
                  <button type="button" onClick={() => void loadStudentDataRequestControls()} disabled={studentDataRequestControlsLoading} className="rounded-2xl border border-neutral-300 px-4 py-2 text-sm disabled:opacity-50">Refresh</button>
                </div>
                {studentDataRequestControls.length === 0 ? (
                   <p className="rounded-2xl bg-neutral-50 p-4 text-sm text-neutral-500">No restrictions or holds have been added to this request.</p>
                ) : studentDataRequestControls.map((control) => {
                  const reviewOverdue = control.lifecycleState === "active" && new Date(control.reviewDate) < new Date();
                  const expiryDue = Boolean(control.expiryDate && new Date(control.expiryDate) <= new Date());
                  return (
                    <article key={control.id} className="min-w-0 max-w-full overflow-hidden rounded-2xl border border-neutral-200 p-4 sm:p-5" data-testid={`student-data-control-${control.id}`}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div><p className="font-semibold capitalize">{control.kind.replaceAll("_", " ")} · request #{control.requestId ?? "removed"}</p><p className="mt-1 text-xs text-neutral-500">Owner account #{control.accountableOwnerTeacherId ?? "removed"} · applied {new Date(control.createdAt).toLocaleDateString("en-GB")}</p></div>
                        <span className={`rounded-full px-3 py-1 text-xs font-medium ${reviewOverdue ? "bg-red-100 text-red-800" : control.lifecycleState === "active" ? "bg-amber-100 text-amber-900" : "bg-neutral-100 text-neutral-700"}`}>{reviewOverdue ? "Review overdue" : control.lifecycleState}</span>
                      </div>
                      <p className="mt-3 text-sm">{control.reasonCategory.replaceAll("_", " ")} · {control.reasonSummary}</p>
                      <p className="mt-2 break-words text-xs text-neutral-600">Student ref #{control.affectedStudentSessionId ?? "removed"} · class ref #{control.affectedClassId ?? "removed"} · categories {control.affectedDataCategories.join(", ")} · access {control.accessLimits.join(", ") || "none"} · processing {control.processingLimits.join(", ") || "none"}</p>
                      <p className="mt-2 text-xs text-neutral-500">Review {new Date(control.reviewDate).toLocaleDateString("en-GB")} · expiry {control.expiryDate ? new Date(control.expiryDate).toLocaleDateString("en-GB") : "not set"}</p>
                      {control.lifecycleState === "active" && <div className="mt-4 flex flex-wrap gap-2">
                        <button type="button" onClick={() => void handleStudentDataRequestControlAction(control, "review")} disabled={studentDataRequestControlAction === control.id} className="rounded-2xl border border-neutral-300 px-4 py-2 text-xs">Record review</button>
                        {expiryDue && <button type="button" onClick={() => void handleStudentDataRequestControlAction(control, "expire")} disabled={studentDataRequestControlAction === control.id} className="rounded-2xl border border-amber-300 px-4 py-2 text-xs">Confirm expiry</button>}
                        <button type="button" onClick={() => void handleStudentDataRequestControlAction(control, "lift")} disabled={studentDataRequestControlAction === control.id} className="rounded-2xl border border-red-300 px-4 py-2 text-xs text-red-800">Lift control</button>
                      </div>}
                      <ol className="mt-4 space-y-2 border-t border-neutral-100 pt-3 text-xs text-neutral-600">
                        {control.events.map((event) => <li key={event.id}><span className="font-medium capitalize">{event.eventType}</span> by account #{event.actorTeacherId ?? "removed"} on {new Date(event.occurredAt).toLocaleDateString("en-GB")} — {event.note}</li>)}
                      </ol>
                    </article>
                  );
                })}
                </div>
               </div>
             </details>
            </div>
          </details>
        )}

        {settingsArea === "records" && isSchoolMaster && (
          <section className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm space-y-5" data-testid="retention-policy-section">
            <div>
               <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-1">School Admin retention · Deletion recovery</p>
                <h2 className="text-lg font-semibold text-neutral-900">Retention and Deletion</h2>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-neutral-600">These settings connect the lifecycle stages: Archived → Pending deletion → Permanently deleted. Classes and Student records follow this sequence. Archived Teacher records remain available for read-only review and are eligible for controlled manual deletion.</p>
            </div>

            <form onSubmit={handleSaveRetentionDefault} className="space-y-4 rounded-2xl border border-neutral-200 bg-neutral-50 p-5">
              <div className="max-w-md">
                <label htmlFor="deletion-recovery-period" className="block text-sm font-semibold">Recovery period before permanent deletion</label>
                 <p id="deletion-recovery-period-help" className="mt-1 text-xs leading-5 text-neutral-500">Enter how many days deleted classes and Student records can be restored. When the deadline passes, eligible live application records are permanently removed automatically by the existing lifecycle worker.</p>
                <input
                  id="deletion-recovery-period"
                  type="number"
                  min="1"
                  max="36500"
                  required
                  value={retentionDefaultForm.deletionRecoveryDays}
                  aria-describedby="deletion-recovery-period-help"
                  onChange={(event) => setRetentionDefaultForm({ ...retentionDefaultForm, deletionRecoveryDays: event.target.value })}
                  className="mt-2 w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm"
                />
                 <p className="mt-2 text-xs leading-5 text-neutral-500">The platform-wide setting is 30 days by default. Enter any whole number from 1 to 36,500 days. Changing it applies to future deletions only; records already in recovery keep their current deadline.</p>
              </div>
              <p className="rounded-xl border border-sky-100 bg-sky-50 px-4 py-3 text-sm text-sky-950">
                {retentionDefaultPolicy
                   ? `This school’s deletion recovery period is ${retentionDefaultForm.deletionRecoveryDays} days.`
                   : `No school-specific deletion recovery period is saved. The default is 30 days.`}
              </p>
              <button disabled={retentionSaving} className="rounded-2xl bg-neutral-900 px-5 py-2.5 text-sm text-white disabled:opacity-50">
                 {retentionSaving ? "Saving…" : "Save recovery period"}
              </button>
            </form>

            <details className="group rounded-2xl border border-neutral-200">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-5 text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-inset">
                <span>Advanced settings</span>
                <span className="text-xs font-medium text-neutral-500">
                  <span className="group-open:hidden">Show</span>
                  <span className="hidden group-open:inline">Hide</span>
                </span>
              </summary>
              <div className="space-y-5 border-t border-neutral-100 p-5">
                 <form onSubmit={handleSaveRetentionDefault} className="space-y-4 rounded-2xl border border-neutral-200 bg-neutral-50 p-5">
                   <div className="flex flex-wrap items-start justify-between gap-3">
                     <div>
                       <h3 className="text-sm font-semibold">Archive retention period</h3>
                       <p id="archive-retention-period-help" className="mt-1 text-xs leading-5 text-neutral-500">Choose how long Archived classes and their associated Student records remain available as read-only records. When this period ends, they enter Pending deletion and the recovery period shown above. They are Permanently deleted when the recovery period ends, unless a valid hold applies.</p>
                     </div>
                     <span className={`rounded-full px-3 py-1 text-xs font-medium ${retentionDefaultPolicy ? "bg-emerald-50 text-emerald-700" : "bg-sky-50 text-sky-800"}`}>
                       {retentionDefaultPolicy ? "School period saved" : "CIG default applies"}
                     </span>
                   </div>
                    <div className="max-w-md">
                      <label htmlFor="archive-retention-period" className="block text-sm font-medium text-neutral-800">
                        Archive retention period (days)
                      </label>
                      <input
                        id="archive-retention-period"
                        aria-describedby="archive-retention-period-help archive-retention-period-range"
                        type="number"
                        min={platformRetentionPolicy.minimumDays}
                        max={platformRetentionPolicy.maximumDays}
                        step="1"
                        required
                        value={retentionDefaultForm.archiveRetentionDays}
                        onChange={(event) => setRetentionDefaultForm({ ...retentionDefaultForm, archiveRetentionDays: event.target.value, retentionDays: event.target.value })}
                        className="mt-2 w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm"
                      />
                      <p id="archive-retention-period-range" className="mt-1 text-xs leading-5 text-neutral-500">
                        Enter any whole number from {platformRetentionPolicy.minimumDays.toLocaleString()} to {platformRetentionPolicy.maximumDays.toLocaleString()} days.
                      </p>
                   </div>
                   <p className="rounded-xl border border-sky-100 bg-sky-50 px-4 py-3 text-sm text-sky-950">
                     {retentionDefaultPolicy
                       ? `This school’s archive period is ${retentionDefaultForm.archiveRetentionDays} days.`
                       : `No school-specific archive period is saved. The CIG default applies: ${platformRetentionPolicy.archiveRetentionDays} days.`}
                   </p>
                   <div className="rounded-2xl border border-neutral-200 bg-white p-4 text-sm" data-testid="retention-save-preview">
                     <p className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-500">Calculated archive expiry</p>
                     <p className="mt-1 text-lg font-semibold text-neutral-900">
                        {formatRetentionPreviewDate(previewArchiveExpiry)}
                     </p>
                     <p className="mt-1 text-xs leading-5 text-neutral-500">Expiry date for an archive created today.</p>
                      <p className="mt-3 border-t border-neutral-100 pt-3 text-sm leading-6 text-neutral-700">
                        If Archived today, these records would enter Pending deletion on <strong>{formatRetentionPreviewDate(previewArchiveExpiry)}</strong> and would ordinarily be Permanently deleted on <strong>{formatRetentionPreviewDate(previewFinalDeletion)}</strong>, unless a valid hold applies.
                      </p>
                   </div>
                   <label className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                     <input type="checkbox" checked={retentionDefaultForm.applyToExistingArchived} onChange={(event) => setRetentionDefaultForm({ ...retentionDefaultForm, applyToExistingArchived: event.target.checked })} className="mt-0.5" />
                      <span><strong>Apply to existing archived classes</strong><br /><span className="text-xs leading-5">Leave unchecked to apply this period to future archives only. Selecting it recalculates archive-expiry dates for existing eligible archived classes. It does not change existing Student-record archive-expiry dates and must not alter records protected by a valid hold.</span></span>
                   </label>
                   <button disabled={retentionSaving} className="rounded-2xl bg-neutral-900 px-5 py-2.5 text-sm text-white disabled:opacity-50">
                     {retentionSaving ? "Saving…" : "Save archive settings"}
                   </button>
                 </form>

                <div>
                  <h3 className="text-sm font-semibold">Category exceptions (not currently active)</h3>
                  <p className="mt-1 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">Additional category-based retention is not currently active. Archived records follow the standard archive and deletion lifecycle.</p>
                  <p className="mt-2 text-xs leading-5 text-neutral-500">Stored category settings remain visible for audit history, but they do not change the standard archive, Pending deletion, or Permanently deleted lifecycle.</p>
                </div>
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-neutral-500">{retentionPolicies.length === 0 ? "No category exceptions are recorded." : `${retentionPolicies.length} category exception${retentionPolicies.length === 1 ? "" : "s"} recorded.`}</p>
                    <button
                      type="button"
                      onClick={() => startRetentionException()}
                      disabled
                      className="rounded-xl border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Category controls inactive
                    </button>
                  </div>
                  {!retentionDefaultPolicy && (
                    <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">Save the school retention policy before adding or removing exceptions.</p>
                  )}
                  {retentionPolicies.length > 0 && (
                    <div className="mt-4 space-y-2">
                      {retentionPolicies.map((policy) => (
                        <div key={policy.id} className="rounded-2xl border border-neutral-100 bg-neutral-50 p-4 text-xs">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <strong>{policy.label}</strong>
                              <p className="mt-1 text-neutral-500">{policy.retentionDays} days</p>
                              {policy.notes && <p className="mt-1 text-neutral-600">Reason: {policy.notes}</p>}
                              {policy.legalHold && <p className="mt-1 font-medium text-amber-800">Scoped legal hold recorded for this category.</p>}
                            </div>
                            <div className="flex gap-2">
                              <button type="button" onClick={() => startRetentionException(policy)} disabled className="rounded-xl border border-neutral-200 bg-white px-3 py-1.5 font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50">Category controls inactive</button>
                              <button type="button" onClick={() => handleRemoveRetentionException(policy)} disabled className="rounded-xl border border-red-200 bg-white px-3 py-1.5 font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50">
                                Stored setting retained
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="border-t border-neutral-100 pt-5">
                  <h3 className="text-sm font-semibold">Scoped legal holds</h3>
                  <p className="mt-1 text-xs leading-5 text-neutral-500">A legal hold must apply to a specified class, student record, or data category—not the whole school. Category holds can be recorded while editing an exception below; class- or student-record holds belong in their protected record workflow. Each hold requires a reason, and the server records who applied it and when.</p>
                  <p className="mt-3 rounded-xl border border-sky-100 bg-sky-50 px-3 py-2 text-xs text-sky-950">A scoped hold prevents deletion only for the affected records. This page never enables a school-wide legal hold.</p>
                </div>

                {retentionExceptionFormOpen && (
                  <form onSubmit={handleSaveRetentionException} className="space-y-3 rounded-2xl border border-neutral-200 p-5">
                    <div>
                      <h3 className="text-sm font-semibold">Add category exception</h3>
                      <p className="mt-1 text-xs leading-5 text-neutral-500">The reason is also the audit explanation for this exception and is required before saving.</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-2">Data category</label>
                      <select value={retentionExceptionForm.category} onChange={(event) => setRetentionExceptionForm({ ...retentionExceptionForm, category: event.target.value })} className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm">
                        {availableRetentionExceptionCategories.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-2">Retention period (days)</label>
                      <input required min={platformRetentionPolicy.minimumDays} max={platformRetentionPolicy.maximumDays} type="number" value={retentionExceptionForm.retentionDays} onChange={(event) => setRetentionExceptionForm({ ...retentionExceptionForm, retentionDays: event.target.value })} className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm" />
                      <p className="mt-1 text-xs text-neutral-500">Must be between {platformRetentionPolicy.minimumDays} and {platformRetentionPolicy.maximumDays} days.</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-2">Reason (required)</label>
                      <textarea required value={retentionExceptionForm.notes} onChange={(event) => setRetentionExceptionForm({ ...retentionExceptionForm, notes: event.target.value })} maxLength={1000} rows={3} className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm" placeholder="Why does this category need a different period or hold?" />
                    </div>
                    <label className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                      <input type="checkbox" checked={retentionExceptionForm.legalHold} onChange={(event) => setRetentionExceptionForm({ ...retentionExceptionForm, legalHold: event.target.checked })} className="mt-0.5" />
                      <span><strong>Place a legal hold on this category</strong><br /><span className="text-xs leading-5">The required reason explains the hold. It applies only to this category; the server records the actor and time.</span></span>
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <button disabled={retentionSaving} className="rounded-2xl bg-neutral-900 px-5 py-2.5 text-sm text-white disabled:opacity-50">{retentionSaving ? "Saving…" : "Save exception"}</button>
                      <button type="button" onClick={() => setRetentionExceptionFormOpen(false)} className="rounded-2xl border border-neutral-200 px-5 py-2.5 text-sm text-neutral-700 hover:bg-neutral-50">Cancel</button>
                    </div>
                  </form>
                )}
              </div>
            </details>
          </section>
        )}

        {settingsArea === "security" && isSchoolMaster && (
          <details className="group rounded-[2rem] bg-white border border-neutral-200 shadow-sm">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-8 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-inset">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-1">Compliance Evidence</p>
                <p className="text-sm text-neutral-600">Readable and technical reports for school review</p>
              </div>
              <span className="shrink-0 rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">View</span>
            </summary>
            <div className="space-y-4 border-t border-neutral-100 p-8">
            <div className="flex flex-wrap items-center gap-3">
              <button onClick={() => handleExportEvidence("html")} disabled={evidenceExporting} className="rounded-2xl bg-neutral-900 text-white px-5 py-2.5 text-sm hover:bg-neutral-700 disabled:opacity-50">
                {evidenceExporting ? "Preparing…" : "Download readable report"}
              </button>
              <details className="group rounded-2xl border border-neutral-200">
                <summary className="cursor-pointer list-none px-4 py-2.5 text-sm font-medium text-neutral-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-inset">
                  For IT or auditors
                </summary>
                <div className="border-t border-neutral-100 p-3">
                  <button onClick={() => handleExportEvidence("json")} disabled={evidenceExporting} className="rounded-xl border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50 disabled:opacity-50">
                    Download technical JSON
                  </button>
                </div>
              </details>
            </div>
            <p className="text-xs text-neutral-400">The readable report can be opened in a browser and printed or saved as a PDF. Use the technical JSON only for an IT or audit system that needs structured data.</p>
            </div>
          </details>
        )}

        {/* Email / SMTP Status (IT admin only) */}
        {settingsArea === "security" && isSchoolMaster && smtpConfigured !== null && (
          <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm space-y-4">
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-400">Email (Password Reset)</p>
            <p className="text-sm leading-6 text-neutral-600">Email delivery is centrally managed by CIG. Schools do not enter SMTP or AWS SES credentials here.</p>
            {smtpConfigured ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                    <p className="text-sm font-medium">Automatic email services are active.</p>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    onClick={handleTestEmail}
                    disabled={testEmailSending}
                    className="rounded-2xl border border-neutral-200 px-4 py-2 text-sm hover:bg-neutral-50 transition-colors disabled:opacity-50"
                  >
                    {testEmailSending ? "Sending…" : "Send test email"}
                  </button>
                  {testEmailResult && (
                    <p className={`text-sm ${testEmailResult.ok ? "text-emerald-600" : "text-red-600"}`}>
                      {testEmailResult.ok ? "✓ " : "✗ "}{testEmailResult.message}
                    </p>
                  )}
                </div>
                <p className="text-xs text-neutral-400">Sends a test message to your own address ({teacher?.email}) to confirm delivery is working.</p>
              </div>
            ) : (
                <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-neutral-300 shrink-0" />
                    <p className="text-sm font-medium text-neutral-600">Automatic email services are not currently available. Please contact CIG support.</p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Two-Factor Authentication */}
        {settingsArea === "security" && (
        <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-1">Two-Factor Authentication</p>
              <p className="text-sm text-neutral-600">
                Your authenticator app is required for every sign-in.
              </p>
            </div>
            {teacher?.totpEnabled && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-50 text-emerald-700 text-xs font-medium border border-emerald-200">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                Active
              </span>
            )}
          </div>

          <div className="rounded-2xl bg-neutral-50 border border-neutral-200 px-5 py-4 text-sm text-neutral-600 space-y-2">
            <p className="font-medium text-neutral-800">Lost or replacing your device?</p>
            <p>Sign out, enter your password, then select “Lost your authenticator?” on the two-factor screen. Enter one unused recovery code. The code can only be used once; recovery signs out every active session and asks you to set up a replacement authenticator.</p>
          </div>
        </div>
        )}

        {/* Security audit report (IT admin only) */}
        {settingsArea === "security" && isSchoolMaster && (
          <details className="group rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-8 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-inset">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-1">Security Audit Report</p>
                <p className="text-sm text-neutral-600">Filter and export school security events</p>
              </div>
              <span className="shrink-0 rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">Run report</span>
            </summary>
            <div className="px-8 py-6 flex items-center justify-between gap-4 border-b border-neutral-200">
              <div>
                <p className="text-sm text-neutral-600">Filter and export security events for your school. Student work and chat content are never included.</p>
              </div>
              <button
                onClick={handleToggleAuditReport}
                disabled={auditReportLoading}
                className="rounded-2xl border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50 transition-colors disabled:opacity-50"
              >
                {auditReportLoading ? "Preparing…" : showAuditReport ? "Hide" : "Run report"}
              </button>
            </div>
            {showAuditReport && (
              <div className="p-6 space-y-5">
                <div className="grid gap-3 md:grid-cols-4">
                  <label className="text-sm text-neutral-600">
                    <span className="block mb-1 font-medium">From</span>
                    <input type="date" value={auditReportFilters.from} onChange={(e) => setAuditReportFilters((filters) => ({ ...filters, from: e.target.value }))} className="w-full rounded-xl border border-neutral-300 px-3 py-2" />
                  </label>
                  <label className="text-sm text-neutral-600">
                    <span className="block mb-1 font-medium">To</span>
                    <input type="date" value={auditReportFilters.to} onChange={(e) => setAuditReportFilters((filters) => ({ ...filters, to: e.target.value }))} className="w-full rounded-xl border border-neutral-300 px-3 py-2" />
                  </label>
                  <label className="text-sm text-neutral-600">
                    <span className="block mb-1 font-medium">Event type</span>
                    <select value={auditReportFilters.action} onChange={(e) => setAuditReportFilters((filters) => ({ ...filters, action: e.target.value }))} className="w-full rounded-xl border border-neutral-300 px-3 py-2">
                      <option value="">All event types</option>
                      {auditReport?.actions.map((action) => <option key={action} value={action}>{action}</option>)}
                    </select>
                  </label>
                  <label className="text-sm text-neutral-600">
                    <span className="block mb-1 font-medium">User</span>
                    <select value={auditReportFilters.teacherId} onChange={(e) => setAuditReportFilters((filters) => ({ ...filters, teacherId: e.target.value }))} className="w-full rounded-xl border border-neutral-300 px-3 py-2">
                      <option value="">All users and system events</option>
                      {orgTeachers.map((orgTeacher) => <option key={orgTeacher.id} value={orgTeacher.id}>{orgTeacher.name} — {orgTeacher.email}</option>)}
                    </select>
                  </label>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" onClick={runAuditReport} disabled={auditReportLoading} className="rounded-2xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 transition-colors disabled:opacity-50">
                    {auditReportLoading ? "Preparing…" : "Run report"}
                  </button>
                  <button type="button" onClick={downloadAuditReport} disabled={auditReportDownloading || !auditReport?.items.length} className="rounded-2xl border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 transition-colors disabled:opacity-50">
                    {auditReportDownloading ? "Preparing download…" : "Download CSV"}
                  </button>
                  {auditReport && <p className="text-sm text-neutral-500">{auditReport.matchingCount} matching {auditReport.matchingCount === 1 ? "event" : "events"}.</p>}
                </div>
                {!auditReport || auditReportLoading ? (
                  <p className="rounded-2xl bg-neutral-50 px-5 py-4 text-sm text-neutral-500">Choose filters and run the report to view security events.</p>
                ) : auditReport.items.length === 0 ? (
                  <p className="rounded-2xl bg-neutral-50 px-5 py-4 text-sm text-neutral-500">No security events match these filters.</p>
                ) : (
                  <>
                    {auditReport.truncated && <p className="rounded-2xl bg-amber-50 px-5 py-4 text-sm text-amber-800">Showing the first {auditReport.limit} matching events. Narrow the filters before exporting a smaller report.</p>}
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-neutral-100 bg-neutral-50">
                            <th className="text-left px-6 py-3 text-neutral-500 font-medium">Time</th>
                            <th className="text-left px-4 py-3 text-neutral-500 font-medium">Action</th>
                            <th className="text-left px-4 py-3 text-neutral-500 font-medium">User</th>
                            <th className="text-left px-4 py-3 text-neutral-500 font-medium">Protected archive access</th>
                            <th className="text-left px-4 py-3 text-neutral-500 font-medium">IP</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-neutral-50">
                          {auditReport.items.map((entry) => (
                            <tr key={entry.id} className="hover:bg-neutral-50">
                              <td className="px-6 py-3 text-neutral-400 whitespace-nowrap font-mono">{new Date(entry.createdAt).toLocaleDateString("en-GB")}</td>
                              <td className="px-4 py-3 font-medium text-neutral-700">{entry.action}</td>
                              <td className="px-4 py-3 text-neutral-500">{entry.teacherName ?? "System"}</td>
                              <td className="px-4 py-3 text-neutral-500">
                                {entry.archiveAccess ? (
                                  <div className="max-w-sm">
                                    <p className="font-medium text-neutral-700">
                                      Archive #{entry.archiveAccess.archiveId} · {entry.archiveAccess.scope.replaceAll("_", " ")}
                                    </p>
                                    <p className="mt-1 whitespace-normal">Requester role at access: School Admin</p>
                                    <p className="mt-1 whitespace-normal">Purpose: {entry.archiveAccess.purpose}</p>
                                  </div>
                                ) : "—"}
                              </td>
                              <td className="px-4 py-3 text-neutral-400 font-mono">{entry.ipAddress ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            )}
          </details>
        )}

        {/* Change password */}
        {settingsArea === "security" && (
        <details className="group rounded-[2rem] bg-white border border-neutral-200 shadow-sm">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-8 text-xs uppercase tracking-[0.2em] text-neutral-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-inset">
            <span>Change Password</span>
            <span className="shrink-0 rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium normal-case tracking-normal text-neutral-600">Manage</span>
          </summary>
          <div className="border-t border-neutral-100 p-8">
          <form onSubmit={handleChangePassword} className="space-y-4 max-w-sm">
            <div>
              <label className="block text-sm font-medium mb-2">Current password</label>
              <input
                required
                type="password"
                autoComplete="current-password"
                value={cpForm.current}
                onChange={(e) => setCpForm({ ...cpForm, current: e.target.value })}
                className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                placeholder="Your current password"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">New password</label>
              <input
                required
                type="password"
                autoComplete="new-password"
                value={cpForm.next}
                onChange={(e) => {
                  setCpForm({ ...cpForm, next: e.target.value });
                  setHibpWarning(null);
                  setAcceptHibpWarning(false);
                }}
                minLength={12}
                className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                placeholder="At least 12 characters"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Confirm new password</label>
              <input
                required
                type="password"
                autoComplete="new-password"
                value={cpForm.confirm}
                onChange={(e) => setCpForm({ ...cpForm, confirm: e.target.value })}
                minLength={12}
                className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                placeholder="Same password again"
              />
            </div>
            {hibpWarning && (
              <div role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                <p className="font-medium">Breach check temporarily unavailable</p>
                <p className="mt-1">{hibpWarning}</p>
                <label className="mt-3 flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={acceptHibpWarning}
                    onChange={(e) => setAcceptHibpWarning(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>I understand and want to continue with this password.</span>
                </label>
              </div>
            )}
            <button
              type="submit"
              disabled={cpLoading || Boolean(hibpWarning && !acceptHibpWarning)}
              className="rounded-2xl bg-black text-white px-6 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {cpLoading ? "Saving…" : "Update password"}
            </button>
            {cpSuccess && <p className="text-sm text-emerald-600">Password updated successfully.</p>}
          </form>
          </div>
        </details>
        )}

        {/* Sign out */}
        <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm">
          <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-4">Session</p>
          <button
            onClick={handleSignOut}
            className="rounded-2xl border border-neutral-300 px-5 py-2.5 text-sm font-medium hover:bg-neutral-50 transition-colors"
          >
            Sign Out
          </button>
        </div>
      </main>
    </div>
  );
}

interface StudentDataRequest {
  id: number;
  studentSessionId: number | null;
  studentName: string;
  classId: number | null;
  className: string;
  requestType: StudentDataRequestType;
  reason: string;
  approvalBasis: string | null;
  status: StudentDataRequestStatus;
  outcome: string | null;
  exportCount: number;
  lastExportedAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface StudentDataRequestControl {
  id: number;
  requestId: number | null;
  accountableOwnerTeacherId: number | null;
  affectedStudentSessionId: number | null;
  affectedClassId: number | null;
  affectedDataCategories: string[];
  kind: "restriction" | "legal_hold" | "safeguarding_hold";
  reasonCategory: "accuracy_dispute" | "objection" | "legal_claim" | "complaint" | "investigation" | "safeguarding" | "retention_duty" | "other";
  reasonSummary: string;
  accessLimits: string[];
  processingLimits: string[];
  startDate: string;
  reviewDate: string;
  expiryDate: string | null;
  lifecycleState: "active" | "expired" | "lifted";
  lastReviewedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  events: Array<{
    id: number;
    eventType: "applied" | "reviewed" | "expired" | "lifted";
    note: string;
    lifecycleState: "active" | "expired" | "lifted";
    actorTeacherId: number | null;
    occurredAt: string;
  }>;
}

type StudentDataRequestType = "access" | "correction" | "deletion";

type StudentDataRequestStatus = "open" | "in_review" | "completed" | "refused" | "escalated";
