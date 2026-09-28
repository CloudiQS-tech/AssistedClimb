import { useEffect, useState } from "react";
import { Link, useRoute } from "wouter";
import { apiFetch, apiFetchBlob, downloadBlob } from "@/lib/api";

const ACTIVITY_STAGES = ["MAP", "TORCH", "RESEARCH", "COMPASS", "EMBED"] as const;
const ACTIVITY_SUMMARY_STAGES = ["MAP", "TORCH", "RESEARCH", "COMPASS"] as const;
const ACTIVITY_STAGE_LABEL: Record<(typeof ACTIVITY_STAGES)[number], string> = {
  MAP: "MAP",
  TORCH: "TORCH",
  RESEARCH: "RESEARCH",
  COMPASS: "COMPASS",
  EMBED: "Final Answer",
};

function formatDuration(seconds: number) {
  const totalSeconds = Math.max(0, Math.round(Number(seconds) || 0));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function csvCell(value: unknown) {
  const rawValue = String(value ?? "");
  const safeValue = `'${rawValue}`;
  return `"${safeValue.replace(/"/g, '""')}"`;
}

function downloadCsv(rows: Array<unknown[]>, filename: string) {
  const csv = rows
    .map((row) => row.map((value) => csvCell(value)).join(","))
    .join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function TeacherStudentActivity() {
  const [, params] = useRoute("/teacher/class/:classId/student/:sessionId/activity");
  const classId = params?.classId;
  const sessionId = params?.sessionId;
  const [student, setStudent] = useState<any>(null);
  const [activity, setActivity] = useState<any>(null);
  const [analysis, setAnalysis] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [analysing, setAnalysing] = useState(false);
  const [error, setError] = useState("");
  const [analysisError, setAnalysisError] = useState("");
  const [activityReportOpen, setActivityReportOpen] = useState(true);
  const [analysisReportOpen, setAnalysisReportOpen] = useState(true);

  useEffect(() => {
    if (!classId || !sessionId) return;
    Promise.all([
      apiFetch(`/teacher/classes/${classId}/students/${sessionId}`),
      apiFetch(`/teacher/classes/${classId}/students/${sessionId}/activity`),
    ])
      .then(([studentData, activityData]) => {
        setStudent(studentData.session);
        setActivity(activityData);
      })
      .catch((err: any) => setError(err.message ?? "Unable to load student activity."))
      .finally(() => setLoading(false));
  }, [classId, sessionId]);

  if (loading) {
    return <div className="min-h-[100dvh] bg-neutral-50 p-8 text-sm text-neutral-500">Loading student activity…</div>;
  }

  if (error || !student || !activity) {
    return (
      <div className="min-h-[100dvh] bg-neutral-50 p-8">
        <p className="text-sm text-red-600" role="alert">{error || "Student activity not found."}</p>
        <Link href={`/teacher/class/${classId}/student/${sessionId}`} className="mt-4 inline-block text-sm underline">
          Back to student climb
        </Link>
      </div>
    );
  }

  const activityCsv = () => {
    const rows: Array<unknown[]> = [
      ["Date", "Duration", ...ACTIVITY_STAGES.map((stage) => `${stage} time`)],
    ];
    (activity.entries ?? []).forEach((entry: any) => {
      const date = new Date(entry.startedAt);
      rows.push([
        date.toLocaleDateString(),
        formatDuration(entry.durationSeconds ?? 0),
        ...ACTIVITY_STAGES.map((stage) => formatDuration(
          entry.pageDurations?.find((page: any) => page.stage === stage)?.durationSeconds ?? 0,
        )),
      ]);
    });
    rows.push([
      "All activity periods",
      "",
      formatDuration(activity.summary?.totalSeconds ?? 0),
      ...ACTIVITY_STAGES.map((stage) => formatDuration(
        activity.summary?.pageDurations?.find((page: any) => page.stage === stage)?.durationSeconds ?? 0,
      )),
    ]);
    return rows;
  };

  const analysisCsv = () => {
    const rows: Array<unknown[]> = [["Section", "Finding"]];
    if (analysis?.summary) rows.push(["Summary", analysis.summary]);
    for (const item of analysis?.observations ?? []) rows.push(["Recorded activity observations", item]);
    for (const item of analysis?.stagePatterns ?? []) rows.push(["Stage patterns", item]);
    for (const item of analysis?.researchConsiderations ?? []) rows.push(["Research considerations", item]);
    return rows;
  };

  const handleAnalyse = async () => {
    setAnalysing(true);
    setAnalysisError("");
    try {
      const result = await apiFetch(`/teacher/classes/${classId}/students/${sessionId}/activity/analyze`, { method: "POST" });
      setAnalysis(result);
    } catch (err: any) {
      setAnalysisError(err.message ?? "Activity analysis is temporarily unavailable.");
    } finally {
      setAnalysing(false);
    }
  };

  const handleDownloadPdf = async () => {
    const sections = ["section-activity", "student-activity-analysis"]
      .map((id) => document.getElementById(id))
      .filter((section): section is HTMLElement => Boolean(section));
    if (sections.length === 0) return;
    const content = document.createElement("div");
    sections.forEach((section) => {
      const clone = section.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("button, form, [data-export-controls]").forEach((element) => element.remove());
      clone.querySelectorAll(".report-collapsible-content").forEach((element) => element.classList.remove("hidden"));
      content.append(clone);
    });
    const text = (content.innerText || content.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) return;
    try {
      const blob = await apiFetchBlob("/teacher/export/pdf", {
        method: "POST",
        body: JSON.stringify({ title: `${student.studentName} Climb Activity`, text }),
      });
      downloadBlob(blob, `${student.studentName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-activity.pdf`);
    } catch (err: any) {
      setError(err?.message ?? "Student activity PDF could not be downloaded.");
    }
  };
  const summaryStageDurations = ACTIVITY_SUMMARY_STAGES.map((stage) => ({
    stage,
    seconds: Number(
      activity.summary?.pageDurations?.find((page: any) => page.stage === stage)?.durationSeconds ?? 0,
    ),
  }));
  const longestStageSeconds = Math.max(1, ...summaryStageDurations.map(({ seconds }) => seconds));

  return (
    <div className="min-h-[100dvh] bg-neutral-50 text-neutral-900 font-sans pb-20">
      <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-6 py-4 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 text-sm">
            <Link href="/teacher/dashboard" className="text-neutral-500 hover:text-black">Dashboard</Link>
            <span className="text-neutral-300">/</span>
            <Link href={`/teacher/class/${classId}`} className="text-neutral-500 hover:text-black">Class View</Link>
            <span className="text-neutral-300">/</span>
            <Link href={`/teacher/class/${classId}/student/${sessionId}`} className="text-neutral-500 hover:text-black [overflow-wrap:anywhere]">
              {student.studentName}
            </Link>
            <span className="text-neutral-300">/</span>
            <span className="font-medium">Climb Activity</span>
          </div>
          <Link
            href={`/teacher/class/${classId}/student/${sessionId}`}
            className="shrink-0 rounded-2xl border border-neutral-300 px-5 py-2 text-sm font-medium hover:bg-neutral-100 transition-colors"
            data-testid="button-back-to-student-climb"
          >
            Back to Student Climb
          </Link>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-12 space-y-8">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-2">Student activity</p>
          <h1 className="text-3xl font-semibold tracking-tight">{student.studentName}'s Climb Activity</h1>
          <p className="mt-2 text-sm text-neutral-500">A separate record of time spent working through each Climb page.</p>
        </div>

        <section id="section-activity" data-testid="section-activity" className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
          <div className="border-b border-neutral-200 px-8 py-6 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-2">Activity</p>
              <h2 className="text-2xl font-semibold tracking-tight">Climb activity</h2>
            </div>
            <div className="flex flex-wrap gap-2 print:hidden">
              <button
                type="button"
                onClick={() => setActivityReportOpen((open) => !open)}
                aria-expanded={activityReportOpen}
                aria-controls="student-activity-report-content"
                className="rounded-xl border border-neutral-300 px-3 py-2 text-xs font-semibold hover:bg-neutral-50"
                data-testid="button-toggle-student-activity-report"
              >
                <span aria-hidden="true">{activityReportOpen ? "−" : "+"}</span> {activityReportOpen ? "Collapse report" : "Expand report"}
              </button>
              <button
                type="button"
                onClick={() => void handleDownloadPdf()}
                className="rounded-xl border border-neutral-300 px-3 py-2 text-xs font-semibold hover:bg-neutral-50"
              >
                Download PDF
              </button>
              <button
                type="button"
                onClick={() => downloadCsv(activityCsv(), `${student.studentName.replace(/\s+/g, "-").toLowerCase()}-activity.csv`)}
                className="rounded-xl border border-neutral-300 px-3 py-2 text-xs font-semibold hover:bg-neutral-50"
              >
                Download CSV
              </button>
              <button
                type="button"
                onClick={handleAnalyse}
                disabled={analysing || (activity.entries ?? []).length === 0}
                className="rounded-xl bg-neutral-900 px-3 py-2 text-xs font-semibold text-white hover:bg-neutral-700 disabled:cursor-wait disabled:opacity-40"
              >
                {analysing ? "Analysing…" : analysis ? "Re-analyse" : "Analyse with AI"}
              </button>
            </div>
          </div>
          <div id="student-activity-report-content" className={`${activityReportOpen ? "" : "hidden"} report-collapsible-content p-8`}>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-6">
              <div className="rounded-xl bg-neutral-50 p-4"><p className="text-xs text-neutral-500">Activity periods</p><p className="text-xl font-semibold">{activity.summary?.totalSessions ?? 0}</p></div>
              <div className="rounded-xl bg-neutral-50 p-4"><p className="text-xs text-neutral-500">Login sessions</p><p className="text-xl font-semibold">{activity.summary?.loginSessionsAvailable ? activity.summary.loginSessionCount : "Not available"}</p></div>
              <div className="rounded-xl bg-neutral-50 p-4"><p className="text-xs text-neutral-500">Total time</p><p className="text-xl font-semibold">{formatDuration(activity.summary?.totalSeconds ?? 0)}</p></div>
              <div className="rounded-xl bg-neutral-50 p-4"><p className="text-xs text-neutral-500">Average login session</p><p className="text-xl font-semibold">{activity.summary?.loginSessionsAvailable ? formatDuration(activity.summary.averageLoginSessionSeconds ?? 0) : "Not available"}</p></div>
            </div>
            <div className="mb-6 rounded-2xl border border-neutral-200 bg-neutral-50 p-5">
              <div className="flex flex-wrap items-start justify-between gap-2 mb-4">
                <div>
                  <h3 className="text-sm font-semibold">Time by Climb stage</h3>
                  <p className="text-xs text-neutral-500 mt-1">How the recorded time was distributed across the main stages.</p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {summaryStageDurations.map(({ stage, seconds }) => (
                  <div key={stage} className="rounded-xl bg-white border border-neutral-200 p-4 min-w-0">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500 truncate">{ACTIVITY_STAGE_LABEL[stage]}</p>
                      <p className="text-sm font-semibold whitespace-nowrap">{formatDuration(seconds)}</p>
                    </div>
                    <div className="mt-3 h-2 rounded-full bg-neutral-100 overflow-hidden" aria-hidden="true">
                      <div className="h-full rounded-full bg-violet-400" style={{ width: `${Math.min(100, (seconds / longestStageSeconds) * 100)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <p className="text-xs leading-relaxed text-neutral-500">
              Activity periods may stop and restart because of inactivity, reload, or reconnection. A login session is counted once only after that authenticated login records a Climb interaction. Historical or mixed login-session figures remain unavailable.
            </p>
            {(activity.entries ?? []).length === 0 && <p className="mt-4 text-sm text-neutral-500">No activity recorded yet.</p>}
          </div>
        </section>

        <section id="student-activity-analysis" data-testid="student-activity-analysis" className="rounded-[2rem] bg-white border-2 border-neutral-900 shadow-sm overflow-hidden">
          <div className="border-b border-neutral-200 px-8 py-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] font-semibold text-neutral-400 mb-1">AI analysis</p>
              <h2 className="text-2xl font-semibold tracking-tight">Recorded activity interpretation</h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-neutral-500">
                This describes recorded interaction patterns only. It is not a judgement of ability, effort, motivation, or attainment.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 print:hidden">
              <button
                type="button"
                onClick={() => setAnalysisReportOpen((open) => !open)}
                aria-expanded={analysisReportOpen}
                aria-controls="student-activity-analysis-content"
                className="rounded-xl border border-neutral-300 px-3 py-2 text-xs font-semibold hover:bg-neutral-50"
                data-testid="button-toggle-student-activity-analysis"
              >
                <span aria-hidden="true">{analysisReportOpen ? "−" : "+"}</span> {analysisReportOpen ? "Collapse report" : "Expand report"}
              </button>
              <button
                type="button"
                onClick={handleAnalyse}
                disabled={analysing || (activity.entries ?? []).length === 0}
                className="rounded-xl bg-neutral-900 px-3 py-2 text-xs font-semibold text-white hover:bg-neutral-700 disabled:cursor-wait disabled:opacity-40"
              >
                {analysing ? "Analysing…" : analysis ? "Re-analyse" : "Analyse with AI"}
              </button>
              <button
                type="button"
                onClick={() => downloadCsv(analysisCsv(), `${student.studentName.replace(/\s+/g, "-").toLowerCase()}-activity-analysis.csv`)}
                disabled={!analysis}
                className="rounded-xl border border-neutral-300 px-3 py-2 text-xs font-semibold hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Download CSV
              </button>
            </div>
          </div>
          <div id="student-activity-analysis-content" className={`${analysisReportOpen ? "" : "hidden"} report-collapsible-content`}>
          {analysisError && <p className="mx-8 mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{analysisError}</p>}
          {analysis ? (
            <div className="space-y-6 p-8">
              <p className="leading-relaxed text-neutral-700">{analysis.summary}</p>
              <div className="grid gap-6 md:grid-cols-2">
                <div className="rounded-2xl border border-sky-100 bg-sky-50 p-5">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-sky-600">What the figures show</p>
                  <ul className="space-y-2">
                    {(analysis.observations ?? []).map((item: string, index: number) => (
                      <li key={index} className="flex gap-2 text-sm leading-relaxed text-sky-950"><span className="font-bold text-sky-500">{index + 1}.</span>{item}</li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-2xl border border-violet-100 bg-violet-50 p-5">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-violet-600">Stage patterns</p>
                  <ul className="space-y-2">
                    {(analysis.stagePatterns ?? []).map((item: string, index: number) => (
                      <li key={index} className="flex gap-2 text-sm leading-relaxed text-violet-950"><span className="font-bold text-violet-500">{index + 1}.</span>{item}</li>
                    ))}
                  </ul>
                </div>
              </div>
              <div className="rounded-2xl border border-amber-100 bg-amber-50 p-5">
                <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-amber-600">Research considerations</p>
                <ul className="space-y-2">
                  {(analysis.researchConsiderations ?? []).map((item: string, index: number) => (
                    <li key={index} className="flex gap-2 text-sm leading-relaxed text-amber-950"><span className="font-bold text-amber-500">{index + 1}.</span>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <div className="p-8 text-sm text-neutral-500">
              Generate an evidence-led interpretation of this student&apos;s recorded activity when you are ready.
            </div>
          )}
          </div>
        </section>
      </main>
    </div>
  );
}