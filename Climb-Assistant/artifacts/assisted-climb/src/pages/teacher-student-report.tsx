import { useState, useEffect } from "react";
import { Link, useRoute } from "wouter";
import { apiFetch } from "@/lib/api";
import { classifyMessages, QUESTION_TYPES } from "@/lib/question-classifier";

const STAGE_ORDER = ["MAP", "TORCH", "COMPASS", "EMBED", "RESEARCH"];

export default function TeacherStudentReport() {
  const [, params] = useRoute("/teacher/class/:classId/student/:sessionId/report");
  const classId = params?.classId;
  const sessionId = params?.sessionId;

  const [cls, setCls] = useState<any>(null);
  const [data, setData] = useState<any>(null);
  const [teacher, setTeacher] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!classId || !sessionId) return;
    Promise.all([
      apiFetch(`/teacher/classes/${classId}`),
      apiFetch(`/teacher/classes/${classId}/students/${sessionId}`),
      apiFetch("/auth/me"),
    ])
      .then(([classData, studentData, teacherData]) => {
        setCls(classData);
        setData(studentData);
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

  const stageStatuses: Record<string, "finished" | "started" | "none"> =
    data.stageStatuses ?? {};

  // TORCH summary
  const studentMessages = messages.filter((m: any) => m.role === "user");
  const qtCounts = classifyMessages(studentMessages.map((m: any) => ({ role: "user", content: m.content })));
  const qtTotal = Object.values(qtCounts).reduce((a: number, b: number) => a + b, 0);
  const sampleQuestions: string[] = studentMessages.slice(0, 6).map((m: any) => m.content as string);

  const today = new Date().toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric",
  });

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
        }
      `}</style>

      <div className="min-h-[100dvh] bg-neutral-50 font-sans text-neutral-900">
        {/* Screen nav */}
        <header className="no-print sticky top-0 z-50 border-b border-neutral-200 bg-white/90 backdrop-blur">
          <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              <Link href="/teacher/dashboard" className="text-neutral-500 hover:text-black">Dashboard</Link>
              <span className="text-neutral-300">/</span>
              <Link href={`/teacher/class/${classId}`} className="text-neutral-500 hover:text-black">{cls.name}</Link>
              <span className="text-neutral-300">/</span>
              <Link href={`/teacher/class/${classId}/student/${sessionId}`} className="text-neutral-500 hover:text-black">{session.studentName}</Link>
              <span className="text-neutral-300">/</span>
              <span className="font-medium">Report</span>
            </div>
            <button
              onClick={() => window.print()}
              className="rounded-2xl bg-black text-white px-5 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
              data-testid="button-print-student-report"
            >
              Print / Save PDF
            </button>
          </div>
        </header>

        <main className="max-w-4xl mx-auto px-6 py-10 space-y-8 pb-20">
          {/* Cover */}
          <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm print-section">
            <div className="flex items-start justify-between gap-6">
              <div>
                <p className="text-xs uppercase tracking-[0.25em] text-neutral-400 mb-2">Individual Student Report</p>
                <h1 className="text-4xl font-semibold tracking-tight mb-1">{session.studentName}</h1>
                <p className="text-neutral-500 text-lg">{cls.name}{cls.subject ? ` — ${cls.subject}` : ""}</p>
              </div>
              <div className="text-right text-sm text-neutral-500 shrink-0">
                <p className="font-medium text-neutral-900">{teacher?.name ?? "Teacher"}</p>
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
                  { stage: "EMBED",    label: "Final Response", dot: "bg-violet-500" },
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
          <section className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden print-section">
            <div className="border-b border-neutral-200 px-8 py-5">
              <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-1">MAP</p>
              <h2 className="text-xl font-semibold tracking-tight">Planning & Framing Thinking</h2>
            </div>
            <div className="p-8 space-y-6">
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
            </div>
          </section>

          {/* TORCH */}
          <section className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden print-section">
            <div className="border-b border-neutral-200 px-8 py-5">
              <p className="text-xs uppercase tracking-[0.2em] text-amber-500 mb-1">TORCH</p>
              <h2 className="text-xl font-semibold tracking-tight">Guided AI Investigation</h2>
            </div>
            <div className="p-8 space-y-6">
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

                  {/* Question type breakdown */}
                  {qtTotal > 0 && (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-widest text-neutral-400 mb-3">Question Type Breakdown</p>
                      <div className="flex flex-wrap gap-2">
                        {(QUESTION_TYPES as string[]).filter((t) => ((qtCounts as Record<string,number>)[t] ?? 0) > 0).map((type) => (
                          <span key={type} className="px-3 py-1.5 rounded-full bg-neutral-100 text-neutral-700 text-xs font-medium">
                            {type}: {(qtCounts as Record<string,number>)[type]} ({Math.round((((qtCounts as Record<string,number>)[type] ?? 0) / qtTotal) * 100)}%)
                          </span>
                        ))}
                      </div>
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
            </div>
          </section>

          {/* COMPASS */}
          <section className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden print-section">
            <div className="border-b border-neutral-200 px-8 py-5">
              <p className="text-xs uppercase tracking-[0.2em] text-emerald-500 mb-1">COMPASS</p>
              <h2 className="text-xl font-semibold tracking-tight">Check Your Thinking</h2>
            </div>
            <div className="p-8 grid grid-cols-1 md:grid-cols-2 gap-6">
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
            </div>
          </section>

          {/* EMBED */}
          <section className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden print-section">
            <div className="border-b border-neutral-200 px-8 py-5">
              <p className="text-xs uppercase tracking-[0.2em] text-violet-500 mb-1">Final Response</p>
              <h2 className="text-xl font-semibold tracking-tight">Reflection, Internalisation & Ownership</h2>
            </div>
            <div className="p-8 grid grid-cols-1 md:grid-cols-2 gap-6">
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
            </div>
          </section>

          <p className="text-xs text-neutral-400 text-center no-print">
            Use Ctrl+P / Cmd+P or click "Print / Save PDF" to export this report.
          </p>
        </main>
      </div>
    </>
  );
}
