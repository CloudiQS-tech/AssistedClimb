import { useState, useEffect, useRef, useCallback } from "react";
import { classifyMessages, QUESTION_TYPE_META, QUESTION_TYPES } from "@/lib/question-classifier";
import { useLocation } from "wouter";
import { apiFetch, clearStudentSession } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
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

const STAGES = ["MAP", "TORCH", "COMPASS", "EMBED", "RESEARCH"] as const;
type Stage = (typeof STAGES)[number];

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
  EMBED: "Final response",
};

const STAGE_DISPLAY: Record<Stage, string> = {
  MAP: "MAP",
  TORCH: "TORCH",
  RESEARCH: "RESEARCH",
  COMPASS: "COMPASS",
  EMBED: "ANSWER",
};

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

type ResearchEntry = {
  id: string;
  source: string;
  findings: string;
  importantPoints: string;
  reliability: string;
  usage: string;
};

function emptyEntry(): ResearchEntry {
  return { id: Date.now().toString(), source: "", findings: "", importantPoints: "", reliability: "", usage: "" };
}

type MapPlanRow = { id: string; investigation: string; sources: string[]; verification: string };
type MapAnswers = {
  taskUnderstanding: string;
  priorKnowledge: string[];
  knowledgeGaps: string[];
  enquiryQuestions: string[];
  researchPlan: MapPlanRow[];
  notes: string;
};
const DEFAULT_MAP_ANSWERS: MapAnswers = {
  taskUnderstanding: "",
  priorKnowledge: [""],
  knowledgeGaps: [""],
  enquiryQuestions: ["", "", "", "", ""],
  researchPlan: [{ id: "1", investigation: "", sources: [], verification: "" }],
  notes: "",
};
function migrateMapAnswers(raw: any): MapAnswers {
  if (!raw || typeof raw !== "object") return DEFAULT_MAP_ANSWERS;
  if ("taskUnderstanding" in raw) {
    return {
      taskUnderstanding: raw.taskUnderstanding ?? "",
      priorKnowledge: Array.isArray(raw.priorKnowledge) && raw.priorKnowledge.length ? raw.priorKnowledge : [""],
      knowledgeGaps: Array.isArray(raw.knowledgeGaps) && raw.knowledgeGaps.length ? raw.knowledgeGaps : [""],
      enquiryQuestions: Array.isArray(raw.enquiryQuestions) && raw.enquiryQuestions.length ? raw.enquiryQuestions : ["", "", "", "", ""],
      researchPlan: Array.isArray(raw.researchPlan) && raw.researchPlan.length ? raw.researchPlan : [{ id: "1", investigation: "", sources: [], verification: "" }],
      notes: raw.notes ?? "",
    };
  }
  return {
    taskUnderstanding: raw.q1 ?? "",
    priorKnowledge: raw.q2 ? [raw.q2] : [""],
    knowledgeGaps: raw.q3 ? [raw.q3] : [""],
    enquiryQuestions: raw.q4 ? raw.q4.split(/\n/).map((s: string) => s.trim()).filter(Boolean) : ["", "", "", "", ""],
    researchPlan: [{ id: "legacy", investigation: raw.q5 ?? "", sources: [], verification: "" }],
    notes: "",
  };
}

function csvCell(val: string) {
  const escaped = val.replace(/"/g, '""');
  return `"${escaped}"`;
}

function buildResearchCsv(entries: ResearchEntry[], startIdx = 0): string {
  const header = ["#", "Source", "What did you find", "Important points", "Reliability", "How will you use this"];
  const rows = entries.map((e, i) => [
    String(startIdx + i + 1),
    e.source,
    e.findings,
    e.importantPoints,
    e.reliability,
    e.usage,
  ].map(csvCell).join(","));
  return [header.map(csvCell).join(","), ...rows].join("\r\n");
}

function triggerCsvDownload(csv: string, filename: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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

function TeacherFeedbackBanner({
  stage,
  feedback,
  onAcknowledge,
}: {
  stage: string;
  feedback: { formativeComment: string; comment: string; grade: string | null; studentAcknowledged: boolean } | undefined;
  onAcknowledge?: () => void;
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
            <button
              onClick={onAcknowledge}
              className="text-xs font-medium text-neutral-600 hover:text-black border border-neutral-200 hover:border-neutral-400 rounded-xl px-3 py-1.5 transition-colors bg-white"
            >
              Mark as actioned
            </button>
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
  const [activeStage, setActiveStage] = useState<Stage>("MAP");
  const [completedStages, setCompletedStages] = useState<Set<Stage>>(new Set());
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [showOverview, setShowOverview] = useState(false);
  const [showTaskModal, setShowTaskModal] = useState(false);
  const [task, setTask] = useState<any>(null);
  const [enabledStages, setEnabledStages] = useState<string[]>(["MAP", "TORCH", "COMPASS", "EMBED", "RESEARCH"]);

  const [stageToReset, setStageToReset] = useState<Stage | null>(null);
  const [isResetting, setIsResetting] = useState(false);

  const [mapAnswers, setMapAnswers] = useState<MapAnswers>(DEFAULT_MAP_ANSWERS);
  const [mapShowSummary, setMapShowSummary] = useState(false);
  const [researchEntries, setResearchEntries] = useState<ResearchEntry[]>([emptyEntry()]);
  const [collapsedEntries, setCollapsedEntries] = useState<Set<string>>(new Set());
  const [compassAnswers, setCompassAnswers] = useState({ check1: "", check2: "", check3: "", check4: "", check5: "", sl1: false, sl2: false, sl3: false, sl4: false, sl5: false });
  const [embedAnswers, setEmbedAnswers] = useState({ finalAnswer: "", q1: "", q2: "", q3: "", q4: "" });
  const [answerFeedback, setAnswerFeedback] = useState<string | null>(null);
  const [answerFeedbackLoading, setAnswerFeedbackLoading] = useState(false);
  const [answerFeedbackCount, setAnswerFeedbackCount] = useState(0);
  const ANSWER_FEEDBACK_LIMIT = 2;
  const [selectedBloomLevel, setSelectedBloomLevel] = useState<number | null>(null);
  const [torchSuggestions, setTorchSuggestions] = useState<Record<string, string[]>>({});
  const [torchThinkingNotes, setTorchThinkingNotes] = useState<string[]>([]);
  const [showAllSuggestions, setShowAllSuggestions] = useState(false);
  const [askedMapQuestions, setAskedMapQuestions] = useState<Set<number>>(new Set());
  const [askedSuggestions, setAskedSuggestions] = useState<Set<string>>(new Set());
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const [studentFeedback, setStudentFeedback] = useState<Record<string, { formativeComment: string; comment: string; grade: string | null; studentAcknowledged: boolean }>>({});

  useEffect(() => {
    apiFetch("/student/session")
      .then((data) => setSession(data))
      .catch(() => setLocation("/join"));

    apiFetch("/student/stages").then((data: any[]) => {
      const map = data.find((d) => d.stage === "MAP");
      if (map?.contentJson) setMapAnswers(migrateMapAnswers(map.contentJson));

      const research = data.find((d) => d.stage === "RESEARCH");
      if (research?.contentJson?.entries?.length) setResearchEntries(research.contentJson.entries);

      const compass = data.find((d) => d.stage === "COMPASS");
      if (compass?.contentJson) setCompassAnswers(compass.contentJson);

      const embed = data.find((d) => d.stage === "EMBED");
      if (embed?.contentJson) setEmbedAnswers(embed.contentJson);

      const furthest = deriveFurthestStage(data);
      setActiveStage(furthest);
      setCompletedStages(new Set(data.map((d) => d.stage as Stage)));
    }).catch(() => {});

    apiFetch("/student/task").then((data: any) => {
      setTask(data);
      if (Array.isArray(data?.enabledStages) && data.enabledStages.length > 0) {
        setEnabledStages(data.enabledStages);
      }
    }).catch(() => {});
    apiFetch("/student/feedback").then((fb: any) => { if (fb && typeof fb === "object") setStudentFeedback(fb); }).catch(() => {});

    apiFetch("/student/torch-suggestions").then((data: any) => {
      if (data && typeof data === "object") {
        if (data.suggestions) {
          setTorchSuggestions(data.suggestions);
          setTorchThinkingNotes(Array.isArray(data.thinkingNotes) ? data.thinkingNotes : []);
        } else {
          setTorchSuggestions(data);
        }
      }
    }).catch(() => {});

    apiFetch("/student/chat").then((msgs: any[]) => {
      if (Array.isArray(msgs)) {
        setChatMessages(msgs.map((m) => ({
          role: m.role === "assistant" ? "ai" : m.role,
          content: m.content,
        })));
      }
    }).catch(() => {});
  }, [setLocation]);

  const mapAnswersRef = useRef(mapAnswers);
  const researchEntriesRef = useRef(researchEntries);
  const compassAnswersRef = useRef(compassAnswers);
  const embedAnswersRef = useRef(embedAnswers);

  useEffect(() => { mapAnswersRef.current = mapAnswers; }, [mapAnswers]);
  useEffect(() => { researchEntriesRef.current = researchEntries; }, [researchEntries]);
  useEffect(() => { compassAnswersRef.current = compassAnswers; }, [compassAnswers]);
  useEffect(() => { embedAnswersRef.current = embedAnswers; }, [embedAnswers]);

  const saveMap = useCallback(() => {
    apiFetch("/student/stages/MAP", { method: "PUT", body: JSON.stringify({ contentJson: mapAnswersRef.current }) })
      .then(() => setCompletedStages((prev) => new Set([...prev, "MAP"])))
      .catch(() => {});
  }, []);
  const saveResearch = useCallback(() => {
    apiFetch("/student/stages/RESEARCH", { method: "PUT", body: JSON.stringify({ contentJson: { entries: researchEntriesRef.current } }) }).catch(() => {});
  }, []);
  const saveCompass = useCallback(() => {
    apiFetch("/student/stages/COMPASS", { method: "PUT", body: JSON.stringify({ contentJson: compassAnswersRef.current }) })
      .then(() => setCompletedStages((prev) => new Set([...prev, "COMPASS"])))
      .catch(() => {});
  }, []);
  const saveEmbed = useCallback(() => {
    apiFetch("/student/stages/EMBED", { method: "PUT", body: JSON.stringify({ contentJson: embedAnswersRef.current }) })
      .then(() => setCompletedStages((prev) => new Set([...prev, "EMBED"])))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const timer = setTimeout(saveMap, 1500);
    return () => clearTimeout(timer);
  }, [mapAnswers, saveMap]);

  useEffect(() => {
    const timer = setTimeout(saveResearch, 1500);
    return () => clearTimeout(timer);
  }, [researchEntries, saveResearch]);

  useEffect(() => {
    const timer = setTimeout(saveCompass, 1500);
    return () => clearTimeout(timer);
  }, [compassAnswers, saveCompass]);

  useEffect(() => {
    const timer = setTimeout(saveEmbed, 1500);
    return () => clearTimeout(timer);
  }, [embedAnswers, saveEmbed]);

  const handleSignOut = async () => {
    try { await apiFetch("/student/logout", { method: "POST" }); } catch {}
    clearStudentSession();
    setLocation("/join");
  };

  const [showPinModal, setShowPinModal] = useState(false);
  const [pinForm, setPinForm] = useState({ current: "", next: "", confirm: "" });
  const [pinLoading, setPinLoading] = useState(false);
  const [pinSuccess, setPinSuccess] = useState(false);
  const [pinError, setPinError] = useState("");

  const handleChangePin = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinError("");
    if (pinForm.next !== pinForm.confirm) { setPinError("New PINs don't match"); return; }
    if (!/^\d{4}$/.test(pinForm.next)) { setPinError("PIN must be exactly 4 digits"); return; }
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

  const goNext = () => {
    const idx = activeEnabled.indexOf(activeStage);
    if (idx < activeEnabled.length - 1) setActiveStage(activeEnabled[idx + 1]);
    setShowOverview(false);
  };

  const goPrev = () => {
    const idx = activeEnabled.indexOf(activeStage);
    if (idx > 0) setActiveStage(activeEnabled[idx - 1]);
    setShowOverview(false);
  };

  const handleInvestigate = async () => {
    if (!chatInput.trim() || isChatLoading) return;
    const msg = chatInput.trim();
    setChatInput("");
    setIsChatLoading(true);
    const tempUserMsg = { role: "user", content: msg };
    setChatMessages((prev) => [...prev, tempUserMsg]);

    try {
      const response = await apiFetch("/student/chat", {
        method: "POST",
        body: JSON.stringify({
          message: msg,
          bloomLevel: selectedBloomLevel !== null ? bloomLevels[selectedBloomLevel].label : undefined,
          history: chatMessages.map((m) => ({
            role: m.role === "ai" ? "assistant" : m.role,
            content: m.content,
          })),
        }),
      });

      let content = response.content;
      let reflectionPrompt: string | undefined;
      const refIdx = content.indexOf("Reflection Prompt:");
      if (refIdx !== -1) {
        reflectionPrompt = content.substring(refIdx + "Reflection Prompt:".length).trim();
        content = content.substring(0, refIdx).trim();
      }
      setChatMessages((prev) => [...prev, { role: "ai", content, reflectionPrompt }]);
      setCompletedStages((prev) => new Set([...prev, "TORCH"]));
    } catch (err: any) {
      setChatMessages((prev) => prev.filter((m) => m !== tempUserMsg));
      const errMsg: string = err.message ?? "";
      const isSession = errMsg.includes("No active student session") || errMsg.includes("401");
      const isNotConfigured = errMsg.includes("not configured") || errMsg.includes("AI_PROVIDER");
      const isQuota = errMsg.includes("quota") || errMsg.includes("429") || errMsg.includes("Too Many Requests");
      if (isSession) {
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
      } else if (stageToReset === "COMPASS") {
        setCompassAnswers({ check1: "", check2: "", check3: "", check4: "", check5: "", sl1: false, sl2: false, sl3: false, sl4: false, sl5: false });
      } else if (stageToReset === "EMBED") {
        setEmbedAnswers({ finalAnswer: "", q1: "", q2: "", q3: "", q4: "" });
      }
      toast({ title: `${stageToReset} cleared`, description: "You can now start this stage fresh." });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setIsResetting(false);
      setStageToReset(null);
    }
  };

  const bloomLevels = [
    { label: "Knowledge", emoji: "🧠", description: "I need to learn definitions, key terms, facts, or foundational information.", placeholder: "What concept, fact, or key term would you like to learn about?" },
    { label: "Understand", emoji: "📖", description: "I don't fully understand something and need it explained more clearly.", placeholder: "What would you like explained more clearly?" },
    { label: "Apply", emoji: "🛠️", description: "I want to use what I've learned — solve a problem or try a real example.", placeholder: "What would you like to practise or use in an example?" },
    { label: "Analyse", emoji: "🔍", description: "I want to break something apart — find causes, patterns, or connections.", placeholder: "What would you like to break down, compare, or investigate?" },
    { label: "Evaluate", emoji: "⚖️", description: "I need to make a judgement — weigh evidence or assess an argument.", placeholder: "What argument, source, or decision do you want to assess?" },
    { label: "Create", emoji: "💡", description: "I'm trying to produce something new — plan, design, or write original work.", placeholder: "What are you trying to design, plan, or produce?" },
  ];

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

  const updateEntry = (id: string, field: keyof ResearchEntry, value: string) => {
    setResearchEntries((prev) => prev.map((e) => e.id === id ? { ...e, [field]: value } : e));
  };
  const addEntry = () => setResearchEntries((prev) => [...prev, emptyEntry()]);
  const removeEntry = (id: string) => {
    setResearchEntries((prev) => prev.length > 1 ? prev.filter((e) => e.id !== id) : prev);
  };

  if (!session) return null;

  const stageIndex = STAGES.indexOf(activeStage);

  const getStageStatus = (stage: Stage): "none" | "started" | "finished" => {
    switch (stage) {
      case "MAP": {
        const u = mapAnswers.taskUnderstanding.trim();
        const pk = mapAnswers.priorKnowledge.filter((p) => p.trim());
        const kg = mapAnswers.knowledgeGaps.filter((g) => g.trim());
        const eq = mapAnswers.enquiryQuestions.filter((q) => q.trim());
        if (!u && !pk.length && !eq.length) return "none";
        if (u.length >= 20 && pk.length >= 2 && kg.length >= 3 && eq.length >= 3) return "finished";
        return "started";
      }
      case "TORCH":
        if (chatMessages.length === 0) return "none";
        return chatMessages.length >= 6 ? "finished" : "started";
      case "RESEARCH": {
        const hasAny = researchEntries.some((e) => e.source || e.findings);
        if (!hasAny) return "none";
        return researchEntries.some((e) => e.source && e.findings) ? "finished" : "started";
      }
      case "COMPASS": {
        const { check1, check2, check3, check4, check5 } = compassAnswers;
        if (!check1 && !check2 && !check3 && !check4 && !check5) return "none";
        if (check1?.trim() && check2?.trim() && check3?.trim() && check4?.trim() && check5?.trim()) return "finished";
        return "started";
      }
      case "EMBED": {
        const { finalAnswer, q1, q2, q3, q4 } = embedAnswers;
        if (!finalAnswer && !q1 && !q2 && !q3 && !q4) return "none";
        if (finalAnswer?.trim() && q1?.trim() && q2?.trim() && q3?.trim() && q4?.trim()) return "finished";
        return "started";
      }
    }
  };

  return (
    <div className="min-h-[100dvh] bg-neutral-50 text-neutral-900 font-sans">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-white border-b border-neutral-200">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div className="shrink-0">
            <h1 className="text-xl font-semibold tracking-tight">The Assisted Climb</h1>
            <p className="text-sm text-neutral-500">{session.studentName} — {session.className}</p>
          </div>
          {task && (
            <div className="flex-1 min-w-0 mx-4 rounded-2xl bg-neutral-50 border border-neutral-200 px-5 py-2.5 flex items-center gap-4 overflow-hidden">
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
          <div className="shrink-0 flex items-center gap-2">
            <button
              onClick={() => { setShowPinModal(true); setPinSuccess(false); setPinError(""); }}
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
              onClick={handleSignOut}
              className="rounded-2xl border border-neutral-300 bg-white text-neutral-500 px-4 py-2.5 text-sm font-medium hover:bg-neutral-50 transition-colors"
              data-testid="link-signout"
            >
              Leave
            </button>
          </div>
        </div>

        {/* Stage navigation bar */}
        <div className="border-t border-neutral-100">
          <div className="max-w-7xl mx-auto px-6 flex">
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
                  onClick={() => { if (!isDisabled) { setActiveStage(stage); setShowOverview(false); } }}
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

      <main className="max-w-7xl mx-auto px-6 py-10">

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
          const researchFilled = researchEntries.filter(e => e.source || e.findings || e.importantPoints || e.reliability || e.usage).length;
          const compassFilled = [compassAnswers.check1, compassAnswers.check2, compassAnswers.check3, compassAnswers.check4, compassAnswers.check5].filter(Boolean).length;
          const embedFilled = [embedAnswers.finalAnswer, embedAnswers.q1, embedAnswers.q2, embedAnswers.q3, embedAnswers.q4].filter(Boolean).length;

          const stages = [
            { stage: "MAP" as Stage, label: "Planning", description: "Plan and frame your thinking before you begin.", total: 5, filled: mapFilled, unit: "questions" },
            { stage: "TORCH" as Stage, label: "Investigation", description: "Use the AI tutor to deepen your thinking.", total: null, filled: torchMsgs, unit: "messages" },
            { stage: "RESEARCH" as Stage, label: "Research Log", description: "Record and evaluate your sources.", total: null, filled: researchFilled, unit: "sources logged" },
            { stage: "COMPASS" as Stage, label: "Check Your Thinking", description: "Step back and interrogate your own understanding.", total: 5, filled: compassFilled, unit: "checks" },
            { stage: "EMBED" as Stage, label: "Final Answer", description: "Write your answer and reflect on how you got there.", total: 5, filled: embedFilled, unit: "sections" },
          ];

          const overallFb = studentFeedback["OVERALL"];
          const hasOverall = !!(overallFb?.grade || overallFb?.comment?.trim());

          return (
            <div className="space-y-6">
              <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm">
                <h2 className="text-3xl font-semibold tracking-tight mb-1">Your Progress</h2>
                <p className="text-neutral-500">Here's where you're up to on your climb, {session.studentName}.</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                {stages.map(({ stage, label, description, total, filled, unit }) => {
                  const isNotStarted = filled === 0;
                  const isComplete = total !== null ? filled >= total : filled >= 4;
                  const statusLabel = isNotStarted ? "Not started" : isComplete ? "Complete" : "In progress";
                  const statusColor = isNotStarted
                    ? "text-neutral-400"
                    : isComplete
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
                        </div>
                        <button
                          onClick={() => { setActiveStage(stage); setShowOverview(false); }}
                          className="w-full rounded-2xl border border-neutral-200 py-2 text-sm font-medium hover:bg-neutral-50 transition-colors"
                        >
                          {isNotStarted ? "Start" : "Continue"} →
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* ── Summative feedback stack ── */}
              {(() => {
                const summativeStages = stages.filter(({ stage }) => {
                  const fb = studentFeedback[stage];
                  return !!(fb?.grade || fb?.comment?.trim());
                });
                if (summativeStages.length === 0 && !hasOverall) return null;
                return (
                  <div className="space-y-3">
                    {summativeStages.length > 0 && (
                      <>
                        <p className="text-xs font-semibold text-neutral-400 uppercase tracking-widest px-1">Mid Point Formative Assessment</p>
                        {summativeStages.map(({ stage, label }) => {
                          const fb = studentFeedback[stage]!;
                          return (
                            <div key={stage} className="rounded-[2rem] bg-white border border-neutral-200 p-6 shadow-sm space-y-3">
                              <div className="flex flex-wrap items-center gap-3">
                                <div className={`px-3 py-1 rounded-xl text-xs font-bold tracking-widest uppercase ${STAGE_COLORS[stage]}`}>
                                  {STAGE_DISPLAY[stage]}
                                </div>
                                <span className="text-sm font-semibold text-neutral-700">{label}</span>
                                {fb.grade && (
                                  <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold border ${ATTAINMENT_COLOR[fb.grade] ?? "bg-neutral-100 text-neutral-600 border-neutral-200"}`}>
                                    {ATTAINMENT_LABEL[fb.grade] ?? fb.grade}
                                  </span>
                                )}
                              </div>
                              {fb.comment?.trim() && (
                                <p className="text-sm text-neutral-700 leading-relaxed whitespace-pre-wrap">{fb.comment}</p>
                              )}
                            </div>
                          );
                        })}
                      </>
                    )}
                    {hasOverall && (
                      <>
                        <p className="text-xs font-semibold text-neutral-400 uppercase tracking-widest px-1 pt-2">Your teacher's final assessment</p>
                        <div className="rounded-[2rem] bg-violet-50 border border-violet-200 p-8 shadow-sm space-y-4">
                          <p className="text-xs font-semibold text-violet-500 uppercase tracking-widest">Overall Assessment</p>
                          {overallFb!.grade && (
                            <span className={`inline-block px-4 py-1.5 rounded-full text-sm font-semibold border ${ATTAINMENT_COLOR[overallFb!.grade] ?? "bg-neutral-100 text-neutral-600 border-neutral-200"}`}>
                              {ATTAINMENT_LABEL[overallFb!.grade] ?? overallFb!.grade}
                            </span>
                          )}
                          {overallFb!.comment?.trim() && (
                            <p className="text-sm text-violet-900 leading-relaxed whitespace-pre-wrap">{overallFb!.comment}</p>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}
            </div>
          );
        })()}

        {/* ── MAP ── */}
        {!showOverview && activeStage === "MAP" && (
          <>
          {mapShowSummary ? (
            <div className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
              <div className="border-b border-neutral-200 px-8 py-6 flex items-center justify-between gap-4">
                <div>
                  <p className={`text-xs uppercase tracking-[0.2em] mb-2 ${STAGE_ACCENT.MAP}`}>MAP — Summary</p>
                  <h2 className="text-3xl font-semibold tracking-tight">My Initial Enquiry Map</h2>
                  {task && <p className="text-neutral-500 mt-1 text-sm font-medium">{task.title}</p>}
                </div>
                <div className="flex gap-3 shrink-0">
                  <button onClick={() => window.print()} className="rounded-2xl border border-neutral-300 px-4 py-2.5 text-sm font-medium hover:bg-neutral-50 transition-colors">Print / PDF</button>
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
                <p className={`text-xs uppercase tracking-[0.2em] mb-2 ${STAGE_ACCENT.MAP}`}>MAP</p>
                <h2 className="text-3xl font-semibold tracking-tight">Planning My Enquiry</h2>
                <p className="text-neutral-500 mt-1 text-sm">Clarify the task, activate what you already know, identify what you need to learn, and break it into manageable questions.</p>
                <div className="flex flex-wrap gap-x-1 gap-y-2 mt-5">
                  {[
                    { label: "Understand", done: mapAnswers.taskUnderstanding.trim().length >= 20 },
                    { label: "Recall", done: mapAnswers.priorKnowledge.filter(p => p.trim()).length >= 2 },
                    { label: "Identify", done: mapAnswers.knowledgeGaps.filter(g => g.trim()).length >= 3 },
                    { label: "Question", done: mapAnswers.enquiryQuestions.filter(q => q.trim()).length >= 3 },
                    { label: "Plan", done: mapAnswers.researchPlan.some(r => r.investigation.trim() && r.verification.trim()) },
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
                      <div className="hidden md:grid grid-cols-[1fr_1fr_1fr_1.5rem] gap-3 px-1">
                        <p className="text-xs font-semibold uppercase tracking-widest text-neutral-400">What to investigate</p>
                        <p className="text-xs font-semibold uppercase tracking-widest text-neutral-400">Where to look</p>
                        <p className="text-xs font-semibold uppercase tracking-widest text-neutral-400">How to verify</p>
                        <span />
                      </div>
                      {mapAnswers.researchPlan.map((row, i) => {
                        const SOURCE_OPTIONS = ["Books", "Reliable websites", "Academic articles", "Teacher guidance", "Experts", "Surveys / Interviews", "Data", "AI tools", "Other"];
                        const VERIFY_SUGGESTIONS = ["Compare with independent source", "Check author / organisation", "Check publication date", "Look for supporting evidence", "Distinguish fact from opinion", "Check if AI cited genuine sources", "Ask if perspectives are missing"];
                        const filledQs = mapAnswers.enquiryQuestions.filter(q => q.trim());
                        return (
                          <div key={row.id} className="rounded-2xl border border-neutral-200 p-4 space-y-3 md:space-y-0 md:grid md:grid-cols-[1fr_1fr_1fr_1.5rem] md:gap-3 md:items-start">
                            <div className="space-y-1.5">
                              <p className="text-xs text-neutral-400 font-medium md:hidden">What to investigate</p>
                              <input
                                type="text"
                                value={row.investigation}
                                onChange={(e) => setMapAnswers({ ...mapAnswers, researchPlan: mapAnswers.researchPlan.map((r, j) => j === i ? { ...r, investigation: e.target.value } : r) })}
                                className="w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                                placeholder="What do I need to investigate?"
                              />
                              {filledQs.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                  {filledQs.map((q, qi) => (
                                    <button key={qi} onClick={() => setMapAnswers({ ...mapAnswers, researchPlan: mapAnswers.researchPlan.map((r, j) => j === i ? { ...r, investigation: q } : r) })} className="text-[10px] bg-neutral-100 hover:bg-neutral-200 text-neutral-500 rounded-lg px-2 py-0.5 transition-colors truncate max-w-[150px]" title={`Use: ${q}`}>
                                      ↑ {q.length > 32 ? q.slice(0, 32) + "…" : q}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                            <div className="space-y-1.5">
                              <p className="text-xs text-neutral-400 font-medium md:hidden">Where to look</p>
                              <div className="flex flex-wrap gap-1">
                                {SOURCE_OPTIONS.map((src) => {
                                  const sel = row.sources.includes(src);
                                  return (
                                    <button key={src} onClick={() => setMapAnswers({ ...mapAnswers, researchPlan: mapAnswers.researchPlan.map((r, j) => j !== i ? r : { ...r, sources: sel ? r.sources.filter(s => s !== src) : [...r.sources, src] }) })} className={`text-xs rounded-lg px-2.5 py-1 font-medium border transition-colors ${sel ? "bg-neutral-800 text-white border-neutral-800" : "bg-white text-neutral-500 border-neutral-200 hover:border-neutral-400"}`}>
                                      {src}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                            <div className="space-y-1.5">
                              <p className="text-xs text-neutral-400 font-medium md:hidden">How to verify</p>
                              <textarea
                                value={row.verification}
                                onChange={(e) => setMapAnswers({ ...mapAnswers, researchPlan: mapAnswers.researchPlan.map((r, j) => j === i ? { ...r, verification: e.target.value } : r) })}
                                className="w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/10 min-h-[60px] resize-none"
                                placeholder="How will you verify this?"
                              />
                              <div className="flex flex-wrap gap-1">
                                {VERIFY_SUGGESTIONS.map((s) => (
                                  <button key={s} onClick={() => setMapAnswers({ ...mapAnswers, researchPlan: mapAnswers.researchPlan.map((r, j) => j !== i ? r : { ...r, verification: r.verification.trim() ? `${r.verification.trim()}\n${s}` : s }) })} className="text-[10px] bg-neutral-100 hover:bg-neutral-200 text-neutral-500 rounded-lg px-2 py-0.5 transition-colors">
                                    + {s}
                                  </button>
                                ))}
                              </div>
                              {row.investigation.trim() && !row.verification.trim() && (
                                <p className="text-xs text-amber-600">How will you know this source is trustworthy?</p>
                              )}
                            </div>
                            <div className="flex md:justify-center md:pt-1">
                              {mapAnswers.researchPlan.length > 1 && (
                                <button onClick={() => setMapAnswers({ ...mapAnswers, researchPlan: mapAnswers.researchPlan.filter((_, j) => j !== i) })} className="text-neutral-300 hover:text-red-400 transition-colors text-sm">✕</button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                      <button onClick={() => setMapAnswers({ ...mapAnswers, researchPlan: [...mapAnswers.researchPlan, { id: Date.now().toString(), investigation: "", sources: [], verification: "" }] })} className="rounded-xl border border-dashed border-neutral-300 px-4 py-2 text-sm text-neutral-500 hover:border-neutral-400 hover:text-neutral-700 transition-colors">
                        + Add another row
                      </button>
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
                    <button onClick={() => window.print()} className="rounded-2xl border border-neutral-200 text-neutral-500 px-4 py-2.5 text-sm font-medium hover:bg-neutral-50 transition-colors">
                      Print / Export PDF
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <button onClick={() => setMapShowSummary(true)} className="rounded-2xl border border-neutral-800 text-neutral-800 px-5 py-2.5 text-sm font-medium hover:bg-neutral-50 transition-colors">
                      Complete My Initial Map
                    </button>
                    <button onClick={goNext} className="rounded-2xl bg-black text-white px-6 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity" data-testid="button-unlock-torch">
                      Continue to TORCH →
                    </button>
                  </div>
                </div>

              </div>
            </div>
          )}
          <TeacherFeedbackBanner stage="MAP" feedback={studentFeedback["MAP"]} onAcknowledge={() => { apiFetch("/student/feedback/MAP/acknowledge", { method: "POST" }).catch(() => {}); setStudentFeedback(p => ({ ...p, MAP: { ...p["MAP"]!, studentAcknowledged: true } })); }} />
          </>
        )}

        {/* ── TORCH ── */}
        {!showOverview && activeStage === "TORCH" && (
          <div className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
            <div className="border-b border-neutral-200 px-8 py-6 flex items-center justify-between gap-4">
              <div>
                <p className={`text-xs uppercase tracking-[0.2em] mb-2 ${STAGE_ACCENT.TORCH}`}>TORCH</p>
                <h2 className="text-3xl font-semibold tracking-tight">Explore & Build Understanding</h2>
                <p className="text-neutral-500 mt-1 text-sm">Question, investigate and explore ideas with the AI tutor — gather information, test your thinking, and make connections.</p>
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
            <div className="grid grid-cols-1 xl:grid-cols-12">
              <div className="xl:col-span-3 p-8 border-r border-neutral-200 space-y-4">
                <h4 className="text-lg font-semibold tracking-tight">Thinking Notes</h4>
                {torchThinkingNotes.length > 0 ? (
                  torchThinkingNotes.map((note, i) => (
                    <InfoCard key={i} title={`Tip ${i + 1}`} text={note} />
                  ))
                ) : (
                  <>
                    <InfoCard title="Investigation Tip" text="Ask the AI to challenge your assumptions, not just explain concepts." />
                    <InfoCard title="Stay in control" text="Use AI to refine your thinking, not replace it." />
                  </>
                )}
              </div>
              <div className="xl:col-span-6 border-r border-neutral-200 flex flex-col min-h-[650px]">
                <div className="border-b border-neutral-200 px-6 py-5">
                  <p className="text-sm font-medium mb-4">What is your goal right now?</p>
                  <div className="grid grid-cols-3 gap-2">
                    {bloomLevels.map((level, index) => {
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
                            setChatInput("");
                            setShowAllSuggestions(false);
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
                        <div className="max-w-xl rounded-3xl bg-black text-white px-5 py-4 text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</div>
                      ) : msg.role === "system-error" ? (
                        <div className="max-w-2xl rounded-3xl bg-neutral-100 border border-neutral-300 px-6 py-5">
                          <p className="text-sm font-medium text-neutral-500 mb-1">AI not available</p>
                          <p className="text-sm text-neutral-600">{msg.content}</p>
                        </div>
                      ) : (
                        <div className="max-w-2xl rounded-3xl bg-white border border-neutral-200 px-6 py-5 shadow-sm">
                          <p className="text-sm text-neutral-700 leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                          {msg.reflectionPrompt && (
                            <div className="mt-4 rounded-2xl bg-amber-50 border border-amber-200 p-4">
                              <p className="text-sm font-medium mb-2 text-amber-900">Reflection Prompt</p>
                              <p className="text-sm text-amber-800">{msg.reflectionPrompt}</p>
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
                    <div className="border-t border-neutral-200 bg-white px-6 pt-4 pb-2 space-y-2">
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
                  const levelName = bloomLevels[selectedBloomLevel].label;
                  const suggestions = torchSuggestions[levelName] ?? [];
                  if (suggestions.length === 0) return null;
                  const VISIBLE = 4;
                  const visible = showAllSuggestions ? suggestions : suggestions.slice(0, VISIBLE);
                  const hasMore = suggestions.length > VISIBLE;
                  const visibleSuggestions = visible.filter(s => !askedSuggestions.has(s));
                  const askSuggestion = (s: string) => {
                    setChatInput(s);
                    setAskedSuggestions(prev => new Set([...prev, s]));
                    chatInputRef.current?.focus();
                  };
                  if (visibleSuggestions.length === 0 && !hasMore) return null;
                  return (
                    <div ref={suggestionsRef} className="border-t border-neutral-200 bg-white px-6 pt-4 pb-2 space-y-2">
                      <p className="text-xs font-semibold text-neutral-400 uppercase tracking-widest">Suggested questions for {levelName}</p>
                      <div className="flex flex-col gap-1">
                        {visibleSuggestions.map((suggestion, i) => (
                          <div key={i} className="flex items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50 pl-4 pr-2 py-2">
                            <span className="flex-1 text-sm text-amber-900 leading-snug">{suggestion}</span>
                            <button
                              onClick={() => askSuggestion(suggestion)}
                              className="shrink-0 text-xs font-medium text-amber-700 bg-white border border-amber-200 rounded-xl px-3 py-1.5 hover:bg-amber-700 hover:text-white hover:border-amber-700 transition-colors"
                            >
                              Ask
                            </button>
                          </div>
                        ))}
                      </div>
                      {hasMore && (
                        <button
                          onClick={() => setShowAllSuggestions(v => !v)}
                          className="text-xs text-neutral-400 hover:text-neutral-700 transition-colors pb-1"
                        >
                          {showAllSuggestions ? "Show less ↑" : `Show ${suggestions.length - VISIBLE} more ↓`}
                        </button>
                      )}
                    </div>
                  );
                })()}
                <div className="border-t border-neutral-200 bg-white px-6 py-5 flex items-end gap-4">
                  <textarea
                    ref={chatInputRef}
                    className="flex-1 rounded-2xl border border-neutral-200 p-4 min-h-[80px] resize-none focus:outline-none focus:ring-2 focus:ring-black/10"
                    placeholder={selectedBloomLevel !== null ? bloomLevels[selectedBloomLevel].placeholder : "Select a goal above, then type your question here..."}
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
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
              </div>
              <div className="xl:col-span-3 p-8 bg-neutral-50 space-y-6">
                <h4 className="text-xl font-semibold tracking-tight">Explore ideas without outsourcing your thinking.</h4>
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
                    <div className="rounded-2xl bg-white border border-neutral-200 p-5 space-y-3">
                      <p className="text-xs font-semibold uppercase tracking-widest text-neutral-400">Your question types</p>
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
                  );
                })()}

                {/* Teacher's recommended sources */}
                {task && Array.isArray((task as any).resources) && (task as any).resources.filter(Boolean).length > 0 && (
                  <div className="rounded-2xl bg-white border border-neutral-200 p-5 space-y-3">
                    <p className="text-xs font-semibold uppercase tracking-widest text-neutral-400">Recommended sources</p>
                    <p className="text-xs text-neutral-500">Your teacher suggested these as good starting points.</p>
                    <div className="flex flex-col gap-2">
                      {((task as any).resources as string[]).filter(Boolean).map((r: string, i: number) => {
                        const isUrl = /^https?:\/\//i.test(r);
                        return isUrl ? (
                          <a key={i} href={r} target="_blank" rel="noopener noreferrer" className="flex items-start gap-2 text-sm text-blue-700 hover:text-blue-900 hover:underline break-all leading-snug">
                            <span className="shrink-0 mt-0.5">↗</span>{r}
                          </a>
                        ) : (
                          <p key={i} className="flex items-start gap-2 text-sm text-neutral-700 leading-snug">
                            <span className="shrink-0 text-neutral-400 mt-0.5">·</span>{r}
                          </p>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Notes */}
                <div className="rounded-2xl bg-white border border-neutral-200 p-5 space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-widest text-neutral-400">My Notes</p>
                  <p className="text-xs text-neutral-500">Thoughts, ideas or reminders as you investigate. These will appear in the Final Response stage for reference.</p>
                  <textarea
                    value={mapAnswers.notes}
                    onChange={(e) => setMapAnswers({ ...mapAnswers, notes: e.target.value })}
                    className="w-full rounded-xl border border-neutral-200 p-3 min-h-[90px] resize-none focus:outline-none focus:ring-2 focus:ring-black/10 text-sm"
                    placeholder="e.g. Things I want to remember as I investigate, initial hypotheses, anything that struck me when reading the task…"
                  />
                </div>
              </div>
            </div>
            <TeacherFeedbackBanner stage="TORCH" feedback={studentFeedback["TORCH"]} onAcknowledge={() => { apiFetch("/student/feedback/TORCH/acknowledge", { method: "POST" }).catch(() => {}); setStudentFeedback(p => ({ ...p, TORCH: { ...p["TORCH"]!, studentAcknowledged: true } })); }} />
          </div>
        )}

        {/* ── RESEARCH ── */}
        {!showOverview && activeStage === "RESEARCH" && (
          <div className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
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
                {researchEntries.some((e) => e.source || e.findings || e.importantPoints || e.reliability || e.usage) && (
                  <button
                    onClick={() => triggerCsvDownload(buildResearchCsv(researchEntries), "research-log.csv")}
                    className="rounded-2xl border border-neutral-200 text-neutral-500 px-4 py-3 text-sm font-medium hover:text-black hover:bg-neutral-50 transition-colors"
                  >
                    ↓ Download all (.csv)
                  </button>
                )}
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
              <div className="divide-y divide-neutral-200">
                {researchEntries.map((entry, idx) => {
                  const isCollapsed = collapsedEntries.has(entry.id);
                  const hasContent = entry.source || entry.findings || entry.importantPoints || entry.reliability || entry.usage;
                  const toggleCollapse = () =>
                    setCollapsedEntries((prev) => {
                      const next = new Set(prev);
                      if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id);
                      return next;
                    });
                  const downloadEntry = () => {
                    const csv = buildResearchCsv([entry], idx);
                    triggerCsvDownload(csv, `source-${idx + 1}.csv`);
                  };

                  return (
                    <div key={entry.id}>
                      {isCollapsed ? (
                        <div className="px-8 py-5 flex items-center justify-between gap-4">
                          <div className="min-w-0">
                            <span className="text-xs font-semibold text-neutral-400 uppercase tracking-widest block mb-1">Source {idx + 1}</span>
                            <p className="text-sm font-medium text-neutral-800 truncate">{entry.source || <span className="text-neutral-400 italic">No source name</span>}</p>
                            {entry.findings && <p className="text-xs text-neutral-400 mt-0.5 truncate">{entry.findings}</p>}
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              onClick={downloadEntry}
                              className="text-xs text-neutral-500 hover:text-black px-3 py-1.5 rounded-xl border border-neutral-200 hover:bg-neutral-50 transition-colors"
                            >
                              ↓ Download
                            </button>
                            <button
                              onClick={toggleCollapse}
                              className="text-xs text-neutral-500 hover:text-black px-3 py-1.5 rounded-xl border border-neutral-200 hover:bg-neutral-50 transition-colors"
                            >
                              View
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="p-8 space-y-5">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-semibold text-neutral-400 uppercase tracking-widest">Source {idx + 1}</span>
                            <div className="flex items-center gap-2">
                              {hasContent && (
                                <button
                                  onClick={toggleCollapse}
                                  className="text-xs text-neutral-500 hover:text-black px-3 py-1 rounded-xl border border-neutral-200 hover:bg-neutral-50 transition-colors"
                                >
                                  Collapse ↑
                                </button>
                              )}
                              {researchEntries.length > 1 && (
                                <button
                                  onClick={() => removeEntry(entry.id)}
                                  className="text-xs text-neutral-400 hover:text-red-500 transition-colors px-3 py-1 rounded-xl border border-neutral-200 hover:border-red-200"
                                  data-testid={`button-remove-entry-${idx}`}
                                >
                                  Remove
                                </button>
                              )}
                            </div>
                          </div>

                          <div>
                            <label className="block text-sm font-medium mb-2">Source</label>
                            <input
                              type="text"
                              value={entry.source}
                              onChange={(e) => updateEntry(entry.id, "source", e.target.value)}
                              className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                              placeholder="Website URL, book title, article name, person interviewed..."
                              data-testid={`input-research-source-${idx}`}
                            />
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                            <div>
                              <label className="block text-sm font-medium mb-2">What did you find?</label>
                              <textarea
                                value={entry.findings}
                                onChange={(e) => updateEntry(entry.id, "findings", e.target.value)}
                                className="w-full rounded-2xl border border-neutral-200 p-4 min-h-[100px] resize-none focus:outline-none focus:ring-2 focus:ring-black/10 text-sm"
                                placeholder="Key information, facts, or arguments from this source..."
                                data-testid={`textarea-research-findings-${idx}`}
                              />
                            </div>
                            <div>
                              <label className="block text-sm font-medium mb-2">Important points</label>
                              <textarea
                                value={entry.importantPoints}
                                onChange={(e) => updateEntry(entry.id, "importantPoints", e.target.value)}
                                className="w-full rounded-2xl border border-neutral-200 p-4 min-h-[100px] resize-none focus:outline-none focus:ring-2 focus:ring-black/10 text-sm"
                                placeholder="What stands out as most significant?"
                                data-testid={`textarea-research-important-${idx}`}
                              />
                            </div>
                            <div>
                              <label className="block text-sm font-medium mb-2">How reliable is this source?</label>
                              <textarea
                                value={entry.reliability}
                                onChange={(e) => updateEntry(entry.id, "reliability", e.target.value)}
                                className="w-full rounded-2xl border border-neutral-200 p-4 min-h-[100px] resize-none focus:outline-none focus:ring-2 focus:ring-black/10 text-sm"
                                placeholder="Who wrote it, when, and why? What perspective or bias might they have? Is this a primary or secondary source?"
                                data-testid={`textarea-research-reliability-${idx}`}
                              />
                            </div>
                            <div>
                              <label className="block text-sm font-medium mb-2">How does this support, challenge, or nuance your argument?</label>
                              <textarea
                                value={entry.usage}
                                onChange={(e) => updateEntry(entry.id, "usage", e.target.value)}
                                className="w-full rounded-2xl border border-neutral-200 p-4 min-h-[100px] resize-none focus:outline-none focus:ring-2 focus:ring-black/10 text-sm"
                                placeholder="Does it back your position, complicate it, or add a different angle? Avoid only choosing sources that agree with you."
                                data-testid={`textarea-research-usage-${idx}`}
                              />
                            </div>
                          </div>

                          {hasContent && (
                            <div className="flex justify-end">
                              <button
                                onClick={toggleCollapse}
                                className="text-xs text-neutral-500 hover:text-black px-4 py-2 rounded-xl border border-neutral-200 hover:bg-neutral-50 transition-colors"
                              >
                                Done — collapse source ↑
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                <div className="p-8">
                  <button
                    onClick={addEntry}
                    className="rounded-2xl border border-dashed border-neutral-300 text-neutral-500 hover:text-black hover:border-neutral-500 px-6 py-3 text-sm font-medium transition-colors w-full"
                    data-testid="button-add-research-entry"
                  >
                    + Add another source
                  </button>
                </div>
              </div>

              <div className="px-8 pb-8 pt-6 border-t border-neutral-100 grid grid-cols-1 md:grid-cols-2 gap-4">
                <InfoCard title="Source Tip" text="A source is only as useful as your notes about it. Record what you found AND why it matters." />
                <InfoCard title="Reliability Check" text="Who wrote this? When? Why? Could they be biased? Is this peer-reviewed or opinion?" />
              </div>
            </div>
            <TeacherFeedbackBanner stage="RESEARCH" feedback={studentFeedback["RESEARCH"]} onAcknowledge={() => { apiFetch("/student/feedback/RESEARCH/acknowledge", { method: "POST" }).catch(() => {}); setStudentFeedback(p => ({ ...p, RESEARCH: { ...p["RESEARCH"]!, studentAcknowledged: true } })); }} />
          </div>
        )}

        {/* ── COMPASS ── */}
        {!showOverview && activeStage === "COMPASS" && (
          <div className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
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
                  Continue to Final Response →
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
            <TeacherFeedbackBanner stage="COMPASS" feedback={studentFeedback["COMPASS"]} onAcknowledge={() => { apiFetch("/student/feedback/COMPASS/acknowledge", { method: "POST" }).catch(() => {}); setStudentFeedback(p => ({ ...p, COMPASS: { ...p["COMPASS"]!, studentAcknowledged: true } })); }} />
          </div>
        )}

        {/* ── EMBED ── */}
        {!showOverview && activeStage === "EMBED" && (
          <div className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
            {/* Header */}
            <div className="border-b border-neutral-200 px-8 py-6 flex items-center justify-between gap-4">
              <div>
                <p className={`text-xs uppercase tracking-[0.2em] mb-2 ${STAGE_ACCENT.EMBED}`}>Final Response</p>
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
            <div className="grid grid-cols-1 xl:grid-cols-12">
              <div className="xl:col-span-8 p-8 border-r border-neutral-200 space-y-5">
                {task && (
                  <div className="rounded-2xl bg-violet-50 border border-violet-100 px-5 py-4">
                    <p className="text-xs uppercase tracking-widest font-semibold text-violet-400 mb-1">Task question</p>
                    <p className="font-semibold text-neutral-800">{task.title}</p>
                    {task.question && <p className="text-neutral-600 mt-1 text-sm">{task.question}</p>}
                  </div>
                )}
                <textarea
                  value={embedAnswers.finalAnswer}
                  onChange={(e) => { setEmbedAnswers({ ...embedAnswers, finalAnswer: e.target.value }); setAnswerFeedback(null); }}
                  onPaste={(e) => { e.preventDefault(); }}
                  onDrop={(e) => { e.preventDefault(); }}
                  className="w-full rounded-2xl border border-neutral-200 p-5 min-h-[340px] resize-none focus:outline-none focus:ring-2 focus:ring-violet-200 text-sm leading-relaxed"
                  placeholder="Write your answer here — in your own words. Pasting is disabled so this answer is genuinely yours."
                  data-testid="textarea-embed-final-answer"
                />
                <div className="flex items-center justify-between">
                  <p className="text-xs text-neutral-400">You can use AI to check your answer and get feedback on what's covered and what's missing — but you only have two chances, so use them wisely.</p>
                  <div className="flex flex-col items-end gap-1">
                    <button
                      disabled={!embedAnswers.finalAnswer.trim() || answerFeedbackLoading || answerFeedbackCount >= ANSWER_FEEDBACK_LIMIT}
                      onClick={async () => {
                        setAnswerFeedbackLoading(true);
                        setAnswerFeedback(null);
                        try {
                          const result = await apiFetch("/student/answer-feedback", { method: "POST", body: JSON.stringify({ answer: embedAnswers.finalAnswer }) }) as { feedback: string };
                          setAnswerFeedback(result.feedback);
                          setAnswerFeedbackCount(c => c + 1);
                        } catch {
                          setAnswerFeedback("Could not get feedback right now — please try again.");
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

                {/* AI Feedback Panel */}
                {answerFeedback && (
                  <div className="rounded-2xl border border-violet-200 bg-violet-50 overflow-hidden">
                    <div className="flex items-center justify-between px-5 py-3 border-b border-violet-200 bg-violet-100/60">
                      <div className="flex items-center gap-2">
                        <span className="text-violet-600">✦</span>
                        <p className="text-sm font-semibold text-violet-900">AI Feedback — cross-referenced against the task</p>
                      </div>
                      <button onClick={() => setAnswerFeedback(null)} className="text-violet-400 hover:text-violet-700 text-lg leading-none transition-colors">×</button>
                    </div>
                    <div className="p-5 space-y-4">
                      {answerFeedback.split(/\n(?=WHAT YOU'VE COVERED|WHAT'S MISSING|VOCABULARY CHECK|NEXT STEPS)/).map((section, i) => {
                        const [heading, ...body] = section.split("\n");
                        const bodyText = body.join("\n").trim();
                        if (!bodyText) return null;
                        const isPositive = heading.includes("COVERED");
                        const isMissing = heading.includes("MISSING");
                        const isVocab = heading.includes("VOCABULARY");
                        const isNext = heading.includes("NEXT STEPS");
                        return (
                          <div key={i} className={`rounded-xl p-4 ${isPositive ? "bg-emerald-50 border border-emerald-200" : isMissing ? "bg-amber-50 border border-amber-200" : isVocab ? "bg-sky-50 border border-sky-200" : isNext ? "bg-violet-100 border border-violet-200" : "bg-white border border-neutral-200"}`}>
                            <p className={`text-xs font-bold uppercase tracking-widest mb-2 ${isPositive ? "text-emerald-600" : isMissing ? "text-amber-600" : isVocab ? "text-sky-600" : isNext ? "text-violet-700" : "text-neutral-500"}`}>{heading.trim()}</p>
                            <p className="text-sm text-neutral-800 leading-relaxed whitespace-pre-wrap">{bodyText}</p>
                          </div>
                        );
                      })}
                    </div>
                    <div className="px-5 pb-4">
                      <p className="text-xs text-violet-500 italic">This feedback is AI-generated. Use it as a guide — your teacher's judgement takes precedence.</p>
                    </div>
                  </div>
                )}
              </div>
              <div className="xl:col-span-4 p-6 bg-neutral-50 space-y-4 overflow-y-auto max-h-[700px]">
                <h5 className="text-sm font-semibold tracking-tight text-neutral-600">My Notes</h5>

                {/* My Notes (from TORCH) */}
                <div className="rounded-xl bg-white border border-neutral-200 p-4 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-bold uppercase tracking-widest text-neutral-400">My Notes</p>
                    <button
                      onClick={() => setActiveStage("TORCH")}
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

                {/* RESEARCH */}
                {researchEntries.some((e) => e.importantPoints || e.findings) && (
                  <div className="rounded-xl bg-white border border-neutral-200 p-4 space-y-3">
                    <p className="text-xs font-bold uppercase tracking-widest text-neutral-400">RESEARCH — Key findings</p>
                    {researchEntries.filter((e) => e.importantPoints || e.findings).map((e, i) => (
                      <div key={e.id}>
                        {e.source && <p className="text-xs font-medium text-neutral-500 mb-0.5">Source {i + 1}: {e.source}</p>}
                        {e.importantPoints && <p className="text-xs text-neutral-700 leading-relaxed">{e.importantPoints}</p>}
                        {!e.importantPoints && e.findings && <p className="text-xs text-neutral-700 leading-relaxed">{e.findings}</p>}
                      </div>
                    ))}
                  </div>
                )}

                {!mapAnswers.notes && !researchEntries.some((e) => e.importantPoints || e.findings) && (
                  <p className="text-xs text-neutral-400 italic">Your notes from TORCH and RESEARCH will appear here for reference.</p>
                )}
              </div>
            </div>

            <TeacherFeedbackBanner stage="EMBED" feedback={studentFeedback["EMBED"]} onAcknowledge={() => { apiFetch("/student/feedback/EMBED/acknowledge", { method: "POST" }).catch(() => {}); setStudentFeedback(p => ({ ...p, EMBED: { ...p["EMBED"]!, studentAcknowledged: true } })); }} />
          </div>
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
              {((task.bloomLevels as string[] | undefined) ?? []).length > 0 && (
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-neutral-400 mb-3">Thinking Levels</p>
                  <div className="flex flex-wrap gap-2">
                    {(task.bloomLevels as string[]).map((l: string, i: number) => (
                      <span key={i} className="px-3 py-1 rounded-full bg-violet-50 border border-violet-200 text-sm font-medium text-violet-800">{l}</span>
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
                  { key: "compass", label: "COMPASS" }, { key: "embed", label: "Final Response" },
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

              {/* Teacher notes */}
              {task.notes && (
                <div className="rounded-xl bg-neutral-50 border border-neutral-200 px-5 py-4">
                  <p className="text-xs font-semibold text-neutral-400 uppercase tracking-widest mb-1.5">Teacher Notes</p>
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
              <p className="text-sm text-neutral-500 mt-1">Your PIN must be exactly 4 digits.</p>
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
                    maxLength={4}
                    value={pinForm.current}
                    onChange={(e) => setPinForm({ ...pinForm, current: e.target.value.replace(/\D/g, "") })}
                    className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10 tracking-widest text-center"
                    placeholder="····"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">New PIN</label>
                  <input
                    required
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    value={pinForm.next}
                    onChange={(e) => setPinForm({ ...pinForm, next: e.target.value.replace(/\D/g, "") })}
                    className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10 tracking-widest text-center"
                    placeholder="····"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">Confirm new PIN</label>
                  <input
                    required
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    value={pinForm.confirm}
                    onChange={(e) => setPinForm({ ...pinForm, confirm: e.target.value.replace(/\D/g, "") })}
                    className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10 tracking-widest text-center"
                    placeholder="····"
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
                    disabled={pinLoading || pinForm.current.length !== 4 || pinForm.next.length !== 4 || pinForm.confirm.length !== 4}
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
