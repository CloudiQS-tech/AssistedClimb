import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { 
  useListTaskTemplates, 
  useCreateTaskTemplate, 
  useUpdateTaskTemplate, 
  useDeleteTaskTemplate, 
  useDuplicateTaskTemplate, 
  useApplyTaskTemplate,
  useGetTeacherDashboardOverview,
  useGetTeacherMe,
  getListTaskTemplatesQueryKey,
  getGetTeacherDashboardOverviewQueryKey,
  TaskTemplateRecord
} from "@workspace/api-client-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { mergeVocabularyTerms, splitVocabularyPaste } from "@/lib/vocabulary";
import { RESOURCE_TYPES, formatResource, hasResourceLabel, parseResource, type ResourceType } from "@/lib/resources";
import { FRAMEWORK_DESCRIPTIONS } from "@/lib/frameworks";

const EXAM_BOARDS = ["AQA", "Pearson Edexcel", "OCR", "WJEC/Eduqas", "CCEA"] as const;
const CUSTOM_EXAM_BOARD = "__custom__";
const YEAR_GROUPS = {
  KS4: ["Year 9", "Year 10", "Year 11"],
  KS5: ["Year 12", "Year 13"],
} as const;

export default function TeacherAssignments() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: teacher, isLoading: teacherLoading, isError: teacherError } = useGetTeacherMe();
  const { data: templates, isLoading: templatesLoading } = useListTaskTemplates({
    query: { enabled: Boolean(teacher), queryKey: getListTaskTemplatesQueryKey() },
  });
  const { data: overview, isLoading: overviewLoading } = useGetTeacherDashboardOverview({
    query: { enabled: Boolean(teacher), queryKey: getGetTeacherDashboardOverviewQueryKey() },
  });

  const createTaskTemplate = useCreateTaskTemplate();
  const updateTaskTemplate = useUpdateTaskTemplate();
  const deleteTaskTemplate = useDeleteTaskTemplate();
  const duplicateTaskTemplate = useDuplicateTaskTemplate();
  const applyTaskTemplate = useApplyTaskTemplate();

  const [editingTemplate, setEditingTemplate] = useState<TaskTemplateRecord | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [vocabInput, setVocabInput] = useState("");
  const [usesCustomExamBoard, setUsesCustomExamBoard] = useState(false);

  const [formData, setFormData] = useState({
    title: "",
    subject: "",
    examBoard: "",
    question: "",
    notes: "",
    learningFramework: "bloom" as "bloom" | "knowledge_dimensions",
    yearGroup: "",
    bloomLevels: [] as string[],
    knowledgeDimensions: [] as string[],
    dueDate: "",
    successCriteria: [""],
    keyVocabulary: [] as string[],
    enabledStages: ["MAP", "TORCH", "COMPASS", "EMBED", "RESEARCH"],
    stageInstructions: {} as Record<string, string>,
    expectedLength: "",
    resources: [""],
    status: "draft" as "draft" | "ready"
  });
  
  const [applyingTemplate, setApplyingTemplate] = useState<number | null>(null);
  const [selectedClassIds, setSelectedClassIds] = useState<number[]>([]);

  useEffect(() => {
    if (teacherError) setLocation("/teacher/login");
  }, [teacherError, setLocation]);

  if (teacherError || teacherLoading || (teacher && (templatesLoading || overviewLoading))) return null;

  const handleCreateNew = () => {
    setIsCreating(true);
    setEditingTemplate(null);
    setApplyingTemplate(null);
    setFormData({
      title: "",
      subject: "",
      examBoard: "",
      question: "",
      notes: "",
      learningFramework: "bloom",
      yearGroup: "",
      bloomLevels: [],
      knowledgeDimensions: [],
      dueDate: "",
      successCriteria: [""],
      keyVocabulary: [],
      enabledStages: ["MAP", "TORCH", "COMPASS", "EMBED", "RESEARCH"],
      stageInstructions: {},
      expectedLength: "",
      resources: [""],
      status: "draft"
    });
    setUsesCustomExamBoard(false);
  };

  const handleEdit = (t: TaskTemplateRecord) => {
    setIsCreating(false);
    setApplyingTemplate(null);
    setEditingTemplate(t);
    setFormData({
      title: t.title,
      subject: t.subject || "",
      examBoard: t.examBoard || "",
      question: t.question,
      notes: t.notes || "",
      learningFramework: t.learningFramework || ((t.knowledgeDimensions?.length ?? 0) > 0 && (t.bloomLevels?.length ?? 0) === 0 ? "knowledge_dimensions" : "bloom"),
      yearGroup: t.yearGroup || "",
      bloomLevels: t.bloomLevels || [],
      knowledgeDimensions: (t.knowledgeDimensions || []).filter((item: string) => ["Factual Knowledge", "Conceptual Knowledge", "Procedural Knowledge"].includes(item)),
      dueDate: t.dueDate || "",
      successCriteria: t.successCriteria?.length ? t.successCriteria : [""],
      keyVocabulary: t.keyVocabulary || [],
      enabledStages: t.enabledStages || ["MAP", "TORCH", "COMPASS", "EMBED", "RESEARCH"],
      stageInstructions: t.stageInstructions || {},
      expectedLength: t.expectedLength || "",
      resources: t.resources?.length ? t.resources : [""],
      status: t.status
    });
    setUsesCustomExamBoard(Boolean(t.examBoard && !EXAM_BOARDS.includes(t.examBoard as typeof EXAM_BOARDS[number])));
  };

  const handleCancelForm = () => {
    setIsCreating(false);
    setEditingTemplate(null);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const payload = {
      title: formData.title,
      subject: formData.subject || undefined,
      examBoard: formData.examBoard.trim() || undefined,
      question: formData.question,
      notes: formData.notes || undefined,
      learningFramework: formData.learningFramework,
      yearGroup: formData.yearGroup || undefined,
      bloomLevels: formData.bloomLevels,
      knowledgeDimensions: formData.knowledgeDimensions,
      dueDate: formData.dueDate || undefined,
      successCriteria: formData.successCriteria.filter(c => c.trim()),
      keyVocabulary: formData.keyVocabulary,
      enabledStages: formData.enabledStages,
      stageInstructions: formData.stageInstructions,
      expectedLength: formData.expectedLength || undefined,
      resources: formData.resources.filter(hasResourceLabel),
      status: formData.status
    };

    if (isCreating) {
      createTaskTemplate.mutate({ data: payload }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTaskTemplatesQueryKey() });
          toast({ title: "Template created" });
          handleCancelForm();
        },
        onError: (err: any) => {
          toast({ title: "Error", description: err.message, variant: "destructive" });
        }
      });
    } else if (editingTemplate) {
      updateTaskTemplate.mutate({ templateId: editingTemplate.id, data: payload }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTaskTemplatesQueryKey() });
          toast({ title: "Template updated" });
          handleCancelForm();
        },
        onError: (err: any) => {
          toast({ title: "Error", description: err.message, variant: "destructive" });
        }
      });
    }
  };

  const handleDelete = (id: number) => {
    if (!confirm("Are you sure you want to delete this template?")) return;
    deleteTaskTemplate.mutate({ templateId: id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTaskTemplatesQueryKey() });
        toast({ title: "Template deleted" });
      },
      onError: (err: any) => {
        toast({ title: "Error", description: err.message, variant: "destructive" });
      }
    });
  };

  const handleDuplicate = (id: number) => {
    duplicateTaskTemplate.mutate({ templateId: id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTaskTemplatesQueryKey() });
        toast({ title: "Template duplicated" });
      },
      onError: (err: any) => {
        toast({ title: "Error", description: err.message, variant: "destructive" });
      }
    });
  };

  const handleApply = (id: number) => {
    setApplyingTemplate(id);
    setSelectedClassIds([]);
    setIsCreating(false);
    setEditingTemplate(null);
  };

  const confirmApply = () => {
    if (!applyingTemplate || selectedClassIds.length === 0) return;
    applyTaskTemplate.mutate({ templateId: applyingTemplate, data: { classIds: selectedClassIds } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetTeacherDashboardOverviewQueryKey() });
        toast({ title: "Template applied to selected classes" });
        setApplyingTemplate(null);
      },
      onError: (err: any) => {
        toast({ title: "Error", description: err.message, variant: "destructive" });
      }
    });
  };

  const toggleBloom = (level: string) => {
    setFormData(prev => ({
      ...prev,
      bloomLevels: prev.bloomLevels.includes(level) 
        ? prev.bloomLevels.filter(l => l !== level) 
        : [...prev.bloomLevels, level]
    }));
  };

  const toggleKnowledgeDimension = (dimension: string) => {
    setFormData(prev => ({
      ...prev,
      knowledgeDimensions: prev.knowledgeDimensions.includes(dimension)
        ? prev.knowledgeDimensions.filter(item => item !== dimension)
        : [...prev.knowledgeDimensions, dimension],
    }));
  };

  const selectFramework = (learningFramework: "bloom" | "knowledge_dimensions") => {
    setFormData(prev => ({
      ...prev,
      learningFramework,
      bloomLevels: learningFramework === "bloom" ? prev.bloomLevels : [],
      knowledgeDimensions: learningFramework === "knowledge_dimensions" ? prev.knowledgeDimensions : [],
    }));
  };

  const ALL_BLOOM = ["Remember", "Understand", "Apply", "Analyse", "Evaluate", "Create"];
  const ALL_KNOWLEDGE_DIMENSIONS = ["Factual Knowledge", "Conceptual Knowledge", "Procedural Knowledge"];
  const ALL_STAGES = ["MAP", "TORCH", "RESEARCH", "COMPASS", "EMBED"];
  const STAGE_NAMES: Record<string, string> = {
    MAP: "Map",
    TORCH: "Torch",
    RESEARCH: "Research",
    COMPASS: "Compass",
    EMBED: "Final Answer",
  };

  return (
    <div className="min-h-[100dvh] bg-neutral-50 text-neutral-900 font-sans pb-20">
      <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-6 py-4 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">
              The Assisted Climb <span className="text-neutral-400 font-normal ml-2">Assignments</span>
            </h1>
          </div>
          <div className="flex max-w-full flex-wrap items-center gap-x-4 gap-y-2 text-sm sm:gap-6">
            <span className="flex min-w-0 items-center gap-2 break-words text-neutral-600 [overflow-wrap:anywhere]">
              {teacher?.name}
            </span>
            <Link href="/teacher" className="text-neutral-500 hover:text-black transition-colors" data-testid="link-dashboard">
              Dashboard
            </Link>
            <Link href="/teacher/settings" className="text-neutral-500 hover:text-black transition-colors" data-testid="link-settings">
              Settings
            </Link>
            <Link href="/teacher/archive" className="text-neutral-500 hover:text-black transition-colors" data-testid="link-archive">
              Archive/Delete
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-12">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight mb-2">Task Templates</h2>
            <p className="text-neutral-500">Create reusable assignments and apply them to your active classes.</p>
          </div>
          {!isCreating && !editingTemplate && (
            <button 
              onClick={handleCreateNew}
              className="rounded-2xl bg-black text-white px-5 py-3 text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Create Template
            </button>
          )}
        </div>

        {(isCreating || editingTemplate) ? (
          <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm mb-8">
            <h3 className="text-xl font-semibold mb-6">{isCreating ? "New Task Template" : "Edit Task Template"}</h3>
            <form onSubmit={handleSave} className="space-y-6">
              
              <div className="grid gap-6 md:grid-cols-2">
                <div className="md:col-span-2">
                  <label className="block text-sm font-semibold mb-2">Task Name / Title *</label>
                  <input required value={formData.title} onChange={e => setFormData(prev => ({...prev, title: e.target.value}))} className="w-full rounded-xl border border-neutral-200 px-4 py-3 bg-neutral-50 focus:bg-white focus:ring-2 focus:ring-black/10" placeholder="E.g., Romeo & Juliet Essay" />
                  <p className="mt-1 text-xs text-neutral-400">Start here, then choose the framework and add the rest of the task details.</p>
                </div>
                <div>
                  <label className="block text-sm font-semibold mb-2">Due Date</label>
                  <input type="date" value={formData.dueDate} onChange={e => setFormData(prev => ({...prev, dueDate: e.target.value}))} className="w-full rounded-xl border border-neutral-200 px-4 py-3 bg-neutral-50 focus:bg-white focus:ring-2 focus:ring-black/10" />
                </div>
                <div>
                  <label htmlFor="template-subject" className="block text-sm font-semibold mb-2">Subject</label>
                  <input id="template-subject" value={formData.subject} onChange={e => setFormData(prev => ({ ...prev, subject: e.target.value }))} className="w-full rounded-xl border border-neutral-200 px-4 py-3 bg-neutral-50 focus:bg-white focus:ring-2 focus:ring-black/10" placeholder="E.g., English Literature" />
                </div>
                <div>
                  <label htmlFor="template-exam-board" className="block text-sm font-semibold mb-2">Exam board</label>
                  <select
                    id="template-exam-board"
                    value={usesCustomExamBoard ? CUSTOM_EXAM_BOARD : formData.examBoard}
                    onChange={e => {
                      const value = e.target.value;
                      if (value === CUSTOM_EXAM_BOARD) {
                        setUsesCustomExamBoard(true);
                        if (EXAM_BOARDS.includes(formData.examBoard as typeof EXAM_BOARDS[number])) {
                          setFormData(prev => ({ ...prev, examBoard: "" }));
                        }
                      } else {
                        setUsesCustomExamBoard(false);
                        setFormData(prev => ({ ...prev, examBoard: value }));
                      }
                    }}
                    className="w-full rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3"
                  >
                    <option value="">Not specified</option>
                    {EXAM_BOARDS.map(board => <option key={board} value={board}>{board}</option>)}
                    <option value={CUSTOM_EXAM_BOARD}>Other / custom</option>
                  </select>
                  {usesCustomExamBoard && (
                    <input
                      type="text"
                      value={formData.examBoard}
                      onChange={e => setFormData(prev => ({ ...prev, examBoard: e.target.value }))}
                      maxLength={200}
                      className="mt-2 w-full rounded-xl border border-neutral-200 px-4 py-3 bg-neutral-50 focus:bg-white focus:ring-2 focus:ring-black/10"
                      placeholder="Enter exam-board name"
                      aria-label="Custom exam-board name"
                      data-testid="input-template-custom-exam-board"
                    />
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-semibold mb-2">Main Question / Prompt *</label>
                <textarea required={formData.status === "ready"} value={formData.question} onChange={e => setFormData(prev => ({...prev, question: e.target.value}))} rows={3} className="w-full rounded-xl border border-neutral-200 px-4 py-3 bg-neutral-50 focus:bg-white focus:ring-2 focus:ring-black/10 resize-none" placeholder="What is the core question students need to answer?" />
              </div>

              <div>
                <label className="block text-sm font-semibold mb-2">Guidance Notes</label>
                <p className="text-xs text-neutral-400 mb-2">Students see these notes as help for completing the task. The AI tutor may also use them to keep support relevant.</p>
                <textarea value={formData.notes} onChange={e => setFormData(prev => ({...prev, notes: e.target.value}))} rows={2} className="w-full rounded-xl border border-neutral-200 px-4 py-3 bg-neutral-50 focus:bg-white focus:ring-2 focus:ring-black/10 resize-none" placeholder="Any extra instructions..." />
              </div>

              <fieldset className="rounded-2xl border border-neutral-200 p-5">
                <legend className="px-2 text-sm font-semibold">Choose one learning framework</legend>
                <div className="mb-5 grid gap-3 sm:grid-cols-2">
                  <button type="button" onClick={() => selectFramework("bloom")} className={`rounded-xl border p-3 text-left ${formData.learningFramework === "bloom" ? "border-black bg-black text-white" : "border-neutral-200"}`}>
                    <span className="block font-semibold">Bloom&apos;s Taxonomy</span>
                    <span className={`mt-1 block text-xs leading-relaxed ${formData.learningFramework === "bloom" ? "text-white/75" : "text-neutral-500"}`}>Choose the thinking level students should demonstrate, from recalling to creating.</span>
                  </button>
                  <button type="button" onClick={() => selectFramework("knowledge_dimensions")} className={`rounded-xl border p-3 text-left ${formData.learningFramework === "knowledge_dimensions" ? "border-sky-700 bg-sky-700 text-white" : "border-neutral-200"}`}>
                    <span className="block font-semibold">Knowledge Dimensions</span>
                    <span className={`mt-1 block text-xs leading-relaxed ${formData.learningFramework === "knowledge_dimensions" ? "text-white/75" : "text-neutral-500"}`}>Choose the kind of knowledge students should develop, from facts to reflection.</span>
                  </button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(formData.learningFramework === "bloom" ? ALL_BLOOM : ALL_KNOWLEDGE_DIMENSIONS).map(item => {
                    const selected = formData.learningFramework === "bloom" ? formData.bloomLevels.includes(item) : formData.knowledgeDimensions.includes(item);
                    return (
                      <button
                        key={item}
                        type="button"
                        onClick={() => formData.learningFramework === "bloom" ? toggleBloom(item) : toggleKnowledgeDimension(item)}
                        className={`rounded-2xl border px-4 py-3 text-left transition-colors ${selected ? formData.learningFramework === "bloom" ? "border-black bg-black text-white" : "border-sky-700 bg-sky-700 text-white" : "border-neutral-200 bg-white text-neutral-600 hover:border-neutral-400"}`}
                      >
                        <span className="block text-sm font-semibold">{item}</span>
                        <span className={`mt-1 block text-xs font-normal leading-relaxed ${selected ? "text-white/75" : "text-neutral-500"}`}>
                          {FRAMEWORK_DESCRIPTIONS[item]}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <label htmlFor="template-year-group" className="mt-5 block text-sm font-semibold">Year group</label>
                <select id="template-year-group" value={formData.yearGroup} onChange={e => setFormData(prev => ({ ...prev, yearGroup: e.target.value }))} className="mt-2 w-full rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3">
                  <option value="">Select a year group</option>
                  {Object.entries(YEAR_GROUPS).map(([keyStage, years]) => (
                    <optgroup key={keyStage} label={keyStage}>
                      {years.map(year => <option key={year} value={year}>{year} — {keyStage}</option>)}
                    </optgroup>
                  ))}
                </select>
              </fieldset>
              
              <div className="grid md:grid-cols-2 gap-6">
                <div>
                  <label htmlFor="template-status" className="block text-sm font-semibold mb-2">Status</label>
                  <select 
                    id="template-status"
                    value={formData.status} 
                    onChange={e => setFormData(prev => ({...prev, status: e.target.value as "draft" | "ready"}))} 
                    className="w-full rounded-xl border border-neutral-200 px-4 py-3 bg-neutral-50 focus:bg-white focus:ring-2 focus:ring-black/10"
                  >
                    <option value="draft">Draft (Not ready to apply)</option>
                    <option value="ready">Ready</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-semibold mb-2">Expected Length</label>
                  <input value={formData.expectedLength} onChange={e => setFormData(prev => ({...prev, expectedLength: e.target.value}))} className="w-full rounded-xl border border-neutral-200 px-4 py-3 bg-neutral-50 focus:bg-white focus:ring-2 focus:ring-black/10" placeholder="e.g. 500 words, 2 paragraphs..." />
                </div>
              </div>

              <div>
                <label className="block text-sm font-semibold mb-2">Active Climb Stages</label>
                <p className="text-xs text-neutral-500 mb-3">Choose which stages students will use when this assignment is applied.</p>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                  {ALL_STAGES.map((stage) => {
                    const enabled = formData.enabledStages.includes(stage);
                    return (
                      <button
                        key={stage}
                        type="button"
                        onClick={() => setFormData((prev) => ({
                          ...prev,
                          enabledStages: enabled
                            ? prev.enabledStages.filter((item) => item !== stage)
                            : [...prev.enabledStages, stage],
                        }))}
                        className={`rounded-xl border px-3 py-3 text-sm font-semibold transition-colors ${
                          enabled ? "border-black bg-black text-white" : "border-neutral-200 bg-neutral-50 text-neutral-500 hover:bg-neutral-100"
                        }`}
                      >
                        {STAGE_NAMES[stage]}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="block text-sm font-semibold mb-2">Stage Guidance</label>
                <p className="text-xs text-neutral-500 mb-3">Optional prompts shown within each enabled stage.</p>
                <div className="grid md:grid-cols-2 gap-3">
                  {["MAP", "TORCH", "COMPASS", "EMBED"].map((stage) => (
                    <label key={stage} className="block">
                      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-neutral-500">{STAGE_NAMES[stage]}</span>
                      <textarea
                        rows={2}
                        value={formData.stageInstructions[stage.toLowerCase()] ?? ""}
                        onChange={(event) => setFormData((prev) => ({
                          ...prev,
                          stageInstructions: {
                            ...prev.stageInstructions,
                            [stage.toLowerCase()]: event.target.value,
                          },
                        }))}
                        disabled={!formData.enabledStages.includes(stage)}
                        className="w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm bg-neutral-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-black/10 disabled:opacity-50"
                        placeholder={`Guidance for ${STAGE_NAMES[stage]}`}
                      />
                    </label>
                  ))}
                </div>
              </div>

              {/* Success Criteria */}
              <div>
                <label className="block text-sm font-semibold mb-2">Success Criteria</label>
                <div className="space-y-2 mb-2">
                  {formData.successCriteria.map((criterion, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <span className="text-neutral-400 text-sm shrink-0">•</span>
                      <input
                        type="text"
                        value={criterion}
                        onChange={(e) => {
                          const updated = [...formData.successCriteria];
                          updated[i] = e.target.value;
                          setFormData({ ...formData, successCriteria: updated });
                        }}
                        className="flex-1 rounded-xl border border-neutral-200 px-3 py-2 text-sm bg-neutral-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-black/10"
                      />
                      {formData.successCriteria.length > 1 && (
                        <button type="button" onClick={() => setFormData({ ...formData, successCriteria: formData.successCriteria.filter((_, j) => j !== i) })} className="text-neutral-400 hover:text-red-500 text-lg leading-none shrink-0">×</button>
                      )}
                    </div>
                  ))}
                </div>
                <button type="button" onClick={() => setFormData({ ...formData, successCriteria: [...formData.successCriteria, ""] })} className="text-sm font-medium text-neutral-500 hover:text-black transition-colors">+ Add criterion</button>
              </div>

              {/* Key Vocabulary */}
              <div>
                <label className="block text-sm font-semibold mb-2">Key Vocabulary</label>
                <p className="text-xs text-neutral-500 mb-3">Paste words separated by spaces, or use commas/new lines to keep multi-word terms together.</p>
                <div className="flex flex-wrap gap-2 mb-3">
                  {formData.keyVocabulary.map((term, i) => (
                    <span key={i} className="flex items-center gap-1 px-3 py-1 rounded-full bg-neutral-100 text-sm font-medium text-neutral-700">
                      {term}
                      <button type="button" onClick={() => setFormData({ ...formData, keyVocabulary: formData.keyVocabulary.filter((_, j) => j !== i) })} className="text-neutral-400 hover:text-red-500 ml-1 leading-none">×</button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={vocabInput}
                    onChange={(e) => setVocabInput(e.target.value)}
                    onPaste={(e) => {
                      const terms = splitVocabularyPaste(e.clipboardData.getData("text"));
                      if (terms.length > 0) {
                        e.preventDefault();
                        setFormData((prev) => ({
                          ...prev,
                          keyVocabulary: mergeVocabularyTerms(prev.keyVocabulary, terms),
                        }));
                        setVocabInput("");
                      }
                    }}
                    onKeyDown={(e) => {
                      if ((e.key === "Enter" || e.key === ",") && vocabInput.trim()) {
                        e.preventDefault();
                        setFormData((prev) => ({
                          ...prev,
                          keyVocabulary: mergeVocabularyTerms(prev.keyVocabulary, [vocabInput.trim()]),
                        }));
                        setVocabInput("");
                      }
                    }}
                    className="flex-1 rounded-xl border border-neutral-200 px-3 py-2 text-sm bg-neutral-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-black/10"
                    placeholder="Paste a list or type a term"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (vocabInput.trim()) {
                        setFormData((prev) => ({
                          ...prev,
                          keyVocabulary: mergeVocabularyTerms(prev.keyVocabulary, [vocabInput.trim()]),
                        }));
                        setVocabInput("");
                      }
                    }}
                    className="rounded-xl border border-neutral-200 px-4 py-2 text-sm font-medium hover:bg-neutral-50 transition-colors"
                  >Add</button>
                </div>
              </div>

              {/* Resources */}
              <div>
                <label className="block text-sm font-semibold mb-2">Resources</label>
                <p className="text-xs text-neutral-400 mb-3">Add up to 5 teacher-checked resources. Mix web links, books, videos, and documents.</p>
                <div className="space-y-2 mb-2">
                  {formData.resources.map((resource, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <select
                        value={parseResource(resource).type}
                        onChange={(e) => {
                          const updated = [...formData.resources];
                          updated[i] = formatResource(e.target.value as ResourceType, parseResource(resource).label);
                          setFormData({ ...formData, resources: updated });
                        }}
                        className="w-32 rounded-xl border border-neutral-200 px-2 py-2 text-sm bg-neutral-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-black/10"
                        aria-label={`Resource ${i + 1} type`}
                      >
                        {RESOURCE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                      </select>
                      <input
                        type="text"
                        value={parseResource(resource).label}
                        onChange={(e) => {
                          const updated = [...formData.resources];
                          updated[i] = formatResource(parseResource(resource).type, e.target.value);
                          setFormData({ ...formData, resources: updated });
                        }}
                        className="flex-1 rounded-xl border border-neutral-200 px-3 py-2 text-sm bg-neutral-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-black/10"
                        placeholder="e.g. Chapter 3 of your textbook / https://..."
                        aria-label={`Resource ${i + 1}`}
                      />
                      {formData.resources.length > 1 && (
                        <button type="button" onClick={() => setFormData({ ...formData, resources: formData.resources.filter((_, j) => j !== i) })} className="text-neutral-400 hover:text-red-500 text-lg leading-none shrink-0">×</button>
                      )}
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  disabled={formData.resources.length >= 5}
                  onClick={() => setFormData({ ...formData, resources: [...formData.resources, ""] })}
                  className="text-sm font-medium text-neutral-500 hover:text-black transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {formData.resources.length >= 5 ? "Maximum of 5 resources" : "+ Add resource"}
                </button>
              </div>
              
              <div className="pt-6 border-t border-neutral-100 flex items-center justify-end gap-3">
                <button type="button" onClick={handleCancelForm} className="px-6 py-3 rounded-xl font-medium text-neutral-600 hover:bg-neutral-100 transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={createTaskTemplate.isPending || updateTaskTemplate.isPending} className="px-6 py-3 rounded-xl font-medium text-white bg-black hover:bg-neutral-800 transition-colors disabled:opacity-50">
                  {isCreating ? "Create Template" : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        ) : null}

        {(!isCreating && !editingTemplate && applyingTemplate) ? (
          <div className="mb-8 rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-semibold">Apply Template to Classes</h3>
              <button onClick={() => setApplyingTemplate(null)} className="text-neutral-500 hover:text-black font-medium">Cancel</button>
            </div>
            
            <p className="text-sm text-neutral-600 mb-6">Select the active classes to apply this template to. Their current task settings will be replaced, but existing student work, feedback and progress will not be changed.</p>
            
            {overview?.classes && overview.classes.length > 0 ? (
              <div className="space-y-3 mb-8 max-h-60 overflow-y-auto pr-2">
                {overview.classes.map(cls => (
                  <label key={cls.id} className={`flex items-center gap-4 p-4 rounded-xl border cursor-pointer transition-colors ${selectedClassIds.includes(cls.id) ? 'border-black bg-neutral-50' : 'border-neutral-200 hover:bg-neutral-50'}`}>
                    <input 
                      type="checkbox" 
                      className="w-5 h-5 rounded border-neutral-300 text-black focus:ring-black"
                      checked={selectedClassIds.includes(cls.id)}
                      onChange={(e) => {
                        if (e.target.checked) setSelectedClassIds(prev => [...prev, cls.id]);
                        else setSelectedClassIds(prev => prev.filter(id => id !== cls.id));
                      }}
                    />
                    <div className="flex-1">
                      <p className="font-semibold text-neutral-900">{cls.name}</p>
                      {cls.taskTitle && <p className="text-xs text-neutral-500 mt-1">Current: {cls.taskTitle}</p>}
                    </div>
                    <span className="text-xs font-mono bg-neutral-100 px-2 py-1 rounded text-neutral-600">{cls.code}</span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-sm italic text-neutral-500 mb-6">No active classes found.</p>
            )}
            
            <div className="flex justify-end">
              <button 
                onClick={confirmApply}
                disabled={selectedClassIds.length === 0 || applyTaskTemplate.isPending}
                className="px-6 py-3 rounded-xl font-medium text-white bg-black hover:bg-neutral-800 transition-colors disabled:opacity-50"
              >
                {applyTaskTemplate.isPending ? "Applying..." : `Apply to ${selectedClassIds.length} class${selectedClassIds.length === 1 ? '' : 'es'}`}
              </button>
            </div>
          </div>
        ) : null}

        {(!isCreating && !editingTemplate) && (
          <div className="grid gap-6">
            {!templates || templates.length === 0 ? (
              <div className="text-center py-20 bg-white rounded-[2rem] border border-neutral-200 shadow-sm">
                <p className="text-neutral-500">No task templates yet. Create one to get started.</p>
              </div>
            ) : (
              templates.map((template) => (
                <div key={template.id} className={`rounded-[2rem] bg-white border ${applyingTemplate === template.id ? 'border-black ring-4 ring-black/5' : 'border-neutral-200'} p-6 shadow-sm flex flex-col md:flex-row gap-6 items-start md:items-center justify-between transition-all`}>
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-xl font-semibold tracking-tight">{template.title}</h3>
                      {template.status === 'draft' ? (
                        <span className="px-2 py-0.5 rounded-md bg-neutral-100 text-neutral-600 text-[10px] font-bold uppercase tracking-wider">Draft</span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-700 text-[10px] font-bold uppercase tracking-wider">Ready</span>
                      )}
                    </div>
                    <p className="text-neutral-600 text-sm mb-4 line-clamp-2">{template.question}</p>
                    
                    <div className="flex flex-wrap gap-2 items-center text-xs">
                      {template.bloomLevels && template.bloomLevels.map((l: string) => (
                        <span key={l} className="px-2 py-1 rounded-md bg-neutral-900 text-white font-medium">{l}</span>
                      ))}
                      {template.knowledgeDimensions && template.knowledgeDimensions.map((dimension: string) => (
                        <span key={dimension} className="px-2 py-1 rounded-md bg-sky-100 text-sky-800 font-medium">{dimension}</span>
                      ))}
                      {template.yearGroup && <span className="rounded-md bg-violet-100 px-2 py-1 font-medium text-violet-800">{template.yearGroup}</span>}
                      {template.subject && <span className="rounded-md bg-sky-100 px-2 py-1 font-medium text-sky-800">{template.subject}</span>}
                      {template.examBoard && <span className="rounded-md bg-amber-100 px-2 py-1 font-medium text-amber-800">{template.examBoard}</span>}
                      {template.dueDate && (
                        <span className="text-neutral-500 flex items-center gap-1 ml-2">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                          {new Date(template.dueDate).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  
                  <div className="flex flex-wrap gap-2 shrink-0">
                    <button onClick={() => handleEdit(template)} className="px-4 py-2 rounded-xl text-sm font-medium border border-neutral-200 bg-white hover:bg-neutral-50 transition-colors">
                      Edit
                    </button>
                    <button onClick={() => handleDuplicate(template.id)} disabled={duplicateTaskTemplate.isPending} className="px-4 py-2 rounded-xl text-sm font-medium border border-neutral-200 bg-white hover:bg-neutral-50 transition-colors">
                      Duplicate
                    </button>
                    <button onClick={() => handleDelete(template.id)} disabled={deleteTaskTemplate.isPending} className="px-4 py-2 rounded-xl text-sm font-medium border border-red-100 text-red-600 bg-red-50 hover:bg-red-100 transition-colors">
                      Delete
                    </button>
                    {template.status === 'ready' && (
                      <button onClick={() => handleApply(template.id)} className="px-4 py-2 rounded-xl text-sm font-medium text-white bg-black hover:bg-neutral-800 transition-colors">
                        Apply...
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </main>
    </div>
  );
}
