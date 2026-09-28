import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { apiFetch, clearTeacherToken } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

interface ArchivedClass {
  id: number;
  teacherId: number;
  name: string;
  subject: string | null;
  code: string;
  createdAt: string;
  archivedAt: string;
  archiveExpiresAt: string | null;
  archiveLifecycleStatus: string;
  archiveExpiryWarningSentAt: string | null;
  studentCount: number;
}

interface ArchivedStudentRecord {
  id: number;
  studentName: string;
  classId: number;
  className: string;
  archivedAt: string;
}

interface ScheduledDeletion {
  id: number;
  name: string;
  subject: string | null;
  teacherId: number;
  teacherName: string;
  deletionScheduledFor: string;
  deletionReason: string | null;
  studentCount: number;
  canRestoreAsSchoolMaster: boolean;
}

interface ScheduledStudentRecord {
  id: number;
  studentName: string;
  classId: number;
  className: string;
  teacherId: number;
  teacherName: string;
  deletionScheduledFor: string;
  canRestoreAsSchoolMaster: boolean;
}

interface TeacherArchiveResponse {
  warningWindowDays: number;
  archivedClasses: ArchivedClass[];
  archivedStudentRecords?: ArchivedStudentRecord[];
  scheduledDeletions: ScheduledDeletion[];
  scheduledStudentRecords: ScheduledStudentRecord[];
}

const emptyArchive: TeacherArchiveResponse = {
  warningWindowDays: 7,
  archivedClasses: [],
  archivedStudentRecords: [],
  scheduledDeletions: [],
  scheduledStudentRecords: [],
};

const archivedStudentRestorePrompt =
  "Restore this student record to active records? The student’s existing work and feedback will be preserved.";

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function TeacherArchive() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [teacher, setTeacher] = useState<any>(null);
  const [archive, setArchive] = useState<TeacherArchiveResponse>(emptyArchive);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unarchivingClass, setUnarchivingClass] = useState<number | null>(null);
  const [restoringClass, setRestoringClass] = useState<number | null>(null);
  const [restoringStudent, setRestoringStudent] = useState<number | null>(null);
  const [restoringArchivedStudent, setRestoringArchivedStudent] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<"classes" | "students">("classes");

  const loadArchive = async () => {
    const data = await apiFetch("/teacher/archive");
    const archivedClasses = Array.isArray(data?.archivedClasses) ? data.archivedClasses : [];
    const archivedStudentRecords = Array.isArray(data?.archivedStudentRecords)
      ? data.archivedStudentRecords
      : [];
    setArchive({
      warningWindowDays: Number.isInteger(data?.warningWindowDays) ? data.warningWindowDays : 7,
      archivedClasses,
      archivedStudentRecords,
      scheduledDeletions: Array.isArray(data?.scheduledDeletions) ? data.scheduledDeletions : [],
      scheduledStudentRecords: Array.isArray(data?.scheduledStudentRecords) ? data.scheduledStudentRecords : [],
    });
  };

  useEffect(() => {
    Promise.all([
      apiFetch("/auth/me").then(setTeacher),
      loadArchive(),
    ])
      .catch((err: any) => {
        setError(err.message ?? "The archive could not be loaded.");
        if (err.status === 401) setLocation("/teacher/login");
      })
      .finally(() => setLoading(false));
  }, [setLocation]);

  const handleSignOut = async () => {
    try { await apiFetch("/auth/logout", { method: "POST" }); } catch {}
    clearTeacherToken();
    setLocation("/");
  };

  const restoreClass = async (item: ScheduledDeletion) => {
    setRestoringClass(item.id);
    try {
      const endpoint = item.canRestoreAsSchoolMaster
        ? `/teacher/org/deletion-requests/classes/${item.id}/restore`
        : `/teacher/classes/${item.id}/restore-deletion`;
      await apiFetch(endpoint, { method: "POST" });
      await loadArchive();
      toast({
        title: "Class deletion restored",
        description: "The class and its student records are active again.",
      });
    } catch (err: any) {
      toast({ title: "Could not restore class", description: err.message, variant: "destructive" });
    } finally {
      setRestoringClass(null);
    }
  };

  const reopenClass = async (item: ArchivedClass) => {
    setUnarchivingClass(item.id);
    try {
      await apiFetch(`/teacher/classes/${item.id}/unarchive`, { method: "POST" });
      await loadArchive();
      toast({
        title: "Class reopened",
        description: `${item.name} is active again.`,
      });
    } catch (err: any) {
      toast({ title: "Could not reopen class", description: err.message, variant: "destructive" });
    } finally {
      setUnarchivingClass(null);
    }
  };

  const restoreStudent = async (item: ScheduledStudentRecord) => {
    setRestoringStudent(item.id);
    try {
      const endpoint = item.canRestoreAsSchoolMaster
        ? `/teacher/org/deletion-requests/students/${item.id}/restore`
        : `/teacher/classes/${item.classId}/students/${item.id}/restore-deletion`;
      await apiFetch(endpoint, { method: "POST" });
      await loadArchive();
      toast({
        title: "Student record restored",
        description: `${item.studentName}'s record is available in ${item.className} again.`,
      });
    } catch (err: any) {
      toast({ title: "Could not restore student record", description: err.message, variant: "destructive" });
    } finally {
      setRestoringStudent(null);
    }
  };

  const restoreArchivedStudent = async (item: ArchivedStudentRecord) => {
    if (!window.confirm(archivedStudentRestorePrompt)) return;
    setRestoringArchivedStudent(item.id);
    try {
      await apiFetch(`/teacher/classes/${item.classId}/students/${item.id}/restore-archive`, {
        method: "POST",
        body: JSON.stringify({ confirmation: "RESTORE TO ACTIVE RECORDS" }),
      });
      await loadArchive();
      toast({
        title: "Student record restored",
        description: `${item.studentName}'s record is active again.`,
      });
    } catch (err: any) {
      toast({ title: "Could not restore student record", description: err.message, variant: "destructive" });
    } finally {
      setRestoringArchivedStudent(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-[100dvh] bg-neutral-50 px-6 py-20 text-center text-sm text-neutral-500">
        Loading archive…
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-neutral-50 font-sans text-neutral-900">
      <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-2 text-sm">
            <Link href="/teacher/dashboard" className="text-neutral-500 transition-colors hover:text-black">Dashboard</Link>
            <span className="text-neutral-300">/</span>
            <span className="font-medium">Archive/Delete</span>
          </div>
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-5 text-sm">
            <span className="min-w-0 text-neutral-600 [overflow-wrap:anywhere]">
              {teacher?.name}
              {teacher?.schoolAdminRole && (
                <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                   {teacher.schoolAdminRole === "master" ? "School Admin" : "School Sub-admin"}
                </span>
              )}
            </span>
            <Link href="/teacher/settings" className="text-neutral-500 transition-colors hover:text-black">Settings</Link>
            <button onClick={handleSignOut} className="text-neutral-500 transition-colors hover:text-black">Sign Out</button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-8 px-6 py-12">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-neutral-400">Teacher workspace</p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight">Archive</h1>
          <p className="mt-3 max-w-3xl text-neutral-500">
            View archived classes and individual student records, check scheduled deletion dates, and restore eligible records.
          </p>
          <p className="mt-2 max-w-3xl text-sm text-neutral-600">
            Archived records are kept securely and become read-only. Records pending deletion can be restored until the date shown.
          </p>
        </div>

        {error && (
          <div role="alert" className="rounded-[2rem] border border-red-200 bg-red-50 px-6 py-5 text-sm text-red-800">{error}</div>
        )}

        <div className="flex w-full gap-2 rounded-2xl border border-neutral-200 bg-white p-1.5 sm:w-fit" role="tablist" aria-label="Archive record type">
          {(["classes", "students"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 rounded-xl px-6 py-2.5 text-sm font-semibold capitalize transition-colors sm:flex-none ${
                activeTab === tab ? "bg-neutral-900 text-white" : "text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {activeTab === "classes" ? (
          <>
            <section className="rounded-[2rem] border border-amber-200 bg-amber-50/60 p-5 shadow-sm sm:p-8" data-testid="archived-classes-section">
              <h2 className="text-2xl font-semibold text-amber-950">Archived classes</h2>
              {archive.archivedClasses.length === 0 ? (
                <p className="mt-6 rounded-2xl border border-amber-200/80 bg-white/70 px-5 py-4 text-sm text-amber-950/70">No archived classes.</p>
              ) : (
                <div className="mt-6 grid gap-4 md:grid-cols-2">
                  {archive.archivedClasses.map((item) => (
                    <article key={item.id} className="flex min-w-0 flex-col justify-between gap-5 rounded-2xl border border-amber-200 bg-white p-5">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="min-w-0 text-lg font-semibold [overflow-wrap:anywhere]">{item.name}</h3>
                          <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800">Read only</span>
                        </div>
                        {item.subject && <p className="mt-1 text-sm text-neutral-500">{item.subject}</p>}
                        <p className="mt-3 text-sm text-neutral-700">{item.studentCount} {item.studentCount === 1 ? "student record" : "student records"}</p>
                        <p className="mt-3 text-xs text-neutral-500">Archived {formatDate(item.archivedAt)}</p>
                        <p className="mt-1 text-xs text-neutral-500">{item.archiveExpiresAt ? `Archive expires ${formatDate(item.archiveExpiresAt)}` : "Expiry date will be assigned by the retention worker"}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Link href={`/teacher/class/${item.id}`} className="rounded-xl border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50">View archived class</Link>
                        {item.teacherId === teacher?.id && (
                          <button type="button" onClick={() => reopenClass(item)} disabled={unarchivingClass === item.id} className="rounded-xl border border-emerald-200 px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
                            {unarchivingClass === item.id ? "Reopening…" : "Reopen class"}
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-[2rem] border border-red-200 bg-red-50/60 p-5 shadow-sm sm:p-8" data-testid="scheduled-deletions-section">
              <h2 className="text-2xl font-semibold text-red-950">Classes pending deletion</h2>
              {archive.scheduledDeletions.length === 0 ? (
                <p className="mt-6 rounded-2xl border border-red-200/80 bg-white/70 px-5 py-4 text-sm text-red-950/70">No classes pending deletion.</p>
              ) : (
                <div className="mt-6 space-y-3">
                  {archive.scheduledDeletions.map((item) => (
                    <article key={item.id} className="flex flex-col gap-4 rounded-2xl border border-red-200 bg-white p-5 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <h3 className="font-semibold">{item.name}</h3>
                        {item.subject && <p className="mt-1 text-sm text-neutral-500">{item.subject}</p>}
                        <p className="mt-2 text-sm text-neutral-700">{item.studentCount} {item.studentCount === 1 ? "student record" : "student records"}</p>
                        <p className="mt-2 text-sm text-red-900/75">Recovery deadline: <strong>{formatDate(item.deletionScheduledFor)}</strong></p>
                      </div>
                      <button onClick={() => restoreClass(item)} disabled={restoringClass === item.id} className="shrink-0 rounded-xl border border-neutral-300 bg-white px-4 py-2 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50">
                        {restoringClass === item.id ? "Restoring…" : "Restore class"}
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : (
          <>
            <section className="rounded-[2rem] border border-amber-200 bg-amber-50/60 p-5 shadow-sm sm:p-8" data-testid="archived-student-records">
              <h2 className="text-2xl font-semibold text-amber-950">Individually archived students</h2>
              {!archive.archivedStudentRecords?.length ? (
                <p className="mt-6 rounded-2xl border border-amber-200/80 bg-white/70 px-5 py-4 text-sm text-amber-950/70">No individually archived students.</p>
              ) : (
                <div className="mt-6 space-y-3">
                  {archive.archivedStudentRecords.map((item) => (
                    <article key={item.id} className="flex flex-col gap-4 rounded-2xl border border-amber-200 bg-white p-5 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <h3 className="font-semibold">{item.studentName}</h3>
                        <p className="mt-1 text-sm text-neutral-500">{item.className}</p>
                        <p className="mt-2 text-sm text-neutral-600">Archived {formatDate(item.archivedAt)}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Link href={`/teacher/class/${item.classId}/student/${item.id}`} className="rounded-xl border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50">View read-only record</Link>
                        <button type="button" onClick={() => restoreArchivedStudent(item)} disabled={restoringArchivedStudent === item.id} className="rounded-xl border border-emerald-200 px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
                          {restoringArchivedStudent === item.id ? "Restoring…" : "Restore record"}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-[2rem] border border-red-200 bg-red-50/60 p-5 shadow-sm sm:p-8">
              <h2 className="text-2xl font-semibold text-red-950">Individual students pending deletion</h2>
              {archive.scheduledStudentRecords.length === 0 ? (
                <p className="mt-6 rounded-2xl border border-red-200/80 bg-white/70 px-5 py-4 text-sm text-red-950/70">No individual students pending deletion.</p>
              ) : (
                <div className="mt-6 space-y-3">
                  {archive.scheduledStudentRecords.map((item) => (
                    <article key={item.id} className="flex flex-col gap-4 rounded-2xl border border-red-200 bg-white p-5 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <h3 className="font-semibold">{item.studentName}</h3>
                        <p className="mt-1 text-sm text-neutral-500">{item.className}</p>
                        <p className="mt-2 text-sm text-red-900/75">Deletion date: <strong>{formatDate(item.deletionScheduledFor)}</strong></p>
                      </div>
                      <button onClick={() => restoreStudent(item)} disabled={restoringStudent === item.id} className="shrink-0 rounded-xl border border-neutral-300 bg-white px-4 py-2 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50">
                        {restoringStudent === item.id ? "Restoring…" : "Restore record"}
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}