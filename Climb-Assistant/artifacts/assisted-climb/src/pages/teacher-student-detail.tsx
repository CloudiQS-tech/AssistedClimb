import { useState, useEffect, useCallback, useRef, useLayoutEffect } from "react";
import { Link, useRoute } from "wouter";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { classifyMessages, classifyQuestion, QUESTION_TYPE_META, QUESTION_TYPES } from "@/lib/question-classifier";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

function AutoTextarea({ value, onChange, placeholder, className }: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  className?: string;
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
      rows={1}
      value={value}
      onChange={onChange}
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

function StageFeedbackPanel({
  stage,
  feedback,
  onUpdate,
}: {
  stage: string;
  feedback: { grade: Grade | null; comment: string; formativeComment: string } | undefined;
  onUpdate: (patch: Partial<{ grade: Grade | null; comment: string; formativeComment: string }>) => void;
}) {
  const current = feedback ?? { grade: null, comment: "", formativeComment: "" };
  return (
    <div className="border-t border-neutral-200 bg-neutral-50 px-8 py-6 space-y-5">
      <p className="text-xs uppercase tracking-[0.2em] font-semibold text-neutral-400">Teacher Feedback — {stage}</p>

      <div>
        <label className="block text-xs font-semibold text-neutral-600 mb-1">Formative Feedback</label>
        <p className="text-[11px] text-neutral-400 mb-2">In-progress observations — visible to the student immediately. Address them directly: "You…" not their name.</p>
        <AutoTextarea
          className="w-full rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-neutral-300 placeholder:text-neutral-400"
          placeholder="e.g. You're asking great questions — now push yourself to evaluate the sources…"
          value={current.formativeComment}
          onChange={(e) => onUpdate({ formativeComment: e.target.value })}
        />
      </div>

      <div className="border-t border-neutral-100 pt-4 space-y-3">
        <label className="block text-xs font-semibold text-neutral-600">Summative Feedback</label>
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
                onClick={() => onUpdate({ grade: current.grade === g ? null : g })}
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-semibold border transition-all ${
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
          className="w-full rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-neutral-300 placeholder:text-neutral-400"
          placeholder="e.g. You showed strong analytical thinking here — now push further by…"
          value={current.comment}
          onChange={(e) => onUpdate({ comment: e.target.value })}
        />
      </div>
    </div>
  );
}

export default function TeacherStudentDetail() {
  const [, params] = useRoute("/teacher/class/:classId/student/:sessionId");
  const classId = params?.classId;
  const sessionId = params?.sessionId;

  const [data, setData] = useState<any>(null);
  const [task, setTask] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [pinResetting, setPinResetting] = useState(false);
  const [pinJustReset, setPinJustReset] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, { grade: Grade | null; comment: string; formativeComment: string }>>({});
  const [overallAssessment, setOverallAssessment] = useState<{ comment: string; grade: string } | null>(null);
  const [synthLoading, setSynthLoading] = useState(false);
  const [formativeLoading, setFormativeLoading] = useState(false);
  const [summativePerStageLoading, setSummativePerStageLoading] = useState(false);
  const [torchExpanded, setTorchExpanded] = useState(false);
  const [researchExpanded, setResearchExpanded] = useState(false);
  const [pendingAiType, setPendingAiType] = useState<"formative" | "summative" | null>(null);
  const pendingAiRef = useRef<"formative" | "summative" | null>(null);
  const feedbackSnapshot = useRef<Record<string, { grade: Grade | null; comment: string; formativeComment: string }>>({});
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const { toast } = useToast();

  useEffect(() => {
    if (!classId || !sessionId) return;
    apiFetch(`/teacher/classes/${classId}/students/${sessionId}`)
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
    apiFetch(`/teacher/classes/${classId}/task`)
      .then(setTask)
      .catch(() => {});
    apiFetch(`/teacher/classes/${classId}/students/${sessionId}/feedback`)
      .then((fb: any) => {
        setFeedback(fb ?? {});
        if (fb?.OVERALL) setOverallAssessment({ comment: fb.OVERALL.comment, grade: fb.OVERALL.grade ?? "" });
      })
      .catch(() => {});
  }, [classId, sessionId]);

  const saveFeedback = useCallback((stage: string, grade: Grade | null, comment: string, formativeComment: string) => {
    if (pendingAiRef.current !== null) return;
    clearTimeout(saveTimers.current[stage]);
    saveTimers.current[stage] = setTimeout(() => {
      apiFetch(`/teacher/classes/${classId}/students/${sessionId}/feedback/${stage}`, {
        method: "PUT",
        body: JSON.stringify({ grade, comment, formativeComment }),
      }).catch(() => {});
    }, 800);
  }, [classId, sessionId]);

  const updateFeedback = useCallback((stage: string, patch: Partial<{ grade: Grade | null; comment: string; formativeComment: string }>) => {
    setFeedback((prev) => {
      const current = prev[stage] ?? { grade: null, comment: "", formativeComment: "" };
      const updated = { ...current, ...patch };
      saveFeedback(stage, updated.grade, updated.comment, updated.formativeComment);
      return { ...prev, [stage]: updated };
    });
  }, [saveFeedback]);

  const handleSynthesise = async () => {
    setSynthLoading(true);
    try {
      const result: any = await apiFetch(
        `/teacher/classes/${classId}/students/${sessionId}/feedback/synthesize`,
        { method: "POST" },
      );
      setOverallAssessment(result);
      await apiFetch(`/teacher/classes/${classId}/students/${sessionId}/feedback/OVERALL`, {
        method: "PUT",
        body: JSON.stringify({ grade: result.grade, comment: result.comment }),
      });
    } catch (err: any) {
      toast({ title: "Failed to generate assessment", description: err.message, variant: "destructive" });
    } finally {
      setSynthLoading(false);
    }
  };

  const handleGenerateSummativePerStage = async () => {
    setSummativePerStageLoading(true);
    try {
      const result: Record<string, { grade: string; comment: string }> = await apiFetch(
        `/teacher/classes/${classId}/students/${sessionId}/generate-summative-per-stage`,
        { method: "POST" },
      );
      feedbackSnapshot.current = JSON.parse(JSON.stringify(feedback));
      pendingAiRef.current = "summative";
      setPendingAiType("summative");
      setFeedback((prev) => {
        const next = { ...prev };
        for (const [stage, { grade, comment }] of Object.entries(result)) {
          const current = next[stage] ?? { grade: null, comment: "", formativeComment: "" };
          next[stage] = { ...current, grade: grade as Grade, comment };
        }
        return next;
      });
      toast({ title: "Summative draft ready", description: "Review and edit below, then click Submit to save." });
    } catch (err: any) {
      toast({ title: "Failed to generate summative feedback", description: err.message, variant: "destructive" });
    } finally {
      setSummativePerStageLoading(false);
    }
  };

  const handleGenerateFormative = async () => {
    setFormativeLoading(true);
    try {
      const result: Record<string, string> = await apiFetch(
        `/teacher/classes/${classId}/students/${sessionId}/generate-formative-feedback`,
        { method: "POST" },
      );
      feedbackSnapshot.current = JSON.parse(JSON.stringify(feedback));
      pendingAiRef.current = "formative";
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
      toast({ title: "Failed to generate feedback", description: err.message, variant: "destructive" });
    } finally {
      setFormativeLoading(false);
    }
  };

  const handleSubmitAiFeedback = async () => {
    pendingAiRef.current = null;
    setPendingAiType(null);
    const saves = Object.entries(feedback).map(([stage, fb]) =>
      apiFetch(`/teacher/classes/${classId}/students/${sessionId}/feedback/${stage}`, {
        method: "PUT",
        body: JSON.stringify({ grade: fb.grade, comment: fb.comment, formativeComment: fb.formativeComment }),
      }).catch(() => {}),
    );
    await Promise.all(saves);
    toast({ title: "Feedback saved", description: "All stages have been saved successfully." });
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

  if (loading) return null;
  if (!data) return <div className="p-6">Data not found</div>;

  const { session, stageEntries: entries, chatMessages: messages } = data;

  const mapEntry = entries.find((e: any) => e.stage === "MAP")?.contentJson || {};
  const researchEntry = entries.find((e: any) => e.stage === "RESEARCH")?.contentJson || {};
  const compassEntry = entries.find((e: any) => e.stage === "COMPASS")?.contentJson || {};
  const embedEntry = entries.find((e: any) => e.stage === "EMBED")?.contentJson || {};

  const researchSources: any[] = researchEntry.entries ?? [];

  // Derive started vs finished from actual content
  const stageStarted: Record<string, boolean> = {
    MAP: !!(mapEntry.taskUnderstanding?.trim() || mapEntry.priorKnowledge?.some((p: string) => p?.trim()) || mapEntry.enquiryQuestions?.some((q: string) => q?.trim())),
    TORCH: messages.length > 0,
    RESEARCH: researchSources.some((s: any) => s.source || s.url || s.title || s.findings || s.importantPoints),
    COMPASS: !!(compassEntry.check1 || compassEntry.check2 || compassEntry.check3 || compassEntry.check4 || compassEntry.check5),
    EMBED: !!(embedEntry.finalAnswer || embedEntry.q1 || embedEntry.q2 || embedEntry.q3 || embedEntry.q4),
  };
  const stageComplete: Record<string, boolean> = {
    MAP: mapEntry.taskUnderstanding?.trim().length >= 20
      && mapEntry.priorKnowledge?.filter((p: string) => p?.trim()).length >= 2
      && mapEntry.knowledgeGaps?.filter((g: string) => g?.trim()).length >= 3
      && mapEntry.enquiryQuestions?.filter((q: string) => q?.trim()).length >= 3,
    TORCH: messages.length >= 6,
    RESEARCH: researchSources.filter((s: any) => (s.source || s.title) && s.findings).length >= 1,
    COMPASS: !!(compassEntry.check1?.trim() && compassEntry.check2?.trim() && compassEntry.check3?.trim() && compassEntry.check4?.trim() && compassEntry.check5?.trim()),
    EMBED: !!(embedEntry.finalAnswer?.trim() && embedEntry.q1?.trim() && embedEntry.q2?.trim() && embedEntry.q3?.trim() && embedEntry.q4?.trim()),
  };

  return (
    <div className="min-h-[100dvh] bg-neutral-50 text-neutral-900 font-sans pb-20">
      <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm">
            <Link href="/teacher/dashboard" className="text-neutral-500 hover:text-black">Dashboard</Link>
            <span className="text-neutral-300">/</span>
            <Link href={`/teacher/class/${classId}`} className="text-neutral-500 hover:text-black">Class View</Link>
            <span className="text-neutral-300">/</span>
            <span className="font-medium">{session.studentName}</span>
          </div>
          <Link
            href={`/teacher/class/${classId}/student/${sessionId}/report`}
            className="rounded-2xl border border-neutral-300 px-5 py-2 text-sm font-medium hover:bg-neutral-100 transition-colors"
            data-testid="button-student-report"
          >
            Print Report
          </Link>
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
              className="text-sm font-semibold bg-amber-500 text-white px-4 py-1.5 rounded-lg hover:bg-amber-600 transition-colors"
            >
              Submit Feedback
            </button>
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-6 py-12 space-y-8">

        {/* Student header + progress */}
        <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight mb-1">{session.studentName}'s Climb</h1>
              {task && (
                <div className="mt-2 space-y-0.5">
                  <p className="text-sm font-semibold text-neutral-700">{task.title}</p>
                  {task.question && <p className="text-sm text-neutral-500 leading-relaxed">{task.question}</p>}
                </div>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  onClick={handleGenerateFormative}
                  disabled={formativeLoading}
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
                  ) : "Generate Formative Feedback"}
                </button>
                <button
                  onClick={handleGenerateSummativePerStage}
                  disabled={summativePerStageLoading}
                  className="rounded-2xl bg-violet-600 text-white px-5 py-2 text-sm font-semibold hover:bg-violet-700 transition-colors disabled:opacity-50 flex items-center gap-2"
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
                  ) : "Generate Summative Feedback"}
                </button>
                <button
                  onClick={handleResetPin}
                  disabled={pinResetting || pinJustReset}
                  className="rounded-2xl border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 transition-colors disabled:opacity-40"
                  data-testid="button-reset-pin"
                >
                  {pinResetting ? "Resetting…" : pinJustReset ? "✓ PIN Reset" : "Reset PIN"}
                </button>
                {pinJustReset && (
                  <span className="text-xs text-neutral-400">Student will set a new PIN on next join.</span>
                )}
              </div>
            </div>
          </div>
        </div>

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
              const label = stage === "EMBED" ? "Final Response" : stage;
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

        {/* MAP */}
        <section id="section-map" data-testid="section-map" className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
          <div className="border-b border-neutral-200 px-8 py-6">
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-2">MAP</p>
            <h3 className="text-2xl font-semibold tracking-tight">Planning My Enquiry</h3>
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
          />
          <div className="flex justify-end px-8 pb-5">
            <button onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} className="text-xs text-neutral-400 hover:text-neutral-700 transition-colors">↑ Back to top</button>
          </div>
        </section>

        {/* TORCH */}
        <section id="section-torch" data-testid="section-torch" className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
          <div className="border-b border-neutral-200 px-8 py-6">
            <p className="text-xs uppercase tracking-[0.2em] text-amber-500 mb-2">TORCH</p>
            <h3 className="text-2xl font-semibold tracking-tight">Guided AI-Mediated Investigation</h3>
            <p className="text-sm text-neutral-500 mt-1">{messages.length} message{messages.length !== 1 ? "s" : ""}</p>
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
          />
          <div className="flex justify-end px-8 pb-5">
            <button onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} className="text-xs text-neutral-400 hover:text-neutral-700 transition-colors">↑ Back to top</button>
          </div>
        </section>

        {/* RESEARCH LOG */}
        <section id="section-research" data-testid="section-research" className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
          <div className="border-b border-neutral-200 px-8 py-6">
            <p className="text-xs uppercase tracking-[0.2em] text-sky-500 mb-2">RESEARCH LOG</p>
            <h3 className="text-2xl font-semibold tracking-tight">Sources & Research Notes</h3>
            <p className="text-sm text-neutral-500 mt-1">{researchSources.length} source{researchSources.length !== 1 ? "s" : ""} logged</p>
          </div>
          {researchSources.length === 0 ? (
            <div className="p-8">
              <p className="italic text-neutral-400">No sources logged yet.</p>
            </div>
          ) : (
            <>
              <div className="divide-y divide-neutral-100">
                {(researchExpanded ? researchSources : researchSources.slice(0, 2)).map((entry: any, idx: number) => (
                  <div key={entry.id ?? idx} className="p-8 space-y-4">
                    <p className="text-xs font-bold uppercase tracking-widest text-neutral-400">Source {idx + 1}</p>
                    {entry.source && (
                      <div>
                        <p className="text-xs font-medium text-neutral-400 mb-1">Source</p>
                        <p className="text-sm font-medium text-neutral-800">{entry.source}</p>
                      </div>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {[
                        { label: "What did they find?", value: entry.findings },
                        { label: "Important points", value: entry.importantPoints },
                        { label: "Reliability check", value: entry.reliability },
                        { label: "How are they using it?", value: entry.usage },
                      ].map((item, i) => (
                        <div key={i}>
                          <p className="text-xs font-medium text-neutral-400 mb-1">{item.label}</p>
                          <div className="rounded-2xl bg-neutral-50 border border-neutral-200 p-4 min-h-[60px] whitespace-pre-wrap text-sm">
                            {item.value || <span className="italic text-neutral-400">Not completed</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
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
          />
          <div className="flex justify-end px-8 pb-5">
            <button onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} className="text-xs text-neutral-400 hover:text-neutral-700 transition-colors">↑ Back to top</button>
          </div>
        </section>

        {/* COMPASS */}
        <section id="section-compass" data-testid="section-compass" className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
          <div className="border-b border-neutral-200 px-8 py-6">
            <p className="text-xs uppercase tracking-[0.2em] text-emerald-500 mb-2">COMPASS</p>
            <h3 className="text-2xl font-semibold tracking-tight">Check Your Thinking</h3>
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
          />
          <div className="flex justify-end px-8 pb-5">
            <button onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} className="text-xs text-neutral-400 hover:text-neutral-700 transition-colors">↑ Back to top</button>
          </div>
        </section>

        {/* EMBED */}
        <section id="section-answer" data-testid="section-embed" className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
          <div className="border-b border-neutral-200 px-8 py-6">
            <p className="text-xs uppercase tracking-[0.2em] text-violet-500 mb-2">ANSWER</p>
            <h3 className="text-2xl font-semibold tracking-tight">Final Answer & Reflection</h3>
          </div>
          {embedEntry.finalAnswer && (
            <div className="px-8 pt-8 pb-4">
              <p className="text-xs uppercase tracking-widest font-semibold text-violet-400 mb-2">Final Answer</p>
              <div className="w-full rounded-2xl bg-violet-50 border border-violet-100 p-5 whitespace-pre-wrap text-sm leading-relaxed">
                {embedEntry.finalAnswer}
              </div>
            </div>
          )}
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
          />
          <div className="flex justify-end px-8 pb-5">
            <button onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} className="text-xs text-neutral-400 hover:text-neutral-700 transition-colors">↑ Back to top</button>
          </div>
        </section>

        {/* OVERALL ASSESSMENT */}
        <section className="rounded-[2rem] bg-white border-2 border-neutral-900 shadow-sm overflow-hidden">
          <div className="border-b border-neutral-200 px-8 py-6 flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] font-semibold text-neutral-400 mb-1">Overall Assessment</p>
              <h3 className="text-2xl font-semibold tracking-tight">Summative Feedback & Overall Grade</h3>
            </div>
            <button
              onClick={handleSynthesise}
              disabled={synthLoading}
              className="px-5 py-2.5 rounded-xl bg-violet-600 text-white text-sm font-semibold hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-wait"
            >
              {synthLoading ? "Generating…" : overallAssessment ? "Regenerate Summative" : "Generate Summative Feedback"}
            </button>
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
                      onClick={() => {
                        const updated = { ...overallAssessment, grade: g };
                        setOverallAssessment(updated);
                        apiFetch(`/teacher/classes/${classId}/students/${sessionId}/feedback/OVERALL`, {
                          method: "PUT",
                          body: JSON.stringify({ grade: g, comment: updated.comment }),
                        }).catch(() => {});
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
                    clearTimeout(saveTimers.current["OVERALL"]);
                    saveTimers.current["OVERALL"] = setTimeout(() => {
                      apiFetch(`/teacher/classes/${classId}/students/${sessionId}/feedback/OVERALL`, {
                        method: "PUT",
                        body: JSON.stringify({ grade: updated.grade, comment: updated.comment }),
                      }).catch(() => {});
                    }, 800);
                  }}
                />
                <p className="text-xs text-neutral-400 mt-2">Edits are auto-saved. This comment is suitable for copying directly into your MIS.</p>
              </div>
            </div>
          ) : (
            <div className="px-8 py-12 text-center text-neutral-400 text-sm">
              <p className="mb-2 text-2xl">✦</p>
              <p>Add grades and comments to each stage above, then generate an AI-synthesised overall assessment and MIS-ready report comment.</p>
            </div>
          )}
        </section>

      </main>
    </div>
  );
}
