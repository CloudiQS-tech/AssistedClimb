import React, { useState } from "react";
import { apiFetch, apiFetchBlob } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

const VALID_STATUSES = [
  "Acted upon",
  "Partly acted upon",
  "No related change found",
  "Not enough evidence",
  "Teacher review needed",
  "No action requested",
] as const;

const STATUS_STYLES: Record<string, string> = {
  "Acted upon": "border-emerald-200 bg-emerald-50 text-emerald-800",
  "Partly acted upon": "border-amber-200 bg-amber-50 text-amber-800",
  "No related change found": "border-neutral-200 bg-neutral-50 text-neutral-700",
  "Not enough evidence": "border-neutral-200 bg-neutral-50 text-neutral-700",
  "Teacher review needed": "border-violet-200 bg-violet-50 text-violet-800",
  "No action requested": "border-sky-200 bg-sky-50 text-sky-800",
};

function FeedbackConclusion({ item }: { item: any }) {
  const status = VALID_STATUSES.includes(item?.status) ? item.status : null;
  return (
    <li className="rounded-xl border border-neutral-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm leading-6 text-neutral-700">
          <span className="font-semibold text-neutral-900">Feedback: </span>
          {item?.feedbackPoint || item?.conclusion || "Feedback point unavailable"}
        </p>
      </div>
      <p className="mt-2 text-sm leading-6 text-neutral-700">
        <span className="font-semibold text-neutral-900">Later evidence: </span>
        {item?.laterEvidence || "The available evidence is insufficient."}
      </p>
      <div className="mt-2 flex flex-wrap items-start gap-2 text-sm leading-6 text-neutral-700">
        <span className="font-semibold text-neutral-900">Conclusion: </span>
        {status && (
          <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLES[status]}`}>
            {status}
          </span>
        )}
        {item?.conclusion && item.conclusion !== item.feedbackPoint && <span>{item.conclusion}</span>}
      </div>
    </li>
  );
}

function TeacherNextSteps({ items }: { items: string[] }) {
  if (!items.length) {
    return <p className="text-sm italic text-neutral-500">No specific next step was identified from the available evidence.</p>;
  }
  return (
    <ul className="list-disc space-y-2 pl-5 text-sm leading-6 text-neutral-700">
      {items.map((item, index) => <li key={index}>{item}</li>)}
    </ul>
  );
}

export function DevelopmentAnalysisPanel({
  analysis,
  classId,
  sessionId,
  studentName,
  taskTitle,
  assessmentFinalised = true,
  onAnalysisComplete,
}: {
  analysis: any;
  classId?: string;
  sessionId?: string;
  studentName?: string;
  taskTitle?: string;
  assessmentFinalised?: boolean;
  onAnalysisComplete: (newAnalysis: any) => void;
}) {
  const [analyzing, setAnalyzing] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const { toast } = useToast();

  if (!analysis) return null;

  const canGenerate = assessmentFinalised && analysis.assessmentFinalised !== false;
  const aiReport = analysis.report || analysis.latestReport || analysis.aiReport?.latestReport || analysis.aiReport || {};
  const formative = aiReport.climbDevelopment || {};
  const aiFeedback = aiReport.finalAnswerDevelopment || {};
  const generatedAt = analysis.generatedAt || aiReport.generatedAt || null;
  const status = analysis.status || analysis.aiReport?.status || "none";
  const hasStoredReport = Boolean(
    (analysis.report || analysis.latestReport || analysis.aiReport?.latestReport)
    && aiReport.reportVersion === 5
    && status !== "requires_regeneration"
  );
  const requiresRegeneration = status === "requires_regeneration"
    || (Boolean(analysis.report || analysis.latestReport || analysis.aiReport?.latestReport) && aiReport.reportVersion !== 5);
  const isPending = status === "pending" || status === "in_progress";
  const hasFailed = status === "failed" || status === "error";

  const topLevelConclusions = Array.isArray(aiReport.feedbackConclusions)
    ? aiReport.feedbackConclusions
    : [];
  const formativeFallback = topLevelConclusions.filter((item: any) => item.phase === "formative");
  const aiFallback = topLevelConclusions.filter((item: any) =>
    ["ai_feedback_one", "ai_feedback_two", "overall"].includes(item.phase)
  );
  const formativeConclusions = Array.isArray(formative.feedbackConclusions)
    ? formative.feedbackConclusions
    : formativeFallback;
  const aiConclusions = Array.isArray(aiFeedback.feedbackConclusions)
    ? aiFeedback.feedbackConclusions
    : aiFallback;
  const aiFeedbackOneConclusions = aiConclusions.filter((item: any) => item.phase === "ai_feedback_one");
  const aiFeedbackTwoConclusions = aiConclusions.filter((item: any) => item.phase === "ai_feedback_two");
  const overallConclusions = aiConclusions.filter((item: any) => item.phase === "overall");
  const teacherNextSteps = Array.isArray(aiReport.teacherNextSteps) ? aiReport.teacherNextSteps : [];
  const cautions = Array.isArray(aiReport.cautions) ? aiReport.cautions : [];

  const handleGenerate = async () => {
    if (!classId || !sessionId) return;
    setAnalyzing(true);
    try {
      const response = await apiFetch(
        `/teacher/classes/${classId}/students/${sessionId}/development-analysis/analyse`,
        { method: "POST" }
      );
      if (response) {
        onAnalysisComplete({ ...analysis, ...response });
        setReportOpen(true);
        toast({
          title: "Development report generated",
          description: "The complete two-section report is ready.",
        });
      }
    } catch (error: any) {
      toast({
        title: "Report generation failed",
        description: error.message || "The stored evidence was not changed. Please try again.",
        variant: "destructive",
      });
    } finally {
      setAnalyzing(false);
    }
  };

  const handleDownloadPdf = async () => {
    if (!classId || !sessionId) return;
    try {
      const blob = await apiFetchBlob(
        `/teacher/classes/${classId}/students/${sessionId}/development-analysis/report.pdf`
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `development-report-${studentName || "student"}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error: any) {
      toast({
        title: "PDF download failed",
        description: error.message || "The stored report could not be downloaded.",
        variant: "destructive",
      });
    }
  };

  return (
    <section
      className="rounded-[2rem] border-2 border-sky-200 bg-white shadow-sm"
      data-testid="section-development-analysis"
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-sky-100 bg-sky-50 px-8 py-6">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-[0.2em] text-sky-700">Teacher view</p>
          <h2 className="text-2xl font-semibold tracking-tight text-sky-950">Development report</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-sky-950/70">
            What changed, and how the later work corresponds with the feedback received.
          </p>
        </div>

        <div className="flex flex-wrap gap-2 no-print">
          {!hasStoredReport && canGenerate ? (
            <button
              type="button"
              onClick={handleGenerate}
              disabled={analyzing || isPending}
              className="rounded-xl bg-sky-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-sky-800 disabled:opacity-50"
              data-testid="button-generate-development-report"
            >
              {analyzing || isPending
                ? "Generating…"
                : requiresRegeneration
                  ? "Generate corrected final report"
                  : "Generate development report"}
            </button>
          ) : hasStoredReport ? (
            <>
              <button
                type="button"
                onClick={() => setReportOpen((open) => !open)}
                className="rounded-xl bg-sky-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-sky-800"
                data-testid="button-view-development-report"
              >
                {reportOpen ? "Hide development report" : "View development report"}
              </button>
              <button
                type="button"
                onClick={handleDownloadPdf}
                className="rounded-xl border border-neutral-300 bg-white px-4 py-2.5 text-sm font-semibold text-neutral-800 hover:bg-neutral-50"
                data-testid="button-download-development-report"
              >
                Download PDF
              </button>
            </>
          ) : null}
        </div>
      </div>

      {requiresRegeneration && (
        <div className="mx-8 my-7 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
          This record contains an older report format. It may be replaced once by the corrected final report; after that, it cannot be regenerated.
        </div>
      )}

      {!hasStoredReport && (
        <div className="px-8 py-7">
          <p className="text-sm text-neutral-600">
            {hasFailed
              ? "The previous report attempt failed. The preserved student work remains unchanged."
              : canGenerate
                ? "Generate one stored report from the preserved formative, summative and answer evidence."
                : "The development report becomes available after summative assessment finalisation."}
          </p>
        </div>
      )}

      {hasStoredReport && (
        <div
          id="development-report-print"
          className={reportOpen ? "px-8 py-8" : "hidden px-8 py-8"}
          data-testid="development-report-content"
        >
          <header className="border-b border-neutral-200 pb-6">
            <h1 className="text-3xl font-semibold tracking-tight text-neutral-950">Development report</h1>
            <p className="mt-2 text-sm text-neutral-600">
              {studentName || "Student"} · {taskTitle || "Assisted Climb task"}
            </p>
            <p className="mt-1 text-xs text-neutral-500">
              Generated {generatedAt ? new Date(generatedAt).toLocaleDateString("en-GB") : "date unavailable"}
            </p>
            <p className="mt-4 max-w-3xl text-sm leading-6 text-neutral-700">
              This report examines how the student’s work changed across preserved versions and whether later work
              contains evidence related to the formative and AI feedback received.
            </p>
          </header>

          <section className="mt-8">
            <h2 className="text-2xl font-semibold text-sky-950">Overall development</h2>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-neutral-700">
              {aiReport.overallDevelopment}
            </p>
          </section>

          <section className="mt-10 border-t border-neutral-200 pt-8">
            <h2 className="text-2xl font-semibold text-sky-950">Development across the Assisted Climb</h2>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-neutral-700">{formative.narrative}</p>

            <h3 className="mt-6 text-base font-semibold text-neutral-950">Response to formative feedback</h3>
            <p className="mt-2 max-w-3xl text-sm leading-7 text-neutral-700">{formative.feedbackNarrative}</p>
            {formativeConclusions.length > 0 ? (
              <ul className="mt-4 space-y-3">
                {formativeConclusions.map((item: any, index: number) => (
                  <FeedbackConclusion key={index} item={item} />
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm italic text-neutral-500">
                No feedback conclusion was recorded for this section.
              </p>
            )}

          </section>

          <section className="mt-10 border-t border-neutral-200 pt-8">
            <h2 className="text-2xl font-semibold text-sky-950">Development across the final answers</h2>

            <h3 className="mt-6 text-base font-semibold text-neutral-950">After AI feedback one</h3>
            <p className="mt-2 max-w-3xl text-sm leading-7 text-neutral-700">{aiFeedback.afterFeedbackOne}</p>
            {aiFeedbackOneConclusions.length > 0 && (
              <ul className="mt-4 space-y-3">
                {aiFeedbackOneConclusions.map((item: any, index: number) => (
                  <FeedbackConclusion key={index} item={item} />
                ))}
              </ul>
            )}

            <h3 className="mt-6 text-base font-semibold text-neutral-950">After AI feedback two</h3>
            <p className="mt-2 max-w-3xl text-sm leading-7 text-neutral-700">{aiFeedback.afterFeedbackTwo}</p>
            {aiFeedbackTwoConclusions.length > 0 && (
              <ul className="mt-4 space-y-3">
                {aiFeedbackTwoConclusions.map((item: any, index: number) => (
                  <FeedbackConclusion key={index} item={item} />
                ))}
              </ul>
            )}

            <h3 className="mt-6 text-base font-semibold text-neutral-950">Overall answer development</h3>
            <p className="mt-2 max-w-3xl text-sm leading-7 text-neutral-700">{aiFeedback.overallAnswerDevelopment}</p>
            {overallConclusions.length > 0 ? (
              <ul className="mt-3 space-y-3">
                {overallConclusions.map((item: any, index: number) => (
                  <FeedbackConclusion key={index} item={item} />
                ))}
              </ul>
            ) : null}

          </section>

          <section className="mt-10 border-t border-neutral-200 pt-8">
            <h2 className="text-2xl font-semibold text-sky-950">Teacher next steps</h2>
            <div className="mt-3"><TeacherNextSteps items={teacherNextSteps} /></div>
          </section>

          <aside className="mt-10 rounded-xl border border-neutral-200 bg-neutral-50 p-5 text-sm leading-6 text-neutral-600">
            <h2 className="font-semibold text-neutral-800">Cautions and evidence limitations</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {cautions.map((item: string, index: number) => <li key={index}>{item}</li>)}
              <li>
                The report identifies correspondence between feedback and later changes. It cannot prove causation,
                improvement or attainment.
              </li>
            </ul>
          </aside>
        </div>
      )}
    </section>
  );
}