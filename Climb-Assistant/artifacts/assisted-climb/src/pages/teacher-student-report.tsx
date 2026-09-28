import { useState, useEffect, type ReactNode } from "react";
import { Link, useRoute } from "wouter";
import { apiFetch, apiFetchBlob, downloadBlob } from "@/lib/api";
import { SafeFormattedText } from "@/components/SafeFormattedText";
import {
  classifyKnowledgeDimension,
  classifyMessages,
  KNOWLEDGE_DIMENSION_TYPES,
  QUESTION_TYPES,
} from "@/lib/question-classifier";
import { normaliseSupportingMaterialCards } from "@/lib/supporting-materials";

const STAGE_ORDER = ["MAP", "TORCH", "COMPASS", "EMBED", "RESEARCH"];

function ReportSection({
  id,
  eyebrow,
  eyebrowClassName,
  title,
  open,
  onToggle,
  children,
  contentClassName = "",
}: {
  id: string;
  eyebrow: string;
  eyebrowClassName: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  contentClassName?: string;
}) {
  const contentId = `report-section-content-${id}`;

  return (
    <section className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden print-section">
      <div className="border-b border-neutral-200 px-8 py-5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={contentId}
          className="report-section-toggle w-full flex items-center justify-between gap-4 text-left"
          data-testid={`report-section-toggle-${id}`}
        >
          <span>
            <span className={`block text-xs uppercase tracking-[0.2em] mb-1 ${eyebrowClassName}`}>{eyebrow}</span>
            <span className="block text-xl font-semibold tracking-tight">{title}</span>
          </span>
          <span
            className="report-section-toggle-indicator flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-neutral-200 text-xl font-light text-neutral-500"
            aria-hidden="true"
          >
            {open ? "−" : "+"}
          </span>
        </button>
      </div>
      <div
        id={contentId}
        className={`${open ? "" : "hidden"} report-section-content p-8 ${contentClassName}`}
        data-testid={`report-section-content-${id}`}
      >
        {children}
      </div>
    </section>
  );
}

export default function TeacherStudentReport() {
  const [, params] = useRoute("/teacher/class/:classId/student/:sessionId/report");
  const classId = params?.classId;
  const sessionId = params?.sessionId;

  const [cls, setCls] = useState<any>(null);
  const [data, setData] = useState<any>(null);
  const [task, setTask] = useState<any>(null);
  const [teacher, setTeacher] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!classId || !sessionId) return;
    Promise.all([
      apiFetch(`/teacher/classes/${classId}`),
      apiFetch(`/teacher/classes/${classId}/students/${sessionId}`),
      apiFetch(`/teacher/classes/${classId}/task`),
      apiFetch("/auth/me"),
    ])
      .then(([classData, studentData, taskData, teacherData]) => {
        setCls(classData);
        setData(studentData);
        setTask(taskData);
        setTeacher(teacherData);
      })
      .finally(() => setLoading(false));
  }, [classId, sessionId]);

  if (loading) return null;
  if (!data || !cls) return <div className="p-6">Report not found</div>;

  const { session, stageEntries: entries, chatMessages: messages } = data;

  const mapEntry = entries.find((e: any) => e.stage === "MAP")?.contentJson ?? {};
  const compassEntry = entries.find((e: any) => e.stage === "COMPASS")?.contentJson ?? {};
  const embedEntry = entries.find((e: any) => e.stage === "EMBED")?.contentJson ?? {};
  const supportingMaterialCards = normaliseSupportingMaterialCards(embedEntry.supportingMaterialCards);

  const stageStatuses: Record<string, "finished" | "started" | "none"> =
    data.stageStatuses ?? {};

  // TORCH summary
  const studentMessages = messages.filter((m: any) => m.role === "user");
  const qtCounts = classifyMessages(studentMessages.map((m: any) => ({ role: "user", content: m.content })));
  const isKnowledgeDimensionsTask = task?.learningFramework === "knowledge_dimensions";
  const knowledgeDimensionCounts = Object.fromEntries(
    KNOWLEDGE_DIMENSION_TYPES.map((type) => [type, 0]),
  ) as Record<string, number>;
  for (const message of studentMessages) {
    const type = isKnowledgeDimensionsTask
      ? classifyKnowledgeDimension(message.content)
      : null;
    if (type) knowledgeDimensionCounts[type] = (knowledgeDimensionCounts[type] ?? 0) + 1;
  }
  const reportTypes = isKnowledgeDimensionsTask ? KNOWLEDGE_DIMENSION_TYPES : QUESTION_TYPES;
  const reportCounts: Record<string, number> = isKnowledgeDimensionsTask ? knowledgeDimensionCounts : { ...qtCounts };
  const qtTotal = Object.values(qtCounts).reduce((a: number, b: number) => a + b, 0);
  const sampleQuestions: string[] = studentMessages.slice(0, 6).map((m: any) => m.content as string);

  const today = new Date().toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric",
  });
  const reportSectionKeys = ["map", "torch", "compass", "embed"] as const;
  const allSectionsOpen = reportSectionKeys.every((key) => Boolean(expandedSections[key]));
  const setAllSectionsOpen = (open: boolean) => {
    setExpandedSections(Object.fromEntries(reportSectionKeys.map((key) => [key, open])));
  };

  const handleDownloadPdf = async () => {
    const main = document.querySelector("main");
    if (!main) return;
    const content = main.cloneNode(true) as HTMLElement;
    content.querySelectorAll("button, form, [data-export-controls], .no-print").forEach((element) => element.remove());
    content.querySelectorAll(".report-section-content").forEach((element) => element.classList.remove("hidden"));
    const text = (content.innerText || content.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) return;
    const blob = await apiFetchBlob("/teacher/export/pdf", {
      method: "POST",
      body: JSON.stringify({ title: "Individual Student Report", text }),
    });
    downloadBlob(blob, `${session.studentName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-student-report.pdf`);
  };

  function answerBox(value: string | undefined) {
    return (
      <div className="rounded-2xl bg-neutral-50 border border-neutral-200 p-4 min-h-[64px] text-sm text-neutral-800 whitespace-pre-wrap leading-relaxed">
        {value?.trim() || <span className="italic text-neutral-400">Not completed</span>}
      </div>
    );
  }

  return (
    <>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; }
          .print-section { page-break-inside: avoid; }
          .report-section-content { display: block !important; }
          .report-section-toggle-indicator { display: none !important; }
        }
      `}</style>

      <div className="min-h-[100dvh] bg-neutral-50 font-sans text-neutral-900">
        {/* Screen nav */}
        <header className="no-print sticky top-0 z-50 border-b border-neutral-200 bg-white/90 backdrop-blur">
          <div className="max-w-4xl mx-auto px-6 py-4 flex flex-col items-start gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 text-sm">
              <Link href="/teacher/dashboard" className="text-neutral-500 hover:text-black">Dashboard</Link>
              <span className="text-neutral-300">/</span>
              <Link href={`/teacher/class/${classId}`} className="min-w-0 text-neutral-500 hover:text-black [overflow-wrap:anywhere]">{cls.name}</Link>
              <span className="text-neutral-300">/</span>
              <Link href={`/teacher/class/${classId}/student/${sessionId}`} className="min-w-0 text-neutral-500 hover:text-black [overflow-wrap:anywhere]">{session.studentName}</Link>
              <span className="text-neutral-300">/</span>
              <span className="font-medium">Report</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setAllSectionsOpen(!allSectionsOpen)}
                className="shrink-0 rounded-2xl border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 transition-opacity"
                data-testid="button-toggle-student-report-sections"
              >
                {allSectionsOpen ? "Collapse all sections" : "Expand all sections"}
              </button>
              <button
                type="button"
                onClick={() => void handleDownloadPdf()}
                className="shrink-0 rounded-2xl bg-black text-white px-5 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
                data-testid="button-print-student-report"
              >
                Download PDF
              </button>
            </div>
          </div>
        </header>

        <main className="max-w-4xl mx-auto px-6 py-10 space-y-8 pb-20">
          {/* Cover */}
          <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm print-section">
            <div className="flex flex-col items-start gap-6 lg:flex-row lg:justify-between">
              <div className="min-w-0 max-w-full">
                <p className="text-xs uppercase tracking-[0.25em] text-neutral-400 mb-2">Individual Student Report</p>
                <h1 className="text-4xl font-semibold tracking-tight mb-1 [overflow-wrap:anywhere]">{session.studentName}</h1>
                <p className="text-neutral-500 text-lg [overflow-wrap:anywhere]">{cls.name}{cls.subject ? ` — ${cls.subject}` : ""}</p>
              </div>
              <div className="max-w-full text-left text-sm text-neutral-500 lg:shrink-0 lg:text-right">
                <p className="font-medium text-neutral-900 [overflow-wrap:anywhere]">{teacher?.name ?? "Teacher"}</p>
                <p>Generated {today}</p>
              </div>
            </div>

            {/* Stage status row */}
            <div className="mt-8 pt-6 border-t border-neutral-100">
              <p className="text-xs text-neutral-400 mb-4">Stage Progress</p>
              <div className="flex flex-wrap gap-4">
                {([
                  { stage: "MAP",      label: "MAP",            dot: "bg-neutral-700" },
                  { stage: "TORCH",    label: "TORCH",          dot: "bg-amber-500" },
                  { stage: "COMPASS",  label: "COMPASS",        dot: "bg-emerald-500" },
                  { stage: "EMBED",    label: "Final Answer", dot: "bg-violet-500" },
                  { stage: "RESEARCH", label: "RESEARCH",       dot: "bg-sky-500" },
                ] as const).map(({ stage, label, dot }) => {
                  const status = stageStatuses[stage] ?? "none";
                  const bg = status === "finished" ? "bg-emerald-50 border-emerald-200"
                           : status === "started"  ? "bg-amber-50 border-amber-200"
                           : "bg-red-50 border-red-200";
                  const icon = status === "finished" ? "✓"
                             : status === "started"  ? "~"
                             : "—";
                  const iconColor = status === "finished" ? "text-emerald-600"
                                  : status === "started"  ? "text-amber-600"
                                  : "text-red-400";
                  const statusLabel = status === "finished" ? "Complete"
                                    : status === "started"  ? "In progress"
                                    : "Not started";
                  return (
                    <div key={stage} className={`flex items-center gap-3 rounded-2xl border px-4 py-3 ${bg}`}>
                      <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
                      <div>
                        <p className="text-xs font-semibold text-neutral-700">{label}</p>
                        <p className={`text-xs ${iconColor} font-medium`}>{icon} {statusLabel}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* MAP */}
          <ReportSection
            id="map"
            eyebrow="MAP"
            eyebrowClassName="text-neutral-400"
            title="Planning & Framing Thinking"
            open={Boolean(expandedSections.map)}
            onToggle={() => setExpandedSections((current) => ({ ...current, map: !current.map }))}
            contentClassName="space-y-6"
          >
              <div>
                <p className="text-sm font-medium text-neutral-500 mb-2">What is this task asking you to do?</p>
                {answerBox(mapEntry.q1)}
              </div>
              <div>
                <p className="text-sm font-medium text-neutral-500 mb-2">What do you already know about this topic?</p>
                {answerBox(mapEntry.q2)}
              </div>
              <div>
                <p className="text-sm font-medium text-neutral-500 mb-2">What might be difficult about this task?</p>
                {answerBox(mapEntry.q3)}
              </div>
          </ReportSection>

          {/* TORCH */}
          <ReportSection
            id="torch"
            eyebrow="TORCH"
            eyebrowClassName="text-amber-500"
            title="Guided AI Investigation"
            open={Boolean(expandedSections.torch)}
            onToggle={() => setExpandedSections((current) => ({ ...current, torch: !current.torch }))}
            contentClassName="space-y-6"
          >
              {messages.length === 0 ? (
                <p className="italic text-neutral-400 text-sm">No AI investigation recorded.</p>
              ) : (
                <>
                  {/* Stats row */}
                  <div className="flex flex-wrap gap-4">
                    <div className="rounded-2xl bg-amber-50 border border-amber-200 px-5 py-3 text-center">
                      <p className="text-2xl font-bold text-amber-700">{studentMessages.length}</p>
                      <p className="text-xs text-amber-600 font-medium mt-0.5">Questions asked</p>
                    </div>
                    <div className="rounded-2xl bg-neutral-50 border border-neutral-200 px-5 py-3 text-center">
                      <p className="text-2xl font-bold text-neutral-700">{messages.filter((m: any) => m.role === "assistant").length}</p>
                      <p className="text-xs text-neutral-500 font-medium mt-0.5">AI responses</p>
                    </div>
                  </div>

                  {/* Framework-aware question breakdown */}
                  {qtTotal > 0 && (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-widest text-neutral-400 mb-3">
                        {isKnowledgeDimensionsTask ? "Knowledge Dimension Signals" : "Question Type Breakdown"}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {(reportTypes as readonly string[]).filter((t) => (reportCounts[t] ?? 0) > 0).map((type) => (
                          <span key={type} className="px-3 py-1.5 rounded-full bg-neutral-100 text-neutral-700 text-xs font-medium">
                            {type}: {reportCounts[type]} ({Math.round(((reportCounts[type] ?? 0) / qtTotal) * 100)}%)
                          </span>
                        ))}
                      </div>
                      {isKnowledgeDimensionsTask && (
                        <p className="mt-2 text-xs text-neutral-400">
                          Learning Process signals reflect metacognitive checking and uncertainty; they are not a separate selectable knowledge dimension.
                        </p>
                      )}
                    </div>
                  )}

                  {/* Sample questions */}
                  {sampleQuestions.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-widest text-neutral-400 mb-3">Lines of Enquiry</p>
                      <ul className="space-y-2">
                        {sampleQuestions.map((q, i) => (
                          <li key={i} className="flex gap-3 text-sm">
                            <span className="shrink-0 w-5 h-5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold flex items-center justify-center">{i + 1}</span>
                            <span className="text-neutral-700 leading-relaxed">{q}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
          </ReportSection>

          {/* COMPASS */}
          <ReportSection
            id="compass"
            eyebrow="COMPASS"
            eyebrowClassName="text-emerald-500"
            title="Check Your Thinking"
            open={Boolean(expandedSections.compass)}
            onToggle={() => setExpandedSections((current) => ({ ...current, compass: !current.compass }))}
            contentClassName="grid grid-cols-1 md:grid-cols-2 gap-6"
          >
              {[
                ["Say it in your own words", compassEntry.check1],
                ["The strongest challenge to your thinking", compassEntry.check2],
                ["Where you're least confident", compassEntry.check3],
                ["Is your evidence balanced?", compassEntry.check4],
                ["Are you ready to write?", compassEntry.check5],
              ].map(([q, a]) => (
                <div key={q as string}>
                  <p className="text-sm font-medium text-neutral-500 mb-2">{q}</p>
                  {answerBox(a as string)}
                </div>
              ))}
          </ReportSection>

          {/* EMBED */}
          <ReportSection
            id="embed"
            eyebrow="Final Answer"
            eyebrowClassName="text-violet-500"
            title="Reflection, Internalisation & Ownership"
            open={Boolean(expandedSections.embed)}
            onToggle={() => setExpandedSections((current) => ({ ...current, embed: !current.embed }))}
            contentClassName="grid grid-cols-1 md:grid-cols-2 gap-6"
          >
              <div className="md:col-span-2">
                <p className="text-sm font-medium text-neutral-500 mb-2">Final Answer</p>
                <div className="rounded-2xl border border-violet-100 bg-violet-50 p-5 text-sm leading-relaxed">
                  {embedEntry.finalAnswer ? <SafeFormattedText value={embedEntry.finalAnswer} /> : <span className="italic text-neutral-400">Not completed</span>}
                </div>
              </div>
              {embedEntry.supportingMaterials && (
                <div className="md:col-span-2">
                  <p className="text-sm font-medium text-neutral-500 mb-2">Existing supporting materials note</p>
                  {answerBox(embedEntry.supportingMaterials)}
                </div>
              )}
              {supportingMaterialCards.map((card, index) => (
                <div key={index} className="md:col-span-2 rounded-2xl border border-violet-100 bg-violet-50/40 p-5">
                  <p className="text-sm font-semibold text-violet-700 mb-3">Supporting material {index + 1}</p>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    {[
                      ["Name of the material", card.name],
                      ["Type of material", card.type],
                      ["What does it show?", card.whatItShows],
                      ["Why is it relevant to the answer?", card.whyRelevant],
                      ["Where is it referred to in the Final Answer?", card.finalResponseReference],
                      ["How was it shared with the teacher?", card.sharingMethod],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <p className="text-sm font-medium text-neutral-500 mb-2">{label}</p>
                        {answerBox(value)}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {[
                ["What changed in your understanding?", embedEntry.q1],
                ["Where did YOU do the thinking?", embedEntry.q2],
                ["How did AI help your learning?", embedEntry.q3],
                ["What did you decide not to trust?", embedEntry.q4],
              ].map(([q, a]) => (
                <div key={q as string}>
                  <p className="text-sm font-medium text-neutral-500 mb-2">{q}</p>
                  {answerBox(a as string)}
                </div>
              ))}
          </ReportSection>

          <p className="text-xs text-neutral-400 text-center no-print">
            Download the complete report as a PDF, including collapsed sections.
          </p>
        </main>
      </div>
    </>
  );
}
