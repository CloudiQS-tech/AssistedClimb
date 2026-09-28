import { useState, useEffect, useMemo } from "react";
import { Link, useRoute } from "wouter";
import { apiFetch, apiFetchBlob, downloadBlob } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import {
  classifyKnowledgeDimension,
  classifyMessages,
  classifyQuestion,
  KNOWLEDGE_DIMENSION_META,
  KNOWLEDGE_DIMENSION_TYPES,
  QUESTION_TYPE_META,
  QUESTION_TYPES,
} from "@/lib/question-classifier";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import InsightReportContent from "@/components/insight-report-content";

const STAGES = ["MAP", "TORCH", "COMPASS", "RESEARCH", "EMBED"] as const;
const STAGE_DISPLAY: Record<string, string> = {
  MAP: "MAP", TORCH: "TORCH", RESEARCH: "RESEARCH", COMPASS: "COMPASS", EMBED: "Final Answer",
};
const STAGE_LIGHT: Record<string, string> = {
  MAP: "text-neutral-700 bg-neutral-100 border-neutral-200",
  TORCH: "text-amber-700 bg-amber-50 border-amber-200",
  RESEARCH: "text-sky-700 bg-sky-50 border-sky-200",
  COMPASS: "text-emerald-700 bg-emerald-50 border-emerald-200",
  EMBED: "text-violet-700 bg-violet-50 border-violet-200",
};

// Single colour system: dot + bar + text all match per type
const QT: Record<string, { bg: string; text: string; light: string }> = {
  Factual:              { bg: "bg-blue-500",    text: "text-blue-600",    light: "bg-blue-50" },
  Conceptual:           { bg: "bg-emerald-500", text: "text-emerald-600", light: "bg-emerald-50" },
  Analytical:           { bg: "bg-amber-500",   text: "text-amber-600",   light: "bg-amber-50" },
  Evaluative:           { bg: "bg-orange-500",  text: "text-orange-600",  light: "bg-orange-50" },
  Creative:             { bg: "bg-violet-500",  text: "text-violet-600",  light: "bg-violet-50" },
  "Help/Clarify": { bg: "bg-pink-500", text: "text-pink-600", light: "bg-pink-50" },
  Other:                { bg: "bg-slate-400",   text: "text-slate-500",   light: "bg-slate-50" },
};
const KD: Record<string, { bg: string; text: string; light: string }> = {
  "Factual Knowledge":   { bg: "bg-blue-500",    text: "text-blue-600",    light: "bg-blue-50" },
  "Conceptual Knowledge":{ bg: "bg-emerald-500", text: "text-emerald-600", light: "bg-emerald-50" },
  "Procedural Knowledge":{ bg: "bg-amber-500",   text: "text-amber-600",   light: "bg-amber-50" },
  "Learning Process":    { bg: "bg-violet-500",  text: "text-violet-600",  light: "bg-violet-50" },
  Other:                 { bg: "bg-slate-400",   text: "text-slate-500",   light: "bg-slate-50" },
};

type InsightHistoryEntry = Record<string, any> & { generatedAt: string };

function csvCell(value: unknown) {
  const rawValue = String(value ?? "");
  const safeValue = `'${rawValue}`;
  return `"${safeValue.replace(/"/g, '""')}"`;
}

function downloadCsv(rows: Array<unknown[]>, filename: string) {
  const csv = rows
    .map((row) => row.map((value) => csvCell(Array.isArray(value) ? value.join("; ") : value)).join(","))
    .join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function TeacherClassInsights() {
  const [, params] = useRoute("/teacher/class/:classId/insights");
  const classId = params?.classId;
  const { toast } = useToast();

  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [synthesising, setSynthesising] = useState(false);
  const [insights, setInsights] = useState<any>(null);
  const [insightsGeneratedAt, setInsightsGeneratedAt] = useState<string | null>(null);
  const [insightHistory, setInsightHistory] = useState<InsightHistoryEntry[]>([]);
  const [expandedQuestionTypes, setExpandedQuestionTypes] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);
  const [reportOpen, setReportOpen] = useState(true);

  useEffect(() => {
    if (!classId) return;
    apiFetch(`/teacher/classes/${classId}/class-insights`)
      .then((d: any) => {
        setData(d);
        const history = Array.isArray(d.insightsHistory)
          ? d.insightsHistory.filter((entry: any) => entry && typeof entry === "object" && typeof entry.generatedAt === "string")
          : d.lastInsights
            ? [{ ...d.lastInsights, generatedAt: d.lastInsightsAt ?? new Date(0).toISOString() }]
            : [];
        const latest = history[history.length - 1] ?? null;
        setInsightHistory(history);
        setInsights(latest);
        setInsightsGeneratedAt(latest?.generatedAt ?? null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    apiFetch(`/teacher/classes/${classId}`)
      .then((cls: any) => setData((prev: any) => prev ? { ...prev, cls } : { cls }))
      .catch(() => {});
  }, [classId]);

  const questionTypeCounts = useMemo<Record<string, number>>(() => {
    if (!data?.torchMessages) return {};
    return classifyMessages(
      (data.torchMessages as any[]).map((m) => ({ role: "user", content: m.content }))
    );
  }, [data?.torchMessages]);

  const isKnowledgeDimensionsTask = data?.task?.learningFramework === "knowledge_dimensions";
  const knowledgeDimensionCounts = useMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = Object.fromEntries(
      KNOWLEDGE_DIMENSION_TYPES.map((type) => [type, 0]),
    );
    for (const message of (data?.torchMessages ?? []) as any[]) {
      if (message.role === "user" && typeof message.content === "string") {
        const type = classifyKnowledgeDimension(message.content);
        counts[type] = (counts[type] ?? 0) + 1;
      }
    }
    return counts;
  }, [data?.torchMessages]);

  const knowledgeDimensionExamplesByType = useMemo<Record<string, string[]>>(() => {
    const grouped: Record<string, string[]> = {};
    for (const message of (data?.torchMessages ?? []) as any[]) {
      if (message.role !== "user" || typeof message.content !== "string") continue;
      const type = classifyKnowledgeDimension(message.content);
      grouped[type] = [...(grouped[type] ?? []), message.content];
    }
    return grouped;
  }, [data?.torchMessages]);

  const totalMessages = useMemo(
    () => Object.values(questionTypeCounts).reduce((a: number, b: number) => a + b, 0),
    [questionTypeCounts]
  );

  const questionExamplesByType = useMemo<Record<string, string[]>>(() => {
    const grouped: Record<string, string[]> = {};
    for (const message of (data?.torchMessages ?? []) as any[]) {
      if (message.role !== "user" || typeof message.content !== "string") continue;
      const type = classifyQuestion(message.content);
      grouped[type] = [...(grouped[type] ?? []), message.content];
    }
    return grouped;
  }, [data?.torchMessages]);

  const analysisTypes = isKnowledgeDimensionsTask ? KNOWLEDGE_DIMENSION_TYPES : QUESTION_TYPES;
  const analysisCounts = isKnowledgeDimensionsTask ? knowledgeDimensionCounts : questionTypeCounts;
  const analysisExamplesByType = isKnowledgeDimensionsTask ? knowledgeDimensionExamplesByType : questionExamplesByType;
  const analysisMeta = isKnowledgeDimensionsTask ? KNOWLEDGE_DIMENSION_META : QUESTION_TYPE_META;
  const analysisStyles = isKnowledgeDimensionsTask ? KD : QT;

  const stageCompletion = useMemo<Record<string, {
    finished: number; started: number; none: number;
    finishedStudents: { id: string; name: string }[];
    startedStudents: { id: string; name: string }[];
    noneStudents: { id: string; name: string }[];
  }>>(() => {
    if (!data?.students) return {};
    const out: Record<string, any> = {};
    for (const stage of STAGES) {
      const finishedStudents: { id: string; name: string }[] = [];
      const startedStudents: { id: string; name: string }[] = [];
      const noneStudents: { id: string; name: string }[] = [];
      for (const s of data.students as any[]) {
        const status = s.stageStatuses?.[stage] ?? "none";
        const entry = { id: String(s.id), name: s.studentName ?? "Unknown" };
        if (status === "finished") finishedStudents.push(entry);
        else if (status === "started") startedStudents.push(entry);
        else noneStudents.push(entry);
      }
      out[stage] = {
        finished: finishedStudents.length, started: startedStudents.length, none: noneStudents.length,
        finishedStudents, startedStudents, noneStudents,
      };
    }
    return out;
  }, [data?.students]);

  const sortedQTypes = (analysisTypes as readonly string[])
    .filter((t) => (analysisCounts[t] ?? 0) > 0)
    .sort((a, b) => (analysisCounts[b] ?? 0) - (analysisCounts[a] ?? 0));

  const dominantType = sortedQTypes[0] ?? null;
  const leastType = sortedQTypes[sortedQTypes.length - 1] ?? null;

  useEffect(() => {
    if (dominantType && Object.keys(expandedQuestionTypes).length === 0) {
      setExpandedQuestionTypes({ [dominantType]: true });
    }
  }, [dominantType, expandedQuestionTypes]);

  if (loading) return null;
  if (!data) return <div className="p-6 text-neutral-500">Class not found</div>;

  const { task, students, cls } = data;
  const studentCount: number = (students ?? []).length;

  // Mutually exclusive student categories (fully done + in progress + not started = total)
  const fullyDoneStudents = (students as any[] ?? []).filter((s: any) =>
    (s.stageStatuses?.["EMBED"] ?? "none") === "finished"
  );
  const notStartedStudents = (students as any[] ?? []).filter((s: any) =>
    STAGES.every((stage) => (s.stageStatuses?.[stage] ?? "none") === "none")
  );
  const inProgressStudents = (students as any[] ?? []).filter((s: any) =>
    (s.stageStatuses?.["EMBED"] ?? "none") !== "finished" &&
    STAGES.some((stage) => (s.stageStatuses?.[stage] ?? "none") !== "none")
  );
  const completePercentage = studentCount > 0
    ? Math.round((fullyDoneStudents.length / studentCount) * 100)
    : 0;
  const incompletePercentage = studentCount > 0 ? 100 - completePercentage : 0;

  // Intervention panels
  const interventionStages = STAGES.filter((s) => (stageCompletion[s]?.none ?? 0) > 0);
  // "Needs a nudge" panel: only show students who haven't started anything at all
  const stuckStudents = inProgressStudents;

  const buildInsightText = (report: any, generatedAt: string | null) => {
    const date = generatedAt
      ? new Date(generatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
      : new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    const lines: string[] = [
      "TEACHING INTELLIGENCE",
      `Class: ${cls?.name ?? ""}`,
      `Generated: ${date}`,
      "",
    ];
    if (report?.questionTypeInsight) {
      lines.push("QUESTION TYPE INTELLIGENCE", "─".repeat(40), report.questionTypeInsight, "");
    }
    const addList = (heading: string, items: unknown, numbered = true) => {
      if (!Array.isArray(items) || items.length === 0) return;
      lines.push(heading, "─".repeat(40));
      items.forEach((item, index) => lines.push(numbered ? `${index + 1}. ${item}` : `• ${item}`));
      lines.push("");
    };
    addList("WHAT STUDENTS SEEM CONFIDENT ABOUT", report?.confidentAreas);
    addList("WHERE GAPS APPEAR", report?.knowledgeGaps);
    addList("STUDENT MISCONCEPTIONS (VERBATIM)", report?.misconceptionQuotes, false);
    addList("STAGE COMPLETION PATTERNS", report?.stagePatterns, false);
    addList("TEACHING RECOMMENDATIONS", report?.teachingRecommendations);
    addList("NEXT LESSON PLAN", report?.nextLessonPlan);
    return lines.join("\n");
  };

  const appendInsightCsvRows = (rows: Array<unknown[]>, report: any) => {
    if (report?.questionTypeInsight) {
      rows.push(["Teaching Insights", "What the questions tell you", report.questionTypeInsight]);
    }
    const addInsightItems = (section: string, items: unknown) => {
      if (!Array.isArray(items)) return;
      items.forEach((item, index) => rows.push([section, index + 1, item]));
    };
    addInsightItems("Teaching Insights — confident areas", report?.confidentAreas);
    addInsightItems("Teaching Insights — knowledge gaps", report?.knowledgeGaps);
    addInsightItems("Teaching Insights — misconceptions", report?.misconceptionQuotes);
    addInsightItems("Teaching Insights — stage patterns", report?.stagePatterns);
    addInsightItems("Teaching Insights — recommendations", report?.teachingRecommendations);
    addInsightItems("Teaching Insights — next lesson plan", report?.nextLessonPlan);
  };

  const reportFilenameDate = (report: InsightHistoryEntry, index: number) => {
    const date = report.generatedAt?.slice(0, 10).replace(/[^0-9-]/g, "");
    return date || `report-${index + 1}`;
  };

  const handleCopy = async () => {
    if (!insights) return;
    await navigator.clipboard.writeText(buildInsightText(insights, insightsGeneratedAt));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadPdf = async () => {
    const source = document.getElementById("teaching-intelligence-report");
    if (!source) return;
    const clone = source.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("button, form, [data-export-controls]").forEach((element) => element.remove());
    clone.querySelectorAll(".report-collapsible-content").forEach((element) => element.classList.remove("hidden"));
    const text = (clone.innerText || clone.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) return;
    try {
      const blob = await apiFetchBlob("/teacher/export/pdf", {
        method: "POST",
        body: JSON.stringify({ title: "Class Teaching Intelligence", text }),
      });
      downloadBlob(blob, "assisted-climb-class-teaching-intelligence.pdf");
    } catch (error: any) {
      toast({ title: "Teaching Intelligence PDF could not be downloaded", description: error?.message ?? "Please try again.", variant: "destructive" });
    }
  };

  const handleDownloadCsv = () => {
    const rows: Array<unknown[]> = [
      ["Section", "Item", "Value", "Examples"],
      ["Report", "Class", cls?.name ?? ""],
      ["Report", "Assignment", task?.title ?? ""],
      ["Report", "Question", task?.question ?? ""],
      ["Report", "Generated at", insightsGeneratedAt ? new Date(insightsGeneratedAt).toISOString() : ""],
      ["Class summary", "Students enrolled", studentCount],
      ["Class summary", "Climbs complete", fullyDoneStudents.length],
      ["Class summary", "Climbs in progress", inProgressStudents.length],
      ["Class summary", "Climbs not started", notStartedStudents.length],
      ["Class summary", "Complete percentage", `${completePercentage}%`],
      ["Class summary", "Incomplete percentage", `${incompletePercentage}%`],
    ];

    for (const stage of STAGES) {
      const counts = stageCompletion[stage] ?? { finished: 0, started: 0, none: 0 };
      rows.push(
        ["Stage completion", `${STAGE_DISPLAY[stage]} — complete`, counts.finished],
        ["Stage completion", `${STAGE_DISPLAY[stage]} — in progress`, counts.started],
        ["Stage completion", `${STAGE_DISPLAY[stage]} — not started`, counts.none],
      );
    }

    for (const type of sortedQTypes) {
      const count = analysisCounts[type] ?? 0;
      const percentage = totalMessages > 0 ? Math.round((count / totalMessages) * 100) : 0;
      rows.push([
        isKnowledgeDimensionsTask ? "Knowledge dimension signal" : "Question type",
        type,
        `${count} (${percentage}%)`,
        (analysisExamplesByType[type] ?? []).join(" | "),
      ]);
    }

    appendInsightCsvRows(rows, insights);

    downloadCsv(rows, "assisted-climb-class-teaching-intelligence.csv");
  };

  const handleDownloadHistoricalPdf = async (report: InsightHistoryEntry, index: number) => {
    try {
      const blob = await apiFetchBlob("/teacher/export/pdf", {
        method: "POST",
        body: JSON.stringify({
          title: "Previous Class Teaching Intelligence",
          text: buildInsightText(report, report.generatedAt),
        }),
      });
      downloadBlob(blob, `assisted-climb-class-teaching-intelligence-${reportFilenameDate(report, index)}.pdf`);
    } catch (error: any) {
      toast({ title: "Teaching Intelligence PDF could not be downloaded", description: error?.message ?? "Please try again.", variant: "destructive" });
    }
  };

  const handleDownloadHistoricalCsv = (report: InsightHistoryEntry, index: number) => {
    const rows: Array<unknown[]> = [
      ["Section", "Item", "Value", "Examples"],
      ["Report", "Class", cls?.name ?? ""],
      ["Report", "Assignment", task?.title ?? ""],
      ["Report", "Question", task?.question ?? ""],
      ["Report", "Generated at", report.generatedAt ? new Date(report.generatedAt).toISOString() : ""],
    ];
    appendInsightCsvRows(rows, report);
    downloadCsv(rows, `assisted-climb-class-teaching-intelligence-${reportFilenameDate(report, index)}.csv`);
  };

  const handleSynthesise = async () => {
    setSynthesising(true);
    try {
      const torchSamples = (data.torchMessages as any[]).map((m: any) => m.content);
      const stageCompletionCounts: Record<string, number> = {};
      for (const [stage, val] of Object.entries(stageCompletion)) {
        stageCompletionCounts[stage] = (val as any).finished ?? 0;
      }
      const result = await apiFetch(`/teacher/classes/${classId}/class-insights/synthesize`, {
        method: "POST",
        body: JSON.stringify({
          questionTypeCounts: analysisCounts,
          totalMessages,
          torchSamples,
          stageCompletion: stageCompletionCounts,
          studentCount,
          learningFramework: data.task?.learningFramework ?? "bloom",
          knowledgeDimensions: data.task?.knowledgeDimensions ?? [],
        }),
      });
      const generatedAt = result.generatedAt ?? new Date().toISOString();
      const nextInsight = { ...result, generatedAt };
      setInsightHistory((current) => [...current, nextInsight]);
      setInsights(nextInsight);
      setInsightsGeneratedAt(generatedAt);
    } catch (err: any) {
      toast({ title: "Failed to generate insights", description: err.message, variant: "destructive" });
    } finally {
      setSynthesising(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-neutral-50 text-neutral-900 font-sans pb-20">
      <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/90 backdrop-blur">
        <div className="max-w-5xl mx-auto px-6 py-4 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 text-sm">
            <Link href="/teacher/dashboard" className="text-neutral-500 hover:text-black">Dashboard</Link>
            <span className="text-neutral-300">/</span>
            <Link href={`/teacher/class/${classId}`} className="min-w-0 text-neutral-500 hover:text-black [overflow-wrap:anywhere]">
              {cls?.name ?? "Class"}
            </Link>
            <span className="text-neutral-300">/</span>
            <span className="font-medium">Teaching Insights</span>
          </div>
          <div className="flex max-w-full flex-wrap items-center gap-2">
            {insightsGeneratedAt && (
              <span className="text-xs text-neutral-400 hidden sm:block">
                Last run: {new Date(insightsGeneratedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
              </span>
            )}
            <button
              type="button"
              onClick={() => void handleDownloadPdf()}
              disabled={!insights}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-neutral-300 bg-white text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" /></svg>
              Download PDF
             </button>
      <button
              type="button"
              onClick={handleDownloadCsv}
        disabled={studentCount === 0}
        className="px-4 py-2.5 rounded-xl border border-neutral-300 bg-white text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Download class teaching intelligence as CSV"
              data-testid="button-class-insights-csv"
            >
              Download CSV
            </button>
             <button
              onClick={handleSynthesise}
              disabled={synthesising || studentCount === 0}
              className="px-5 py-2.5 rounded-xl bg-neutral-900 text-white text-sm font-medium hover:bg-neutral-700 transition-colors disabled:opacity-40 disabled:cursor-wait"
            >
              {synthesising ? "Analysing…" : insights ? "New Insight" : "Generate AI Analysis"}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-10 space-y-6 [overflow-wrap:anywhere]">

        {/* Page title + stat strip */}
        <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm">
          <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-1">Teaching Insights</p>
          <h1 className="text-3xl font-semibold tracking-tight mb-1">{cls?.name ?? "Class"}</h1>
          {task && (
            <p className="text-neutral-500 mt-1 mb-6">
              <span className="font-medium text-neutral-800">{task.title}</span>
              {task.question && <span className="ml-2 text-neutral-400">— {task.question}</span>}
            </p>
          )}

          {studentCount > 0 && (
             <div className="grid grid-cols-2 gap-4 mt-4 sm:grid-cols-3 2xl:grid-cols-6">
              <div className="rounded-2xl bg-neutral-50 border border-neutral-100 p-4 text-center">
                <p className="text-3xl font-black text-neutral-900">{studentCount}</p>
                 <p className="mt-1 whitespace-nowrap text-[10px] leading-tight uppercase tracking-[0.12em] text-neutral-400 sm:text-[11px]">Students Enrolled</p>
              </div>
              <div className="rounded-2xl bg-emerald-50 border border-emerald-100 p-4 text-center">
                <p className="text-3xl font-black text-emerald-700">{fullyDoneStudents.length}</p>
                 <p className="mt-1 whitespace-nowrap text-[10px] leading-tight uppercase tracking-[0.12em] text-emerald-500 sm:text-[11px]">Climbs Complete</p>
              </div>
              <div className="rounded-2xl bg-amber-50 border border-amber-100 p-4 text-center">
                <p className="text-3xl font-black text-amber-600">{inProgressStudents.length}</p>
                 <p className="mt-1 whitespace-nowrap text-[10px] leading-tight uppercase tracking-[0.12em] text-amber-500 sm:text-[11px]">Climbs Incomplete</p>
              </div>
              <div className="rounded-2xl bg-red-50 border border-red-100 p-4 text-center">
                <p className="text-3xl font-black text-red-500">{notStartedStudents.length}</p>
                 <p className="mt-1 whitespace-nowrap text-[10px] leading-tight uppercase tracking-[0.12em] text-red-400 sm:text-[11px]">Climbs Not Started</p>
              </div>
              <div className="rounded-2xl bg-emerald-50 border border-emerald-100 p-4 text-center">
                <p className="text-3xl font-black text-emerald-700">{completePercentage}%</p>
                <p className="mt-1 whitespace-nowrap text-[10px] leading-tight uppercase tracking-[0.12em] text-emerald-500 sm:text-[11px]">Complete</p>
              </div>
              <div className="rounded-2xl bg-amber-50 border border-amber-100 p-4 text-center">
                <p className="text-3xl font-black text-amber-600">{incompletePercentage}%</p>
                <p className="mt-1 whitespace-nowrap text-[10px] leading-tight uppercase tracking-[0.12em] text-amber-500 sm:text-[11px]">Incomplete</p>
              </div>
            </div>
          )}
        </div>

        {/* Needs Attention — intervention panel */}
        {studentCount > 0 && interventionStages.length > 0 && (
          <section className="rounded-[2rem] bg-red-50 border border-red-200 p-8 shadow-sm">
            <div className="flex items-center gap-3 mb-6">
              <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
              <h2 className="text-xs uppercase tracking-[0.2em] font-semibold text-red-500">Needs a nudge — not started</h2>
            </div>
            <div className="space-y-3">
              {interventionStages.map((stage) => {
                const students = stageCompletion[stage]?.noneStudents ?? [];
                return (
                  <div key={stage} className="grid min-w-0 grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4">
                    <span className={`w-full text-center text-xs font-semibold px-2.5 py-2 rounded-xl border ${STAGE_LIGHT[stage]}`}>
                      {STAGE_DISPLAY[stage]}
                    </span>
                    <div className="grid min-w-0 grid-cols-1 gap-2 pt-0 sm:grid-cols-2 xl:grid-cols-3">
                      {students.map((s) => (
                        <Link key={s.id} href={`/teacher/class/${classId}/student/${s.id}`} className="min-w-0 rounded-xl bg-white border border-red-200 px-3 py-2 text-sm text-red-700 font-medium shadow-sm transition-colors hover:bg-red-50 [overflow-wrap:anywhere]">
                          {s.name}
                        </Link>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* In progress — stuck students */}
        {stuckStudents.length > 0 && (
          <section className="rounded-[2rem] bg-amber-50 border border-amber-200 p-8 shadow-sm">
            <div className="flex items-center gap-3 mb-6">
              <span className="w-2 h-2 rounded-full bg-amber-400" />
              <h2 className="text-xs uppercase tracking-[0.2em] font-semibold text-amber-600">In progress — started but not finished</h2>
            </div>
            <div className="space-y-3">
              {STAGES.map((stage) => {
                const students = stageCompletion[stage]?.startedStudents ?? [];
                if (students.length === 0) return null;
                return (
                  <div key={stage} className="grid min-w-0 grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4">
                    <span className={`w-full text-center text-xs font-semibold px-2.5 py-2 rounded-xl border ${STAGE_LIGHT[stage]}`}>
                      {STAGE_DISPLAY[stage]}
                    </span>
                    <div className="grid min-w-0 grid-cols-1 gap-2 pt-0 sm:grid-cols-2 xl:grid-cols-3">
                      {students.map((s) => (
                        <Link key={s.id} href={`/teacher/class/${classId}/student/${s.id}`} className="min-w-0 rounded-xl bg-white border border-amber-200 px-3 py-2 text-sm text-amber-700 font-medium shadow-sm transition-colors hover:bg-amber-50 [overflow-wrap:anywhere]">
                          {s.name}
                        </Link>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Stage progress — compact funnel */}
        <section className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm">
          <h2 className="text-xs uppercase tracking-[0.2em] font-semibold text-neutral-400 mb-6">Stage Completion</h2>
          {studentCount === 0 ? (
            <p className="text-sm italic text-neutral-400">No students have joined yet.</p>
          ) : (
            <div className="space-y-3">
              {/* Column headers */}
                <div className="flex items-center gap-2 sm:gap-4">
                <div className="w-16 shrink-0 sm:w-28" />
                <div className="flex-1" />
                  <div className="w-48 shrink-0 grid grid-cols-3 text-center">
                    <span className="whitespace-nowrap text-[10px] uppercase font-semibold text-emerald-600">Done</span>
                    <span className="whitespace-nowrap text-[10px] uppercase font-semibold text-amber-500">Started</span>
                    <span className="whitespace-nowrap text-[10px] uppercase font-semibold text-red-500">Incomplete</span>
                </div>
              </div>
              {STAGES.map((stage) => {
                const counts = stageCompletion[stage] ?? { finished: 0, started: 0, none: studentCount, finishedNames: [], startedNames: [], noneNames: [] };
                const finPct = studentCount > 0 ? (counts.finished / studentCount) * 100 : 0;
                const startPct = studentCount > 0 ? (counts.started / studentCount) * 100 : 0;
                return (
                  <div key={stage} className="flex items-center gap-2 sm:gap-4">
                    <div className={`w-16 shrink-0 text-center text-xs font-semibold px-1 py-1.5 rounded-full border sm:w-28 sm:px-2.5 ${STAGE_LIGHT[stage]}`}>
                      {STAGE_DISPLAY[stage]}
                    </div>
                    <TooltipProvider delayDuration={100}>
                      <div className="flex-1 h-6 rounded-full overflow-hidden flex">
                        {finPct > 0 && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="h-full bg-emerald-500 shrink-0 cursor-default" style={{ width: `${finPct}%` }} />
                            </TooltipTrigger>
                            <TooltipContent side="top" className="bg-white text-neutral-900 border border-neutral-200 shadow-lg p-3">
                              <p className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wide mb-1.5">Finished</p>
                              <ul className="space-y-0.5">{counts.finishedStudents.map((s: { id: string; name: string }) => <li key={s.id} className="text-xs">{s.name}</li>)}</ul>
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {startPct > 0 && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="h-full bg-amber-400 shrink-0 cursor-default" style={{ width: `${startPct}%` }} />
                            </TooltipTrigger>
                            <TooltipContent side="top" className="bg-white text-neutral-900 border border-neutral-200 shadow-lg p-3">
                              <p className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wide mb-1.5">Started</p>
                              <ul className="space-y-0.5">{counts.startedStudents.map((s: { id: string; name: string }) => <li key={s.id} className="text-xs">{s.name}</li>)}</ul>
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {counts.none > 0 && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="h-full flex-1 bg-red-500 cursor-default" />
                            </TooltipTrigger>
                            <TooltipContent side="top" className="bg-white text-neutral-900 border border-neutral-200 shadow-lg p-3">
                              <p className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wide mb-1.5">Not started</p>
                              <ul className="space-y-0.5">{counts.noneStudents.map((s: { id: string; name: string }) => <li key={s.id} className="text-xs">{s.name}</li>)}</ul>
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </TooltipProvider>
                    <div className="w-48 shrink-0 grid grid-cols-3 text-center">
                      <span className="text-base font-black text-emerald-600">{counts.finished}</span>
                      <span className="text-base font-black text-amber-500">{counts.started}</span>
                      <span className="text-base font-black text-red-500">{counts.none}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* TORCH — framework-aware question analysis */}
        {totalMessages > 0 && (
          <section className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm">
            <div className="flex flex-col gap-5 border-b border-neutral-100 pb-6 md:flex-row md:items-start md:justify-between">
              <div className="max-w-2xl">
                <p className="text-xs uppercase tracking-[0.2em] font-semibold text-amber-600 mb-1">
                   TORCH / {isKnowledgeDimensionsTask ? "Knowledge Dimensions" : "Question insights"}
                </p>
                <h2 className="text-2xl font-semibold tracking-tight text-neutral-900">
                  {isKnowledgeDimensionsTask ? "Which knowledge dimensions are students using?" : "What kinds of questions are students asking?"}
                </h2>
                <p className="mt-2 text-sm leading-6 text-neutral-500">
                   {totalMessages} AI messages across the class, grouped by {isKnowledgeDimensionsTask ? "knowledge-dimension signals" : "question type"}. Select <strong className="font-semibold text-neutral-700">Show examples</strong> on a row to see the questions behind its count.
                </p>
              </div>
              {dominantType && (
                <div className="flex shrink-0 flex-wrap gap-2 md:max-w-[18rem] md:justify-end">
                  <span className="px-3 py-1.5 rounded-full bg-neutral-900 text-white font-medium">
                     Most: {dominantType} ({analysisCounts[dominantType]})
                  </span>
                  {leastType && leastType !== dominantType && (
                    <span className="px-3 py-1.5 rounded-full bg-neutral-100 text-neutral-500 font-medium">
                       Least: {leastType} ({analysisCounts[leastType]})
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="mt-6 rounded-2xl border border-neutral-100 bg-neutral-50/70 p-4 sm:p-5">
              <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div>
                   <p className="text-sm font-semibold text-neutral-800">
                     {isKnowledgeDimensionsTask ? "Knowledge dimension signals" : "Question type distribution"}
                   </p>
                   <p className="text-xs text-neutral-500">
                     Share of all classified AI questions{isKnowledgeDimensionsTask ? "; reflection is shown separately as a learning-process signal" : ""}
                   </p>
                </div>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Count + share</span>
              </div>
              <div
                className="flex h-3 overflow-hidden rounded-full gap-px"
                role="img"
                 aria-label={`Stacked bar showing the distribution of ${isKnowledgeDimensionsTask ? "knowledge dimension signals" : "question types"}`}
              >
                {(analysisTypes as readonly string[]).map((type) => {
                  const pct = totalMessages > 0 ? ((analysisCounts[type] ?? 0) / totalMessages) * 100 : 0;
                  if (pct === 0) return null;
                  return <div key={type} className={analysisStyles[type]?.bg ?? "bg-neutral-300"} style={{ width: `${pct}%` }} title={`${type}: ${Math.round(pct)}%`} />;
                })}
              </div>
            </div>

             {/* Per-type rows — all categories, sorted highest first */}
            <div className="mt-4 space-y-2">
                 {(analysisTypes as readonly string[])
                  .slice()
                   .sort((a, b) => (analysisCounts[b] ?? 0) - (analysisCounts[a] ?? 0))
                  .map((type) => {
                     const count = analysisCounts[type] ?? 0;
                    const pct = totalMessages > 0 ? Math.round((count / totalMessages) * 100) : 0;
                    const isEmpty = count === 0;
                     const examples = analysisExamplesByType[type] ?? [];
                    const isExpanded = expandedQuestionTypes[type] === true && !isEmpty;
                     const c = analysisStyles[type] ?? { bg: "bg-neutral-300", text: "text-neutral-500", light: "bg-neutral-50" };
                    const examplesId = `question-examples-${type.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
                    return (
                      <div key={type} className={`rounded-2xl border ${isExpanded ? "border-neutral-300 bg-white" : "border-transparent"} transition-colors ${isEmpty ? "opacity-35" : ""}`}>
                        <div className="flex flex-wrap items-center gap-3 px-2 py-2">
                          {/* Dot + label */}
                          <div className="flex w-44 shrink-0 items-center gap-2.5">
                            <span className={`h-3 w-3 shrink-0 rounded-full ${c.bg}`} />
                            <span className={`text-sm font-semibold ${isEmpty ? "text-neutral-400" : "text-neutral-800"}`}>{type}</span>
                          </div>
                          {/* Bar */}
                          <div className="min-w-[9rem] flex-1 h-5 bg-neutral-100 rounded-full overflow-hidden">
                            {pct > 0 && <div className={`h-full rounded-full ${c.bg}`} style={{ width: `${pct}%` }} />}
                          </div>
                          {/* Numbers */}
                          <div className="w-20 shrink-0 text-right">
                            <span className={`text-sm font-black ${isEmpty ? "text-neutral-300" : "text-neutral-900"}`}>{pct}%</span>
                            <span className="text-xs text-neutral-400 ml-1">({count})</span>
                          </div>
                          <button
                            type="button"
                            disabled={isEmpty}
                            aria-expanded={isExpanded}
                            aria-controls={examplesId}
                             onClick={() => setExpandedQuestionTypes((current) => ({ ...current, [type]: !current[type] }))}
                            className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-left text-xs font-semibold text-neutral-700 transition-colors hover:border-neutral-400 hover:bg-neutral-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:border-transparent disabled:bg-transparent disabled:text-neutral-400 sm:ml-auto sm:w-auto"
                          >
                            <span>{isExpanded ? "Hide examples" : "Show examples"}</span>
                            {!isEmpty && <span className="ml-1 font-normal text-neutral-400">({examples.length})</span>}
                            {!isEmpty && <span className="ml-2 text-neutral-400" aria-hidden="true">{isExpanded ? "↑" : "↓"}</span>}
                          </button>
                        </div>
                        {isExpanded && (
                          <div id={examplesId} className="mx-2 mb-2 rounded-xl border border-neutral-100 bg-neutral-50 px-4 py-3">
                             <p className="text-xs font-semibold text-neutral-800">{analysisMeta[type as keyof typeof analysisMeta].description}</p>
                            <p className="mt-1 text-[11px] text-neutral-500">Examples from this class:</p>
                            <ul className="mt-2 grid gap-2 md:grid-cols-2">
                              {examples.map((example, index) => (
                                <li key={`${type}-${index}`} className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs leading-relaxed text-neutral-700">
                                  “{example}”
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    );
                  })}
            </div>

             {/* Taxonomy key */}
            <div className="mt-6 border-t border-neutral-100 pt-5">
              <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                 <p className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">
                   {isKnowledgeDimensionsTask ? "What each knowledge signal means" : "What each question type means"}
                 </p>
                <p className="text-xs text-neutral-400">The buttons above show the class questions; these cards explain the categories.</p>
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
                {(analysisTypes as readonly string[]).map((t) => {
                  const c = analysisStyles[t] ?? { bg: "bg-neutral-300", text: "text-neutral-500", light: "bg-neutral-50" };
                  return (
                    <div key={t} className={`rounded-xl border border-neutral-100 p-3 ${c.light}`}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`w-2.5 h-2.5 rounded-full ${c.bg}`} />
                        <p className={`text-xs font-semibold ${c.text}`}>{t}</p>
                      </div>
                      <p className="text-[11px] text-neutral-500 leading-snug">{analysisMeta[t as keyof typeof analysisMeta].description}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        )}

        {insightHistory.length > 1 && (
          <div className="space-y-3" aria-label="Previous teaching intelligence reports">
            {insightHistory.slice(0, -1).map((report, index) => (
              <details key={`${report.generatedAt}-${index}`} className="group overflow-hidden rounded-[2rem] border border-neutral-300 bg-white shadow-sm">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-8 py-5 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
                  <div className="min-w-0">
                    <p className="text-xs uppercase tracking-[0.2em] font-semibold text-neutral-400">Previous AI analysis</p>
                    <p className="mt-1 text-sm font-medium text-neutral-700">
                      Generated {new Date(report.generatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-2" onClick={(event) => event.stopPropagation()}>
                    <button
                      type="button"
                      onClick={() => void handleDownloadHistoricalPdf(report, index)}
                      className="rounded-full border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-500 transition-colors hover:border-neutral-400 hover:text-neutral-800"
                      aria-label={`Download PDF for report generated ${new Date(report.generatedAt).toLocaleDateString("en-GB")}`}
                      data-testid={`button-previous-teaching-intelligence-pdf-${index}`}
                    >
                      PDF
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDownloadHistoricalCsv(report, index)}
                      className="rounded-full border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-500 transition-colors hover:border-neutral-400 hover:text-neutral-800"
                      aria-label={`Download CSV for report generated ${new Date(report.generatedAt).toLocaleDateString("en-GB")}`}
                      data-testid={`button-previous-teaching-intelligence-csv-${index}`}
                    >
                      CSV
                    </button>
                    <span className="rounded-full border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-500 transition-colors group-open:bg-neutral-900 group-open:text-white">
                      View report
                    </span>
                  </div>
                </summary>
                <div className="border-t border-neutral-200">
                  <InsightReportContent insights={report} />
                </div>
              </details>
            ))}
          </div>
        )}

        {/* AI Teaching Insights */}
        {insights ? (
          <section id="teaching-intelligence-report" className="rounded-[2rem] bg-white border-2 border-neutral-900 shadow-sm overflow-hidden">
            <div className="border-b border-neutral-200 px-8 py-6 flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] font-semibold text-neutral-400 mb-1">AI Analysis</p>
                <h2 className="text-2xl font-semibold tracking-tight">Teaching Insights</h2>
                {insightsGeneratedAt && (
                  <p className="text-xs text-neutral-400 mt-1">
                    Generated {new Date(insightsGeneratedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap justify-end gap-2 shrink-0 mt-1">
                <button
                  type="button"
                  onClick={() => void handleDownloadPdf()}
                  className="rounded-full border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-500 transition-colors hover:border-neutral-400 hover:text-neutral-800"
                  aria-label="Download current Teaching Insights as PDF"
                  data-testid="button-current-teaching-intelligence-pdf"
                  data-export-controls
                >
                  PDF
                </button>
                <button
                  type="button"
                  onClick={handleDownloadCsv}
                  disabled={studentCount === 0}
                  className="rounded-full border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-500 transition-colors hover:border-neutral-400 hover:text-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label="Download current Teaching Insights as CSV"
                  data-testid="button-current-teaching-intelligence-csv"
                  data-export-controls
                >
                  CSV
                </button>
                <button
                  type="button"
                  onClick={() => setReportOpen((open) => !open)}
                  aria-expanded={reportOpen}
                  aria-controls="teaching-intelligence-report-content"
                  className="flex items-center gap-2 px-4 py-2 rounded-xl border border-neutral-200 bg-white text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors"
                  data-testid="button-toggle-teaching-intelligence"
                >
                  <span aria-hidden="true">{reportOpen ? "−" : "+"}</span>
                  {reportOpen ? "Collapse report" : "Expand report"}
                </button>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl border border-neutral-200 bg-white text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors"
                >
                  {copied ? (
                    <><svg className="w-4 h-4 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>Copied</>
                  ) : (
                    <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>Copy</>
                  )}
                </button>
              </div>
            </div>

            <div id="teaching-intelligence-report-content" className={`${reportOpen ? "" : "hidden"} report-collapsible-content p-8 space-y-8`}>
              {insights.questionTypeInsight && (
                <div>
                  <p className="text-xs uppercase tracking-widest font-semibold text-amber-500 mb-3">What the questions tell you</p>
                  <p className="text-neutral-700 leading-relaxed">{insights.questionTypeInsight}</p>
                </div>
              )}

              {((insights.confidentAreas?.length ?? 0) > 0 || (insights.knowledgeGaps?.length ?? 0) > 0) && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {(insights.confidentAreas?.length ?? 0) > 0 && (
                    <div className="rounded-2xl bg-emerald-50 border border-emerald-100 p-5">
                      <p className="text-xs uppercase tracking-widest font-semibold text-emerald-600 mb-3">Where students seem solid</p>
                      <ul className="space-y-2">
                        {(insights.confidentAreas as string[]).map((item, i) => (
                          <li key={i} className="flex gap-2.5 text-sm text-emerald-900 leading-relaxed">
                            <span className="mt-0.5 shrink-0 w-4 h-4 rounded-full bg-emerald-200 flex items-center justify-center text-[10px] font-bold text-emerald-700">{i + 1}</span>
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {(insights.knowledgeGaps?.length ?? 0) > 0 && (
                    <div className="rounded-2xl bg-red-50 border border-red-100 p-5">
                      <p className="text-xs uppercase tracking-widest font-semibold text-red-500 mb-3">Where gaps appear</p>
                      <ul className="space-y-2">
                        {(insights.knowledgeGaps as string[]).map((item, i) => (
                          <li key={i} className="flex gap-2.5 text-sm text-red-900 leading-relaxed">
                            <span className="mt-0.5 shrink-0 w-4 h-4 rounded-full bg-red-200 flex items-center justify-center text-[10px] font-bold text-red-700">{i + 1}</span>
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {(insights.misconceptionQuotes?.length ?? 0) > 0 && (
                <div className="rounded-2xl bg-orange-50 border border-orange-100 p-5">
                  <p className="text-xs uppercase tracking-widest font-semibold text-orange-500 mb-3">Misconceptions — in their own words</p>
                  <ul className="space-y-3">
                    {(insights.misconceptionQuotes as string[]).map((item, i) => {
                      const dash = item.indexOf(" — ");
                      const quote = dash > -1 ? item.slice(0, dash) : item;
                      const explanation = dash > -1 ? item.slice(dash + 3) : "";
                      return (
                        <li key={i} className="space-y-1">
                          <p className="text-sm font-medium text-orange-900 italic">"{quote}"</p>
                          {explanation && <p className="text-xs text-orange-700 leading-relaxed">{explanation}</p>}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {(insights.stagePatterns?.length ?? 0) > 0 && (
                <div>
                  <p className="text-xs uppercase tracking-widest font-semibold text-sky-500 mb-3">Stage patterns</p>
                  <ul className="space-y-2">
                    {(insights.stagePatterns as string[]).map((item, i) => (
                      <li key={i} className="flex gap-3 text-sm text-neutral-700 leading-relaxed">
                        <span className="mt-0.5 shrink-0 text-sky-300">◆</span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {(insights.teachingRecommendations?.length ?? 0) > 0 && (
                <div>
                  <p className="text-xs uppercase tracking-widest font-semibold text-neutral-500 mb-3">Teaching recommendations</p>
                  <ol className="space-y-2">
                    {(insights.teachingRecommendations as string[]).map((item, i) => (
                      <li key={i} className="flex gap-3 text-sm text-neutral-700 leading-relaxed">
                        <span className="mt-0.5 shrink-0 w-5 h-5 rounded-full bg-neutral-200 flex items-center justify-center text-[10px] font-bold text-neutral-600">{i + 1}</span>
                        {item}
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {(insights.nextLessonPlan?.length ?? 0) > 0 && (
                <div className="rounded-2xl bg-neutral-900 text-white p-6">
                  <p className="text-xs uppercase tracking-widest font-semibold text-neutral-400 mb-4">Next lesson — suggested plan</p>
                  <ol className="space-y-3">
                    {(insights.nextLessonPlan as string[]).map((item, i) => (
                      <li key={i} className="flex gap-4 leading-relaxed">
                        <span className="mt-0.5 shrink-0 w-7 h-7 rounded-full bg-white text-neutral-900 flex items-center justify-center text-xs font-bold">
                          {i + 1}
                        </span>
                        <span className="text-sm text-neutral-100 leading-relaxed">{item}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          </section>
        ) : studentCount > 0 ? (
          <div className="rounded-[2rem] border-2 border-dashed border-neutral-200 p-12 text-center">
            <p className="text-3xl mb-3">✦</p>
            <p className="text-neutral-400 text-sm mb-4">
              Click <strong className="text-neutral-600">Generate AI Analysis</strong> above to get question-type intelligence,<br />
              knowledge gaps, and concrete recommendations for your next lesson.
            </p>
            <button
              onClick={handleSynthesise}
              disabled={synthesising}
              className="px-6 py-2.5 rounded-xl bg-neutral-900 text-white text-sm font-medium hover:bg-neutral-700 transition-colors disabled:opacity-40"
            >
              {synthesising ? "Analysing…" : "Generate AI Analysis"}
            </button>
          </div>
        ) : null}

      </main>
    </div>
  );
}
