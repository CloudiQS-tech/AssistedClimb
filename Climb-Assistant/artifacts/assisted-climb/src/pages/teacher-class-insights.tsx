import { useState, useEffect, useMemo } from "react";
import { Link, useRoute } from "wouter";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { classifyMessages, classifyQuestion, QUESTION_TYPE_META, QUESTION_TYPES } from "@/lib/question-classifier";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const STAGES = ["MAP", "TORCH", "COMPASS", "RESEARCH", "EMBED"] as const;
const STAGE_DISPLAY: Record<string, string> = {
  MAP: "MAP", TORCH: "TORCH", RESEARCH: "RESEARCH", COMPASS: "COMPASS", EMBED: "Final Response",
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

export default function TeacherClassInsights() {
  const [, params] = useRoute("/teacher/class/:classId/insights");
  const classId = params?.classId;
  const { toast } = useToast();

  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [synthesising, setSynthesising] = useState(false);
  const [insights, setInsights] = useState<any>(null);
  const [insightsGeneratedAt, setInsightsGeneratedAt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!classId) return;
    apiFetch(`/teacher/classes/${classId}/class-insights`)
      .then((d: any) => {
        setData(d);
        if (d.lastInsights) {
          setInsights(d.lastInsights);
          setInsightsGeneratedAt(d.lastInsightsAt ?? null);
        }
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

  const totalMessages = useMemo(
    () => Object.values(questionTypeCounts).reduce((a: number, b: number) => a + b, 0),
    [questionTypeCounts]
  );

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

  if (loading) return null;
  if (!data) return <div className="p-6 text-neutral-500">Class not found</div>;

  const { task, students, cls } = data;
  const studentCount: number = (students ?? []).length;

  const sortedQTypes = (QUESTION_TYPES as string[])
    .filter((t) => (questionTypeCounts[t] ?? 0) > 0)
    .sort((a, b) => (questionTypeCounts[b] ?? 0) - (questionTypeCounts[a] ?? 0));

  const dominantType = sortedQTypes[0] ?? null;
  const leastType = sortedQTypes[sortedQTypes.length - 1] ?? null;

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

  // Intervention panels
  const interventionStages = STAGES.filter((s) => (stageCompletion[s]?.none ?? 0) > 0);
  // "Needs a nudge" panel: only show students who haven't started anything at all
  const stuckStudents = inProgressStudents;

  const handleCopy = async () => {
    if (!insights) return;
    const date = insightsGeneratedAt
      ? new Date(insightsGeneratedAt).toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })
      : new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    const lines: string[] = [
      "TEACHING INTELLIGENCE",
      `Class: ${cls?.name ?? ""}`,
      `Generated: ${date}`,
      "",
    ];
    if (insights.questionTypeInsight) {
      lines.push("QUESTION TYPE INTELLIGENCE");
      lines.push("─".repeat(40));
      lines.push(insights.questionTypeInsight);
      lines.push("");
    }
    if ((insights.confidentAreas?.length ?? 0) > 0) {
      lines.push("WHAT STUDENTS SEEM CONFIDENT ABOUT");
      lines.push("─".repeat(40));
      (insights.confidentAreas as string[]).forEach((item: string, i: number) => lines.push(`${i + 1}. ${item}`));
      lines.push("");
    }
    if ((insights.knowledgeGaps?.length ?? 0) > 0) {
      lines.push("WHERE GAPS APPEAR");
      lines.push("─".repeat(40));
      (insights.knowledgeGaps as string[]).forEach((item: string, i: number) => lines.push(`${i + 1}. ${item}`));
      lines.push("");
    }
    if ((insights.misconceptionQuotes?.length ?? 0) > 0) {
      lines.push("STUDENT MISCONCEPTIONS (VERBATIM)");
      lines.push("─".repeat(40));
      (insights.misconceptionQuotes as string[]).forEach((item: string) => lines.push(`• ${item}`));
      lines.push("");
    }
    if ((insights.stagePatterns?.length ?? 0) > 0) {
      lines.push("STAGE COMPLETION PATTERNS");
      lines.push("─".repeat(40));
      (insights.stagePatterns as string[]).forEach((item: string) => lines.push(`• ${item}`));
      lines.push("");
    }
    if ((insights.teachingRecommendations?.length ?? 0) > 0) {
      lines.push("TEACHING RECOMMENDATIONS");
      lines.push("─".repeat(40));
      (insights.teachingRecommendations as string[]).forEach((item: string, i: number) => lines.push(`${i + 1}. ${item}`));
      lines.push("");
    }
    if ((insights.nextLessonPlan?.length ?? 0) > 0) {
      lines.push("NEXT LESSON PLAN");
      lines.push("─".repeat(40));
      (insights.nextLessonPlan as string[]).forEach((item: string, i: number) => lines.push(`${i + 1}. ${item}`));
      lines.push("");
    }
    await navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handlePrintReport = () => {
    const style = document.createElement("style");
    style.id = "__report-print-style";
    style.innerHTML = `@media print { body > * { display: none !important; } #teaching-intelligence-report { display: block !important; position: static !important; } }`;
    document.head.appendChild(style);
    window.print();
    document.head.removeChild(style);
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
          questionTypeCounts,
          totalMessages,
          torchSamples,
          stageCompletion: stageCompletionCounts,
          studentCount,
        }),
      });
      setInsights(result);
      setInsightsGeneratedAt(result.generatedAt ?? new Date().toISOString());
    } catch (err: any) {
      toast({ title: "Failed to generate insights", description: err.message, variant: "destructive" });
    } finally {
      setSynthesising(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-neutral-50 text-neutral-900 font-sans pb-20">
      <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/90 backdrop-blur">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm">
            <Link href="/teacher/dashboard" className="text-neutral-500 hover:text-black">Dashboard</Link>
            <span className="text-neutral-300">/</span>
            <Link href={`/teacher/class/${classId}`} className="text-neutral-500 hover:text-black">
              {cls?.name ?? "Class"}
            </Link>
            <span className="text-neutral-300">/</span>
            <span className="font-medium">Teaching Intelligence</span>
          </div>
          <div className="flex items-center gap-2">
            {insightsGeneratedAt && (
              <span className="text-xs text-neutral-400 hidden sm:block">
                Last run: {new Date(insightsGeneratedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
            <button
              onClick={() => window.print()}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-neutral-300 bg-white text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" /></svg>
              Print / PDF
            </button>
            <button
              onClick={handleSynthesise}
              disabled={synthesising || studentCount === 0}
              className="px-5 py-2.5 rounded-xl bg-neutral-900 text-white text-sm font-medium hover:bg-neutral-700 transition-colors disabled:opacity-40 disabled:cursor-wait"
            >
              {synthesising ? "Analysing…" : insights ? "Refresh Analysis" : "Generate AI Analysis"}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-10 space-y-6">

        {/* Page title + stat strip */}
        <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm">
          <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-1">Teaching Intelligence</p>
          <h1 className="text-3xl font-semibold tracking-tight mb-1">{cls?.name ?? "Class"}</h1>
          {task && (
            <p className="text-neutral-500 mt-1 mb-6">
              <span className="font-medium text-neutral-800">{task.title}</span>
              {task.question && <span className="ml-2 text-neutral-400">— {task.question}</span>}
            </p>
          )}

          {studentCount > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4">
              <div className="rounded-2xl bg-neutral-50 border border-neutral-100 p-4 text-center">
                <p className="text-3xl font-black text-neutral-900">{studentCount}</p>
                <p className="text-xs text-neutral-400 mt-1 uppercase tracking-wider">Enrolled</p>
              </div>
              <div className="rounded-2xl bg-emerald-50 border border-emerald-100 p-4 text-center">
                <p className="text-3xl font-black text-emerald-700">{fullyDoneStudents.length}</p>
                <p className="text-xs text-emerald-500 mt-1 uppercase tracking-wider">Climbs Completed</p>
              </div>
              <div className="rounded-2xl bg-amber-50 border border-amber-100 p-4 text-center">
                <p className="text-3xl font-black text-amber-600">{inProgressStudents.length}</p>
                <p className="text-xs text-amber-500 mt-1 uppercase tracking-wider">Climbs In Progress</p>
              </div>
              <div className="rounded-2xl bg-red-50 border border-red-100 p-4 text-center">
                <p className="text-3xl font-black text-red-500">{notStartedStudents.length}</p>
                <p className="text-xs text-red-400 mt-1 uppercase tracking-wider">Climbs Started</p>
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
            <div className="space-y-4">
              {interventionStages.map((stage) => {
                const students = stageCompletion[stage]?.noneStudents ?? [];
                return (
                  <div key={stage} className="flex items-start gap-4">
                    <span className={`shrink-0 text-xs font-semibold px-2.5 py-1 rounded-full border ${STAGE_LIGHT[stage]}`}>
                      {STAGE_DISPLAY[stage]}
                    </span>
                    <div className="flex flex-wrap gap-2 pt-0.5">
                      {students.map((s) => (
                        <Link key={s.id} href={`/teacher/class/${classId}/student/${s.id}`} className="px-3 py-1 rounded-full bg-white border border-red-200 text-sm text-red-700 font-medium shadow-sm hover:bg-red-50 transition-colors">
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
            <div className="space-y-4">
              {STAGES.map((stage) => {
                const students = stageCompletion[stage]?.startedStudents ?? [];
                if (students.length === 0) return null;
                return (
                  <div key={stage} className="flex items-start gap-4">
                    <span className={`shrink-0 text-xs font-semibold px-2.5 py-1 rounded-full border ${STAGE_LIGHT[stage]}`}>
                      {STAGE_DISPLAY[stage]}
                    </span>
                    <div className="flex flex-wrap gap-2 pt-0.5">
                      {students.map((s) => (
                        <Link key={s.id} href={`/teacher/class/${classId}/student/${s.id}`} className="px-3 py-1 rounded-full bg-white border border-amber-200 text-sm text-amber-700 font-medium shadow-sm hover:bg-amber-50 transition-colors">
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
              <div className="flex items-center gap-4">
                <div className="w-28 shrink-0" />
                <div className="flex-1" />
                <div className="w-44 shrink-0 grid grid-cols-3 text-center">
                  <span className="text-[10px] uppercase font-semibold text-emerald-600">Done</span>
                  <span className="text-[10px] uppercase font-semibold text-amber-500">Started</span>
                  <span className="text-[10px] uppercase font-semibold text-red-500">Incomplete</span>
                </div>
              </div>
              {STAGES.map((stage) => {
                const counts = stageCompletion[stage] ?? { finished: 0, started: 0, none: studentCount, finishedNames: [], startedNames: [], noneNames: [] };
                const finPct = studentCount > 0 ? (counts.finished / studentCount) * 100 : 0;
                const startPct = studentCount > 0 ? (counts.started / studentCount) * 100 : 0;
                return (
                  <div key={stage} className="flex items-center gap-4">
                    <div className={`w-28 shrink-0 text-center text-xs font-semibold px-2.5 py-1.5 rounded-full border ${STAGE_LIGHT[stage]}`}>
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
                    <div className="w-44 shrink-0 grid grid-cols-3 text-center">
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

        {/* TORCH — Question Type Analysis */}
        {totalMessages > 0 && (
          <section className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm">
            <div className="flex items-start justify-between mb-6">
              <div>
                <h2 className="text-xs uppercase tracking-[0.2em] font-semibold text-neutral-400 mb-1">
                  TORCH — How students asked questions
                </h2>
                <p className="text-sm text-neutral-500">{totalMessages} AI messages across the class</p>
              </div>
              {dominantType && (
                <div className="flex gap-2 text-xs flex-wrap justify-end">
                  <span className="px-3 py-1.5 rounded-full bg-neutral-900 text-white font-medium">
                    Most: {dominantType} ({questionTypeCounts[dominantType]})
                  </span>
                  {leastType && leastType !== dominantType && (
                    <span className="px-3 py-1.5 rounded-full bg-neutral-100 text-neutral-500 font-medium">
                      Least: {leastType} ({questionTypeCounts[leastType]})
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Stacked overview bar */}
            <div className="flex h-3 rounded-full overflow-hidden gap-px mb-6">
              {(QUESTION_TYPES as string[]).map((type) => {
                const pct = totalMessages > 0 ? ((questionTypeCounts[type] ?? 0) / totalMessages) * 100 : 0;
                if (pct === 0) return null;
                return <div key={type} className={QT[type]?.bg ?? "bg-neutral-300"} style={{ width: `${pct}%` }} title={`${type}: ${Math.round(pct)}%`} />;
              })}
            </div>

            {/* Per-type rows — all types, sorted highest first */}
            <TooltipProvider delayDuration={200}>
              <div className="space-y-2">
                {(QUESTION_TYPES as string[])
                  .slice()
                  .sort((a, b) => (questionTypeCounts[b] ?? 0) - (questionTypeCounts[a] ?? 0))
                  .map((type) => {
                    const count = questionTypeCounts[type] ?? 0;
                    const pct = totalMessages > 0 ? Math.round((count / totalMessages) * 100) : 0;
                    const qt = type as keyof typeof QUESTION_TYPE_META;
                    const isEmpty = count === 0;
                    const c = QT[type] ?? { bg: "bg-neutral-300", text: "text-neutral-500", light: "bg-neutral-50" };
                    return (
                      <div key={type} className={`flex items-center gap-3 ${isEmpty ? "opacity-35" : ""}`}>
                        {/* Dot + label */}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="w-44 shrink-0 flex items-center gap-2.5 cursor-default">
                              <span className={`w-3 h-3 rounded-full shrink-0 ${c.bg}`} />
                              <span className={`text-sm font-semibold ${isEmpty ? "text-neutral-400" : "text-neutral-800"}`}>{type}</span>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="right" className="max-w-[320px] text-left p-3 bg-white text-neutral-900 border border-neutral-200 shadow-lg">
                            <p className="font-semibold text-neutral-800 mb-2">{QUESTION_TYPE_META[qt].description}</p>
                            {isEmpty ? (
                              <p className="text-xs text-neutral-400 italic">No questions of this type yet.</p>
                            ) : (
                              <ul className="space-y-1 max-h-52 overflow-y-auto pr-1">
                                {(data.torchMessages as any[])
                                  .filter((m: any) => m.role === "user" && classifyQuestion(m.content) === type)
                                  .map((m: any, i: number) => (
                                    <li key={i} className="text-[11px] text-neutral-500">"{m.content}"</li>
                                  ))}
                              </ul>
                            )}
                          </TooltipContent>
                        </Tooltip>
                        {/* Bar */}
                        <div className="flex-1 h-5 bg-neutral-100 rounded-full overflow-hidden">
                          {pct > 0 && <div className={`h-full rounded-full ${c.bg}`} style={{ width: `${pct}%` }} />}
                        </div>
                        {/* Numbers */}
                        <div className="w-20 shrink-0 text-right">
                          <span className={`text-sm font-black ${isEmpty ? "text-neutral-300" : "text-neutral-900"}`}>{pct}%</span>
                          <span className="text-xs text-neutral-400 ml-1">({count})</span>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </TooltipProvider>

            {/* Question type key */}
            <div className="mt-5 pt-5 border-t border-neutral-100 grid grid-cols-2 md:grid-cols-4 gap-3">
              {(["Factual", "Conceptual", "Analytical", "Evaluative"] as const).map((t) => {
                const c = QT[t];
                return (
                  <div key={t} className={`rounded-xl border border-neutral-100 p-3 ${c.light}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`w-2.5 h-2.5 rounded-full ${c.bg}`} />
                      <p className={`text-xs font-semibold ${c.text}`}>{t}</p>
                    </div>
                    <p className="text-[11px] text-neutral-500 leading-snug">{QUESTION_TYPE_META[t].description}</p>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* AI Teaching Intelligence */}
        {insights ? (
          <section id="teaching-intelligence-report" className="rounded-[2rem] bg-white border-2 border-neutral-900 shadow-sm overflow-hidden">
            <div className="border-b border-neutral-200 px-8 py-6 flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] font-semibold text-neutral-400 mb-1">AI Analysis</p>
                <h2 className="text-2xl font-semibold tracking-tight">Teaching Intelligence</h2>
                {insightsGeneratedAt && (
                  <p className="text-xs text-neutral-400 mt-1">
                    Generated {new Date(insightsGeneratedAt).toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </p>
                )}
              </div>
              <div className="flex gap-2 shrink-0 mt-1">
                <button
                  onClick={handleCopy}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl border border-neutral-200 bg-white text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors"
                >
                  {copied ? (
                    <><svg className="w-4 h-4 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>Copied</>
                  ) : (
                    <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>Copy</>
                  )}
                </button>
                <button
                  onClick={handlePrintReport}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl border border-neutral-900 bg-neutral-900 text-sm font-medium text-white hover:bg-neutral-700 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                  Download PDF
                </button>
              </div>
            </div>

            <div className="p-8 space-y-8">
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
