import { useState, useEffect, useRef, useCallback } from "react";
import { classifyMessages, QUESTION_TYPE_META, QUESTION_TYPES } from "@/lib/question-classifier";
import { useLocation } from "wouter";
import {
  apiFetch,
  apiFetchBlob,
  clearStudentSession,
  isStudentRecoveryError,
  rememberStudentRecoveryNotice,
} from "@/lib/api";
import { registerBeforeLogout } from "@/lib/session-lifecycle";
import { FRAMEWORK_DESCRIPTIONS } from "@/lib/frameworks";
import { useToast } from "@/hooks/use-toast";
import {
  classifyWorkspaceError,
  isUnauthorizedError,
  WorkspaceRequestState,
  type WorkspaceFailureState,
} from "@/components/WorkspaceRequestState";
import { FinalAnswerEditor } from "@/components/FinalAnswerEditor";
import { answerReadableText, answerVisibleText } from "@/lib/final-answer-format";
import {
  emptySupportingMaterial,
  normaliseSupportingMaterialCards,
  supportingMaterialCardsForPersistence,
  supportingMaterialCardsTextLength,
  SUPPORTING_MATERIAL_MAX_CHARACTERS,
  SUPPORTING_MATERIAL_TYPES,
  type SupportingMaterialCard,
} from "@/lib/supporting-materials";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { LinkifiedText } from "@/components/LinkifiedText";

const STAGES = ["MAP", "TORCH", "RESEARCH", "COMPASS", "EMBED"] as const;
type Stage = (typeof STAGES)[number];
const countWords = (value: string) => value.trim() ? value.trim().split(/\s+/).length : 0;
const ACTIVITY_INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000;
const ACTIVITY_HEARTBEAT_INTERVAL_MS = 30 * 1000;

const SOURCE_TYPE_OPTIONS = [
  "Website",
  "Book",
  "Article",
  "Video",
  "Data",
  "Expert or interview",
  "Survey",
  "Teacher",
  "AI",
  "Other",
] as const;
const STAGE_COLORS: Record<Stage, string> = {
  MAP: "bg-neutral-800 text-white",
  TORCH: "bg-amber-500 text-white",
  RESEARCH: "bg-sky-500 text-white",
  COMPASS: "bg-emerald-500 text-white",
  EMBED: "bg-violet-500 text-white",
};

const STAGE_BORDER: Record<Stage, string> = {
  MAP: "border-neutral-800",
  TORCH: "border-amber-500",
  RESEARCH: "border-sky-500",
  COMPASS: "border-emerald-500",
  EMBED: "border-violet-500",
};

const STAGE_LABEL: Record<Stage, string> = {
  MAP: "Understand • Plan • Set Goals",
  TORCH: "Explore • Question • Investigate",
  RESEARCH: "Research Log",
  COMPASS: "Verify • Evaluate • Reflect",
  EMBED: "Final Answer",
};

const STAGE_DISPLAY: Record<Stage, string> = {
  MAP: "MAP",
  TORCH: "TORCH",
  RESEARCH: "RESEARCH",
  COMPASS: "COMPASS",
  EMBED: "Final Answer",
};

const ACTIVITY_STAGE_ROWS = [
  { label: "MAP", stage: "MAP" },
  { label: "TORCH", stage: "TORCH" },
  { label: "Research", stage: "RESEARCH" },
  { label: "COMPASS", stage: "COMPASS" },
  { label: "Final Answer", stage: "EMBED" },
] as const;
const STAGE_ACCENT: Record<Stage, string> = {
  MAP: "text-neutral-500",
  TORCH: "text-amber-500",
  RESEARCH: "text-sky-500",
  COMPASS: "text-emerald-500",
  EMBED: "text-violet-500",
};

function deriveFurthestStage(entries: any[]): Stage {
  let furthest: Stage = "MAP";
  for (const stage of STAGES) {
    if (entries.some((e) => e.stage === stage)) {
      furthest = stage;
    }
  }
  return furthest;
}

type MapResearchContext = {
  mapRowId: string;
  investigation: string;
  sourceTypes: string[];
  plannedSource: string;
  verification: string;
  verificationSelections?: string[];
  addedAt: string;
};

type ResearchOrigin = "plan" | "teacher" | "during-research";

type SourceProvenance = {
  type: "teacher";
  originalSource: string;
  sourceId: string;
};

type ResearchEntry = {
  id: string;
  sourceType: SourceType | "";
  actualSource: string;
  sourceDetails: string;
  findings: string;
  importantPoints: string;
  combinedLearning?: string;
  reliability: string;
  trustworthinessSelections?: string[];
  usage: string;
  effectSelection?: string;
  isComplete?: boolean;
  sourceId?: string;
  sourceOrigin?: ResearchOrigin;
  addedAt?: string;
  mapContext?: MapResearchContext;
  sourceProvenance?: SourceProvenance;
};

type TorchGoal = {
  label: string;
  emoji: string;
  description: string;
  placeholder: string;
};

type TorchSuggestionStatus = "idle" | "loading" | "ready" | "empty" | "error";
type TorchPromptSource = "From your MAP" | "Suggested question" | "Your own question";
type TorchSuggestionSelection = { goal: string; question: string; questionId?: string; edited?: boolean };

function recordThinkingChoiceEvent(event: {
  eventType: "selected" | "inserted" | "edited";
  optionName: string;
  questionId?: string;
  conversationTurn: number;
}) {
  void apiFetch("/student/thinking-choice-events", {
    method: "POST",
    body: JSON.stringify({
      ...event,
      idempotencyKey: `torch:${event.eventType}:${event.optionName}:${event.questionId ?? "none"}:${crypto.randomUUID()}`,
      occurredAt: new Date().toISOString(),
    }),
  }).catch(() => {});
}

function torchSuggestionKey(goal: string, question: string): string {
  return `${goal}\u0000${question}`;
}

function readUsedTorchSuggestionKeys(contentJson: unknown): Set<string> {
  if (!contentJson || typeof contentJson !== "object" || Array.isArray(contentJson)) return new Set();
  const raw = (contentJson as Record<string, unknown>).torchUsedExampleQuestions;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return new Set();
  const keys = new Set<string>();
  for (const [goal, questions] of Object.entries(raw)) {
    if (!Array.isArray(questions)) continue;
    for (const question of questions) {
      if (typeof question === "string" && question.trim()) {
        keys.add(torchSuggestionKey(goal, question.trim()));
      }
    }
  }
  return keys;
}

function splitTutorResponse(value: unknown): {
  content: string;
  tryNext?: string;
  tryNextLabel?: string;
  discussionPrompt?: string;
  discussionLabel?: string;
} {
  const content = typeof value === "string" ? value : "";
  const marker = /\b(?:Understand this|Your next step|Talk it through|Knowledge and thinking support|Try this next|Discuss with TORCH|Key knowledge|A question for you|Your turn|Reflection Prompt):\s*/gi;
  const matches = Array.from(content.matchAll(marker));
  if (!matches.length) return { content };

  const mainParts = [content.slice(0, matches[0].index).trim()].filter(Boolean);
  let tryNext = "";
  let tryNextLabel = "";
  let discussionPrompt = "";
  let discussionLabel = "";
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    const markerName = current[0].split(":")[0].trim();
    const section = content.slice((current.index ?? 0) + current[0].length, next?.index ?? content.length).trim();
    if (!section) continue;
    const lowerMarkerName = markerName.toLocaleLowerCase();
    if (lowerMarkerName === "understand this" || lowerMarkerName === "knowledge and thinking support" || lowerMarkerName === "key knowledge") {
      mainParts.push(section);
      continue;
    }
    if (lowerMarkerName === "your next step" || lowerMarkerName === "try this next") {
      const firstAction = section.split(/\n\s*\n/)[0].trim();
      const isConcreteAction = firstAction.split(/\s+/).length >= 4
        && !/^(?:consider|think about|reflect on|explore|look at|look into|ponder|review the differences?)\b/i.test(firstAction)
        && !firstAction.includes("?")
        && /\b(?:create|write|compare|find|identify|define|check|list|annotate|sort|choose|record|draft|underline|highlight|use|bring|test|explain|describe|revisit|make)\b/i.test(firstAction);
      if (!tryNext && isConcreteAction) {
        tryNext = section;
        tryNextLabel = "Your next step";
      } else {
        if (firstAction && !firstAction.includes("?")) mainParts.push(firstAction);
      }
      continue;
    }
    if (lowerMarkerName !== "talk it through"
      && lowerMarkerName !== "discuss with torch"
      && lowerMarkerName !== "a question for you"
      && lowerMarkerName !== "your turn"
      && lowerMarkerName !== "reflection prompt") {
      mainParts.push(`${markerName}: ${section}`);
      continue;
    }
    const firstQuestionEnd = section.indexOf("?");
    const candidate = firstQuestionEnd >= 0 ? section.slice(0, firstQuestionEnd + 1).trim() : "";
    const isGenuineQuestion = candidate.endsWith("?")
      && (candidate.match(/\?/g) ?? []).length === 1;
    if (!discussionPrompt && isGenuineQuestion) {
      discussionPrompt = candidate;
      discussionLabel = markerName;
      continue;
    }
    mainParts.push(`${markerName}: ${section}`);
  }

  if (!discussionPrompt) {
    const support = mainParts.join("\n\n").trim();
    const boundaries = Array.from(support.matchAll(/[.!?]\s+|\n\s*\n/g));
    const lastBoundary = boundaries.at(-1);
    const start = lastBoundary ? (lastBoundary.index ?? 0) + lastBoundary[0].length : 0;
    const candidate = support.slice(start).trim();
    if (
      start > 0
      && candidate.endsWith("?")
      && (candidate.match(/\?/g) ?? []).length === 1
      && candidate.length >= 8
    ) {
      mainParts.splice(0, mainParts.length, support.slice(0, start).trim());
      discussionPrompt = candidate;
      discussionLabel = "Talk it through";
    }
  }

  return {
    content: mainParts.join("\n\n"),
    tryNext: tryNext || undefined,
    tryNextLabel: tryNextLabel || undefined,
    discussionPrompt: discussionPrompt || undefined,
    discussionLabel: discussionLabel || undefined,
  };
}

type AnswerFeedback = {
  requirementCoverage: {
    taskQuestion: { status: "met" | "partial" | "missing"; feedback: string };
    successCriteria: Array<{ criterion: string; status: "met" | "partial" | "missing"; evidence: string }>;
  };
  keyVocabulary: Array<{ term: string; status: "used" | "missing" | "unclear"; feedback: string }>;
  expectedLengthOrFormat: {
    requirement: string;
    status: "meets" | "needs_attention" | "not_specified";
    feedback: string;
  };
  stageEvidence: {
    MAP: { used: boolean; feedback: string };
    TORCH: { used: boolean; feedback: string };
    COMPASS: { used: boolean; feedback: string };
  };
  strengths: string[];
  areasForDevelopment: string[];
  nextSteps: string[];
};

type AnswerFeedbackAttempt = {
  answerSnapshot: string;
  feedback: AnswerFeedback;
  createdAt: string;
};

function newResearchEntryId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function emptyEntry(origin: ResearchOrigin = "during-research"): ResearchEntry {
  const id = newResearchEntryId();
  return {
    id,
    sourceType: "",
    actualSource: "",
    sourceDetails: "",
    findings: "",
    importantPoints: "",
    combinedLearning: "",
    reliability: "",
    trustworthinessSelections: [],
    usage: "",
    effectSelection: "",
    isComplete: false,
    sourceId: origin === "during-research" ? id : undefined,
    sourceOrigin: origin,
  };
}

function migrateResearchEntry(raw: any, fallbackId: string): ResearchEntry {
  const rawContext = raw?.mapContext;
  const mapContext = rawContext && typeof rawContext === "object"
    ? {
        mapRowId: String(rawContext.mapRowId ?? ""),
        investigation: typeof rawContext.investigation === "string" ? rawContext.investigation : "",
        sourceTypes: Array.isArray(rawContext.sourceTypes)
          ? rawContext.sourceTypes.filter((source: unknown): source is string => typeof source === "string")
          : [],
        plannedSource: typeof rawContext.plannedSource === "string"
          ? rawContext.plannedSource
          : "",
        verification: typeof rawContext.verification === "string" ? rawContext.verification : "",
        verificationSelections: Array.isArray(rawContext.verificationSelections) ? rawContext.verificationSelections : [],
        addedAt: typeof rawContext.addedAt === "string"
          ? rawContext.addedAt
          : typeof raw?.addedAt === "string" ? raw.addedAt : "",
      }
    : undefined;
  const rawProvenance = raw?.sourceProvenance;
  const actualSource = typeof raw?.actualSource === "string"
    ? raw.actualSource
    : typeof raw?.source === "string"
      ? raw.source
      : typeof raw?.title === "string"
        ? raw.title
        : typeof raw?.url === "string" ? raw.url : "";
  const sourceProvenance = rawProvenance?.type === "teacher"
    && typeof rawProvenance.originalSource === "string"
    && rawProvenance.originalSource.trim()
    ? {
        type: "teacher" as const,
        originalSource: rawProvenance.originalSource.trim(),
        sourceId: typeof rawProvenance.sourceId === "string" && rawProvenance.sourceId.trim()
          ? rawProvenance.sourceId
          : teacherResourceSourceId(rawProvenance.originalSource),
      }
    : undefined;
  const id = String(raw?.id ?? fallbackId);
  const sourceOrigin: ResearchOrigin | undefined = raw?.sourceOrigin === "plan"
    || raw?.sourceOrigin === "teacher"
    || raw?.sourceOrigin === "during-research"
    ? raw.sourceOrigin
    : mapContext
      ? "plan"
      : sourceProvenance
        ? "teacher"
        : undefined;
  const sourceId = typeof raw?.sourceId === "string" && raw.sourceId.trim()
    ? raw.sourceId
    : mapContext?.mapRowId
      || sourceProvenance?.sourceId
      || `legacy:${id}`;
  const findings = typeof raw?.findings === "string" ? raw.findings : "";
  const importantPoints = typeof raw?.importantPoints === "string" ? raw.importantPoints : "";
  const combinedLearning = typeof raw?.combinedLearning === "string"
    ? raw.combinedLearning
    : combineLegacyLearning(findings, importantPoints);
  return {
    id,
    sourceType: typeof raw?.sourceType === "string" ? sourceTypeForHandoff(raw.sourceType) : "",
    sourceDetails: typeof raw?.sourceDetails === "string"
      ? raw.sourceDetails
      : typeof raw?.citation === "string" ? raw.citation : "",
    actualSource,
    findings,
    importantPoints,
    combinedLearning,
    reliability: typeof raw?.reliability === "string" ? raw.reliability : "",
    trustworthinessSelections: Array.isArray(raw?.trustworthinessSelections) ? raw.trustworthinessSelections : [],
    usage: typeof raw?.usage === "string" ? raw.usage : "",
    effectSelection: typeof raw?.effectSelection === "string" ? raw.effectSelection : undefined,
    isComplete: typeof raw?.isComplete === "boolean" ? raw.isComplete : undefined,
    sourceId,
    ...(sourceOrigin ? { sourceOrigin } : {}),
    ...(typeof raw?.addedAt === "string" ? { addedAt: raw.addedAt } : {}),
    ...(mapContext ? { mapContext } : {}),
    ...(sourceProvenance ? { sourceProvenance } : {}),
  };
}

type MapPlanRow = {
  id: string;
  investigation: string;
  sources: string[];
  plannedSource: string;
  actualSource: string;
  verification: string;
  verificationSelections?: string[];
  showPlannedSource?: boolean;
  showActualSourcePanel?: boolean;
};
type MapAnswers = {
  taskUnderstanding: string;
  priorKnowledge: string[];
  knowledgeGaps: string[];
  enquiryQuestions: string[];
  researchPlan: MapPlanRow[];
  notes: string;
};

type StudentCompletionMarker = {
  complete: boolean;
  markedAt: string | null;
  sectionsMissing: boolean;
};

const STUDENT_COMPLETION_KEY = "_studentCompletion";

function readStudentCompletion(content: unknown): StudentCompletionMarker | undefined {
  if (!content || typeof content !== "object") return undefined;
  const marker = (content as Record<string, unknown>)[STUDENT_COMPLETION_KEY];
  if (!marker || typeof marker !== "object" || typeof (marker as Record<string, unknown>).complete !== "boolean") return undefined;
  return {
    complete: (marker as Record<string, unknown>).complete as boolean,
    markedAt: typeof (marker as Record<string, unknown>).markedAt === "string" ? (marker as Record<string, unknown>).markedAt as string : null,
    sectionsMissing: (marker as Record<string, unknown>).sectionsMissing === true,
  };
}

function isMapPlanRowComplete(row: MapPlanRow) {
  const verificationSelections = row.verificationSelections ?? [];
  return Boolean(
    row.investigation.trim()
    && row.sources.some((source) => source.trim())
    && (verificationSelections.some((selection) => selection.trim()) || row.verification.trim()),
  );
}

function isMapComplete(answers: MapAnswers) {
  return answers.taskUnderstanding.trim().length >= 20
    && answers.priorKnowledge.filter((item) => item.trim()).length >= 2
    && answers.knowledgeGaps.filter((item) => item.trim()).length >= 3
    && answers.enquiryQuestions.filter((item) => item.trim()).length >= 3
    && answers.researchPlan.length > 0
    && answers.researchPlan.every(isMapPlanRowComplete);
}

const DEFAULT_MAP_ANSWERS: MapAnswers = {
  taskUnderstanding: "",
  priorKnowledge: [""],
  knowledgeGaps: [""],
  enquiryQuestions: ["", "", "", "", ""],
  researchPlan: [{ id: "1", investigation: "", sources: [], plannedSource: "", actualSource: "", verification: "", verificationSelections: [] }],
  notes: "",
};
function migrateMapPlanRow(raw: any, fallbackId: string): MapPlanRow {
  const rawSources: string[] = Array.isArray(raw?.sources)
    ? raw.sources.filter((source: unknown): source is string => typeof source === "string")
    : [];
  const sources: string[] = Array.from(new Set(
    rawSources
      .map((source: string) => sourceTypeForHandoff(source) || source.trim())
      .filter((source: string) => Boolean(source)),
  ));
  const legacySource = typeof raw?.source === "string" ? raw.source : "";
  return {
    id: String(raw?.id ?? fallbackId),
    investigation: typeof raw?.investigation === "string" ? raw.investigation : "",
    sources,
    plannedSource: typeof raw?.plannedSource === "string" ? raw.plannedSource : legacySource,
    actualSource: typeof raw?.actualSource === "string" ? raw.actualSource : legacySource,
    verification: typeof raw?.verification === "string" ? raw.verification : "",
    verificationSelections: Array.isArray(raw?.verificationSelections) ? raw.verificationSelections : [],
  };
}
function migrateMapAnswers(raw: any): MapAnswers {
  if (!raw || typeof raw !== "object") return DEFAULT_MAP_ANSWERS;
  if ("taskUnderstanding" in raw) {
    return {
      taskUnderstanding: raw.taskUnderstanding ?? "",
      priorKnowledge: Array.isArray(raw.priorKnowledge) && raw.priorKnowledge.length ? raw.priorKnowledge : [""],
      knowledgeGaps: Array.isArray(raw.knowledgeGaps) && raw.knowledgeGaps.length ? raw.knowledgeGaps : [""],
      enquiryQuestions: Array.isArray(raw.enquiryQuestions) && raw.enquiryQuestions.length ? raw.enquiryQuestions : ["", "", "", "", ""],
      researchPlan: Array.isArray(raw.researchPlan) && raw.researchPlan.length
        ? raw.researchPlan.map((row: any, index: number) => migrateMapPlanRow(row, String(index + 1)))
        : [{ id: "1", investigation: "", sources: [], plannedSource: "", actualSource: "", verification: "" }],
      notes: raw.notes ?? "",
    };
  }
  return {
    taskUnderstanding: raw.q1 ?? "",
    priorKnowledge: raw.q2 ? [raw.q2] : [""],
    knowledgeGaps: raw.q3 ? [raw.q3] : [""],
    enquiryQuestions: raw.q4 ? raw.q4.split(/\n/).map((s: string) => s.trim()).filter(Boolean) : ["", "", "", "", ""],
    researchPlan: [{ id: "legacy", investigation: raw.q5 ?? "", sources: [], plannedSource: "", actualSource: "", verification: "", verificationSelections: [] }],
    notes: "",
  };
}

function normaliseResource(resource: string): string {
  return resource.trim().toLocaleLowerCase();
}

function teacherResourceSourceId(resource: string): string {
  return `teacher:${normaliseResource(resource)}`;
}

function researchOriginLabel(origin?: ResearchOrigin): string | null {
  if (origin === "plan") return "From my Research Plan";
  if (origin === "teacher") return "Teacher-provided source";
  if (origin === "during-research") return "Added during research";
  return null;
}

function sourceProvenanceLabel(entry: ResearchEntry): string | null {
  if (!entry.actualSource.trim()) return null;
  return researchOriginLabel(entry.sourceOrigin)
    ?? (entry.mapContext ? "From my Research Plan" : null)
    ?? (entry.sourceProvenance ? "Teacher-provided source" : null);
}

function combineLegacyLearning(findings: string, importantPoints: string): string {
  const findingsValue = findings.trim();
  const importantValue = importantPoints.trim();
  if (!findingsValue) return importantValue;
  if (!importantValue || findingsValue === importantValue) return findingsValue;
  return `${findingsValue}\n\n${importantValue}`;
}

function researchEntryReadyToComplete(entry: ResearchEntry): boolean {
  return Boolean(
    entry.actualSource.trim()
    && entry.sourceType
    && entry.sourceDetails.trim()
    && (entry.combinedLearning ?? "").trim()
    && (entry.trustworthinessSelections?.length ?? 0) > 0
    && entry.reliability.trim()
    && entry.effectSelection
    && entry.usage.trim(),
  );
}

function addResourceToLog(
  current: ResearchEntry[],
  resource: string,
  options: {
    mapContext?: MapResearchContext;
    sourceProvenance?: SourceProvenance;
    sourceType?: SourceType | "";
    sourceId?: string;
    sourceOrigin?: ResearchOrigin;
  } = {},
): ResearchEntry[] {
  if (!resource.trim()) return current;
  if (options.sourceId && current.some((entry) => entry.sourceId === options.sourceId)) return current;
  const blankEntry = current.findIndex((entry) =>
    !entry.mapContext
    && !entry.actualSource.trim()
    && !entry.sourceType
    && !entry.sourceDetails.trim()
    && !entry.findings.trim()
    && !entry.importantPoints.trim()
    && !(entry.combinedLearning || "").trim()
    && !entry.reliability.trim()
    && !entry.usage.trim()
  );
  if (blankEntry >= 0) {
    return current.map((entry, index) => index === blankEntry
      ? {
          ...entry,
          actualSource: resource.trim(),
          sourceId: options.sourceId ?? entry.sourceId,
          sourceOrigin: options.sourceOrigin ?? entry.sourceOrigin,
          addedAt: options.mapContext?.addedAt ?? new Date().toISOString(),
          ...(options.sourceType ? { sourceType: options.sourceType } : {}),
          ...(options.mapContext ? { mapContext: options.mapContext } : {}),
          ...(options.sourceProvenance ? { sourceProvenance: options.sourceProvenance } : {}),
        }
      : entry
    );
  }
  return [...current, {
    ...emptyEntry(),
    actualSource: resource.trim(),
    sourceId: options.sourceId,
    sourceOrigin: options.sourceOrigin,
    addedAt: options.mapContext?.addedAt ?? new Date().toISOString(),
    ...(options.sourceType ? { sourceType: options.sourceType } : {}),
    ...(options.mapContext ? { mapContext: options.mapContext } : {}),
    ...(options.sourceProvenance ? { sourceProvenance: options.sourceProvenance } : {}),
  }];
}

function csvCell(val: string) {
  // Every exported value is explicitly text. Spreadsheet apps can otherwise
  // trim whitespace/control characters before evaluating a formula.
  const safeValue = `'${val}`;
  const escaped = safeValue.replace(/"/g, '""');
  return `"${escaped}"`;
}

function buildResearchCsv(entries: ResearchEntry[], startIdx = 0): string {
  const header = [
    "#",
    "Source origin",
    "Planned investigation",
    "Planned source types",
    "Planned source or link",
    "Planned verification method",
    "Actual source used",
    "Source type",
    "Source details / citation",
    "What the student found",
    "What the student considered most important",
    "Trustworthiness evaluation",
    "Effect on the student's thinking",
    "Date/time added to the Research Log",
    "What the student learned",
    "Trustworthiness checks",
    "Effect on the student's thinking selection",
    "Completion status",
  ];
  const rows = entries.map((e, i) => [
    String(startIdx + i + 1),
    sourceProvenanceLabel(e) ?? "Origin not recorded",
    e.mapContext?.investigation ?? "",
    e.mapContext?.sourceTypes?.join("; ") ?? "",
    e.mapContext?.plannedSource ?? "",
    [...(Array.isArray(e.mapContext?.verificationSelections) ? e.mapContext.verificationSelections : []), e.mapContext?.verification].filter(Boolean).join("; "),
    e.actualSource,
    e.sourceType || "Type not specified",
    e.sourceDetails,
    e.findings,
    e.importantPoints,
    e.reliability,
    e.usage,
    e.addedAt ?? "",
    e.combinedLearning ?? "",
    e.trustworthinessSelections?.join("; ") ?? "",
    e.effectSelection ?? "",
    e.isComplete ? "Complete" : "In progress",
  ].map(csvCell).join(","));
  return [header.map(csvCell).join(","), ...rows].join("\r\n");
}

function triggerCsvDownload(csv: string, filename: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  triggerBlobDownload(blob, filename);
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function studentElementExportText(selector: string): string | null {
  const source = document.querySelector(selector);
  if (!source) return null;
  const clone = source.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("details").forEach((details) => { details.open = true; });
  clone.querySelectorAll("[data-export-controls], button, form").forEach((element) => element.remove());
  clone.querySelectorAll("input, textarea, select").forEach((control) => {
    const replacement = document.createElement("div");
    replacement.className = "export-control-value";
    if (control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio")) {
      replacement.textContent = control.checked ? "☑ Selected" : "☐ Not selected";
    } else if (control instanceof HTMLTextAreaElement) {
      replacement.textContent = control.value || "None recorded";
    } else if (control instanceof HTMLSelectElement) {
      replacement.textContent = control.selectedOptions[0]?.textContent || "None recorded";
    } else if (control instanceof HTMLInputElement) {
      replacement.textContent = control.value || "None recorded";
    }
    control.replaceWith(replacement);
  });
  return (clone.innerText || clone.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
}

async function downloadStudentElementPdf(selector: string, title: string, filename: string) {
  const text = studentElementExportText(selector);
  if (!text) throw new Error("There is no recorded content to export.");
  await downloadStudentTextPdf(text, title, filename);
}

async function downloadStudentTextPdf(text: string, title: string, filename: string) {
  const blob = await apiFetchBlob("/student/export/pdf", {
    method: "POST",
    body: JSON.stringify({ title, text }),
  });
  triggerBlobDownload(blob, filename);
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatActivityDuration(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  if (safeSeconds === 0) return "No recorded time";
  if (safeSeconds < 60) return `${safeSeconds} second${safeSeconds === 1 ? "" : "s"}`;

  const minutes = Math.floor(safeSeconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  const hourLabel = `${hours} hour${hours === 1 ? "" : "s"}`;
  return remainingMinutes > 0
    ? `${hourLabel} ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}`
    : hourLabel;
}

function activityStageSeconds(activity: any, stage: Stage | null) {
  if (!stage) return 0;
  return activity?.summary?.pageDurations?.find((page: any) => page.stage === stage)?.durationSeconds ?? 0;
}

function activityCsv(activity: any) {
  const stages = ["MAP", "TORCH", "RESEARCH", "COMPASS", "EMBED"];
  const stageLabels: Record<string, string> = {
    MAP: "MAP",
    TORCH: "TORCH",
    RESEARCH: "Research",
    COMPASS: "COMPASS",
    EMBED: "Final Answer",
  };
  const pageSeconds = (entry: any, stage: string) =>
    entry?.pageDurations?.find((page: any) => page.stage === stage)?.durationSeconds ?? 0;
  const entries = Array.isArray(activity?.entries) ? activity.entries : [];
  const totalSeconds = activity?.summary?.totalSeconds ?? 0;
  const summaryRows: string[][] = [
    ["Metric", "Value"],
    ["Login sessions", activity?.summary?.loginSessionsAvailable
      ? activity.summary.loginSessionCount ? String(activity.summary.loginSessionCount) : "None recorded"
      : "Not available"],
    ["Total active time", totalSeconds > 0 ? formatActivityDuration(totalSeconds) : "None recorded"],
    ["Average session time", activity?.summary?.loginSessionsAvailable && activity.summary.averageLoginSessionSeconds > 0
      ? formatActivityDuration(activity.summary.averageLoginSessionSeconds)
      : "None recorded"],
    [],
    ["Time by Climb section", "Recorded time"],
    ...stages.map((stage) => {
      const seconds = activity?.summary?.pageDurations?.find((page: any) => page.stage === stage)?.durationSeconds ?? 0;
      return [stageLabels[stage], seconds > 0 ? formatActivityDuration(seconds) : "None recorded"];
    }),
    [],
    ["Activity period", "Duration", ...stages.map((stage) => `${stageLabels[stage]} time`)],
  ];
  const rows: string[][] = entries.map((entry: any) => {
    const started = new Date(entry.startedAt);
    return [
      started.toLocaleDateString(),
      formatDuration(entry.durationSeconds ?? 0),
      ...stages.map((stage) => formatDuration(pageSeconds(entry, stage))),
    ];
  });
  return [...summaryRows, ...(rows.length > 0 ? rows : [["None recorded", "", ...stages.map(() => "None recorded")]])]
    .map((row: string[]) => row.map((value: string) => csvCell(value)).join(",")).join("\r\n");
}

function teacherMessagesCsv(messages: any[]) {
  const rows = messages.length > 0
    ? messages.map((message) => [
        message.senderType === "student" ? "Student" : "Teacher",
        message.createdAt ? new Date(message.createdAt).toLocaleString("en-GB") : "Date/time not recorded",
        String(message.content ?? ""),
      ])
    : [["None recorded", "", ""]];
  return [
    ["Sender", "Date/time", "Message"],
    ...rows,
  ].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

const ATTAINMENT_COLOR: Record<string, string> = {
  emerging: "bg-red-100 text-red-700 border-red-200",
  developing: "bg-amber-100 text-amber-700 border-amber-200",
  secure: "bg-sky-100 text-sky-700 border-sky-200",
  exceeding: "bg-emerald-100 text-emerald-700 border-emerald-200",
};
const ATTAINMENT_LABEL: Record<string, string> = {
  emerging: "Emerging", developing: "Developing", secure: "Secure", exceeding: "Exceeding",
};
const FEEDBACK_ACKNOWLEDGEMENT_TIMEOUT_MS = 15_000;

function TeacherFeedbackBanner({
  stage,
  feedback,
  onAcknowledge,
  isAcknowledging = false,
  readOnly = false,
}: {
  stage: string;
  feedback: { formativeComment: string; comment: string; grade: string | null; studentAcknowledged: boolean } | undefined;
  onAcknowledge?: () => void;
  isAcknowledging?: boolean;
  readOnly?: boolean;
}) {
  if (!feedback) return null;
  const { formativeComment, studentAcknowledged } = feedback;
  const hasFormative = !!formativeComment?.trim();
  if (!hasFormative) return null;

  return (
    <div className="border-t border-neutral-200 bg-neutral-50 px-8 py-6 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs uppercase tracking-[0.2em] font-semibold text-neutral-400">
          Teacher Feedback — {stage}
        </p>
        {studentAcknowledged ? (
          <div className="flex items-center gap-1.5 text-emerald-600">
            <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
            <span className="text-xs font-semibold">Feedback actioned</span>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-red-400 shrink-0" />
              <span className="text-xs font-semibold text-red-600">You have feedback</span>
            </div>
            {readOnly ? (
              <span className="text-xs font-medium text-neutral-400">Read-only</span>
            ) : (
              <button
                onClick={onAcknowledge}
                disabled={isAcknowledging}
                className="text-xs font-medium text-neutral-600 hover:text-black border border-neutral-200 hover:border-neutral-400 rounded-xl px-3 py-1.5 transition-colors bg-white disabled:cursor-wait disabled:opacity-60"
              >
                {isAcknowledging ? "Saving..." : "Mark as actioned"}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="rounded-2xl bg-sky-50 border border-sky-100 px-5 py-4 space-y-1.5">
        <p className="text-xs font-semibold text-sky-600 uppercase tracking-widest">Formative Feedback</p>
        <p className="text-sm text-sky-900 leading-relaxed whitespace-pre-wrap">{formativeComment}</p>
      </div>
    </div>
  );
}

export default function Climb() {
  const [session, setSession] = useState<any>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceError, setWorkspaceError] = useState<WorkspaceFailureState | null>(null);
  const [taskLoaded, setTaskLoaded] = useState(false);
  const [activeStage, setActiveStage] = useState<Stage>("MAP");
  const activeStageRef = useRef<Stage>("MAP");
  const activityHeartbeatRef = useRef<((force?: boolean) => void) | null>(null);
  const [completedStages, setCompletedStages] = useState<Set<Stage>>(new Set());
  const [stageCompletions, setStageCompletions] = useState<Partial<Record<Stage, StudentCompletionMarker>>>({});
  const stageCompletionsRef = useRef<Partial<Record<Stage, StudentCompletionMarker>>>({});
  const [completionWarningStage, setCompletionWarningStage] = useState<Stage | null>(null);
  const [completionSavingStage, setCompletionSavingStage] = useState<Stage | null>(null);
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [teacherMessages, setTeacherMessages] = useState<any[]>([]);
  const [teacherUnreadCount, setTeacherUnreadCount] = useState(0);
  const [showTeacherMessages, setShowTeacherMessages] = useState(false);
  const [teacherMessagesLoading, setTeacherMessagesLoading] = useState(false);
  const [teacherMessagesError, setTeacherMessagesError] = useState("");
  const [teacherMessageDraft, setTeacherMessageDraft] = useState("");
  const [teacherMessageSending, setTeacherMessageSending] = useState(false);
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [showOverview, setShowOverview] = useState(true);
  const [showActivity, setShowActivity] = useState(false);
  const [activity, setActivity] = useState<any>(null);
  const [activityError, setActivityError] = useState("");
  const [activityLoading, setActivityLoading] = useState(false);
  const [showTaskModal, setShowTaskModal] = useState(false);
  const [task, setTask] = useState<any>(null);
  const [enabledStages, setEnabledStages] = useState<string[]>(["MAP", "TORCH", "COMPASS", "EMBED", "RESEARCH"]);

  const [stageToReset, setStageToReset] = useState<Stage | null>(null);
  const [isResetting, setIsResetting] = useState(false);

  const [mapAnswers, setMapAnswers] = useState<MapAnswers>(DEFAULT_MAP_ANSWERS);
  const mapIsComplete = isMapComplete(mapAnswers);
  const [mapShowSummary, setMapShowSummary] = useState(false);
  const [collapsedMapPlanRows, setCollapsedMapPlanRows] = useState<Set<string>>(new Set());
  const [researchEntries, setResearchEntries] = useState<ResearchEntry[]>([emptyEntry()]);
  const researchDirtyRef = useRef(false);
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set());
  const [compassAnswers, setCompassAnswers] = useState({ check1: "", check2: "", check3: "", check4: "", check5: "", sl1: false, sl2: false, sl3: false, sl4: false, sl5: false });
  const [embedAnswers, setEmbedAnswers] = useState({
    finalAnswer: "",
    supportingMaterials: "",
    supportingMaterialCards: [] as SupportingMaterialCard[],
    q1: "",
    q2: "",
    q3: "",
    q4: "",
  });
  const [supportingMaterialValidationError, setSupportingMaterialValidationError] = useState("");
  const [answerFeedbackAttempts, setAnswerFeedbackAttempts] = useState<AnswerFeedbackAttempt[]>([]);
  const [answerFeedbackLoading, setAnswerFeedbackLoading] = useState(false);
  const [answerFeedbackCount, setAnswerFeedbackCount] = useState(0);
  const ANSWER_FEEDBACK_LIMIT = 2;
  const FINAL_ANSWER_MAX_CHARACTERS = 50_000;
  const ANSWER_FEEDBACK_MAX_CHARACTERS = FINAL_ANSWER_MAX_CHARACTERS;
  const LEGACY_SUPPORTING_MATERIALS_MAX_CHARACTERS = 1_000;
  const [selectedBloomLevel, setSelectedBloomLevel] = useState<number | null>(null);
  const [torchSuggestions, setTorchSuggestions] = useState<Record<string, string[]>>({});
  const [torchSuggestionStatus, setTorchSuggestionStatus] = useState<TorchSuggestionStatus>("idle");
  const [torchSuggestionError, setTorchSuggestionError] = useState("");
  const [askedMapQuestions, setAskedMapQuestions] = useState<Set<number>>(new Set());
  const [usedTorchSuggestions, setUsedTorchSuggestions] = useState<Set<string>>(new Set());
  const [pendingTorchSuggestion, setPendingTorchSuggestion] = useState<TorchSuggestionSelection | null>(null);
  const editedTorchSuggestionKeysRef = useRef<Set<string>>(new Set());
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const [studentFeedback, setStudentFeedback] = useState<Record<string, { formativeComment: string; comment: string; grade: string | null; studentAcknowledged: boolean }>>({});
  const [acknowledgingFeedbackStage, setAcknowledgingFeedbackStage] = useState<string | null>(null);
  const [studentAutoSaveStatus, setStudentAutoSaveStatus] = useState<"saved" | "saving" | "error">("saved");
  const isLifecycleReadOnly = Boolean(session?.lockedAt || session?.archivedAt || session?.classArchivedAt);
  const isReadOnly = Boolean(isLifecycleReadOnly || task?.deadlineClosed);
  const readOnlyMessage = task?.deadlineClosed
    ? "This task is closed because its due date has passed. You can still view your work, but editing and AI tools are no longer available. Ask your teacher if you need the task reopened."
    : session?.archivedAt
    ? `This completed work has been archived${session.retentionUntil ? ` until ${new Date(session.retentionUntil).toLocaleDateString()}` : ""}. You can view it, but editing and AI tools are no longer available.`
    : session?.classArchivedAt
    ? "This class has been archived. You can view your work, but editing and AI tools are no longer available."
    : session?.isFinalised
    ? "The climb is complete. You can no longer edit this."
    : "Your work is locked. Please see your teacher.";

  const loadWorkspace = useCallback(async () => {
    setWorkspaceLoading(true);
    setWorkspaceError(null);
    try {
      const [nextSession, stages, nextTask, feedback, messages, savedAnswerFeedback, initialTeacherMessages] = await Promise.all([
        apiFetch("/student/session"),
        apiFetch("/student/stages") as Promise<any[]>,
        apiFetch("/student/task").catch((error: any) => {
          if (error?.status === 404) return null;
          throw error;
        }),
        apiFetch("/student/feedback"),
        apiFetch("/student/chat") as Promise<any[]>,
        apiFetch("/student/answer-feedback") as Promise<{ attempts?: AnswerFeedbackAttempt[] }>,
        apiFetch("/student/teacher-messages?markRead=false").catch(() => null),
      ]);

      setSession(nextSession);
      if (initialTeacherMessages) {
        setTeacherMessages(initialTeacherMessages.messages ?? []);
        setTeacherUnreadCount(initialTeacherMessages.unreadCount ?? 0);
      }

      const loadedCompletions: Partial<Record<Stage, StudentCompletionMarker>> = {};
      for (const entry of stages) {
        const marker = readStudentCompletion(entry.contentJson);
        if (marker) loadedCompletions[entry.stage as Stage] = marker;
      }
      stageCompletionsRef.current = loadedCompletions;
      setStageCompletions(loadedCompletions);
      const map = stages.find((entry) => entry.stage === "MAP");
      if (map?.contentJson) setMapAnswers(migrateMapAnswers(map.contentJson));
      const torch = stages.find((entry) => entry.stage === "TORCH");
      if (torch?.contentJson) setUsedTorchSuggestions(readUsedTorchSuggestionKeys(torch.contentJson));
      const research = stages.find((entry) => entry.stage === "RESEARCH");
      if (research?.contentJson?.entries?.length) {
        setResearchEntries(research.contentJson.entries.map((entry: any, index: number) =>
          migrateResearchEntry(entry, `research-${index + 1}`)
        ));
        setExpandedEntries(new Set());
        researchDirtyRef.current = false;
      }
      const compass = stages.find((entry) => entry.stage === "COMPASS");
      if (compass?.contentJson) setCompassAnswers(compass.contentJson);
      const embed = stages.find((entry) => entry.stage === "EMBED");
      if (embed?.contentJson) setEmbedAnswers({
        finalAnswer: String(embed.contentJson.finalAnswer ?? ""),
        supportingMaterials: String(embed.contentJson.supportingMaterials ?? ""),
        supportingMaterialCards: normaliseSupportingMaterialCards(embed.contentJson.supportingMaterialCards),
        q1: String(embed.contentJson.q1 ?? ""),
        q2: String(embed.contentJson.q2 ?? ""),
        q3: String(embed.contentJson.q3 ?? ""),
        q4: String(embed.contentJson.q4 ?? ""),
      });
      setActiveStage(deriveFurthestStage(stages));
      setCompletedStages(new Set(
        (Object.entries(loadedCompletions) as Array<[Stage, StudentCompletionMarker]>)
          .filter(([, marker]) => marker.complete)
          .map(([stage]) => stage),
      ));

      setTask(nextTask);
      setTaskLoaded(true);
      if (Array.isArray(nextTask?.enabledStages) && nextTask.enabledStages.length > 0) {
        setEnabledStages(nextTask.enabledStages);
      }

      if (feedback && typeof feedback === "object") setStudentFeedback(feedback);
      if (Array.isArray(messages)) {
        setChatMessages(messages.map((message) => ({
          role: message.role === "assistant" ? "ai" : message.role,
          ...splitTutorResponse(message.content),
        })));
      }
      const savedAttempts = Array.isArray(savedAnswerFeedback?.attempts)
        ? savedAnswerFeedback.attempts.slice(0, ANSWER_FEEDBACK_LIMIT)
        : [];
      setAnswerFeedbackAttempts(savedAttempts);
      setAnswerFeedbackCount(savedAttempts.length);
    } catch (err) {
      if (isStudentRecoveryError(err)) rememberStudentRecoveryNotice();
      if (isStudentRecoveryError(err) || isUnauthorizedError(err)) {
        setLocation("/join");
      } else {
        setWorkspaceError(classifyWorkspaceError(err));
      }
    } finally {
      setWorkspaceLoading(false);
    }
  }, [setLocation]);

  const openTeacherMessages = async () => {
    if (teacherMessagesLoading) return;
    setTeacherMessagesLoading(true);
    setTeacherMessagesError("");
    try {
      const result = await apiFetch("/student/teacher-messages?markRead=true");
      setTeacherMessages(result.messages ?? []);
      setTeacherUnreadCount(result.unreadCount ?? 0);
      setShowTeacherMessages(true);
    } catch (error: any) {
      setTeacherMessagesError(error?.message || "Messages could not be loaded.");
      toast({ title: "Messages unavailable", description: error?.message || "Please try again.", variant: "destructive" });
    } finally {
      setTeacherMessagesLoading(false);
    }
  };

  const sendTeacherMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!teacherMessageDraft.trim() || teacherMessageSending || isReadOnly) return;
    setTeacherMessageSending(true);
    setTeacherMessagesError("");
    try {
      const sent = await apiFetch("/student/teacher-messages", {
        method: "POST",
        body: JSON.stringify({ content: teacherMessageDraft.trim() }),
      });
      setTeacherMessages((current) => [...current, sent]);
      setTeacherMessageDraft("");
    } catch (error: any) {
      setTeacherMessagesError(error?.message || "Could not send message.");
    } finally {
      setTeacherMessageSending(false);
    }
  };

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    if (isLifecycleReadOnly) return;
    const lastInteractionAt = { current: null as number | null };
    const lastHeartbeatAt = { current: 0 };
    const activityIsOpen = { current: false };
    const heartbeatInFlight = { current: false };
    const heartbeatRequested = { current: false };

    const heartbeat = (force = false) => {
      if (document.visibilityState !== "visible") return;
      if (heartbeatInFlight.current) {
        if (force) heartbeatRequested.current = true;
        return;
      }
      if (
        !force
        && activityIsOpen.current
        && Date.now() - lastHeartbeatAt.current < ACTIVITY_HEARTBEAT_INTERVAL_MS
      ) return;
      heartbeatInFlight.current = true;
      const stage = activeStageRef.current;
      void apiFetch("/student/activity/heartbeat", {
        method: "POST",
        body: JSON.stringify({ stage }),
      })
        .then(() => {
          activityIsOpen.current = true;
          lastHeartbeatAt.current = Date.now();
        })
        .catch(() => {})
        .finally(() => {
          heartbeatInFlight.current = false;
          if (heartbeatRequested.current) {
            heartbeatRequested.current = false;
            heartbeat(true);
          }
        });
    };
    activityHeartbeatRef.current = heartbeat;
    const pause = () => {
      if (!activityIsOpen.current) return;
      activityIsOpen.current = false;
      lastHeartbeatAt.current = 0;
      void apiFetch("/student/activity/pause", { method: "POST" }).catch(() => {});
    };
    const recordInteraction = () => {
      if (document.visibilityState !== "visible") return;
      lastInteractionAt.current = Date.now();
      heartbeat();
    };
    const checkActivity = () => {
      if (document.visibilityState !== "visible") {
        pause();
        return;
      }
      const lastInteraction = lastInteractionAt.current;
      if (lastInteraction === null || Date.now() - lastInteraction > ACTIVITY_INACTIVITY_TIMEOUT_MS) {
        pause();
        return;
      }
      heartbeat();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        pause();
      } else {
        checkActivity();
      }
    };
    const interactionEvents: Array<keyof WindowEventMap> = [
      "pointerdown",
      "keydown",
      "input",
      "scroll",
      "touchstart",
      "focusin",
    ];
    interactionEvents.forEach((eventName) => window.addEventListener(eventName, recordInteraction, { passive: true }));
    const interval = window.setInterval(checkActivity, ACTIVITY_HEARTBEAT_INTERVAL_MS);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(interval);
      interactionEvents.forEach((eventName) => window.removeEventListener(eventName, recordInteraction));
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      activityHeartbeatRef.current = null;
    };
  }, [isLifecycleReadOnly]);

  useEffect(() => {
    activeStageRef.current = activeStage;
  }, [activeStage]);

  useEffect(() => {
    if (!task?.deadlineClosesAt || task.deadlineClosed || task.lateEditingAllowed) return;
    const closesAt = new Date(task.deadlineClosesAt).getTime();
    let timer: number | undefined;
    const scheduleDeadlineCheck = () => {
      const remaining = closesAt - Date.now();
      if (remaining <= 0) {
        setTask((current: any) => current ? { ...current, deadlineClosed: true } : current);
        return;
      }
      timer = window.setTimeout(scheduleDeadlineCheck, Math.min(remaining, 6 * 60 * 60 * 1000));
    };
    scheduleDeadlineCheck();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [task?.deadlineClosesAt, task?.deadlineClosed, task?.lateEditingAllowed]);

  const markTaskClosedFromError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("task is closed because its due date has passed")) {
      setTask((current: any) => current ? { ...current, deadlineClosed: true } : current);
    }
  }, []);

  const openActivity = async () => {
    setShowActivity(true);
    setActivityLoading(true);
    setActivityError("");
    try {
      setActivity(await apiFetch("/student/activity"));
    } catch (err: any) {
      setActivityError(err.message ?? "Unable to load your activity.");
    } finally {
      setActivityLoading(false);
    }
  };
  const downloadActivityPdf = async () => {
    try {
      await downloadStudentElementPdf('[data-student-export="activity"]', "My Activity", "my-activity.pdf");
    } catch (error: any) {
      toast({ title: "Activity PDF could not be downloaded", description: error?.message ?? "Please try again.", variant: "destructive" });
    }
  };
  const downloadActivityCsv = () => {
    triggerCsvDownload(activityCsv(activity), "my-activity.csv");
  };
  const downloadMessagesPdf = async () => {
    try {
      await downloadStudentElementPdf('[data-student-export="messages"]', "Messages", "messages.pdf");
    } catch (error: any) {
      toast({ title: "Messages PDF could not be downloaded", description: error?.message ?? "Please try again.", variant: "destructive" });
    }
  };
  const downloadMessagesCsv = () => {
    triggerCsvDownload(teacherMessagesCsv(teacherMessages), "messages.csv");
  };

  const mapAnswersRef = useRef(mapAnswers);
  const researchEntriesRef = useRef(researchEntries);
  const compassAnswersRef = useRef(compassAnswers);
  const embedAnswersRef = useRef(embedAnswers);
  const stageSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => { mapAnswersRef.current = mapAnswers; }, [mapAnswers]);
  useEffect(() => { researchEntriesRef.current = researchEntries; }, [researchEntries]);
  useEffect(() => { compassAnswersRef.current = compassAnswers; }, [compassAnswers]);
  useEffect(() => { embedAnswersRef.current = embedAnswers; }, [embedAnswers]);

  const saveMap = useCallback(async () => {
    if (isReadOnly) return false;
    setStudentAutoSaveStatus("saving");
    try {
      await apiFetch("/student/stages/MAP", { method: "PUT", body: JSON.stringify({ contentJson: {
        ...mapAnswersRef.current,
        ...(stageCompletionsRef.current.MAP ? { [STUDENT_COMPLETION_KEY]: stageCompletionsRef.current.MAP } : {}),
      } }) });
      setStudentAutoSaveStatus("saved");
      return true;
    } catch (error) {
      markTaskClosedFromError(error);
      setStudentAutoSaveStatus("error");
      return false;
    }
  }, [isReadOnly, markTaskClosedFromError]);

  const loadTorchSuggestions = useCallback(async () => {
    if (isReadOnly || torchSuggestionStatus === "loading") return;
    setTorchSuggestionStatus("loading");
    setTorchSuggestionError("");
    clearTimeout(stageSaveTimers.current.MAP);
    const mapSaved = await saveMap();
    if (!mapSaved) {
      setTorchSuggestionError("Your latest MAP planning could not be saved. Save your work before trying again.");
      setTorchSuggestionStatus("error");
      return;
    }
    try {
      const response = await apiFetch("/student/torch-suggestions");
      const suggestions = response && typeof response === "object" && response.suggestions && typeof response.suggestions === "object"
        ? response.suggestions as Record<string, string[]>
        : {};
      const hasSuggestions = Object.values(suggestions).some((items) => Array.isArray(items) && items.length > 0);
      setTorchSuggestions(suggestions);
      setTorchSuggestionStatus(hasSuggestions ? "ready" : "empty");
    } catch (error: any) {
      if (isStudentRecoveryError(error)) rememberStudentRecoveryNotice();
      if (isStudentRecoveryError(error) || isUnauthorizedError(error)) {
        setLocation("/join");
        return;
      }
      setTorchSuggestionError(error?.message ?? "Suggested questions are temporarily unavailable.");
      setTorchSuggestionStatus("error");
    }
  }, [isReadOnly, saveMap, setLocation, torchSuggestionStatus]);
  const saveResearch = useCallback(async () => {
    if (isReadOnly) return false;
    if (!researchDirtyRef.current) return true;
    setStudentAutoSaveStatus("saving");
    try {
      await apiFetch("/student/stages/RESEARCH", { method: "PUT", body: JSON.stringify({ contentJson: {
        entries: researchEntriesRef.current,
        ...(stageCompletionsRef.current.RESEARCH ? { [STUDENT_COMPLETION_KEY]: stageCompletionsRef.current.RESEARCH } : {}),
      } }) });
      researchDirtyRef.current = false;
      setStudentAutoSaveStatus("saved");
      return true;
    } catch (error) {
      markTaskClosedFromError(error);
      setStudentAutoSaveStatus("error");
      return false;
    }
  }, [isReadOnly, markTaskClosedFromError]);
  const flushResearchSave = useCallback(async () => {
    clearTimeout(stageSaveTimers.current.RESEARCH);
    return saveResearch();
  }, [saveResearch]);
  const saveCompass = useCallback(async () => {
    if (isReadOnly) return;
    setStudentAutoSaveStatus("saving");
    try {
      await apiFetch("/student/stages/COMPASS", { method: "PUT", body: JSON.stringify({ contentJson: {
        ...compassAnswersRef.current,
        ...(stageCompletionsRef.current.COMPASS ? { [STUDENT_COMPLETION_KEY]: stageCompletionsRef.current.COMPASS } : {}),
      } }) });
      setStudentAutoSaveStatus("saved");
    } catch (error) {
      markTaskClosedFromError(error);
      setStudentAutoSaveStatus("error");
    }
  }, [isReadOnly, markTaskClosedFromError]);
  const saveEmbed = useCallback(async () => {
    if (isReadOnly) return;
    setStudentAutoSaveStatus("saving");
    try {
      await apiFetch("/student/stages/EMBED", { method: "PUT", body: JSON.stringify({ contentJson: {
        ...embedAnswersRef.current,
        supportingMaterialCards: supportingMaterialCardsForPersistence(embedAnswersRef.current.supportingMaterialCards),
        ...(stageCompletionsRef.current.EMBED ? { [STUDENT_COMPLETION_KEY]: stageCompletionsRef.current.EMBED } : {}),
      } }) });
      setStudentAutoSaveStatus("saved");
    } catch (error) {
      markTaskClosedFromError(error);
      setStudentAutoSaveStatus("error");
    }
  }, [isReadOnly, markTaskClosedFromError]);
  const updateSupportingMaterial = (index: number, patch: Partial<SupportingMaterialCard>) => {
    const supportingMaterialCards = embedAnswers.supportingMaterialCards.map((card, cardIndex) =>
      cardIndex === index ? { ...card, ...patch } : card
    );
    if (supportingMaterialCardsTextLength(supportingMaterialCards) > SUPPORTING_MATERIAL_MAX_CHARACTERS) {
      setSupportingMaterialValidationError("Supporting materials can contain at most 10,000 characters. Delete some text before adding more.");
      return;
    }
    setSupportingMaterialValidationError("");
    setEmbedAnswers({ ...embedAnswers, supportingMaterialCards });
  };
  const addSupportingMaterial = () => {
    setSupportingMaterialValidationError("");
    setEmbedAnswers((current) => ({
      ...current,
      supportingMaterialCards: [...current.supportingMaterialCards, emptySupportingMaterial()],
    }));
  };
  const removeSupportingMaterial = (index: number) => {
    setSupportingMaterialValidationError("");
    setEmbedAnswers((current) => ({
      ...current,
      supportingMaterialCards: current.supportingMaterialCards.filter((_, cardIndex) => cardIndex !== index),
    }));
  };

  useEffect(() => {
    clearTimeout(stageSaveTimers.current.MAP);
    stageSaveTimers.current.MAP = setTimeout(() => { void saveMap(); }, 1500);
    return () => clearTimeout(stageSaveTimers.current.MAP);
  }, [mapAnswers, saveMap]);

  useEffect(() => {
    clearTimeout(stageSaveTimers.current.RESEARCH);
    stageSaveTimers.current.RESEARCH = setTimeout(() => { void saveResearch(); }, 1500);
    return () => clearTimeout(stageSaveTimers.current.RESEARCH);
  }, [researchEntries, saveResearch]);

  useEffect(() => {
    clearTimeout(stageSaveTimers.current.COMPASS);
    stageSaveTimers.current.COMPASS = setTimeout(() => { void saveCompass(); }, 1500);
    return () => clearTimeout(stageSaveTimers.current.COMPASS);
  }, [compassAnswers, saveCompass]);

  useEffect(() => {
    clearTimeout(stageSaveTimers.current.EMBED);
    stageSaveTimers.current.EMBED = setTimeout(() => { void saveEmbed(); }, 1500);
    return () => clearTimeout(stageSaveTimers.current.EMBED);
  }, [embedAnswers, saveEmbed]);

  useEffect(() => registerBeforeLogout(async () => {
    Object.values(stageSaveTimers.current).forEach(clearTimeout);
    await Promise.all([saveMap(), saveResearch(), saveCompass(), saveEmbed()]);
  }), [saveCompass, saveEmbed, saveMap, saveResearch]);

  const handleSignOut = async () => {
    try { await apiFetch("/student/logout", { method: "POST" }); } catch {}
    clearStudentSession();
    setLocation("/join");
  };

  const acknowledgeFeedback = useCallback(async (stage: string) => {
    if (isReadOnly || acknowledgingFeedbackStage) return;
    setAcknowledgingFeedbackStage(stage);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), FEEDBACK_ACKNOWLEDGEMENT_TIMEOUT_MS);
    try {
      await apiFetch(`/student/feedback/${stage}/acknowledge`, {
        method: "POST",
        signal: controller.signal,
      });
      setStudentFeedback((previous) => {
        const current = previous[stage];
        return current
          ? { ...previous, [stage]: { ...current, studentAcknowledged: true } }
          : previous;
      });
    } catch (error: any) {
      toast({
        title: "Could not mark feedback as actioned",
        description: error?.name === "AbortError"
          ? "Saving took too long. Check your connection and try again."
          : error?.message ?? "Please try again.",
        variant: "destructive",
      });
    } finally {
      window.clearTimeout(timeout);
      setAcknowledgingFeedbackStage(null);
    }
  }, [acknowledgingFeedbackStage, isReadOnly, toast]);

  const [showPinModal, setShowPinModal] = useState(false);
  const [pinForm, setPinForm] = useState({ current: "", next: "", confirm: "" });
  const [pinLoading, setPinLoading] = useState(false);
  const [pinSuccess, setPinSuccess] = useState(false);
  const [pinError, setPinError] = useState("");

  const handleChangePin = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinError("");
    if (pinForm.next !== pinForm.confirm) { setPinError("New PINs don't match"); return; }
    if (!/^\d{6}$/.test(pinForm.next)) { setPinError("PIN must be exactly 6 digits"); return; }
    setPinLoading(true);
    try {
      await apiFetch("/student/change-pin", {
        method: "POST",
        body: JSON.stringify({ currentPin: pinForm.current, newPin: pinForm.next }),
      });
      setPinSuccess(true);
      setPinForm({ current: "", next: "", confirm: "" });
    } catch (err: any) {
      setPinError(err.message ?? "Something went wrong");
    } finally {
      setPinLoading(false);
    }
  };

  const handleSwitchClass = async () => {
    sessionStorage.setItem("switchName", session.studentName ?? "");
    try { await apiFetch("/student/logout", { method: "POST" }); } catch {}
    clearStudentSession();
    setLocation("/join?switch=1");
  };

  const activeEnabled = STAGES.filter(s => enabledStages.includes(s));

  const handleStageNavigation = useCallback(async (stage: Stage) => {
    if (!isReadOnly && !(await flushResearchSave())) return;
    activeStageRef.current = stage;
    setActiveStage(stage);
    setShowOverview(false);
    activityHeartbeatRef.current?.(true);
  }, [flushResearchSave, isReadOnly]);

  const goNext = () => {
    const idx = activeEnabled.indexOf(activeStage);
    if (idx < activeEnabled.length - 1) void handleStageNavigation(activeEnabled[idx + 1]);
  };

  const goPrev = () => {
    const idx = activeEnabled.indexOf(activeStage);
    if (idx > 0) void handleStageNavigation(activeEnabled[idx - 1]);
  };

  const handleInvestigate = async () => {
    if (!chatInput.trim() || isChatLoading) return;
    const msg = chatInput.trim();
    const torchSuggestion = pendingTorchSuggestion;
    const promptSource: TorchPromptSource = mapAnswers.enquiryQuestions.some((question) => question.trim() === msg)
      ? "From your MAP"
      : torchSuggestion
        ? "Suggested question"
        : "Your own question";
    setChatInput("");
    setPendingTorchSuggestion(null);
    setIsChatLoading(true);
    const tempUserMsg = { role: "user", content: msg, promptSource };
    setChatMessages((prev) => [...prev, tempUserMsg]);

    try {
      const response = await apiFetch("/student/chat", {
        method: "POST",
        body: JSON.stringify({
          message: msg,
          bloomLevel: selectedBloomLevel !== null ? goalLevels[selectedBloomLevel].label : undefined,
          ...(torchSuggestion ? { torchSuggestion } : {}),
        }),
      });

       if (torchSuggestion) {
         setUsedTorchSuggestions((previous) => new Set([
           ...previous,
           torchSuggestionKey(torchSuggestion.goal, torchSuggestion.question),
         ]));
       }
       setChatMessages((prev) => [...prev, { role: "ai", ...splitTutorResponse(response.content) }]);
    } catch (err: any) {
      setChatMessages((prev) => prev.filter((m) => m !== tempUserMsg));
      if (torchSuggestion) {
        setChatInput(msg);
        setPendingTorchSuggestion(torchSuggestion);
      }
      const errMsg: string = err.message ?? "";
      markTaskClosedFromError(err);
      const isSession = errMsg.includes("No active student session") || errMsg.includes("401");
      const isNotConfigured = errMsg.includes("not configured") || errMsg.includes("AI_PROVIDER");
      const isQuota = errMsg.includes("quota") || errMsg.includes("429") || errMsg.includes("Too Many Requests");
      const isRecovery = isStudentRecoveryError(err);
      if (isSession || isRecovery) {
        if (isRecovery) rememberStudentRecoveryNotice();
        setLocation("/join");
      } else if (isNotConfigured) {
        setChatMessages((prev) => [
          ...prev,
          { role: "system-error", content: "The AI tutor isn't available right now — your school technician needs to configure it." },
        ]);
      } else if (isQuota) {
        setChatMessages((prev) => [
          ...prev,
          { role: "system-error", content: "The AI tutor is temporarily busy. Wait a moment and try again." },
        ]);
      } else {
        setChatMessages((prev) => [
          ...prev,
          { role: "system-error", content: errMsg || "Something went wrong. Please try again." },
        ]);
      }
    } finally {
      setIsChatLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleInvestigate();
    }
  };

  const handleResetStage = async () => {
    if (!stageToReset) return;
    setIsResetting(true);
    try {
      await apiFetch(`/student/stages/${stageToReset}`, { method: "DELETE" });
      setCompletedStages((prev) => {
        const next = new Set(prev);
        next.delete(stageToReset);
        return next;
      });
      if (stageToReset === "MAP") {
        setMapAnswers(DEFAULT_MAP_ANSWERS);
        setMapShowSummary(false);
      } else if (stageToReset === "RESEARCH") {
        setResearchEntries([emptyEntry()]);
        setExpandedEntries(new Set());
        researchDirtyRef.current = false;
      } else if (stageToReset === "COMPASS") {
        setCompassAnswers({ check1: "", check2: "", check3: "", check4: "", check5: "", sl1: false, sl2: false, sl3: false, sl4: false, sl5: false });
      } else if (stageToReset === "EMBED") {
        setSupportingMaterialValidationError("");
        setEmbedAnswers({
          finalAnswer: "",
          supportingMaterials: "",
          supportingMaterialCards: [],
          q1: "",
          q2: "",
          q3: "",
          q4: "",
        });
      }
      toast({ title: `${stageToReset} cleared`, description: "You can now start this stage fresh." });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setIsResetting(false);
      setStageToReset(null);
    }
  };

  const bloomLevels: TorchGoal[] = [
    { label: "Remember", emoji: "🧠", description: "I need to recall definitions, key terms, facts, or foundational information.", placeholder: "What concept, fact, or key term would you like to recall?" },
    { label: "Understand", emoji: "📖", description: "I don't fully understand something and need it explained more clearly.", placeholder: "What would you like explained more clearly?" },
    { label: "Apply", emoji: "🛠️", description: "I want to use what I've learned — solve a problem or try a real example.", placeholder: "What would you like to practise or use in an example?" },
    { label: "Analyse", emoji: "🔍", description: "I want to break something apart — find causes, patterns, or connections.", placeholder: "What would you like to break down, compare, or investigate?" },
    { label: "Evaluate", emoji: "⚖️", description: "I need to make a judgement — weigh evidence or assess an argument.", placeholder: "What argument, source, or decision do you want to assess?" },
    { label: "Create", emoji: "💡", description: "I'm trying to produce something new — plan, design, or write original work.", placeholder: "What are you trying to design, plan, or produce?" },
  ];
  const knowledgeDimensionLevels: TorchGoal[] = [
    { label: "Factual Knowledge", emoji: "📚", description: FRAMEWORK_DESCRIPTIONS["Factual Knowledge"], placeholder: "What facts, terms, or details do you need to learn?" },
    { label: "Conceptual Knowledge", emoji: "🧩", description: FRAMEWORK_DESCRIPTIONS["Conceptual Knowledge"], placeholder: "What connections, principles, or ideas would you like to understand?" },
    { label: "Procedural Knowledge", emoji: "🛠️", description: FRAMEWORK_DESCRIPTIONS["Procedural Knowledge"], placeholder: "What method, skill, or process would you like to practise?" },
  ];
  const goalPresets = task?.learningFramework === "knowledge_dimensions" ? knowledgeDimensionLevels : bloomLevels;
  const configuredGoals: string[] = task?.learningFramework === "knowledge_dimensions"
    ? (Array.isArray(task?.knowledgeDimensions) ? task.knowledgeDimensions : [])
      .filter((label: unknown): label is string => typeof label === "string")
      .map((label: string) => label.trim())
      .filter((label: string) => knowledgeDimensionLevels.some((goal) => goal.label === label))
    : (Array.isArray(task?.bloomLevels) ? task.bloomLevels : [])
      .filter((label: unknown): label is string => typeof label === "string")
      .map((label: string) => label.trim())
      .filter(Boolean);
  const goalLevels: TorchGoal[] = (configuredGoals.length ? configuredGoals : goalPresets.map((goal) => goal.label))
    .map((label) => goalPresets.find((goal) => goal.label === label) ?? {
      label,
      emoji: "🎯",
      description: `Focus your thinking on ${label}.`,
      placeholder: `What would you like help with in ${label}?`,
    });
  const teacherResources: string[] = Array.from(new Map<string, string>(
    (Array.isArray(task?.resources) ? task.resources : [])
      .filter((resource: unknown): resource is string => typeof resource === "string" && Boolean(resource.trim()))
      .map((resource: string) => [normaliseResource(resource), resource.trim()])
  ).values());
  const loggedSourceIds = new Set(researchEntries.map((entry) => entry.sourceId).filter(Boolean));

  const compassChecks = [
    { key: "check1", title: "Say it in your own words", prompt: "Without looking at your notes, what is the key conclusion or argument you've reached? Write it in plain language, as if explaining to someone who knows nothing about it." },
    { key: "check2", title: "The strongest challenge to your thinking", prompt: "What is the best argument or evidence that challenges your current position? Have you genuinely engaged with it, or have you ignored it?" },
    { key: "check3", title: "Where you're least confident", prompt: "What part of your understanding is weakest or most uncertain? What would you need to feel more confident about it?" },
    { key: "check4", title: "Is your evidence balanced?", prompt: "Looking across all your sources — do they represent more than one perspective? Is there a significant viewpoint or counterargument missing from your research? If so, what is it?" },
    { key: "check5", title: "Are you ready to write?", prompt: "Looking honestly at everything — do you understand this well enough to write a well-supported answer? If not, what is still missing?" },
  ] as const;

  const embedQuestions = [
    { key: "q1", title: "What changed in your understanding?" },
    { key: "q2", title: "Where did YOU do the thinking?" },
    { key: "q3", title: "How did AI help your learning?" },
    { key: "q4", title: "What did you decide not to trust?" },
  ] as const;
  const markResourceAsUsed = (resource: string) => {
    if (isReadOnly) return;
    researchDirtyRef.current = true;
    setResearchEntries((current) => addResourceToLog(current, resource, {
      sourceId: teacherResourceSourceId(resource),
      sourceOrigin: "teacher",
      sourceType: resource.trim().match(/^https?:\/\//i) ? "Website" : "Other",
      sourceProvenance: {
        type: "teacher",
        originalSource: resource.trim(),
        sourceId: teacherResourceSourceId(resource),
      },
    }));
  };
  const markMapSourceAsUsed = (row: MapPlanRow) => {
    const actualSource = (row.actualSource.trim() || row.plannedSource.trim());
    if (isReadOnly || !actualSource) return;
    researchDirtyRef.current = true;
    const addedAt = new Date().toISOString();
    setResearchEntries((current) => addResourceToLog(current, actualSource, {
      sourceId: row.id,
      sourceOrigin: "plan",
      mapContext: {
        mapRowId: row.id,
        investigation: row.investigation.trim(),
        sourceTypes: [...row.sources],
        plannedSource: row.plannedSource.trim(),
        verification: row.verification.trim(),
        verificationSelections: row.verificationSelections ? [...row.verificationSelections] : [],
        addedAt,
      },
      sourceType: sourceTypeForHandoff(row.sources[0] ?? ""),
    }));
  };
  const updateEntry = (
    id: string,
    field: "actualSource" | "sourceType" | "sourceDetails" | "findings" | "importantPoints" | "combinedLearning" | "reliability" | "usage" | "effectSelection",
    value: string,
  ) => {
    researchDirtyRef.current = true;
    setResearchEntries((prev) => prev.map((entry) => {
      if (entry.id !== id) return entry;
      if (field === "actualSource" && value.trim() && !entry.addedAt) {
        return {
          ...entry,
          actualSource: value,
          addedAt: new Date().toISOString(),
          sourceId: entry.sourceId ?? entry.id,
          sourceOrigin: entry.sourceOrigin ?? "during-research",
        };
      }
      const updated = { ...entry, [field]: value };
      return updated.isComplete && !researchEntryReadyToComplete(updated)
        ? { ...updated, isComplete: false }
        : updated;
    }));
  };
  const addEntry = () => {
    researchDirtyRef.current = true;
    setResearchEntries((prev) => [...prev, emptyEntry()]);
  };
  const removeEntry = (id: string) => {
    researchDirtyRef.current = true;
    setResearchEntries((prev) => prev.length > 1 ? prev.filter((e) => e.id !== id) : prev);
  };

  if (workspaceError) {
    return <WorkspaceRequestState workspace="Student climb" state={workspaceError} onRetry={loadWorkspace} />;
  }
  if (workspaceLoading || !session) {
    return <WorkspaceRequestState workspace="Student climb" state="loading" />;
  }

  const stageIndex = STAGES.indexOf(activeStage);

  const stageExportBasenames: Record<Stage, string> = {
    MAP: "map-export",
    TORCH: "torch-export",
    RESEARCH: "research-export",
    COMPASS: "compass-export",
    EMBED: "final-response-export",
  };
  const downloadActiveStage = () => {
    let rows: Array<Array<string>> = [["Field", "Response"]];
    if (activeStage === "MAP") rows = [["Field", "Response"], ...Object.entries(mapAnswers).map(([key, value]) => [key, Array.isArray(value) ? JSON.stringify(value) : String(value ?? "")])];
    if (activeStage === "TORCH") rows = [["Role", "Message"], ...chatMessages.map((message) => [message.role, message.content])];
    if (activeStage === "RESEARCH") rows = [
      [
        "Source origin",
        "Planned investigation",
        "Planned source types",
        "Planned source or link",
        "Planned verification method",
        "Actual source used",
        "Source type",
        "Source details / citation",
        "What the student found",
        "What the student considered most important",
        "Trustworthiness evaluation",
        "Effect on the student's thinking",
        "Date/time added to the Research Log",
        "What the student learned",
        "Trustworthiness checks",
        "Effect on the student's thinking selection",
        "Completion status",
      ],
      ...researchEntries.map((entry) => [
        sourceProvenanceLabel(entry) ?? "Origin not recorded",
        entry.mapContext?.investigation ?? "",
        entry.mapContext?.sourceTypes?.join("; ") ?? "",
        entry.mapContext?.plannedSource ?? "",
        [...(entry.mapContext?.verificationSelections ?? []), entry.mapContext?.verification].filter(Boolean).join("; "),
        entry.actualSource,
        entry.sourceType || "Type not specified",
        entry.sourceDetails,
        entry.findings,
        entry.importantPoints,
        entry.reliability,
        entry.usage,
        entry.addedAt ?? "",
        entry.combinedLearning ?? "",
        entry.trustworthinessSelections?.join("; ") ?? "",
        entry.effectSelection ?? "",
        entry.isComplete ? "Complete" : "In progress",
      ]),
    ];
    if (activeStage === "COMPASS") rows = [["Field", "Response"], ...Object.entries(compassAnswers).map(([key, value]) => [key, String(value ?? "")])];
    if (activeStage === "EMBED") {
      rows = [
        ["Field", "Response"],
        ["Final answer", answerReadableText(embedAnswers.finalAnswer)],
        ["Legacy supporting materials", embedAnswers.supportingMaterials],
        ...supportingMaterialCardsForPersistence(embedAnswers.supportingMaterialCards).flatMap((card, index) => [
          [`Supporting material ${index + 1} — Name of the material`, card.name],
          [`Supporting material ${index + 1} — Type of material`, card.type],
          [`Supporting material ${index + 1} — What does it show?`, card.whatItShows],
          [`Supporting material ${index + 1} — Why is it relevant to your answer?`, card.whyRelevant],
          [`Supporting material ${index + 1} — Where is it referred to in your Final Answer?`, card.finalResponseReference],
          [`Supporting material ${index + 1} — How was it shared with your teacher?`, card.sharingMethod],
        ]),
        ["What changed in your understanding?", embedAnswers.q1],
        ["Where did you do the thinking?", embedAnswers.q2],
        ["How did AI help your learning?", embedAnswers.q3],
        ["What did you decide not to trust?", embedAnswers.q4],
      ];
    }
    triggerCsvDownload(rows.map((row) => row.map(csvCell).join(",")).join("\r\n"), `${stageExportBasenames[activeStage]}.csv`);
  };
  const downloadActiveStagePdf = async () => {
    try {
      const text = activeStage === "TORCH"
        ? [
            "TORCH conversation",
            ...chatMessages.map((message) => `${message.role === "user" ? "Student" : "TORCH"}:\n${message.content}`),
          ].join("\n\n")
        : studentElementExportText(`[data-student-section="${activeStage}"]`);
      if (!text) throw new Error("There is no recorded content to export.");
      await downloadStudentTextPdf(
        text,
        `${stageExportBasenames[activeStage]} export`,
        `${stageExportBasenames[activeStage]}.pdf`,
      );
    } catch (error: any) {
      toast({ title: "Stage PDF could not be downloaded", description: error?.message ?? "Please try again.", variant: "destructive" });
    }
  };
  const downloadProgressCsv = () => {
    const mapFilled = [
      mapAnswers.taskUnderstanding.trim().length >= 20 ? 1 : 0,
      mapAnswers.priorKnowledge.filter((item) => item.trim()).length >= 2 ? 1 : 0,
      mapAnswers.knowledgeGaps.filter((item) => item.trim()).length >= 3 ? 1 : 0,
      mapAnswers.enquiryQuestions.filter((item) => item.trim()).length >= 3 ? 1 : 0,
      mapAnswers.researchPlan.some((row) => row.investigation.trim() && row.verification.trim()) ? 1 : 0,
    ].reduce((total, value) => total + value, 0);
    const researchFilled = researchEntries.filter((entry) =>
      entry.actualSource || entry.sourceType || entry.sourceDetails || entry.findings || entry.importantPoints || entry.reliability || entry.usage
    ).length;
    const compassFilled = [compassAnswers.check1, compassAnswers.check2, compassAnswers.check3, compassAnswers.check4, compassAnswers.check5].filter(Boolean).length;
    const embedFilled = [answerVisibleText(embedAnswers.finalAnswer), embedAnswers.q1, embedAnswers.q2, embedAnswers.q3, embedAnswers.q4].filter(Boolean).length;
    const rows = [
      ["Section", "Status", "Progress"],
      ["MAP", getStageStatus("MAP"), `${mapFilled}/5 questions`],
      ["TORCH", getStageStatus("TORCH"), `${chatMessages.length} messages`],
      ["Research", getStageStatus("RESEARCH"), `${researchFilled} sources logged`],
      ["COMPASS", getStageStatus("COMPASS"), `${compassFilled}/5 checks`],
      ["Final Answer", getStageStatus("EMBED"), `${embedFilled}/5 sections`],
    ];
    triggerCsvDownload(rows.map((row) => row.map(csvCell).join(",")).join("\r\n"), "progress-export.csv");
  };
  const downloadProgressPdf = async () => {
    try {
      await downloadStudentElementPdf('[data-student-export="progress"]', "Progress export", "progress-export.pdf");
    } catch (error: any) {
      toast({ title: "Progress PDF could not be downloaded", description: error?.message ?? "Please try again.", variant: "destructive" });
    }
  };

  const getStageStatus = (stage: Stage): "none" | "started" | "finished" => {
    const declared = stageCompletions[stage];
    if (declared?.complete) return "finished";
    const declaredIncomplete = declared?.complete === false;
    switch (stage) {
      case "MAP": {
        const u = mapAnswers.taskUnderstanding.trim();
        const pk = mapAnswers.priorKnowledge.filter((p) => p.trim());
        const kg = mapAnswers.knowledgeGaps.filter((g) => g.trim());
        const eq = mapAnswers.enquiryQuestions.filter((q) => q.trim());
        if (!u && !pk.length && !eq.length) return "none";
        if (u.length >= 20 && pk.length >= 2 && kg.length >= 3 && eq.length >= 3) return declaredIncomplete ? "started" : "finished";
        return "started";
      }
      case "TORCH":
        if (chatMessages.length === 0) return "none";
        return chatMessages.length >= 6 && !declaredIncomplete ? "finished" : "started";
      case "RESEARCH": {
        const startedEntries = researchEntries.filter((entry) =>
          entry.actualSource.trim()
          || entry.sourceType
          || entry.sourceDetails.trim()
          || (entry.combinedLearning ?? "").trim()
          || entry.reliability.trim()
          || entry.usage.trim()
        );
        if (startedEntries.length === 0) return "none";
        return startedEntries.every((entry) => entry.isComplete === true) && !declaredIncomplete ? "finished" : "started";
      }
      case "COMPASS": {
        const { check1, check2, check3, check4, check5 } = compassAnswers;
        if (!check1 && !check2 && !check3 && !check4 && !check5) return "none";
        if (check1?.trim() && check2?.trim() && check3?.trim() && check4?.trim() && check5?.trim()) return declaredIncomplete ? "started" : "finished";
        return "started";
      }
      case "EMBED": {
        const { finalAnswer, q1, q2, q3, q4 } = embedAnswers;
        if (!finalAnswer && !q1 && !q2 && !q3 && !q4) return "none";
        if (finalAnswer?.trim() && q1?.trim() && q2?.trim() && q3?.trim() && q4?.trim()) return declaredIncomplete ? "started" : "finished";
        return "started";
      }
    }
  };

  const completionStageName: Record<Stage, string> = {
    MAP: "MAP",
    TORCH: "TORCH",
    RESEARCH: "Research",
    COMPASS: "COMPASS",
    EMBED: "Answer",
  };

  const missingSectionsForStage = (stage: Stage): string[] => {
    if (stage === "MAP") {
      const missing: string[] = [];
      if (!mapAnswers.taskUnderstanding.trim()) missing.push("Understanding the task");
      if (!mapAnswers.priorKnowledge.some((item) => item.trim())) missing.push("What I already know");
      if (!mapAnswers.knowledgeGaps.some((item) => item.trim())) missing.push("What I need to find out");
      if (!mapAnswers.enquiryQuestions.some((item) => item.trim())) missing.push("My enquiry questions");
      if (!mapAnswers.researchPlan.some(isMapPlanRowComplete)) missing.push("Research Plan");
      return missing;
    }
    if (stage === "TORCH") return [];
    if (stage === "RESEARCH") {
      return researchEntries.some(researchEntryReadyToComplete) ? [] : ["A completed Research Log source"];
    }
    if (stage === "COMPASS") {
      return compassChecks
        .filter((check) => !compassAnswers[check.key]?.trim())
        .map((check) => check.title);
    }
    return [
      ...(!answerVisibleText(embedAnswers.finalAnswer).trim() ? ["Your final answer"] : []),
      ...embedQuestions.filter((question) => !embedAnswers[question.key]?.trim()).map((question) => question.title),
    ];
  };

  const persistStageCompletion = async (stage: Stage, complete: boolean, sectionsMissing: boolean) => {
    if (isReadOnly || completionSavingStage) return;
    const marker: StudentCompletionMarker = {
      complete,
      markedAt: complete ? new Date().toISOString() : null,
      sectionsMissing: complete && sectionsMissing,
    };
    const contentJson = stage === "MAP"
      ? { ...mapAnswersRef.current, [STUDENT_COMPLETION_KEY]: marker }
      : stage === "TORCH"
        ? { [STUDENT_COMPLETION_KEY]: marker }
        : stage === "RESEARCH"
          ? { entries: researchEntriesRef.current, [STUDENT_COMPLETION_KEY]: marker }
          : stage === "COMPASS"
            ? { ...compassAnswersRef.current, [STUDENT_COMPLETION_KEY]: marker }
            : {
                ...embedAnswersRef.current,
                supportingMaterialCards: supportingMaterialCardsForPersistence(embedAnswersRef.current.supportingMaterialCards),
                [STUDENT_COMPLETION_KEY]: marker,
              };
    setCompletionSavingStage(stage);
    setStudentAutoSaveStatus("saving");
    try {
      await apiFetch(`/student/stages/${stage}`, {
        method: "PUT",
        body: JSON.stringify({ contentJson, submission: complete }),
      });
      const next = { ...stageCompletionsRef.current, [stage]: marker };
      stageCompletionsRef.current = next;
      setStageCompletions(next);
      setCompletedStages((previous) => {
        const updated = new Set(previous);
        if (complete) updated.add(stage);
        else updated.delete(stage);
        return updated;
      });
      setCompletionWarningStage(null);
      setStudentAutoSaveStatus("saved");
    } catch (error) {
      markTaskClosedFromError(error);
      setStudentAutoSaveStatus("error");
    } finally {
      setCompletionSavingStage(null);
    }
  };

  const StageCompletionFooter = ({ stage }: { stage: Stage }) => {
    const marker = stageCompletions[stage];
    const missing = missingSectionsForStage(stage);
    const currentIndex = activeEnabled.indexOf(stage);
    const nextStage = currentIndex >= 0 ? activeEnabled[currentIndex + 1] : undefined;
    const continueLabel = nextStage
      ? `Continue to ${completionStageName[nextStage]}`
      : "Return to Progress";
    return (
      <div className="border-t border-neutral-200 bg-neutral-50 p-5 sm:p-8" data-testid={`stage-completion-${stage}`}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            {marker?.complete ? (
              <>
                <div className="inline-flex rounded-2xl bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white">Complete ✓</div>
                {marker.sectionsMissing && <p className="mt-2 text-sm font-medium text-amber-700">Marked complete with sections missing.</p>}
                {!isReadOnly && (
                  <button type="button" onClick={() => void persistStageCompletion(stage, false, false)} className="mt-2 block text-sm font-medium text-neutral-500 underline underline-offset-4 hover:text-neutral-900">
                    Mark as incomplete
                  </button>
                )}
              </>
            ) : (
              <button
                type="button"
                disabled={isReadOnly || completionSavingStage === stage}
                onClick={() => missing.length ? setCompletionWarningStage(stage) : void persistStageCompletion(stage, true, false)}
                className={`rounded-2xl px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50 ${missing.length ? "bg-red-600 hover:bg-red-700" : "bg-emerald-700 hover:bg-emerald-800"}`}
              >
                {completionSavingStage === stage ? "Saving…" : `Mark ${completionStageName[stage]} as complete`}
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => nextStage ? void handleStageNavigation(nextStage) : setShowOverview(true)}
            className="rounded-2xl border border-neutral-300 bg-white px-5 py-2.5 text-sm font-semibold text-neutral-800 hover:bg-neutral-100"
          >
            {continueLabel} →
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-[100dvh] bg-neutral-50 text-neutral-900 font-sans">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-white border-b border-neutral-200">
        <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col items-start justify-between gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">The Assisted Climb</h1>
            <p className="text-sm text-neutral-500 [overflow-wrap:anywhere]">{session.studentName} — {session.className}</p>
          </div>
          {task && (
            <div className="flex w-full min-w-0 items-center gap-4 overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-50 px-5 py-2.5 lg:mx-4 lg:flex-1">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold uppercase tracking-widest text-neutral-400 leading-none mb-0.5">Your Task</p>
                <p className="text-sm font-semibold text-neutral-800 truncate">{task.title}</p>
                <p className="text-xs text-neutral-500 truncate">{task.question}</p>
              </div>
              {task.dueDate && (
                <div className="shrink-0 text-right">
                  <p className="text-xs text-neutral-400">Due</p>
                  <p className="text-xs font-medium text-neutral-600">{new Date(task.dueDate).toLocaleDateString()}</p>
                </div>
              )}
              <button
                onClick={() => setShowTaskModal(true)}
                className="shrink-0 text-xs font-semibold text-sky-600 hover:text-sky-800 transition-colors whitespace-nowrap"
              >
                View all
              </button>
            </div>
          )}
          <div className="flex max-w-full flex-wrap items-center gap-2">
            {!isReadOnly && (
              <span
                className={`text-xs font-medium ${studentAutoSaveStatus === "error" ? "text-red-600" : "text-neutral-400"}`}
                aria-live="polite"
                data-testid="student-autosave-status"
              >
                {studentAutoSaveStatus === "saving" ? "Saving automatically…" : studentAutoSaveStatus === "error" ? "Auto-save unavailable" : "All changes saved"}
              </span>
            )}
            <button
              onClick={openActivity}
              className="rounded-2xl border border-neutral-300 bg-white text-neutral-700 px-4 py-2.5 text-sm font-medium hover:bg-neutral-50 transition-colors"
              aria-label="View my activity"
            >
              My activity
            </button>
            <button
              onClick={() => { setShowPinModal(true); setPinSuccess(false); setPinError(""); }}
              disabled={isLifecycleReadOnly}
              className="rounded-2xl border border-neutral-300 bg-white text-neutral-500 px-4 py-2.5 text-sm font-medium hover:bg-neutral-50 transition-colors"
            >
              Change PIN
            </button>
            <button
              onClick={handleSwitchClass}
              className="rounded-2xl bg-black text-white px-5 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Switch Class
            </button>
            <button
              onClick={() => void openTeacherMessages()}
              disabled={teacherMessagesLoading}
              className={`rounded-2xl px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-60 ${
                teacherUnreadCount > 0
                  ? "bg-emerald-600 text-white hover:bg-emerald-700"
                  : "border border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50"
              }`}
              aria-label={teacherUnreadCount > 0 ? `Messages, ${teacherUnreadCount} unread` : "Messages"}
            >
              Messages{teacherUnreadCount > 0 ? ` (${teacherUnreadCount})` : ""}
            </button>
            <button
              onClick={handleSignOut}
              className="rounded-2xl border border-neutral-300 bg-white text-neutral-500 px-4 py-2.5 text-sm font-medium hover:bg-neutral-50 transition-colors"
              data-testid="link-signout"
            >
              Sign out
            </button>
          </div>
        </div>

        {isReadOnly && (
          <div className="border-t border-amber-200 bg-amber-50 px-6 py-3 text-center text-sm font-medium text-amber-900">
            <span>{readOnlyMessage}</span>
            {task?.deadlineClosed && (
              <button
                type="button"
                onClick={() => { void loadWorkspace(); }}
                className="ml-3 rounded-lg border border-amber-300 bg-white px-3 py-1 text-xs font-semibold text-amber-900"
              >
                Check if reopened
              </button>
            )}
          </div>
        )}

        {/* Stage navigation bar */}
        <div className="overflow-x-auto border-t border-neutral-100">
          <div className="mx-auto flex min-w-[700px] max-w-7xl px-4 sm:px-6">
            {/* My Progress tab */}
            <button
              onClick={() => setShowOverview(true)}
              data-testid="journey-stage-OVERVIEW"
              className={`relative flex flex-col items-center gap-0.5 py-3 px-4 text-center transition-all border-b-2 ${
                showOverview
                  ? "border-neutral-900 text-neutral-900"
                  : "border-transparent text-neutral-400 hover:text-neutral-600 hover:border-neutral-300"
              }`}
            >
              <span className="text-xs font-bold tracking-widest uppercase">Progress</span>
              <span className="text-[11px] font-normal leading-none">Overview</span>
            </button>

            <div className="w-px bg-neutral-200 my-2 mx-1" />

            {STAGES.map((stage) => {
              const isActive = !showOverview && activeStage === stage;
              const isDisabled = !enabledStages.includes(stage);
              return (
                <button
                  key={stage}
                  onClick={() => { if (!isDisabled) void handleStageNavigation(stage); }}
                  data-testid={`journey-stage-${stage}`}
                  disabled={isDisabled}
                  className={`relative flex-1 flex flex-col items-center gap-0.5 py-3 px-2 text-center transition-all border-b-2 ${
                    isDisabled
                      ? "border-transparent text-neutral-300 cursor-not-allowed select-none"
                      : isActive
                        ? `${STAGE_BORDER[stage]} text-neutral-900`
                        : "border-transparent text-neutral-400 hover:text-neutral-600 hover:border-neutral-300"
                  }`}
                >
                  {isDisabled ? (
                    <>
                      <span className="text-xs font-bold tracking-widest uppercase line-through">{STAGE_DISPLAY[stage]}</span>
                      <span className="text-[10px] font-medium text-neutral-300 leading-none">not set</span>
                    </>
                  ) : (
                    <>
                      <span className="text-xs font-bold tracking-widest uppercase">{STAGE_DISPLAY[stage]}</span>
                      <span className="text-[11px] font-normal leading-none">{STAGE_LABEL[stage]}</span>
                      {!isActive && (() => {
                        const s = getStageStatus(stage);
                        if (s === "finished") return <span className="absolute top-2 right-3 w-1.5 h-1.5 rounded-full bg-emerald-500" />;
                        if (s === "started") return <span className="absolute top-2 right-3 w-1.5 h-1.5 rounded-full bg-amber-400" />;
                        return null;
                      })()}
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      <main className={`max-w-7xl mx-auto px-6 py-10 ${isReadOnly ? "pointer-events-none select-none opacity-75" : ""}`}>
        {taskLoaded && !task && (
          <section className="mb-6 rounded-[2rem] border border-sky-200 bg-sky-50 p-6" data-testid="student-empty-task">
            <h2 className="text-xl font-semibold text-sky-950">No task has been assigned yet</h2>
            <p className="mt-2 text-sm text-sky-900">Your workspace is ready. Ask your teacher when the next task will appear, or refresh to check again.</p>
            <button type="button" onClick={() => window.location.reload()} className="mt-4 rounded-2xl border border-sky-300 bg-white px-5 py-3 text-sm font-medium text-sky-950" data-testid="workspace-refresh">Refresh workspace</button>
          </section>
        )}
        {!showOverview && (
          <div className="pointer-events-auto mb-4 flex flex-wrap justify-end gap-2">
            <button onClick={downloadActiveStagePdf} className="rounded-xl border border-neutral-300 bg-white px-3 py-2 text-xs font-semibold hover:bg-neutral-50" aria-label="Download PDF">Download PDF</button>
            <button onClick={downloadActiveStage} className="rounded-xl border border-neutral-300 bg-white px-3 py-2 text-xs font-semibold hover:bg-neutral-50" aria-label="Download CSV">Download CSV</button>
          </div>
        )}

        {/* ── OVERVIEW ── */}
        {showOverview && (() => {
          const mapFilled = [
            mapAnswers.taskUnderstanding.trim().length >= 20 ? 1 : 0,
            mapAnswers.priorKnowledge.filter(p => p.trim()).length >= 2 ? 1 : 0,
            mapAnswers.knowledgeGaps.filter(g => g.trim()).length >= 3 ? 1 : 0,
            mapAnswers.enquiryQuestions.filter(q => q.trim()).length >= 3 ? 1 : 0,
            mapAnswers.researchPlan.some(r => r.investigation.trim() && r.verification.trim()) ? 1 : 0,
          ].reduce((a, b) => a + b, 0);
          const torchMsgs = chatMessages.length;
           const researchFilled = researchEntries.filter(e => e.actualSource || e.sourceType || e.sourceDetails || e.findings || e.importantPoints || e.reliability || e.usage).length;
          const compassFilled = [compassAnswers.check1, compassAnswers.check2, compassAnswers.check3, compassAnswers.check4, compassAnswers.check5].filter(Boolean).length;
          const embedFilled = [answerVisibleText(embedAnswers.finalAnswer), embedAnswers.q1, embedAnswers.q2, embedAnswers.q3, embedAnswers.q4].filter(Boolean).length;

          const stages = [
            { stage: "MAP" as Stage, label: "Planning", description: "Plan and frame your thinking before you begin.", total: 5, filled: mapFilled, unit: "questions" },
            { stage: "TORCH" as Stage, label: "Investigation", description: "Use the AI tutor to deepen your thinking.", total: null, filled: torchMsgs, unit: "messages" },
            { stage: "RESEARCH" as Stage, label: "Research Log", description: "Record and evaluate your sources.", total: null, filled: researchFilled, unit: "sources logged" },
            { stage: "COMPASS" as Stage, label: "Check Your Thinking", description: "Step back and interrogate your own understanding.", total: 5, filled: compassFilled, unit: "checks" },
            { stage: "EMBED" as Stage, label: "Final Answer", description: "Write your answer and reflect on how you got there.", total: 5, filled: embedFilled, unit: "sections" },
          ];

           const overallFb = studentFeedback["OVERALL"];
           const formativeStages = stages.filter(({ stage }) => !!studentFeedback[stage]?.formativeComment?.trim());
           const summativeStages = stages.filter(({ stage }) => {
             const fb = studentFeedback[stage];
             return !!(fb?.grade || fb?.comment?.trim());
           });
           const hasOverall = !!(overallFb?.grade || overallFb?.comment?.trim());

          return (
            <div className="space-y-6" data-student-export="progress">
              <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h2 className="text-3xl font-semibold tracking-tight mb-1">Your Progress</h2>
                    <p className="text-neutral-500">Here's where you're up to on your climb, {session.studentName}.</p>
                  </div>
                  <div className="pointer-events-auto flex flex-wrap gap-2">
                    <button type="button" onClick={downloadProgressPdf} className="rounded-xl border border-neutral-300 bg-white px-3 py-2 text-xs font-semibold hover:bg-neutral-50" aria-label="Download PDF">Download PDF</button>
                    <button type="button" onClick={downloadProgressCsv} className="rounded-xl border border-neutral-300 bg-white px-3 py-2 text-xs font-semibold hover:bg-neutral-50" aria-label="Download CSV">Download CSV</button>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                {stages.map(({ stage, label, description, total, filled, unit }) => {
                  const completion = stageCompletions[stage];
                  const isMarkedComplete = completion?.complete === true;
                  const isNotStarted = filled === 0 && !isMarkedComplete;
                  const isReadyToComplete = !isMarkedComplete && !isNotStarted && missingSectionsForStage(stage).length === 0;
                  const statusLabel = isMarkedComplete
                    ? "Marked complete ✓"
                    : isNotStarted
                      ? "Not started"
                      : isReadyToComplete
                        ? "Ready to complete"
                        : "In progress";
                  const statusColor = isNotStarted
                    ? "text-neutral-400"
                    : isMarkedComplete || isReadyToComplete
                    ? "text-emerald-600"
                    : "text-amber-600";
                  const pct = total !== null ? Math.min((filled / total) * 100, 100) : Math.min(filled * 20, 100);
                  const fb = studentFeedback[stage];
                  const hasFeedback = !!(fb?.grade || fb?.comment?.trim() || fb?.formativeComment?.trim());

                  return (
                    <div key={stage} className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden flex flex-col">
                      <div className={`px-5 py-4 ${STAGE_COLORS[stage]}`}>
                        <p className="text-xs font-bold tracking-widest uppercase opacity-80">{STAGE_DISPLAY[stage]}</p>
                        <p className="text-sm font-semibold mt-0.5">{label}</p>
                      </div>
                      <div className="flex-1 p-5 flex flex-col justify-between gap-4">
                        <p className="text-xs text-neutral-500 leading-relaxed">{description}</p>
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className={`text-xs font-semibold ${statusColor}`}>{statusLabel}</span>
                            <span className="text-xs text-neutral-400">{filled}{total !== null ? `/${total}` : ""} {unit}</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-neutral-100 overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${STAGE_COLORS[stage].split(" ")[0]}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          {isMarkedComplete && completion.sectionsMissing && (
                            <p className="text-xs font-medium text-amber-700">Some sections are still incomplete</p>
                          )}
                        </div>
                        <button
                          onClick={() => {
                            if (isReadyToComplete) {
                              void persistStageCompletion(stage, true, false);
                              return;
                            }
                            void handleStageNavigation(stage);
                          }}
                          className="w-full rounded-2xl border border-neutral-200 py-2 text-sm font-medium hover:bg-neutral-50 transition-colors"
                        >
                          {isMarkedComplete
                            ? "Marked complete ✓"
                            : isNotStarted
                              ? "Start →"
                              : isReadyToComplete
                                ? "Mark complete ✓"
                                : "Continue →"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* ── Stage feedback stack ── */}
              {(() => {
                 if (formativeStages.length === 0 && summativeStages.length === 0 && !hasOverall) return null;
                return (
                   <div className="space-y-6" data-testid="student-assessment-overview">
                     {formativeStages.length > 0 && (
                       <section className="space-y-3" data-testid="student-formative-assessments" aria-labelledby="student-formative-assessments-heading">
                         <p id="student-formative-assessments-heading" className="text-xs font-semibold text-neutral-400 uppercase tracking-widest px-1">Formative Assessments</p>
                         {formativeStages.map(({ stage, label }) => {
                           const fb = studentFeedback[stage]!;
                           return (
                              <button
                                key={stage}
                                type="button"
                                onClick={() => { void handleStageNavigation(stage); }}
                                data-testid={`formative-feedback-card-${stage}`}
                                aria-label={`Open ${label} stage feedback`}
                                className="block w-full cursor-pointer space-y-3 rounded-[2rem] border border-neutral-200 bg-white p-6 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-sky-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2"
                              >
                               <div className="flex flex-wrap items-center gap-3">
                                 <div className={`px-3 py-1 rounded-xl text-xs font-bold tracking-widest uppercase ${STAGE_COLORS[stage]}`}>
                                   {STAGE_DISPLAY[stage]}
                                 </div>
                                 <span className="text-sm font-semibold text-neutral-700">{label}</span>
                               </div>
                               <div className="rounded-2xl bg-sky-50 border border-sky-100 p-4 space-y-2">
                                 <p className="text-xs font-semibold text-sky-600 uppercase tracking-widest">Teacher feedback</p>
                                 <p className="text-sm text-sky-900 leading-relaxed whitespace-pre-wrap">{fb.formativeComment}</p>
                               </div>
                                {fb.studentAcknowledged && (
                                  <p className="text-right text-xs font-semibold text-emerald-600">Feedback actioned ✓</p>
                                )}
                              </button>
                           );
                         })}
                       </section>
                     )}
                     {summativeStages.length > 0 && (
                       <section className="space-y-3" data-testid="student-summative-assessments" aria-labelledby="student-summative-assessments-heading">
                         <p id="student-summative-assessments-heading" className="text-xs font-semibold text-neutral-400 uppercase tracking-widest px-1">Summative Assessments</p>
                         {summativeStages.map(({ stage, label }) => {
                           const fb = studentFeedback[stage]!;
                           return (
                             <article key={stage} className="rounded-[2rem] bg-white border border-neutral-200 p-6 shadow-sm space-y-3">
                               <div className="flex flex-wrap items-center justify-between gap-3">
                                 <div className="flex flex-wrap items-center gap-3">
                                   <div className={`px-3 py-1 rounded-xl text-xs font-bold tracking-widest uppercase ${STAGE_COLORS[stage]}`}>
                                     {STAGE_DISPLAY[stage]}
                                   </div>
                                   <span className="text-sm font-semibold text-neutral-700">{label}</span>
                                 </div>
                                 {fb.grade && (
                                   <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold border ${ATTAINMENT_COLOR[fb.grade] ?? "bg-neutral-100 text-neutral-600 border-neutral-200"}`}>
                                     {ATTAINMENT_LABEL[fb.grade] ?? fb.grade}
                                   </span>
                                 )}
                               </div>
                               {fb.comment?.trim() && (
                                 <p className="text-sm text-neutral-700 leading-relaxed whitespace-pre-wrap">{fb.comment}</p>
                               )}
                             </article>
                           );
                         })}
                       </section>
                     )}
                    {hasOverall && (
                       <section data-testid="student-final-summative-assessment" aria-labelledby="student-final-summative-assessment-heading" className="space-y-3">
                         <p id="student-final-summative-assessment-heading" className="text-xs font-semibold text-neutral-400 uppercase tracking-widest px-1">Final Summative Assessment</p>
                         <div className="rounded-[2rem] bg-violet-50 border border-violet-200 p-8 shadow-sm space-y-4">
                           <p className="text-xs font-semibold text-violet-500 uppercase tracking-widest">Overall assessment</p>
                           {overallFb!.grade && (
                             <span className={`inline-block px-4 py-1.5 rounded-full text-sm font-semibold border ${ATTAINMENT_COLOR[overallFb!.grade] ?? "bg-neutral-100 text-neutral-600 border-neutral-200"}`}>
                               {ATTAINMENT_LABEL[overallFb!.grade] ?? overallFb!.grade}
                             </span>
                           )}
                           {overallFb!.comment?.trim() && (
                             <p className="text-sm text-violet-900 leading-relaxed whitespace-pre-wrap">{overallFb!.comment}</p>
                           )}
                         </div>
                       </section>
                    )}
                  </div>
                );
              })()}
            </div>
          );
        })()}

        {/* ── MAP ── */}
        {!showOverview && activeStage === "MAP" && (
          <section data-student-section="MAP">
          {mapShowSummary ? (
            <div className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
              <div className="border-b border-neutral-200 px-8 py-6 flex items-center justify-between gap-4">
                <div>
                  <p className={`text-xs uppercase tracking-[0.2em] mb-2 ${STAGE_ACCENT.MAP}`}>MAP — Summary</p>
                  <h2 className="text-3xl font-semibold tracking-tight">My Initial Enquiry Map</h2>
                  {task && <p className="text-neutral-500 mt-1 text-sm font-medium">{task.title}</p>}
                </div>
                <div className="flex gap-3 shrink-0">
                  <button onClick={() => setMapShowSummary(false)} className="rounded-2xl bg-black text-white px-5 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity">← Back to editing</button>
                </div>
              </div>
              <div className="p-8 space-y-8 max-w-3xl">
                {task && (
                  <div className="rounded-2xl bg-neutral-50 border border-neutral-200 p-5">
                    <p className="text-xs uppercase tracking-widest text-neutral-400 font-semibold mb-1">Original task</p>
                    <p className="font-semibold">{task.title}</p>
                    {task.question && <p className="text-neutral-600 text-sm mt-1">{task.question}</p>}
                  </div>
                )}
                <div>
                  <p className="text-xs uppercase tracking-widest text-neutral-400 font-semibold mb-2">My understanding of the task</p>
                  <p className="text-sm leading-relaxed">{mapAnswers.taskUnderstanding || <span className="italic text-neutral-400">Not yet written</span>}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-widest text-neutral-400 font-semibold mb-2">What I already know</p>
                  <ul className="space-y-1">
                    {mapAnswers.priorKnowledge.filter(p => p.trim()).length > 0
                      ? mapAnswers.priorKnowledge.filter(p => p.trim()).map((p, i) => <li key={i} className="text-sm flex gap-2"><span className="text-neutral-300">•</span>{p}</li>)
                      : <li className="text-sm italic text-neutral-400">Not yet completed</li>}
                  </ul>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-widest text-neutral-400 font-semibold mb-2">What I need to find out</p>
                  <ul className="space-y-1">
                    {mapAnswers.knowledgeGaps.filter(g => g.trim()).length > 0
                      ? mapAnswers.knowledgeGaps.filter(g => g.trim()).map((g, i) => <li key={i} className="text-sm flex gap-2"><span className="text-neutral-300">•</span>{g}</li>)
                      : <li className="text-sm italic text-neutral-400">Not yet completed</li>}
                  </ul>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-widest text-neutral-400 font-semibold mb-2">My enquiry questions</p>
                  <ol className="space-y-1">
                    {mapAnswers.enquiryQuestions.filter(q => q.trim()).length > 0
                      ? mapAnswers.enquiryQuestions.filter(q => q.trim()).map((q, i) => <li key={i} className="text-sm flex gap-2"><span className="text-neutral-400 font-medium">{i + 1}.</span>{q}</li>)
                      : <li className="text-sm italic text-neutral-400">Not yet completed</li>}
                  </ol>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-widest text-neutral-400 font-semibold mb-3">Research &amp; verification plan</p>
                  {mapAnswers.researchPlan.filter(r => r.investigation.trim()).length > 0 ? (
                    <div className="space-y-3">
                      {mapAnswers.researchPlan.filter(r => r.investigation.trim()).map((row) => (
                        <div key={row.id} className="rounded-xl border border-neutral-200 p-4 grid grid-cols-3 gap-4 text-sm">
                          <div><p className="text-xs text-neutral-400 mb-1">Investigate</p><p>{row.investigation}</p></div>
                          <div><p className="text-xs text-neutral-400 mb-1">Sources</p><p>{row.sources.length > 0 ? row.sources.join(", ") : <span className="italic text-neutral-400">—</span>}</p></div>
                          <div><p className="text-xs text-neutral-400 mb-1">Verify</p><p className="whitespace-pre-wrap">{row.verification || <span className="italic text-neutral-400">—</span>}</p></div>
                        </div>
                      ))}
                    </div>
                  ) : <p className="text-sm italic text-neutral-400">Not yet completed</p>}
                </div>
                <div className="pt-4 border-t border-neutral-100">
                  <button onClick={goNext} className="rounded-2xl bg-black text-white px-8 py-3 text-sm font-medium hover:opacity-90 transition-opacity" data-testid="button-unlock-torch">
                    Continue to TORCH →
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
              {/* Header + progress */}
              <div className="border-b border-neutral-200 px-8 py-6">
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                  <div>
                    <p className={`text-xs uppercase tracking-[0.2em] mb-2 ${STAGE_ACCENT.MAP}`}>MAP</p>
                    <h2 className="text-3xl font-semibold tracking-tight">Planning My Enquiry</h2>
                    <p className="text-neutral-500 mt-1 text-sm">Clarify the task, activate what you already know, identify what you need to learn, and break it into manageable questions.</p>
                  </div>
                  <button onClick={goNext} className="shrink-0 rounded-2xl bg-black text-white px-6 py-3 text-sm font-medium hover:opacity-90 transition-opacity" data-testid="button-unlock-torch-top">
                    Continue to TORCH →
                  </button>
                </div>
                <div className="flex flex-wrap gap-x-1 gap-y-2 mt-5">
                  {[
                    { label: "Understand", done: mapAnswers.taskUnderstanding.trim().length >= 20 },
                    { label: "Recall", done: mapAnswers.priorKnowledge.filter(p => p.trim()).length >= 2 },
                    { label: "Identify", done: mapAnswers.knowledgeGaps.filter(g => g.trim()).length >= 3 },
                    { label: "Question", done: mapAnswers.enquiryQuestions.filter(q => q.trim()).length >= 3 },
                    { label: "Plan", done: mapAnswers.researchPlan.length > 0 && mapAnswers.researchPlan.every(isMapPlanRowComplete) },
                  ].map((step, i, arr) => (
                    <div key={step.label} className="flex items-center gap-1">
                      <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold ${step.done ? "bg-neutral-800 text-white" : "bg-neutral-100 text-neutral-400 border border-neutral-200"}`}>
                        {step.done ? "✓" : i + 1}
                      </span>
                      <span className={`text-xs font-medium ${step.done ? "text-neutral-800" : "text-neutral-400"}`}>{step.label}</span>
                      {i < arr.length - 1 && <span className="text-neutral-200 mx-1 text-xs">—</span>}
                    </div>
                  ))}
                </div>
              </div>

              <div className="divide-y divide-neutral-100">

                {/* Section 1 */}
                <div className="p-8">
                  <div className="flex gap-4 items-start">
                    <span className="shrink-0 w-7 h-7 rounded-full bg-neutral-800 text-white text-xs font-bold flex items-center justify-center mt-0.5">1</span>
                    <div className="flex-1 space-y-4">
                      <div>
                        <h3 className="text-lg font-semibold tracking-tight">Understanding My Task</h3>
                        <p className="text-sm text-neutral-500 mt-0.5">Make sure you understand exactly what you need to do before you start investigating.</p>
                      </div>
                      {task && (
                        <div className="rounded-2xl bg-neutral-50 border border-neutral-200 p-4">
                          <p className="text-xs uppercase tracking-widest text-neutral-400 font-semibold mb-1">Your task</p>
                          <p className="font-semibold text-sm">{task.title}</p>
                          {task.question && <p className="text-neutral-600 text-sm mt-1">{task.question}</p>}
                          {task.notes && <p className="text-neutral-400 text-xs mt-1 italic">{task.notes}</p>}
                        </div>
                      )}
                      <div>
                        <label className="block text-sm font-medium mb-2">
                          In your own words, explain what you need to investigate, decide, create or solve{task ? ` in response to: "${task.title}"` : "."}
                        </label>
                        <textarea
                          value={mapAnswers.taskUnderstanding}
                          onChange={(e) => setMapAnswers({ ...mapAnswers, taskUnderstanding: e.target.value })}
                          className="w-full rounded-2xl border border-neutral-200 p-4 min-h-[140px] resize-none focus:outline-none focus:ring-2 focus:ring-black/10 text-sm"
                          placeholder="Explain the task in your own words. What are you being asked to do? What kind of response is needed?"
                          data-testid="textarea-map-0"
                        />
                        {mapAnswers.taskUnderstanding.trim().length > 0 && mapAnswers.taskUnderstanding.trim().length < 20 && (
                          <p className="text-xs text-amber-600 mt-1.5">Can you make this more specific? How does this connect to the task?</p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Section 2 */}
                <div className="p-8">
                  <div className="flex gap-4 items-start">
                    <span className="shrink-0 w-7 h-7 rounded-full bg-neutral-200 text-neutral-600 text-xs font-bold flex items-center justify-center mt-0.5">2</span>
                    <div className="flex-1 space-y-4">
                      <div>
                        <h3 className="text-lg font-semibold tracking-tight">What I Already Know</h3>
                        <p className="text-sm text-neutral-500 mt-0.5">{task ? `What do you already know that could help you respond to "${task.title}"?` : "What do you already know about this topic?"}</p>
                        <p className="text-xs text-neutral-400 mt-1">List relevant facts, ideas, experiences or prior learning. Do not research yet.</p>
                      </div>
                      <div className="space-y-2">
                        {mapAnswers.priorKnowledge.map((item, i) => (
                          <div key={i} className="flex gap-2 items-center">
                            <span className="text-neutral-300 text-xs font-medium shrink-0 w-5 text-right">{i + 1}.</span>
                            <input
                              type="text"
                              value={item}
                              onChange={(e) => { const n = [...mapAnswers.priorKnowledge]; n[i] = e.target.value; setMapAnswers({ ...mapAnswers, priorKnowledge: n }); }}
                              className="flex-1 rounded-xl border border-neutral-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                              placeholder={i === 0 ? "e.g. I know that…" : "Add another point…"}
                              data-testid={`input-map-prior-${i}`}
                            />
                            {mapAnswers.priorKnowledge.length > 1 && (
                              <button onClick={() => setMapAnswers({ ...mapAnswers, priorKnowledge: mapAnswers.priorKnowledge.filter((_, j) => j !== i) })} className="text-neutral-300 hover:text-red-400 transition-colors text-sm">✕</button>
                            )}
                          </div>
                        ))}
                        {mapAnswers.priorKnowledge.filter(p => p.trim()).length === 1 && (
                          <p className="text-xs text-amber-600 pl-7">Is this something you know, or something you assume? Try to add at least one more point.</p>
                        )}
                      </div>
                      <button onClick={() => setMapAnswers({ ...mapAnswers, priorKnowledge: [...mapAnswers.priorKnowledge, ""] })} className="ml-7 rounded-xl border border-dashed border-neutral-300 px-4 py-2 text-sm text-neutral-500 hover:border-neutral-400 hover:text-neutral-700 transition-colors">
                        + Add another idea
                      </button>
                    </div>
                  </div>
                </div>

                {/* Section 3 */}
                <div className="p-8">
                  <div className="flex gap-4 items-start">
                    <span className="shrink-0 w-7 h-7 rounded-full bg-neutral-200 text-neutral-600 text-xs font-bold flex items-center justify-center mt-0.5">3</span>
                    <div className="flex-1 space-y-4">
                      <div>
                        <h3 className="text-lg font-semibold tracking-tight">What I Need to Find Out</h3>
                        <p className="text-sm text-neutral-500 mt-0.5">{task ? `What information will you need before you can respond confidently to "${task.title}"?` : "What information do you still need to find?"}</p>
                        <p className="text-xs text-neutral-400 mt-1">Identify gaps in your knowledge. Focus on what you genuinely need to understand, rather than listing general topics.</p>
                      </div>
                      <div className="space-y-2">
                        {mapAnswers.knowledgeGaps.map((item, i) => (
                          <div key={i} className="flex gap-2 items-center">
                            <span className="text-neutral-300 text-xs font-medium shrink-0 w-5 text-right">{i + 1}.</span>
                            <input
                              type="text"
                              value={item}
                              onChange={(e) => { const n = [...mapAnswers.knowledgeGaps]; n[i] = e.target.value; setMapAnswers({ ...mapAnswers, knowledgeGaps: n }); }}
                              className="flex-1 rounded-xl border border-neutral-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                              placeholder={i === 0 ? "e.g. I need to understand…" : "Add another gap…"}
                              data-testid={`input-map-gap-${i}`}
                            />
                            {mapAnswers.knowledgeGaps.length > 1 && (
                              <button onClick={() => setMapAnswers({ ...mapAnswers, knowledgeGaps: mapAnswers.knowledgeGaps.filter((_, j) => j !== i) })} className="text-neutral-300 hover:text-red-400 transition-colors text-sm">✕</button>
                            )}
                          </div>
                        ))}
                        {mapAnswers.knowledgeGaps.filter(g => g.trim()).length > 0 && mapAnswers.knowledgeGaps.filter(g => g.trim()).length < 3 && (
                          <p className="text-xs text-amber-600 pl-7">What evidence would help you answer the task? Try to identify at least 3 knowledge gaps.</p>
                        )}
                      </div>
                      <button onClick={() => setMapAnswers({ ...mapAnswers, knowledgeGaps: [...mapAnswers.knowledgeGaps, ""] })} className="ml-7 rounded-xl border border-dashed border-neutral-300 px-4 py-2 text-sm text-neutral-500 hover:border-neutral-400 hover:text-neutral-700 transition-colors">
                        + Add another item
                      </button>
                    </div>
                  </div>
                </div>

                {/* Section 4 */}
                <div className="p-8">
                  <div className="flex gap-4 items-start">
                    <span className="shrink-0 w-7 h-7 rounded-full bg-neutral-200 text-neutral-600 text-xs font-bold flex items-center justify-center mt-0.5">4</span>
                    <div className="flex-1 space-y-4">
                      <div>
                        <h3 className="text-lg font-semibold tracking-tight">My Smaller Enquiry Questions</h3>
                        <p className="text-sm text-neutral-500 mt-0.5">{task ? `What smaller questions will you need to answer before you can complete "${task.title}"?` : "What smaller questions will guide your investigation?"}</p>
                        <p className="text-xs text-neutral-400 mt-1">Break the main task into focused, manageable questions. Each question should help you move closer to the final outcome.</p>
                      </div>
                      <div className="space-y-2">
                        {mapAnswers.enquiryQuestions.map((q, i) => (
                          <div key={i} className="flex gap-2 items-center">
                            <span className="text-neutral-400 text-xs font-bold shrink-0 w-6 text-right">Q{i + 1}</span>
                            <input
                              type="text"
                              value={q}
                              onChange={(e) => { const n = [...mapAnswers.enquiryQuestions]; n[i] = e.target.value; setMapAnswers({ ...mapAnswers, enquiryQuestions: n }); }}
                              className="flex-1 rounded-xl border border-neutral-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                              placeholder={`Enquiry question ${i + 1}…`}
                              data-testid={`input-map-question-${i}`}
                            />
                            {mapAnswers.enquiryQuestions.length > 1 && (
                              <button onClick={() => setMapAnswers({ ...mapAnswers, enquiryQuestions: mapAnswers.enquiryQuestions.filter((_, j) => j !== i) })} className="text-neutral-300 hover:text-red-400 transition-colors text-sm">✕</button>
                            )}
                          </div>
                        ))}
                        {mapAnswers.enquiryQuestions.filter(q => q.trim()).length > 0 && mapAnswers.enquiryQuestions.filter(q => q.trim()).length < 3 && (
                          <p className="text-xs text-amber-600 pl-8">How does each question connect to the main task? Try to add at least 3 focused questions.</p>
                        )}
                      </div>
                      <button onClick={() => setMapAnswers({ ...mapAnswers, enquiryQuestions: [...mapAnswers.enquiryQuestions, ""] })} className="ml-8 rounded-xl border border-dashed border-neutral-300 px-4 py-2 text-sm text-neutral-500 hover:border-neutral-400 hover:text-neutral-700 transition-colors">
                        + Add another question
                      </button>
                    </div>
                  </div>
                </div>

                {/* Section 5 */}
                <div className="p-8">
                  <div className="flex gap-4 items-start">
                    <span className="shrink-0 w-7 h-7 rounded-full bg-neutral-200 text-neutral-600 text-xs font-bold flex items-center justify-center mt-0.5">5</span>
                    <div className="flex-1 space-y-5">
                      <div>
                        <h3 className="text-lg font-semibold tracking-tight">My Research Plan</h3>
                        <p className="text-sm text-neutral-500 mt-0.5">For each thing you need to investigate, plan where you will look and how you will verify what you find.</p>
                      </div>
                      {mapAnswers.researchPlan.map((row, i) => {
                        const SOURCE_OPTIONS = [...SOURCE_TYPE_OPTIONS];
                        const VERIFY_OPTIONS = [
                          "Compare it with another source",
                          "Check who created it",
                          "Check when it was published",
                          "Look for supporting evidence",
                          "Check facts against opinions",
                          "Look for missing perspectives",
                          "Check the sources used by AI"
                        ];
                        const investigationSuggestions = goalLevels
                          .map((level) => torchSuggestions[level.label]?.[0])
                          .filter((suggestion): suggestion is string => Boolean(suggestion))
                          .slice(0, 3);
                        const filledQs = mapAnswers.enquiryQuestions.filter((question) => question.trim());
                        const isLogged = loggedSourceIds.has(row.id);

                        return (
                          <div key={row.id} className="overflow-hidden rounded-2xl border border-neutral-200 bg-white" data-testid={`panel-map-plan-row-${row.id}`}>
                            <div className="flex items-center gap-3 px-5 py-4">
                              <button
                                type="button"
                                aria-expanded={!collapsedMapPlanRows.has(row.id)}
                                aria-controls={`map-plan-content-${row.id}`}
                                onClick={() => setCollapsedMapPlanRows((current) => {
                                  const next = new Set(current);
                                  if (next.has(row.id)) next.delete(row.id);
                                  else next.add(row.id);
                                  return next;
                                })}
                                className="flex min-w-0 flex-1 items-center justify-between gap-4 rounded-lg text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500 focus-visible:ring-offset-2"
                                data-testid={`button-toggle-map-plan-${i}`}
                              >
                                <span className="min-w-0">
                                  <span className="block text-sm font-semibold text-neutral-900">Research plan {i + 1}</span>
                                  <span className="mt-0.5 block truncate text-xs text-neutral-500">
                                    {row.investigation.trim() || "Not started"}
                                  </span>
                                </span>
                                <span className="flex shrink-0 items-center gap-3">
                                  {isLogged && (
                                    <span className="hidden rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 sm:inline-flex">
                                      Added to Research Log
                                    </span>
                                  )}
                                  <svg className={`h-5 w-5 text-neutral-500 transition-transform ${collapsedMapPlanRows.has(row.id) ? "" : "rotate-180"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m6 9 6 6 6-6" />
                                  </svg>
                                </span>
                              </button>
                              {mapAnswers.researchPlan.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => setMapAnswers({ ...mapAnswers, researchPlan: mapAnswers.researchPlan.filter((_, j) => j !== i) })}
                                  className="shrink-0 rounded-lg px-2 py-1 text-sm font-bold text-neutral-300 transition-colors hover:text-red-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                                  aria-label={`Delete research plan ${i + 1}`}
                                >
                                  ✕
                                </button>
                              )}
                            </div>
                            {!collapsedMapPlanRows.has(row.id) && (
                            <div id={`map-plan-content-${row.id}`} className="space-y-6 border-t border-neutral-100 px-6 pb-6 pt-5">
                            {/* Step 1 */}
                            <div className="space-y-3">
                              <h4 className="text-sm font-semibold tracking-tight text-neutral-900">1. What do I need to find out?</h4>
                              <p className="text-xs text-neutral-500">What question or information do you need to investigate?</p>
                              <div className="space-y-2">
                                <input
                                  type="text"
                                  value={row.investigation}
                                  onChange={(e) => setMapAnswers({ ...mapAnswers, researchPlan: mapAnswers.researchPlan.map((r, j) => j === i ? { ...r, investigation: e.target.value } : r) })}
                                  className="w-full rounded-xl border border-neutral-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-400"
                                  placeholder="e.g. How does deforestation affect local rainfall?"
                                  data-testid={`input-map-investigation-${i}`}
                                />
                                {filledQs.length > 0 && (
                                  <div className="flex flex-wrap gap-1.5 pt-1">
                                    <p className="w-full text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Your questions from MAP</p>
                                    {filledQs.map((question, questionIndex) => (
                                      <button
                                        key={`${question}-${questionIndex}`}
                                        type="button"
                                        onClick={() => setMapAnswers({
                                          ...mapAnswers,
                                          researchPlan: mapAnswers.researchPlan.map((candidate, rowIndex) =>
                                            rowIndex === i ? { ...candidate, investigation: question } : candidate
                                          ),
                                        })}
                                        className="max-w-full truncate rounded-lg bg-neutral-100 px-2.5 py-1 text-[11px] font-medium text-neutral-600 transition-colors hover:bg-neutral-200 sm:max-w-[250px]"
                                        title={`Use: ${question}`}
                                      >
                                        ↑ {question.length > 35 ? `${question.slice(0, 35)}…` : question}
                                      </button>
                                    ))}
                                  </div>
                                )}
                                <div className="flex flex-wrap items-center gap-2 pt-1">
                                  {investigationSuggestions.length === 0 && (
                                    <button
                                      type="button"
                                      onClick={() => void loadTorchSuggestions()}
                                      disabled={isReadOnly || torchSuggestionStatus === "loading"}
                                      className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                                      data-testid={`button-map-investigation-suggestions-${i}`}
                                    >
                                      {torchSuggestionStatus === "loading" ? "Preparing example questions…" : "✦ Suggest 4 example questions"}
                                    </button>
                                  )}
                                  {investigationSuggestions.length > 0 && (
                                    <>
                                      <p className="w-full text-[11px] font-semibold uppercase tracking-wider text-amber-700">AI suggestions — choose one or write your own</p>
                                      {investigationSuggestions.map((suggestion, suggestionIndex) => (
                                        <button
                                          key={`${suggestion}-${suggestionIndex}`}
                                          type="button"
                                          onClick={() => setMapAnswers({
                                            ...mapAnswers,
                                            researchPlan: mapAnswers.researchPlan.map((candidate, rowIndex) =>
                                              rowIndex === i ? { ...candidate, investigation: suggestion } : candidate
                                            ),
                                          })}
                                          className="max-w-full rounded-lg bg-amber-50 px-2.5 py-1.5 text-left text-[11px] font-medium text-amber-900 transition-colors hover:bg-amber-100 sm:max-w-[31%]"
                                          title={`Use: ${suggestion}`}
                                        >
                                          ✦ {suggestion}
                                        </button>
                                      ))}
                                    </>
                                  )}
                                  {torchSuggestionStatus === "error" && investigationSuggestions.length === 0 && (
                                    <p className="text-xs text-red-600">{torchSuggestionError}</p>
                                  )}
                                </div>
                              </div>
                            </div>
                            {/* Step 2 */}
                            <div className="space-y-4 pt-4 border-t border-neutral-100">
                              <h4 className="text-sm font-semibold tracking-tight text-neutral-900">2. Where could I look?</h4>
                              <div className="flex flex-wrap gap-1.5">
                                {SOURCE_OPTIONS.map((src) => {
                                  const sel = row.sources.includes(src);
                                  return (
                                    <button key={src} onClick={() => setMapAnswers({ ...mapAnswers, researchPlan: mapAnswers.researchPlan.map((r, j) => j !== i ? r : { ...r, sources: sel ? r.sources.filter(s => s !== src) : [...r.sources, src] }) })} className={`text-xs rounded-[0.5rem] px-3 py-1.5 font-medium border transition-colors ${sel ? "bg-neutral-800 text-white border-neutral-800" : "bg-white text-neutral-600 border-neutral-200 hover:border-neutral-400"}`}>
                                      {src}
                                    </button>
                                  );
                                })}
                                {row.sources.filter((source) => !(SOURCE_OPTIONS as readonly string[]).includes(source)).map((source) => (
                                  <button
                                    key={source}
                                    onClick={() => setMapAnswers({
                                      ...mapAnswers,
                                      researchPlan: mapAnswers.researchPlan.map((candidate, rowIndex) =>
                                        rowIndex === i ? { ...candidate, sources: candidate.sources.filter((item) => item !== source) } : candidate
                                      ),
                                    })}
                                    className="text-xs rounded-[0.5rem] px-3 py-1.5 font-medium border bg-blue-700 text-white border-blue-700 break-all"
                                    title="Task resource. Select to delete it from this row."
                                  >
                                    {source} ×
                                  </button>
                                ))}
                              </div>
                              <div className="pt-2">
                                {!row.showPlannedSource && !row.plannedSource.trim() ? (
                                  <button
                                    type="button"
                                    onClick={() => setMapAnswers({ ...mapAnswers, researchPlan: mapAnswers.researchPlan.map((r, j) => j === i ? { ...r, showPlannedSource: true } : r) })}
                                    className="text-xs font-medium text-neutral-500 hover:text-neutral-800 transition-colors flex items-center gap-1.5"
                                  >
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                                    Already have a particular source in mind?
                                  </button>
                                ) : (
                                  <div className="space-y-1.5">
                                    <label className="block text-xs font-semibold text-neutral-700" htmlFor={`input-map-source-${i}`}>
                                      Already have a particular source in mind? <span className="font-normal text-neutral-400 block sm:inline mt-0.5 sm:mt-0 ml-0 sm:ml-1">Optional: add its name or link.</span>
                                    </label>
                                    <input
                                      id={`input-map-source-${i}`}
                                      type="text"
                                      value={row.plannedSource}
                                      onChange={(e) => setMapAnswers({
                                        ...mapAnswers,
                                        researchPlan: mapAnswers.researchPlan.map((r, j) =>
                                          j === i ? { ...r, plannedSource: e.target.value } : r
                                        )
                                      })}
                                      className="w-full md:w-2/3 rounded-xl border border-neutral-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-400 bg-neutral-50 focus:bg-white"
                                      placeholder="e.g. National Geographic article on rainforests"
                                      data-testid={`input-map-source-${i}`}
                                    />
                                  </div>
                                )}
                              </div>
                            </div>
                            {/* Step 3 */}
                            <div className="space-y-4 pt-4 border-t border-neutral-100">
                              <h4 className="text-sm font-semibold tracking-tight text-neutral-900">3. How will I check it?</h4>
                              <p className="text-xs text-neutral-500">Choose how you will check what you find.</p>
                              <div className="flex flex-col gap-2.5 pt-1">
                                {VERIFY_OPTIONS.map((opt) => {
                                  const sels = row.verificationSelections ?? [];
                                  const isSel = sels.includes(opt);
                                  return (
                                    <label key={opt} className="flex items-center gap-3 cursor-pointer w-fit group rounded-md focus-within:ring-2 focus-within:ring-neutral-500 focus-within:ring-offset-2">
                                      <div className={`w-4 h-4 rounded-sm border flex items-center justify-center transition-colors ${isSel ? 'bg-neutral-800 border-neutral-800 text-white' : 'border-neutral-300 bg-white group-hover:border-neutral-400'}`}>
                                        {isSel && <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                                      </div>
                                      <span className="text-xs font-medium text-neutral-700 select-none">{opt}</span>
                                      <input type="checkbox" className="sr-only" checked={isSel} onChange={(e) => {
                                        const newSels = e.target.checked ? [...sels, opt] : sels.filter(s => s !== opt);
                                        setMapAnswers({ ...mapAnswers, researchPlan: mapAnswers.researchPlan.map((r, j) => j === i ? { ...r, verificationSelections: newSels } : r) });
                                      }} />
                                    </label>
                                  );
                                })}
                              </div>
                              <div className="pt-2">
                                <label className="block text-xs font-semibold text-neutral-700 mb-2" htmlFor={`input-map-verification-${i}`}>
                                  Anything else you will do to check it? <span className="font-normal text-neutral-400">(optional)</span>
                                </label>
                                <input
                                  id={`input-map-verification-${i}`}
                                  type="text"
                                  value={row.verification}
                                  onChange={(e) => setMapAnswers({ ...mapAnswers, researchPlan: mapAnswers.researchPlan.map((r, j) => j === i ? { ...r, verification: e.target.value } : r) })}
                                  className="w-full md:w-2/3 rounded-xl border border-neutral-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-400 bg-neutral-50 focus:bg-white"
                                  placeholder="e.g. Read the comments to see how people respond"
                                  data-testid={`textarea-map-verification-${i}`}
                                />
                              </div>
                            </div>
                            {/* Actions */}
                            <div className="pt-6 border-t border-neutral-100 flex flex-col items-center">
                              {isLogged ? (
                                <button
                                  type="button"
                                  disabled
                                  className="rounded-xl border border-neutral-200 bg-neutral-50 px-6 py-2.5 text-sm font-semibold text-neutral-500 flex items-center gap-2"
                                  data-testid={`button-map-source-used-${i}`}
                                >
                                  <svg className="w-4 h-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                                  Added to Research Log ✓
                                </button>
                              ) : row.showActualSourcePanel ? (
                                <div className="w-full max-w-md rounded-2xl border border-sky-200 bg-sky-50/50 p-5 space-y-4">
                                  <div className="flex justify-between items-start">
                                    <h5 className="text-sm font-semibold text-sky-900">Which source did you actually use?</h5>
                                    <button onClick={() => setMapAnswers({ ...mapAnswers, researchPlan: mapAnswers.researchPlan.map((r, j) => j === i ? { ...r, showActualSourcePanel: false } : r) })} className="text-sky-400 hover:text-sky-700">✕</button>
                                  </div>
                                  <label htmlFor={`input-map-actual-source-${i}`} className="block text-xs font-semibold text-sky-800">Actual source name or link</label>
                                  <input
                                    id={`input-map-actual-source-${i}`}
                                    type="text"
                                    value={row.actualSource}
                                    onChange={(e) => setMapAnswers({ ...mapAnswers, researchPlan: mapAnswers.researchPlan.map((r, j) => j === i ? { ...r, actualSource: e.target.value } : r) })}
                                    className="w-full rounded-xl border border-sky-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/20 bg-white"
                                    placeholder="Enter the source name or link..."
                                    data-testid={`input-map-actual-source-${i}`}
                                  />
                                  <div className="flex justify-end">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        if (!row.actualSource.trim()) return;
                                        markMapSourceAsUsed(row);
                                        setMapAnswers({ ...mapAnswers, researchPlan: mapAnswers.researchPlan.map((r, j) => j === i ? { ...r, showActualSourcePanel: false } : r) });
                                      }}
                                      disabled={isReadOnly || !row.actualSource.trim()}
                                      className="rounded-xl border border-sky-300 bg-sky-600 px-5 py-2 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-60 transition-colors shadow-sm"
                                      data-testid={`button-map-add-log-${i}`}
                                    >
                                      Add to Research Log
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setMapAnswers({
                                      ...mapAnswers,
                                      researchPlan: mapAnswers.researchPlan.map((r, j) =>
                                        j === i ? { ...r, showActualSourcePanel: true, actualSource: r.actualSource || r.plannedSource } : r
                                      )
                                    });
                                  }}
                                  disabled={isReadOnly}
                                  className="rounded-xl border border-sky-200 bg-white px-6 py-2.5 text-sm font-semibold text-sky-700 hover:bg-sky-50 hover:border-sky-300 transition-colors shadow-sm"
                                      data-testid={`button-map-source-used-${i}`}
                                >
                                  I used a source for this
                                </button>
                              )}
                            </div>
                            </div>
                            )}
                          </div>
                        );
                      })}
                      <button onClick={() => setMapAnswers({ ...mapAnswers, researchPlan: [...mapAnswers.researchPlan, { id: newResearchEntryId(), investigation: "", sources: [], plannedSource: "", actualSource: "", verification: "", verificationSelections: [] }] })} className="w-full md:w-auto rounded-xl border border-dashed border-neutral-300 px-5 py-2.5 text-sm font-medium text-neutral-500 hover:border-neutral-400 hover:text-neutral-700 transition-colors bg-neutral-50/50 hover:bg-neutral-50" data-testid="button-plan-another-investigation">
                        + Plan another investigation
                      </button>
                      {teacherResources.length > 0 && (
                        <div className="rounded-2xl border border-sky-200 bg-sky-50/50 p-6 space-y-4" data-testid="panel-teacher-resources-plan">
                          <div>
                            <p className="text-sm font-semibold text-sky-950">Sources from your teacher</p>
                            <p className="text-xs text-sky-800 mt-1">Your teacher has suggested these sources. You still need to decide whether they are useful and trustworthy.</p>
                          </div>
                          <div className="space-y-2.5">
                            {teacherResources.map((r, index) => {
                              const isLogged = loggedSourceIds.has(teacherResourceSourceId(r));
                              return (
                                <div key={normaliseResource(r)} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-sky-200 bg-white p-3.5 shadow-sm">
                                  <div className="space-y-0.5">
                                    <span className="text-[10px] font-bold uppercase tracking-widest text-sky-600">{r.trim().match(/^https?:\/\//i) ? "Website" : "Other"}</span>
                                    <p className="text-sm font-medium text-neutral-800 break-all" data-testid={`text-plan-resource-${index}`}>{r}</p>
                                  </div>
                                  <button
                                    onClick={() => markResourceAsUsed(r)}
                                    disabled={isReadOnly || isLogged}
                                    className={`shrink-0 rounded-xl border px-4 py-2 text-xs font-semibold disabled:opacity-60 transition-colors ${isLogged ? 'bg-neutral-50 text-neutral-500 border-neutral-200' : 'border-sky-300 bg-sky-600 text-white hover:bg-sky-700'}`}
                                    data-testid={`button-research-used-${index}`}
                                  >
                                    {isLogged ? "Added to Research Log ✓" : "I used this source"}
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="p-8 flex flex-wrap items-center justify-between gap-4">
                  <div className="flex flex-wrap gap-2">
                    {completedStages.has("MAP") && (
                      <button className="rounded-2xl border border-neutral-200 text-neutral-500 px-4 py-2.5 text-sm font-medium hover:text-red-500 hover:border-red-200 hover:bg-red-50 transition-colors" onClick={() => setStageToReset("MAP")} data-testid="button-reset-map">
                        Reset stage
                      </button>
                    )}
                  </div>
                </div>

              </div>
            </div>
          )}
          <StageCompletionFooter stage="MAP" />
          <TeacherFeedbackBanner stage="MAP" feedback={studentFeedback["MAP"]} onAcknowledge={() => { void acknowledgeFeedback("MAP"); }} isAcknowledging={acknowledgingFeedbackStage === "MAP"} readOnly={isReadOnly} />
          </section>
        )}

        {/* ── TORCH ── */}
        {!showOverview && activeStage === "TORCH" && (
          <section data-student-section="TORCH" className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
            <div className="border-b border-neutral-200 px-8 py-6 flex items-center justify-between gap-4">
              <div>
                <p className={`text-xs uppercase tracking-[0.2em] mb-2 ${STAGE_ACCENT.TORCH}`}>TORCH</p>
                <h2 className="text-3xl font-semibold tracking-tight">Explore & Build Understanding</h2>
                <p className="text-neutral-500 mt-1 text-sm">Question, investigate and explore ideas with the AI tutor — gather information, test your thinking, and make connections.</p>
               <div className="mt-4 max-w-3xl rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3" data-testid="panel-torch-thinking-boundary">
                 <p className="text-xs font-semibold uppercase tracking-widest text-amber-800">How the tutor helps</p>
                 <div className="mt-2 grid gap-2 text-xs leading-relaxed text-amber-950 sm:grid-cols-2">
                   <p><span className="font-semibold">Background support:</span> you may get a short fact or definition when you need one, followed by a prompt to explain or apply it.</p>
                   <p><span className="font-semibold">Your thinking:</span> for analysis, evaluation, comparison, and arguments, the tutor questions and tests your reasoning instead of writing your answer.</p>
                 </div>
               </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <button onClick={goPrev} className="rounded-2xl border border-neutral-200 text-neutral-500 px-4 py-3 text-sm font-medium hover:text-black hover:bg-neutral-50 transition-colors" data-testid="button-back-to-map">
                  ← Back to MAP
                </button>
                <button onClick={goNext} className="rounded-2xl bg-black text-white px-6 py-3 text-sm font-medium hover:opacity-90 transition-opacity" data-testid="button-move-research">
                  Continue to RESEARCH →
                </button>
              </div>
            </div>
            <div>
              <div className="flex flex-col min-h-[650px]">
                <div className="border-b border-neutral-200 px-6 py-5">
                   <div className="mb-4">
                     <p className="text-sm font-semibold">What would you like to think about?</p>
                     <p className="mt-1 text-xs leading-relaxed text-neutral-500">Choose one or more of the four options below. Each option includes example questions you can use to guide your conversation with the AI tutor. You can return and choose another option at any time.</p>
                   </div>
                  <div className="grid grid-cols-3 gap-2">
                    {goalLevels.map((level, index) => {
                      const isSelected = selectedBloomLevel === index;
                      return (
                        <button
                          key={index}
                          className={`rounded-2xl border p-4 text-left transition-all group ${
                            isSelected
                              ? "border-amber-400 bg-amber-50 ring-2 ring-amber-300"
                              : "border-neutral-200 hover:bg-neutral-50 hover:border-neutral-400"
                          }`}
                          data-testid={`button-torch-prompt-${index}`}
                          onClick={() => {
                            setSelectedBloomLevel(index);
                            recordThinkingChoiceEvent({
                              eventType: "selected",
                              optionName: level.label,
                              conversationTurn: chatMessages.filter((entry) => entry.role === "user").length,
                            });
                            setChatInput("");
                            setPendingTorchSuggestion(null);
                            // A new goal should never inherit a prior failed
                            // request. Retry automatically when the student
                            // chooses another goal after a transient error.
                            if (torchSuggestionStatus === "idle" || torchSuggestionStatus === "error") {
                              void loadTorchSuggestions();
                            }
                            setTimeout(() => {
                              suggestionsRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                            }, 50);
                          }}
                        >
                          <div className="text-lg mb-1">{level.emoji}</div>
                          <div className={`text-sm font-semibold mb-1 ${isSelected ? "text-amber-800" : "group-hover:text-black"}`}>{level.label}</div>
                          <div className="text-xs text-neutral-500 leading-snug">{level.description}</div>
                          {isSelected && <div className="mt-2 text-[10px] font-semibold uppercase tracking-widest text-amber-600">Selected ✓</div>}
                        </button>
                      );
                    })}
                  </div>
                   {/* Student's own question-type breakdown */}
                   {(() => {
                     const userMsgs = chatMessages.filter((m) => m.role === "user");
                     if (userMsgs.length === 0) return null;
                     const counts = classifyMessages(userMsgs.map((m) => ({ role: "user", content: m.content })));
                     const total = (Object.values(counts) as number[]).reduce((a, b) => a + b, 0);
                     const active = QUESTION_TYPES.filter((t) => counts[t] > 0);
                     if (active.length === 0) return null;
                     const barColor: Record<string, string> = {
                       Factual: "bg-blue-400", Conceptual: "bg-sky-400", Analytical: "bg-amber-400",
                       Evaluative: "bg-orange-400", Creative: "bg-violet-400",
                       "Help/Clarify": "bg-neutral-300", Other: "bg-neutral-200",
                     };
                     return (
                       <div className="mt-4 rounded-2xl bg-neutral-50 border border-neutral-200 px-4 py-3 sm:flex sm:items-center sm:gap-5">
                         <div className="shrink-0">
                           <p className="text-xs font-semibold uppercase tracking-widest text-neutral-400">Your question types</p>
                           <p className="mt-1 text-xs text-neutral-500">A quick view of how you are exploring the task.</p>
                         </div>
                         <div className="mt-3 min-w-0 flex-1 space-y-2 sm:mt-0">
                           <div className="flex h-2 rounded-full overflow-hidden gap-px">
                             {active.map((type) => (
                               <div key={type} className={barColor[type]} style={{ width: `${(counts[type] / total) * 100}%` }} />
                             ))}
                           </div>
                           <div className="flex flex-wrap gap-1.5">
                             {active.map((type) => (
                               <span key={type} className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold border ${QUESTION_TYPE_META[type].color}`}>
                                 {type} <span className="font-bold">{counts[type]}</span>
                               </span>
                             ))}
                           </div>
                         </div>
                       </div>
                     );
                   })()}
                </div>
                <div className="flex-1 bg-neutral-50 px-6 py-8 space-y-6 overflow-y-auto max-h-[500px]">
                  {chatMessages.length === 0 && !isChatLoading && (
                    <p className="text-sm text-neutral-400 text-center">Start a conversation with the AI tutor...</p>
                  )}
                  {chatMessages.length > 5 && (
                    <p className="text-xs text-neutral-400 text-center">Showing the last 5 messages — {chatMessages.length - 5} earlier message{chatMessages.length - 5 === 1 ? "" : "s"} hidden.</p>
                  )}
                  {chatMessages.slice(-5).map((msg, index) => (
                    <div key={index} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                      {msg.role === "user" ? (
                        <div className="max-w-xl">
                          {msg.promptSource && (
                            <p className="mb-1.5 text-right text-xs font-medium text-neutral-500">{msg.promptSource}</p>
                          )}
                          <div className="rounded-3xl bg-black text-white px-5 py-4 text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</div>
                        </div>
                      ) : msg.role === "system-error" ? (
                        <div className="max-w-2xl rounded-3xl bg-neutral-100 border border-neutral-300 px-6 py-5">
                          <p className="text-sm font-medium text-neutral-500 mb-1">AI not available</p>
                          <p className="text-sm text-neutral-600">{msg.content}</p>
                        </div>
                       ) : (
                         <div className="max-w-2xl rounded-3xl bg-white border border-neutral-200 px-6 py-5 shadow-sm space-y-4">
                           {msg.content && (
                             <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4" data-testid="torch-understand-this">
                               <p className="text-sm font-semibold text-sky-950 mb-2">Understand this</p>
                               <p className="text-sm text-sky-900 leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                             </div>
                           )}
                           {msg.discussionPrompt && (
                             <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4" data-testid="torch-discuss-with-torch">
                               <p className="text-sm font-semibold text-emerald-950 mb-2">
                                 {msg.discussionLabel === "Talk it through"
                                   ? msg.discussionLabel
                                   : msg.discussionLabel === "A question for you" || msg.discussionLabel === "Your turn" || msg.discussionLabel === "Reflection Prompt"
                                     ? msg.discussionLabel
                                     : "Talk it through"}
                               </p>
                               <p className="text-sm text-emerald-900">{msg.discussionPrompt}</p>
                             </div>
                           )}
                            {msg.tryNext && (
                              <div className="rounded-2xl bg-amber-50 border border-amber-200 p-4" data-testid="torch-try-next">
                                <p className="text-sm font-semibold text-amber-950 mb-2">
                                   {msg.tryNextLabel || "Your next step"}
                                </p>
                                <p className="text-sm text-amber-900 whitespace-pre-wrap">{msg.tryNext}</p>
                              </div>
                            )}
                         </div>
                      )}
                    </div>
                  ))}
                  {isChatLoading && (
                    <div className="flex justify-start">
                      <div className="max-w-2xl rounded-3xl bg-white border border-neutral-200 px-6 py-5 shadow-sm animate-pulse">
                        <p className="text-sm text-neutral-500">Thinking...</p>
                      </div>
                    </div>
                  )}
                </div>
                 <div className="border-t border-neutral-200 bg-white px-6 py-5 flex items-end gap-4">
                   <textarea
                     ref={chatInputRef}
                     className="flex-1 rounded-2xl border border-neutral-200 p-4 min-h-[80px] resize-none focus:outline-none focus:ring-2 focus:ring-black/10"
                     placeholder={selectedBloomLevel !== null ? goalLevels[selectedBloomLevel].placeholder : "Select a goal above, then type your question here..."}
                     value={chatInput}
                      onChange={(e) => {
                        const nextValue = e.target.value;
                         if (pendingTorchSuggestion && nextValue !== pendingTorchSuggestion.question) {
                           const editKey = torchSuggestionKey(pendingTorchSuggestion.goal, pendingTorchSuggestion.question);
                           if (!editedTorchSuggestionKeysRef.current.has(editKey)) {
                             editedTorchSuggestionKeysRef.current.add(editKey);
                             recordThinkingChoiceEvent({
                               eventType: "edited",
                               optionName: pendingTorchSuggestion.goal,
                               questionId: pendingTorchSuggestion.questionId,
                               conversationTurn: chatMessages.filter((entry) => entry.role === "user").length + 1,
                             });
                           }
                           setPendingTorchSuggestion({ ...pendingTorchSuggestion, edited: true });
                        }
                        setChatInput(nextValue);
                      }}
                     onKeyDown={handleKeyPress}
                     data-testid="textarea-torch-chat"
                   />
                   <button
                     disabled={isChatLoading || !chatInput.trim()}
                     className="rounded-2xl bg-black text-white px-6 py-4 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                     onClick={handleInvestigate}
                     data-testid="button-torch-investigate"
                   >
                     Investigate
                   </button>
                 </div>
                 <div className="border-t border-neutral-200 bg-neutral-50 px-6 py-5" data-testid="panel-torch-notes">
                   <div className="rounded-2xl border border-neutral-200 bg-white p-5 space-y-2">
                     <p className="text-xs font-semibold uppercase tracking-widest text-neutral-400">My Notes</p>
        <p className="text-xs text-neutral-500">Capture thoughts, ideas or reminders as you investigate. These will appear in the Final Answer stage for reference.</p>
                     <textarea
                       value={mapAnswers.notes}
                       onChange={(e) => setMapAnswers({ ...mapAnswers, notes: e.target.value })}
                       className="w-full rounded-xl border border-neutral-200 p-3 min-h-[90px] resize-none focus:outline-none focus:ring-2 focus:ring-black/10 text-sm"
                       placeholder="e.g. Things I want to remember as I investigate, initial hypotheses, anything that struck me when reading the task…"
                       data-testid="textarea-torch-notes"
                     />
                   </div>
                 </div>
                 {/* MAP questions — always visible */}
                {(() => {
                  const myQuestions = mapAnswers.enquiryQuestions.filter((q) => q.trim());
                  const visibleMapQs = myQuestions.filter((_, i) => !askedMapQuestions.has(i));
                  if (visibleMapQs.length === 0) return null;
                  const askMapQ = (q: string, i: number) => {
                    setChatInput(q);
                    setAskedMapQuestions(prev => new Set([...prev, i]));
                    chatInputRef.current?.focus();
                  };
                  return (
                    <div className="border-t border-neutral-200 bg-white px-6 pt-4 pb-2 space-y-2" data-testid="panel-torch-map-questions">
                      <p className="text-xs font-semibold text-neutral-400 uppercase tracking-widest">Your planned questions from MAP</p>
                      <div className="flex flex-col gap-1">
                        {myQuestions.map((q, i) => askedMapQuestions.has(i) ? null : (
                          <div key={i} className="flex items-center gap-2 rounded-2xl border border-neutral-200 bg-neutral-50 pl-4 pr-2 py-2">
                            <span className="flex-1 text-sm text-neutral-800 leading-snug">{q}</span>
                            <button
                              onClick={() => askMapQ(q, i)}
                              className="shrink-0 text-xs font-medium text-neutral-500 bg-white border border-neutral-200 rounded-xl px-3 py-1.5 hover:bg-black hover:text-white hover:border-black transition-colors"
                            >
                              Ask
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
                {/* Suggested questions — only when a goal is selected */}
                {selectedBloomLevel !== null && (() => {
                  const levelName = goalLevels[selectedBloomLevel].label;
                  const suggestions = torchSuggestions[levelName] ?? [];
                   if (torchSuggestionStatus === "loading") {
                     return (
                       <div ref={suggestionsRef} className="border-t border-neutral-200 bg-white px-6 py-5" data-testid="status-torch-suggestions-loading">
                         <p className="text-sm font-medium text-neutral-700">Preparing questions for {levelName}…</p>
                         <p className="text-xs text-neutral-500 mt-1">These will use your task and MAP planning.</p>
                       </div>
                     );
                   }
                   if (torchSuggestionStatus === "error") {
                     return (
                       <div ref={suggestionsRef} className="border-t border-neutral-200 bg-white px-6 py-5 space-y-3" data-testid="status-torch-suggestions-error">
                         <div>
                           <p className="text-sm font-medium text-neutral-700">Suggested questions are unavailable</p>
                           <p className="text-xs text-neutral-500 mt-1">{torchSuggestionError}</p>
                         </div>
                         <button
                           onClick={() => void loadTorchSuggestions()}
                           disabled={isReadOnly}
                           className="rounded-xl border border-neutral-300 bg-white px-3 py-2 text-xs font-semibold hover:bg-neutral-50 disabled:opacity-50"
                           data-testid="button-retry-torch-suggestions"
                         >
                           Try again
                         </button>
                       </div>
                     );
                   }
                   if (torchSuggestionStatus === "empty" || (torchSuggestionStatus === "ready" && suggestions.length === 0)) {
                     return (
                       <div ref={suggestionsRef} className="border-t border-neutral-200 bg-white px-6 py-5" data-testid="status-torch-suggestions-empty">
                         <p className="text-sm font-medium text-neutral-700">No starter questions were returned for {levelName}.</p>
                         <p className="text-xs text-neutral-500 mt-1">You can still use your MAP questions or write your own question above.</p>
                       </div>
                     );
                   }
                    if (suggestions.length === 0) return null;
                   const visibleSuggestions = suggestions.slice(0, 4);
                   const usedCount = visibleSuggestions.filter((suggestion) =>
                     usedTorchSuggestions.has(torchSuggestionKey(levelName, suggestion)),
                   ).length;
                    const askSuggestion = (question: string, questionIndex: number) => {
                     if (usedTorchSuggestions.has(torchSuggestionKey(levelName, question))) return;
                     setChatInput(question);
                      const questionId = `torch-${levelName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${questionIndex + 1}`;
                      setPendingTorchSuggestion({ goal: levelName, question, questionId });
                      recordThinkingChoiceEvent({
                        eventType: "selected",
                        optionName: levelName,
                        questionId,
                        conversationTurn: chatMessages.filter((entry) => entry.role === "user").length + 1,
                      });
                      recordThinkingChoiceEvent({
                        eventType: "inserted",
                        optionName: levelName,
                        questionId,
                        conversationTurn: chatMessages.filter((entry) => entry.role === "user").length + 1,
                      });
                    chatInputRef.current?.focus();
                  };
                  return (
                     <div ref={suggestionsRef} className="border-t border-neutral-200 bg-white px-6 pt-4 pb-2 space-y-2" data-testid="panel-torch-suggested-questions">
                       <div className="flex items-start justify-between gap-3">
                       <p className="text-xs font-semibold text-neutral-400 uppercase tracking-widest">Suggested example questions for {levelName}</p>
                         <p className="text-xs font-medium text-neutral-500" data-testid="torch-example-question-counter">
                           Example questions used: {usedCount} of 4 · {usedCount === 4 ? "No example questions remaining" : `${4 - usedCount} remaining`}
                         </p>
                       </div>
                      <div className="flex flex-col gap-1">
                         {visibleSuggestions.map((suggestion, i) => {
                           const isUsed = usedTorchSuggestions.has(torchSuggestionKey(levelName, suggestion));
                           return (
                           <div key={i} className={`flex items-center gap-2 rounded-2xl border pl-4 pr-2 py-2 ${isUsed ? "border-neutral-200 bg-neutral-100" : "border-amber-200 bg-amber-50"}`}>
                             <span className={`flex-1 text-sm leading-snug ${isUsed ? "text-neutral-500" : "text-amber-900"}`}>{suggestion}</span>
                             {isUsed && <span className="shrink-0 text-xs font-semibold text-neutral-500">Used</span>}
                            <button
                               onClick={() => askSuggestion(suggestion, i)}
                               disabled={isUsed || isReadOnly || isChatLoading}
                               className="shrink-0 text-xs font-medium text-amber-700 bg-white border border-amber-200 rounded-xl px-3 py-1.5 hover:bg-amber-700 hover:text-white hover:border-amber-700 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                            >
                               {isUsed ? "Used" : "Ask"}
                            </button>
                          </div>
                           );
                         })}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
            <StageCompletionFooter stage="TORCH" />
            <TeacherFeedbackBanner stage="TORCH" feedback={studentFeedback["TORCH"]} onAcknowledge={() => { void acknowledgeFeedback("TORCH"); }} isAcknowledging={acknowledgingFeedbackStage === "TORCH"} readOnly={isReadOnly} />
          </section>
        )}

        {/* ── RESEARCH ── */}
        {!showOverview && activeStage === "RESEARCH" && (
          <section data-student-section="RESEARCH" className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
            <div className="border-b border-neutral-200 px-8 py-6 flex items-center justify-between gap-4">
              <div>
                <p className={`text-xs uppercase tracking-[0.2em] mb-2 ${STAGE_ACCENT.RESEARCH}`}>RESEARCH LOG</p>
                <h2 className="text-3xl font-semibold tracking-tight">Record Your Sources</h2>
                <p className="text-neutral-500 mt-1 text-sm">For each source you use, document what you found and how you're using it.</p>
              </div>
              <div className="flex items-center gap-3 shrink-0 flex-wrap justify-end">
                <button onClick={goPrev} className="rounded-2xl border border-neutral-200 text-neutral-500 px-4 py-3 text-sm font-medium hover:text-black hover:bg-neutral-50 transition-colors" data-testid="button-back-to-torch">
                  ← Back to TORCH
                </button>
                {completedStages.has("RESEARCH") && (
                  <button
                    className="rounded-2xl border border-neutral-200 text-neutral-500 px-4 py-3 text-sm font-medium hover:text-red-500 hover:border-red-200 hover:bg-red-50 transition-colors"
                    onClick={() => setStageToReset("RESEARCH")}
                    data-testid="button-reset-research"
                  >
                    Reset stage
                  </button>
                )}
                <button onClick={goNext} className="rounded-2xl bg-black text-white px-6 py-3 text-sm font-medium hover:opacity-90 transition-opacity" data-testid="button-move-compass">
                  Continue to COMPASS →
                </button>
              </div>
            </div>

            <div>
              <div className="divide-y divide-neutral-200 bg-neutral-50/30">
                {researchEntries.map((entry, idx) => {
                  const isCollapsed = !expandedEntries.has(entry.id);
                  const provenanceLabel = sourceProvenanceLabel(entry);
                  const sourceDetailsGuidance = entry.sourceType
                    ? SOURCE_DETAILS_GUIDANCE[entry.sourceType]
                    : "Choose a source type, then add the details someone else would need to identify or find it.";
                  const toggleCollapse = () =>
                    setExpandedEntries((prev) => {
                      const next = new Set<string>(); // Close others when one is opened
                      if (isCollapsed) next.add(entry.id);
                      return next;
                    });
                  const TRUSTWORTHINESS_OPTIONS = [
                    "I checked who created it",
                    "I checked when it was published",
                    "It provides supporting evidence",
                    "I compared it with another source",
                    "It may contain bias or a particular perspective",
                    "I am not yet sure"
                  ];
                  const EFFECT_OPTIONS = [
                    "Supported my thinking",
                    "Challenged my thinking",
                    "Changed my thinking",
                    "Added a different perspective",
                    "Did not help my investigation"
                  ];
                  return (
                    <div key={entry.id} className={isCollapsed ? "" : "bg-white pb-6"}>
                      {isCollapsed ? (
                        <div className={`px-8 py-5 flex items-center justify-between gap-4 transition-colors ${provenanceLabel ? "border-l-4 border-l-sky-400 bg-white hover:bg-neutral-50" : "bg-white hover:bg-neutral-50"}`}>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2 mb-1.5">
                              <span className="text-xs font-bold text-neutral-400 uppercase tracking-widest">Source {idx + 1}</span>
                              {provenanceLabel && (
                                <span className="inline-flex rounded-md bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-700 uppercase tracking-widest border border-sky-100" data-testid={`badge-source-provenance-${idx}`}>
                                  {provenanceLabel}
                                </span>
                              )}
                              <span className={`inline-flex rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest border ${entry.isComplete ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                                {entry.isComplete ? 'Complete' : 'In progress'}
                              </span>
                            </div>
                            <p className="text-sm font-semibold text-neutral-800 truncate">
                              {entry.actualSource
                                ? <LinkifiedText text={entry.actualSource} />
                                : <span className="text-neutral-400 italic">No source name</span>}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              onClick={toggleCollapse}
                              className="text-xs font-semibold text-neutral-700 hover:text-black px-4 py-2 rounded-xl border border-neutral-200 hover:bg-neutral-100 transition-colors shadow-sm bg-white"
                              data-testid={`button-view-research-entry-${idx}`}
                            >
                              {entry.isComplete ? "Review" : "Continue"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="pt-6 px-8 animate-in fade-in slide-in-from-top-2 duration-200">
                          {/* Expanded Header */}
                          <div className="flex flex-col gap-1.5 mb-6">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-xs font-bold text-neutral-400 uppercase tracking-widest">Source {idx + 1}</span>
                              {provenanceLabel && (
                                <span className="inline-flex rounded-md bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-700 uppercase tracking-widest border border-sky-100" data-testid={`badge-source-provenance-${idx}`}>
                                  {provenanceLabel}
                                </span>
                              )}
                              <span className={`inline-flex rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest border ${entry.isComplete ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                                {entry.isComplete ? 'Complete' : 'In progress'}
                              </span>
                            </div>
                            <div className="flex flex-col gap-2">
                              <label htmlFor={`research-source-${entry.id}`} className="text-sm font-semibold text-neutral-700">Source name or link</label>
                              <input
                                id={`research-source-${entry.id}`}
                                type="text"
                                value={entry.actualSource}
                                onChange={(e) => updateEntry(entry.id, "actualSource", e.target.value)}
                                className="w-full font-semibold text-lg bg-transparent focus:outline-none focus:border-b-2 border-black border-dashed transition-all"
                                placeholder="Source name or link"
                                data-testid={`input-research-source-${idx}`}
                              />
                              <label htmlFor={`research-source-type-${entry.id}`} className="text-sm font-semibold text-neutral-700">Source type</label>
                              <select
                                id={`research-source-type-${entry.id}`}
                                value={entry.sourceType}
                                onChange={(e) => updateEntry(entry.id, "sourceType", e.target.value)}
                                className="w-fit text-sm bg-transparent border-b border-neutral-300 pb-1 text-neutral-600 focus:outline-none focus:border-black"
                                data-testid={`select-research-source-type-${idx}`}
                              >
                                <option value="" disabled>Select source type...</option>
                                {SOURCE_TYPE_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                              </select>
                            </div>
                          </div>

                          {/* Source identification & original plan */}
                          <div className="space-y-3 mb-8">
                            <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
                              <label htmlFor={`research-citation-${entry.id}`} className="block text-sm font-semibold text-neutral-700">
                                How can someone find this source? <span className="text-red-500" aria-hidden="true">*</span>
                              </label>
                              <p className="mt-1 text-xs text-neutral-500">{sourceDetailsGuidance}</p>
                              <textarea
                                id={`research-citation-${entry.id}`}
                                value={entry.sourceDetails}
                                onChange={(e) => updateEntry(entry.id, "sourceDetails", e.target.value)}
                                className="mt-3 min-h-[70px] w-full resize-none rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                                placeholder="Add the link, ISBN, DOI, or other details needed to identify this source."
                                required
                                data-testid={`textarea-research-source-details-${idx}`}
                              />
                            </div>

                            {entry.mapContext && (
                              <details className="group [&_summary::-webkit-details-marker]:hidden rounded-xl border border-neutral-200 bg-neutral-50 overflow-hidden">
                                <summary className="flex cursor-pointer items-center justify-between px-4 py-3 text-sm font-semibold text-neutral-700 hover:bg-neutral-100">
                                  My original plan
                                  <span className="transition group-open:rotate-180">
                                    <svg fill="none" height="24" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="24"><polyline points="6 9 12 15 18 9" /></svg>
                                  </span>
                                </summary>
                                <div className="px-4 pb-4 border-t border-neutral-200 bg-white pt-4 space-y-3">
                                  <div>
                                    <p className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 mb-1">What I intended to investigate</p>
                                    <p className="text-sm text-neutral-800">{entry.mapContext.investigation}</p>
                                  </div>
                                  <div>
                                    <p className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 mb-1">Where I intended to look</p>
                                    <p className="text-sm text-neutral-800">{entry.mapContext.sourceTypes?.join(', ') || 'Not specified'}</p>
                                  </div>
                                  {entry.mapContext.plannedSource && (
                                    <div>
                                      <p className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 mb-1">The source I originally planned</p>
                                      <p className="text-sm text-neutral-800">{entry.mapContext.plannedSource}</p>
                                    </div>
                                  )}
                                  <div>
                                    <p className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 mb-1">How I intended to check the information</p>
                                    <p className="text-sm text-neutral-800">
                                      {entry.mapContext.verificationSelections?.join(', ') || ''}
                                      {entry.mapContext.verificationSelections?.length && entry.mapContext.verification ? ' — ' : ''}
                                      {entry.mapContext.verification}
                                      {(!entry.mapContext.verificationSelections?.length && !entry.mapContext.verification) && 'Not specified'}
                                    </p>
                                  </div>
                                </div>
                              </details>
                            )}
                          </div>

                          {/* 3 Questions */}
                          <div className="space-y-8 max-w-3xl">
                            {/* Step 1 */}
                            <div className="space-y-3">
                              <label htmlFor={`research-learning-${entry.id}`} className="block text-lg font-semibold tracking-tight">1. What did you learn?</label>
                              <p className="text-sm text-neutral-600">What did you learn from this source? Include the most important evidence, information or ideas.</p>
                              <textarea
                                id={`research-learning-${entry.id}`}
                                value={entry.combinedLearning ?? ""}
                                onChange={(e) => updateEntry(entry.id, "combinedLearning", e.target.value)}
                                className="w-full rounded-xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10 min-h-[120px] resize-y"
                                placeholder="Write your findings here..."
                                data-testid={`textarea-research-learning-${idx}`}
                              />
                            </div>

                            {/* Step 2 */}
                            <div className="space-y-3 pt-6 border-t border-neutral-100">
                              <h3 className="text-lg font-semibold tracking-tight">2. Can you trust it?</h3>
                              <p className="text-sm text-neutral-600">Select anything you checked or noticed.</p>
                              <div className="flex flex-col gap-2.5 pt-1 mb-4">
                                {TRUSTWORTHINESS_OPTIONS.map((opt) => {
                                  const sels = entry.trustworthinessSelections ?? [];
                                  const isSel = sels.includes(opt);
                                  return (
                                    <label key={opt} className="flex items-center gap-3 cursor-pointer w-fit group rounded-md focus-within:ring-2 focus-within:ring-neutral-500 focus-within:ring-offset-2">
                                      <div className={`w-4 h-4 rounded-sm border flex items-center justify-center transition-colors ${isSel ? 'bg-neutral-800 border-neutral-800 text-white' : 'border-neutral-300 bg-white group-hover:border-neutral-400'}`}>
                                        {isSel && <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                                      </div>
                                      <span className="text-sm font-medium text-neutral-700 select-none">{opt}</span>
                                      <input type="checkbox" className="sr-only" checked={isSel} onChange={(e) => {
                                        const newSels = e.target.checked ? [...sels, opt] : sels.filter(s => s !== opt);
                                        researchDirtyRef.current = true;
                                        setResearchEntries(prev => prev.map(r => {
                                          if (r.id !== entry.id) return r;
                                          const updated = { ...r, trustworthinessSelections: newSels };
                                          return updated.isComplete && !researchEntryReadyToComplete(updated)
                                            ? { ...updated, isComplete: false }
                                            : updated;
                                        }));
                                      }} />
                                    </label>
                                  );
                                })}
                              </div>
                              <label htmlFor={`research-reliability-${entry.id}`} className="block text-sm text-neutral-600 font-medium">What makes this source trustworthy—or what makes you question it?</label>
                              <textarea
                                id={`research-reliability-${entry.id}`}
                                value={entry.reliability}
                                onChange={(e) => updateEntry(entry.id, "reliability", e.target.value)}
                                className="w-full rounded-xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10 min-h-[80px] resize-y"
                                placeholder="Explain your thinking here..."
                                data-testid={`textarea-research-reliability-${idx}`}
                              />
                            </div>

                            {/* Step 3 */}
                            <div className="space-y-3 pt-6 border-t border-neutral-100">
                              <h3 className="text-lg font-semibold tracking-tight">3. How did it affect your thinking?</h3>
                              <div className="flex flex-col gap-2.5 pt-1 mb-4">
                                {EFFECT_OPTIONS.map((opt) => {
                                  const isSel = entry.effectSelection === opt;
                                  return (
                                    <label key={opt} className="flex items-center gap-3 cursor-pointer w-fit group rounded-md focus-within:ring-2 focus-within:ring-neutral-500 focus-within:ring-offset-2">
                                      <div className={`w-4 h-4 rounded-full border flex items-center justify-center transition-colors ${isSel ? 'border-neutral-800' : 'border-neutral-300 bg-white group-hover:border-neutral-400'}`}>
                                        {isSel && <div className="w-2 h-2 rounded-full bg-neutral-800" />}
                                      </div>
                                      <span className="text-sm font-medium text-neutral-700 select-none">{opt}</span>
                                      <input type="radio" name={`effect-${entry.id}`} className="sr-only" checked={isSel} onChange={() => {
                                        researchDirtyRef.current = true;
                                        setResearchEntries(prev => prev.map(r => r.id === entry.id ? { ...r, effectSelection: opt } : r));
                                      }} />
                                    </label>
                                  );
                                })}
                              </div>
                              <label htmlFor={`research-usage-${entry.id}`} className="block text-sm text-neutral-600 font-medium">Explain what this source added to your thinking.</label>
                              <textarea
                                id={`research-usage-${entry.id}`}
                                value={entry.usage}
                                onChange={(e) => updateEntry(entry.id, "usage", e.target.value)}
                                className="w-full rounded-xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10 min-h-[80px] resize-y"
                                placeholder="Explain how your thinking changed or grew..."
                                data-testid={`textarea-research-usage-${idx}`}
                              />
                            </div>
                          </div>

                          <div className="pt-8 mt-8 border-t border-neutral-200 flex justify-between items-center">
                            <button onClick={() => removeEntry(entry.id)} className="text-sm font-medium text-neutral-400 hover:text-red-500 transition-colors">
                              Delete source
                            </button>
                            <div className="flex gap-3">
                              {!researchEntryReadyToComplete(entry) && (
                                <p className="max-w-xs self-center text-right text-xs text-neutral-500">
                                  Add the source name and type, then complete all three questions before marking this source complete.
                                </p>
                              )}
                              <button onClick={() => toggleCollapse()} className="text-sm font-medium text-neutral-500 hover:text-neutral-800 transition-colors">
                                Collapse
                              </button>
                              <button
                                onClick={() => {
                                  if (!researchEntryReadyToComplete(entry)) return;
                                  researchDirtyRef.current = true;
                                  setResearchEntries(prev => prev.map(r => r.id === entry.id ? { ...r, isComplete: true } : r));
                                  setExpandedEntries(prev => { const next = new Set(prev); next.delete(entry.id); return next; });
                                }}
                                disabled={isReadOnly || !researchEntryReadyToComplete(entry)}
                                className="rounded-xl bg-black px-6 py-2.5 text-sm font-semibold text-white hover:opacity-90 transition-opacity shadow-md disabled:cursor-not-allowed disabled:opacity-40"
                                data-testid={`button-complete-research-entry-${idx}`}
                              >
                                Mark this source as complete
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="p-8 border-t border-neutral-200 flex justify-center bg-neutral-50">
                <button
                  onClick={addEntry}
                  disabled={isReadOnly}
                  className="rounded-xl border border-dashed border-neutral-300 bg-white px-8 py-4 text-sm font-medium text-neutral-600 hover:border-neutral-400 hover:text-neutral-900 transition-colors shadow-sm disabled:opacity-60"
                  data-testid="button-add-research-entry"
                >
                  + Add a source I discovered
                </button>
              </div>
            </div>

            <StageCompletionFooter stage="RESEARCH" />
            <TeacherFeedbackBanner stage="RESEARCH" feedback={studentFeedback["RESEARCH"]} onAcknowledge={() => { void acknowledgeFeedback("RESEARCH"); }} isAcknowledging={acknowledgingFeedbackStage === "RESEARCH"} readOnly={isReadOnly} />
          </section>
        )}

        {/* ── COMPASS ── */}
        {!showOverview && activeStage === "COMPASS" && (
          <section data-student-section="COMPASS" className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
            <div className="border-b border-neutral-200 px-8 py-6 flex items-center justify-between gap-4">
              <div>
                <p className={`text-xs uppercase tracking-[0.2em] mb-2 ${STAGE_ACCENT.COMPASS}`}>COMPASS</p>
                <h2 className="text-3xl font-semibold tracking-tight">Verify, Evaluate & Reflect</h2>
                <p className="text-neutral-500 mt-1 text-sm">Check your evidence, evaluate sources, identify bias, compare perspectives, and reflect on how confident you are in your understanding.</p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <button onClick={goPrev} className="rounded-2xl border border-neutral-200 text-neutral-500 px-4 py-3 text-sm font-medium hover:text-black hover:bg-neutral-50 transition-colors" data-testid="button-back-to-research">
                  ← Back to RESEARCH
                </button>
                {completedStages.has("COMPASS") && (
                  <button
                    className="rounded-2xl border border-neutral-200 text-neutral-500 px-4 py-3 text-sm font-medium hover:text-red-500 hover:border-red-200 hover:bg-red-50 transition-colors"
                    onClick={() => setStageToReset("COMPASS")}
                    data-testid="button-reset-compass"
                  >
                    Reset stage
                  </button>
                )}
                <button onClick={goNext} className="rounded-2xl bg-black text-white px-6 py-3 text-sm font-medium hover:opacity-90 transition-opacity" data-testid="button-move-embed">
                  Continue to Final Answer →
                </button>
              </div>
            </div>
            {(() => {
              const compassTips: Record<string, { title: string; text: string } | null> = {
                check1: { title: "Say it simply", text: "If you can't explain your conclusion without your notes, you don't fully understand it yet. That's the test." },
                check2: { title: "Devil's advocate", text: "Actively look for the argument against your view. Understanding the opposition strengthens your own position." },
                check3: { title: "Productive uncertainty", text: "Not knowing something is not a weakness — it's information. It tells you exactly where to focus before you write." },
                check4: { title: "Balance, not agreement", text: "Good research doesn't just confirm what you already thought. If all your sources say the same thing, look harder for the dissenting view — even if you ultimately disagree with it." },
                check5: null,
              };
              const sourceChecklist = [
                { key: "sl1" as const, label: "Sources recorded", description: "All sources I found are in my research log, not just the ones I ended up using" },
                { key: "sl2" as const, label: "Reliability checked", description: "I've considered whether each source is trustworthy (author, publisher, date)" },
                { key: "sl3" as const, label: "Bias considered", description: "I've thought about what perspective each source might be coming from" },
                { key: "sl4" as const, label: "Balance tested", description: "I've looked for views that challenge my conclusion, not just ones that support it" },
                { key: "sl5" as const, label: "Evidence-led", description: "My conclusion follows from the evidence — I haven't worked backwards from what I already believed" },
              ];
              const allChecked = sourceChecklist.every(item => compassAnswers[item.key]);
              return (
                <div className="p-8 space-y-5">
                  {/* Source integrity checklist */}
                  <div className="rounded-2xl border border-neutral-200 overflow-hidden">
                    <div className="px-5 py-4 bg-neutral-50 border-b border-neutral-200 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-semibold">Research integrity checklist</p>
                        <p className="text-xs text-neutral-500 mt-0.5">Tick each one honestly before you write</p>
                      </div>
                      {allChecked && <span className="text-xs font-medium text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-full px-3 py-1">All done ✓</span>}
                    </div>
                    <div className="divide-y divide-neutral-100">
                      {sourceChecklist.map((item) => (
                        <label key={item.key} className="flex items-start gap-4 px-5 py-4 cursor-pointer hover:bg-neutral-50 transition-colors">
                          <div className="mt-0.5 shrink-0">
                            <input
                              type="checkbox"
                              checked={!!compassAnswers[item.key]}
                              onChange={(e) => setCompassAnswers(prev => ({ ...prev, [item.key]: e.target.checked }))}
                              className="w-4 h-4 rounded border-neutral-300 accent-black cursor-pointer"
                              data-testid={`checkbox-compass-${item.key}`}
                            />
                          </div>
                          <div>
                            <p className={`text-sm font-medium leading-snug ${compassAnswers[item.key] ? "line-through text-neutral-400" : "text-neutral-800"}`}>{item.label}</p>
                            <p className="text-xs text-neutral-500 mt-0.5 leading-relaxed">{item.description}</p>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>
                  {compassChecks.map((check, index) => (
                    <div key={check.key} className="rounded-2xl border border-neutral-200 p-5 space-y-3">
                      <div>
                        <p className="text-sm font-semibold">{check.title}</p>
                        <p className="text-xs text-neutral-500 mt-1 leading-relaxed">{check.prompt}</p>
                      </div>
                      {compassTips[check.key] && (
                        <div className="flex gap-3 rounded-xl bg-emerald-50 border border-emerald-100 px-4 py-3">
                          <span className="text-emerald-500 text-sm mt-0.5 shrink-0">💡</span>
                          <div>
                            <p className="text-xs font-semibold text-emerald-700 mb-0.5">{compassTips[check.key]!.title}</p>
                            <p className="text-xs text-emerald-800/70 leading-relaxed">{compassTips[check.key]!.text}</p>
                          </div>
                        </div>
                      )}
                      <textarea
                        value={compassAnswers[check.key]}
                        onChange={(e) => setCompassAnswers({ ...compassAnswers, [check.key]: e.target.value })}
                        className="w-full rounded-2xl border border-neutral-200 p-4 min-h-[100px] resize-none focus:outline-none focus:ring-2 focus:ring-black/10 text-sm"
                        placeholder="Write your response here..."
                        data-testid={`textarea-compass-${index}`}
                      />
                    </div>
                  ))}
                  <div className="pt-4 border-t border-neutral-200 space-y-3">
                    <h4 className="text-base font-semibold tracking-tight text-neutral-700">Confidence is not the same as understanding.</h4>
                    <p className="text-xs text-neutral-500 leading-relaxed">Feeling sure about something is not evidence you understand it. These four questions are designed to reveal the gap between what you think you know and what you can actually articulate, defend, and write.</p>
                  </div>
                </div>
              );
            })()}
            <StageCompletionFooter stage="COMPASS" />
            <TeacherFeedbackBanner stage="COMPASS" feedback={studentFeedback["COMPASS"]} onAcknowledge={() => { void acknowledgeFeedback("COMPASS"); }} isAcknowledging={acknowledgingFeedbackStage === "COMPASS"} readOnly={isReadOnly} />
          </section>
        )}

        {/* ── EMBED ── */}
        {!showOverview && activeStage === "EMBED" && (
          <section data-student-section="EMBED" className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
            {/* Header */}
            <div className="border-b border-neutral-200 px-8 py-6 flex items-center justify-between gap-4">
              <div>
                <p className={`text-xs uppercase tracking-[0.2em] mb-2 ${STAGE_ACCENT.EMBED}`}>Final Answer</p>
                <h2 className="text-3xl font-semibold tracking-tight">Your Answer</h2>
                <p className="text-neutral-500 mt-1 text-sm">Bring together everything you've learned and write your response to the task in your own words.</p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <button onClick={goPrev} className="rounded-2xl border border-neutral-200 text-neutral-500 px-4 py-3 text-sm font-medium hover:text-black hover:bg-neutral-50 transition-colors" data-testid="button-back-to-compass">
                  ← Back to COMPASS
                </button>
                {completedStages.has("EMBED") && (
                  <button
                    className="rounded-2xl border border-neutral-200 text-neutral-500 px-4 py-3 text-sm font-medium hover:text-red-500 hover:border-red-200 hover:bg-red-50 transition-colors"
                    onClick={() => setStageToReset("EMBED")}
                    data-testid="button-reset-embed"
                  >
                    Reset stage
                  </button>
                )}
              </div>
            </div>

            {/* Answer + reference notes */}
            <div>
              <div className="p-8 space-y-5">
                {task && (
                  <div className="rounded-2xl bg-violet-50 border border-violet-100 px-5 py-4">
                    <p className="text-xs uppercase tracking-widest font-semibold text-violet-400 mb-1">Task question</p>
                    <p className="font-semibold text-neutral-800">{task.title}</p>
                    {task.question && <p className="text-neutral-600 mt-1 text-sm">{task.question}</p>}
                  </div>
                )}
                <FinalAnswerEditor
                  value={embedAnswers.finalAnswer}
                  readOnly={isReadOnly}
                  onChange={(finalAnswer) => {
                    if (answerVisibleText(finalAnswer).length <= FINAL_ANSWER_MAX_CHARACTERS) {
                      setEmbedAnswers({ ...embedAnswers, finalAnswer });
                    }
                  }}
                />
                <p className="text-right text-xs text-neutral-500">
                  {countWords(answerVisibleText(embedAnswers.finalAnswer)).toLocaleString()} words · {answerVisibleText(embedAnswers.finalAnswer).length.toLocaleString()} / {FINAL_ANSWER_MAX_CHARACTERS.toLocaleString()} characters
                </p>
                <details
                  data-testid="supporting-materials-disclosure"
                  className="group rounded-2xl border border-neutral-200 bg-neutral-50"
                >
                  <summary className="cursor-pointer list-none p-5 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="font-semibold">Supporting materials</h3>
                        <p className="mt-1 text-sm text-neutral-600">Optional. Add details about separate documents, images or other materials you shared with your teacher.</p>
                      </div>
                      <span className="mt-0.5 shrink-0 text-lg leading-none text-neutral-500 transition-transform group-open:rotate-180" aria-hidden="true">⌄</span>
                    </div>
                  </summary>
                  <div className="border-t border-neutral-200 p-5 space-y-3">
                    <p className="text-sm text-neutral-600">If you use a separate document, image or other supporting material, refer to it clearly in your Final Answer. Explain what it shows and why it is relevant. Share it with your teacher using your school’s agreed method. Files cannot be uploaded to the e-Assisted Climb or analysed by its AI feedback.</p>
                  {embedAnswers.supportingMaterials && (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-2">
                      <label htmlFor="legacy-supporting-materials" className="block text-sm font-semibold text-amber-950">Existing supporting materials note</label>
                      <p className="text-xs text-amber-900">This older note is preserved exactly as saved. You can keep it alongside the structured cards.</p>
                      <textarea
                        id="legacy-supporting-materials"
                        value={embedAnswers.supportingMaterials}
                        onChange={(event) => {
                          const supportingMaterials = event.target.value;
                          if (supportingMaterials.length <= LEGACY_SUPPORTING_MATERIALS_MAX_CHARACTERS) {
                            setEmbedAnswers({ ...embedAnswers, supportingMaterials });
                          }
                        }}
                        maxLength={LEGACY_SUPPORTING_MATERIALS_MAX_CHARACTERS}
                        disabled={isReadOnly}
                        className="min-h-[110px] w-full rounded-xl border border-amber-200 bg-white p-4 text-sm disabled:bg-neutral-100"
                      />
                    </div>
                  )}
                  {embedAnswers.supportingMaterialCards.map((card, index) => (
                    <fieldset key={index} className="rounded-xl border border-neutral-200 bg-white p-5 space-y-4">
                      <div className="flex items-start justify-between gap-3">
                        <legend className="text-base font-semibold">Supporting material {index + 1}</legend>
                        {!isReadOnly && (
                          <button
                            type="button"
                            onClick={() => removeSupportingMaterial(index)}
                            className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50"
                          >
                            Remove this material
                          </button>
                        )}
                      </div>
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <div>
                          <label htmlFor={`supporting-material-${index}-name`} className="mb-1 block text-sm font-semibold">Name of the material</label>
                          <input
                            id={`supporting-material-${index}-name`}
                            value={card.name}
                            onChange={(event) => updateSupportingMaterial(index, { name: event.target.value })}
                            placeholder="Chapter 2 graphs"
                            disabled={isReadOnly}
                            className="w-full rounded-xl border border-neutral-200 p-3 text-sm disabled:bg-neutral-100"
                          />
                        </div>
                        <div>
                          <label htmlFor={`supporting-material-${index}-type`} className="mb-1 block text-sm font-semibold">Type of material</label>
                          <select
                            id={`supporting-material-${index}-type`}
                            value={card.type}
                            onChange={(event) => updateSupportingMaterial(index, { type: event.target.value as SupportingMaterialCard["type"] })}
                            disabled={isReadOnly}
                            className="w-full rounded-xl border border-neutral-200 bg-white p-3 text-sm disabled:bg-neutral-100"
                          >
                            <option value="">Select a type</option>
                            {SUPPORTING_MATERIAL_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                          </select>
                        </div>
                        <div>
                          <label htmlFor={`supporting-material-${index}-shows`} className="mb-1 block text-sm font-semibold">What does it show?</label>
                          <textarea
                            id={`supporting-material-${index}-shows`}
                            value={card.whatItShows}
                            onChange={(event) => updateSupportingMaterial(index, { whatItShows: event.target.value })}
                            disabled={isReadOnly}
                            className="min-h-[90px] w-full rounded-xl border border-neutral-200 p-3 text-sm disabled:bg-neutral-100"
                          />
                        </div>
                        <div>
                          <label htmlFor={`supporting-material-${index}-relevance`} className="mb-1 block text-sm font-semibold">Why is it relevant to your answer?</label>
                          <textarea
                            id={`supporting-material-${index}-relevance`}
                            value={card.whyRelevant}
                            onChange={(event) => updateSupportingMaterial(index, { whyRelevant: event.target.value })}
                            disabled={isReadOnly}
                            className="min-h-[90px] w-full rounded-xl border border-neutral-200 p-3 text-sm disabled:bg-neutral-100"
                          />
                        </div>
                        <div>
                          <label htmlFor={`supporting-material-${index}-reference`} className="mb-1 block text-sm font-semibold">Where is it referred to in your Final Answer?</label>
                          <input
                            id={`supporting-material-${index}-reference`}
                            value={card.finalResponseReference}
                            onChange={(event) => updateSupportingMaterial(index, { finalResponseReference: event.target.value })}
                            placeholder="Section 2 or paragraph 4"
                            disabled={isReadOnly}
                            className="w-full rounded-xl border border-neutral-200 p-3 text-sm disabled:bg-neutral-100"
                          />
                        </div>
                        <div>
                          <label htmlFor={`supporting-material-${index}-sharing`} className="mb-1 block text-sm font-semibold">How was it shared with your teacher?</label>
                          <input
                            id={`supporting-material-${index}-sharing`}
                            value={card.sharingMethod}
                            onChange={(event) => updateSupportingMaterial(index, { sharingMethod: event.target.value })}
                            placeholder="Microsoft Teams, Google Classroom or the school’s agreed method"
                            disabled={isReadOnly}
                            className="w-full rounded-xl border border-neutral-200 p-3 text-sm disabled:bg-neutral-100"
                          />
                        </div>
                      </div>
                    </fieldset>
                  ))}
                  {!isReadOnly && (
                    <button
                      type="button"
                      onClick={addSupportingMaterial}
                      className="w-full rounded-xl border border-dashed border-neutral-300 bg-white px-4 py-3 text-sm font-semibold hover:bg-neutral-50"
                    >
                      Add another supporting material
                    </button>
                  )}
                  <p className="text-right text-xs text-neutral-400">
                    {supportingMaterialCardsTextLength(embedAnswers.supportingMaterialCards).toLocaleString()} / {SUPPORTING_MATERIAL_MAX_CHARACTERS.toLocaleString()} characters
                  </p>
                  {supportingMaterialValidationError && (
                    <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-800">
                      {supportingMaterialValidationError}
                    </p>
                  )}
                  </div>
                </details>
                <div className="flex items-center justify-between">
                  <p className="text-xs text-neutral-400">You can use AI to check your complete answer and get feedback on what's covered and what's missing — longer answers are reviewed in sections and combined into one report. You only have two chances, so use them wisely.</p>
                  <div className="flex flex-col items-end gap-1">
                    <button
                      disabled={!answerReadableText(embedAnswers.finalAnswer).trim() || answerReadableText(embedAnswers.finalAnswer).length > ANSWER_FEEDBACK_MAX_CHARACTERS || answerFeedbackLoading || answerFeedbackCount >= ANSWER_FEEDBACK_LIMIT}
                      onClick={async () => {
                        setAnswerFeedbackLoading(true);
                        try {
                          const result = await apiFetch("/student/answer-feedback", {
                            method: "POST",
                            body: JSON.stringify({ answer: answerReadableText(embedAnswers.finalAnswer) }),
                          }) as { attempt: AnswerFeedbackAttempt; remaining: number };
                          setAnswerFeedbackAttempts((previous) => [...previous, result.attempt]);
                          setAnswerFeedbackCount(ANSWER_FEEDBACK_LIMIT - result.remaining);
                        } catch (error: any) {
                          const message = typeof error?.message === "string" ? error.message : "";
                          toast({
                            title: message.includes("50,000 characters") ? "Your answer is too long to check" : "Could not get feedback right now",
                            description: message || "Please try again. This attempt has not used one of your checks.",
                          });
                        } finally {
                          setAnswerFeedbackLoading(false);
                        }
                      }}
                      className="shrink-0 flex items-center gap-2 rounded-2xl bg-violet-600 text-white text-sm font-medium px-5 py-2.5 hover:bg-violet-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {answerFeedbackLoading ? (
                        <><span className="inline-block w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />Checking…</>
                      ) : (
                        <>✦ Check my answer</>
                      )}
                    </button>
                    <p className="text-xs text-neutral-400">
                      {answerFeedbackCount >= ANSWER_FEEDBACK_LIMIT
                        ? "You've used both checks — review the feedback above and make your final edits."
                        : `${ANSWER_FEEDBACK_LIMIT - answerFeedbackCount} of ${ANSWER_FEEDBACK_LIMIT} check${ANSWER_FEEDBACK_LIMIT - answerFeedbackCount === 1 ? "" : "s"} remaining`}
                    </p>
                  </div>
                </div>
                {answerReadableText(embedAnswers.finalAnswer).length > ANSWER_FEEDBACK_MAX_CHARACTERS && (
                  <p className="text-sm text-amber-700">Your answer is over the 50,000-character limit. Shorten it before requesting AI feedback.</p>
                )}

                {/* AI Feedback Panel */}
                {answerFeedbackAttempts.length > 0 && (
                  <div
                    className="max-h-[900px] overflow-y-auto space-y-5 pr-1"
                    role="region"
                    aria-label="AI answer feedback results"
                    data-testid="answer-feedback-results"
                  >
                    {answerFeedbackAttempts.map((attempt, attemptIndex) => {
                      const feedback = attempt.feedback;
                      const statusStyle = (status: string) => status === "met" || status === "used" || status === "meets"
                        ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                        : status === "missing"
                          ? "bg-amber-50 border-amber-200 text-amber-700"
                          : "bg-sky-50 border-sky-200 text-sky-700";
                      const statusLabel = (status: string) => status.replace("_", " ");
                      const journeyStages = ["MAP", "TORCH", "COMPASS"] as const;
                      return (
                        <details
                          key={attemptIndex}
                          className="group rounded-2xl border border-violet-200 bg-violet-50 overflow-hidden"
                          aria-labelledby={`answer-feedback-attempt-${attemptIndex + 1}`}
                          data-testid={`answer-feedback-attempt-${attemptIndex + 1}`}
                        >
                          <summary className="list-none cursor-pointer px-5 py-4 bg-violet-100/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500 [&::-webkit-details-marker]:hidden">
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="text-violet-600">✦</span>
                                  <h4 id={`answer-feedback-attempt-${attemptIndex + 1}`} className="text-sm font-semibold text-violet-900">
                                    Answer check {attemptIndex + 1} of {ANSWER_FEEDBACK_LIMIT}
                                  </h4>
                                </div>
                                <p className="text-xs text-violet-700 mt-1">Cross-referenced against the task and your saved learning journey.</p>
                                <p className="text-xs text-violet-600 mt-1">This result stays linked to the answer you submitted for this check, even after later edits.</p>
                              </div>
                              <span className="mt-1 flex shrink-0 items-center gap-1.5 text-xs font-semibold text-violet-700">
                                <span className="group-open:hidden">Expand</span>
                                <span className="hidden group-open:inline">Collapse</span>
                                <svg className="h-5 w-5 transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m6 9 6 6 6-6" />
                                </svg>
                              </span>
                            </div>
                          </summary>
                          <div className="border-t border-violet-200 p-5 space-y-4">
                            <div className="rounded-xl border border-violet-200 bg-white p-4 space-y-3">
                              <p className="text-xs font-bold uppercase tracking-widest text-violet-600">Requirement coverage</p>
                              <div className={`rounded-lg border p-3 ${statusStyle(feedback.requirementCoverage.taskQuestion.status)}`}>
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <p className="text-sm font-semibold">Task question</p>
                                  <span className="text-[10px] uppercase tracking-wider font-bold">{statusLabel(feedback.requirementCoverage.taskQuestion.status)}</span>
                                </div>
                                <p className="text-sm leading-relaxed mt-1">{feedback.requirementCoverage.taskQuestion.feedback}</p>
                              </div>
                              {feedback.requirementCoverage.successCriteria.map((criterion, criterionIndex) => (
                                <div key={`${criterion.criterion}-${criterionIndex}`} className={`rounded-lg border p-3 ${statusStyle(criterion.status)}`}>
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <p className="text-sm font-semibold">Success criterion: {criterion.criterion}</p>
                                    <span className="text-[10px] uppercase tracking-wider font-bold">{statusLabel(criterion.status)}</span>
                                  </div>
                                  <p className="text-sm leading-relaxed mt-1">{criterion.evidence}</p>
                                </div>
                              ))}
                            </div>

                            <div className="space-y-4">
                              <div className="rounded-xl border border-neutral-200 bg-white p-4">
                                <p className="text-xs font-bold uppercase tracking-widest text-neutral-500">Length and format</p>
                                <div className={`mt-3 rounded-lg border p-3 ${statusStyle(feedback.expectedLengthOrFormat.status)}`}>
                                  <p className="text-sm font-semibold">{feedback.expectedLengthOrFormat.requirement || "No length or format was specified."}</p>
                                  <p className="text-sm leading-relaxed mt-1">{feedback.expectedLengthOrFormat.feedback}</p>
                                </div>
                              </div>
                              <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 space-y-3">
                                <p className="text-xs font-bold uppercase tracking-widest text-sky-700">Key vocabulary</p>
                                {feedback.keyVocabulary.length > 0 ? (
                                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                                    {feedback.keyVocabulary.map((term, termIndex) => (
                                      <div key={`${term.term}-${termIndex}`} className={`rounded-lg border p-3 ${statusStyle(term.status)}`}>
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                          <p className="text-sm font-semibold">{term.term}</p>
                                          <span className="text-[10px] uppercase tracking-wider font-bold">{statusLabel(term.status)}</span>
                                        </div>
                                        <p className="text-sm leading-relaxed mt-1">{term.feedback}</p>
                                      </div>
                                    ))}
                                  </div>
                                ) : <p className="text-sm text-sky-900">No key vocabulary was set for this task.</p>}
                              </div>
                            </div>

                            <div className="rounded-xl border border-neutral-200 bg-white p-4 space-y-3">
                              <p className="text-xs font-bold uppercase tracking-widest text-neutral-500">How your journey informed this answer</p>
                              <div className="grid gap-3 md:grid-cols-3">
                                {journeyStages.map((stage) => (
                                  <div key={stage} className={`rounded-lg border p-3 ${feedback.stageEvidence[stage].used ? "bg-emerald-50 border-emerald-200" : "bg-neutral-50 border-neutral-200"}`}>
                                    <div className="flex items-center justify-between gap-2">
                                      <p className="text-sm font-semibold text-neutral-800">{stage}</p>
                                      <span className={`text-[10px] uppercase tracking-wider font-bold ${feedback.stageEvidence[stage].used ? "text-emerald-700" : "text-neutral-500"}`}>
                                        {feedback.stageEvidence[stage].used ? "used" : "not shown"}
                                      </span>
                                    </div>
                                    <p className="text-sm text-neutral-700 leading-relaxed mt-1">{feedback.stageEvidence[stage].feedback}</p>
                                  </div>
                                ))}
                              </div>
                            </div>

                            <div className="grid gap-4 md:grid-cols-3">
                              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                                <p className="text-xs font-bold uppercase tracking-widest text-emerald-700 mb-2">Strengths</p>
                                <ul className="list-disc pl-5 space-y-1.5 text-sm text-emerald-950">
                                  {feedback.strengths.map((item, index) => <li key={index}>{item}</li>)}
                                </ul>
                              </div>
                              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                                <p className="text-xs font-bold uppercase tracking-widest text-amber-700 mb-2">Areas for development</p>
                                <ul className="list-disc pl-5 space-y-1.5 text-sm text-amber-950">
                                  {feedback.areasForDevelopment.map((item, index) => <li key={index}>{item}</li>)}
                                </ul>
                              </div>
                              <div className="rounded-xl border border-violet-200 bg-violet-100 p-4">
                                <p className="text-xs font-bold uppercase tracking-widest text-violet-700 mb-2">Next steps</p>
                                <ul className="list-disc pl-5 space-y-1.5 text-sm text-violet-950">
                                  {feedback.nextSteps.map((item, index) => <li key={index}>{item}</li>)}
                                </ul>
                              </div>
                            </div>
                          </div>
                          <div className="px-5 pb-4">
                            <p className="text-xs text-violet-500 italic">This feedback is AI-generated. Use it as a guide — your teacher's judgement takes precedence. It will not write your answer for you.</p>
                          </div>
                        </details>
                      );
                    })}
                  </div>
                )}
                <div className="border-t border-neutral-200 pt-6 space-y-4">
                  <div>
                    <h3 className="text-lg font-semibold tracking-tight">Reflect on your learning</h3>
                    <p className="text-sm text-neutral-500 mt-1">
                      Explain how your thinking developed and how you stayed in control of the final answer.
                    </p>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    {embedQuestions.map((question) => (
                      <label key={question.key} className="rounded-2xl border border-neutral-200 p-4 space-y-2">
                        <span className="block text-sm font-semibold text-neutral-800">{question.title}</span>
                        <textarea
                          value={embedAnswers[question.key]}
                          onChange={(event) => setEmbedAnswers({
                            ...embedAnswers,
                            [question.key]: event.target.value,
                          })}
                          className="w-full rounded-xl border border-neutral-200 p-3 min-h-[110px] resize-none focus:outline-none focus:ring-2 focus:ring-violet-200 text-sm"
                          placeholder="Write your reflection here..."
                          data-testid={`textarea-embed-${question.key}`}
                        />
                      </label>
                    ))}
                  </div>
                </div>
                 {/* My Notes (from TORCH) */}
                 <div className="rounded-xl bg-white border border-neutral-200 p-4 space-y-2">
                   <div className="flex items-center justify-between gap-2">
                     <p className="text-xs font-bold uppercase tracking-widest text-neutral-400">My Notes</p>
                     <button
                       onClick={() => { void handleStageNavigation("TORCH"); }}
                       className="text-[10px] text-neutral-400 hover:text-neutral-700 underline underline-offset-2 transition-colors shrink-0"
                     >
                       Edit in TORCH →
                     </button>
                   </div>
                   {mapAnswers.notes
                     ? <p className="text-xs text-neutral-700 leading-relaxed whitespace-pre-wrap">{mapAnswers.notes}</p>
                     : <p className="text-xs text-neutral-400 italic">No notes yet — add them in the TORCH stage.</p>
                   }
                 </div>
              </div>
               <div className="px-8 pb-8">
                {/* RESEARCH */}
                 {researchEntries.some((e) => e.combinedLearning || e.importantPoints || e.findings) && (
                   <div className="rounded-xl bg-neutral-50 border border-neutral-200 p-5 space-y-3">
                    <p className="text-xs font-bold uppercase tracking-widest text-neutral-400">RESEARCH — Key findings</p>
                     {researchEntries.filter((e) => e.combinedLearning || e.importantPoints || e.findings).map((e, i) => (
                      <div key={e.id}>
                        {e.actualSource && <p className="text-xs font-medium text-neutral-500 mb-0.5">Source {i + 1}: {e.actualSource}</p>}
                         <p className="text-xs text-neutral-700 leading-relaxed">
                           {e.combinedLearning || e.importantPoints || e.findings}
                         </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <StageCompletionFooter stage="EMBED" />
            <TeacherFeedbackBanner stage="EMBED" feedback={studentFeedback["EMBED"]} onAcknowledge={() => { void acknowledgeFeedback("EMBED"); }} isAcknowledging={acknowledgingFeedbackStage === "EMBED"} readOnly={isReadOnly} />
          </section>
        )}

      </main>

      <AlertDialog open={!!stageToReset} onOpenChange={(open) => { if (!open) setStageToReset(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset {stageToReset} stage?</AlertDialogTitle>
            <AlertDialogDescription>
              This will clear all saved content for the {stageToReset} stage. You can fill it in again from scratch. Other stages won't be affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isResetting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleResetStage}
              disabled={isResetting}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
              data-testid="button-confirm-reset-stage"
            >
              {isResetting ? "Clearing…" : "Clear Stage"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Task detail modal */}
      {showTaskModal && task && (
        <div
          className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-6 bg-black/40 backdrop-blur-sm"
          onClick={() => setShowTaskModal(false)}
        >
          <div
            className="bg-white rounded-t-[2rem] sm:rounded-[2rem] shadow-2xl w-full max-w-2xl max-h-[90dvh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-8 pt-8 pb-4 shrink-0">
              <p className="text-xs font-bold uppercase tracking-widest text-neutral-400">Your Task</p>
              <button
                onClick={() => setShowTaskModal(false)}
                className="text-neutral-400 hover:text-neutral-700 transition-colors text-xl leading-none"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            {/* Scrollable body */}
            <div className="overflow-y-auto px-8 pb-8 space-y-6">
              {/* Title + question */}
              <div className="space-y-2">
                <h2 className="text-2xl font-semibold text-neutral-900 leading-snug">{task.title}</h2>
                {task.question && (
                  <p className="text-neutral-600 leading-relaxed">{task.question}</p>
                )}
                {task.dueDate && (
                  <p className="text-sm text-neutral-400">
                    Due: <span className="font-medium text-neutral-700">{new Date(task.dueDate).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</span>
                  </p>
                )}
              </div>

              {/* Success criteria */}
              {((task.successCriteria as string[] | undefined) ?? []).length > 0 && (
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-neutral-400 mb-3">Success Criteria</p>
                  <ul className="space-y-2">
                    {(task.successCriteria as string[]).map((c: string, i: number) => (
                      <li key={i} className="flex items-start gap-3">
                        <span className="mt-0.5 w-5 h-5 rounded-full border-2 border-neutral-300 shrink-0" />
                        <span className="text-sm text-neutral-700 leading-relaxed">{c}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Key vocabulary */}
              {((task.keyVocabulary as string[] | undefined) ?? []).length > 0 && (
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-neutral-400 mb-3">Key Vocabulary</p>
                  <div className="flex flex-wrap gap-2">
                    {(task.keyVocabulary as string[]).map((w: string, i: number) => (
                      <span key={i} className="px-3 py-1 rounded-full bg-sky-50 border border-sky-200 text-sm font-medium text-sky-800">{w}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Expected length */}
              {task.expectedLength && (
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-neutral-400 mb-1.5">Expected Length</p>
                  <p className="text-sm text-neutral-700">{task.expectedLength}</p>
                </div>
              )}

              {/* Bloom's levels */}
              {(task.learningFramework ?? "bloom") === "bloom" && ((task.bloomLevels as string[] | undefined) ?? []).length > 0 && (
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-neutral-400 mb-3">Thinking Levels</p>
                  <div className="flex flex-wrap gap-2">
                    {(task.bloomLevels as string[]).map((l: string, i: number) => (
                      <span key={i} className="px-3 py-1 rounded-full bg-violet-50 border border-violet-200 text-sm font-medium text-violet-800">{l}</span>
                    ))}
                  </div>
                </div>
              )}

              {task.learningFramework === "knowledge_dimensions" && ((task.knowledgeDimensions as string[] | undefined) ?? []).length > 0 && (
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-neutral-400 mb-3">Knowledge Dimension</p>
                  <div className="flex flex-wrap gap-2">
                    {(task.knowledgeDimensions as string[]).map((dimension: string) => (
                      <span key={dimension} className="px-3 py-1 rounded-full bg-sky-50 border border-sky-200 text-sm font-medium text-sky-800">{dimension}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Active stages */}
              {((task.enabledStages as string[] | undefined) ?? []).length > 0 && (
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-neutral-400 mb-3">Active Stages</p>
                  <div className="flex flex-wrap gap-2">
                    {(["MAP", "TORCH", "COMPASS", "EMBED", "RESEARCH"] as const).map((s) => {
                      const active = (task.enabledStages as string[]).includes(s);
                      return (
                        <span key={s} className={`px-3 py-1 rounded-full border text-sm font-medium ${active ? `${STAGE_COLORS[s]} opacity-100` : "bg-neutral-100 border-neutral-200 text-neutral-400 line-through"}`}>
                          {STAGE_DISPLAY[s]}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Stage instructions */}
              {(() => {
                const si = task.stageInstructions as { map?: string; torch?: string; compass?: string; embed?: string } | undefined;
                const entries = [
                  { key: "map", label: "MAP" }, { key: "torch", label: "TORCH" },
                  { key: "compass", label: "COMPASS" }, { key: "embed", label: "Final Answer" },
                ].filter(({ key }) => si?.[key as keyof typeof si]?.trim());
                if (!entries.length) return null;
                return (
                  <div>
                    <p className="text-xs font-bold uppercase tracking-widest text-neutral-400 mb-3">Stage Instructions</p>
                    <div className="space-y-3">
                      {entries.map(({ key, label }) => (
                        <div key={key} className="rounded-xl bg-neutral-50 border border-neutral-200 px-4 py-3">
                          <p className="text-xs font-bold uppercase tracking-wider text-neutral-400 mb-1">{label}</p>
                          <p className="text-sm text-neutral-700 leading-relaxed whitespace-pre-wrap">{si![key as keyof typeof si]}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* Resources */}
              {((task.resources as string[] | undefined) ?? []).length > 0 && (
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-neutral-400 mb-3">Resources</p>
                  <ul className="space-y-1.5">
                    {(task.resources as string[]).map((r: string, i: number) => (
                      <li key={i}>
                        {r.startsWith("http") ? (
                          <a href={r} target="_blank" rel="noopener noreferrer" className="text-sm text-sky-600 hover:underline break-all">{r}</a>
                        ) : (
                          <span className="text-sm text-neutral-700">{r}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Student-facing guidance notes */}
              {task.notes && (
                <div className="rounded-xl bg-neutral-50 border border-neutral-200 px-5 py-4">
                  <p className="text-xs font-semibold text-neutral-400 uppercase tracking-widest mb-1.5">Guidance Notes</p>
                  <p className="text-sm text-neutral-600 leading-relaxed whitespace-pre-wrap">{task.notes}</p>
                </div>
              )}

              <button
                onClick={() => setShowTaskModal(false)}
                className="w-full rounded-2xl bg-neutral-900 text-white py-2.5 text-sm font-semibold hover:bg-neutral-700 transition-colors"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Change PIN modal */}
      {showPinModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-white rounded-[2rem] p-8 shadow-xl space-y-6">
            <div className="text-center">
              <h2 className="text-xl font-semibold tracking-tight">Change your PIN</h2>
              <p className="text-sm text-neutral-500 mt-1">Your PIN must be exactly 6 digits.</p>
            </div>
            {pinSuccess ? (
              <div className="text-center space-y-4">
                <p className="text-sm text-emerald-600 font-medium">✓ PIN updated successfully.</p>
                <button
                  onClick={() => { setShowPinModal(false); setPinSuccess(false); }}
                  className="w-full rounded-2xl bg-black text-white py-3 text-sm font-medium hover:opacity-90 transition-opacity"
                >
                  Done
                </button>
              </div>
            ) : (
              <form onSubmit={handleChangePin} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-2">Current PIN</label>
                  <input
                    required
                    type="password"
                    inputMode="numeric"
                    maxLength={6}
                    value={pinForm.current}
                    onChange={(e) => setPinForm({ ...pinForm, current: e.target.value.replace(/\D/g, "") })}
                    className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10 tracking-widest text-center"
                    placeholder="······"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">New PIN</label>
                  <input
                    required
                    type="password"
                    inputMode="numeric"
                    maxLength={6}
                    value={pinForm.next}
                    onChange={(e) => setPinForm({ ...pinForm, next: e.target.value.replace(/\D/g, "") })}
                    className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10 tracking-widest text-center"
                    placeholder="······"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">Confirm new PIN</label>
                  <input
                    required
                    type="password"
                    inputMode="numeric"
                    maxLength={6}
                    value={pinForm.confirm}
                    onChange={(e) => setPinForm({ ...pinForm, confirm: e.target.value.replace(/\D/g, "") })}
                    className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10 tracking-widest text-center"
                    placeholder="······"
                  />
                </div>
                {pinError && <p className="text-sm text-red-500 text-center">{pinError}</p>}
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => { setShowPinModal(false); setPinForm({ current: "", next: "", confirm: "" }); setPinError(""); }}
                    className="flex-1 rounded-2xl border border-neutral-300 py-3 text-sm font-medium hover:bg-neutral-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={pinLoading || pinForm.current.length !== 6 || pinForm.next.length !== 6 || pinForm.confirm.length !== 6}
                    className="flex-1 rounded-2xl bg-black text-white py-3 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {pinLoading ? "Saving…" : "Update PIN"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
      {showActivity && (
      <div className="fixed inset-0 z-[70] bg-black/40 p-4 flex items-center justify-center" role="dialog" aria-modal="true" aria-labelledby="activity-title">
          <div className="w-full max-w-2xl max-h-[90dvh] overflow-y-auto rounded-[2rem] bg-white p-6 shadow-xl" data-student-export="activity">
            <div className="flex items-start justify-between gap-4 mb-6">
              <div>
                <h2 id="activity-title" className="text-2xl font-semibold">My activity</h2>
                <p className="text-sm text-neutral-500">Time is recorded while you interact with your Climb and pauses after 2 minutes without activity. It may not include time spent working elsewhere.</p>
                <div className="mt-4 flex flex-wrap gap-2" data-export-controls>
                  <button onClick={() => void downloadActivityPdf()} className="rounded-xl border border-neutral-300 bg-white px-3 py-2 text-xs font-semibold hover:bg-neutral-50">Download PDF</button>
                  <button onClick={downloadActivityCsv} className="rounded-xl border border-neutral-300 bg-white px-3 py-2 text-xs font-semibold hover:bg-neutral-50">Download CSV</button>
                </div>
              </div>
              <button onClick={() => setShowActivity(false)} className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-100" aria-label="Close activity">×</button>
            </div>
            {activityLoading ? <p className="text-sm text-neutral-500">Loading activity…</p> : activityError ? <p className="text-sm text-red-600">{activityError}</p> : (
              <div id="student-activity-print">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
                  <InfoCard title="Login sessions" text={activity?.summary?.loginSessionsAvailable ? (activity.summary.loginSessionCount ? String(activity.summary.loginSessionCount) : "None recorded") : "Not available"} />
                  <InfoCard title="Total active time" text={activity?.summary?.totalSeconds ? formatActivityDuration(activity.summary.totalSeconds) : "None recorded"} />
                  <InfoCard title="Average session time" text={activity?.summary?.loginSessionsAvailable ? (activity.summary.averageLoginSessionSeconds ? formatActivityDuration(activity.summary.averageLoginSessionSeconds) : "None recorded") : "Not available"} />
                </div>
                <section aria-labelledby="activity-stage-breakdown-title">
                  <h3 id="activity-stage-breakdown-title" className="text-lg font-semibold">Time spent in each part of your Climb</h3>
                  <div className="mt-4 space-y-3">
                    {ACTIVITY_STAGE_ROWS.map(({ label, stage }) => {
                      const seconds = activityStageSeconds(activity, stage);
                      const totalSeconds = activity?.summary?.totalSeconds ?? 0;
                      const proportion = totalSeconds > 0 ? Math.min(100, (seconds / totalSeconds) * 100) : 0;
                      return (
                        <div key={label} className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
                          <div className="flex items-center justify-between gap-4 text-sm">
                            <span className="font-medium text-neutral-800">{label}</span>
                            <span className="text-neutral-600">{seconds > 0 ? formatActivityDuration(seconds) : "None recorded"}</span>
                          </div>
                          <div className="mt-3 h-2 rounded-full bg-neutral-200" aria-hidden="true">
                            <div className="h-2 rounded-full bg-neutral-700" style={{ width: `${proportion}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <p className="mt-4 text-sm leading-relaxed text-neutral-500">
                    Recorded time shows where you interacted with your Climb. It does not measure the quality of your work.
                  </p>
                </section>
              </div>
            )}
          </div>
        </div>
      )}
      {completionWarningStage && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="completion-warning-title">
          <div className="w-full max-w-lg rounded-[2rem] bg-white p-6 shadow-xl">
            <h2 id="completion-warning-title" className="text-xl font-semibold">Sections missing</h2>
            <p className="mt-3 text-sm leading-6 text-neutral-600">
              You are marking this stage as complete, but the following sections do not yet have a response:
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-neutral-800">
              {missingSectionsForStage(completionWarningStage).map((section) => <li key={section}>{section}</li>)}
            </ul>
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" onClick={() => setCompletionWarningStage(null)} className="rounded-2xl border border-neutral-300 px-4 py-2.5 text-sm font-semibold hover:bg-neutral-50">
                Go back and complete them
              </button>
              <button type="button" onClick={() => void persistStageCompletion(completionWarningStage, true, true)} className="rounded-2xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700">
                Mark as complete anyway
              </button>
            </div>
          </div>
        </div>
      )}
      {showTeacherMessages && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="teacher-messages-title"
          onClick={() => setShowTeacherMessages(false)}
        >
          <div className="w-full max-w-lg max-h-[85dvh] overflow-y-auto rounded-[2rem] bg-white p-6 shadow-xl" onClick={(event) => event.stopPropagation()} data-student-export="messages">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="teacher-messages-title" className="text-2xl font-semibold">Messages</h2>
                <p className="mt-1 text-sm text-neutral-500">Messages for this Climb.</p>
                <div className="mt-4 flex flex-wrap gap-2" data-export-controls>
                  <button onClick={() => void downloadMessagesPdf()} className="rounded-xl border border-neutral-300 bg-white px-3 py-2 text-xs font-semibold hover:bg-neutral-50">Download PDF</button>
                  <button onClick={downloadMessagesCsv} className="rounded-xl border border-neutral-300 bg-white px-3 py-2 text-xs font-semibold hover:bg-neutral-50">Download CSV</button>
                </div>
              </div>
              <button onClick={() => setShowTeacherMessages(false)} className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-100" aria-label="Close messages">×</button>
            </div>
            {teacherMessagesError ? (
                    <p className="mt-6 text-sm text-red-600" role="alert">{teacherMessagesError}</p>
            ) : teacherMessages.length === 0 ? (
              <p className="mt-8 rounded-xl bg-neutral-50 p-5 text-center text-sm text-neutral-500">None recorded.</p>
            ) : (
              <div className="mt-6 space-y-3">
                {teacherMessages.map((message: any) => (
                  <article key={message.id} className={`rounded-xl border p-4 ${message.senderType === "student" ? "ml-8 border-sky-100 bg-sky-50" : "mr-8 border-neutral-200 bg-neutral-50"}`}>
                    <p className="text-xs font-semibold text-neutral-500">{message.senderType === "student" ? "You" : "Your teacher"}</p>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-800">{message.content}</p>
                    <time className="mt-3 block text-xs text-neutral-500" dateTime={message.createdAt}>
                      {new Date(message.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
                    </time>
                  </article>
                ))}
              </div>
            )}
            <form className="mt-5" onSubmit={sendTeacherMessage}>
              <label htmlFor="student-teacher-message-content" className="block text-sm font-medium text-neutral-700">Reply</label>
              <textarea
                id="student-teacher-message-content"
                value={teacherMessageDraft}
                onChange={(event) => setTeacherMessageDraft(event.target.value)}
                maxLength={500}
                disabled={isReadOnly || teacherMessageSending}
                className="mt-2 min-h-24 w-full resize-y rounded-xl border border-neutral-300 px-3 py-2.5 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 disabled:bg-neutral-100"
              />
              <div className="mt-1 flex justify-between text-xs text-neutral-500">
                <span>{isReadOnly ? readOnlyMessage : ""}</span>
                <span>{teacherMessageDraft.length}/500</span>
              </div>
              <button type="submit" disabled={isReadOnly || teacherMessageSending || !teacherMessageDraft.trim()} className="mt-3 w-full rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
                {teacherMessageSending ? "Sending…" : "Send"}
              </button>
            </form>
            <button onClick={() => setShowTeacherMessages(false)} className="mt-6 w-full rounded-xl bg-neutral-900 py-2.5 text-sm font-semibold text-white hover:bg-neutral-700">Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

function InfoCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-medium mb-2">{title}</p>
      <p className="text-sm text-neutral-600 leading-relaxed">{text}</p>
    </div>
  );
}

function sourceTypeForHandoff(sourceType: string): SourceType | "" {
  const trimmed = sourceType.trim();
  if (!trimmed) return "";
  if (SOURCE_TYPE_OPTIONS.includes(trimmed as SourceType)) return trimmed as SourceType;
  return SOURCE_TYPE_ALIASES[trimmed] ?? "";
}

const SOURCE_DETAILS_GUIDANCE: Record<SourceType, string> = {
  Website: "Include the title, author or organisation, publisher, date, and URL.",
  Book: "Include the title, author, and ISBN where available.",
  Article: "Include the title, author, journal or publisher, date, and URL or DOI.",
  Video: "Include the title, creator, platform, and URL.",
  Data: "Include the dataset title, publisher or organisation, date, and URL or catalogue reference.",
  "Expert or interview": "Include the expert or interviewee, their role, date, and notes on how the information was gathered.",
  Survey: "Include the survey title, organiser, date, participants or sample, and a link or reference where available.",
  Teacher: "Include the teacher’s name or role, date, and the guidance or resource reference.",
  AI: "Include the tool name, date, and a permitted conversation link or reference only. Do not include private conversation contents or credentials.",
  Other: "Include the details someone else would need to identify or find this source.",
};

type SourceType = (typeof SOURCE_TYPE_OPTIONS)[number];

const SOURCE_TYPE_ALIASES: Record<string, SourceType> = {
  Books: "Book",
  "Reliable websites": "Website",
  "Academic article": "Article",
  "Academic articles": "Article",
  Interview: "Expert or interview",
  Experts: "Expert or interview",
  "Surveys / Interviews": "Survey",
  "Teacher guidance": "Teacher",
  "AI / LLM": "AI",
  "AI tool": "AI",
  "AI tools": "AI",
};
