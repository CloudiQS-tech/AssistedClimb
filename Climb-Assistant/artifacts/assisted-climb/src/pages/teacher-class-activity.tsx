import { useEffect, useState } from "react";
import { Link, useRoute } from "wouter";
import { apiFetch, apiFetchBlob, downloadBlob } from "@/lib/api";

const ACTIVITY_STAGES = ["MAP", "TORCH", "RESEARCH", "COMPASS", "EMBED"] as const;
const STAGE_LABEL: Record<(typeof ACTIVITY_STAGES)[number], string> = {
  MAP: "MAP",
  TORCH: "TORCH",
  RESEARCH: "Research",
  COMPASS: "Compass",
  EMBED: "Final Answer",
};
const STAGE_COLOR: Record<(typeof ACTIVITY_STAGES)[number], string> = {
  MAP: "bg-neutral-400",
  TORCH: "bg-amber-400",
  RESEARCH: "bg-sky-400",
  COMPASS: "bg-emerald-400",
  EMBED: "bg-violet-400",
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
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function TeacherClassActivity() {
  const [, params] = useRoute("/teacher/class/:classId/activity");
  const classId = params?.classId;
  const [report, setReport] = useState<any>(null);
  const [analysis, setAnalysis] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [analysing, setAnalysing] = useState(false);
  const [error, setError] = useState("");
  const [analysisError, setAnalysisError] = useState("");
  const [reportOpen, setReportOpen] = useState(true);

  useEffect(() => {
    if (!classId) return;
    apiFetch(`/teacher/classes/${classId}/activity`)
      .then(setReport)
      .catch((err: any) => setError(err.message ?? "Unable to load class activity."))
      .finally(() => setLoading(false));
  }, [classId]);

  if (loading) {
    return <div className="min-h-[100dvh] bg-neutral-50 p-8 text-sm text-neutral-500">Loading class activity…</div>;
  }

  if (error || !report) {
    return (
      <div className="min-h-[100dvh] bg-neutral-50 p-8">
        <p className="text-sm text-red-600" role="alert">{error || "Class activity not found."}</p>
        <Link href={`/teacher/class/${classId}`} className="mt-4 inline-block text-sm underline">Back to class</Link>
      </div>
    );
  }

  const summary = report.summary;
  const students = report.students ?? [];
  const stageStats = report.summary?.stageStats ?? [];
  const longestStageSeconds = Math.max(1, ...stageStats.map((stage: any) => Number(stage.totalSeconds) || 0));

  const activityCsv = () => {
    const rows: Array<unknown[]> = [
      [
        "Student",
        "Activity periods",
        "Login sessions",
        "Total seconds",
        "Average login session seconds",
        "Longest login session seconds",
        "Dominant stage",
        ...ACTIVITY_STAGES.map((stage) => `${STAGE_LABEL[stage]} seconds`),
      ],
    ];
    students.forEach((student: any) => {
      rows.push([
        student.studentName,
        student.totalSessions,
        student.loginSessionsAvailable ? student.loginSessionCount : "Not available",
        student.totalSeconds,
        student.loginSessionsAvailable ? student.averageLoginSessionSeconds : "Not available",
        student.loginSessionsAvailable ? student.longestLoginSessionSeconds : "Not available",
        student.dominantStage ? STAGE_LABEL[student.dominantStage as keyof typeof STAGE_LABEL] : "",
        ...ACTIVITY_STAGES.map((stage) => student.stageDurations?.find((item: any) => item.stage === stage)?.durationSeconds ?? 0),
      ]);
    });
    rows.push(
      ["Class total", summary.totalSessions, summary.loginSessionsAvailable ? summary.loginSessionCount : "Not available", summary.totalSeconds, summary.loginSessionsAvailable ? summary.averageLoginSessionSeconds : "Not available", summary.loginSessionsAvailable ? summary.longestLoginSessionSeconds : "Not available", "", ...ACTIVITY_STAGES.map((stage) => stageStats.find((item: any) => item.stage === stage)?.totalSeconds ?? 0)],
      ["Class average per enrolled student", "", "", summary.averageStudentSeconds, "", "", "", ...ACTIVITY_STAGES.map((stage) => stageStats.find((item: any) => item.stage === stage)?.averageStudentSeconds ?? 0)],
    );
    rows.push([]);
    rows.push(["Stage comparison", "Total seconds", "Average seconds per student", "Share of total", "Most time", "Most seconds", "Least time", "Least seconds"]);
    stageStats.forEach((stage: any) => {
      rows.push([
        STAGE_LABEL[stage.stage as keyof typeof STAGE_LABEL],
        stage.totalSeconds,
        stage.averageStudentSeconds,
        `${stage.sharePercent}%`,
        stage.highestStudent?.studentName ?? "",
        stage.highestStudent?.seconds ?? 0,
        stage.lowestStudent?.studentName ?? "",
        stage.lowestStudent?.seconds ?? 0,
      ]);
    });
    return rows;
  };

  const handleDownloadCsv = () => {
    downloadCsv(activityCsv(), `${String(report.class?.name ?? "class").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-class-activity.csv`);
  };

  const handleDownloadPdf = async () => {
    const section = document.getElementById("class-activity-report");
    if (!section) return;
    const content = section.cloneNode(true) as HTMLElement;
    content.querySelectorAll("button, form, [data-export-controls]").forEach((element) => element.remove());
    content.querySelectorAll(".report-collapsible-content").forEach((element) => element.classList.remove("hidden"));
    const text = (content.innerText || content.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) return;
    try {
      const blob = await apiFetchBlob("/teacher/export/pdf", {
        method: "POST",
        body: JSON.stringify({ title: "Class Climb Activity", text }),
      });
      downloadBlob(blob, `${String(report.class?.name ?? "class").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-class-activity.pdf`);
    } catch (err: any) {
      setError(err?.message ?? "Class activity PDF could not be downloaded.");
    }
  };

  const handleAnalyse = async () => {
    setAnalysing(true);
    setAnalysisError("");
    try {
      const result = await apiFetch(`/teacher/classes/${classId}/activity/analyze`, { method: "POST" });
      setAnalysis(result);
    } catch (err: any) {
      setAnalysisError(err.message ?? "Activity analysis is temporarily unavailable.");
    } finally {
      setAnalysing(false);
    }
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
            <span className="font-medium">Class Activity</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/teacher/class/${classId}/insights`} className="rounded-2xl border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 transition-colors">
              Teaching Insights
            </Link>
            <Link href={`/teacher/class/${classId}`} className="rounded-2xl border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 transition-colors">
              Back to Class
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-12 space-y-8">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-2">Class activity</p>
          <h1 className="text-3xl font-semibold tracking-tight">{report.class?.name ?? "Class"} activity</h1>
          {report.task?.title && <p className="mt-2 text-sm text-neutral-500">{report.task.title}{report.task.question ? ` — ${report.task.question}` : ""}</p>}
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-neutral-500">
            Recorded active time across the class, with student and stage comparisons. Time indicates recorded interaction with Climb, not learning quality or attainment.
          </p>
        </div>

        <section id="class-activity-report" data-testid="class-activity-report" className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 px-8 py-5">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-neutral-400">Class Activity Report</p>
              <p className="mt-1 text-sm text-neutral-500">Summary, stage comparison, student comparison, and activity patterns.</p>
            </div>
            <button
              type="button"
              onClick={() => setReportOpen((open) => !open)}
              aria-expanded={reportOpen}
              aria-controls="class-activity-report-content"
              className="rounded-xl border border-neutral-300 px-3 py-2 text-xs font-semibold hover:bg-neutral-50"
              data-testid="button-toggle-class-activity-report"
            >
              <span aria-hidden="true">{reportOpen ? "−" : "+"}</span> {reportOpen ? "Collapse report" : "Expand report"}
            </button>
          </div>
          <div id="class-activity-report-content" className={`${reportOpen ? "" : "hidden"} report-collapsible-content space-y-8 p-8`}>
          <div className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
            <div className="border-b border-neutral-200 px-8 py-6 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-2">Cumulative figures</p>
                <h2 className="text-2xl font-semibold tracking-tight">Class climb activity</h2>
              </div>
              <div className="flex flex-wrap gap-2 print:hidden">
                <button type="button" onClick={() => void handleDownloadPdf()} className="rounded-xl border border-neutral-300 px-3 py-2 text-xs font-semibold hover:bg-neutral-50">Download PDF</button>
                <button type="button" onClick={handleDownloadCsv} className="rounded-xl border border-neutral-300 px-3 py-2 text-xs font-semibold hover:bg-neutral-50">Download CSV</button>
              </div>
            </div>
            <div className="p-8">
              <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
                <div className="rounded-2xl bg-neutral-50 p-4"><p className="text-xs text-neutral-500">Students enrolled</p><p className="mt-1 text-xl font-semibold">{summary.studentCount}</p><p className="mt-1 text-xs text-neutral-400">{summary.activeStudentCount} with recorded time</p></div>
                <div className="rounded-2xl bg-neutral-50 p-4"><p className="text-xs text-neutral-500">Activity periods</p><p className="mt-1 text-xl font-semibold">{summary.totalSessions}</p></div>
                <div className="rounded-2xl bg-neutral-50 p-4"><p className="text-xs text-neutral-500">Login sessions</p><p className="mt-1 text-xl font-semibold">{summary.loginSessionsAvailable ? summary.loginSessionCount : "Not available"}</p></div>
                <div className="rounded-2xl bg-neutral-50 p-4"><p className="text-xs text-neutral-500">Total time</p><p className="mt-1 text-xl font-semibold">{formatDuration(summary.totalSeconds)}</p></div>
                <div className="rounded-2xl bg-neutral-50 p-4"><p className="text-xs text-neutral-500">Average login session</p><p className="mt-1 text-xl font-semibold">{summary.loginSessionsAvailable ? formatDuration(summary.averageLoginSessionSeconds) : "Not available"}</p></div>
                <div className="rounded-2xl bg-neutral-50 p-4"><p className="text-xs text-neutral-500">Average per student</p><p className="mt-1 text-xl font-semibold">{formatDuration(summary.averageStudentSeconds)}</p></div>
                <div className="rounded-2xl bg-neutral-50 p-4"><p className="text-xs text-neutral-500">Median per student</p><p className="mt-1 text-xl font-semibold">{formatDuration(summary.medianStudentSeconds)}</p></div>
              </div>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-emerald-600">Most recorded time</p>
                  <p className="mt-2 text-lg font-semibold text-emerald-900">{summary.topStudent?.studentName ?? "No activity"}</p>
                  <p className="text-sm text-emerald-700">{summary.topStudent ? formatDuration(summary.topStudent.seconds) : "No recorded time yet"}</p>
                </div>
                <div className="rounded-2xl border border-amber-100 bg-amber-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-amber-600">Least recorded time</p>
                  <p className="mt-2 text-lg font-semibold text-amber-900">{summary.bottomStudent?.studentName ?? "No students"}</p>
                  <p className="text-sm text-amber-700">{summary.bottomStudent ? formatDuration(summary.bottomStudent.seconds) : "No recorded time yet"}</p>
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm">
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-2">Stage comparison</p>
            <h2 className="text-2xl font-semibold tracking-tight">Where was class time spent?</h2>
            <div className="mt-6 space-y-4">
              {stageStats.map((stage: any) => (
                <div key={stage.stage} className="rounded-2xl border border-neutral-200 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="font-semibold">{STAGE_LABEL[stage.stage as keyof typeof STAGE_LABEL]}</p>
                    <div className="flex flex-wrap gap-4 text-xs text-neutral-500">
                      <span>Total <strong className="text-neutral-800">{formatDuration(stage.totalSeconds)}</strong></span>
                      <span>Average/student <strong className="text-neutral-800">{formatDuration(stage.averageStudentSeconds)}</strong></span>
                      <span><strong className="text-neutral-800">{stage.sharePercent}%</strong> of recorded time</span>
                    </div>
                  </div>
                  <div className="mt-3 h-3 overflow-hidden rounded-full bg-neutral-100">
                    <div className={`h-full rounded-full ${STAGE_COLOR[stage.stage as keyof typeof STAGE_COLOR]}`} style={{ width: `${Math.min(100, (stage.totalSeconds / longestStageSeconds) * 100)}%` }} />
                  </div>
                  <div className="mt-3 grid gap-2 text-xs text-neutral-500 sm:grid-cols-2">
                    <span>Most: <strong className="text-neutral-800">{stage.highestStudent ? `${stage.highestStudent.studentName} (${formatDuration(stage.highestStudent.seconds)})` : "No recorded time"}</strong></span>
                    <span>Least: <strong className="text-neutral-800">{stage.lowestStudent ? `${stage.lowestStudent.studentName} (${formatDuration(stage.lowestStudent.seconds)})` : "No recorded time"}</strong></span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm overflow-hidden">
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-2">Student comparison</p>
            <h2 className="text-2xl font-semibold tracking-tight">Recorded time by student</h2>
            <div className="mt-6 overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-xs uppercase tracking-wider text-neutral-400">
                    <th className="px-3 py-3 font-semibold">Student</th>
                    <th className="px-3 py-3 font-semibold">Activity periods</th>
                    <th className="px-3 py-3 font-semibold">Login sessions</th>
                    <th className="px-3 py-3 font-semibold">Total time</th>
                    <th className="px-3 py-3 font-semibold">Average login session</th>
                    <th className="px-3 py-3 font-semibold">Longest login session</th>
                    <th className="px-3 py-3 font-semibold">Main stage</th>
                  </tr>
                </thead>
                <tbody>
                  {students.map((student: any) => (
                    <tr key={student.id} className="border-b border-neutral-100 last:border-0">
                      <td className="px-3 py-3 font-medium"><Link href={`/teacher/class/${classId}/student/${student.id}`} className="hover:underline">{student.studentName}</Link></td>
                      <td className="px-3 py-3 text-neutral-600">{student.totalSessions}</td>
                      <td className="px-3 py-3 text-neutral-600">{student.loginSessionsAvailable ? student.loginSessionCount : "Not available"}</td>
                      <td className="px-3 py-3 font-semibold">{formatDuration(student.totalSeconds)}</td>
                      <td className="px-3 py-3 text-neutral-600">{student.loginSessionsAvailable ? formatDuration(student.averageLoginSessionSeconds) : "Not available"}</td>
                      <td className="px-3 py-3 text-neutral-600">{student.loginSessionsAvailable ? formatDuration(student.longestLoginSessionSeconds) : "Not available"}</td>
                      <td className="px-3 py-3 text-neutral-600">{student.dominantStage ? STAGE_LABEL[student.dominantStage as keyof typeof STAGE_LABEL] : "No activity"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {students.length === 0 && <p className="py-6 text-sm text-neutral-500">No students are enrolled in this class.</p>}
            </div>
          </div>

          <section className="rounded-[2rem] bg-white border-2 border-neutral-900 shadow-sm overflow-hidden">
            <div className="border-b border-neutral-200 px-8 py-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] font-semibold text-neutral-400 mb-1">AI interpretation</p>
                <h2 className="text-2xl font-semibold tracking-tight">Activity analysis</h2>
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-neutral-500">This interpretation describes recorded interaction patterns. It does not turn time into a measure of ability or prove why a student spent more or less time.</p>
              </div>
              <button type="button" onClick={handleAnalyse} disabled={analysing || summary.totalSessions === 0} className="shrink-0 rounded-xl bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-wait disabled:opacity-40">
                {analysing ? "Analysing…" : analysis ? "Re-analyse activity" : "Analyse activity"}
              </button>
            </div>
            {analysisError && <p className="mx-8 mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{analysisError}</p>}
            {analysis ? (
              <div className="space-y-7 p-8">
                <p className="text-neutral-700 leading-relaxed">{analysis.summary}</p>
                <div className="grid gap-6 md:grid-cols-2">
                  <div className="rounded-2xl border border-sky-100 bg-sky-50 p-5">
                    <p className="text-xs uppercase tracking-widest font-semibold text-sky-600 mb-3">What the figures show</p>
                    <ul className="space-y-2">{(analysis.findings ?? []).map((item: string, index: number) => <li key={index} className="flex gap-2 text-sm leading-relaxed text-sky-950"><span className="font-bold text-sky-500">{index + 1}.</span>{item}</li>)}</ul>
                  </div>
                  <div className="rounded-2xl border border-violet-100 bg-violet-50 p-5">
                    <p className="text-xs uppercase tracking-widest font-semibold text-violet-600 mb-3">Comparisons</p>
                    <ul className="space-y-2">{(analysis.comparisons ?? []).map((item: string, index: number) => <li key={index} className="flex gap-2 text-sm leading-relaxed text-violet-950"><span className="font-bold text-violet-500">{index + 1}.</span>{item}</li>)}</ul>
                  </div>
                </div>
                <div className="rounded-2xl border border-amber-100 bg-amber-50 p-5">
                  <p className="text-xs uppercase tracking-widest font-semibold text-amber-600 mb-3">Research considerations</p>
                  <ul className="space-y-2">{(analysis.researchConsiderations ?? []).map((item: string, index: number) => <li key={index} className="flex gap-2 text-sm leading-relaxed text-amber-950"><span className="font-bold text-amber-500">{index + 1}.</span>{item}</li>)}</ul>
                </div>
              </div>
            ) : (
              <div className="p-8 text-sm text-neutral-500">Generate an evidence-led interpretation of the class activity figures when you are ready.</div>
            )}
          </section>
          </div>
        </section>
      </main>
    </div>
  );
}