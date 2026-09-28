import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { apiFetch, clearTeacherToken } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { useGetTeacherDashboardOverview, useGetTeacherMe } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetTeacherDashboardOverviewQueryKey, getGetTeacherMeQueryKey } from "@workspace/api-client-react";
import { classifyWorkspaceError, isUnauthorizedError, WorkspaceRequestState } from "@/components/WorkspaceRequestState";

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button
      onClick={copy}
      className={`mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
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

type DashboardDetailKind = "readyForFormative" | "readyForSummative" | "notStarted";

export default function TeacherDashboard() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [showNewClass, setShowNewClass] = useState(false);
  const [newClassName, setNewClassName] = useState("");
  const [newClassSubject, setNewClassSubject] = useState("");
  const [openDetail, setOpenDetail] = useState<DashboardDetailKind | null>(null);

  const teacherQuery = useGetTeacherMe({ query: { queryKey: getGetTeacherMeQueryKey(), retry: false } });
  const { data: teacher, isLoading: teacherLoading } = teacherQuery;
  const overviewQuery = useGetTeacherDashboardOverview({
    query: { enabled: Boolean(teacher), queryKey: getGetTeacherDashboardOverviewQueryKey(), retry: false },
  });
  const { data: overview, isLoading: overviewLoading } = overviewQuery;

  useEffect(() => {
    if (teacherQuery.error && isUnauthorizedError(teacherQuery.error)) {
      setLocation("/teacher/login");
    } else if (teacher?.isItAdmin) {
      setLocation("/teacher/settings");
    }
  }, [teacher, teacherQuery.error, setLocation]);

  const handleSignOut = async () => {
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } catch (e) {}
    clearTeacherToken();
    setLocation("/");
  };

  const handleCreateClass = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const cls = await apiFetch("/teacher/classes", {
        method: "POST",
        body: JSON.stringify({ name: newClassName, subject: newClassSubject || undefined })
      });
      queryClient.invalidateQueries({ queryKey: getGetTeacherDashboardOverviewQueryKey() });
      setLocation(`/teacher/class/${cls.id}`);
    } catch (err: any) {
      toast({
        title: "Error creating class",
        description: err.message,
        variant: "destructive"
      });
    }
  };

  const workspaceError = teacherQuery.error ?? overviewQuery.error;
  if (workspaceError && !isUnauthorizedError(workspaceError)) {
    return (
      <WorkspaceRequestState
        workspace="Teacher workspace"
        state={classifyWorkspaceError(workspaceError)}
        onRetry={() => teacherQuery.error ? teacherQuery.refetch() : overviewQuery.refetch()}
      />
    );
  }
  if (teacherLoading || (teacher && overviewLoading)) {
    return <WorkspaceRequestState workspace="Teacher workspace" state="loading" />;
  }

  const formatDueDate = (value: string | null) => {
    if (!value) return "";
    const dateOnly = value.slice(0, 10);
    const [year, month, day] = dateOnly.split("-").map(Number);
    const date = new Date(year, month - 1, day, 12);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  };

  const formatDetailDate = (value: string | null) => {
    if (!value) return "Date unavailable";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "Date unavailable"
      : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  };

  const detailLabels: Record<DashboardDetailKind, { title: string; description: string; action: string }> = {
    readyForFormative: {
      title: "Ready for formative assessment",
      description: "Classes whose formative assessment date has arrived.",
      action: "Open class",
    },
    readyForSummative: {
      title: "Ready for summative assessment",
      description: "Classes whose task completion date has passed.",
      action: "Open class",
    },
    notStarted: {
      title: "Students not yet started",
      description: "Approved students with no recorded work in the Climb.",
      action: "Open student",
    },
  };

  const detailItems = openDetail && overview
    ? overview.attentionDetails?.[openDetail] ?? []
    : [];

  return (
    <div className="min-h-[100dvh] bg-neutral-50 text-neutral-900 font-sans">
      <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-6 py-4 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">
              The Assisted Climb <span className="text-neutral-400 font-normal ml-2">Teacher Dashboard</span>
            </h1>
          </div>

          <div className="flex max-w-full flex-wrap items-center gap-x-4 gap-y-2 text-sm sm:gap-6">
            <span className="flex min-w-0 items-center gap-2 break-words text-neutral-600 [overflow-wrap:anywhere]">
              {teacher?.name}
              {teacher?.schoolAdminRole && (
                <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">{teacher.schoolAdminRole === "master" ? "School Admin" : "School Sub-admin"}</span>
              )}
            </span>
            <Link href="/teacher/assignments" className="text-neutral-500 hover:text-black transition-colors" data-testid="link-assignments">
              Assignments
            </Link>
            <Link href="/teacher/settings" className="text-neutral-500 hover:text-black transition-colors" data-testid="link-settings">
              {teacher?.schoolAdminRole ? "School settings" : "Account"}
            </Link>
            <Link href="/teacher/archive" className="text-neutral-500 hover:text-black transition-colors" data-testid="link-archive">
              Archive/Delete
            </Link>
            <button onClick={handleSignOut} className="hover:text-black transition-colors text-neutral-500">
              Sign Out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-12">
        
        {overview && (
          <div className="mb-12 space-y-6">
            <section className="rounded-[2rem] bg-white border border-neutral-200 p-6 shadow-sm" aria-labelledby="dashboard-attention-heading">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-neutral-400">Teacher workspace</p>
                  <h2 id="dashboard-attention-heading" className="mt-1 text-2xl font-semibold tracking-tight">What needs your attention?</h2>
                  <p className="mt-1 max-w-2xl text-sm text-neutral-500">A quick view of students and climbs that may need your next action.</p>
                </div>
                <p className="text-xs text-neutral-400">{overview.totalClasses} active {overview.totalClasses === 1 ? "class" : "classes"} · {overview.totalStudents} enrolled students</p>
              </div>

              <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <button type="button" onClick={() => setOpenDetail((current) => current === "readyForFormative" ? null : "readyForFormative")} aria-expanded={openDetail === "readyForFormative"} className="w-full rounded-2xl border border-amber-200 bg-amber-50 p-4 text-left transition hover:border-amber-300 hover:shadow-sm" data-testid="card-ready-for-formative">
                  <span className="text-2xl font-bold text-amber-700">{overview.readyForFormativeClasses}</span>
                  <span className="mt-1 block text-[11px] font-bold uppercase tracking-wider text-amber-700">Ready for formative assessment</span>
                  <span className="mt-2 block text-xs text-amber-800/70">Classes at the formative assessment date</span>
                </button>
                <button type="button" onClick={() => setOpenDetail((current) => current === "readyForSummative" ? null : "readyForSummative")} aria-expanded={openDetail === "readyForSummative"} className="w-full rounded-2xl border border-violet-200 bg-violet-50 p-4 text-left transition hover:border-violet-300 hover:shadow-sm" data-testid="card-ready-for-summative">
                  <span className="text-2xl font-bold text-violet-700">{overview.readyForSummativeClasses}</span>
                  <span className="mt-1 block text-[11px] font-bold uppercase tracking-wider text-violet-700">Ready for summative assessment</span>
                  <span className="mt-2 block text-xs text-violet-800/70">Classes past the task completion date</span>
                </button>
                <button type="button" onClick={() => setOpenDetail((current) => current === "notStarted" ? null : "notStarted")} aria-expanded={openDetail === "notStarted"} className="w-full rounded-2xl border border-rose-200 bg-rose-50 p-4 text-left transition hover:border-rose-300 hover:shadow-sm" data-testid="card-not-started">
                  <span className="text-2xl font-bold text-rose-700">{overview.notStartedStudents}</span>
                  <span className="mt-1 block text-[11px] font-bold uppercase tracking-wider text-rose-700">Students not yet started</span>
                  <span className="mt-2 block text-xs text-rose-800/70">Approved students with no recorded work</span>
                </button>
                <Link href="/teacher/approvals" className="w-full rounded-2xl border border-sky-200 bg-sky-50 p-4 text-left transition hover:border-sky-300 hover:shadow-sm" data-testid="card-awaiting-approval">
                  <span className="text-2xl font-bold text-sky-700">{overview.pendingApprovals}</span>
                  <span className="mt-1 block text-[11px] font-bold uppercase tracking-wider text-sky-700">Students awaiting approval</span>
                  <span className="mt-2 block text-xs text-sky-800/70">Registrations waiting for teacher review</span>
                </Link>
              </div>

              {openDetail && (
                <section className="mt-4 rounded-2xl border border-neutral-200 bg-neutral-50 p-4" aria-live="polite" data-testid="dashboard-attention-detail">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-neutral-400">Details</p>
                      <h3 className="mt-1 text-lg font-semibold">{detailLabels[openDetail].title}</h3>
                      <p className="mt-1 text-sm text-neutral-500">{detailLabels[openDetail].description}</p>
                    </div>
                    <button type="button" onClick={() => setOpenDetail(null)} className="self-start rounded-lg px-2 py-1 text-sm text-neutral-500 hover:bg-white hover:text-neutral-900" aria-label="Close details">Close</button>
                  </div>

                  {detailItems.length === 0 ? (
                    <p className="mt-4 rounded-xl bg-white px-4 py-3 text-sm text-neutral-500">No matching records right now.</p>
                  ) : (
                    <div className="mt-4 max-h-96 space-y-2 overflow-y-auto">
                      {detailItems.map((item) => {
                        const href = item.sessionId
                          ? `/teacher/class/${item.classId}/student/${item.sessionId}`
                          : `/teacher/class/${item.classId}`;
                        return (
                          <Link key={`${item.kind}-${item.sessionId ?? item.classId}`} href={href} className="block rounded-xl border border-neutral-200 bg-white px-4 py-3 transition hover:border-neutral-400 hover:shadow-sm">
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                              <div className="min-w-0">
                                <p className="font-semibold [overflow-wrap:anywhere]">{item.studentName ?? item.className}</p>
                                <p className="mt-0.5 text-xs text-neutral-500">{item.className}{item.taskTitle ? ` · ${item.taskTitle}` : ""}</p>
                                <p className="mt-2 text-sm text-neutral-700">{item.reason}{item.stage ? ` · ${item.stage}` : ""}</p>
                              </div>
                              <div className="shrink-0 text-left text-xs text-neutral-400 sm:text-right">
                                {item.completionDate && <p>Completed {formatDetailDate(item.completionDate)}</p>}
                                {item.lastActivityAt && <p>Last active {formatDetailDate(item.lastActivityAt)}</p>}
                                {item.dueDate && <p>Due {formatDueDate(item.dueDate)}</p>}
                                {item.missingFeedback && <p className="mt-1 font-semibold text-amber-700">Assessment feedback outstanding</p>}
                              </div>
                            </div>
                          </Link>
                        );
                      })}
                    </div>
                  )}

                </section>
              )}

              {overview.pendingApprovals > 0 && (
                <Link href="/teacher/approvals" className="mt-4 flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 hover:border-amber-300" data-testid="dashboard-pending-approvals">
                  <span><strong>{overview.pendingApprovals}</strong> student {overview.pendingApprovals === 1 ? "registration needs" : "registrations need"} review.</span>
                  <span className="font-semibold">View registrations →</span>
                </Link>
              )}
            </section>

          </div>
        )}

        <div className="flex items-center justify-between mb-8">
          <h2 className="text-3xl font-semibold tracking-tight">Your Classes</h2>
          <button 
            onClick={() => setShowNewClass(!showNewClass)}
            className="rounded-2xl bg-black text-white px-5 py-3 text-sm font-medium hover:opacity-90 transition-opacity"
            data-testid="button-new-class"
          >
            {showNewClass ? "Cancel" : "New Class"}
          </button>
        </div>

        {showNewClass && (
          <div className="mb-8 rounded-[2rem] bg-white border border-neutral-200 p-6 shadow-sm">
            <h3 className="text-lg font-semibold mb-4">Create New Class</h3>
            <form onSubmit={handleCreateClass} className="flex flex-col sm:flex-row gap-4 items-start sm:items-end">
              <div className="w-full sm:flex-1">
                    <label className="block text-sm font-medium mb-2">Class name</label>
                <input 
                  required
                  type="text"
                  value={newClassName}
                  onChange={(e) => setNewClassName(e.target.value)}
                  className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10"
                  placeholder="e.g. 10A"
                  data-testid="input-class-name"
                />
              </div>
              <div className="w-full sm:flex-1">
                <label className="block text-sm font-medium mb-2">Subject</label>
                <input 
                  type="text"
                  value={newClassSubject}
                  onChange={(e) => setNewClassSubject(e.target.value)}
                  className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10"
                  placeholder="e.g. Literature"
                  data-testid="input-class-subject"
                />
              </div>
              <button 
                type="submit"
                className="w-full sm:w-auto rounded-2xl bg-black text-white px-6 py-3 h-[50px] text-sm font-medium hover:opacity-90 transition-opacity"
                data-testid="button-create-class"
              >
                Create Class
              </button>
            </form>
          </div>
        )}

        {!overview || overview.classes.length === 0 ? (
          <div className="text-center py-20 bg-white rounded-[2rem] border border-neutral-200 shadow-sm">
            <h2 className="text-xl font-semibold">No active classes yet</h2>
            <p className="mt-2 text-neutral-500">Create a class when you are ready, or refresh to check for changes.</p>
            <button type="button" onClick={() => void overviewQuery.refetch()} className="mt-5 rounded-2xl border border-neutral-300 bg-white px-5 py-3 text-sm font-medium" data-testid="workspace-refresh">Refresh workspace</button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {overview.classes.map((cls) => {
              const hasCurrentTask = Boolean(cls.taskTitle);
              return (
              <div key={cls.id} className="relative group rounded-[2rem] bg-white border border-neutral-200 shadow-sm hover:shadow-md transition-shadow flex flex-col h-full">
                <Link 
                  href={`/teacher/class/${cls.id}`}
                  className="flex-1 p-5 flex flex-col block"
                  data-testid={`card-class-${cls.id}`}
                >
                  <div className="flex-1">
                    <h4 className="min-w-0 text-xl font-semibold tracking-tight [overflow-wrap:anywhere]">
                      {cls.name}
                    </h4>
                    {cls.subject && (
                      <p className="mt-1 text-sm text-neutral-500">{cls.subject}</p>
                    )}
                    
                    <div className="mt-4">
                      <p className="mb-1 text-xs uppercase tracking-[0.2em] text-neutral-400">Join code</p>
                      <p className="text-xl font-mono font-bold tracking-widest">{cls.code}</p>
                      <CopyButton code={cls.code} />
                    </div>

                    <div className="mt-4 p-3 bg-neutral-50 rounded-xl border border-neutral-100">
                      <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-neutral-400">Current task</p>
                      <p className="line-clamp-1 text-sm font-medium" title={cls.taskTitle ?? undefined}>
                        {cls.taskTitle ?? "Not set"}
                      </p>
                    </div>

                    <div className="mt-4 space-y-1 text-sm text-neutral-600">
                      <p>Students: {cls.enrolledCount}</p>
                      <p>Climbs complete: {cls.completedCount} of {cls.enrolledCount} · {cls.progressPercent}%</p>
                      <div className="space-y-0.5 pt-1">
                        {hasCurrentTask ? (
                          <>
                            <p>Formative: {cls.formativeAssessmentDate ? formatDueDate(cls.formativeAssessmentDate) : "Not set"}</p>
                            <p>Final deadline: {cls.dueDate ? formatDueDate(cls.dueDate) : "Not set"}</p>
                          </>
                        ) : (
                          <p className="text-neutral-400">Deadlines not set</p>
                        )}
                      </div>
                    </div>
                  </div>
                  
                  <div className="pt-3 mt-3 border-t border-neutral-100 flex items-center justify-end">
                    <span className="rounded-xl bg-black text-white px-4 py-2 text-sm font-medium hover:bg-neutral-800 transition-colors">
                      Open class →
                    </span>
                  </div>
                </Link>

              </div>
              );
            })}
          </div>
        )}
      </main>

    </div>
  );
}
