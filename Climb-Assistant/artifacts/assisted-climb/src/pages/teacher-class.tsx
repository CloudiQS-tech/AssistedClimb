import { useState, useEffect } from "react";
import { Link, useRoute, useLocation } from "wouter";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { classifyMessages, classifyQuestion, QUESTION_TYPE_META, QUESTION_TYPES } from "@/lib/question-classifier";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button
      onClick={copy}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
        copied
          ? "bg-emerald-100 text-emerald-700 border border-emerald-200"
          : "bg-white text-neutral-500 border border-neutral-200 hover:text-neutral-800 hover:border-neutral-300"
      }`}
    >
      {copied ? (
        <>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          Copied
        </>
      ) : (
        <>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="4" y="4" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.2"/><path d="M3 8H2.5A1.5 1.5 0 0 1 1 6.5v-5A1.5 1.5 0 0 1 2.5 0h5A1.5 1.5 0 0 1 9 1.5V2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
          Copy code
        </>
      )}
    </button>
  );
}

const ALL_STAGES = ["MAP", "TORCH", "COMPASS", "EMBED", "RESEARCH"] as const;
type Stage = (typeof ALL_STAGES)[number];

const STAGE_COLOR: Record<Stage, string> = {
  MAP: "bg-neutral-800 text-white",
  TORCH: "bg-amber-500 text-white",
  RESEARCH: "bg-sky-500 text-white",
  COMPASS: "bg-emerald-500 text-white",
  EMBED: "bg-violet-500 text-white",
};

const STAGE_LIGHT: Record<Stage, string> = {
  MAP: "bg-neutral-100 text-neutral-700",
  TORCH: "bg-amber-50 text-amber-700",
  RESEARCH: "bg-sky-50 text-sky-700",
  COMPASS: "bg-emerald-50 text-emerald-700",
  EMBED: "bg-violet-50 text-violet-700",
};

const RAG_FINISHED = "bg-emerald-500 text-white";
const RAG_STARTED  = "bg-amber-400 text-white";
const RAG_NONE     = "bg-red-400 text-white";

const ALL_BLOOM = ["Remember", "Understand", "Apply", "Analyse", "Evaluate", "Create"];

export default function TeacherClass() {
  const [, params] = useRoute("/teacher/class/:classId");
  const classId = params?.classId;
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const [cls, setCls] = useState<any>(null);
  const [students, setStudents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [removingStudent, setRemovingStudent] = useState<number | null>(null);
  const [unlockingPin, setUnlockingPin] = useState<number | null>(null);

  const [studentQuestionTypes, setStudentQuestionTypes] = useState<Record<number, Record<string, number>>>({});
  const [studentMessages, setStudentMessages] = useState<Record<number, string[]>>({});

  const [task, setTask] = useState<any>(null);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskQuestion, setTaskQuestion] = useState("");
  const [taskNotes, setTaskNotes] = useState("");
  const [taskDueDate, setTaskDueDate] = useState("");
  const [taskBlooms, setTaskBlooms] = useState<string[]>([]);
  const [taskSuccessCriteria, setTaskSuccessCriteria] = useState<string[]>([""]);
  const [taskKeyVocabulary, setTaskKeyVocabulary] = useState<string[]>([]);
  const [taskVocabInput, setTaskVocabInput] = useState("");
  const [taskExpanded, setTaskExpanded] = useState(false);
  const [taskStageInstructions, setTaskStageInstructions] = useState<Record<string, string>>({});
  const [taskEnabledStages, setTaskEnabledStages] = useState<string[]>(["MAP", "TORCH", "COMPASS", "EMBED", "RESEARCH"]);
  const [taskExpectedLength, setTaskExpectedLength] = useState("");
  const [taskResources, setTaskResources] = useState<string[]>([""]);
  const [savingTask, setSavingTask] = useState(false);

  useEffect(() => {
    if (!classId) return;
    Promise.all([
      apiFetch(`/teacher/classes/${classId}`),
      apiFetch(`/teacher/classes/${classId}/students`),
    ]).then(([classData, studentsData]) => {
      setCls(classData);
      setStudents(studentsData);
      setLoading(false);
    }).catch(() => { setLocation("/teacher/login"); setLoading(false); });

    apiFetch(`/teacher/classes/${classId}/torch-stats`)
      .then((torchData: any) => {
        const perStudent: Record<number, Record<string, number>> = {};
        const perStudentMsgs: Record<number, string[]> = {};
        for (const s of (torchData.byStudent ?? [])) {
          const userMsgs = s.messages.map((m: any) => m.content as string);
          perStudent[s.sessionId] = classifyMessages(
            s.messages.map((m: any) => ({ role: "user", content: m.content }))
          );
          perStudentMsgs[s.sessionId] = userMsgs;
        }
        setStudentQuestionTypes(perStudent);
        setStudentMessages(perStudentMsgs);
      })
      .catch(() => {});

    apiFetch(`/teacher/classes/${classId}/task`)
      .then((t: any) => {
        setTask(t);
        setTaskTitle(t.title ?? "");
        setTaskQuestion(t.question ?? "");
        setTaskNotes(t.notes ?? "");
        setTaskDueDate(t.dueDate ?? "");
        setTaskBlooms(t.bloomLevels ?? []);
        setTaskSuccessCriteria(t.successCriteria?.length ? t.successCriteria : [""]);
        setTaskKeyVocabulary(t.keyVocabulary ?? []);
        setTaskStageInstructions(t.stageInstructions ?? {});
        setTaskEnabledStages(t.enabledStages ?? ["MAP", "TORCH", "COMPASS", "EMBED", "RESEARCH"]);
        setTaskExpectedLength(t.expectedLength ?? "");
        setTaskResources(t.resources?.length ? t.resources : [""]);
      })
      .catch(() => {});
  }, [classId]);

  const handleSaveTask = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingTask(true);
    try {
      const saved = await apiFetch(`/teacher/classes/${classId}/task`, {
        method: "PUT",
        body: JSON.stringify({
          title: taskTitle,
          question: taskQuestion,
          notes: taskNotes || undefined,
          bloomLevels: taskBlooms,
          dueDate: taskDueDate || undefined,
          successCriteria: taskSuccessCriteria.filter(s => s.trim()),
          keyVocabulary: taskKeyVocabulary,
          enabledStages: taskEnabledStages,
          stageInstructions: taskStageInstructions,
          expectedLength: taskExpectedLength || undefined,
          resources: taskResources.filter(r => r.trim()),
        }),
      });
      setTask(saved);
      setShowTaskForm(false);
      toast({ title: "Task saved" });
    } catch (err: any) {
      toast({ title: "Error saving task", description: err.message, variant: "destructive" });
    } finally {
      setSavingTask(false);
    }
  };

  const toggleBloom = (level: string) => {
    setTaskBlooms((prev) =>
      prev.includes(level) ? prev.filter((l) => l !== level) : [...prev, level]
    );
  };

  const handleUnlockPin = async (sessionId: number, studentName: string) => {
    setUnlockingPin(sessionId);
    try {
      await apiFetch(`/teacher/classes/${classId}/students/${sessionId}/unlock-pin`, { method: "POST" });
      setStudents((prev) => prev.map((s) => s.id === sessionId ? { ...s, failedPinAttempts: 0, pinLockedUntil: null } : s));
      toast({ title: `${studentName}'s PIN unlocked` });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setUnlockingPin(null);
    }
  };

  const handleRemoveStudent = async (sessionId: number, studentName: string) => {
    if (!confirm(`Remove ${studentName} from this class? They will no longer be able to join.`)) return;
    setRemovingStudent(sessionId);
    try {
      await apiFetch(`/teacher/class/${classId}/student/${sessionId}`, { method: "DELETE" });
      setStudents((prev) => prev.filter((s) => s.id !== sessionId));
      toast({ title: `${studentName} removed` });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setRemovingStudent(null);
    }
  };

  if (loading) return null;
  if (!cls) return <div className="p-6">Class not found</div>;

  const getStageStatus = (student: any, stage: Stage): "none" | "started" | "finished" =>
    (student.stageStatuses?.[stage] ?? "none") as "none" | "started" | "finished";

  return (
    <div className="min-h-[100dvh] bg-neutral-50 text-neutral-900 font-sans">
      <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm">
            <Link href="/teacher/dashboard" className="text-neutral-500 hover:text-black">Dashboard</Link>
            <span className="text-neutral-300">/</span>
            <span className="font-medium">{cls.name}</span>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/teacher/class/${classId}/insights`}
              className="rounded-2xl bg-neutral-900 text-white px-5 py-2 text-sm font-medium hover:bg-neutral-700 transition-colors"
              data-testid="button-class-insights"
            >
              Class Insights
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-12 space-y-8">

        {/* Class header */}
        <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight mb-1">{cls.name}</h1>
            {cls.subject && <p className="text-neutral-500">{cls.subject}</p>}
          </div>
          <div className="bg-neutral-50 rounded-2xl p-6 border border-neutral-200 min-w-[200px] text-center">
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-2">Class Code</p>
            <p className="text-4xl font-mono font-bold tracking-widest mb-3">{cls.code}</p>
            <CopyButton code={cls.code} />
          </div>
        </div>

        {/* ── Task panel ── */}
        <div className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
          <div className="border-b border-neutral-200 px-8 py-6 flex items-center justify-between gap-4">
            <div>
              <h3 className="text-xl font-semibold tracking-tight">Class Task</h3>
              <p className="text-sm text-neutral-500 mt-1">
                {task ? "Students see this task on every page of their workspace." : "No task set yet. Set one so students know what they're working on."}
              </p>
            </div>
            <button
              onClick={() => setShowTaskForm(!showTaskForm)}
              className="shrink-0 rounded-2xl bg-black text-white px-5 py-3 text-sm font-medium hover:opacity-90 transition-opacity"
              data-testid="button-set-task"
            >
              {showTaskForm ? "Cancel" : task ? "Edit Task" : "Set Task"}
            </button>
          </div>

          {/* Existing task summary */}
          {task && !showTaskForm && (
            <div className="px-8 py-4">
              {/* Always-visible title row with expand toggle */}
              <button
                onClick={() => setTaskExpanded((v) => !v)}
                className="w-full flex items-center justify-between gap-4 text-left group py-2"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold uppercase tracking-widest text-neutral-400 mb-0.5">Task</p>
                  <p className="text-lg font-semibold leading-snug">{task.title}</p>
                  {!taskExpanded && task.question && (
                    <p className="text-sm text-neutral-500 truncate mt-0.5">{task.question}</p>
                  )}
                </div>
                <div className="shrink-0 flex items-center gap-3">
                  {task.dueDate && !taskExpanded && (
                    <span className="text-xs text-neutral-400 font-medium hidden sm:block">
                      Due {new Date(task.dueDate).toLocaleDateString()}
                    </span>
                  )}
                  <span className={`text-neutral-400 group-hover:text-neutral-700 transition-transform duration-200 ${taskExpanded ? "rotate-180" : ""}`}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </span>
                </div>
              </button>

              {/* Collapsible details */}
              {taskExpanded && (
                <div className="pt-4 pb-2 space-y-4 border-t border-neutral-100 mt-2">
                  {task.dueDate && (
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-bold uppercase tracking-widest text-neutral-400">Due date:</p>
                      <p className="text-sm font-semibold">{new Date(task.dueDate).toLocaleDateString()}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-xs font-bold uppercase tracking-widest text-neutral-400 mb-1">Question</p>
                    <p className="text-neutral-700">{task.question}</p>
                  </div>
                  {task.notes && (
                    <div>
                      <p className="text-xs font-bold uppercase tracking-widest text-neutral-400 mb-1">Guidance Notes</p>
                      <p className="text-sm text-neutral-600 whitespace-pre-wrap">{task.notes}</p>
                    </div>
                  )}
                  {task.bloomLevels?.length > 0 && (
                    <div>
                      <p className="text-xs font-bold uppercase tracking-widest text-neutral-400 mb-2">Focus Bloom's Levels</p>
                      <div className="flex flex-wrap gap-2">
                        {task.bloomLevels.map((l: string) => (
                          <span key={l} className="px-3 py-1 rounded-full text-xs font-semibold bg-neutral-900 text-white">{l}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {task.successCriteria?.filter(Boolean).length > 0 && (
                    <div>
                      <p className="text-xs font-bold uppercase tracking-widest text-neutral-400 mb-2">Success Criteria</p>
                      <ul className="space-y-1">
                        {task.successCriteria.filter(Boolean).map((c: string, i: number) => (
                          <li key={i} className="text-sm text-neutral-600 flex gap-2"><span className="text-neutral-400 shrink-0">–</span>{c}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {task.keyVocabulary?.filter(Boolean).length > 0 && (
                    <div>
                      <p className="text-xs font-bold uppercase tracking-widest text-neutral-400 mb-2">Key Vocabulary</p>
                      <div className="flex flex-wrap gap-2">
                        {task.keyVocabulary.filter(Boolean).map((w: string, i: number) => (
                          <span key={i} className="px-3 py-1 rounded-full text-xs font-semibold bg-sky-50 border border-sky-200 text-sky-700">{w}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Task form */}
          {showTaskForm && (
            <form onSubmit={handleSaveTask} className="px-8 py-6 space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium mb-2">Task Title <span className="text-red-500">*</span></label>
                  <input
                    required
                    type="text"
                    value={taskTitle}
                    onChange={(e) => setTaskTitle(e.target.value)}
                    className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                    placeholder="e.g. Causes of World War I"
                    data-testid="input-task-title"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">Due Date</label>
                  <input
                    type="date"
                    value={taskDueDate}
                    onChange={(e) => setTaskDueDate(e.target.value)}
                    className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                    data-testid="input-task-due-date"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Task Question <span className="text-red-500">*</span></label>
                <textarea
                  required
                  value={taskQuestion}
                  onChange={(e) => setTaskQuestion(e.target.value)}
                  className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm min-h-[100px] resize-none focus:outline-none focus:ring-2 focus:ring-black/10"
                  placeholder="e.g. To what extent was nationalism the main cause of World War I?"
                  data-testid="input-task-question"
                />
                <p className="text-xs text-neutral-400 mt-1">Students see this question on every page. The AI tutor will also use this to keep its Socratic questions relevant.</p>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Guidance Notes <span className="text-neutral-400 font-normal">(optional)</span></label>
                <textarea
                  value={taskNotes}
                  onChange={(e) => setTaskNotes(e.target.value)}
                  className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm min-h-[80px] resize-none focus:outline-none focus:ring-2 focus:ring-black/10"
                  placeholder="e.g. Focus on chapters 3–5. Consider the role of alliances, imperialism, and the assassination of Franz Ferdinand."
                  data-testid="input-task-notes"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-3">Focus Bloom's Levels <span className="text-neutral-400 font-normal">(optional — tick the levels you want students to aim for)</span></label>
                <div className="flex flex-wrap gap-2">
                  {ALL_BLOOM.map((level) => (
                    <button
                      type="button"
                      key={level}
                      onClick={() => toggleBloom(level)}
                      className={`px-4 py-2 rounded-2xl text-sm font-medium border transition-all ${
                        taskBlooms.includes(level)
                          ? "bg-neutral-900 text-white border-neutral-900"
                          : "bg-white text-neutral-600 border-neutral-300 hover:border-neutral-500"
                      }`}
                      data-testid={`button-bloom-${level}`}
                    >
                      {level}
                    </button>
                  ))}
                </div>
              </div>

              {/* Success Criteria */}
              <div>
                <label className="block text-sm font-medium mb-1">Success Criteria <span className="text-neutral-400 font-normal">(optional)</span></label>
                <p className="text-xs text-neutral-400 mb-3">What does a strong answer look like? Students can self-check against these at each stage.</p>
                <div className="space-y-2">
                  {taskSuccessCriteria.map((criterion, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <span className="text-neutral-400 text-sm shrink-0">•</span>
                      <input
                        type="text"
                        value={criterion}
                        onChange={(e) => {
                          const updated = [...taskSuccessCriteria];
                          updated[i] = e.target.value;
                          setTaskSuccessCriteria(updated);
                        }}
                        className="flex-1 rounded-xl border border-neutral-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                        placeholder={`e.g. ${i === 0 ? "Identifies at least three causes" : i === 1 ? "Uses evidence to support each point" : "Reaches a clear, justified conclusion"}`}
                      />
                      {taskSuccessCriteria.length > 1 && (
                        <button type="button" onClick={() => setTaskSuccessCriteria(taskSuccessCriteria.filter((_, j) => j !== i))} className="text-neutral-400 hover:text-red-500 text-lg leading-none shrink-0">×</button>
                      )}
                    </div>
                  ))}
                  <button type="button" onClick={() => setTaskSuccessCriteria([...taskSuccessCriteria, ""])} className="text-sm text-neutral-500 hover:text-black transition-colors mt-1">+ Add criterion</button>
                </div>
              </div>

              {/* Key Vocabulary */}
              <div>
                <label className="block text-sm font-medium mb-1">Key Vocabulary <span className="text-neutral-400 font-normal">(optional)</span></label>
                <p className="text-xs text-neutral-400 mb-3">Terms students are expected to use. The AI tutor will also nudge students toward these in TORCH.</p>
                <div className="flex flex-wrap gap-2 mb-2">
                  {taskKeyVocabulary.map((term, i) => (
                    <span key={i} className="flex items-center gap-1 px-3 py-1 rounded-full bg-neutral-100 text-sm">
                      {term}
                      <button type="button" onClick={() => setTaskKeyVocabulary(taskKeyVocabulary.filter((_, j) => j !== i))} className="text-neutral-400 hover:text-red-500 ml-1 leading-none">×</button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={taskVocabInput}
                    onChange={(e) => setTaskVocabInput(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.key === "Enter" || e.key === ",") && taskVocabInput.trim()) {
                        e.preventDefault();
                        setTaskKeyVocabulary([...taskKeyVocabulary, taskVocabInput.trim()]);
                        setTaskVocabInput("");
                      }
                    }}
                    className="flex-1 rounded-xl border border-neutral-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                    placeholder="Type a term and press Enter"
                  />
                  <button
                    type="button"
                    onClick={() => { if (taskVocabInput.trim()) { setTaskKeyVocabulary([...taskKeyVocabulary, taskVocabInput.trim()]); setTaskVocabInput(""); } }}
                    className="rounded-xl border border-neutral-200 px-3 py-2 text-sm hover:bg-neutral-50 transition-colors"
                  >Add</button>
                </div>
              </div>

              {/* Expected Length */}
              <div>
                <label className="block text-sm font-medium mb-1">Expected Length <span className="text-neutral-400 font-normal">(optional)</span></label>
                <p className="text-xs text-neutral-400 mb-2">Helps students know how much to write.</p>
                <input
                  type="text"
                  value={taskExpectedLength}
                  onChange={(e) => setTaskExpectedLength(e.target.value)}
                  className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                  placeholder="e.g. 3–4 paragraphs, around 400 words"
                />
              </div>

              {/* Active Stages */}
              <div>
                <label className="block text-sm font-medium mb-1">Active Stages</label>
                <p className="text-xs text-neutral-400 mb-3">Toggle off any stages you don't want students to use. Disabled stages will be crossed out and locked.</p>
                <div className="grid grid-cols-5 gap-2">
                  {(() => {
                    const STAGE_EMOJI: Record<string, string> = { MAP: "🗺️", TORCH: "🔥", COMPASS: "🧭", EMBED: "✍️", RESEARCH: "📚" };
                    const STAGE_NAME: Record<string, string> = { MAP: "Map", TORCH: "Torch", COMPASS: "Compass", EMBED: "Final Response", RESEARCH: "Research" };
                    return ALL_STAGES.map((stage) => {
                      const enabled = taskEnabledStages.includes(stage);
                      return (
                        <button
                          type="button"
                          key={stage}
                          onClick={() => setTaskEnabledStages(
                            enabled
                              ? taskEnabledStages.filter(s => s !== stage)
                              : [...taskEnabledStages, stage]
                          )}
                          className={`relative p-3 rounded-2xl border text-left transition-all ${
                            enabled ? STAGE_LIGHT[stage] : "bg-white border-neutral-200"
                          }`}
                        >
                          <div className="text-xl mb-1">{STAGE_EMOJI[stage]}</div>
                          <div className={`text-xs font-semibold leading-tight ${enabled ? "" : "line-through text-neutral-300"}`}>{STAGE_NAME[stage]}</div>
                          <div className={`text-[10px] mt-1.5 font-semibold uppercase tracking-widest ${enabled ? "opacity-60" : "text-neutral-400"}`}>
                            {enabled ? "On" : "Off"}
                          </div>
                          {enabled && (
                            <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-current opacity-50" />
                          )}
                        </button>
                      );
                    });
                  })()}
                </div>
              </div>

              {/* Stage-specific Instructions */}
              <div>
                <label className="block text-sm font-medium mb-1">Stage Instructions <span className="text-neutral-400 font-normal">(optional)</span></label>
                <p className="text-xs text-neutral-400 mb-3">Brief guidance shown to students at the start of each stage.</p>
                <div className="space-y-3">
                  {(["MAP", "TORCH", "COMPASS", "EMBED", "RESEARCH"] as const).map((stage) => (
                    <div key={stage} className="flex gap-3 items-start">
                      <span className={`shrink-0 mt-2 px-2 py-0.5 rounded text-xs font-semibold ${STAGE_LIGHT[stage]}`}>
                        {stage === "EMBED" ? "Final Response" : stage === "RESEARCH" ? "Research" : stage}
                      </span>
                      <textarea
                        value={taskStageInstructions[stage.toLowerCase()] ?? ""}
                        onChange={(e) => setTaskStageInstructions({ ...taskStageInstructions, [stage.toLowerCase()]: e.target.value })}
                        className="flex-1 rounded-xl border border-neutral-200 px-3 py-2 text-sm min-h-[60px] resize-none focus:outline-none focus:ring-2 focus:ring-black/10"
                        placeholder={
                          stage === "MAP" ? "e.g. Note everything you already know — don't look anything up yet." :
                          stage === "TORCH" ? "e.g. Ask the AI tutor questions. Try to understand the causes, not just list them." :
                          stage === "COMPASS" ? "e.g. Use your notes from MAP and TORCH to plan your answer with clear paragraphs." :
                          "e.g. Write your final response. Aim to use all the key vocabulary."
                        }
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Resources */}
              <div>
                <label className="block text-sm font-medium mb-1">Resources <span className="text-neutral-400 font-normal">(optional)</span></label>
                <p className="text-xs text-neutral-400 mb-3">Recommended reading or links for students.</p>
                <div className="space-y-2">
                  {taskResources.map((resource, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <input
                        type="text"
                        value={resource}
                        onChange={(e) => {
                          const updated = [...taskResources];
                          updated[i] = e.target.value;
                          setTaskResources(updated);
                        }}
                        className="flex-1 rounded-xl border border-neutral-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                        placeholder="e.g. Chapter 3 of your textbook / https://..."
                      />
                      {taskResources.length > 1 && (
                        <button type="button" onClick={() => setTaskResources(taskResources.filter((_, j) => j !== i))} className="text-neutral-400 hover:text-red-500 text-lg leading-none shrink-0">×</button>
                      )}
                    </div>
                  ))}
                  <button type="button" onClick={() => setTaskResources([...taskResources, ""])} className="text-sm text-neutral-500 hover:text-black transition-colors mt-1">+ Add resource</button>
                </div>
              </div>

              <div className="flex items-center justify-end gap-4 pt-2 border-t border-neutral-100">
                <button
                  type="button"
                  onClick={() => setShowTaskForm(false)}
                  className="rounded-2xl border border-neutral-300 px-5 py-3 text-sm font-medium hover:bg-neutral-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingTask}
                  className="rounded-2xl bg-black text-white px-6 py-3 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                  data-testid="button-save-task"
                >
                  {savingTask ? "Saving…" : "Save Task"}
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Student roster */}
        <div className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
          <div className="border-b border-neutral-200 px-8 py-6">
            <h3 className="text-xl font-semibold tracking-tight">Students</h3>
          </div>

          {students.length === 0 ? (
            <div className="p-12 text-center text-neutral-500">
              No students have joined yet. Share the class code with your class.
            </div>
          ) : (
            <div>
              <div className="grid items-center px-6 py-3 bg-neutral-50 border-b border-neutral-100 text-[10px] font-semibold uppercase tracking-wide text-neutral-400"
                style={{ gridTemplateColumns: "1fr repeat(5, 80px) 1fr 110px" }}>
                <span>Name</span>
                {ALL_STAGES.map((s) => (
                  <span key={s} className="text-center truncate px-1">
                    {s === "EMBED" ? "Final Resp." : s}
                  </span>
                ))}
                <span className="pl-2">Question Types</span>
                <span></span>
              </div>

              <div className="divide-y divide-neutral-100">
                {students.map((student) => {
                  const qtCounts = studentQuestionTypes[student.id] ?? {};
                  const qtTotal = Object.values(qtCounts).reduce((a: number, b: number) => a + b, 0);
                  const QT_BG: Record<string, string> = {
                    Factual: "bg-blue-400", Conceptual: "bg-sky-400", Analytical: "bg-amber-400",
                    Evaluative: "bg-orange-400", Creative: "bg-violet-400",
                    "Help/Clarify": "bg-neutral-300", Other: "bg-neutral-200",
                  };
                  return (
                    <div
                      key={student.id}
                      className="grid items-center px-6 py-4 hover:bg-neutral-50 transition-colors"
                      style={{ gridTemplateColumns: "1fr repeat(5, 80px) 1fr 110px" }}
                      data-testid={`row-student-${student.id}`}
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium">{student.studentName}</p>
                          {student.pinLockedUntil && new Date(student.pinLockedUntil) > new Date() && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-50 border border-red-200 text-red-600 text-xs font-medium">
                              PIN locked
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-neutral-400">Joined {new Date(student.createdAt).toLocaleDateString()}</p>
                      </div>
                      {ALL_STAGES.map((stage) => {
                        const status = getStageStatus(student, stage);
                        return (
                          <div key={stage} className="flex justify-center">
                            {status === "finished" ? (
                              <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold ${RAG_FINISHED}`}>✓</span>
                            ) : status === "started" ? (
                              <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold ${RAG_STARTED}`}>…</span>
                            ) : (
                              <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold ${RAG_NONE}`}>—</span>
                            )}
                          </div>
                        );
                      })}
                      <div className="pl-2">
                        {qtTotal > 0 ? (
                          <div className="space-y-1">
                            <div className="flex h-5 rounded-full overflow-hidden gap-px">
                              {QUESTION_TYPES.filter((t) => (qtCounts[t] ?? 0) > 0).map((type) => {
                                const pct = Math.round(((qtCounts[type] ?? 0) / qtTotal) * 100);
                                const isLight = type === "Help/Clarify" || type === "Other";
                                return (
                                  <div
                                    key={type}
                                    className={`flex items-center justify-center ${QT_BG[type]}`}
                                    style={{ width: `${pct}%` }}
                                    title={`${type}: ${qtCounts[type]} (${pct}%)`}
                                  >
                                    {pct >= 12 && (
                                      <span className={`text-[9px] font-bold leading-none select-none ${isLight ? "text-neutral-600" : "text-white"}`}>
                                        {pct}%
                                      </span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                            <TooltipProvider>
                            <div className="flex flex-wrap gap-1">
                              {QUESTION_TYPES.filter((t) => (qtCounts[t] ?? 0) > 0).map((type) => {
                                const msgs = (studentMessages[student.id] ?? []).filter((q) => classifyQuestion(q) === type);
                                return (
                                  <Tooltip key={type}>
                                    <TooltipTrigger asChild>
                                      <span
                                        className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold border cursor-default ${QUESTION_TYPE_META[type].color}`}
                                      >
                                        {type} {qtCounts[type]}
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-[300px] text-left p-3 bg-white text-neutral-900 border border-neutral-200 shadow-lg">
                                      <p className="font-semibold text-neutral-800 mb-2">{QUESTION_TYPE_META[type].description}</p>
                                      <ul className="space-y-1 max-h-48 overflow-y-auto pr-1">
                                        {msgs.map((q, i) => (
                                          <li key={i} className="text-[11px] text-neutral-500">"{q}"</li>
                                        ))}
                                      </ul>
                                    </TooltipContent>
                                  </Tooltip>
                                );
                              })}
                            </div>
                            </TooltipProvider>
                          </div>
                        ) : (
                          <span className="text-xs text-neutral-300 italic">No AI chat yet</span>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-1.5">
                        <Link
                          href={`/teacher/class/${classId}/student/${student.id}`}
                          className="rounded-2xl border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 transition-colors"
                          data-testid={`button-view-student-${student.id}`}
                        >
                          View Work
                        </Link>
                        {student.pinLockedUntil && new Date(student.pinLockedUntil) > new Date() && (
                          <button
                            onClick={() => handleUnlockPin(student.id, student.studentName)}
                            disabled={unlockingPin === student.id}
                            className="rounded-xl border border-amber-200 text-amber-700 px-3 py-1 text-xs hover:bg-amber-50 transition-colors disabled:opacity-50"
                          >
                            {unlockingPin === student.id ? "Unlocking…" : "Unlock PIN"}
                          </button>
                        )}
                        <button
                          onClick={() => handleRemoveStudent(student.id, student.studentName)}
                          disabled={removingStudent === student.id}
                          className="text-xs text-red-400 hover:text-red-600 transition-colors disabled:opacity-50"
                        >
                          {removingStudent === student.id ? "Removing…" : "Remove"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
