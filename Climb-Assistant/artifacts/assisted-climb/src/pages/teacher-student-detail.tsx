import { useState, useEffect, useCallback, useRef, useLayoutEffect } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { apiFetch, apiFetchBlob, downloadBlob } from "@/lib/api";
import { registerBeforeLogout } from "@/lib/session-lifecycle";
import { useToast } from "@/hooks/use-toast";
import { classifyMessages, classifyQuestion, QUESTION_TYPE_META, QUESTION_TYPES } from "@/lib/question-classifier";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { LinkifiedText } from "@/components/LinkifiedText";
import { SafeFormattedText } from "@/components/SafeFormattedText";
import { answerReadableText, answerVisibleText } from "@/lib/final-answer-format";
import { normaliseSupportingMaterialCards } from "@/lib/supporting-materials";

function csvCell(value: unknown) {
  const rawValue = String(value ?? "");
  // Keep all student-controlled cells as text, including tab/space-prefixed
  // values that spreadsheet applications may otherwise treat as formulas.
  const safeValue = `'${rawValue}`;
  return `"${safeValue.replace(/"/g, '""')}"`;
}

function supportingMaterialRows(content: any): Array<unknown[]> {
  const cards = normaliseSupportingMaterialCards(content?.supportingMaterialCards);
  return [
    ["Legacy supporting materials", content?.supportingMaterials ?? ""],
    ...cards.flatMap((card, index) => [
      [`Supporting material ${index + 1} — Name of the material`, card.name],
      [`Supporting material ${index + 1} — Type of material`, card.type],
      [`Supporting material ${index + 1} — What does it show?`, card.whatItShows],
      [`Supporting material ${index + 1} — Why is it relevant to the answer?`, card.whyRelevant],
      [`Supporting material ${index + 1} — Where is it referred to in the Final Answer?`, card.finalResponseReference],
      [`Supporting material ${index + 1} — How was it shared with the teacher?`, card.sharingMethod],
    ]),
  ];
}

function downloadCsv(rows: Array<unknown[]>, filename: string) {
  const csv = rows.map((row) => row.map((value) => csvCell(Array.isArray(value) ? value.join("; ") : typeof value === "object" ? JSON.stringify(value) : value)).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadTeacherMessagesCsv(messages: Array<{ senderType: string; createdAt: string; content: string }>) {
  const csvCell = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const rows = [
    ["Sender", "Date/time", "Content"],
    ...messages.map((message) => [
      message.senderType === "teacher" ? "Teacher" : "Student",
      new Date(message.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }),
      message.content,
    ]),
  ];
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "student-messages.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function researchSourceText(entry: any): string {
  if (typeof entry?.actualSource === "string" && entry.actualSource.trim()) return entry.actualSource;
  if (typeof entry?.source === "string" && entry.source.trim()) return entry.source;
  if (typeof entry?.title === "string" && entry.title.trim()) return entry.title;
  if (typeof entry?.url === "string" && entry.url.trim()) return entry.url;
  return "";
}

function researchSourceType(entry: any): string {
  const raw = typeof entry?.sourceType === "string" ? entry.sourceType.trim() : "";
  if (!raw) return "Type not specified";
  const aliases: Record<string, string> = {
    "Academic article": "Article",
    "Academic articles": "Article",
    "Teacher guidance": "Teacher",
    "AI / LLM": "AI",
    "AI tool": "AI",
    "AI tools": "AI",
    Books: "Book",
    "Reliable websites": "Website",
    Interview: "Expert or interview",
    Experts: "Expert or interview",
    "Surveys / Interviews": "Survey",
  };
  return aliases[raw] ?? raw;
}

function researchSourceDetails(entry: any): string {
  if (typeof entry?.sourceDetails === "string" && entry.sourceDetails.trim()) return entry.sourceDetails;
  return typeof entry?.citation === "string" ? entry.citation : "";
}

function researchSourceOrigin(entry: any): string {
  if (entry?.sourceOrigin === "plan" || entry?.mapContext) return "From my Research Plan";
  if (entry?.sourceOrigin === "teacher" || entry?.sourceProvenance?.type === "teacher") return "Teacher-provided source";
  if (entry?.sourceOrigin === "during-research") return "Added during research";
  return "Origin not recorded";
}

function researchAddedAt(entry: any): string {
  return typeof entry?.addedAt === "string" ? entry.addedAt : "";
}

function researchLearningText(entry: any): string {
  if (typeof entry?.combinedLearning === "string" && entry.combinedLearning.trim()) {
    return entry.combinedLearning;
  }
  const findings = typeof entry?.findings === "string" ? entry.findings.trim() : "";
  const importantPoints = typeof entry?.importantPoints === "string" ? entry.importantPoints.trim() : "";
  if (!findings) return importantPoints;
  if (!importantPoints || findings === importantPoints) return findings;
  return `${findings}\n\n${importantPoints}`;
}

async function downloadSectionPdf(sectionId: string, title: string, filename: string) {
  const section = document.getElementById(sectionId);
  if (!section) return;
  const content = section.cloneNode(true) as HTMLElement;
  content.querySelectorAll("button, form, [data-export-controls]").forEach((element) => element.remove());
  content.querySelectorAll(".report-collapsible-content").forEach((element) => element.classList.remove("hidden"));
  const text = `${title}\n\n${(content.innerText || content.textContent || "").replace(/\n{3,}/g, "\n\n").trim()}`.trim();
  if (!text) return;
  const blob = await apiFetchBlob("/teacher/export/pdf", {
    method: "POST",
    body: JSON.stringify({ title, text }),
  });
  downloadBlob(blob, filename);
}

const exportDetails: Record<string, { title: string; filename: string; pdfFilename: string }> = {
  OVERVIEW: { title: "Overview", filename: "assisted-climb-overview.csv", pdfFilename: "assisted-climb-overview.pdf" },
  MAP: { title: "Map", filename: "assisted-climb-map.csv", pdfFilename: "assisted-climb-map.pdf" },
  TORCH: { title: "Torch", filename: "assisted-climb-torch.csv", pdfFilename: "assisted-climb-torch.pdf" },
  COMPASS: { title: "Compass", filename: "assisted-climb-compass.csv", pdfFilename: "assisted-climb-compass.pdf" },
  EMBED: { title: "Final Answer", filename: "assisted-climb-final-answer.csv", pdfFilename: "assisted-climb-final-answer.pdf" },
  RESEARCH: { title: "Research Log", filename: "assisted-climb-research-log.csv", pdfFilename: "assisted-climb-research-log.pdf" },
};

const RESEARCH_ACTIVITY_STAGES = ["MAP", "TORCH", "RESEARCH", "COMPASS", "EMBED"] as const;
const RESEARCH_STAGE_LABEL: Record<(typeof RESEARCH_ACTIVITY_STAGES)[number], string> = {
  MAP: "Map",
  TORCH: "Torch",
  RESEARCH: "Research Log",
  COMPASS: "Compass",
  EMBED: "Final Answer",
};

const JOURNEY_STAGE_CARD: Record<string, string> = {
  MAP: "border-neutral-200 bg-neutral-50",
  TORCH: "border-amber-200 bg-amber-50",
  RESEARCH: "border-sky-200 bg-sky-50",
  COMPASS: "border-emerald-200 bg-emerald-50",
  EMBED: "border-violet-200 bg-violet-50",
};

const JOURNEY_STAGE_LABEL: Record<string, string> = {
  MAP: "text-neutral-600",
  TORCH: "text-amber-700",
  RESEARCH: "text-sky-700",
  COMPASS: "text-emerald-700",
  EMBED: "text-violet-700",
};

function formatResearchTimestamp(value: unknown) {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function formatResearchDuration(value: unknown) {
  const totalSeconds = Math.max(0, Math.round(Number(value) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const readable = [
    hours ? `${hours}h` : "",
    minutes ? `${minutes}m` : "",
    seconds || (!hours && !minutes) ? `${seconds}s` : "",
  ].filter(Boolean).join(" ");
  return readable;
}

function formatInsightDuration(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Not available";
  const minutes = Math.round(Math.max(0, value) / 60);
  if (minutes < 1) return "0 minutes";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes
    ? `${hours} hour${hours === 1 ? "" : "s"} ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}`
    : `${hours} hour${hours === 1 ? "" : "s"}`;
}

function formatInsightDate(value: unknown) {
  if (!value) return "Not available";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime())
    ? "Not available"
    : date.toLocaleDateString("en-GB", { dateStyle: "long" });
}

function studentInsightStatusLabel(value: unknown) {
  return ({
    acted_upon: "Addressed",
    partly_acted_upon: "Partly addressed",
    no_related_change: "No related change found",
    not_enough_evidence: "Not enough evidence",
    teacher_review_needed: "Teacher review needed",
    no_action_requested: "No action requested",
  } as Record<string, string>)[String(value)] ?? "Not enough evidence";
}

function studentInsightLearningEvidenceLabel(value: unknown) {
  return ({
    demonstrated: "Demonstrated",
    partly_demonstrated: "Partly demonstrated",
    not_demonstrated: "Not demonstrated in recorded evidence",
    not_assessable: "Not assessable from recorded evidence",
  } as Record<string, string>)[String(value)] ?? "Not assessable from recorded evidence";
}

function extractStudentInsights(detail: any): Record<"formative" | "summative", any> {
  const saved = detail?.studentInsights ?? detail?.developmentAnalysis?.studentInsights ?? {};
  return {
    formative: saved.formative ?? null,
    summative: saved.summative ?? null,
  };
}

const HISTORICAL_PROVENANCE_UNAVAILABLE = "Provenance information not available for this previously generated Insight.";

function hasRecordedInsightProvenance(insight: any) {
  return Boolean(insight?.provenance && typeof insight.provenance === "object" && Object.keys(insight.provenance).length > 0);
}

function AutoTextarea({ value, onChange, placeholder, className, id, disabled, "data-testid": testId }: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  className?: string;
  id?: string;
  disabled?: boolean;
  "data-testid"?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      id={id}
      data-testid={testId}
      rows={1}
      value={value}
      onChange={onChange}
      disabled={disabled}
      placeholder={placeholder}
      className={className}
      style={{ overflow: "hidden" }}
    />
  );
}

const GRADES = ["emerging", "developing", "secure", "exceeding"] as const;
type Grade = (typeof GRADES)[number];
const GRADE_LABEL: Record<Grade, string> = {
  emerging: "Emerging",
  developing: "Developing",
  secure: "Secure",
  exceeding: "Exceeding",
};
const GRADE_COLOR: Record<Grade, string> = {
  emerging: "bg-red-100 text-red-700 border-red-200",
  developing: "bg-amber-100 text-amber-700 border-amber-200",
  secure: "bg-sky-100 text-sky-700 border-sky-200",
  exceeding: "bg-emerald-100 text-emerald-700 border-emerald-200",
};
const GRADE_COLOR_ACTIVE: Record<Grade, string> = {
  emerging: "bg-red-500 text-white border-red-500 ring-2 ring-red-400 ring-offset-2 shadow-md",
  developing: "bg-amber-500 text-white border-amber-500 ring-2 ring-amber-400 ring-offset-2 shadow-md",
  secure: "bg-sky-500 text-white border-sky-500 ring-2 ring-sky-400 ring-offset-2 shadow-md",
  exceeding: "bg-emerald-500 text-white border-emerald-500 ring-2 ring-emerald-400 ring-offset-2 shadow-md",
};
const GRADE_SELECTED_LABEL: Record<Grade, string> = {
  emerging: "text-red-600",
  developing: "text-amber-600",
  secure: "text-sky-600",
  exceeding: "text-emerald-600",
};
const SUMMATIVE_FEEDBACK_STAGES = ["MAP", "TORCH", "COMPASS", "RESEARCH", "EMBED"] as const;

type FeedbackSaveState = "idle" | "saving" | "saved" | "error";
type FeedbackVisibility = { formative: boolean; summative: boolean };

function feedbackVisibilityKey(classId?: string, sessionId?: string) {
  return classId && sessionId ? `teacher-feedback-visibility:${classId}:${sessionId}` : null;
}

function readFeedbackVisibility(classId?: string, sessionId?: string): FeedbackVisibility {
  const key = feedbackVisibilityKey(classId, sessionId);
  if (!key || typeof window === "undefined") return { formative: false, summative: false };
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(key) ?? "{}");
    return {
      formative: stored.formative === true,
      summative: stored.summative === true,
    };
  } catch {
    return { formative: false, summative: false };
  }
}

function StageFeedbackPanel({
  stage,
  feedback,
  onUpdate,
  onRetry,
  showFormative,
  showSummative,
  readOnly,
  saveState = "idle",
}: {
  stage: string;
  feedback: { grade: Grade | null; comment: string; formativeComment: string; studentAcknowledged?: boolean } | undefined;
  onUpdate: (patch: Partial<{ grade: Grade | null; comment: string; formativeComment: string }>) => void;
  onRetry: () => void;
  showFormative: boolean;
  showSummative: boolean;
  readOnly: boolean;
  saveState?: FeedbackSaveState;
}) {
  const current = feedback ?? { grade: null, comment: "", formativeComment: "" };
  if (!showFormative && !showSummative) return null;
  return (
    <div className="border-t border-neutral-200 bg-neutral-50 px-8 py-6 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs uppercase tracking-[0.2em] font-semibold text-neutral-400">Teacher Feedback — {stage}</p>
        {saveState !== "idle" && (
          <div className="flex items-center gap-2">
            <span
              data-testid={`feedback-save-status-${stage}`}
              className={`text-xs font-medium ${
                saveState === "error"
                  ? "text-red-600"
                  : saveState === "saved"
                    ? "text-emerald-600"
                    : "text-neutral-500"
              }`}
            >
              {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : "Couldn’t save"}
            </span>
            {saveState === "error" && !readOnly && (
              <button
                type="button"
                onClick={onRetry}
                className="rounded-lg border border-red-200 bg-white px-2.5 py-1 text-xs font-semibold text-red-700 hover:border-red-400 hover:bg-red-50 transition-colors"
                data-testid={`button-retry-feedback-${stage}`}
              >
                Retry {stage} save
              </button>
            )}
          </div>
        )}
      </div>

      {showFormative && <div>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <label htmlFor={`feedback-${stage}-formative`} className="block text-xs font-semibold text-neutral-600">Formative Feedback</label>
          {current.formativeComment.trim() && current.studentAcknowledged && (
            <span className="text-xs font-medium text-emerald-700">Student marked as actioned ✓</span>
          )}
        </div>
        <p className="text-[11px] text-neutral-400 mb-2">In-progress observations — visible to the student immediately. Address them directly: "You…" not their name.</p>
        <AutoTextarea
          id={`feedback-${stage}-formative`}
          data-testid={`textarea-formative-${stage}`}
          className="w-full rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-neutral-300 placeholder:text-neutral-400"
          placeholder="e.g. You're asking great questions — now push yourself to evaluate the sources…"
          value={current.formativeComment}
          onChange={(e) => onUpdate({ formativeComment: e.target.value })}
          disabled={readOnly}
        />
      </div>}

      {showSummative && <div className={`${showFormative ? "border-t border-neutral-100 pt-4 " : ""}space-y-3`}>
        <label htmlFor={`feedback-${stage}-summative`} className="block text-xs font-semibold text-neutral-600">Summative Feedback</label>
        <p className="text-[11px] text-neutral-400">Final assessment — set an attainment level and write a comment. Address them directly: "You…" not their name.</p>
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-[11px] uppercase tracking-widest text-neutral-400">Attainment Level</p>
            {current.grade ? (
              <p className={`text-xs font-semibold ${GRADE_SELECTED_LABEL[current.grade]}`}>
                ✓ {GRADE_LABEL[current.grade]} selected
              </p>
            ) : (
              <p className="text-xs text-neutral-400 italic">None selected</p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {GRADES.map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => onUpdate({ grade: current.grade === g ? null : g })}
                disabled={readOnly}
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-semibold border transition-all disabled:cursor-not-allowed disabled:opacity-60 ${
                  current.grade === g
                    ? GRADE_COLOR_ACTIVE[g]
                    : `${GRADE_COLOR[g]} opacity-50 hover:opacity-100`
                }`}
              >
                {current.grade === g && <span className="text-base leading-none">✓</span>}
                {GRADE_LABEL[g]}
              </button>
            ))}
          </div>
        </div>
        <AutoTextarea
          id={`feedback-${stage}-summative`}
          data-testid={`textarea-summative-${stage}`}
          className="w-full rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-neutral-300 placeholder:text-neutral-400"
          placeholder="e.g. You showed strong analytical thinking here — now push further by…"
          value={current.comment}
          onChange={(e) => onUpdate({ comment: e.target.value })}
          disabled={readOnly}
        />
      </div>}
      {readOnly && <p className="text-xs font-medium text-violet-700">Assessment locked — feedback is read-only.</p>}
    </div>
  );
}

function answerFeedbackStatusStyle(status: string) {
  if (status === "met" || status === "used" || status === "meets") {
    return "bg-emerald-50 border-emerald-200 text-emerald-800";
  }
  if (status === "missing") {
    return "bg-amber-50 border-amber-200 text-amber-800";
  }
  return "bg-sky-50 border-sky-200 text-sky-800";
}

function TeacherAnswerFeedback({ attempts }: { attempts: any[] }) {
  if (attempts.length === 0) return null;

  return (
    <section
      className="rounded-[2rem] border border-violet-200 bg-violet-50 shadow-sm overflow-hidden"
      data-testid="teacher-answer-feedback"
      aria-labelledby="teacher-answer-feedback-heading"
    >
      <div className="border-b border-violet-200 bg-violet-100/60 px-8 py-6">
        <p className="text-xs uppercase tracking-[0.2em] text-violet-600 mb-2">Student AI guidance</p>
        <h2 id="teacher-answer-feedback-heading" className="text-2xl font-semibold tracking-tight text-violet-950">
          Final-answer checks
        </h2>
        <p className="text-sm text-violet-800 mt-2">
          Read-only copies of the feedback the student requested for their final answer. This does not change the teacher assessment.
        </p>
      </div>

      <div className="p-8 space-y-6">
        {attempts.map((attempt, attemptIndex) => {
          const feedback = attempt.feedback;
          const statusLabel = (status: string) => status.replace("_", " ");
          const journeyStages = ["MAP", "TORCH", "COMPASS"] as const;
          return (
            <details
              key={`${attempt.createdAt}-${attemptIndex}`}
              className="group rounded-2xl border border-violet-200 bg-white overflow-hidden"
              data-testid={`teacher-answer-feedback-attempt-${attemptIndex + 1}`}
            >
              <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
                <div>
                  <h3 className="text-sm font-semibold text-violet-950">Answer check {attemptIndex + 1} of {attempts.length}</h3>
                  <p className="text-xs text-violet-700 mt-1">
                    {new Date(attempt.createdAt).toLocaleDateString("en-GB")}
                  </p>
                </div>
                <span className="flex items-center gap-2 text-xs font-semibold text-violet-700">
                  <span>Review feedback</span>
                  <svg className="h-4 w-4 transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m6 9 6 6 6-6" />
                  </svg>
                </span>
              </summary>

              <div className="border-t border-violet-200 p-5 space-y-5">
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-neutral-500 mb-2">Answer checked</p>
                  <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4 text-sm leading-relaxed whitespace-pre-wrap">
                    {attempt.answerSnapshot}
                  </div>
                </div>

                <div className="rounded-xl border border-violet-200 p-4 space-y-3">
                  <p className="text-xs font-bold uppercase tracking-widest text-violet-700">Requirement coverage</p>
                  <div className={`rounded-lg border p-3 ${answerFeedbackStatusStyle(feedback.requirementCoverage.taskQuestion.status)}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold">Task question</p>
                      <span className="text-[10px] uppercase tracking-wider font-bold">
                        {statusLabel(feedback.requirementCoverage.taskQuestion.status)}
                      </span>
                    </div>
                    <p className="text-sm leading-relaxed mt-1">{feedback.requirementCoverage.taskQuestion.feedback}</p>
                  </div>
                  {feedback.requirementCoverage.successCriteria.map((criterion: any, criterionIndex: number) => (
                    <div key={`${criterion.criterion}-${criterionIndex}`} className={`rounded-lg border p-3 ${answerFeedbackStatusStyle(criterion.status)}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-semibold">Success criterion: {criterion.criterion}</p>
                        <span className="text-[10px] uppercase tracking-wider font-bold">{statusLabel(criterion.status)}</span>
                      </div>
                      <p className="text-sm leading-relaxed mt-1">{criterion.evidence}</p>
                    </div>
                  ))}
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 space-y-3">
                    <p className="text-xs font-bold uppercase tracking-widest text-sky-700">Key vocabulary</p>
                    {feedback.keyVocabulary.length > 0 ? feedback.keyVocabulary.map((term: any, termIndex: number) => (
                      <div key={`${term.term}-${termIndex}`} className={`rounded-lg border p-3 ${answerFeedbackStatusStyle(term.status)}`}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm font-semibold">{term.term}</p>
                          <span className="text-[10px] uppercase tracking-wider font-bold">{statusLabel(term.status)}</span>
                        </div>
                        <p className="text-sm leading-relaxed mt-1">{term.feedback}</p>
                      </div>
                    )) : <p className="text-sm text-sky-900">No key vocabulary was set for this task.</p>}
                  </div>
                  <div className="rounded-xl border border-neutral-200 p-4 space-y-2">
                    <p className="text-xs font-bold uppercase tracking-widest text-neutral-500">Length and format</p>
                    <div className={`rounded-lg border p-3 ${answerFeedbackStatusStyle(feedback.expectedLengthOrFormat.status)}`}>
                      <p className="text-sm font-semibold">{feedback.expectedLengthOrFormat.requirement || "No length or format was specified."}</p>
                      <p className="text-sm leading-relaxed mt-1">{feedback.expectedLengthOrFormat.feedback}</p>
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-neutral-200 p-4 space-y-3">
                  <p className="text-xs font-bold uppercase tracking-widest text-neutral-500">Journey evidence</p>
                  <div className="grid gap-3 md:grid-cols-3">
                    {journeyStages.map((stage) => (
                      <div key={stage} className={`rounded-lg border p-3 ${feedback.stageEvidence[stage].used ? "bg-emerald-50 border-emerald-200" : "bg-neutral-50 border-neutral-200"}`}>
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-semibold text-neutral-800">{stage}</p>
                          <span className="text-[10px] uppercase tracking-wider font-bold text-neutral-500">
                            {feedback.stageEvidence[stage].used ? "used" : "not shown"}
                          </span>
                        </div>
                        <p className="text-sm text-neutral-700 leading-relaxed mt-1">{feedback.stageEvidence[stage].feedback}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-3">
                  {[
                    ["Strengths", feedback.strengths, "border-emerald-200 bg-emerald-50 text-emerald-950"],
                    ["Areas for development", feedback.areasForDevelopment, "border-amber-200 bg-amber-50 text-amber-950"],
                    ["Next steps", feedback.nextSteps, "border-violet-200 bg-violet-50 text-violet-950"],
                  ].map(([title, items, className]) => (
                    <div key={title as string} className={`rounded-xl border p-4 ${className}`}>
                      <p className="text-xs font-bold uppercase tracking-widest mb-2">{title as string}</p>
                      <ul className="list-disc pl-5 space-y-1.5 text-sm">
                        {(items as string[]).map((item, index) => <li key={index}>{item}</li>)}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}

export default function TeacherStudentDetail() {
  const [, navigate] = useLocation();
  const initialStageHandledRef = useRef(false);
  const [, params] = useRoute("/teacher/class/:classId/student/:sessionId");
  const classId = params?.classId;
  const sessionId = params?.sessionId;

  const [data, setData] = useState<any>(null);
  const [dataError, setDataError] = useState("");
  const [task, setTask] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [pinResetting, setPinResetting] = useState(false);
  const [pinJustReset, setPinJustReset] = useState(false);
  const [assessmentUpdating, setAssessmentUpdating] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, { grade: Grade | null; comment: string; formativeComment: string; studentAcknowledged?: boolean }>>({});
  const [overallAssessment, setOverallAssessment] = useState<{ comment: string; grade: string } | null>(null);
  const [activity, setActivity] = useState<any>(null);
  const [activityLoaded, setActivityLoaded] = useState(false);
  const [studentMessages, setStudentMessages] = useState<any[]>([]);
  const [studentMessagesOpen, setStudentMessagesOpen] = useState(false);
  const [studentMessagesLoading, setStudentMessagesLoading] = useState(false);
  const [studentMessagesError, setStudentMessagesError] = useState("");
  const [feedbackLoaded, setFeedbackLoaded] = useState(false);
  const [studentInsights, setStudentInsights] = useState<Record<"formative" | "summative", any>>({
    formative: null,
    summative: null,
  });
  const [studentInsightLoading, setStudentInsightLoading] = useState<"formative" | "summative" | null>(null);
  const [openStudentInsights, setOpenStudentInsights] = useState<Record<"formative" | "summative", boolean>>({
    formative: false,
    summative: false,
  });
  const [synthLoading, setSynthLoading] = useState(false);
  const [formativeLoading, setFormativeLoading] = useState(false);
  const [summativePerStageLoading, setSummativePerStageLoading] = useState(false);
  const [feedbackVisibility, setFeedbackVisibility] = useState<FeedbackVisibility>(
    () => readFeedbackVisibility(classId, sessionId),
  );
  const [feedbackSaveStates, setFeedbackSaveStates] = useState<Record<string, FeedbackSaveState>>({});
  const [snapshotFinalisationFailed, setSnapshotFinalisationFailed] = useState(false);
  const [snapshotFinalising, setSnapshotFinalising] = useState(false);
  const [torchExpanded, setTorchExpanded] = useState(false);
  const [researchExpanded, setResearchExpanded] = useState(false);
  const [pendingAiType, setPendingAiType] = useState<"formative" | "summative" | null>(null);
  const pendingAiRef = useRef<"formative" | "summative" | null>(null);
  const feedbackSnapshot = useRef<Record<string, { grade: Grade | null; comment: string; formativeComment: string }>>({});
  const feedbackRef = useRef(feedback);
  const overallAssessmentRef = useRef(overallAssessment);
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const feedbackWritesRef = useRef<Record<string, Promise<void>>>({});
  const { toast } = useToast();

  const rememberFeedbackVisibility = useCallback((
    next: FeedbackVisibility | ((current: FeedbackVisibility) => FeedbackVisibility),
  ) => {
    setFeedbackVisibility((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      const key = feedbackVisibilityKey(classId, sessionId);
      if (key) {
        try {
          window.sessionStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          // Editor visibility can safely fall back to saved feedback if browser storage is unavailable.
        }
      }
      return resolved;
    });
  }, [classId, sessionId]);

  useEffect(() => {
    if (!classId || !sessionId) return;
    setDataError("");
    apiFetch(`/teacher/classes/${classId}/students/${sessionId}`)
      .then((detail: any) => {
        setData(detail);
        setStudentInsights(extractStudentInsights(detail));
      })
      .catch((error: any) => {
        setDataError(error?.message ?? "The student’s work could not be loaded.");
      })
      .finally(() => setLoading(false));
    apiFetch(`/teacher/classes/${classId}/task`)
      .then(setTask)
      .catch(() => {});
    apiFetch(`/teacher/classes/${classId}/students/${sessionId}/feedback`)
      .then((fb: any) => {
        const nextFeedback = fb ?? {};
        const restoredVisibility = readFeedbackVisibility(classId, sessionId);
        setFeedback(nextFeedback);
        rememberFeedbackVisibility({
          formative: restoredVisibility.formative
            || Object.values(nextFeedback).some((item: any) => Boolean(item?.formativeComment?.trim())),
          summative: restoredVisibility.summative
            || Object.entries(nextFeedback).some(([stage, item]: [string, any]) =>
            stage !== "OVERALL" && Boolean(item?.grade || item?.comment?.trim()),
          ),
        });
        if (fb?.OVERALL) {
          setOverallAssessment({ comment: fb.OVERALL.comment, grade: fb.OVERALL.grade ?? "" });
          rememberFeedbackVisibility((current) => ({ ...current, summative: true }));
        }
      })
      .catch(() => {})
      .finally(() => setFeedbackLoaded(true));
    apiFetch(`/teacher/classes/${classId}/students/${sessionId}/activity`)
      .then(setActivity)
      .catch(() => {})
      .finally(() => setActivityLoaded(true));
  }, [classId, rememberFeedbackVisibility, sessionId]);

  useEffect(() => { feedbackRef.current = feedback; }, [feedback]);
  useEffect(() => { overallAssessmentRef.current = overallAssessment; }, [overallAssessment]);
  const queueFeedbackSave = useCallback((
    stage: string,
    item: { grade: Grade | null | string; comment: string; formativeComment?: string },
    options: { keepalive?: boolean } = {},
  ): Promise<void> => {
    if (!classId || !sessionId) return Promise.resolve();
    setFeedbackSaveStates((current) => ({ ...current, [stage]: "saving" }));
    const previous = feedbackWritesRef.current[stage] ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => apiFetch(`/teacher/classes/${classId}/students/${sessionId}/feedback/${stage}`, {
        method: "PUT",
        body: JSON.stringify(item),
        keepalive: options.keepalive,
      }))
      .then((result: any) => {
        setFeedbackSaveStates((current) => ({ ...current, [stage]: "saved" }));
        if (stage === "OVERALL" && result?.finalisedAt) {
          setData((current: any) => current ? {
            ...current,
            session: { ...current.session, lockedAt: result.finalisedAt },
          } : current);
        }
      })
      .catch((error) => {
        setFeedbackSaveStates((current) => ({ ...current, [stage]: "error" }));
        throw error;
      });
    feedbackWritesRef.current[stage] = next.catch(() => undefined);
    return next;
  }, [classId, sessionId]);

  const flushFeedbackSaves = useCallback(async (options: { keepalive?: boolean } = {}) => {
    Object.values(saveTimers.current).forEach(clearTimeout);
    const feedbackToSave = pendingAiRef.current === null ? feedbackRef.current : feedbackSnapshot.current;
    const stageSaves = Object.entries(feedbackToSave)
      .filter(([stage]) => stage !== "OVERALL")
      .map(([stage, item]) => queueFeedbackSave(stage, item, options));
    const assertSaves = async (saves: Promise<void>[]) => {
      const results = await Promise.allSettled(saves);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw failed.reason;
    };
    await assertSaves(stageSaves);

    const overall = overallAssessmentRef.current;
    if (overall) {
      await queueFeedbackSave("OVERALL", { grade: overall.grade, comment: overall.comment }, options);
    }
  }, [queueFeedbackSave]);

  const handleOpenActivity = useCallback(async () => {
    if (!classId || !sessionId) return;
    if (pendingAiRef.current !== null) {
      toast({
        title: "Review the feedback draft first",
        description: "Submit or discard the current AI draft before opening student activity.",
      });
      return;
    }
    try {
      await flushFeedbackSaves();
      navigate(`/teacher/class/${classId}/student/${sessionId}/activity`);
    } catch (error: any) {
      toast({
        title: "Feedback could not be saved",
        description: error?.message ?? "Check your connection and try again.",
        variant: "destructive",
      });
    }
  }, [classId, flushFeedbackSaves, navigate, sessionId, toast]);

  const handleOpenStudentMessages = useCallback(async () => {
    if (!classId || !sessionId) return;
    setStudentMessagesOpen(true);
    setStudentMessagesLoading(true);
    setStudentMessagesError("");
    try {
      const result = await apiFetch(`/teacher/classes/${classId}/students/${sessionId}/messages`);
      setStudentMessages(result.messages ?? []);
    } catch (error: any) {
      setStudentMessages([]);
      setStudentMessagesError(error?.message ?? "Messages could not be loaded.");
    } finally {
      setStudentMessagesLoading(false);
    }
  }, [classId, sessionId]);

  const handleDownloadStudentMessagesPdf = useCallback(async () => {
    if (!classId || !sessionId) return;
    try {
      const blob = await apiFetchBlob(`/teacher/classes/${classId}/students/${sessionId}/messages/report.pdf`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "student-messages.pdf";
      link.click();
      URL.revokeObjectURL(url);
    } catch (error: any) {
      toast({ title: "Messages PDF could not be downloaded", description: error?.message ?? "Check your connection and try again.", variant: "destructive" });
    }
  }, [classId, sessionId, toast]);

  useEffect(() => {
    if (!classId || !sessionId) return;
    return registerBeforeLogout(async () => {
      await flushFeedbackSaves();
    });
  }, [classId, flushFeedbackSaves, sessionId]);

  useEffect(() => {
    const handlePageHide = () => {
      void flushFeedbackSaves({ keepalive: true }).catch(() => undefined);
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [flushFeedbackSaves]);

  const saveFeedback = useCallback((stage: string, grade: Grade | null, comment: string, formativeComment: string) => {
    if (pendingAiRef.current !== null) return;
    setFeedbackSaveStates((current) => ({ ...current, [stage]: "saving" }));
    clearTimeout(saveTimers.current[stage]);
    saveTimers.current[stage] = setTimeout(() => {
      void queueFeedbackSave(stage, { grade, comment, formativeComment }).catch(() => undefined);
    }, 800);
  }, [queueFeedbackSave]);

  const retryFeedbackSave = useCallback((stage: string) => {
    if (pendingAiRef.current !== null) return;
    const current = feedbackRef.current[stage];
    if (!current) return;
    void queueFeedbackSave(stage, current).catch(() => undefined);
  }, [queueFeedbackSave]);

  const updateFeedback = useCallback((stage: string, patch: Partial<{ grade: Grade | null; comment: string; formativeComment: string }>) => {
    setFeedback((prev) => {
      const current = prev[stage] ?? { grade: null, comment: "", formativeComment: "" };
      const updated = { ...current, ...patch };
      saveFeedback(stage, updated.grade, updated.comment, updated.formativeComment);
      const next = { ...prev, [stage]: updated };
      feedbackRef.current = next;
      return next;
    });
  }, [saveFeedback]);

  const handleSynthesise = async (): Promise<boolean> => {
    setSynthLoading(true);
    try {
      const result: any = await apiFetch(
        `/teacher/classes/${classId}/students/${sessionId}/feedback/synthesize`,
        { method: "POST" },
      );
      setOverallAssessment(result);
      overallAssessmentRef.current = result;
      rememberFeedbackVisibility((current) => ({ ...current, summative: true }));
      await queueFeedbackSave("OVERALL", { grade: result.grade, comment: result.comment });
      return true;
    } catch (err: any) {
      toast({ title: "Failed to generate assessment", description: err.message, variant: "destructive" });
      return false;
    } finally {
      setSynthLoading(false);
    }
  };

  const handleGenerateSummativePerStage = async () => {
    if (formativeLoading || summativePerStageLoading || pendingAiRef.current) return;
    if (!studentInsights.formative) {
      toast({
        title: "Formative Insight required",
        description: "Generate the Formative Student Insight before generating summative feedback.",
        variant: "destructive",
      });
      return;
    }
    pendingAiRef.current = "summative";
    setSummativePerStageLoading(true);
    try {
      const result: Record<string, { grade: string; comment: string }> = await apiFetch(
        `/teacher/classes/${classId}/students/${sessionId}/generate-summative-per-stage`,
        { method: "POST" },
      );
      const { OVERALL: generatedOverall, ...generatedStageFeedback } = result;
      if (!generatedOverall?.comment?.trim() || !generatedOverall.grade) {
        throw new Error("The overall assessment was not generated. Please try again.");
      }
      rememberFeedbackVisibility((current) => ({ ...current, summative: true }));
      feedbackSnapshot.current = JSON.parse(JSON.stringify(feedback));
      setOverallAssessment(generatedOverall);
      overallAssessmentRef.current = generatedOverall;
      setPendingAiType("summative");
      setFeedback((prev) => {
        const next = { ...prev };
        for (const [stage, { grade, comment }] of Object.entries(generatedStageFeedback)) {
          const current = next[stage] ?? { grade: null, comment: "", formativeComment: "" };
          next[stage] = { ...current, grade: grade as Grade, comment };
        }
        feedbackRef.current = next;
        return next;
      });
      toast({ title: "Summative draft ready", description: "Review and edit below, then click Submit to save." });
    } catch (err: any) {
      pendingAiRef.current = null;
      toast({ title: "Failed to generate summative feedback", description: err.message, variant: "destructive" });
    } finally {
      setSummativePerStageLoading(false);
    }
  };

  const handleGenerateFormative = async () => {
    if (formativeLoading || summativePerStageLoading || pendingAiRef.current) return;
    pendingAiRef.current = "formative";
    setFormativeLoading(true);
    try {
      const result: Record<string, string> = await apiFetch(
        `/teacher/classes/${classId}/students/${sessionId}/generate-formative-feedback`,
        { method: "POST" },
      );
      rememberFeedbackVisibility((current) => ({ ...current, formative: true }));
      feedbackSnapshot.current = JSON.parse(JSON.stringify(feedback));
      setPendingAiType("formative");
      setFeedback((prev) => {
        const next = { ...prev };
        for (const [stage, comment] of Object.entries(result)) {
          const current = next[stage] ?? { grade: null, comment: "", formativeComment: "" };
          next[stage] = { ...current, formativeComment: comment };
        }
        return next;
      });
      toast({ title: "Formative draft ready", description: "Review and edit below, then click Submit to save." });
    } catch (err: any) {
      pendingAiRef.current = null;
      toast({ title: "Failed to generate feedback", description: err.message, variant: "destructive" });
    } finally {
      setFormativeLoading(false);
    }
  };

  const handleGenerateStudentInsight = async (phase: "formative" | "summative") => {
    if (!classId || !sessionId || studentInsightLoading || pendingAiRef.current !== null) return;
    setStudentInsightLoading(phase);
    try {
      const result = await apiFetch(
        `/teacher/classes/${classId}/students/${sessionId}/generate-student-insight`,
        { method: "POST", body: JSON.stringify({ phase }) },
      );
      setStudentInsights((current) => ({ ...current, [phase]: result }));
      setOpenStudentInsights((current) => ({ ...current, [phase]: false }));
      toast({
        title: "Student insight ready",
        description: "The report combines the student's work, recorded activity, AI use, and available feedback evidence.",
      });
      window.setTimeout(() => {
        document.getElementById(`section-student-insight-${phase}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 0);
    } catch (err: any) {
      if (String(err?.message ?? "").toLowerCase().includes("already been generated")) {
        try {
          const detail = await apiFetch(`/teacher/classes/${classId}/students/${sessionId}`);
          setData(detail);
          const savedInsights = extractStudentInsights(detail);
          setStudentInsights(savedInsights);
          setOpenStudentInsights((current) => ({ ...current, [phase]: false }));
          window.setTimeout(() => {
            document.getElementById(`section-student-insight-${phase}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
          }, 0);
          toast({
            title: "Student insight already available",
            description: "The saved report has been loaded below.",
          });
          return;
        } catch {
          // Keep the original error when the refresh also fails.
        }
      }
      toast({ title: "Failed to generate student insight", description: err.message, variant: "destructive" });
    } finally {
      setStudentInsightLoading(null);
    }
  };

  const downloadStudentInsightCsv = (phase: "formative" | "summative") => {
    const insight = studentInsights[phase];
    if (!insight) return;
    const journeyFormat = insight.purposeVersion === "journey-v2";
    const compactResponseRows: Array<[string, string, string, string, string, string]> = phase === "summative" && insight.responseToAiFeedback
      ? [
        ["Summative", "After AI feedback one summary", "", "", "", insight.responseToAiFeedback.afterFeedbackOneSummary ?? insight.responseToAiFeedback.afterFeedbackOne ?? ""],
        ...(["feedbackOneConclusions", "feedbackTwoConclusions"] as const).flatMap((key) => {
          const round = key === "feedbackOneConclusions" ? "Feedback one" : "Feedback two";
          return (Array.isArray(insight.responseToAiFeedback?.[key]) ? insight.responseToAiFeedback[key] : [])
            .map((item: any) => [
              "Summative",
              round,
              item.feedbackPoint ?? "",
              Array.isArray(item.evidenceReferences)
                ? item.evidenceReferences.map((reference: any) => reference.excerpt).filter(Boolean).join(" ")
                : item.laterEvidence ?? "",
              studentInsightStatusLabel(item.status),
              item.conclusion ?? "",
            ] as [string, string, string, string, string, string]);
        }),
        ["Summative", "After AI feedback two summary", "", "", "", insight.responseToAiFeedback.afterFeedbackTwoSummary ?? insight.responseToAiFeedback.afterFeedbackTwo ?? ""],
        ["Summative", "Overall answer development", "", "", "", insight.responseToAiFeedback.overallAnswerDevelopment ?? ""],
      ]
      : [];
    const teacherFeedbackRows: Array<[string, string, string, string, string, string]> = phase === "summative"
      ? (Array.isArray(insight.formativeFeedbackConclusions) ? insight.formativeFeedbackConclusions : []).map((item: any) => [
        "Summative",
        `Teacher formative feedback — ${item.feedbackStage ?? ""}`,
        item.feedback ?? "",
        item.conclusion ?? "",
        studentInsightStatusLabel(item.status),
        item.studentAcknowledged ? "Student marked feedback as actioned" : "",
      ])
      : [];
    const activityComparisonRows: Array<[string, string]> = phase === "summative" && insight.activityComparison
      ? [
        ["Formative Insight date", formatInsightDate(insight.activityComparison.formativeGeneratedAt)],
        ["Login sessions — at Formative Insight", String(insight.activityComparison.atFormative?.recordedSessions ?? "Not available")],
        ["Login sessions — since Formative Insight", String(insight.activityComparison.sinceFormative?.recordedSessions ?? "Not available")],
        ["Login sessions — Summative total", String(insight.activityComparison.summativeTotal?.recordedSessions ?? "Not available")],
        ["Recorded active time — at Formative Insight", formatInsightDuration(insight.activityComparison.atFormative?.recordedSeconds)],
        ["Recorded active time — since Formative Insight", formatInsightDuration(insight.activityComparison.sinceFormative?.recordedSeconds)],
        ["Recorded active time — Summative total", formatInsightDuration(insight.activityComparison.summativeTotal?.recordedSeconds)],
        ["TORCH AI questions — at Formative Insight", String(insight.activityComparison.atFormative?.torchQuestions ?? "Not available")],
        ["TORCH AI questions — since Formative Insight", String(insight.activityComparison.sinceFormative?.torchQuestions ?? "Not available")],
        ["TORCH AI questions — Summative total", String(insight.activityComparison.summativeTotal?.torchQuestions ?? "Not available")],
        ["TORCH AI responses — at Formative Insight", String(insight.activityComparison.atFormative?.torchResponses ?? "Not available")],
        ["TORCH AI responses — since Formative Insight", String(insight.activityComparison.sinceFormative?.torchResponses ?? "Not available")],
        ["TORCH AI responses — Summative total", String(insight.activityComparison.summativeTotal?.torchResponses ?? "Not available")],
        ["Final-answer AI-feedback rounds used", typeof insight.activityComparison.finalAnswerFeedbackRoundsUsed === "number"
          ? `${insight.activityComparison.finalAnswerFeedbackRoundsUsed} out of 2`
          : "Not available"],
        ["Stages changed since formative", insight.activityComparison.changedStages?.join("; ") || "Not available"],
        ["Recorded activity note", "Recorded activity means interaction recorded inside the Climb; it is not total time spent on the task."],
      ]
      : [];
    const progressRows: Array<[string, string]> = phase === "summative"
      ? [
        ["Addressed", insight.progressBreakdown?.addressed?.join("; ") || "Not available from this saved report."],
        ["Partly addressed", insight.progressBreakdown?.partlyAddressed?.join("; ") || "Not available from this saved report."],
        ["Still to develop", insight.progressBreakdown?.stillToDevelop?.join("; ") || (insight.nextSteps?.join("; ") || "Not available from this saved report.")],
        ["Main recorded development", insight.formativeFollowUp ?? "Not available from this saved report."],
      ]
      : [];
    const sectionTimingRows: Array<[string, string]> = Array.isArray(insight.activitySectionTiming)
      ? insight.activitySectionTiming.map((entry: any) => [
        `Recorded time — ${entry.label ?? entry.stage ?? "Section"}`,
        formatInsightDuration(entry.recordedSeconds),
      ])
      : [["Recorded time by Climb section", "Not available from this saved report."]];
    const provenanceRecorded = hasRecordedInsightProvenance(insight);
    const provenanceValue = (value: unknown, fallback = HISTORICAL_PROVENANCE_UNAVAILABLE) =>
      provenanceRecorded && value !== undefined && value !== null && value !== "" ? String(value) : fallback;
    const provenanceRows: Array<[string, string]> = [
      ["Insight phase", provenanceRecorded ? (insight.provenance?.phase ?? phase) : phase],
      ["Generated", formatInsightDate(insight.provenance?.generatedAt ?? insight.generatedAt)],
      ["Prompt version", provenanceValue(insight.provenance?.promptVersion)],
      ["AI provider", provenanceValue(insight.provenance?.aiProvider)],
      ["Model", provenanceValue(insight.provenance?.model)],
      ["Formative snapshot ID", provenanceRecorded ? String(insight.provenance?.formativeSnapshotId ?? "Not used") : HISTORICAL_PROVENANCE_UNAVAILABLE],
      ["Summative snapshot ID", provenanceRecorded ? String(insight.provenance?.summativeSnapshotId ?? "Not used") : HISTORICAL_PROVENANCE_UNAVAILABLE],
      ["Source record IDs", provenanceRecorded ? JSON.stringify(insight.provenance?.sourceRecordIds ?? {}) : HISTORICAL_PROVENANCE_UNAVAILABLE],
    ];
    const stageEvidenceRows: Array<[string, string]> = Array.isArray(insight.stageEvidenceProfile)
      ? insight.stageEvidenceProfile.flatMap((item: any): Array<[string, string]> => [
        [`${item.stage ?? "Stage"} visited`, item.visited ? "Yes" : "No"],
        [`${item.stage ?? "Stage"} marked complete`, item.markedComplete ? "Yes" : "No"],
        [`${item.stage ?? "Stage"} substantive evidence recorded`, item.substantiveEvidenceRecorded ? "Yes" : "No"],
        [`${item.stage ?? "Stage"} learning demonstrated`, studentInsightLearningEvidenceLabel(item.learningEvidenceStatus)],
        [`${item.stage ?? "Stage"} learning evidence`, item.learningEvidence ?? "Not available from this saved report."],
      ])
      : [];
    const rows: Array<[string, string]> = [
      ["Report", phase === "formative" ? "Formative Student Insight" : "Summative Student Insight"],
      ["Student", data?.session?.studentName ?? ""],
      ["Task", task?.title ?? ""],
      ["Generated", formatInsightDate(insight.generatedAt)],
      ...provenanceRows,
      ...sectionTimingRows,
       ...stageEvidenceRows,
      [phase === "formative" ? journeyFormat ? "Journey at the formative point" : "Overall interpretation" : "Journey comparison", insight.summary ?? ""],
      [phase === "formative" ? journeyFormat ? "Use of the Climb" : "How it came together" : "Formative to completed journey", insight.howItCameTogether ?? ""],
      ["Recorded activity", insight.activitySummary ?? ""],
      ["Use of AI", insight.aiUseSummary ?? ""],
      [phase === "summative" ? "Progress since the Formative Insight" : journeyFormat ? "Research and verification" : "Formative follow-up", insight.formativeFollowUp ?? ""],
      ...activityComparisonRows,
      ...progressRows,
      ...(phase === "summative" ? [["Other recorded development", insight.otherRecordedDevelopment?.join("; ") || "No separate development identified."] as [string, string]] : []),
      ...(["strengths", "nextSteps", "cautions"] as const).flatMap((key) =>
        (Array.isArray(insight[key]) ? insight[key] : []).map((value: string, index: number) => [
          key === "strengths"
            ? `${phase === "formative" ? journeyFormat ? "Planning and reflection" : "Strength" : "Recorded development"} ${index + 1}`
            : key === "nextSteps"
              ? `${phase === "formative" ? journeyFormat ? "Missed opportunity" : "Teacher next step" : "Opportunity still unused"} ${index + 1}`
              : `${phase === "formative" && !journeyFormat ? "Caution" : "Evidence limitation"} ${index + 1}`,
          value,
        ] as [string, string]),
      ),
    ];
    const escapeCsv = (value: string) => {
      const text = String(value);
      const safeText = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
      return `"${safeText.replace(/"/g, '""')}"`;
    };
    const summativeCsvRows: Array<[string, string, string, string, string, string]> = [
      ["Summative", "Report summary", "Formative Insight date", "", "", formatInsightDate(insight.activityComparison?.formativeGeneratedAt)],
      ...[...provenanceRows, ...sectionTimingRows].map(([label, value]) =>
        ["Summative", label, "", "", "", value] as [string, string, string, string, string, string]),
      ...[...activityComparisonRows, ...progressRows].map(([label, value]) =>
        ["Summative", label, "", "", "", value] as [string, string, string, string, string, string]),
      ...compactResponseRows,
      ...teacherFeedbackRows,
    ];
    const csv = phase === "summative"
      ? `\uFEFF${[
        ["Report phase", "Feedback round", "Feedback point", "Later evidence", "Response status", "Conclusion"],
        ...summativeCsvRows,
      ].map((row) => row.map(escapeCsv).join(",")).join("\r\n")}`
      : `\uFEFF${rows.map(([label, value]) => `${escapeCsv(label)},${escapeCsv(value)}`).join("\r\n")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${phase}-student-insight-${data?.session?.studentName || "student"}.csv`
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-");
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const downloadStudentInsightPdf = async (phase: "formative" | "summative") => {
    if (!classId || !sessionId) return;
    try {
      const blob = await apiFetchBlob(
        `/teacher/classes/${classId}/students/${sessionId}/student-insight/${phase}/report.pdf`,
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${phase}-student-insight-${data?.session?.studentName || "student"}.pdf`
        .toLowerCase()
        .replace(/[^a-z0-9.-]+/g, "-");
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error: any) {
      toast({
        title: "PDF download failed",
        description: error.message || "The stored Student Insight could not be downloaded.",
        variant: "destructive",
      });
    }
  };

  const handleSubmitAiFeedback = async () => {
    const submittedType = pendingAiRef.current;
    if (submittedType === "summative") {
      const missingStages = SUMMATIVE_FEEDBACK_STAGES.filter((stage) => {
        const item = feedbackRef.current[stage];
        return !item?.grade || !item.comment.trim();
      });
      const overall = overallAssessmentRef.current;
      if (missingStages.length > 0 || !overall?.grade || !overall.comment.trim()) {
        toast({
          title: "Complete the summative assessment before submitting",
          description: missingStages.length > 0
            ? `Add a grade and comment for: ${missingStages.join(", ")}.`
            : "Add an overall grade and comment.",
          variant: "destructive",
        });
        return;
      }
    }
    pendingAiRef.current = null;
    setPendingAiType(null);
    try {
      await flushFeedbackSaves();
    } catch (error: any) {
      toast({
        title: "Feedback could not be saved",
        description: error?.message ?? "Check your connection and try again.",
        variant: "destructive",
      });
      return;
    }
    if (submittedType === "summative") {
      toast({ title: "Summative feedback saved", description: "All stage feedback and the overall assessment are now available." });
      return;
    }
    if (submittedType !== "formative") {
      toast({ title: "Feedback saved", description: "All stages have been saved successfully." });
      return;
    }
    try {
      setSnapshotFinalising(true);
      await apiFetch(`/teacher/classes/${classId}/students/${sessionId}/feedback/finalise-formative`, { method: "POST" });
      setSnapshotFinalisationFailed(false);
      toast({ title: "Feedback saved", description: "All stages have been saved successfully." });
    } catch {
      setSnapshotFinalisationFailed(true);
      toast({
        title: "Feedback was saved, but the preserved version could not be confirmed. Try again.",
        variant: "destructive",
      });
    } finally {
      setSnapshotFinalising(false);
    }
  };

  const retrySnapshotFinalisation = async () => {
    if (!classId || !sessionId || snapshotFinalising) return;
    setSnapshotFinalising(true);
    try {
      await apiFetch(`/teacher/classes/${classId}/students/${sessionId}/feedback/finalise-formative`, { method: "POST" });
      setSnapshotFinalisationFailed(false);
      toast({ title: "Preserved version confirmed", description: "The formative feedback version is now available for development analysis." });
    } catch {
      toast({
        title: "Feedback was saved, but the preserved version could not be confirmed. Try again.",
        variant: "destructive",
      });
    } finally {
      setSnapshotFinalising(false);
    }
  };

  const handleDiscardAiFeedback = () => {
    pendingAiRef.current = null;
    setPendingAiType(null);
    setFeedback(feedbackSnapshot.current);
    toast({ title: "Draft discarded", description: "Feedback returned to its previous state." });
  };

  const handleResetPin = async () => {
    if (!classId || !sessionId) return;
    if (!confirm(`Reset PIN for ${data?.session?.studentName}? They will be asked to choose a new PIN next time they join.`)) return;
    setPinResetting(true);
    try {
      await apiFetch(`/teacher/classes/${classId}/students/${sessionId}/reset-pin`, {
        method: "POST",
      });
      setPinJustReset(true);
      toast({ title: "PIN reset", description: `${data.session.studentName} will be prompted to set a new PIN on their next join.` });
    } catch (err: any) {
      toast({ title: "Failed to reset PIN", description: err.message, variant: "destructive" });
    } finally {
      setPinResetting(false);
    }
  };

  const handleAssessmentLock = async () => {
    if (!classId || !sessionId || !data?.session) return;
    const isLocked = Boolean(data.session.lockedAt);
    if (isLocked && data.session.isFinalised) return;
    const action = isLocked ? "unlock-assessment" : "lock-assessment";
    if (!confirm(`${isLocked ? "Unlock" : "Lock"} ${data.session.studentName}'s work temporarily?\n\n${isLocked ? "They will be able to edit and use AI tools again." : "They will still be able to view their work, but editing and AI tools will be disabled until you unlock it."}`)) return;
    setAssessmentUpdating(true);
    try {
      const result = await apiFetch(`/teacher/classes/${classId}/students/${sessionId}/${action}`, { method: "POST" });
      setData((current: any) => current ? {
        ...current,
        session: {
          ...current.session,
          lockedAt: isLocked ? null : result?.lockedAt ?? new Date().toISOString(),
        },
      } : current);
       toast({ title: isLocked ? "Work unlocked" : "Work locked", description: isLocked ? "The student can edit and use AI tools again." : "The student can view their work but cannot edit it until unlocked." });
    } catch (err: any) {
      toast({ title: `Could not ${isLocked ? "unlock" : "lock"} assessment`, description: err.message, variant: "destructive" });
    } finally {
      setAssessmentUpdating(false);
    }
  };

  useEffect(() => {
    if (!data || initialStageHandledRef.current) return;
    const stage = new URLSearchParams(window.location.search).get("stage");
    const sectionId = {
      MAP: "section-map",
      TORCH: "section-torch",
      RESEARCH: "section-research",
      COMPASS: "section-compass",
      EMBED: "section-answer",
    }[stage ?? ""];
    initialStageHandledRef.current = true;
    if (!sectionId) return;
    window.requestAnimationFrame(() => {
      document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [data]);

  if (loading) return null;
  if (!data) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="rounded-2xl border border-red-200 bg-red-50 p-5">
          <h1 className="font-semibold text-red-900">Student work could not be loaded</h1>
          <p className="mt-2 text-sm text-red-800">{dataError || "The student record was not found."}</p>
          <Link href={`/teacher/class/${classId}`} className="mt-4 inline-flex rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white">
            Back to class
          </Link>
        </div>
      </div>
    );
  }

  const { session, stageEntries: entries, chatMessages: messages, answerFeedbackAttempts = [] } = data;

  const mapEntry = entries.find((e: any) => e.stage === "MAP")?.contentJson || {};
  const torchEntry = entries.find((e: any) => e.stage === "TORCH")?.contentJson || {};
  const researchEntry = entries.find((e: any) => e.stage === "RESEARCH")?.contentJson || {};
  const compassEntry = entries.find((e: any) => e.stage === "COMPASS")?.contentJson || {};
  const embedEntry = entries.find((e: any) => e.stage === "EMBED")?.contentJson || {};
  const readOnlyFeedback = Boolean(session.lockedAt);
  const hasFormativeFeedback = Object.values(feedback).some((item) => Boolean(item.formativeComment.trim()));
  const hasCompleteSummativeFeedback = SUMMATIVE_FEEDBACK_STAGES.every((stage) => {
    const item = feedback[stage];
    return Boolean(item?.grade && item.comment.trim());
  }) && Boolean(
    overallAssessment?.grade
    && overallAssessment.comment.trim()
    && GRADES.includes(overallAssessment.grade as Grade),
  );
  const showFormativeFeedback = feedbackVisibility.formative;
  const showSummativeFeedback = feedbackVisibility.summative || Boolean(overallAssessment);

  const researchSources: any[] = researchEntry.entries ?? [];

  // Derive started vs finished from actual content
  const stageStarted: Record<string, boolean> = {
    MAP: !!(mapEntry.taskUnderstanding?.trim() || mapEntry.priorKnowledge?.some((p: string) => p?.trim()) || mapEntry.enquiryQuestions?.some((q: string) => q?.trim())),
    TORCH: messages.length > 0,
    RESEARCH: researchSources.some((s: any) => s.source || s.url || s.title || s.findings || s.importantPoints),
    COMPASS: !!(compassEntry.check1 || compassEntry.check2 || compassEntry.check3 || compassEntry.check4 || compassEntry.check5),
    EMBED: !!(answerVisibleText(String(embedEntry.finalAnswer ?? "")) || embedEntry.q1 || embedEntry.q2 || embedEntry.q3 || embedEntry.q4),
  };
  const declaredOrLegacy = (entry: any, legacy: boolean) =>
    typeof entry?._studentCompletion?.complete === "boolean" ? entry._studentCompletion.complete : legacy;
  const stageComplete: Record<string, boolean> = {
    MAP: declaredOrLegacy(mapEntry, mapEntry.taskUnderstanding?.trim().length >= 20
      && mapEntry.priorKnowledge?.filter((p: string) => p?.trim()).length >= 2
      && mapEntry.knowledgeGaps?.filter((g: string) => g?.trim()).length >= 3
      && mapEntry.enquiryQuestions?.filter((q: string) => q?.trim()).length >= 3),
    TORCH: declaredOrLegacy(torchEntry, messages.length >= 6),
    RESEARCH: declaredOrLegacy(researchEntry, researchSources.filter((s: any) => (s.source || s.title) && s.findings).length >= 1),
    COMPASS: declaredOrLegacy(compassEntry, !!(compassEntry.check1?.trim() && compassEntry.check2?.trim() && compassEntry.check3?.trim() && compassEntry.check4?.trim() && compassEntry.check5?.trim())),
    EMBED: declaredOrLegacy(embedEntry, !!(answerVisibleText(String(embedEntry.finalAnswer ?? "")).trim() && embedEntry.q1?.trim() && embedEntry.q2?.trim() && embedEntry.q3?.trim() && embedEntry.q4?.trim())),
  };
  const stageHasMissingDeclaration: Record<string, boolean> = {
    MAP: mapEntry._studentCompletion?.complete === true && mapEntry._studentCompletion?.sectionsMissing === true,
    TORCH: torchEntry._studentCompletion?.complete === true && torchEntry._studentCompletion?.sectionsMissing === true,
    RESEARCH: researchEntry._studentCompletion?.complete === true && researchEntry._studentCompletion?.sectionsMissing === true,
    COMPASS: compassEntry._studentCompletion?.complete === true && compassEntry._studentCompletion?.sectionsMissing === true,
    EMBED: embedEntry._studentCompletion?.complete === true && embedEntry._studentCompletion?.sectionsMissing === true,
  };
  const stageStatus = (stage: string) => (
    stageComplete[stage] ? "Complete" : stageStarted[stage] ? "In progress" : "Not started"
  );
  const overviewRows: Array<unknown[]> = [
    ["Learning information", "Detail"],
    ["Assignment", task?.title ?? ""],
    ["Question", task?.question ?? ""],
    ["Map", stageStatus("MAP")],
    ["Torch", stageStatus("TORCH")],
    ["Research Log", stageStatus("RESEARCH")],
    ["Compass", stageStatus("COMPASS")],
    ["Final Answer", stageStatus("EMBED")],
    ["Timestamp timezone", "UTC (ISO 8601)"],
    ["Recorded activity periods", activity?.summary?.totalSessions ?? 0],
    ["Total recorded activity", formatResearchDuration(activity?.summary?.totalSeconds ?? 0)],
    ["Average login session", activity?.summary?.loginSessionsAvailable ? formatResearchDuration(activity?.summary?.averageLoginSessionSeconds ?? 0) : "Not available"],
  ];
  (activity?.entries ?? []).forEach((entry: any, index: number) => {
    const sessionNumber = index + 1;
    overviewRows.push(
      [`Login date ${sessionNumber} (UTC)`, formatResearchTimestamp(entry.startedAt)],
      [`Activity ${sessionNumber} last seen (UTC)`, formatResearchTimestamp(entry.lastSeenAt)],
      [`Activity ${sessionNumber} ended (UTC)`, entry.endedAt ? formatResearchTimestamp(entry.endedAt) : "Open session"],
      [`Activity ${sessionNumber} duration`, formatResearchDuration(entry.durationSeconds)],
    );
  });
  for (const stage of RESEARCH_ACTIVITY_STAGES) {
    const stageSeconds = activity?.summary?.pageDurations?.find(
      (page: any) => page.stage === stage,
    )?.durationSeconds ?? 0;
    overviewRows.push([`Total time — ${RESEARCH_STAGE_LABEL[stage]}`, formatResearchDuration(stageSeconds)]);
  }
  for (const stage of RESEARCH_ACTIVITY_STAGES) {
    const stageFeedback = feedback[stage];
    overviewRows.push(
      [`Formative feedback — ${RESEARCH_STAGE_LABEL[stage]}`, stageFeedback?.formativeComment ?? ""],
      [`Summative grade — ${RESEARCH_STAGE_LABEL[stage]}`, stageFeedback?.grade ?? ""],
      [`Summative feedback — ${RESEARCH_STAGE_LABEL[stage]}`, stageFeedback?.comment ?? ""],
    );
  }
  overviewRows.push(
    ["Overall grade", overallAssessment?.grade ?? ""],
    ["Overall feedback", overallAssessment?.comment ?? ""],
  );

  const stageExport = (
    stage: string,
    sectionId: string,
    rows: Array<unknown[]>,
    options: { disabled?: boolean } = {},
  ) => {
    const details = exportDetails[stage];
    return (
      <div className="flex flex-wrap gap-2 print:hidden">
        <button
          onClick={() => void downloadSectionPdf(sectionId, details.title, details.pdfFilename)}
          className="rounded-xl border border-neutral-300 px-3 py-2 text-xs font-semibold hover:bg-neutral-50"
          aria-label={`Download ${details.title} PDF`}
        >
          Download PDF
        </button>
        <button
          onClick={() => downloadCsv(rows, details.filename)}
          disabled={options.disabled}
          className="rounded-xl border border-neutral-300 px-3 py-2 text-xs font-semibold hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={`Download ${details.title} spreadsheet`}
        >
          Download CSV
        </button>
      </div>
    );
  };
  return (
    <div className="min-h-[100dvh] bg-neutral-50 text-neutral-900 font-sans pb-20">
      <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-6 py-4 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 text-sm">
            <Link href="/teacher/dashboard" className="text-neutral-500 hover:text-black">Dashboard</Link>
            <span className="text-neutral-300">/</span>
            <Link href={`/teacher/class/${classId}`} className="text-neutral-500 hover:text-black">Class View</Link>
            <span className="text-neutral-300">/</span>
            <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{session.studentName}</span>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Link
              href={`/teacher/class/${classId}/student/${sessionId}/report`}
              className="rounded-2xl border border-neutral-300 px-5 py-2 text-sm font-medium hover:bg-neutral-100 transition-colors"
              data-testid="button-student-report"
            >
              Download Report
            </Link>
            <button
              type="button"
              onClick={() => downloadCsv(overviewRows, "assisted-climb-student-overview.csv")}
              disabled={!activityLoaded || !activity || !feedbackLoaded}
              className="rounded-2xl border border-neutral-300 px-5 py-2 text-sm font-medium transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Download student overview as CSV"
              data-testid="button-student-csv"
            >
              Download CSV
            </button>
          </div>
        </div>
      </header>

      {pendingAiType && (
        <div className="sticky top-[57px] z-40 border-b border-amber-200 bg-amber-50 px-6 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <span className="shrink-0 w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            <p className="text-sm font-medium text-amber-900 truncate">
              AI-generated <span className="font-bold">{pendingAiType}</span> feedback is ready — review and edit below, then submit.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleDiscardAiFeedback}
              className="text-sm text-amber-700 hover:text-amber-900 px-3 py-1.5 rounded-lg hover:bg-amber-100 transition-colors"
            >
              Discard
            </button>
            <button
              onClick={handleSubmitAiFeedback}
              disabled={snapshotFinalising}
              className="text-sm font-semibold bg-amber-500 text-white px-4 py-1.5 rounded-lg hover:bg-amber-600 transition-colors"
            >
              {snapshotFinalising ? "Preserving…" : "Submit Feedback"}
            </button>
          </div>
        </div>
      )}

      {snapshotFinalisationFailed && !pendingAiType && (
        <div className="border-b border-amber-200 bg-amber-50 px-6 py-3 flex items-center justify-between gap-4">
          <p className="text-sm font-medium text-amber-900">
            Feedback was saved, but the preserved version could not be confirmed. Try again.
          </p>
          <button
            type="button"
            onClick={retrySnapshotFinalisation}
            disabled={snapshotFinalising}
            className="shrink-0 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
          >
            {snapshotFinalising ? "Trying…" : "Try again"}
          </button>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-6 py-12 space-y-8">

        {/* Student header + progress */}
        <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div className="min-w-0">
              <h1 className="text-3xl font-semibold tracking-tight mb-1 [overflow-wrap:anywhere]">{session.studentName}'s Climb</h1>
              {task && (
                <div className="mt-2 space-y-0.5">
                  <p className="text-sm font-semibold text-neutral-700">{task.title}</p>
                  {task.question && <p className="text-sm text-neutral-500 leading-relaxed">{task.question}</p>}
                </div>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-3" aria-label="Student Insight workflow">
                <button
                  onClick={handleGenerateFormative}
                  disabled={pendingAiType === "formative"
                    ? snapshotFinalising
                    : hasFormativeFeedback || readOnlyFeedback || formativeLoading || summativePerStageLoading || pendingAiType !== null}
                  className="rounded-2xl bg-sky-600 text-white px-5 py-2 text-sm font-semibold hover:bg-sky-700 transition-colors disabled:opacity-50 flex items-center gap-2"
                  data-testid="button-generate-formative"
                >
                  {formativeLoading ? (
                    <>
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                      Generating…
                    </>
                  ) : pendingAiType === "formative"
                    ? snapshotFinalising ? "Preserving…" : "Submit Formative Feedback"
                    : hasFormativeFeedback ? "Formative Feedback Generated" : "Generate Formative Feedback"}
                </button>
                <button
                  onClick={() => handleGenerateStudentInsight("formative")}
                  disabled={!hasFormativeFeedback || Boolean(studentInsights.formative) || studentInsightLoading !== null || formativeLoading || summativePerStageLoading || pendingAiType !== null || Boolean(session.lockedAt)}
                  title={
                    pendingAiType === "formative"
                      ? "Submit the formative feedback draft above before generating the Formative Insight."
                      : !hasFormativeFeedback
                        ? "Generate Formative Feedback first."
                        : undefined
                  }
                  className="rounded-2xl bg-emerald-600 text-white px-5 py-2 text-sm font-semibold hover:bg-emerald-700 transition-colors disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-600 flex items-center gap-2"
                  data-testid="button-generate-formative-student-insight"
                >
                  {studentInsightLoading === "formative"
                    ? "Generating Formative Insight…"
                    : studentInsights.formative
                      ? "Formative Insight Generated"
                      : "Generate Formative Insight"}
                </button>
                <button
                  onClick={pendingAiType === "summative" ? handleSubmitAiFeedback : handleGenerateSummativePerStage}
                  disabled={pendingAiType === "summative"
                    ? snapshotFinalising
                    : !studentInsights.formative || hasCompleteSummativeFeedback || readOnlyFeedback || formativeLoading || summativePerStageLoading || pendingAiType !== null}
                  title={!studentInsights.formative ? "Generate Formative Insight first." : undefined}
                  className="rounded-2xl bg-violet-600 text-white px-5 py-2 text-sm font-semibold hover:bg-violet-700 transition-colors disabled:cursor-not-allowed disabled:opacity-50 flex items-center gap-2"
                  data-testid="button-generate-summative-per-stage"
                >
                  {summativePerStageLoading ? (
                    <>
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                      Generating…
                    </>
                  ) : pendingAiType === "summative"
                    ? snapshotFinalising ? "Preserving…" : "Submit Summative Feedback"
                    : hasCompleteSummativeFeedback ? "Summative Feedback Generated" : "Generate Summative Feedback"}
                </button>
                <button
                  onClick={() => handleGenerateStudentInsight("summative")}
                   disabled={!studentInsights.formative || !hasCompleteSummativeFeedback || Boolean(studentInsights.summative) || !session.lockedAt || studentInsightLoading !== null || formativeLoading || summativePerStageLoading || pendingAiType !== null}
                  title={
                    !studentInsights.formative
                      ? "Generate Formative Insight first."
                      : !hasCompleteSummativeFeedback
                        ? "Complete Summative Feedback, including the overall assessment, first."
                        : !session.lockedAt
                          ? "Submit Summative Feedback so the assessment can be finalised first."
                          : undefined
                  }
                  className="rounded-2xl bg-emerald-600 text-white px-5 py-2 text-sm font-semibold hover:bg-emerald-700 transition-colors disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-600 flex items-center gap-2"
                  data-testid="button-generate-summative-student-insight"
                >
                  {studentInsightLoading === "summative"
                    ? "Generating Summative Insight…"
                    : studentInsights.summative
                      ? "Summative Insight Generated"
                      : "Generate Summative Insight"}
                </button>
                <button
                  type="button"
                  onClick={handleOpenActivity}
                  className="rounded-2xl border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 transition-colors"
                  data-testid="button-student-climb-activity"
                >
                  Student Climb Activity
                </button>
                 <button
                   type="button"
                   onClick={() => void handleOpenStudentMessages()}
                   className="rounded-2xl border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 transition-colors"
                   data-testid="button-student-messages"
                 >
                   Student Messages
                 </button>
                <button
                  onClick={handleResetPin}
                  disabled={pinResetting || pinJustReset}
                  className="rounded-2xl border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 transition-colors disabled:opacity-40"
                  data-testid="button-reset-pin"
                >
                  {pinResetting ? "Resetting…" : pinJustReset ? "✓ PIN Reset" : "Reset PIN"}
                </button>
                <button
                  onClick={handleAssessmentLock}
                  disabled={assessmentUpdating}
                  className={`rounded-2xl border px-4 py-2 text-sm font-medium transition-colors disabled:opacity-40 ${session.lockedAt ? "border-violet-200 text-violet-700 hover:bg-violet-50" : "border-neutral-300 hover:bg-neutral-50"}`}
                  data-testid="button-toggle-assessment-lock"
                >
                  {assessmentUpdating ? "Saving…" : session.lockedAt ? "Unlock" : "Lock"}
                </button>
                {pinJustReset && (
                  <span className="text-xs text-neutral-400">Student will set a new PIN on next join.</span>
                )}
              </div>
               <div className="mt-3 space-y-1 text-xs text-neutral-500">
                 {!hasFormativeFeedback && !session.lockedAt && (
                   <p>Generate Formative Feedback first.</p>
                 )}
                 {pendingAiType === "formative" && !studentInsights.formative && !session.lockedAt && (
                   <p className="font-medium text-sky-700">Submit the formative feedback draft above, then generate the Formative Insight.</p>
                 )}
                 {hasFormativeFeedback && !studentInsights.formative && !pendingAiType && !session.lockedAt && (
                   <p>Generate Formative Insight next.</p>
                 )}
                  {studentInsights.formative && !hasCompleteSummativeFeedback && !session.lockedAt && (
                   <p>Generate Summative Feedback next.</p>
                 )}
                 {pendingAiType === "summative" && (
                   <p className="font-medium text-violet-700">Submit the summative feedback draft above; the Summative Insight will then become available.</p>
                 )}
                  {hasCompleteSummativeFeedback && !studentInsights.summative && session.lockedAt && !pendingAiType && (
                   <p>Generate Summative Insight next.</p>
                 )}
                 {studentInsights.summative && <p>All four steps are complete. The Student Insights remain available to view and download.</p>}
               </div>
            </div>
          </div>
        </div>

        {Object.entries(studentInsights).filter(([, insight]) => Boolean(insight)).map(([phase, studentInsight]) => (
          <section
            key={phase}
            id={`section-student-insight-${phase}`}
            data-testid={`section-student-insight-${phase}`}
            className="rounded-[2rem] bg-white border-2 border-emerald-200 shadow-sm overflow-hidden"
          >
            <div className="border-b border-emerald-100 bg-emerald-50 px-8 py-6 flex flex-wrap items-start justify-between gap-3">
              <div>
                 <p className="text-xs uppercase tracking-[0.2em] font-semibold text-emerald-700 mb-1">Research evidence view</p>
                <h2 className="text-2xl font-semibold tracking-tight">
                  {phase === "formative" ? "Formative Student Insight" : "Summative Student Insight"}
                </h2>
                <p className="mt-2 max-w-3xl text-sm text-emerald-950/70">
                   A structured record of feature use, recorded activity, AI and teacher feedback, and observable evidence of change.
                </p>
              </div>
              <div className="flex items-center gap-3">
                {studentInsight.generatedAt && (
                  <p className="text-xs text-emerald-800/60">Generated {new Date(studentInsight.generatedAt).toLocaleDateString("en-GB")}</p>
                )}
                <button
                  type="button"
                  onClick={() => downloadStudentInsightCsv(phase as "formative" | "summative")}
                  className="rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-sm font-semibold text-emerald-800"
                >
                  Download CSV
                </button>
                <button
                  type="button"
                  onClick={() => void downloadStudentInsightPdf(phase as "formative" | "summative")}
                  className="rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-sm font-semibold text-emerald-800"
                >
                  Download PDF
                </button>
              </div>
            </div>

            <details
              open={openStudentInsights[phase as "formative" | "summative"]}
              onToggle={(event) => {
                const insightPhase = phase as "formative" | "summative";
                const open = event.currentTarget.open;
                setOpenStudentInsights((current) => current[insightPhase] === open ? current : { ...current, [insightPhase]: open });
              }}
            >
              <summary className="cursor-pointer border-b border-emerald-100 px-8 py-3 text-sm font-semibold text-emerald-900">
                Show or hide this insight
              </summary>
            <div className="p-8 space-y-6">
               {studentInsight.metrics && (
                 <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  {[
                     ["Activity sessions", studentInsight.activityComparison?.summativeTotal?.recordedSessions ?? studentInsight.metrics.totalSessions ?? "Not available"],
                     ["Recorded time", formatInsightDuration(studentInsight.activityComparison?.summativeTotal?.recordedSeconds ?? studentInsight.metrics.totalSeconds)],
                     ["TORCH AI questions", studentInsight.activityComparison?.summativeTotal?.torchQuestions ?? studentInsight.metrics.studentMessages ?? 0],
                     ["TORCH AI responses", studentInsight.activityComparison?.summativeTotal?.torchResponses ?? studentInsight.metrics.assistantMessages ?? 0],
                     ...(phase === "summative"
                       ? [["Final-answer AI feedback", typeof studentInsight.activityComparison?.finalAnswerFeedbackRoundsUsed === "number"
                         ? `${studentInsight.activityComparison.finalAnswerFeedbackRoundsUsed} out of 2 rounds`
                         : "Not available"]]
                       : []),
                  ].map(([label, value]) => (
                    <div key={label as string} className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{label as string}</p>
                      <p className="mt-2 text-sm font-semibold text-neutral-900">{value as string | number}</p>
                    </div>
                  ))}
                </div>
              )}

                <section className="rounded-2xl border border-slate-200 bg-slate-50 p-5 space-y-4" data-testid="student-insight-evidence-metadata">
                 <div>
                   <p className="text-xs font-semibold uppercase tracking-wider text-slate-700/70">Recorded time by Climb section</p>
                   {Array.isArray(studentInsight.activitySectionTiming) && studentInsight.activitySectionTiming.length > 0
                     ? <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
                       {studentInsight.activitySectionTiming.map((entry: any) => (
                         <div key={entry.stage ?? entry.label} className="rounded-xl border border-slate-200 bg-white p-3">
                           <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{entry.label ?? entry.stage}</p>
                           <p className="mt-1 text-sm font-semibold text-slate-900">{formatInsightDuration(entry.recordedSeconds)}</p>
                         </div>
                       ))}
                     </div>
                     : <p className="mt-2 text-sm text-slate-600">Not available from this saved report.</p>}
                 </div>
               </section>

                <section className="rounded-2xl border border-indigo-200 bg-indigo-50/60 p-5 space-y-4" data-testid="student-insight-stage-evidence-profile">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-indigo-800/70">Feature-use profile</p>
                    <p className="mt-2 text-sm leading-relaxed text-indigo-950/75">
                      These are separate observations. Visiting a stage, marking it complete, recording substantive evidence, and demonstrating learning are not interchangeable.
                    </p>
                  </div>
                  {Array.isArray(studentInsight.stageEvidenceProfile) && studentInsight.stageEvidenceProfile.length > 0 ? (
                    <div className="overflow-x-auto rounded-xl border border-indigo-100 bg-white">
                      <table className="w-full min-w-[760px] text-left text-sm">
                        <thead className="bg-indigo-50 text-xs uppercase tracking-wide text-indigo-900/70">
                          <tr>
                            <th className="px-4 py-3 font-semibold">Stage</th>
                            <th className="px-4 py-3 font-semibold">Visited</th>
                            <th className="px-4 py-3 font-semibold">Marked complete</th>
                            <th className="px-4 py-3 font-semibold">Substantive evidence</th>
                            <th className="px-4 py-3 font-semibold">Learning demonstrated</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-indigo-100">
                          {studentInsight.stageEvidenceProfile.map((item: any, index: number) => (
                            <tr key={`${item.stage ?? "stage"}-${index}`}>
                              <th className="px-4 py-3 font-medium text-neutral-900">{item.stage ?? "Stage"}</th>
                              <td className="px-4 py-3 text-neutral-700">{item.visited ? "Yes" : "No"}</td>
                              <td className="px-4 py-3 text-neutral-700">{item.markedComplete ? "Yes" : "No"}</td>
                              <td className="px-4 py-3 text-neutral-700">{item.substantiveEvidenceRecorded ? "Yes" : "No"}</td>
                              <td className="px-4 py-3 text-neutral-700">
                                <p>{studentInsightLearningEvidenceLabel(item.learningEvidenceStatus)}</p>
                                <p className="mt-1 text-xs text-neutral-500">{item.learningEvidence ?? "Not available from this saved report."}</p>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-sm text-neutral-600">This previously generated report does not include a separate feature-use profile.</p>
                  )}
                </section>

               {phase === "summative" && (
                 <section className="rounded-2xl border border-sky-200 bg-sky-50/60 p-5 space-y-4" data-testid="summative-activity-comparison">
                   <div>
                     <p className="text-xs font-semibold uppercase tracking-wider text-sky-800/70 mb-2">Activity before and after the Formative Insight</p>
                     <p className="text-sm text-sky-950/75">Formative Insight date: {formatInsightDate(studentInsight.activityComparison?.formativeGeneratedAt)}</p>
                   </div>
                   <div className="overflow-x-auto rounded-xl border border-sky-100 bg-white">
                     <table className="w-full min-w-[680px] text-left text-sm">
                       <thead className="bg-sky-50 text-xs uppercase tracking-wide text-sky-900/70">
                         <tr>
                           <th className="px-4 py-3 font-semibold">Measure</th>
                           <th className="px-4 py-3 font-semibold">At Formative Insight</th>
                           <th className="px-4 py-3 font-semibold">Since Formative Insight</th>
                           <th className="px-4 py-3 font-semibold">Summative total</th>
                         </tr>
                       </thead>
                       <tbody className="divide-y divide-sky-100">
                          <tr>
                            <th className="px-4 py-3 font-medium text-neutral-900">Login sessions</th>
                            <td className="px-4 py-3 text-neutral-700">{studentInsight.activityComparison?.atFormative?.recordedSessions ?? "Not available"}</td>
                            <td className="px-4 py-3 text-neutral-700">{studentInsight.activityComparison?.sinceFormative?.recordedSessions ?? "Not available"}</td>
                            <td className="px-4 py-3 text-neutral-700">{studentInsight.activityComparison?.summativeTotal?.recordedSessions ?? "Not available"}</td>
                          </tr>
                           {[
                           ["Recorded active time", "recordedSeconds", true],
                           ["TORCH AI questions", "torchQuestions", false],
                           ["TORCH AI responses", "torchResponses", false],
                         ].map(([label, key, duration]) => {
                           const read = (part: any) => {
                             const value = part?.[key as string];
                             return typeof value === "number"
                               ? duration ? formatInsightDuration(value) : String(value)
                               : "Not available";
                           };
                           return (
                             <tr key={label as string}>
                               <th className="px-4 py-3 font-medium text-neutral-900">{label as string}</th>
                               <td className="px-4 py-3 text-neutral-700">{read(studentInsight.activityComparison?.atFormative)}</td>
                               <td className="px-4 py-3 text-neutral-700">{read(studentInsight.activityComparison?.sinceFormative)}</td>
                               <td className="px-4 py-3 font-semibold text-neutral-900">{read(studentInsight.activityComparison?.summativeTotal)}</td>
                             </tr>
                           );
                         })}
                       </tbody>
                     </table>
                   </div>
                   <p className="text-xs leading-relaxed text-sky-950/70">Recorded activity means interaction recorded inside the Climb; it is not total time spent on the task.</p>
                 </section>
               )}

              <div className="rounded-2xl border border-emerald-100 bg-emerald-50/50 p-5">
                 <p className="text-xs font-semibold uppercase tracking-wider text-emerald-800/70 mb-2">{phase === "formative" ? studentInsight.purposeVersion === "journey-v2" ? "Journey at the formative point" : "Overall interpretation" : "Journey comparison"}</p>
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{studentInsight.summary}</p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                {[
                   [phase === "formative" ? studentInsight.purposeVersion === "journey-v2" ? "Use of the Climb" : "How it came together" : "Formative to completed journey", studentInsight.howItCameTogether, "border-violet-200 bg-violet-50"],
                  ["Recorded activity", studentInsight.activitySummary, "border-sky-200 bg-sky-50"],
                   ["Use of AI", studentInsight.aiUseSummary, "border-amber-200 bg-amber-50"],
                    [phase === "summative" ? "Progress since the Formative Insight" : studentInsight.purposeVersion === "journey-v2" ? "Research and verification" : "Formative follow-up", studentInsight.formativeFollowUp, "border-rose-200 bg-rose-50"],
                ].map(([title, text, className]) => (
                  <div key={title as string} className={`rounded-2xl border p-5 ${className as string}`}>
                    <p className="text-xs font-semibold uppercase tracking-wider text-neutral-600 mb-2">{title as string}</p>
                    <p className="text-sm leading-relaxed whitespace-pre-wrap">{text as string}</p>
                  </div>
                ))}
              </div>

               {phase === "summative" && (
                 <section className="rounded-2xl border border-rose-200 bg-rose-50/70 p-5 space-y-4" data-testid="summative-progress-breakdown">
                   <p className="text-xs font-semibold uppercase tracking-wider text-rose-800/70">Progress since the Formative Insight</p>
                   <div className="grid gap-4 md:grid-cols-3">
                     {[
                       ["Addressed", studentInsight.progressBreakdown?.addressed],
                       ["Partly addressed", studentInsight.progressBreakdown?.partlyAddressed],
                       ["Still to develop", studentInsight.progressBreakdown?.stillToDevelop?.length ? studentInsight.progressBreakdown.stillToDevelop : studentInsight.nextSteps],
                     ].map(([title, items]) => (
                       <div key={title as string} className="rounded-xl border border-rose-200 bg-white p-4">
                         <p className="text-xs font-semibold uppercase tracking-wider text-neutral-600 mb-2">{title as string}</p>
                         {Array.isArray(items) && items.length > 0
                           ? <ul className="list-disc pl-5 space-y-1.5 text-sm leading-relaxed">{items.map((item: string, index: number) => <li key={index}>{item}</li>)}</ul>
                           : <p className="text-sm text-neutral-500">Not available from this saved report.</p>}
                       </div>
                     ))}
                   </div>
                   {Array.isArray(studentInsight.teacherReviewNotes) && studentInsight.teacherReviewNotes.length > 0 && (
                     <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                       <p className="text-xs font-semibold uppercase tracking-wider text-amber-800">Teacher review note</p>
                       <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-amber-950">
                         {studentInsight.teacherReviewNotes.map((note: string, index: number) => <li key={index}>{note}</li>)}
                       </ul>
                     </div>
                   )}
                 </section>
               )}

               {phase === "summative" && (
                 <section className="rounded-2xl border border-violet-200 bg-violet-50/60 p-5 space-y-3" data-testid="summative-work-changes">
                   <p className="text-xs font-semibold uppercase tracking-wider text-violet-800/70">Where the work changed</p>
                   <p className="text-sm leading-relaxed"><span className="font-medium">Stages changed since formative:</span> {studentInsight.activityComparison?.changedStages?.length ? studentInsight.activityComparison.changedStages.join(", ") : "Not available"}.</p>
                   <p className="text-sm leading-relaxed"><span className="font-medium">Main recorded development:</span> {studentInsight.formativeFollowUp || "Not available from this saved report."}</p>
                 </section>
               )}

                {phase === "summative" && Array.isArray(studentInsight.formativeFeedbackConclusions) && studentInsight.formativeFeedbackConclusions.length > 0 && (
                  <section className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-5 space-y-4" data-testid="response-to-teacher-formative-feedback">
                    <p className="text-xs font-semibold uppercase tracking-wider text-emerald-800/70">Response to teacher formative feedback</p>
                    <div className="space-y-3">
                      {studentInsight.formativeFeedbackConclusions.map((item: any, index: number) => (
                        <div key={`${item.feedbackStage}-${index}`} className="rounded-xl border border-emerald-200 bg-white p-4">
                          <p className="text-xs font-semibold uppercase tracking-wider text-neutral-600">{item.feedbackStage}</p>
                          <p className="mt-2 text-sm leading-relaxed"><span className="font-medium">Feedback:</span> {item.feedback || "The preserved feedback text is not available in this saved report."}</p>
                           <p className="mt-2 text-xs font-semibold text-emerald-800">{studentInsightStatusLabel(item.status)}</p>
                           {typeof item.studentAcknowledged === "boolean" && (
                             <p className="mt-1 text-xs text-emerald-800/70">Student marked feedback as actioned: {item.studentAcknowledged ? "Yes" : "No"}</p>
                           )}
                          <p className="mt-2 text-sm leading-relaxed"><span className="font-medium">Later evidence:</span> {item.conclusion}</p>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {phase === "summative" && (
                  <section className="rounded-2xl border border-neutral-200 bg-neutral-50 p-5" data-testid="other-recorded-development">
                    <p className="text-xs font-semibold uppercase tracking-wider text-neutral-600">Other recorded development</p>
                    {Array.isArray(studentInsight.otherRecordedDevelopment) && studentInsight.otherRecordedDevelopment.length > 0
                      ? <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm leading-relaxed">{studentInsight.otherRecordedDevelopment.map((item: string, index: number) => <li key={index}>{item}</li>)}</ul>
                      : <p className="mt-3 text-sm text-neutral-500">No separate development could be identified confidently from this saved report.</p>}
                  </section>
                )}

                {phase === "summative" && studentInsight.responseToAiFeedback && (
                 <section className="rounded-2xl border border-violet-200 bg-violet-50/60 p-5 space-y-5" data-testid="response-to-ai-feedback">
                   <div>
                     <p className="text-xs font-semibold uppercase tracking-wider text-violet-800/70 mb-2">Response to AI feedback</p>
                     <p className="text-sm leading-relaxed whitespace-pre-wrap">{studentInsight.responseToAiFeedback.overallAnswerDevelopment}</p>
                   </div>
                   <div className="grid gap-4 md:grid-cols-2">
                     <div className="rounded-xl border border-violet-200 bg-white p-4">
                       <p className="text-xs font-semibold uppercase tracking-wider text-neutral-600 mb-2">After AI feedback one</p>
                        <p className="text-sm leading-relaxed">{studentInsight.responseToAiFeedback.afterFeedbackOneSummary ?? studentInsight.responseToAiFeedback.afterFeedbackOne}</p>
                        {studentInsight.responseToAiFeedback.feedbackOneStatus && <p className="mt-3 text-xs font-semibold text-violet-800">{studentInsight.responseToAiFeedback.feedbackOneStatus}</p>}
                     </div>
                     <div className="rounded-xl border border-violet-200 bg-white p-4">
                       <p className="text-xs font-semibold uppercase tracking-wider text-neutral-600 mb-2">After AI feedback two</p>
                         <p className="text-sm leading-relaxed">{studentInsight.responseToAiFeedback.feedbackTwoConclusions?.length ? (studentInsight.responseToAiFeedback.afterFeedbackTwoSummary ?? studentInsight.responseToAiFeedback.afterFeedbackTwo) : "No second AI-feedback round was recorded."}</p>
                        {studentInsight.responseToAiFeedback.feedbackTwoStatus && <p className="mt-3 text-xs font-semibold text-violet-800">{studentInsight.responseToAiFeedback.feedbackTwoStatus}</p>}
                     </div>
                   </div>
                    {([
                      ["Feedback one — point-by-point conclusions", studentInsight.responseToAiFeedback.feedbackOneConclusions],
                      ["Feedback two — point-by-point conclusions", studentInsight.responseToAiFeedback.feedbackTwoConclusions],
                    ] as const).map(([title, conclusions]) => Array.isArray(conclusions) && conclusions.length > 0 && (
                      <div key={title} className="rounded-xl border border-violet-200 bg-white p-4">
                        <p className="text-xs font-semibold uppercase tracking-wider text-neutral-600 mb-3">{title}</p>
                        <div className="space-y-3">
                          {conclusions.map((item: any, index: number) => (
                            <div key={index} className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
                              <p className="text-sm font-semibold text-neutral-900">{item.feedbackPoint}</p>
                              <p className="mt-1 text-xs font-semibold text-violet-800">{item.status}</p>
                              <p className="mt-2 text-sm leading-relaxed"><span className="font-medium">Evidence:</span> {Array.isArray(item.evidenceReferences) && item.evidenceReferences.length > 0 ? item.evidenceReferences.map((reference: any) => reference.excerpt).join(" ") : item.laterEvidence ?? "No corresponding evidence was recorded."}</p>
                              <p className="mt-1 text-sm leading-relaxed"><span className="font-medium">Conclusion:</span> {item.conclusion}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    {(["supportingEvidence", "unresolved", "teacherReview"] as const).some((key) => Array.isArray(studentInsight.responseToAiFeedback[key])) && (
                      <div className="grid gap-4 md:grid-cols-3">
                        {([
                          ["Supporting evidence", studentInsight.responseToAiFeedback.supportingEvidence],
                          ["What remains unresolved", studentInsight.responseToAiFeedback.unresolved],
                          ["Teacher review", studentInsight.responseToAiFeedback.teacherReview],
                        ] as const).map(([title, items]) => (
                          <div key={title} className="rounded-xl border border-violet-200 bg-white p-4">
                            <p className="text-xs font-semibold uppercase tracking-wider text-neutral-600 mb-2">{title}</p>
                            {Array.isArray(items) && items.length > 0
                              ? <ul className="list-disc pl-5 space-y-1.5 text-sm leading-relaxed">{items.map((item: string, index: number) => <li key={index}>{item}</li>)}</ul>
                              : <p className="text-sm text-neutral-500">No additional point was recorded.</p>}
                          </div>
                        ))}
                      </div>
                    )}
                    {Array.isArray(studentInsight.responseToAiFeedback.evidenceCautions) && studentInsight.responseToAiFeedback.evidenceCautions.length > 0 && (
                     <div className="rounded-xl border border-neutral-200 bg-white p-4">
                       <p className="text-xs font-semibold uppercase tracking-wider text-neutral-600 mb-2">Evidence cautions</p>
                       <ul className="list-disc pl-5 space-y-1.5 text-sm leading-relaxed">
                         {studentInsight.responseToAiFeedback.evidenceCautions.map((item: string, index: number) => <li key={index}>{item}</li>)}
                       </ul>
                     </div>
                   )}
                 </section>
               )}

              <div className="grid gap-4 md:grid-cols-3">
                {[
                   [phase === "formative" && studentInsight.purposeVersion === "journey-v2" ? "Observed learning and process evidence" : phase === "summative" ? "Recorded development" : "Strengths", studentInsight.strengths, "border-emerald-200 bg-emerald-50"],
                  [phase === "formative" && studentInsight.purposeVersion === "journey-v2" ? "Missed opportunities" : phase === "summative" ? "Opportunities still unused" : "Teacher next steps", studentInsight.nextSteps, "border-violet-200 bg-violet-50"],
                  [phase === "formative" && studentInsight.purposeVersion !== "journey-v2" ? "Cautions" : "Evidence limitations", studentInsight.cautions, "border-neutral-200 bg-neutral-50"],
                ].map(([title, items, className]) => (
                  <div key={title as string} className={`rounded-2xl border p-5 ${className as string}`}>
                    <p className="text-xs font-semibold uppercase tracking-wider text-neutral-600 mb-2">{title as string}</p>
                    {Array.isArray(items) && items.length > 0 ? (
                      <ul className="list-disc pl-5 space-y-2 text-sm leading-relaxed">
                        {(items as string[]).map((item, index) => <li key={index}>{item}</li>)}
                      </ul>
                    ) : (
                      <p className="text-sm text-neutral-500">No additional points returned.</p>
                    )}
                  </div>
                ))}
              </div>

              <p className="text-xs leading-relaxed text-neutral-500">
                This is a teacher-facing interpretation, not a grade. Recorded time measures interaction inside the Climb only. Activity after formative feedback does not prove that the student revised their work because the platform does not retain response versions.
              </p>
            </div>
            </details>
          </section>
        ))}

        <section id="section-overview" data-testid="section-overview" className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
          <div className="border-b border-neutral-200 px-8 py-6 flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-2">Overview</p>
              <h2 className="text-2xl font-semibold tracking-tight">Learning journey overview</h2>
            </div>
            {stageExport("OVERVIEW", "section-overview", overviewRows, {
              disabled: !activityLoaded || !activity || !feedbackLoaded,
            })}
          </div>
          <div className="p-8 space-y-5">
            {task && (
              <div>
                <p className="text-sm font-semibold text-neutral-700">{task.title}</p>
                {task.question && <p className="mt-1 text-sm text-neutral-600 whitespace-pre-wrap">{task.question}</p>}
              </div>
            )}
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {[
                ["Map", "MAP"],
                ["Torch", "TORCH"],
                ["Research Log", "RESEARCH"],
                ["Compass", "COMPASS"],
                ["Final Answer", "EMBED"],
              ].map(([label, stage]) => (
                <div key={stage} className={`rounded-2xl border p-4 ${JOURNEY_STAGE_CARD[stage]}`}>
                  <dt className={`text-xs font-semibold uppercase tracking-wider ${JOURNEY_STAGE_LABEL[stage]}`}>{label}</dt>
                  <dd className="mt-1 text-sm text-neutral-800">{stageStatus(stage)}</dd>
                  {stageHasMissingDeclaration[stage] && <dd className="mt-1 text-xs font-semibold text-amber-700">Sections missing</dd>}
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* Jump-to nav */}
        <div className="rounded-[2rem] bg-white border border-neutral-200 px-8 py-5 shadow-sm">
          <p className="text-xs text-neutral-400 font-medium uppercase tracking-wider mb-3">Jump to section</p>
          <div className="flex flex-wrap gap-2">
            {([
              { stage: "MAP",      sectionId: "section-map",      finishedColor: "bg-neutral-800 text-white",   startedColor: "bg-white text-neutral-700 border-2 border-neutral-400",   noneColor: "bg-neutral-100 text-neutral-400" },
              { stage: "TORCH",    sectionId: "section-torch",    finishedColor: "bg-amber-500 text-white",     startedColor: "bg-white text-amber-600 border-2 border-amber-400",        noneColor: "bg-neutral-100 text-neutral-400" },
              { stage: "COMPASS",  sectionId: "section-compass",  finishedColor: "bg-emerald-500 text-white",   startedColor: "bg-white text-emerald-600 border-2 border-emerald-400",    noneColor: "bg-neutral-100 text-neutral-400" },
              { stage: "EMBED",    sectionId: "section-answer",   finishedColor: "bg-violet-500 text-white",    startedColor: "bg-white text-violet-600 border-2 border-violet-400",      noneColor: "bg-neutral-100 text-neutral-400" },
              { stage: "RESEARCH", sectionId: "section-research", finishedColor: "bg-sky-500 text-white",       startedColor: "bg-white text-sky-600 border-2 border-sky-400",            noneColor: "bg-neutral-100 text-neutral-400" },
            ] as const).map(({ stage, sectionId, finishedColor, startedColor, noneColor }) => {
              const finished = stageComplete[stage] ?? false;
              const started = !finished && (stageStarted[stage] ?? false);
              const label = stage === "EMBED" ? "Final Answer" : stage;
              const colorClass = finished ? finishedColor : started ? startedColor : noneColor;
              return (
                <button
                  key={stage}
                  onClick={() => document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  className={`flex flex-col items-center px-4 py-2.5 rounded-2xl text-xs font-bold tracking-widest transition-opacity hover:opacity-80 cursor-pointer ${colorClass}`}
                >
                  <span>{label}</span>
                  <span className="mt-1 text-sm font-bold leading-none">
                    {finished ? "✓" : started ? "…" : "✗"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <TeacherAnswerFeedback attempts={answerFeedbackAttempts} />

        {/* MAP */}
        <section id="section-map" data-testid="section-map" className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
          <div className="border-b border-neutral-200 px-8 py-6 flex flex-wrap items-start justify-between gap-3">
            <div><p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-2">MAP</p><h3 className="text-2xl font-semibold tracking-tight">Planning My Enquiry</h3></div>
            {stageExport("MAP", "section-map", [["Field", "Response"], ...Object.entries(mapEntry)])}
          </div>
          {/* New format */}
          {"taskUnderstanding" in mapEntry ? (
            <div className="p-8 space-y-6">
              <div>
                <p className="text-sm font-medium mb-2 text-neutral-500">Understanding of the task</p>
                <div className="w-full rounded-2xl bg-neutral-50 border border-neutral-200 p-4 min-h-[70px] whitespace-pre-wrap text-sm">
                  {mapEntry.taskUnderstanding || <span className="italic text-neutral-400">Not yet completed</span>}
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <p className="text-sm font-medium mb-2 text-neutral-500">What I already know</p>
                  <div className="rounded-2xl bg-neutral-50 border border-neutral-200 p-4 min-h-[70px]">
                    {Array.isArray(mapEntry.priorKnowledge) && mapEntry.priorKnowledge.filter((p: string) => p.trim()).length > 0
                      ? <ul className="space-y-1">{mapEntry.priorKnowledge.filter((p: string) => p.trim()).map((p: string, i: number) => <li key={i} className="text-sm flex gap-2"><span className="text-neutral-300">•</span>{p}</li>)}</ul>
                      : <span className="text-sm italic text-neutral-400">Not yet completed</span>}
                  </div>
                </div>
                <div>
                  <p className="text-sm font-medium mb-2 text-neutral-500">What I need to find out</p>
                  <div className="rounded-2xl bg-neutral-50 border border-neutral-200 p-4 min-h-[70px]">
                    {Array.isArray(mapEntry.knowledgeGaps) && mapEntry.knowledgeGaps.filter((g: string) => g.trim()).length > 0
                      ? <ul className="space-y-1">{mapEntry.knowledgeGaps.filter((g: string) => g.trim()).map((g: string, i: number) => <li key={i} className="text-sm flex gap-2"><span className="text-neutral-300">•</span>{g}</li>)}</ul>
                      : <span className="text-sm italic text-neutral-400">Not yet completed</span>}
                  </div>
                </div>
              </div>
              <div>
                <p className="text-sm font-medium mb-2 text-neutral-500">Enquiry questions</p>
                <div className="rounded-2xl bg-neutral-50 border border-neutral-200 p-4 min-h-[70px]">
                  {Array.isArray(mapEntry.enquiryQuestions) && mapEntry.enquiryQuestions.filter((q: string) => q.trim()).length > 0
                    ? <ol className="space-y-1">{mapEntry.enquiryQuestions.filter((q: string) => q.trim()).map((q: string, i: number) => <li key={i} className="text-sm flex gap-2"><span className="text-neutral-500 font-medium">{i + 1}.</span>{q}</li>)}</ol>
                    : <span className="text-sm italic text-neutral-400">Not yet completed</span>}
                </div>
              </div>
              {Array.isArray(mapEntry.researchPlan) && mapEntry.researchPlan.filter((r: any) => r.investigation?.trim()).length > 0 && (
                <div>
                  <p className="text-sm font-medium mb-2 text-neutral-500">Research &amp; verification plan</p>
                  <div className="space-y-3">
                    {mapEntry.researchPlan.filter((r: any) => r.investigation?.trim()).map((row: any, i: number) => (
                      <div key={i} className="rounded-xl border border-neutral-200 p-4 grid grid-cols-3 gap-4 text-sm">
                        <div><p className="text-xs text-neutral-400 mb-1">Investigate</p><p>{row.investigation}</p></div>
                        <div><p className="text-xs text-neutral-400 mb-1">Sources</p><p>{row.sources?.length > 0 ? row.sources.join(", ") : <span className="italic text-neutral-400">—</span>}</p></div>
                        <div><p className="text-xs text-neutral-400 mb-1">Verify</p><p className="whitespace-pre-wrap">{row.verification || <span className="italic text-neutral-400">—</span>}</p></div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {mapEntry.notes && (
                <div>
                  <p className="text-sm font-medium mb-2 text-neutral-500">Planning notes</p>
                  <div className="w-full rounded-2xl bg-neutral-50 border border-neutral-200 p-4 whitespace-pre-wrap text-sm">{mapEntry.notes}</div>
                </div>
              )}
            </div>
          ) : (
            /* Legacy q1-q5 format */
            <div className="p-8 space-y-6">
              {[
                { label: "What is this task asking you to do?", value: mapEntry.q1 },
                { label: "What do you already know about this topic?", value: mapEntry.q2 },
                { label: "What might be difficult about this task?", value: mapEntry.q3 },
                { label: "Break the task into its component parts.", value: mapEntry.q4 },
                { label: "Plan your research.", value: mapEntry.q5 },
              ].map((item, i) => (
                <div key={i}>
                  <p className="text-sm font-medium mb-2 text-neutral-500">{item.label}</p>
                  <div className="w-full rounded-2xl bg-neutral-50 border border-neutral-200 p-4 min-h-[70px] whitespace-pre-wrap text-sm">
                    {item.value || <span className="italic text-neutral-400">Not yet completed</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
          <StageFeedbackPanel
            stage="MAP"
            feedback={feedback["MAP"]}
            onUpdate={(patch) => updateFeedback("MAP", patch)}
            onRetry={() => retryFeedbackSave("MAP")}
            showFormative={showFormativeFeedback}
            showSummative={showSummativeFeedback}
            readOnly={readOnlyFeedback}
            saveState={feedbackSaveStates.MAP}
          />
          <div className="flex justify-end px-8 pb-5">
            <button onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} className="text-xs text-neutral-400 hover:text-neutral-700 transition-colors">↑ Back to top</button>
          </div>
        </section>

        {/* TORCH */}
        <section id="section-torch" data-testid="section-torch" className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
          <div className="border-b border-neutral-200 px-8 py-6 flex flex-wrap items-start justify-between gap-3">
            <div><p className="text-xs uppercase tracking-[0.2em] text-amber-500 mb-2">TORCH</p><h3 className="text-2xl font-semibold tracking-tight">Guided AI-Mediated Investigation</h3><p className="text-sm text-neutral-500 mt-1">{messages.length} message{messages.length !== 1 ? "s" : ""}</p></div>
            {stageExport("TORCH", "section-torch", [["Role", "Message"], ...messages.map((message: any) => [message.role, message.content])])}
          </div>

          {/* Bloom level breakdown */}
          {(() => {
            const LEVELS = ["Knowledge", "Understand", "Apply", "Analyse", "Evaluate", "Create"] as const;
            const LEVEL_COLORS: Record<string, string> = {
              Knowledge: "bg-blue-100 text-blue-700 border-blue-200",
              Understand: "bg-sky-100 text-sky-700 border-sky-200",
              Apply: "bg-emerald-100 text-emerald-700 border-emerald-200",
              Analyse: "bg-amber-100 text-amber-700 border-amber-200",
              Evaluate: "bg-orange-100 text-orange-700 border-orange-200",
              Create: "bg-violet-100 text-violet-700 border-violet-200",
            };
            const userMessages = messages.filter((m: any) => m.role === "user");
            const counts: Record<string, number> = {};
            for (const m of userMessages) {
              if (m.bloomLevel) counts[m.bloomLevel] = (counts[m.bloomLevel] ?? 0) + 1;
            }
            const untagged = userMessages.filter((m: any) => !m.bloomLevel).length;
            const hasAny = Object.keys(counts).length > 0;
            if (!hasAny && messages.length === 0) return null;
            return (
              <div className="border-b border-neutral-100 px-8 py-5">
                <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-3">Thinking level breakdown</p>
                <div className="flex flex-wrap gap-2">
                  {LEVELS.map((level) => {
                    const count = counts[level] ?? 0;
                    return (
                      <span
                        key={level}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border ${
                          count > 0 ? LEVEL_COLORS[level] : "bg-neutral-100 text-neutral-400 border-neutral-200"
                        }`}
                      >
                        {level}
                        <span className={`font-bold ${count > 0 ? "" : "opacity-50"}`}>{count}</span>
                      </span>
                    );
                  })}
                  {untagged > 0 && (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border bg-neutral-100 text-neutral-400 border-neutral-200">
                      No level selected <span className="font-bold">{untagged}</span>
                    </span>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Question type breakdown */}
          {(() => {
            const userMessages = messages.filter((m: any) => m.role === "user");
            if (userMessages.length === 0) return null;
            const counts = classifyMessages(userMessages.map((m: any) => ({ role: "user", content: m.content })));
            const total = Object.values(counts).reduce((a, b) => a + b, 0);
            return (
              <div className="border-b border-neutral-100 px-8 py-5">
                <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-3">Question type breakdown</p>
                <TooltipProvider delayDuration={200}>
                <div className="flex flex-wrap gap-2 mb-3">
                  {QUESTION_TYPES.filter((t) => counts[t] > 0).map((type) => (
                    <Tooltip key={type}>
                      <TooltipTrigger asChild>
                        <span
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border cursor-default ${QUESTION_TYPE_META[type].color}`}
                        >
                          {type} <span className="font-bold">{counts[type]}</span>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-[300px] text-left p-3 bg-white text-neutral-900 border border-neutral-200 shadow-lg">
                        <p className="font-semibold leading-snug text-neutral-800 mb-2">{QUESTION_TYPE_META[type].description}</p>
                        <ul className="space-y-1 max-h-48 overflow-y-auto pr-1">
                          {userMessages
                            .filter((m: any) => classifyQuestion(m.content) === type)
                            .map((m: any, i: number) => (
                              <li key={i} className="text-[11px] text-neutral-500">"{m.content}"</li>
                            ))}
                        </ul>
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
                </TooltipProvider>
                <div className="flex h-2 rounded-full overflow-hidden gap-px">
                  {QUESTION_TYPES.filter((t) => counts[t] > 0).map((type) => {
                    const pct = (counts[type] / total) * 100;
                    const bg: Record<string, string> = {
                      Factual: "bg-blue-400", Conceptual: "bg-sky-400", Analytical: "bg-amber-400",
                      Evaluative: "bg-orange-400", Creative: "bg-violet-400",
                      "Help/Clarify": "bg-neutral-300", Other: "bg-neutral-200",
                    };
                    return <div key={type} className={`${bg[type]}`} style={{ width: `${pct}%` }} title={`${type}: ${counts[type]}`} />;
                  })}
                </div>
              </div>
            );
          })()}

          <div className="bg-neutral-50 px-8 py-8 space-y-6">
            {messages.length === 0 ? (
              <p className="italic text-neutral-400">No chat history yet.</p>
            ) : (
              <>
                {(torchExpanded ? messages : messages.slice(0, 4)).map((msg: any, index: number) => (
                  <div key={index} className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}>
                    {msg.role === "user" && msg.bloomLevel && (
                      <span className="text-[10px] font-semibold uppercase tracking-widest text-neutral-400 mb-1 mr-1">{msg.bloomLevel}</span>
                    )}
                    {msg.role === "user" ? (
                      <div className="max-w-xl rounded-3xl bg-black text-white px-5 py-4 text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</div>
                    ) : (
                      <div className="max-w-2xl rounded-3xl bg-white border border-neutral-200 px-6 py-5 shadow-sm">
                        <p className="text-sm text-neutral-700 leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                      </div>
                    )}
                  </div>
                ))}
                {messages.length > 4 && (
                  <div className="flex justify-center pt-2">
                    <button
                      onClick={() => setTorchExpanded(v => !v)}
                      className="flex items-center gap-2 px-5 py-2.5 rounded-full border border-neutral-200 bg-white text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors shadow-sm"
                    >
                      {torchExpanded ? (
                        <><span>Collapse discussion</span><span className="text-xs">↑</span></>
                      ) : (
                        <><span>View all {messages.length} messages</span><span className="text-xs">↓</span></>
                      )}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
          <StageFeedbackPanel
            stage="TORCH"
            feedback={feedback["TORCH"]}
            onUpdate={(patch) => updateFeedback("TORCH", patch)}
            onRetry={() => retryFeedbackSave("TORCH")}
            showFormative={showFormativeFeedback}
            showSummative={showSummativeFeedback}
            readOnly={readOnlyFeedback}
            saveState={feedbackSaveStates.TORCH}
          />
          <div className="flex justify-end px-8 pb-5">
            <button onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} className="text-xs text-neutral-400 hover:text-neutral-700 transition-colors">↑ Back to top</button>
          </div>
        </section>

        {/* RESEARCH LOG */}
        <section id="section-research" data-testid="section-research" className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
          <div className="border-b border-neutral-200 px-8 py-6 flex flex-wrap items-start justify-between gap-3">
            <div><p className="text-xs uppercase tracking-[0.2em] text-sky-500 mb-2">RESEARCH LOG</p><h3 className="text-2xl font-semibold tracking-tight">Sources & Research Notes</h3><p className="text-sm text-neutral-500 mt-1">{researchSources.length} source{researchSources.length !== 1 ? "s" : ""} logged</p></div>
            {stageExport("RESEARCH", "section-research", [[
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
            ], ...researchSources.map((source: any) => [
              researchSourceOrigin(source),
              source.mapContext?.investigation ?? "",
              Array.isArray(source.mapContext?.sourceTypes) ? source.mapContext.sourceTypes.join("; ") : "",
              source.mapContext?.plannedSource ?? "",
              [...(Array.isArray(source.mapContext?.verificationSelections) ? source.mapContext.verificationSelections : []), source.mapContext?.verification].filter(Boolean).join("; "),
              researchSourceText(source),
              researchSourceType(source),
              researchSourceDetails(source),
              source.findings ?? "",
              source.importantPoints ?? "",
              source.reliability ?? "",
              source.usage ?? "",
              researchAddedAt(source),
              researchLearningText(source),
              Array.isArray(source.trustworthinessSelections) ? source.trustworthinessSelections.join("; ") : "",
              source.effectSelection ?? "",
              source.isComplete ? "Complete" : "In progress",
            ])])}
          </div>
          {researchSources.length === 0 ? (
            <div className="p-8">
              <p className="italic text-neutral-400">No sources logged yet.</p>
            </div>
          ) : (
            <>
              <div className="space-y-3 bg-neutral-50/50 p-6">
                {(researchExpanded ? researchSources : researchSources.slice(0, 2)).map((entry: any, idx: number) => (
                  <details key={entry.id ?? idx} className="group overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-5 [&::-webkit-details-marker]:hidden">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-xs font-bold uppercase tracking-widest text-neutral-400">Source {idx + 1}</p>
                          <span
                            className="inline-flex max-w-full rounded-full border border-amber-200 bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900 break-words"
                            data-testid={`research-source-provenance-${idx}`}
                          >
                            {researchSourceOrigin(entry)}
                          </span>
                        <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${entry.isComplete ? "border-emerald-200 bg-emerald-100 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
                          {entry.isComplete ? "Complete" : "In progress"}
                        </span>
                        </div>
                        <p className="mt-2 truncate text-sm font-semibold text-neutral-800">
                          {researchSourceText(entry) || "Source name not recorded"}
                        </p>
                      </div>
                      <span className="flex shrink-0 items-center gap-2 text-xs font-semibold text-neutral-600">
                        <span>Review source</span>
                        <svg className="h-4 w-4 transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m6 9 6 6 6-6" />
                        </svg>
                      </span>
                    </summary>
                    <div className="space-y-4 border-t border-neutral-200 p-6">
                    {researchSourceText(entry) && (
                      <div>
                        <p className="text-xs font-medium text-neutral-400 mb-1">Source</p>
                        <p className="text-sm font-medium text-neutral-800 whitespace-pre-wrap break-words">
                          <LinkifiedText text={researchSourceText(entry)} />
                        </p>
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="inline-flex max-w-full rounded-full border border-sky-200 bg-sky-100 px-2.5 py-1 text-xs font-semibold text-sky-900 break-words"
                        data-testid={`research-source-type-${idx}`}
                      >
                        Actual source type: {researchSourceType(entry)}
                      </span>
                    </div>
                    {researchSourceDetails(entry) && (
                      <div className="rounded-2xl border border-sky-100 bg-sky-50/60 p-4">
                        <p className="text-xs font-semibold uppercase tracking-wider text-sky-800/70 mb-1">How to find this source</p>
                        <p className="text-sm text-neutral-800 whitespace-pre-wrap break-words" data-testid={`research-source-details-${idx}`}>
                          <LinkifiedText text={researchSourceDetails(entry)} />
                        </p>
                      </div>
                    )}
                    {entry.mapContext && (
                      <details className="rounded-2xl border border-violet-200 bg-violet-50/60 p-4 space-y-3" data-testid={`research-map-context-${idx}`}>
                        <summary className="cursor-pointer list-none flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wider text-violet-800/70">My original plan</p>
                            <p className="mt-1 text-xs text-violet-900/70">Snapshot preserved when the source was added to the Research Log.</p>
                          </div>
                          <span className="rounded-full border border-violet-200 bg-white px-2.5 py-1 text-[10px] font-semibold text-violet-900">Show planning evidence</span>
                        </summary>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full border border-violet-200 bg-white px-2.5 py-1 text-[10px] font-semibold text-violet-900">Planned, not the recorded source</span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div className="min-w-0">
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-violet-800/70">What to investigate</p>
                            <p className="mt-1 text-sm text-neutral-800 whitespace-pre-wrap break-words">{entry.mapContext.investigation || <span className="italic text-neutral-400">Not added in MAP</span>}</p>
                          </div>
                          <div className="min-w-0">
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-violet-800/70">Planned source or link</p>
                            <p className="mt-1 text-sm text-neutral-800 whitespace-pre-wrap break-words">
                              {entry.mapContext.plannedSource || <span className="italic text-neutral-400">Not added in MAP</span>}
                            </p>
                          </div>
                          <div className="min-w-0">
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-violet-800/70">Planned source types</p>
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              {Array.isArray(entry.mapContext.sourceTypes) && entry.mapContext.sourceTypes.length > 0
                                ? entry.mapContext.sourceTypes.map((sourceType: string) => (
                                  <span key={sourceType} className="max-w-full rounded-full border border-violet-200 bg-white px-2 py-1 text-xs text-violet-900 break-words">{sourceType}</span>
                                ))
                                : <span className="text-sm italic text-neutral-400">Not added in MAP</span>}
                            </div>
                          </div>
                          <div className="min-w-0">
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-violet-800/70">How to verify</p>
                            <div className="mt-1 flex flex-wrap gap-1.5 mb-1.5">
                              {Array.isArray(entry.mapContext.verificationSelections) && entry.mapContext.verificationSelections.length > 0 && entry.mapContext.verificationSelections.map((sel: string) => (
                                <span key={sel} className="max-w-full rounded-full border border-violet-200 bg-white px-2 py-1 text-xs text-violet-900 break-words">{sel}</span>
                              ))}
                            </div>
                            <p className="text-sm text-neutral-800 whitespace-pre-wrap break-words">{entry.mapContext.verification || (Array.isArray(entry.mapContext.verificationSelections) && entry.mapContext.verificationSelections.length > 0 ? "" : <span className="italic text-neutral-400">Not added in MAP</span>)}</p>
                          </div>
                          <div className="min-w-0 md:col-span-2">
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-violet-800/70">Added to Research Log</p>
                            <p className="mt-1 text-sm text-neutral-800">
                              {researchAddedAt(entry) ? new Date(researchAddedAt(entry)).toLocaleDateString("en-GB") : <span className="italic text-neutral-400">Not recorded for this older entry</span>}
                            </p>
                          </div>
                        </div>
                      </details>
                    )}
                    <div className="space-y-6">
                      <div className="rounded-2xl bg-neutral-50 border border-neutral-200 p-5 space-y-2">
                        <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500">1. What did they learn?</p>
                        <p className="text-sm whitespace-pre-wrap break-words">{researchLearningText(entry) || <span className="italic text-neutral-400">Not completed</span>}</p>
                      </div>

                      <div className="rounded-2xl bg-neutral-50 border border-neutral-200 p-5 space-y-4">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-2">2. Can you trust it?</p>
                          <div className="flex flex-wrap gap-1.5 mb-3">
                            {Array.isArray(entry.trustworthinessSelections) && entry.trustworthinessSelections.length > 0 ? (
                              entry.trustworthinessSelections.map((sel: string) => (
                                <span key={sel} className="inline-flex items-center rounded-lg bg-neutral-200/50 px-2.5 py-1 text-xs font-medium text-neutral-700">{sel}</span>
                              ))
                            ) : null}
                          </div>
                          <p className="text-sm whitespace-pre-wrap break-words">{entry.reliability || <span className="italic text-neutral-400">Not completed</span>}</p>
                        </div>
                      </div>

                      <div className="rounded-2xl bg-neutral-50 border border-neutral-200 p-5 space-y-4">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-2">3. How did it affect their thinking?</p>
                          {entry.effectSelection && (
                            <div className="mb-3">
                              <span className="inline-flex items-center rounded-lg bg-black px-2.5 py-1 text-xs font-medium text-white">{entry.effectSelection}</span>
                            </div>
                          )}
                          <p className="text-sm whitespace-pre-wrap break-words">{entry.usage || <span className="italic text-neutral-400">Not completed</span>}</p>
                        </div>
                      </div>
                    </div>
                    </div>
                  </details>
                ))}
              </div>
              {researchSources.length > 2 && (
                <div className="flex justify-center px-8 py-5">
                  <button
                    onClick={() => setResearchExpanded(v => !v)}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-full border border-neutral-200 bg-white text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors shadow-sm"
                  >
                    {researchExpanded ? (
                      <><span>Collapse research</span><span className="text-xs">↑</span></>
                    ) : (
                      <><span>View all {researchSources.length} sources</span><span className="text-xs">↓</span></>
                    )}
                  </button>
                </div>
              )}
            </>
          )}
          <StageFeedbackPanel
            stage="RESEARCH"
            feedback={feedback["RESEARCH"]}
            onUpdate={(patch) => updateFeedback("RESEARCH", patch)}
            onRetry={() => retryFeedbackSave("RESEARCH")}
            showFormative={showFormativeFeedback}
            showSummative={showSummativeFeedback}
            readOnly={readOnlyFeedback}
            saveState={feedbackSaveStates.RESEARCH}
          />
          <div className="flex justify-end px-8 pb-5">
            <button onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} className="text-xs text-neutral-400 hover:text-neutral-700 transition-colors">↑ Back to top</button>
          </div>
        </section>

        {/* COMPASS */}
        <section id="section-compass" data-testid="section-compass" className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
          <div className="border-b border-neutral-200 px-8 py-6 flex flex-wrap items-start justify-between gap-3">
            <div><p className="text-xs uppercase tracking-[0.2em] text-emerald-500 mb-2">COMPASS</p><h3 className="text-2xl font-semibold tracking-tight">Check Your Thinking</h3></div>
            {stageExport("COMPASS", "section-compass", [["Field", "Response"], ...Object.entries(compassEntry)])}
          </div>
          <div className="p-8 grid grid-cols-1 md:grid-cols-2 gap-6">
            {[
              { label: "Say it in your own words", value: compassEntry.check1 },
              { label: "The strongest challenge to your thinking", value: compassEntry.check2 },
              { label: "Where you're least confident", value: compassEntry.check3 },
              { label: "Is your evidence balanced?", value: compassEntry.check4 },
              { label: "Are you ready to write?", value: compassEntry.check5 },
            ].map((item, i) => (
              <div key={i}>
                <p className="text-sm font-medium mb-2 text-neutral-500">{item.label}</p>
                <div className="w-full rounded-2xl bg-neutral-50 border border-neutral-200 p-4 min-h-[80px] whitespace-pre-wrap text-sm">
                  {item.value || <span className="italic text-neutral-400">Not yet completed</span>}
                </div>
              </div>
            ))}
          </div>
          <StageFeedbackPanel
            stage="COMPASS"
            feedback={feedback["COMPASS"]}
            onUpdate={(patch) => updateFeedback("COMPASS", patch)}
            onRetry={() => retryFeedbackSave("COMPASS")}
            showFormative={showFormativeFeedback}
            showSummative={showSummativeFeedback}
            readOnly={readOnlyFeedback}
            saveState={feedbackSaveStates.COMPASS}
          />
          <div className="flex justify-end px-8 pb-5">
            <button onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} className="text-xs text-neutral-400 hover:text-neutral-700 transition-colors">↑ Back to top</button>
          </div>
        </section>

        {/* Final Answer — persisted internally as EMBED */}
        <section id="section-answer" data-testid="section-embed" className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
          <div className="border-b border-neutral-200 px-8 py-6 flex flex-wrap items-start justify-between gap-3">
            <div><p className="text-xs uppercase tracking-[0.2em] text-violet-500 mb-2">ANSWER</p><h3 className="text-2xl font-semibold tracking-tight">Final Answer & Reflection</h3></div>
            {stageExport("EMBED", "section-answer", [
              ["Field", "Response"],
              ["Final answer", answerReadableText(String(embedEntry.finalAnswer ?? ""))],
              ...supportingMaterialRows(embedEntry),
              ["What changed in your understanding?", embedEntry.q1],
              ["Where did you do the thinking?", embedEntry.q2],
              ["How did AI help your learning?", embedEntry.q3],
              ["What did you decide not to trust?", embedEntry.q4],
            ])}
          </div>
          {embedEntry.finalAnswer && (
            <div className="px-8 pt-8 pb-4">
              <p className="text-xs uppercase tracking-widest font-semibold text-violet-400 mb-2">Final Answer</p>
              <div className="w-full rounded-2xl bg-violet-50 border border-violet-100 p-5 text-sm leading-relaxed">
                <SafeFormattedText value={embedEntry.finalAnswer} />
              </div>
            </div>
          )}
          {embedEntry.supportingMaterials && (
            <div className="px-8 pb-4">
              <p className="text-xs uppercase tracking-widest font-semibold text-violet-400 mb-2">Existing supporting materials note</p>
              <div className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 p-5 whitespace-pre-wrap text-sm leading-relaxed">{embedEntry.supportingMaterials}</div>
            </div>
          )}
          {normaliseSupportingMaterialCards(embedEntry.supportingMaterialCards).map((card, index) => (
            <div key={index} className="mx-8 mb-4 rounded-2xl border border-violet-100 bg-violet-50/40 p-5">
              <p className="text-xs uppercase tracking-widest font-semibold text-violet-500 mb-3">Supporting material {index + 1}</p>
              <dl className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {[
                  ["Name of the material", card.name],
                  ["Type of material", card.type],
                  ["What does it show?", card.whatItShows],
                  ["Why is it relevant to the answer?", card.whyRelevant],
                  ["Where is it referred to in the Final Answer?", card.finalResponseReference],
                  ["How was it shared with the teacher?", card.sharingMethod],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs font-semibold uppercase tracking-wider text-neutral-500">{label}</dt>
                    <dd className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{value || <span className="italic text-neutral-400">Not recorded</span>}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
          <div className="p-8 grid grid-cols-1 md:grid-cols-2 gap-6">
            {[
              { label: "What changed in your understanding?", value: embedEntry.q1 },
              { label: "Where did YOU do the thinking?", value: embedEntry.q2 },
              { label: "How did AI help your learning?", value: embedEntry.q3 },
              { label: "What did you decide not to trust?", value: embedEntry.q4 },
            ].map((item, i) => (
              <div key={i}>
                <p className="text-sm font-medium mb-2 text-neutral-500">{item.label}</p>
                <div className="w-full rounded-2xl bg-neutral-50 border border-neutral-200 p-4 min-h-[80px] whitespace-pre-wrap text-sm">
                  {item.value || <span className="italic text-neutral-400">Not yet completed</span>}
                </div>
              </div>
            ))}
          </div>
          <StageFeedbackPanel
            stage="EMBED"
            feedback={feedback["EMBED"]}
            onUpdate={(patch) => updateFeedback("EMBED", patch)}
            onRetry={() => retryFeedbackSave("EMBED")}
            showFormative={showFormativeFeedback}
            showSummative={showSummativeFeedback}
            readOnly={readOnlyFeedback}
            saveState={feedbackSaveStates.EMBED}
          />
          <div className="flex justify-end px-8 pb-5">
            <button onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} className="text-xs text-neutral-400 hover:text-neutral-700 transition-colors">↑ Back to top</button>
          </div>
        </section>

        {/* OVERALL ASSESSMENT */}
        {showSummativeFeedback && <section
          className="rounded-[2rem] bg-white border-2 border-neutral-900 shadow-sm overflow-hidden"
          data-testid="section-overall-assessment"
        >
          <div className="border-b border-neutral-200 px-8 py-6 flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] font-semibold text-neutral-400 mb-1">Overall Assessment</p>
              <h3 className="text-2xl font-semibold tracking-tight">Summative Feedback & Overall Grade</h3>
            </div>
            {overallAssessment && (
              <button
                onClick={handleSynthesise}
                disabled={synthLoading}
                className="px-5 py-2.5 rounded-xl bg-violet-600 text-white text-sm font-semibold hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-wait"
              >
                {synthLoading ? "Generating…" : "Regenerate Overall Assessment"}
              </button>
            )}
          </div>

          {overallAssessment ? (
            <div className="px-8 py-8 space-y-6">
              <div>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs uppercase tracking-widest font-semibold text-neutral-400">Overall Grade</p>
                  {overallAssessment.grade && GRADES.includes(overallAssessment.grade as typeof GRADES[number]) ? (
                    <p className={`text-xs font-semibold ${GRADE_SELECTED_LABEL[overallAssessment.grade as typeof GRADES[number]]}`}>
                      ✓ {GRADE_LABEL[overallAssessment.grade as typeof GRADES[number]]} selected
                    </p>
                  ) : (
                    <p className="text-xs text-neutral-400 italic">None selected</p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {GRADES.map((g) => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => {
                        const updated = { ...overallAssessment, grade: g };
                        setOverallAssessment(updated);
                        overallAssessmentRef.current = updated;
                        void queueFeedbackSave("OVERALL", { grade: g, comment: updated.comment });
                      }}
                      className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-semibold border transition-all ${
                        overallAssessment.grade === g
                          ? GRADE_COLOR_ACTIVE[g]
                          : `${GRADE_COLOR[g]} opacity-50 hover:opacity-100`
                      }`}
                    >
                      {overallAssessment.grade === g && <span className="text-base leading-none">✓</span>}
                      {GRADE_LABEL[g]}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs uppercase tracking-widest font-semibold text-neutral-400 mb-3">Report Comment</p>
                <AutoTextarea
                  className="w-full rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm leading-relaxed resize-none focus:outline-none focus:ring-2 focus:ring-neutral-300"
                  value={overallAssessment.comment}
                  onChange={(e) => {
                    const updated = { ...overallAssessment, comment: e.target.value };
                    setOverallAssessment(updated);
                    overallAssessmentRef.current = updated;
                    clearTimeout(saveTimers.current["OVERALL"]);
                    saveTimers.current["OVERALL"] = setTimeout(() => {
                      void queueFeedbackSave("OVERALL", { grade: updated.grade, comment: updated.comment }).catch(() => undefined);
                    }, 800);
                  }}
                />
                <p className="text-xs text-neutral-400 mt-2">Edits are auto-saved. This comment is suitable for copying directly into your MIS.</p>
              </div>
            </div>
          ) : (
            <div className="px-8 py-12 text-center text-neutral-400 text-sm space-y-4">
              <p className="mb-2 text-2xl">✦</p>
              <p>Add grades and comments to each stage above, then generate an AI-synthesised overall assessment and MIS-ready report comment.</p>
              <button
                type="button"
                onClick={() => {
                  const emptyAssessment = { grade: "", comment: "" };
                  setOverallAssessment(emptyAssessment);
                  overallAssessmentRef.current = emptyAssessment;
                }}
                className="rounded-xl border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:border-neutral-500 hover:text-black transition-colors"
              >
                Enter assessment manually
              </button>
            </div>
          )}
        </section>}

      </main>
      {studentMessagesOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="student-messages-title"
          onClick={() => setStudentMessagesOpen(false)}
        >
          <section
            className="flex max-h-[min(720px,calc(100vh-2rem))] w-full max-w-3xl flex-col overflow-hidden rounded-[2rem] bg-white shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-neutral-200 px-6 py-5">
              <div>
                <h2 id="student-messages-title" className="text-xl font-semibold text-neutral-900">Student Messages</h2>
                <p className="mt-1 text-sm text-neutral-500">Teacher–student messages for this Climb.</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleDownloadStudentMessagesPdf()}
                  disabled={studentMessagesLoading}
                  className="rounded-xl border border-neutral-300 px-3 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
                >
                  Download PDF
                </button>
                <button
                  type="button"
                  onClick={() => downloadTeacherMessagesCsv(studentMessages)}
                  disabled={studentMessagesLoading}
                  className="rounded-xl border border-neutral-300 px-3 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
                >
                  Download CSV
                </button>
                <button
                  type="button"
                  onClick={() => setStudentMessagesOpen(false)}
                  className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-100"
                  aria-label="Close Student Messages"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="min-h-0 overflow-y-auto px-6 py-5">
              {studentMessagesLoading ? (
                <p className="text-sm text-neutral-500">Loading messages…</p>
              ) : studentMessagesError ? (
                <p className="text-sm text-red-600" role="alert">{studentMessagesError}</p>
              ) : studentMessages.length === 0 ? (
                <p className="text-sm text-neutral-500">None recorded</p>
              ) : (
                <div className="space-y-4">
                  {studentMessages.map((message) => (
                    <article key={message.id} className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <p className="text-sm font-semibold text-neutral-800">
                          {message.senderType === "teacher" ? "Teacher" : "Student"}
                        </p>
                        <time
                          className="text-xs text-neutral-500"
                          dateTime={message.createdAt}
                        >
                          {new Date(message.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
                        </time>
                      </div>
                      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-neutral-800">{message.content}</p>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
