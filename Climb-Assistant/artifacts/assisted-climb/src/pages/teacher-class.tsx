import { useState, useEffect, useRef, useMemo, type ReactNode } from "react";
import { Link, useRoute, useLocation } from "wouter";
import { apiFetch, apiFetchBlob } from "@/lib/api";
import { registerBeforeLogout } from "@/lib/session-lifecycle";
import { useToast } from "@/hooks/use-toast";
import { classifyMessages, classifyQuestion, QUESTION_TYPE_META, QUESTION_TYPES } from "@/lib/question-classifier";
import { mergeVocabularyTerms, splitVocabularyPaste } from "@/lib/vocabulary";
import { RESOURCE_TYPES, formatResource, hasResourceLabel, parseResource, type ResourceType } from "@/lib/resources";
import { FRAMEWORK_DESCRIPTIONS } from "@/lib/frameworks";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useQueryClient } from "@tanstack/react-query";
import { useListClassStudents, getListClassStudentsQueryKey, useBulkReviewStudentRegistrations, StudentSummary, getGetTeacherDashboardOverviewQueryKey } from "@workspace/api-client-react";

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

const ALL_STAGES = ["MAP", "TORCH", "RESEARCH", "COMPASS", "EMBED"] as const;
type Stage = (typeof ALL_STAGES)[number];

const STAGE_LABEL: Record<Stage, string> = {
  MAP: "MAP",
  TORCH: "TORCH",
  RESEARCH: "Research",
  COMPASS: "Compass",
  EMBED: "Final Answer",
};

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

const STAGE_PROGRESS_CARD: Record<Stage, string> = {
  MAP: "border-neutral-200 bg-neutral-50 text-neutral-800",
  TORCH: "border-amber-200 bg-amber-50 text-amber-800",
  RESEARCH: "border-sky-200 bg-sky-50 text-sky-800",
  COMPASS: "border-emerald-200 bg-emerald-50 text-emerald-800",
  EMBED: "border-violet-200 bg-violet-50 text-violet-800",
};

const STAGE_STATUS_META = {
  finished: {
    label: "Complete",
    symbol: "✓",
    className: "border-emerald-200 bg-emerald-50 text-emerald-800",
    symbolClassName: "bg-emerald-500 text-white",
  },
  started: {
    label: "In progress",
    symbol: "…",
    className: "border-amber-200 bg-amber-50 text-amber-800",
    symbolClassName: "bg-amber-400 text-white",
  },
  none: {
    label: "Not started",
    symbol: "—",
    className: "border-neutral-200 bg-neutral-50 text-neutral-500",
    symbolClassName: "bg-neutral-200 text-neutral-600",
  },
} as const;

const ALL_BLOOM = ["Remember", "Understand", "Apply", "Analyse", "Evaluate", "Create"];
const ALL_KNOWLEDGE_DIMENSIONS = [
  "Factual Knowledge",
  "Conceptual Knowledge",
  "Procedural Knowledge",
];
const YEAR_GROUPS = {
  KS4: ["Year 9", "Year 10", "Year 11"],
  KS5: ["Year 12", "Year 13"],
} as const;
const EXAM_BOARDS = ["AQA", "Pearson Edexcel", "OCR", "WJEC/Eduqas", "CCEA"] as const;
const CUSTOM_EXAM_BOARD = "__custom__";
type LearningFramework = "bloom" | "knowledge_dimensions";

type TaskDraft = {
  title: string;
  subject: string;
  examBoard: string;
  question: string;
  notes: string;
  dueDate: string;
  formativeAssessmentDate: string;
  learningFramework: LearningFramework;
  yearGroup: string;
  bloomLevels: string[];
  knowledgeDimensions: string[];
  successCriteria: string[];
  keyVocabulary: string[];
  enabledStages: string[];
  stageInstructions: Record<string, string>;
  expectedLength: string;
  resources: string[];
};

function taskPayload(draft: TaskDraft) {
  return {
    title: draft.title,
    subject: draft.subject.trim() || undefined,
    examBoard: draft.examBoard.trim() || undefined,
    question: draft.question,
    notes: draft.notes || undefined,
    learningFramework: draft.learningFramework,
    yearGroup: draft.yearGroup || undefined,
    bloomLevels: draft.bloomLevels,
    knowledgeDimensions: draft.knowledgeDimensions,
    dueDate: draft.dueDate || undefined,
    formativeAssessmentDate: draft.formativeAssessmentDate || undefined,
    successCriteria: draft.successCriteria.filter((item) => item.trim()),
    keyVocabulary: draft.keyVocabulary,
    enabledStages: draft.enabledStages,
    stageInstructions: draft.stageInstructions,
    expectedLength: draft.expectedLength || undefined,
    resources: draft.resources.filter(hasResourceLabel),
  };
}

export default function TeacherClass() {
  const [, params] = useRoute("/teacher/class/:classId");
  const classId = params?.classId ? parseInt(params.classId) : 0;
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const [cls, setCls] = useState<any>(null);
  const [editingClassDetails, setEditingClassDetails] = useState(false);
  const [classNameDraft, setClassNameDraft] = useState("");
  const [classSubjectDraft, setClassSubjectDraft] = useState("");
  const [savingClassDetails, setSavingClassDetails] = useState(false);
  const [classDetailsError, setClassDetailsError] = useState("");
  const { data: students = [], isLoading: studentsLoading } = useListClassStudents(classId, { query: { enabled: !!classId, queryKey: getListClassStudentsQueryKey(classId) } });

  const [loading, setLoading] = useState(true);
  const [archivingStudent, setArchivingStudent] = useState<number | null>(null);
  const [deletingStudent, setDeletingStudent] = useState<number | null>(null);
  const [reviewingRegistration, setReviewingRegistration] = useState<number | null>(null);
  const [unlockingPin, setUnlockingPin] = useState<number | null>(null);
  const [updatingWorkLock, setUpdatingWorkLock] = useState<number | null>(null);
  const [regeneratingCode, setRegeneratingCode] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deletingClass, setDeletingClass] = useState(false);
  const [developmentAnalysisOpen, setDevelopmentAnalysisOpen] = useState(false);
  const [developmentAnalysisLoading, setDevelopmentAnalysisLoading] = useState(false);
  const [developmentAnalysis, setDevelopmentAnalysis] = useState<any>(null);
  const [journeyGenerating, setJourneyGenerating] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedSessionIds, setSelectedSessionIds] = useState<number[]>([]);
  const bulkReview = useBulkReviewStudentRegistrations();

  const [studentQuestionTypes, setStudentQuestionTypes] = useState<Record<number, Record<string, number>>>({});
  const [studentMessages, setStudentMessages] = useState<Record<number, string[]>>({});
  const [messageStudent, setMessageStudent] = useState<{ id: number; name: string } | null>(null);
  const [messageConversation, setMessageConversation] = useState<any[]>([]);
  const [messageLoading, setMessageLoading] = useState(false);
  const [messageDraft, setMessageDraft] = useState("");
  const [messageSending, setMessageSending] = useState(false);
  const [messageError, setMessageError] = useState("");

  const [task, setTask] = useState<any>(null);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskSubject, setTaskSubject] = useState("");
  const [taskExamBoard, setTaskExamBoard] = useState("");
  const [taskUsesCustomExamBoard, setTaskUsesCustomExamBoard] = useState(false);
  const [taskQuestion, setTaskQuestion] = useState("");
  const [taskNotes, setTaskNotes] = useState("");
  const [taskDueDate, setTaskDueDate] = useState("");
  const [taskLearningFramework, setTaskLearningFramework] = useState<LearningFramework>("bloom");
  const [taskYearGroup, setTaskYearGroup] = useState("");
  const [taskBlooms, setTaskBlooms] = useState<string[]>([]);
  const [taskKnowledgeDimensions, setTaskKnowledgeDimensions] = useState<string[]>([]);
  const [taskSuccessCriteria, setTaskSuccessCriteria] = useState<string[]>([""]);
  const [taskKeyVocabulary, setTaskKeyVocabulary] = useState<string[]>([]);
  const [taskVocabInput, setTaskVocabInput] = useState("");
  const [taskExpanded, setTaskExpanded] = useState(false);
  const [taskStageInstructions, setTaskStageInstructions] = useState<Record<string, string>>({});
  const [taskEnabledStages, setTaskEnabledStages] = useState<string[]>(["MAP", "TORCH", "COMPASS", "EMBED", "RESEARCH"]);
  const [taskExpectedLength, setTaskExpectedLength] = useState("");
  const [taskResources, setTaskResources] = useState<string[]>([""]);
  const [taskFormativeAssessmentDate, setTaskFormativeAssessmentDate] = useState("");
  const [savingTask, setSavingTask] = useState(false);
  const [generatingTask, setGeneratingTask] = useState(false);
  const [taskSuggestion, setTaskSuggestion] = useState<any>(null);
  const [taskSuggestionError, setTaskSuggestionError] = useState("");
  const [appliedSuggestionFields, setAppliedSuggestionFields] = useState<Record<string, boolean>>({});
  const [suggestionAnnouncement, setSuggestionAnnouncement] = useState("");
  const [reopeningTask, setReopeningTask] = useState(false);
  const [closingTask, setClosingTask] = useState(false);
  const [taskAutoSaveStatus, setTaskAutoSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const taskDraftRef = useRef<TaskDraft>({
    title: "",
    subject: "",
    examBoard: "",
    question: "",
    notes: "",
    dueDate: "",
    formativeAssessmentDate: "",
    learningFramework: "bloom",
    yearGroup: "",
    bloomLevels: [],
    knowledgeDimensions: [],
    successCriteria: [""],
    keyVocabulary: [],
    enabledStages: ["MAP", "TORCH", "COMPASS", "EMBED", "RESEARCH"],
    stageInstructions: {},
    expectedLength: "",
    resources: [""],
  });
  const taskFormOpenRef = useRef(false);
  const savedTaskSignatureRef = useRef<string | null>(null);
  const taskSaveInFlightRef = useRef<{ signature: string; promise: Promise<any> } | null>(null);

  useEffect(() => {
    taskDraftRef.current = {
      title: taskTitle,
      subject: taskSubject,
      examBoard: taskExamBoard,
      question: taskQuestion,
      notes: taskNotes,
      dueDate: taskDueDate,
      formativeAssessmentDate: taskFormativeAssessmentDate,
      learningFramework: taskLearningFramework,
      yearGroup: taskYearGroup,
      bloomLevels: taskBlooms,
      knowledgeDimensions: taskKnowledgeDimensions,
      successCriteria: taskSuccessCriteria,
      keyVocabulary: taskKeyVocabulary,
      enabledStages: taskEnabledStages,
      stageInstructions: taskStageInstructions,
      expectedLength: taskExpectedLength,
      resources: taskResources,
    };
  }, [
    taskBlooms,
    taskExamBoard,
    taskLearningFramework,
    taskYearGroup,
    taskKnowledgeDimensions,
    taskDueDate,
    taskFormativeAssessmentDate,
    taskEnabledStages,
    taskExpectedLength,
    taskKeyVocabulary,
    taskNotes,
    taskQuestion,
    taskResources,
    taskStageInstructions,
    taskSuccessCriteria,
    taskSubject,
    taskTitle,
  ]);

  useEffect(() => {
    taskFormOpenRef.current = showTaskForm;
  }, [showTaskForm]);

  const saveTaskDraft = async () => {
    if (!classId) return null;
    const payload = taskPayload(taskDraftRef.current);
    const signature = JSON.stringify(payload);
    if (signature === savedTaskSignatureRef.current) return task;
    if (taskSaveInFlightRef.current?.signature === signature) {
      return taskSaveInFlightRef.current.promise;
    }

    const priorSave = taskSaveInFlightRef.current?.promise;
    setTaskAutoSaveStatus("saving");
    const promise = Promise.resolve(priorSave)
      .catch(() => undefined)
      .then(() => apiFetch(`/teacher/classes/${classId}/task`, {
        method: "PUT",
        body: JSON.stringify(payload),
      }))
      .then((saved) => {
        savedTaskSignatureRef.current = signature;
        setTask(saved);
        setTaskAutoSaveStatus("saved");
        void queryClient.invalidateQueries({ queryKey: getGetTeacherDashboardOverviewQueryKey() });
        return saved;
      })
      .catch((error) => {
        setTaskAutoSaveStatus("error");
        throw error;
      })
      .finally(() => {
        if (taskSaveInFlightRef.current?.signature === signature) {
          taskSaveInFlightRef.current = null;
        }
      });
    taskSaveInFlightRef.current = { signature, promise };
    return promise;
  };

  useEffect(() => {
    if (!showTaskForm || !classId || !taskTitle.trim() || !taskQuestion.trim()) return;
    const timer = window.setTimeout(() => {
      void saveTaskDraft().catch(() => {});
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [
    classId,
    showTaskForm,
    taskBlooms,
    taskDueDate,
    taskFormativeAssessmentDate,
    taskEnabledStages,
    taskExamBoard,
    taskExpectedLength,
    taskKeyVocabulary,
    taskKnowledgeDimensions,
    taskLearningFramework,
    taskNotes,
    taskQuestion,
    taskResources,
    taskStageInstructions,
    taskSuccessCriteria,
    taskSubject,
    taskTitle,
    taskYearGroup,
  ]);

  useEffect(() => {
    if (!classId) return;
    apiFetch(`/teacher/classes/${classId}`)
      .then((classData) => {
        setCls(classData);
        setLoading(false);
      })
      .catch(() => { setLocation("/teacher/login"); setLoading(false); });

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
        const loadedDraft: TaskDraft = {
          title: t.title ?? "",
          subject: t.subject ?? cls?.subject ?? "",
          examBoard: t.examBoard ?? "",
          question: t.question ?? "",
          notes: t.notes ?? "",
          dueDate: t.dueDate ?? "",
          formativeAssessmentDate: t.formativeAssessmentDate ?? "",
          learningFramework: t.learningFramework ?? ((t.knowledgeDimensions?.length ?? 0) > 0 && (t.bloomLevels?.length ?? 0) === 0 ? "knowledge_dimensions" : "bloom"),
          yearGroup: t.yearGroup ?? "",
          bloomLevels: t.bloomLevels ?? [],
          knowledgeDimensions: (t.knowledgeDimensions ?? []).filter((item: string) => ALL_KNOWLEDGE_DIMENSIONS.includes(item)),
          successCriteria: t.successCriteria?.length ? t.successCriteria : [""],
          keyVocabulary: t.keyVocabulary ?? [],
          enabledStages: t.enabledStages ?? ["MAP", "TORCH", "COMPASS", "EMBED", "RESEARCH"],
          stageInstructions: t.stageInstructions ?? {},
          expectedLength: t.expectedLength ?? "",
          resources: t.resources?.length ? t.resources : [""],
        };
        savedTaskSignatureRef.current = JSON.stringify(taskPayload(loadedDraft));
        setTask(t);
        setTaskAutoSaveStatus("saved");
        setTaskTitle(loadedDraft.title);
        setTaskSubject(loadedDraft.subject);
        setTaskExamBoard(loadedDraft.examBoard);
        setTaskUsesCustomExamBoard(Boolean(loadedDraft.examBoard && !EXAM_BOARDS.includes(loadedDraft.examBoard as typeof EXAM_BOARDS[number])));
        setTaskQuestion(loadedDraft.question);
        setTaskNotes(loadedDraft.notes);
        setTaskDueDate(loadedDraft.dueDate);
        setTaskFormativeAssessmentDate(loadedDraft.formativeAssessmentDate);
        setTaskLearningFramework(loadedDraft.learningFramework);
        setTaskYearGroup(loadedDraft.yearGroup);
        setTaskBlooms(loadedDraft.bloomLevels);
        setTaskKnowledgeDimensions(loadedDraft.knowledgeDimensions);
        setTaskSuccessCriteria(loadedDraft.successCriteria);
        setTaskKeyVocabulary(loadedDraft.keyVocabulary);
        setTaskStageInstructions(loadedDraft.stageInstructions);
        setTaskEnabledStages(loadedDraft.enabledStages);
        setTaskExpectedLength(loadedDraft.expectedLength);
        setTaskResources(loadedDraft.resources);
      })
      .catch(() => {});
  }, [classId, cls?.subject]);

  useEffect(() => {
    if (!classId) return;
    return registerBeforeLogout(async () => {
      const draft = taskDraftRef.current;
      if (!taskFormOpenRef.current || !draft.title.trim() || !draft.question.trim()) return;
      await saveTaskDraft().catch(() => {});
    });
  }, [classId]);

  const handleSaveTask = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingTask(true);
    try {
      await saveTaskDraft();
      setShowTaskForm(false);
      toast({ title: "Task saved" });
    } catch (err: any) {
      toast({ title: "Error saving task", description: err.message, variant: "destructive" });
    } finally {
      setSavingTask(false);
    }
  };

  const toggleDevelopmentAnalysis = async () => {
    const opening = !developmentAnalysisOpen;
    setDevelopmentAnalysisOpen(opening);
    if (!opening || developmentAnalysis || developmentAnalysisLoading || !classId) return;
    setDevelopmentAnalysisLoading(true);
    try {
      setDevelopmentAnalysis(await apiFetch(`/teacher/classes/${classId}/class-journey-analysis`));
    } catch {
      setDevelopmentAnalysis({ error: "Class Journey Analysis could not be loaded." });
    } finally {
      setDevelopmentAnalysisLoading(false);
    }
  };

  const generateClassJourneyAnalysis = async () => {
    if (!classId || journeyGenerating) return;
    const hasExisting = Boolean(developmentAnalysis?.report);
    if (hasExisting && !window.confirm("Regenerate Class Journey Analysis? This will make one new AI request and replace the saved report.")) return;
    setJourneyGenerating(true);
    try {
      const result = await apiFetch(`/teacher/classes/${classId}/class-journey-analysis/generate`, {
        method: "POST",
        body: JSON.stringify({ regenerate: hasExisting }),
      });
      setDevelopmentAnalysis((current: any) => ({ ...current, ...result, report: result.report, status: result.status }));
      toast({ title: hasExisting ? "Class Journey Analysis regenerated" : "Class Journey Analysis saved" });
    } catch (error: any) {
      toast({ title: "Class Journey Analysis could not be generated", description: error.message, variant: "destructive" });
    } finally {
      setJourneyGenerating(false);
    }
  };

  const downloadClassJourneyFile = async (extension: "pdf" | "csv") => {
    if (!classId) return;
    try {
      const blob = await apiFetchBlob(`/teacher/classes/${classId}/class-journey-analysis/report.${extension}`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${(cls?.name ?? "class").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-class-journey-analysis.${extension}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error: any) {
      toast({ title: "Download unavailable", description: error.message, variant: "destructive" });
    }
  };

  const toggleTaskForm = () => {
    if (!showTaskForm && !task && !taskSubject.trim()) {
      setTaskSubject(cls?.subject ?? "");
    }
    setShowTaskForm((current) => !current);
  };

  const startEditingClassDetails = () => {
    setClassNameDraft(cls?.name ?? "");
    setClassSubjectDraft(cls?.subject ?? "");
    setClassDetailsError("");
    setEditingClassDetails(true);
  };

  const handleSaveClassDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = classNameDraft.trim();
    if (!name) {
      setClassDetailsError("Enter a class name.");
      return;
    }
    setSavingClassDetails(true);
    setClassDetailsError("");
    try {
      const updated = await apiFetch(`/teacher/classes/${classId}`, {
        method: "PUT",
        body: JSON.stringify({
          name,
          subject: classSubjectDraft.trim(),
        }),
      });
      setCls(updated);
      setEditingClassDetails(false);
      queryClient.invalidateQueries({ queryKey: getGetTeacherDashboardOverviewQueryKey() });
      toast({ title: "Class details updated" });
    } catch (err: any) {
      setClassDetailsError(err.message || "Could not update the class details.");
    } finally {
      setSavingClassDetails(false);
    }
  };

  const handleReopenTask = async () => {
    if (!classId || reopeningTask) return;
    setReopeningTask(true);
    try {
      const reopened = await apiFetch(`/teacher/classes/${classId}/task/reopen`, { method: "POST" });
      setTask(reopened);
      toast({ title: "Task reopened", description: "Students can edit their existing work again." });
    } catch (err: any) {
      toast({ title: "Could not reopen task", description: err.message, variant: "destructive" });
    } finally {
      setReopeningTask(false);
    }
  };

  const handleCloseTask = async () => {
    if (!classId || closingTask) return;
    if (!confirm("Close late editing now?\n\nStudents will still be able to view all of their work, but editing and AI tools will stop immediately. The due date will not change.")) return;
    setClosingTask(true);
    try {
      const closed = await apiFetch(`/teacher/classes/${classId}/task/close`, { method: "POST" });
      setTask(closed);
      toast({ title: "Late editing closed", description: "Student work is now read-only. The due date has not changed." });
    } catch (err: any) {
      toast({ title: "Could not close late editing", description: err.message, variant: "destructive" });
    } finally {
      setClosingTask(false);
    }
  };

  const toggleBloom = (level: string) => {
    setTaskBlooms((prev) =>
      prev.includes(level) ? prev.filter((l) => l !== level) : [...prev, level]
    );
  };

  const toggleKnowledgeDimension = (dimension: string) => {
    setTaskKnowledgeDimensions((prev) =>
      prev.includes(dimension)
        ? prev.filter((item) => item !== dimension)
        : [...prev, dimension],
    );
  };

  const selectLearningFramework = (framework: LearningFramework) => {
    setTaskLearningFramework(framework);
    setTaskSuggestion(null);
    setTaskSuggestionError("");
    if (framework === "bloom") setTaskKnowledgeDimensions([]);
    else setTaskBlooms([]);
  };

  const generateRemainingTask = async () => {
    const selected = taskLearningFramework === "bloom" ? taskBlooms : taskKnowledgeDimensions;
    if (!taskTitle.trim() || !taskSubject.trim() || !taskYearGroup || selected.length === 0) {
      setTaskSuggestionError("Enter a task title and subject, choose one framework and select at least one option, then choose a year group.");
      return;
    }
    setGeneratingTask(true);
    setTaskSuggestionError("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 45_000);
    try {
      const suggestion = await apiFetch(`/teacher/classes/${classId}/task/generate`, {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          title: taskTitle.trim(),
          subject: taskSubject.trim(),
          examBoard: taskExamBoard || undefined,
          question: taskQuestion.trim() || undefined,
          learningFramework: taskLearningFramework,
          yearGroup: taskYearGroup,
          bloomLevels: taskLearningFramework === "bloom" ? taskBlooms : [],
          knowledgeDimensions: taskLearningFramework === "knowledge_dimensions" ? taskKnowledgeDimensions : [],
        }),
      });
      setTaskSuggestion(suggestion);
      setAppliedSuggestionFields({});
      setSuggestionAnnouncement("AI suggestions are ready to review.");
    } catch (err: unknown) {
      const status = err && typeof err === "object" && "status" in err
        ? Number((err as { status?: unknown }).status)
        : undefined;
      const message = err instanceof Error ? err.message : "";
      const isGatewayFailure = status === 502 || status === 503 || status === 504;
      const isTimeout = controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError");
      setTaskSuggestionError(
        isGatewayFailure || isTimeout || message === "An error occurred"
          ? "The AI service is temporarily busy. Please wait a moment and try again."
          : message || "The AI service is temporarily unavailable. Please try again.",
      );
    } finally {
      window.clearTimeout(timeout);
      setGeneratingTask(false);
    }
  };

  const applySuggestionField = (field: string) => {
    if (!taskSuggestion) return;
    if (field === "question") setTaskQuestion(taskSuggestion.question ?? "");
    if (field === "notes") setTaskNotes(taskSuggestion.notes ?? "");
    if (field === "successCriteria") setTaskSuccessCriteria(taskSuggestion.successCriteria?.length ? taskSuggestion.successCriteria : [""]);
    if (field === "keyVocabulary") setTaskKeyVocabulary(taskSuggestion.keyVocabulary ?? []);
    if (field === "expectedLength") setTaskExpectedLength(taskSuggestion.expectedLength ?? "");
    if (field === "stageInstructions") setTaskStageInstructions(taskSuggestion.stageInstructions ?? {});
    setAppliedSuggestionFields((current) => ({ ...current, [field]: true }));
    setSuggestionAnnouncement(`${field === "stageInstructions" ? "Stage instructions" : field} applied to the task.`);
  };

  const addSuggestedResources = (items: Array<{ suggestion: any; index: number }>) => {
    const updated = [...taskResources];
    const addedIndices: number[] = [];
    let skippedCount = 0;

    for (const { suggestion, index } of items) {
      if (!suggestion || appliedSuggestionFields[`resource-${index}`]) continue;
      const provenance = suggestion.url
        ? `${suggestion.label} — ${suggestion.url} (retrieved ${new Date(suggestion.retrievedAt).toLocaleDateString("en-GB")}; teacher-reviewed, not specification-verified)`
        : suggestion.label;
      const formatted = formatResource(suggestion.type as ResourceType, provenance);
      const firstEmpty = updated.findIndex((resource) => !hasResourceLabel(resource));
      if (firstEmpty >= 0) {
        updated[firstEmpty] = formatted;
        addedIndices.push(index);
      } else if (updated.length < 5) {
        updated.push(formatted);
        addedIndices.push(index);
      } else {
        skippedCount += 1;
      }
    }

    if (addedIndices.length > 0) {
      setTaskResources(updated);
      setAppliedSuggestionFields((current) => ({
        ...current,
        ...Object.fromEntries(addedIndices.map((index) => [`resource-${index}`, true])),
      }));
    }
    return { addedCount: addedIndices.length, skippedCount };
  };

  const addSuggestedResource = (index: number) => {
    const suggestion = taskSuggestion?.resourceSuggestions?.[index];
    if (!suggestion) return;
    const { addedCount } = addSuggestedResources([{ suggestion, index }]);
    if (addedCount === 0) {
      toast({ title: "Maximum of 5 resources", description: "Remove a resource before adding this suggestion.", variant: "destructive" });
      return;
    }
    setSuggestionAnnouncement(`Resource suggestion ${index + 1} added to the task.`);
  };

  const updateResourceSuggestion = (index: number, field: "type" | "label", value: string) => {
    setTaskSuggestion((current: any) => {
      if (!current) return current;
      const resourceSuggestions = [...(current.resourceSuggestions ?? [])];
      resourceSuggestions[index] = { ...resourceSuggestions[index], [field]: value };
      return { ...current, resourceSuggestions };
    });
    setAppliedSuggestionFields((current) => ({ ...current, [`resource-${index}`]: false }));
  };

  const updateSuggestion = (field: string, value: string) => {
    setTaskSuggestion((current: any) => current ? { ...current, [field]: value } : current);
    setAppliedSuggestionFields((current) => ({ ...current, [field]: false }));
  };

  const updateSuggestionList = (field: "successCriteria" | "keyVocabulary", value: string) => {
    const items = field === "keyVocabulary"
      ? value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)
      : value.split("\n").map((item) => item.trim()).filter(Boolean);
    setTaskSuggestion((current: any) => current ? { ...current, [field]: items } : current);
    setAppliedSuggestionFields((current) => ({ ...current, [field]: false }));
  };

  const updateSuggestionStages = (value: string) => {
    const stageInstructions = Object.fromEntries(
      value.split("\n")
        .map((line) => {
          const separator = line.indexOf(":");
          return separator === -1 ? null : [line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()];
        })
        .filter((entry): entry is [string, string] => Boolean(entry?.[0] && entry[1])),
    );
    setTaskSuggestion((current: any) => current ? { ...current, stageInstructions } : current);
    setAppliedSuggestionFields((current) => ({ ...current, stageInstructions: false }));
  };

  const applyAllSuggestions = () => {
    const resourceSuggestions = taskSuggestion?.resourceSuggestions ?? [];
    ["question", "notes", "successCriteria", "keyVocabulary", "expectedLength", "stageInstructions"].forEach(applySuggestionField);
    const { addedCount, skippedCount } = addSuggestedResources(
      resourceSuggestions.map((suggestion: any, index: number) => ({ suggestion, index })),
    );
    setSuggestionAnnouncement(
      skippedCount > 0
        ? `Task and ${addedCount} resource${addedCount === 1 ? "" : "s"} applied. ${skippedCount} source${skippedCount === 1 ? "" : "s"} could not fit within the five-resource limit.`
        : resourceSuggestions.length > 0
          ? `Task and ${addedCount} resource${addedCount === 1 ? "" : "s"} applied.`
          : "All AI task suggestions applied to the task.",
    );
    if (resourceSuggestions.length > 0) {
      toast({
        title: "Task and resources applied",
        description: skippedCount > 0
          ? `${addedCount} source${addedCount === 1 ? "" : "s"} added. Remove a resource to add the remaining source${skippedCount === 1 ? "" : "s"}.`
          : "Review or edit the task and check each source before sharing it with students.",
      });
    } else {
      toast({ title: "Suggestions applied", description: "Review or edit the task, then save it when you are ready." });
    }
    if (skippedCount === 0) {
      setTaskSuggestion(null);
    }
  };

  const handleUnlockPin = async (sessionId: number, studentName: string) => {
    setUnlockingPin(sessionId);
    try {
      await apiFetch(`/teacher/classes/${classId}/students/${sessionId}/unlock-pin`, { method: "POST" });
      queryClient.setQueryData(getListClassStudentsQueryKey(classId), (old: any) =>
        old?.map((s: any) => s.id === sessionId ? { ...s, failedPinAttempts: 0, pinLockedUntil: null } : s)
      );
      toast({ title: `${studentName}'s PIN unlocked` });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setUnlockingPin(null);
    }
  };

  const handleWorkLock = async (student: any) => {
    const isLocked = Boolean(student.lockedAt);
    if (isLocked && student.isFinalised) return;
    const verb = isLocked ? "Unlock" : "Lock";
    if (!confirm(`${verb} ${student.studentName}'s work?\n\n${isLocked ? "They will be able to edit and use AI tools again." : "They will still be able to view their work, but editing and AI tools will stop until you unlock it."}`)) return;
    setUpdatingWorkLock(student.id);
    try {
      const result = await apiFetch(`/teacher/classes/${classId}/students/${student.id}/${isLocked ? "unlock-assessment" : "lock-assessment"}`, { method: "POST" });
      queryClient.setQueryData(getListClassStudentsQueryKey(classId), (old: any) =>
        old?.map((item: any) => item.id === student.id
          ? { ...item, lockedAt: isLocked ? null : result?.lockedAt ?? new Date().toISOString() }
          : item)
      );
      toast({
        title: `${student.studentName}'s work ${isLocked ? "unlocked" : "locked"}`,
        description: isLocked ? "They can edit and use AI tools again." : "They can view their work but cannot edit it.",
      });
    } catch (err: any) {
      toast({ title: `Could not ${isLocked ? "unlock" : "lock"} work`, description: err.message, variant: "destructive" });
    } finally {
      setUpdatingWorkLock(null);
    }
  };

  const handleArchiveStudent = async (sessionId: number, studentName: string) => {
    if (!confirm(`Archive ${studentName}'s completed work?\n\nArchive keeps this work read-only. It does not start automatic deletion. Editing, submissions, and AI tools stop immediately; any later permanent removal is a separate School Admin decision.`)) return;
    setArchivingStudent(sessionId);
    try {
      const result = await apiFetch(`/teacher/classes/${classId}/students/${sessionId}/archive`, { method: "POST" });
      queryClient.setQueryData(getListClassStudentsQueryKey(classId), (old: any) =>
        old?.map((s: any) => s.id === sessionId ? { ...s, archivedAt: result.archivedAt, retentionUntil: result.retentionUntil } : s)
      );
      toast({
        title: `${studentName}'s work was archived`,
        description: "It remains read-only. Archive is different from the teacher's 30-day Delete action.",
      });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setArchivingStudent(null);
    }
  };

  const handleDeleteStudent = async (sessionId: number, studentName: string) => {
    const confirmation = window.prompt(
      `Delete ${studentName}'s record?\n\nDelete removes it from normal use immediately, keeps it recoverable for 30 days, then permanently removes the live application record. Archive is a separate read-only option.\n\nType DELETE to continue.`,
    );
    if (confirmation !== "DELETE") return;
    setDeletingStudent(sessionId);
    try {
      const result = await apiFetch(`/teacher/classes/${classId}/students/${sessionId}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmation }),
      });
      queryClient.setQueryData(getListClassStudentsQueryKey(classId), (old: any) =>
        old?.filter((s: any) => s.id !== sessionId)
      );
      toast({
        title: `${studentName}'s record is scheduled for deletion`,
        description: `It can be restored from Scheduled deletions until ${new Date(result.deletionScheduledFor).toLocaleDateString("en-GB")}.`,
      });
    } catch (err: any) {
      toast({ title: "Could not schedule deletion", description: err.message, variant: "destructive" });
    } finally {
      setDeletingStudent(null);
    }
  };

  const handleRegistrationDecision = async (session: any, decision: "approve" | "reject") => {
    const label = decision === "approve" ? "approve" : "reject";
    if (!confirm(`${label === "approve" ? "Approve" : "Reject"} ${session.studentName}'s registration?`)) return;
    setReviewingRegistration(session.id);
    try {
      await apiFetch(`/teacher/classes/${classId}/students/${session.id}/${decision}`, { method: "POST" });
      queryClient.setQueryData(getListClassStudentsQueryKey(classId), (old: any) =>
        old?.map((s: any) => s.id === session.id ? { ...s, registrationStatus: decision === "approve" ? "approved" : "rejected", registrationReviewedAt: new Date().toISOString() } : s)
      );
      toast({ title: `${session.studentName}'s registration ${decision === "approve" ? "approved" : "rejected"}` });
    } catch (err: any) {
      toast({ title: "Could not update registration", description: err.message, variant: "destructive" });
    } finally {
      setReviewingRegistration(null);
    }
  };

  const handleDeleteRejectedRegistration = async (session: any) => {
    if (!confirm(`Remove ${session.studentName}'s rejected registration?\n\nThey can submit a fresh registration using the class code.`)) return;
    setReviewingRegistration(session.id);
    try {
      await apiFetch(`/teacher/classes/${classId}/students/${session.id}/rejection`, { method: "DELETE" });
      queryClient.setQueryData(getListClassStudentsQueryKey(classId), (old: any) =>
        old?.filter((s: any) => s.id !== session.id)
      );
      toast({ title: "Rejected registration removed" });
    } catch (err: any) {
      toast({ title: "Could not remove registration", description: err.message, variant: "destructive" });
    } finally {
      setReviewingRegistration(null);
    }
  };

  const handleSendTeacherMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!messageStudent || !messageDraft.trim() || messageSending) return;
    setMessageSending(true);
    setMessageError("");
    try {
      const sent = await apiFetch(`/teacher/classes/${classId}/students/${messageStudent.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: messageDraft.trim() }),
      });
      setMessageConversation((current) => [...current, sent]);
      setMessageDraft("");
      queryClient.invalidateQueries({ queryKey: getListClassStudentsQueryKey(classId) });
      toast({ title: "Message sent", description: `Message sent to ${messageStudent.name}.` });
    } catch (error: any) {
      setMessageError(error?.message || "Could not send message.");
    } finally {
      setMessageSending(false);
    }
  };

  const openTeacherMessagePanel = async (student: { id: number; studentName: string }) => {
    setMessageStudent({ id: student.id, name: student.studentName });
    setMessageConversation([]);
    setMessageDraft("");
    setMessageError("");
    setMessageLoading(true);
    try {
      const result = await apiFetch(`/teacher/classes/${classId}/students/${student.id}/messages`);
      setMessageConversation(result.messages ?? []);
      queryClient.invalidateQueries({ queryKey: getListClassStudentsQueryKey(classId) });
    } catch (error: any) {
      setMessageError(error?.message || "Messages could not be loaded.");
    } finally {
      setMessageLoading(false);
    }
  };

  const handleBulkReview = (decision: "approve" | "reject") => {
    if (!selectedSessionIds.length) return;
    if (!confirm(`Are you sure you want to ${decision} ${selectedSessionIds.length} students?`)) return;

    bulkReview.mutate({ classId, data: { sessionIds: selectedSessionIds, decision } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListClassStudentsQueryKey(classId) });
        setSelectedSessionIds([]);
        toast({ title: `Bulk ${decision} successful` });
      },
      onError: (err: any) => {
        toast({ title: `Failed to bulk ${decision}`, description: err.message, variant: "destructive" });
      }
    });
  };

  const filteredStudents = useMemo(() => {
    return students.filter(s => {
      const matchesSearch = s.studentName.toLowerCase().includes(searchQuery.toLowerCase());
      if (!matchesSearch) return false;
      if (statusFilter === "all") return true;
      if (statusFilter === "pending") return s.registrationStatus === "pending";
      if (statusFilter === "approved") return s.registrationStatus === "approved";
      if (statusFilter === "rejected") return s.registrationStatus === "rejected";
      if (statusFilter === "locked") return !!s.lockedAt;
      if (statusFilter === "archived") return !!s.archivedAt;
      return true;
    });
  }, [students, searchQuery, statusFilter]);
  const selectableStudents = filteredStudents.filter((student) => student.registrationStatus === "pending");

  const handleRegenerateCode = async () => {
    if (!confirm("Create a new class code?\n\nExisting students will stay connected. The old code will stop accepting new joins immediately.")) return;
    setRegeneratingCode(true);
    try {
      const result = await apiFetch(`/teacher/classes/${classId}/regenerate-code`, { method: "POST" });
      setCls((prev: any) => ({ ...prev, code: result.code }));
      toast({ title: "New class code created", description: "The old code can no longer be used to join this class." });
    } catch (err: any) {
      toast({ title: "Could not create a new code", description: err.message, variant: "destructive" });
    } finally {
      setRegeneratingCode(false);
    }
  };

  const handleArchive = async () => {
    const endpoint = cls.archivedAt ? "unarchive" : "archive";
    if (!confirm(cls.archivedAt
      ? "Reopen this class? Students will be able to edit, use AI tools, and new students can join using the class code again."
      : "Archive this class?\n\nStudents and teachers can still view existing work, but new joins, editing, and AI tools will be blocked until you reopen it.")) return;
    setArchiving(true);
    try {
      const result = await apiFetch(`/teacher/classes/${classId}/${endpoint}`, { method: "POST" });
      setCls((prev: any) => ({ ...prev, archivedAt: endpoint === "archive" ? result.archivedAt : null }));
      toast({ title: endpoint === "archive" ? "Class archived" : "Class reopened" });
    } catch (err: any) {
      toast({ title: "Could not update class status", description: err.message, variant: "destructive" });
    } finally {
      setArchiving(false);
    }
  };

  const handleDeleteClass = async () => {
    const confirmation = window.prompt(
      `Delete this class and its student records?\n\nThey will leave normal use immediately, remain recoverable for 30 days, then the application permanently removes the live records. Archive keeps a class read-only instead.\n\nType DELETE to continue.`,
    );
    if (confirmation !== "DELETE") return;
    setDeletingClass(true);
    try {
      const result = await apiFetch(`/teacher/classes/${classId}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmation }),
      });
      toast({
        title: "Class scheduled for deletion",
        description: `It can be restored from Scheduled deletions until ${new Date(result.deletionScheduledFor).toLocaleDateString("en-GB")}.`,
      });
      setLocation("/teacher/dashboard");
    } catch (err: any) {
      toast({ title: "Could not schedule class deletion", description: err.message, variant: "destructive" });
    } finally {
      setDeletingClass(false);
    }
  };

  if (loading) return null;
  if (!cls) return <div className="p-6">Class not found</div>;

  const getStageStatus = (student: any, stage: Stage): "none" | "started" | "finished" =>
    (student.stageStatuses?.[stage] ?? "none") as "none" | "started" | "finished";
  const studentsNeedingAttention = students.filter((student: any) => student.needsAttention);

  return (
    <div className="min-h-[100dvh] bg-neutral-50 text-neutral-900 font-sans">
      <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-6 py-4 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 text-sm">
            <Link href="/teacher/dashboard" className="text-neutral-500 hover:text-black">Dashboard</Link>
            <span className="text-neutral-300">/</span>
            <Link href="/teacher/archive" className="text-neutral-500 hover:text-black">Archive/Delete</Link>
            <span className="text-neutral-300">/</span>
            <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{cls.name}</span>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/teacher/class/${classId}/activity`}
              className="rounded-2xl border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 transition-colors"
              data-testid="button-class-activity"
            >
              Class Activity
            </Link>
            <Link
              href={`/teacher/class/${classId}/insights`}
              className="rounded-2xl bg-neutral-900 text-white px-5 py-2 text-sm font-medium hover:bg-neutral-700 transition-colors"
              data-testid="button-class-insights"
            >
              Teaching Insights
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-12 space-y-8">

        {/* Class header */}
        <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div className="min-w-0 flex-1">
            {editingClassDetails ? (
              <form onSubmit={handleSaveClassDetails} className="max-w-xl space-y-4" data-testid="form-edit-class-details">
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block text-sm font-medium text-neutral-700">
                    Class name
                    <input
                      required
                      maxLength={200}
                      value={classNameDraft}
                      onChange={(event) => setClassNameDraft(event.target.value)}
                      className="mt-1 w-full rounded-xl border border-neutral-300 bg-white px-3 py-2.5 text-sm text-neutral-900 outline-none focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                      data-testid="input-edit-class-name"
                    />
                  </label>
                  <label className="block text-sm font-medium text-neutral-700">
                    Subject
                    <input
                      maxLength={200}
                      value={classSubjectDraft}
                      onChange={(event) => setClassSubjectDraft(event.target.value)}
                      className="mt-1 w-full rounded-xl border border-neutral-300 bg-white px-3 py-2.5 text-sm text-neutral-900 outline-none focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                      data-testid="input-edit-class-subject"
                    />
                  </label>
                </div>
                {classDetailsError && <p className="text-sm text-red-700" role="alert">{classDetailsError}</p>}
                <div className="flex flex-wrap gap-2">
                  <button type="submit" disabled={savingClassDetails} className="rounded-xl bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-neutral-700 disabled:opacity-50" data-testid="button-save-class-details">
                    {savingClassDetails ? "Saving…" : "Save class details"}
                  </button>
                  <button type="button" disabled={savingClassDetails} onClick={() => setEditingClassDetails(false)} className="rounded-xl border border-neutral-300 bg-white px-4 py-2.5 text-sm font-semibold text-neutral-700 hover:bg-neutral-50 disabled:opacity-50">
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <h1 className="min-w-0 text-3xl font-semibold tracking-tight mb-1 [overflow-wrap:anywhere]">{cls.name}</h1>
                  {cls.archivedAt && <span className="rounded-full bg-amber-100 border border-amber-200 px-3 py-1 text-xs font-semibold text-amber-800">Archived · read only</span>}
                </div>
                {cls.subject && <p className="text-neutral-500">{cls.subject}</p>}
                {!cls.archivedAt && (
                  <button type="button" onClick={startEditingClassDetails} className="mt-3 rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-50" data-testid="button-edit-class-details">
                    Edit class details
                  </button>
                )}
              </>
            )}
          </div>
          <div className="bg-neutral-50 rounded-2xl p-6 border border-neutral-200 min-w-[240px] text-center">
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-2">Class Code</p>
            <p className="text-4xl font-mono font-bold tracking-widest mb-3">{cls.code}</p>
            <div className="flex justify-center gap-2">
              <CopyButton code={cls.code} />
              <button onClick={handleRegenerateCode} disabled={regeneratingCode || cls.archivedAt} className="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-600 hover:text-neutral-900 disabled:opacity-40">
                {regeneratingCode ? "Creating…" : "New code"}
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={handleArchive} disabled={archiving || deletingClass} className={`rounded-2xl px-5 py-3 text-sm font-semibold transition-colors disabled:opacity-50 ${cls.archivedAt ? "bg-emerald-600 text-white hover:bg-emerald-700" : "border border-amber-300 text-amber-800 hover:bg-amber-50"}`}>
              {archiving ? "Saving…" : cls.archivedAt ? "Reopen class" : "Archive class"}
            </button>
            {!cls.archivedAt && (
              <button onClick={handleDeleteClass} disabled={deletingClass || archiving} className="rounded-2xl border border-red-200 px-5 py-3 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50">
                {deletingClass ? "Scheduling…" : "Delete class"}
              </button>
            )}
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
              onClick={toggleTaskForm}
              disabled={Boolean(cls.archivedAt)}
              className="shrink-0 rounded-2xl bg-black px-5 py-3 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              data-testid="button-set-task"
            >
              {cls.archivedAt ? "Read-only class" : showTaskForm ? "Cancel" : task ? "Edit Task" : "Set Task"}
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
                    <p className="text-lg font-semibold leading-snug" data-testid="saved-task-title">{task.title}</p>
                  {!taskExpanded && task.question && (
                    <p className="text-sm text-neutral-500 truncate mt-0.5">{task.question}</p>
                  )}
                  {!taskExpanded && (
                    <p className="mt-2 text-xs text-neutral-500">
                      Framework: <span className="font-semibold text-neutral-800">
                        {task.learningFramework === "knowledge_dimensions" ? "Knowledge Dimensions" : "Bloom's Taxonomy"}
                      </span>
                    </p>
                  )}
                </div>
                <div className="shrink-0 flex items-center gap-3">
                  {task.deadlineClosed && (
                    <span className="rounded-full bg-red-50 px-3 py-1 text-xs font-semibold text-red-700">
                      Closed
                    </span>
                  )}
                  {!task.deadlineClosed && task.lateEditingAllowed && (
                    <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
                      Reopened for late editing
                    </span>
                  )}
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
              {!taskExpanded && (
                <button
                  type="button"
                  onClick={() => setShowTaskForm(true)}
                  className="mt-2 rounded-xl border border-neutral-200 bg-white px-3 py-2 text-xs font-semibold text-neutral-700 hover:border-neutral-400"
                  data-testid="button-choose-framework"
                >
                  Choose framework
                </button>
              )}

              {/* Collapsible details */}
              {taskExpanded && (
                <div className="pt-4 pb-2 space-y-4 border-t border-neutral-100 mt-2">
                  {task.dueDate && (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
                      <div>
                        <p className="text-xs font-bold uppercase tracking-widest text-neutral-400">Due date</p>
                        <p className="text-sm font-semibold">{new Date(`${task.dueDate}T12:00:00`).toLocaleDateString()}</p>
                        <p className="mt-1 text-xs text-neutral-500">
                          {task.deadlineClosed
                            ? "Student work is now read-only."
                            : task.lateEditingAllowed
                              ? "Late editing has been authorised."
                              : "Students can edit until the end of this date (UK time)."}
                        </p>
                      </div>
                      {task.deadlineClosed && (
                        <button
                          type="button"
                          onClick={() => { void handleReopenTask(); }}
                          disabled={reopeningTask}
                          className="rounded-xl bg-black px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
                          data-testid="button-reopen-task"
                        >
                          {reopeningTask ? "Reopening…" : "Reopen for late editing"}
                        </button>
                      )}
                      {task.lateEditingAllowed && (
                        <button
                          type="button"
                          onClick={() => { void handleCloseTask(); }}
                          disabled={closingTask}
                          className="rounded-xl border border-neutral-300 bg-white px-4 py-2 text-xs font-semibold text-neutral-800 disabled:opacity-50"
                          data-testid="button-close-late-editing"
                        >
                          {closingTask ? "Closing…" : "Close late editing"}
                        </button>
                      )}
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
                  {(task.learningFramework ?? "bloom") === "bloom" && task.bloomLevels?.length > 0 && (
                    <div>
                      <p className="text-xs font-bold uppercase tracking-widest text-neutral-400 mb-2">Focus Bloom's Levels</p>
                      <div className="flex flex-wrap gap-2">
                        {task.bloomLevels.map((l: string) => (
                          <span key={l} className="px-3 py-1 rounded-full text-xs font-semibold bg-neutral-900 text-white">{l}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {task.learningFramework === "knowledge_dimensions" && task.knowledgeDimensions?.length > 0 && (
                    <div>
                      <p className="text-xs font-bold uppercase tracking-widest text-neutral-400 mb-2">Knowledge Dimension</p>
                      <div className="flex flex-wrap gap-2">
                        {task.knowledgeDimensions.map((dimension: string) => (
                          <span key={dimension} className="px-3 py-1 rounded-full text-xs font-semibold bg-sky-50 border border-sky-200 text-sky-800">{dimension}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {task.yearGroup && <p className="mt-3 text-sm text-neutral-500">Target year group: <span className="font-medium text-neutral-800">{task.yearGroup}</span></p>}
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
          {showTaskForm && !cls.archivedAt && (
            <form onSubmit={handleSaveTask} className="px-8 py-6 space-y-6">
              <div className="flex items-center justify-between gap-3 rounded-xl bg-neutral-50 px-4 py-3 text-xs text-neutral-500">
                <span>Changes save automatically while you work.</span>
                <span
                  aria-live="polite"
                  className={taskAutoSaveStatus === "error" ? "font-medium text-red-600" : "font-medium text-neutral-600"}
                >
                  {taskAutoSaveStatus === "saving"
                    ? "Saving…"
                    : taskAutoSaveStatus === "error"
                      ? "Auto-save failed — use Save Task to retry"
                      : taskAutoSaveStatus === "saved"
                        ? "All changes saved"
                        : ""}
                </span>
              </div>
              <div className="grid gap-6 md:grid-cols-2">
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium mb-2">Task Name <span className="text-red-500">*</span></label>
                  <input
                    required
                    type="text"
                    value={taskTitle}
                    onChange={(e) => setTaskTitle(e.target.value)}
                    className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                    placeholder="e.g. Causes of World War I"
                    autoFocus={!taskTitle.trim()}
                    data-testid="input-task-title"
                  />
                  <p className="mt-1 text-xs text-neutral-400">Start here. Once the task has a name, choose the framework and the rest of the task details.</p>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">Due Date (summative assessment issued after this date)</label>
                  <input
                    type="date"
                    value={taskDueDate}
                    onChange={(e) => setTaskDueDate(e.target.value)}
                    className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                    data-testid="input-task-due-date"
                  />
                  <p className="mt-1 text-xs text-neutral-400">
                    Students can edit until 11:59pm on this date (UK time). The summative assessment is issued after the completion date. Changing the date cancels any previous late-edit reopening.
                  </p>
                </div>
                <div>
                  <label htmlFor="task-formative-date" className="block text-sm font-medium mb-2">Formative assessment date</label>
                  <input
                    id="task-formative-date"
                    type="date"
                    value={taskFormativeAssessmentDate}
                    onChange={(event) => setTaskFormativeAssessmentDate(event.target.value)}
                    className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                    data-testid="input-task-formative-assessment-date"
                  />
                  <p className="mt-1 text-xs text-neutral-400">When you plan to review formative progress.</p>
                </div>
                <div>
                  <label htmlFor="task-subject" className="block text-sm font-medium mb-2">Subject <span className="text-red-500">*</span></label>
                  <input
                    id="task-subject"
                    required
                    type="text"
                    value={taskSubject}
                    onChange={(event) => { setTaskSubject(event.target.value); setTaskSuggestion(null); }}
                    className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                    placeholder="e.g. Biology"
                    data-testid="input-task-subject"
                  />
                  <p className="mt-1 text-xs text-neutral-400">Starts with the class subject. Editing it changes this task only.</p>
                </div>
                <div>
                  <label htmlFor="task-exam-board" className="block text-sm font-medium mb-2">Exam board</label>
                  <select
                    id="task-exam-board"
                    value={taskUsesCustomExamBoard ? CUSTOM_EXAM_BOARD : taskExamBoard}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value === CUSTOM_EXAM_BOARD) {
                        setTaskUsesCustomExamBoard(true);
                        if (EXAM_BOARDS.includes(taskExamBoard as typeof EXAM_BOARDS[number])) setTaskExamBoard("");
                      } else {
                        setTaskUsesCustomExamBoard(false);
                        setTaskExamBoard(value);
                      }
                      setTaskSuggestion(null);
                    }}
                    className="w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                    data-testid="select-task-exam-board"
                  >
                    <option value="">Not specified</option>
                    {EXAM_BOARDS.map((board) => <option key={board} value={board}>{board}</option>)}
                    <option value={CUSTOM_EXAM_BOARD}>Other / custom</option>
                  </select>
                  {taskUsesCustomExamBoard && (
                    <input
                      type="text"
                      value={taskExamBoard}
                      onChange={(event) => { setTaskExamBoard(event.target.value); setTaskSuggestion(null); }}
                      maxLength={200}
                      className="mt-2 w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                      placeholder="Enter exam-board name"
                      aria-label="Custom exam-board name"
                      data-testid="input-custom-exam-board"
                    />
                  )}
                  <p className="mt-1 text-xs text-neutral-400">Used as planning context; AI does not verify specifications.</p>
                </div>
              </div>

              <fieldset className="rounded-2xl border border-neutral-200 p-5">
                <legend className="px-2 text-sm font-semibold">Choose one learning framework</legend>
                <p className="mb-4 text-xs text-neutral-500">This task will use either Bloom&apos;s Taxonomy or Knowledge Dimensions, never both.</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => selectLearningFramework("bloom")}
                    className={`rounded-2xl border p-4 text-left ${taskLearningFramework === "bloom" ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-200 bg-white"}`}
                    aria-pressed={taskLearningFramework === "bloom"}
                    data-testid="framework-bloom"
                  >
                    <span className="block font-semibold">Bloom&apos;s Taxonomy</span>
                    <span className={`mt-1 block text-xs leading-relaxed ${taskLearningFramework === "bloom" ? "text-neutral-300" : "text-neutral-500"}`}>Choose the thinking level students should demonstrate, from recalling to creating.</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => selectLearningFramework("knowledge_dimensions")}
                    className={`rounded-2xl border p-4 text-left ${taskLearningFramework === "knowledge_dimensions" ? "border-sky-700 bg-sky-700 text-white" : "border-neutral-200 bg-white"}`}
                    aria-pressed={taskLearningFramework === "knowledge_dimensions"}
                    data-testid="framework-knowledge-dimensions"
                  >
                    <span className="block font-semibold">Knowledge Dimensions</span>
                    <span className={`mt-1 block text-xs leading-relaxed ${taskLearningFramework === "knowledge_dimensions" ? "text-sky-100" : "text-neutral-500"}`}>Choose the kind of knowledge students should develop, from facts to reflection.</span>
                  </button>
                </div>

                <div className="mt-5">
                  <p className="mb-3 text-sm font-medium">
                    {taskLearningFramework === "bloom" ? "Select Bloom's levels" : "Select Knowledge Dimensions"}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {(taskLearningFramework === "bloom" ? ALL_BLOOM : ALL_KNOWLEDGE_DIMENSIONS).map((item) => {
                      const selected = taskLearningFramework === "bloom" ? taskBlooms.includes(item) : taskKnowledgeDimensions.includes(item);
                      return (
                        <button
                          type="button"
                          key={item}
                          onClick={() => taskLearningFramework === "bloom" ? toggleBloom(item) : toggleKnowledgeDimension(item)}
                          className={`rounded-2xl border px-4 py-3 text-left transition-all ${
                            selected
                              ? taskLearningFramework === "bloom" ? "border-neutral-900 bg-neutral-900 text-white" : "border-sky-700 bg-sky-700 text-white"
                              : "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-500"
                          }`}
                          aria-pressed={selected}
                          data-testid={`framework-option-${item.toLowerCase().replace(/\s+/g, "-")}`}
                        >
                          <span className="block text-sm font-semibold">{item}</span>
                          <span className={`mt-1 block text-xs font-normal leading-relaxed ${selected ? "text-white/75" : "text-neutral-500"}`}>
                            {FRAMEWORK_DESCRIPTIONS[item]}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </fieldset>

              <div className="rounded-2xl border border-violet-200 bg-violet-50 p-5">
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                  <div>
                    <label htmlFor="task-year-group" className="mb-2 block text-sm font-medium">Year group</label>
                    <select
                      id="task-year-group"
                      value={taskYearGroup}
                      onChange={(event) => { setTaskYearGroup(event.target.value); setTaskSuggestion(null); }}
                      className="w-full rounded-2xl border border-violet-200 bg-white px-4 py-3 text-sm"
                      data-testid="select-task-year-group"
                    >
                      <option value="">Select a year group</option>
                      {Object.entries(YEAR_GROUPS).map(([keyStage, years]) => (
                        <optgroup key={keyStage} label={keyStage}>
                          {years.map((year) => <option key={year} value={year}>{year} — {keyStage}</option>)}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    onClick={() => void generateRemainingTask()}
                    disabled={generatingTask || !taskTitle.trim() || !taskSubject.trim() || !taskYearGroup || (taskLearningFramework === "bloom" ? taskBlooms.length === 0 : taskKnowledgeDimensions.length === 0)}
                    className="rounded-2xl bg-violet-700 px-5 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
                    data-testid="button-generate-remaining-task"
                  >
                    {generatingTask ? "Generating…" : "Generate remaining task"}
                  </button>
                </div>
                {taskSuggestionError && <p className="mt-3 text-sm text-red-700" role="alert">{taskSuggestionError}</p>}
                {suggestionAnnouncement && <p className="sr-only" role="status" aria-live="polite">{suggestionAnnouncement}</p>}
              </div>

              {taskSuggestion && (
                <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5" data-testid="task-suggestion-review">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h4 className="font-semibold text-emerald-950">Review AI suggestions</h4>
                      <p className="mt-1 text-xs text-emerald-800">Nothing changes until you apply it. Existing teacher content is kept unless you choose to replace it.</p>
                    </div>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => setTaskSuggestion(null)} className="rounded-xl border border-emerald-300 bg-white px-3 py-2 text-xs font-semibold">Dismiss</button>
                      <button type="button" onClick={applyAllSuggestions} className="rounded-xl bg-emerald-700 px-3 py-2 text-xs font-semibold text-white">Apply task and resources</button>
                    </div>
                  </div>
                  <div className="mt-5 space-y-3">
                    <div className={`rounded-xl border p-3 text-sm ${
                      taskSuggestion.researchStatus === "complete"
                        ? "border-sky-200 bg-sky-50 text-sky-900"
                        : "border-amber-200 bg-amber-50 text-amber-900"
                    }`} role="status" data-testid="task-research-status">
                      <p className="font-semibold">Live web research</p>
                      <p className="mt-1 text-xs leading-relaxed">{taskSuggestion.researchNotice}</p>
                    </div>
                    {[
                      ["question", "Task question", taskSuggestion.question],
                      ["notes", "Guidance notes", taskSuggestion.notes],
                      ["successCriteria", "Success criteria", (taskSuggestion.successCriteria ?? []).join("\n")],
                      ["keyVocabulary", "Key vocabulary", (taskSuggestion.keyVocabulary ?? []).join(", ")],
                      ["expectedLength", "Expected length", taskSuggestion.expectedLength],
                      ["stageInstructions", "Stage instructions", Object.entries(taskSuggestion.stageInstructions ?? {}).map(([stage, value]) => `${stage.toUpperCase()}: ${value}`).join("\n")],
                    ].map(([field, label, value]) => (
                      <div key={field} className="rounded-xl border border-emerald-100 bg-white p-4">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-xs font-bold uppercase tracking-wider text-emerald-800">{label}</p>
                          <button
                            type="button"
                            onClick={() => applySuggestionField(field)}
                            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500/40 ${
                              appliedSuggestionFields[field]
                                ? "border-emerald-500 bg-emerald-100 text-emerald-900"
                                : "border-emerald-300 text-emerald-800 hover:bg-emerald-50 active:bg-emerald-100"
                            }`}
                            aria-label={appliedSuggestionFields[field] ? `${label} applied` : `Apply ${label}`}
                            data-testid={`button-apply-suggestion-${field}`}
                          >
                            {appliedSuggestionFields[field] ? (
                              <>
                                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 8 3.2 3.2L13 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                                Applied
                              </>
                            ) : "Apply"}
                          </button>
                        </div>
                        {field === "successCriteria" || field === "keyVocabulary" ? (
                          <textarea
                            value={field === "successCriteria" ? (taskSuggestion.successCriteria ?? []).join("\n") : (taskSuggestion.keyVocabulary ?? []).join("\n")}
                            onChange={(event) => updateSuggestionList(field, event.target.value)}
                            rows={field === "successCriteria" ? 4 : 3}
                            className="mt-2 w-full resize-y rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm text-neutral-700 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                            aria-label={`Edit ${label}`}
                          />
                        ) : field === "stageInstructions" ? (
                          <textarea
                            value={Object.entries(taskSuggestion.stageInstructions ?? {}).map(([stage, instruction]) => `${stage.toUpperCase()}: ${instruction}`).join("\n")}
                            onChange={(event) => updateSuggestionStages(event.target.value)}
                            rows={5}
                            className="mt-2 w-full resize-y rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm text-neutral-700 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                            aria-label={`Edit ${label}`}
                          />
                        ) : (
                          <textarea
                            value={String(taskSuggestion[field] ?? "")}
                            onChange={(event) => updateSuggestion(field, event.target.value)}
                            rows={field === "question" || field === "notes" ? 3 : 2}
                            className="mt-2 w-full resize-y rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm text-neutral-700 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                            aria-label={`Edit ${label}`}
                          />
                        )}
                      </div>
                    ))}
                    {(taskSuggestion.resourceSuggestions ?? []).length > 0 && (
                      <div className="rounded-xl border border-emerald-100 bg-white p-4">
                        <p className="text-xs font-bold uppercase tracking-wider text-emerald-800">Live source suggestions</p>
                        <p className="mt-1 text-xs text-neutral-500">These are suggestions only. They have not been checked or verified. You must check and verify each source before adding it to the task or giving it to students.</p>
                        <div className="mt-3 space-y-2">
                          {taskSuggestion.resourceSuggestions.map((suggestion: any, index: number) => (
                            <div key={suggestion.url ?? index} className="flex flex-col gap-3 rounded-lg border border-emerald-100 p-3 sm:flex-row sm:items-center">
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="rounded-full bg-emerald-100 px-2 py-1 text-[11px] font-semibold text-emerald-900">
                                    {suggestion.sourceCategory === "official_exam_board" ? "Official exam board" : "Reputable education"}
                                  </span>
                                  <span className="text-xs text-neutral-500">{suggestion.publisher}</span>
                                </div>
                                <input
                                  type="text"
                                  value={suggestion.label}
                                  onChange={(event) => updateResourceSuggestion(index, "label", event.target.value)}
                                  className="mt-2 w-full min-w-0 rounded-lg border border-emerald-200 bg-white px-3 py-2 text-sm text-neutral-700"
                                  aria-label={`Edit resource suggestion ${index + 1}`}
                                />
                                <a href={suggestion.url} target="_blank" rel="noopener noreferrer" className="mt-2 block break-all text-xs font-medium text-sky-700 underline">
                                  Open source: {suggestion.url}
                                </a>
                                <p className="mt-2 text-xs text-neutral-600">{suggestion.reason}</p>
                                <p className="mt-1 text-[11px] text-amber-700">
                                  Retrieved {new Date(suggestion.retrievedAt).toLocaleDateString("en-GB")} · Not specification-verified
                                </p>
                              </div>
                              <button
                                type="button"
                                onClick={() => addSuggestedResource(index)}
                                disabled={appliedSuggestionFields[`resource-${index}`]}
                                className="shrink-0 rounded-lg border border-emerald-300 px-3 py-2 text-xs font-semibold text-emerald-800 disabled:bg-emerald-100"
                                aria-label={appliedSuggestionFields[`resource-${index}`] ? `Resource suggestion ${index + 1} added` : `Add resource suggestion ${index + 1}`}
                                data-testid={`button-add-resource-suggestion-${index}`}
                              >
                                {appliedSuggestionFields[`resource-${index}`] ? "Added" : "Add to resources"}
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </section>
              )}

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
                <p className="text-xs text-neutral-400 mb-2">Students see these notes as help for completing the task. The AI tutor may also use them to keep support relevant.</p>
                <textarea
                  value={taskNotes}
                  onChange={(e) => setTaskNotes(e.target.value)}
                  className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm min-h-[80px] resize-none focus:outline-none focus:ring-2 focus:ring-black/10"
                  placeholder="e.g. Focus on chapters 3–5. Consider the role of alliances, imperialism, and the assassination of Franz Ferdinand."
                  data-testid="input-task-notes"
                />
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
                <p className="text-xs text-neutral-400 mb-3">Paste words separated by spaces, or use commas/new lines to keep multi-word terms together. The AI tutor will also nudge students toward these in TORCH.</p>
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
                    onPaste={(e) => {
                      const terms = splitVocabularyPaste(e.clipboardData.getData("text"));
                      if (terms.length > 0) {
                        e.preventDefault();
                        setTaskKeyVocabulary(mergeVocabularyTerms(taskKeyVocabulary, terms));
                        setTaskVocabInput("");
                      }
                    }}
                    onKeyDown={(e) => {
                      if ((e.key === "Enter" || e.key === ",") && taskVocabInput.trim()) {
                        e.preventDefault();
                        setTaskKeyVocabulary(mergeVocabularyTerms(taskKeyVocabulary, [taskVocabInput.trim()]));
                        setTaskVocabInput("");
                      }
                    }}
                    className="flex-1 rounded-xl border border-neutral-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                    placeholder="Paste a list or type a term"
                  />
                  <button
                    type="button"
                    onClick={() => { if (taskVocabInput.trim()) { setTaskKeyVocabulary(mergeVocabularyTerms(taskKeyVocabulary, [taskVocabInput.trim()])); setTaskVocabInput(""); } }}
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
                    const STAGE_ICON: Record<string, ReactNode> = {
                      MAP: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s-8-4.5-8-11.8A8 8 0 0 1 12 2a8 8 0 0 1 8 8.2c0 7.3-8 11.8-8 11.8z"/><circle cx="12" cy="10" r="3"/></svg>,
                      TORCH: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>,
                      COMPASS: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>,
                      EMBED: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>,
                      RESEARCH: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>
                    };
                    const STAGE_NAME: Record<string, string> = { MAP: "Map", TORCH: "Torch", COMPASS: "Compass", EMBED: "Final Answer", RESEARCH: "Research" };
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
                          <div className="mb-2 opacity-80">{STAGE_ICON[stage]}</div>
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
                        {stage === "EMBED" ? "Final Answer" : stage === "RESEARCH" ? "Research" : stage}
                      </span>
                      <textarea
                        value={taskStageInstructions[stage.toLowerCase()] ?? ""}
                        onChange={(e) => setTaskStageInstructions({ ...taskStageInstructions, [stage.toLowerCase()]: e.target.value })}
                        className="flex-1 rounded-xl border border-neutral-200 px-3 py-2 text-sm min-h-[60px] resize-none focus:outline-none focus:ring-2 focus:ring-black/10"
                        placeholder={
                          stage === "MAP" ? "e.g. Note everything you already know — don't look anything up yet." :
                          stage === "TORCH" ? "e.g. Ask the AI tutor questions. Try to understand the causes, not just list them." :
                          stage === "COMPASS" ? "e.g. Use your notes from MAP and TORCH to plan your answer with clear paragraphs." :
                          "e.g. Write your final answer. Aim to use all the key vocabulary."
                        }
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Resources */}
              <div>
                <label className="block text-sm font-medium mb-1">Resources <span className="text-neutral-400 font-normal">(optional)</span></label>
                <p className="text-xs text-neutral-400 mb-3">Add up to 5 teacher-checked resources. Mix web links, books, videos, and documents.</p>
                <div className="space-y-2">
                  {taskResources.map((resource, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <select
                        value={parseResource(resource).type}
                        onChange={(e) => {
                          const updated = [...taskResources];
                          updated[i] = formatResource(e.target.value as ResourceType, parseResource(resource).label);
                          setTaskResources(updated);
                        }}
                        className="w-32 rounded-xl border border-neutral-200 px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                        aria-label={`Resource ${i + 1} type`}
                      >
                        {RESOURCE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                      </select>
                      <input
                        type="text"
                        value={parseResource(resource).label}
                        onChange={(e) => {
                          const updated = [...taskResources];
                          updated[i] = formatResource(parseResource(resource).type, e.target.value);
                          setTaskResources(updated);
                        }}
                        className="flex-1 rounded-xl border border-neutral-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                        placeholder="e.g. Chapter 3 of your textbook / https://..."
                        aria-label={`Resource ${i + 1}`}
                      />
                      {taskResources.length > 1 && (
                        <button type="button" onClick={() => setTaskResources(taskResources.filter((_, j) => j !== i))} className="text-neutral-400 hover:text-red-500 text-lg leading-none shrink-0">×</button>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    disabled={taskResources.length >= 5}
                    onClick={() => setTaskResources([...taskResources, ""])}
                    className="text-sm text-neutral-500 hover:text-black transition-colors mt-1 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {taskResources.length >= 5 ? "Maximum of 5 resources" : "+ Add resource"}
                  </button>
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

        <section className="rounded-[2rem] bg-white border border-sky-200 shadow-sm overflow-hidden" data-testid="class-journey-analysis">
          <button
            type="button"
            onClick={toggleDevelopmentAnalysis}
            className="w-full flex items-center justify-between gap-4 px-8 py-5 text-left hover:bg-sky-50/40 transition-colors"
            aria-expanded={developmentAnalysisOpen}
          >
            <div>
              <p className="text-xs uppercase tracking-[0.2em] font-semibold text-sky-700">Teacher view</p>
              <h3 className="mt-1 text-lg font-semibold">Class Journey Analysis</h3>
            </div>
            <span className="text-sm font-medium text-sky-700">{developmentAnalysisOpen ? "Hide" : "Open"}</span>
          </button>
          {developmentAnalysisOpen && (
            <div className="border-t border-sky-100 px-8 py-5 space-y-6">
              {developmentAnalysisLoading ? (
                <p className="text-sm text-neutral-500">Loading saved Class Journey Analysis…</p>
              ) : developmentAnalysis?.error ? (
                <p className="text-sm text-red-700">{developmentAnalysis.error}</p>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-neutral-600">
                      {developmentAnalysis?.report
                        ? `Saved ${new Date(developmentAnalysis.generatedAt ?? developmentAnalysis.report.generatedAt).toLocaleDateString("en-GB")}`
                        : "Generate this report deliberately when the class journey is ready for review."}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {developmentAnalysis?.report && (
                        <>
                          <button type="button" onClick={() => void downloadClassJourneyFile("pdf")} className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm font-semibold text-neutral-700">Download PDF</button>
                          <button type="button" onClick={() => void downloadClassJourneyFile("csv")} className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm font-semibold text-neutral-700">Download CSV</button>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => void generateClassJourneyAnalysis()}
                        disabled={journeyGenerating || (developmentAnalysis?.evidence?.denominator ?? 0) < 1}
                        className="rounded-lg bg-sky-700 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {journeyGenerating ? "Generating…" : developmentAnalysis?.report ? "Regenerate Analysis" : "Generate Analysis"}
                      </button>
                    </div>
                  </div>

                  {developmentAnalysis?.evidence && (
                    <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
                      <h4 className="text-xs font-bold uppercase tracking-widest text-amber-900">Evidence coverage</h4>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        {[
                          ["Students", developmentAnalysis.evidence.totalStudents],
                          ["Both Student Insights", developmentAnalysis.evidence.studentsWithBothInsights],
                          ["Comparable evidence", developmentAnalysis.evidence.denominator],
                          ["Awaiting evidence", developmentAnalysis.evidence.awaitingComparableEvidence],
                        ].map(([label, value]) => (
                          <div key={label as string} className="rounded-xl border border-amber-200 bg-white p-3">
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-800/70">{label as string}</p>
                            <p className="mt-1 text-xl font-semibold text-amber-950">{value as number}</p>
                          </div>
                        ))}
                      </div>
                      {developmentAnalysis.evidence.awaitingComparableEvidence > 0 && (
                        <p className="mt-4 text-sm text-amber-950">
                          This analysis will cover only {developmentAnalysis.evidence.denominator} of {developmentAnalysis.evidence.totalStudents} students with sufficient comparable evidence.
                        </p>
                      )}
                    </section>
                  )}

                  {developmentAnalysis?.report && (() => {
                    const report = developmentAnalysis.report;
                    const sectionList = (items: unknown) => Array.isArray(items) && items.length
                      ? <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-neutral-700">{items.map((item: unknown, index: number) => <li key={index}>{String(item)}</li>)}</ul>
                      : <p className="mt-3 text-sm italic text-neutral-500">No finding was recorded.</p>;
                    return (
                      <div className="space-y-5">
                         {report.thinkingChoicesAcrossClass && (
                           <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5" data-testid="thinking-choices-across-class">
                             <h4 className="text-xs font-bold uppercase tracking-widest text-amber-900">Thinking Choices Across the Class</h4>
                             <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                               {Object.entries(report.thinkingChoicesAcrossClass.studentsByOptionCount ?? {}).map(([count, value]: [string, any]) => (
                                 <div key={count} className="rounded-xl border border-amber-200 bg-white p-3">
                                   <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-800/70">{count} options</p>
                                   <p className="mt-1 text-xl font-semibold text-amber-950">{value.students}{report.thinkingChoicesAcrossClass.showPercentages ? <span className="text-sm font-normal"> ({value.percentage}%)</span> : null}</p>
                                 </div>
                               ))}
                             </div>
                             <p className="mt-4 text-sm text-amber-950">
                               Most common first choice: <strong>{report.thinkingChoicesAcrossClass.mostCommonFirstChoice ?? "No recorded choice"}</strong>.
                               {" "}Students who broadened their choices after formative feedback: <strong>{report.thinkingChoicesAcrossClass.studentsWhoBroadenedAfterFeedback ?? 0}</strong>.
                             </p>
                             <div className="mt-4 grid gap-2 sm:grid-cols-2">
                               {Object.entries(report.thinkingChoicesAcrossClass.optionPopularity ?? {}).map(([option, value]: [string, any]) => (
                                 <p key={option} className="text-sm text-amber-950">
                                   <strong>{option}:</strong> {value.uses} submitted use{value.uses === 1 ? "" : "s"} across {value.students} student{value.students === 1 ? "" : "s"} (average {value.averageUse} per student).
                                 </p>
                               ))}
                             </div>
                             <p className="mt-3 text-sm text-amber-950">
                               Submitted use before formative feedback: <strong>{report.thinkingChoicesAcrossClass.totalPreFeedbackUse ?? 0}</strong>;
                               {" "}after: <strong>{report.thinkingChoicesAcrossClass.totalPostFeedbackUse ?? 0}</strong>.
                               {" "}Transitions recorded: <strong>{report.thinkingChoicesAcrossClass.transitions?.length ?? 0}</strong>.
                               {" "}Immediate multi-option use: <strong>{report.thinkingChoicesAcrossClass.immediateMultiOptionStudents ?? 0}</strong>;
                               {" "}gradual introduction: <strong>{report.thinkingChoicesAcrossClass.gradualOptionStudents ?? 0}</strong>.
                             </p>
                           </section>
                         )}
                        {[
                          ["Formative-to-summative changes", report.formativeToSummativeChanges?.findings],
                          ["Response to formative feedback", report.responseToFormativeFeedback?.findings],
                          ["Response to AI feedback", report.responseToAiFeedback?.findings],
                          ["Class similarities", report.classSimilarities],
                          ["Notable differences", report.notableDifferences],
                          ["Reflection and future planning", report.reflectionAndFuturePlanning],
                          ["Evidence limitations", report.evidenceLimitations],
                        ].map(([title, items]) => (
                          <section key={title as string} className="rounded-2xl border border-neutral-200 bg-neutral-50 p-5">
                            <h4 className="text-xs font-bold uppercase tracking-widest text-neutral-600">{title as string}</h4>
                            {sectionList(items)}
                          </section>
                        ))}
                        <section className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
                          <h4 className="text-xs font-bold uppercase tracking-widest text-sky-800">Activity context</h4>
                          <p className="mt-3 text-sm text-sky-950">
                            {report.activityContext?.studentsWithActivityAfterFormative ?? 0} of {report.activityContext?.studentsCompared ?? 0} comparable students had recorded activity after the Formative Insight. This is contextual interaction inside the Climb, not progress.
                          </p>
                        </section>
                        <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
                          <h4 className="text-xs font-bold uppercase tracking-widest text-emerald-800">Feedback marked as actioned</h4>
                          {(() => {
                            const summary = report.feedbackMarkedAsActioned ?? {};
                            const denominator = summary.denominator ?? 0;
                            return (
                              <dl className="mt-3 grid gap-2 text-sm text-emerald-950 sm:grid-cols-2">
                                <div><dt className="font-medium">Total feedback points marked as actioned</dt><dd>{summary.total ?? 0} of {denominator}</dd></div>
                                <div><dt className="font-medium">With a related later change</dt><dd>{summary.relatedLaterChange ?? 0} of {denominator}</dd></div>
                                <div><dt className="font-medium">With a partial related later change</dt><dd>{summary.partialRelatedLaterChange ?? 0} of {denominator}</dd></div>
                                <div><dt className="font-medium">With no related change found</dt><dd>{summary.noRelatedChangeFound ?? 0} of {denominator}</dd></div>
                                <div><dt className="font-medium">Insufficient evidence</dt><dd>{summary.insufficientEvidence ?? 0} of {denominator}</dd></div>
                              </dl>
                            );
                          })()}
                        </section>
                      </div>
                    );
                  })()}
                </>
              )}
            </div>
          )}
        </section>

        <section className="hidden" aria-hidden="true" data-testid="historical-development-analysis">
          <button
            type="button"
            onClick={toggleDevelopmentAnalysis}
            className="w-full flex items-center justify-between gap-4 px-8 py-5 text-left hover:bg-sky-50/40 transition-colors"
            aria-expanded={developmentAnalysisOpen}
          >
            <div>
              <p className="text-xs uppercase tracking-[0.2em] font-semibold text-sky-700">Teacher view</p>
              <h3 className="mt-1 text-lg font-semibold">Historical Development Analysis</h3>
            </div>
            <span className="text-sm font-medium text-sky-700">{developmentAnalysisOpen ? "Hide" : "Open"}</span>
          </button>
          {developmentAnalysisOpen && (
            <div className="border-t border-sky-100 px-8 py-5">
              {developmentAnalysisLoading ? (
                <p className="text-sm text-neutral-500">Loading preserved development summary…</p>
              ) : developmentAnalysis?.error ? (
                <p className="text-sm text-red-700">{developmentAnalysis.error}</p>
              ) : (
                  <div className="space-y-6">
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                      <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Common changed stages</p>
                        <div className="mt-2 text-sm text-neutral-900">
                          {developmentAnalysis?.commonChangedStages?.length
                            ? developmentAnalysis.commonChangedStages.map((cs: any, i: number) => {
                                const label = cs.stage === "RESEARCH"
                                  ? "Research Log"
                                  : cs.stage === "EMBED" || cs.stage === "ANSWER"
                                    ? "Final Answer"
                                    : cs.stage || cs.label || "Stage";
                                return (
                                  <div key={i}>
                                    {label}: {cs.count ?? 0}
                                    {typeof cs.proportion === "number" ? ` (${Math.round(cs.proportion * 100)}%)` : ""}
                                  </div>
                                );
                              })
                            : "None"}
                        </div>
                      </div>
                      <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Source changes</p>
                        <p className="mt-2 text-sm font-semibold text-neutral-900">
                           {developmentAnalysis?.sourceChanges?.added || 0} added<br/>{developmentAnalysis?.sourceChanges?.removed || 0} removed<br/>{developmentAnalysis?.sourceChanges?.edited || 0} edited
                        </p>
                      </div>
                      <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">TORCH interactions</p>
                        <p className="mt-2 text-xl font-semibold text-neutral-900">{developmentAnalysis?.torchInteractionsAdded || 0} added</p>
                      </div>
                      <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Climb comparisons</p>
                        <div className="mt-2 text-sm font-semibold text-neutral-900">
                          <div>
                            Comparable: {developmentAnalysis?.comparisons?.comparableStudents ?? 0}
                            {typeof developmentAnalysis?.comparisons?.comparableProportion === "number"
                              ? ` (${Math.round(developmentAnalysis.comparisons.comparableProportion * 100)}%)`
                              : ""}
                          </div>
                          <div>
                            Changed: {developmentAnalysis?.comparisons?.changedStudents ?? 0}
                            {typeof developmentAnalysis?.comparisons?.changedProportion === "number"
                              ? ` (${Math.round(developmentAnalysis.comparisons.changedProportion * 100)}%)`
                              : ""}
                          </div>
                        </div>
                      </div>
                      <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Answers changed after</p>
                        <div className="mt-2 text-sm font-semibold text-neutral-900">
                          <div>
                            AI feedback one: {developmentAnalysis?.answers?.changedAfterFeedbackOne ?? 0}
                            {typeof developmentAnalysis?.answers?.changedAfterFeedbackOneProportion === "number"
                              ? ` (${Math.round(developmentAnalysis.answers.changedAfterFeedbackOneProportion * 100)}%)`
                              : ""}
                          </div>
                          <div>
                            AI feedback two: {developmentAnalysis?.answers?.changedAfterFeedbackTwo ?? 0}
                            {typeof developmentAnalysis?.answers?.changedAfterFeedbackTwoProportion === "number"
                              ? ` (${Math.round(developmentAnalysis.answers.changedAfterFeedbackTwoProportion * 100)}%)`
                              : ""}
                          </div>
                        </div>
                      </div>
                    </div>

                    {developmentAnalysis?.statusCounts ? (
                      <div>
                        <h4 className="text-xs font-bold uppercase tracking-widest text-neutral-500 mb-3">Feedback Response Statuses</h4>
                          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-7">
                          {[
                            ["Acted upon", developmentAnalysis.statusCounts["Acted upon"] ?? 0, "border-emerald-200 bg-emerald-50 text-emerald-800"],
                            ["Partly acted upon", developmentAnalysis.statusCounts["Partly acted upon"] ?? 0, "border-amber-200 bg-amber-50 text-amber-800"],
                            ["No related change found", developmentAnalysis.statusCounts["No related change found"] ?? 0, "border-neutral-200 bg-neutral-50 text-neutral-700"],
                            ["Not enough evidence", developmentAnalysis.statusCounts["Not enough evidence"] ?? 0, "border-neutral-200 bg-neutral-50 text-neutral-700"],
                            ["Teacher review needed", developmentAnalysis.statusCounts["Teacher review needed"] ?? 0, "border-violet-200 bg-violet-50 text-violet-800"],
                            ["No action requested", developmentAnalysis.statusCounts["No action requested"] ?? 0, "border-sky-200 bg-sky-50 text-sky-800"],
                            ["Not analysed", developmentAnalysis.statusCounts["Not analysed"] ?? 0, "border-sky-200 bg-sky-50 text-sky-800"]
                          ].map(([label, value, classes]) => (
                            <div key={label as string} className={`rounded-xl border p-4 ${classes}`}>
                              <p className="text-[11px] font-semibold uppercase tracking-wider opacity-80">{label as string}</p>
                              <p className="mt-2 text-xl font-semibold">{value as number}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div>
                        <h4 className="text-xs font-bold uppercase tracking-widest text-neutral-500 mb-3">Feedback Response Statuses</h4>
                        <p className="text-sm text-neutral-500 italic">Unavailable</p>
                      </div>
                    )}

                    {developmentAnalysis?.commonAnswerPatterns && developmentAnalysis.commonAnswerPatterns.length > 0 ? (
                      <div>
                        <h4 className="text-xs font-bold uppercase tracking-widest text-sky-800 mb-3">Common Answer Patterns</h4>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                          {developmentAnalysis.commonAnswerPatterns.map((p: any, i: number) => (
                            <div key={i} className="bg-sky-50 p-4 rounded-xl border border-sky-200">
                              <p className="text-sm font-semibold text-sky-900 mb-1">{p.label || p.pattern}</p>
                              <p className="text-sm text-sky-800/80">{p.count} student{p.count !== 1 && "s"}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div>
                        <h4 className="text-xs font-bold uppercase tracking-widest text-sky-800 mb-3">Common Answer Patterns</h4>
                        <p className="text-sm text-neutral-500 italic">None</p>
                      </div>
                    )}

                    {developmentAnalysis?.missingEvidence && Object.keys(developmentAnalysis.missingEvidence).length > 0 ? (
                      <div>
                        <h4 className="text-xs font-bold uppercase tracking-widest text-amber-800 mb-3">Missing Evidence</h4>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                          {Object.entries(developmentAnalysis.missingEvidence).map(([category, count]: [string, any], i: number) => (
                            <div key={i} className="bg-amber-50 p-4 rounded-xl border border-amber-200">
                              <p className="text-sm font-semibold text-amber-900 mb-1">{category}</p>
                              <p className="text-sm text-amber-800/80">{String(count)} student{count !== 1 && "s"}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div>
                        <h4 className="text-xs font-bold uppercase tracking-widest text-amber-800 mb-3">Missing Evidence</h4>
                        <p className="text-sm text-neutral-500 italic">None</p>
                      </div>
                    )}

                    {developmentAnalysis?.teacherReview && developmentAnalysis.teacherReview.length > 0 ? (
                      <div>
                        <h4 className="text-xs font-bold uppercase tracking-widest text-violet-800 mb-3">Teacher Review Needed</h4>
                        <div className="bg-violet-50 rounded-xl border border-violet-200 divide-y divide-violet-200/50">
                          {developmentAnalysis.teacherReview.map((item: any, i: number) => {
                            const desc = item.reason || item.description || "Review needed";
                            return (
                              <div key={i} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                                <div>
                                  <p className="text-sm font-semibold text-violet-900">{item.studentName || `Student`}</p>
                                  <p className="text-xs text-violet-800 mt-0.5">{String(desc)}</p>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ) : (
                      <div>
                        <h4 className="text-xs font-bold uppercase tracking-widest text-violet-800 mb-3">Teacher Review Needed</h4>
                        <p className="text-sm text-neutral-500 italic">None</p>
                      </div>
                    )}
                  </div>
              )}
              <p className="mt-4 text-xs text-neutral-500">Aggregate counts only; no student payloads, AI calls, scoring, ranking, or attainment claims.</p>
            </div>
          )}
        </section>

        {/* Student roster */}
        <div className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
          <div className="border-b border-neutral-200 px-8 py-6 flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
            <h3 className="text-xl font-semibold tracking-tight">Students</h3>

            <div className="flex flex-col sm:flex-row gap-3 w-full md:w-auto">
              <input
                type="text"
                placeholder="Search students..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="rounded-xl border border-neutral-200 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
              />
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                className="rounded-xl border border-neutral-200 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/10 bg-white"
              >
                <option value="all">All Statuses</option>
                <option value="pending">Pending Approval</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="locked">Assessment Locked</option>
                <option value="archived">Archived</option>
              </select>
            </div>
          </div>

           {studentsNeedingAttention.length > 0 && (
             <div
               className="border-b border-amber-200 bg-amber-50 px-6 py-4 sm:px-8"
               data-testid="students-needing-attention"
             >
               <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                 <div>
                   <p className="text-sm font-semibold text-amber-950">
                     {studentsNeedingAttention.length} student{studentsNeedingAttention.length === 1 ? "" : "s"} need attention
                   </p>
                   <p className="mt-1 text-xs text-amber-900/75">
                     These students have not started or have completed two or fewer sections.
                   </p>
                 </div>
                 <div className="flex flex-wrap gap-2 sm:justify-end">
                   {studentsNeedingAttention.map((student: any) => (
                     <Link
                       key={student.id}
                       href={`/teacher/class/${classId}/student/${student.id}`}
                       className="rounded-full border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-950 hover:border-amber-500"
                       data-testid={`attention-student-${student.id}`}
                     >
                       {student.studentName}
                     </Link>
                   ))}
                 </div>
               </div>
             </div>
           )}

          {students.length === 0 ? (
            <div className="p-12 text-center text-neutral-500">
              No students have joined yet. Share the class code with your class.
            </div>
          ) : (
            <div>
              {selectedSessionIds.length > 0 && (
                <div className="px-6 py-3 bg-neutral-900 text-white flex items-center justify-between">
                  <span className="text-sm font-medium">{selectedSessionIds.length} pending registrations selected</span>
                  <div className="flex gap-2">
                    <button onClick={() => handleBulkReview("approve")} disabled={bulkReview.isPending} className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors disabled:opacity-50">Approve Selected</button>
                    <button onClick={() => handleBulkReview("reject")} disabled={bulkReview.isPending} className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-semibold transition-colors disabled:opacity-50">Reject Selected</button>
                  </div>
                </div>
              )}

              <div>
              <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3 bg-neutral-50 border-b border-neutral-100">
                <label className="inline-flex items-center gap-3 text-sm text-neutral-600">
                  <input
                    type="checkbox"
                    aria-label="Select all pending registrations"
                    checked={selectableStudents.length > 0 && selectableStudents.every((student) => selectedSessionIds.includes(student.id))}
                    disabled={selectableStudents.length === 0}
                    onChange={(e) => {
                      if (e.target.checked) setSelectedSessionIds(selectableStudents.map((student) => student.id));
                      else setSelectedSessionIds([]);
                    }}
                    className="w-4 h-4 rounded border-neutral-300 text-black focus:ring-black"
                  />
                  Select all pending registrations
                </label>
                <span className="text-xs font-medium text-neutral-400">
                  {filteredStudents.length} {filteredStudents.length === 1 ? "student" : "students"}
                </span>
              </div>

              {filteredStudents.length === 0 ? (
                <div className="p-8 text-center text-sm text-neutral-500 italic">No students match your search/filters.</div>
              ) : (
                <div className="divide-y divide-neutral-100">
                  {filteredStudents.map((student: any) => {
                    const qtCounts = studentQuestionTypes[student.id] ?? {};
                    const qtTotal = Object.values(qtCounts).reduce((a: number, b: number) => a + b, 0);
                    const questionTypesWithCounts = QUESTION_TYPES.filter((type) => (qtCounts[type] ?? 0) > 0);
                    const primaryQuestionType = questionTypesWithCounts.reduce<string | null>(
                      (current, type) => !current || (qtCounts[type] ?? 0) > (qtCounts[current] ?? 0) ? type : current,
                      null,
                    );
                    const QT_BG: Record<string, string> = {
                      Factual: "bg-blue-400", Conceptual: "bg-sky-400", Analytical: "bg-amber-400",
                      Evaluative: "bg-orange-400", Creative: "bg-violet-400",
                      "Help/Clarify": "bg-neutral-300", Other: "bg-neutral-200",
                    };
                    return (
                      <div
                        key={student.id}
                        className="px-5 py-5 sm:px-6 hover:bg-neutral-50/70 transition-colors"
                        data-testid={`row-student-${student.id}`}
                      >
                        <div className="flex items-start gap-3">
                        <div className="flex w-5 shrink-0 items-center pt-1">
                          {student.registrationStatus === "pending" && (
                            <input
                              type="checkbox"
                              aria-label={`Select pending registration for ${student.studentName}`}
                              checked={selectedSessionIds.includes(student.id)}
                              onChange={(e) => {
                                if (e.target.checked) setSelectedSessionIds(prev => [...prev, student.id]);
                                else setSelectedSessionIds(prev => prev.filter(id => id !== student.id));
                              }}
                              className="w-4 h-4 rounded border-neutral-300 text-black focus:ring-black"
                            />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="font-semibold text-neutral-900 break-words">{student.studentName}</p>
                                {student.registrationStatus === "pending" && (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 text-xs font-medium">Awaiting approval</span>
                                )}
                                {student.registrationStatus === "rejected" && (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-red-50 border border-red-200 text-red-700 text-xs font-medium">Registration rejected</span>
                                )}
                                {student.pinLockedUntil && new Date(student.pinLockedUntil) > new Date() && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-50 border border-red-200 text-red-600 text-xs font-medium">
                                    PIN locked
                                  </span>
                                )}
                                {student.lockedAt && (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-violet-50 border border-violet-200 text-violet-700 text-xs font-medium">
                                    {student.archivedAt
                                      ? `Archived · read only${student.retentionUntil ? ` until ${new Date(student.retentionUntil).toLocaleDateString()}` : ""}`
                                      : student.isFinalised ? "Climb complete" : "Work locked"}
                                  </span>
                                )}
                                 {student.needsAttention && (
                                   <span
                                     className="inline-flex items-center gap-1 rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-xs font-medium text-amber-800"
                                     title={student.attentionReason ?? "Teaching attention needed"}
                                     data-testid={`student-attention-${student.id}`}
                                   >
                                     Needs attention
                                   </span>
                                 )}
                              </div>
                              <p className="mt-1 text-xs text-neutral-400">Joined {new Date(student.createdAt).toLocaleDateString()}</p>
                            </div>

                            <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                              {cls.archivedAt ? (
                                <>
                                  <Link
                                    href={`/teacher/class/${classId}/student/${student.id}`}
                                    className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700"
                                    data-testid={`button-view-student-${student.id}`}
                                  >
                                    View Work
                                  </Link>
                                  <span className="text-xs font-medium text-amber-800">Class read-only</span>
                                </>
                              ) : student.registrationStatus === "pending" ? (
                                <>
                                  <button
                                    onClick={() => handleRegistrationDecision(student, "approve")}
                                    disabled={reviewingRegistration === student.id}
                                    className="rounded-xl bg-emerald-600 text-white px-3 py-2 text-xs font-medium hover:bg-emerald-700 disabled:opacity-50"
                                  >
                                    {reviewingRegistration === student.id ? "Saving…" : "Approve"}
                                  </button>
                                  <button
                                    onClick={() => handleRegistrationDecision(student, "reject")}
                                    disabled={reviewingRegistration === student.id}
                                    className="rounded-xl border border-red-200 text-red-700 px-3 py-2 text-xs hover:bg-red-50 disabled:opacity-50"
                                  >
                                    Reject
                                  </button>
                                </>
                              ) : student.registrationStatus === "rejected" ? (
                                <button
                                  onClick={() => handleDeleteRejectedRegistration(student)}
                                  disabled={reviewingRegistration === student.id}
                                  className="rounded-xl border border-red-200 text-red-700 px-3 py-2 text-xs hover:bg-red-50 disabled:opacity-50"
                                >
                                  {reviewingRegistration === student.id ? "Removing…" : "Remove registration"}
                                </button>
                              ) : (
                                <>
                                   {!student.archivedAt && (
                                     <button
                                        onClick={() => void openTeacherMessagePanel(student)}
                                       className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 transition-colors hover:bg-emerald-100"
                                       data-testid={`button-message-student-${student.id}`}
                                     >
                                        Message
                                        {student.unreadStudentMessageCount > 0 && (
                                          <span className="ml-1 inline-flex min-w-5 items-center justify-center rounded-full bg-emerald-600 px-1.5 py-0.5 text-[11px] font-bold text-white" aria-label={`${student.unreadStudentMessageCount} unread student replies`}>
                                            {student.unreadStudentMessageCount}
                                          </span>
                                        )}
                                     </button>
                                   )}
                                  <Link
                                    href={`/teacher/class/${classId}/student/${student.id}`}
                                    className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700"
                                    data-testid={`button-view-student-${student.id}`}
                                  >
                                    View Work
                                  </Link>
                                  <details className="relative">
                                    <summary
                                      aria-label={`More actions for ${student.studentName}`}
                                      className="list-none cursor-pointer rounded-xl border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100 [&::-webkit-details-marker]:hidden"
                                    >
                                      More <span aria-hidden="true">⌄</span>
                                    </summary>
                                    <div className="absolute right-0 z-30 mt-2 w-48 rounded-xl border border-neutral-200 bg-white p-2 shadow-xl">
                                      {student.pinLockedUntil && new Date(student.pinLockedUntil) > new Date() && (
                                        <button
                                          onClick={() => handleUnlockPin(student.id, student.studentName)}
                                          disabled={unlockingPin === student.id}
                                          className="w-full rounded-lg px-3 py-2 text-left text-sm text-amber-700 hover:bg-amber-50 transition-colors disabled:opacity-50"
                                        >
                                          {unlockingPin === student.id ? "Unlocking…" : "Unlock PIN"}
                                        </button>
                                      )}
                                      {!student.archivedAt && !student.lockedAt && (
                                        <button
                                          onClick={() => handleWorkLock(student)}
                                          disabled={updatingWorkLock === student.id}
                                          className="w-full rounded-lg px-3 py-2 text-left text-sm text-violet-700 hover:bg-violet-50 transition-colors disabled:opacity-50"
                                        >
                                          {updatingWorkLock === student.id ? "Locking…" : "Lock work"}
                                        </button>
                                      )}
                                      {!student.archivedAt && student.lockedAt && !student.isFinalised && (
                                        <button
                                          onClick={() => handleWorkLock(student)}
                                          disabled={updatingWorkLock === student.id}
                                          className="w-full rounded-lg px-3 py-2 text-left text-sm text-violet-700 hover:bg-violet-50 transition-colors disabled:opacity-50"
                                        >
                                          {updatingWorkLock === student.id ? "Unlocking…" : "Unlock work"}
                                        </button>
                                      )}
                                      {!student.archivedAt && (
                                        <button
                                          onClick={() => handleArchiveStudent(student.id, student.studentName)}
                                          disabled={archivingStudent === student.id}
                                          className="w-full rounded-lg px-3 py-2 text-left text-sm text-amber-700 hover:bg-amber-50 transition-colors disabled:opacity-50"
                                        >
                                          {archivingStudent === student.id ? "Archiving…" : "Archive record"}
                                        </button>
                                      )}
                                      {!student.archivedAt && (
                                        <button
                                          onClick={() => handleDeleteStudent(student.id, student.studentName)}
                                          disabled={deletingStudent === student.id}
                                          className="mt-1 w-full rounded-lg border-t border-neutral-100 px-3 py-2 text-left text-sm text-red-700 hover:bg-red-50 transition-colors disabled:opacity-50"
                                        >
                                          {deletingStudent === student.id ? "Scheduling…" : "Delete record"}
                                        </button>
                                      )}
                                    </div>
                                  </details>
                                </>
                              )}
                            </div>
                          </div>

                          <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(230px,0.8fr)]">
                            <div>
                              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Progress</p>
                              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                                {ALL_STAGES.map((stage) => {
                                  const status = getStageStatus(student, stage);
                                  const statusMeta = STAGE_STATUS_META[status];
                                  return (
                                    <Link
                                      key={stage}
                                      href={`/teacher/class/${classId}/student/${student.id}?stage=${stage}`}
                                      data-testid={`student-progress-${student.id}-${stage}`}
                                      data-stage={stage}
                                      aria-label={`View ${student.studentName}'s ${STAGE_LABEL[stage]} work, ${statusMeta.label}`}
                                      className={`min-w-0 rounded-xl border px-3 py-2.5 transition-all hover:-translate-y-0.5 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 ${STAGE_PROGRESS_CARD[stage]}`}
                                    >
                                      <div className="flex items-center gap-2">
                                        <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${statusMeta.symbolClassName}`} aria-hidden="true">
                                          {statusMeta.symbol}
                                        </span>
                                        <span className="truncate text-[11px] font-semibold uppercase tracking-wide">{STAGE_LABEL[stage]}</span>
                                      </div>
                                      <p className="mt-1.5 text-xs font-medium">{statusMeta.label}</p>
                                      {student.stageCompletionWarnings?.[stage] && (
                                        <p className="mt-1 text-[11px] font-semibold text-amber-700">Sections missing</p>
                                      )}
                                      {student.formativeFeedbackActionedStages?.includes(stage) && (
                                        <p className="mt-1 text-[11px] font-medium text-emerald-700">Feedback actioned ✓</p>
                                      )}
                                    </Link>
                                  );
                                })}
                              </div>
                            </div>

                            <div>
                              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Question insight</p>
                              {qtTotal > 0 ? (
                                <details className="group rounded-xl border border-neutral-200 bg-white">
                                  <summary className="list-none cursor-pointer px-4 py-3 [&::-webkit-details-marker]:hidden">
                                    <div className="flex items-center justify-between gap-3">
                                      <div className="min-w-0">
                                        <p className="text-sm font-semibold text-neutral-800">{qtTotal} AI {qtTotal === 1 ? "question" : "questions"}</p>
                                        <p className="mt-0.5 truncate text-xs text-neutral-500">
                                          Mostly {primaryQuestionType ?? "Other"}
                                        </p>
                                      </div>
                                      <span className="text-xs font-medium text-neutral-500 group-open:hidden">View</span>
                                      <span className="hidden text-xs font-medium text-neutral-500 group-open:inline">Hide</span>
                                    </div>
                                  </summary>
                                  <div className="border-t border-neutral-100 px-4 py-3">
                                    <div className="flex h-2 rounded-full overflow-hidden gap-px" aria-hidden="true">
                                      {questionTypesWithCounts.map((type) => {
                                        const pct = Math.round(((qtCounts[type] ?? 0) / qtTotal) * 100);
                                        return <div key={type} className={QT_BG[type]} style={{ width: `${pct}%` }} />;
                                      })}
                                    </div>
                                    <TooltipProvider>
                                    <div className="mt-3 flex flex-wrap gap-1.5">
                                      {questionTypesWithCounts.map((type) => {
                                        const count = qtCounts[type] ?? 0;
                                        const pct = Math.round((count / qtTotal) * 100);
                                        const msgs = (studentMessages[student.id] ?? []).filter((q) => classifyQuestion(q) === type);
                                        return (
                                          <Tooltip key={type}>
                                            <TooltipTrigger asChild>
                                              <span
                                                className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-semibold border cursor-default ${QUESTION_TYPE_META[type].color}`}
                                                aria-label={`${type}: ${count} questions, ${pct}%`}
                                              >
                                                {type} {count} · {pct}%
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
                                </details>
                              ) : (
                                <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3">
                                  <p className="text-sm font-medium text-neutral-500">No AI chat yet</p>
                                  <p className="mt-0.5 text-xs text-neutral-400">Question insights will appear here.</p>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              </div>
          </div>
        )}
        {messageStudent && (
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="teacher-message-title"
            onClick={() => { if (!messageSending) setMessageStudent(null); }}
          >
            <form
              className="w-full max-w-md rounded-[2rem] bg-white p-6 shadow-xl"
              onSubmit={handleSendTeacherMessage}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                   <h2 id="teacher-message-title" className="text-xl font-semibold text-neutral-900">Messages with {messageStudent.name}</h2>
                   <p className="mt-1 text-sm text-neutral-500">Messages for this Climb.</p>
                </div>
                <button type="button" onClick={() => setMessageStudent(null)} disabled={messageSending} className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-100" aria-label="Close message dialog">×</button>
              </div>
               {messageLoading ? (
                 <p className="mt-6 text-sm text-neutral-500">Loading messages…</p>
               ) : (
                 <div className="mt-5 max-h-72 space-y-3 overflow-y-auto rounded-xl bg-neutral-50 p-3">
                   {messageError && !messageConversation.length ? (
                     <p className="text-sm text-red-600" role="alert">{messageError}</p>
                   ) : messageConversation.length === 0 ? (
                     <p className="p-3 text-center text-sm text-neutral-500">No messages yet.</p>
                   ) : messageConversation.map((message: any) => (
                     <article key={message.id} className={`rounded-xl border p-3 ${message.senderType === "teacher" ? "ml-8 border-emerald-100 bg-emerald-50" : "mr-8 border-neutral-200 bg-white"}`}>
                       <p className="text-xs font-semibold text-neutral-500">{message.senderType === "teacher" ? "You" : "Student"}</p>
                       <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-neutral-800">{message.content}</p>
                       <time className="mt-2 block text-[11px] text-neutral-500" dateTime={message.createdAt}>
                         {new Date(message.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
                       </time>
                     </article>
                   ))}
                 </div>
               )}
               <label className="mt-5 block text-sm font-medium text-neutral-700" htmlFor="teacher-message-content">Reply</label>
              <textarea
                id="teacher-message-content"
                value={messageDraft}
                maxLength={500}
                onChange={(event) => setMessageDraft(event.target.value)}
                className="mt-2 min-h-32 w-full resize-y rounded-xl border border-neutral-300 px-3 py-2.5 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
                autoFocus
              />
              <div className="mt-1 flex justify-between text-xs text-neutral-500">
                 <span>{messageError && <span className="text-red-600" role="alert">{messageError}</span>}</span>
                <span>{messageDraft.length}/500</span>
              </div>
              <div className="mt-5 flex justify-end gap-3">
                <button type="button" onClick={() => setMessageStudent(null)} disabled={messageSending} className="rounded-xl border border-neutral-300 px-4 py-2.5 text-sm font-medium hover:bg-neutral-50">Cancel</button>
                 <button type="submit" disabled={messageSending || messageLoading || !messageDraft.trim()} className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
                  {messageSending ? "Sending…" : "Send"}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </main>
    </div>
  );
}
