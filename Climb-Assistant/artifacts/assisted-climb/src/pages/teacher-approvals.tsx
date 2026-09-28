import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetTeacherDashboardOverviewQueryKey,
  getGetTeacherMeQueryKey,
  getListClassStudentsQueryKey,
  useGetTeacherDashboardOverview,
  useGetTeacherMe,
} from "@workspace/api-client-react";
import { apiFetch, clearTeacherToken } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import {
  classifyWorkspaceError,
  isUnauthorizedError,
  WorkspaceRequestState,
} from "@/components/WorkspaceRequestState";

type PendingApproval = {
  id: number;
  classId: number;
  className: string;
  studentName: string;
  createdAt: string;
};

export default function TeacherApprovals() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [loadingApprovals, setLoadingApprovals] = useState(true);
  const [approvalsError, setApprovalsError] = useState<Error | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);

  const teacherQuery = useGetTeacherMe({
    query: { queryKey: getGetTeacherMeQueryKey(), retry: false },
  });
  const overviewQuery = useGetTeacherDashboardOverview({
    query: {
      enabled: Boolean(teacherQuery.data),
      queryKey: getGetTeacherDashboardOverviewQueryKey(),
      retry: false,
    },
  });

  useEffect(() => {
    if (teacherQuery.error && isUnauthorizedError(teacherQuery.error)) {
      setLocation("/teacher/login");
    } else if (teacherQuery.data?.isItAdmin) {
      setLocation("/teacher/settings");
    }
  }, [setLocation, teacherQuery.data, teacherQuery.error]);

  useEffect(() => {
    let cancelled = false;
    const classes = overviewQuery.data?.classes ?? [];
    if (!overviewQuery.data) return;
    if (classes.length === 0) {
      setApprovals([]);
      setLoadingApprovals(false);
      return;
    }

    setLoadingApprovals(true);
    setApprovalsError(null);
    Promise.all(
      classes.map(async (cls) => {
        const data = await apiFetch(`/teacher/classes/${cls.id}/students`);
        const students = Array.isArray(data) ? data : [];
        return students
          .filter((student: any) => student.registrationStatus === "pending")
          .map((student: any) => ({
            id: student.id,
            classId: cls.id,
            className: cls.name,
            studentName: student.studentName,
            createdAt: student.createdAt,
          }));
      }),
    )
      .then((groups) => {
        if (!cancelled) {
          setApprovals(groups.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
        }
      })
      .catch((error: Error) => {
        if (!cancelled) setApprovalsError(error);
      })
      .finally(() => {
        if (!cancelled) setLoadingApprovals(false);
      });

    return () => {
      cancelled = true;
    };
  }, [overviewQuery.data]);

  const handleSignOut = async () => {
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } catch {}
    clearTeacherToken();
    setLocation("/");
  };

  const handleDecision = async (approval: PendingApproval, decision: "approve" | "reject") => {
    const action = decision === "approve" ? "Approve" : "Reject";
    if (!window.confirm(`${action} ${approval.studentName}'s registration for ${approval.className}?`)) return;

    const key = `${approval.classId}:${approval.id}`;
    setReviewing(key);
    try {
      await apiFetch(`/teacher/classes/${approval.classId}/students/${approval.id}/${decision}`, {
        method: "POST",
      });
      setApprovals((current) => current.filter((item) => item.id !== approval.id || item.classId !== approval.classId));
      queryClient.invalidateQueries({ queryKey: getGetTeacherDashboardOverviewQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListClassStudentsQueryKey(approval.classId) });
      toast({
        title: `${approval.studentName}'s registration ${decision === "approve" ? "approved" : "rejected"}`,
      });
    } catch (error: any) {
      toast({
        title: `Could not ${decision} registration`,
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setReviewing(null);
    }
  };

  const workspaceError = teacherQuery.error ?? overviewQuery.error ?? approvalsError;
  if (workspaceError && !isUnauthorizedError(workspaceError)) {
    return (
      <WorkspaceRequestState
        workspace="Pending approvals"
        state={classifyWorkspaceError(workspaceError)}
        onRetry={() => {
          if (teacherQuery.error) void teacherQuery.refetch();
          else if (overviewQuery.error) void overviewQuery.refetch();
          else if (overviewQuery.data) {
            setApprovalsError(null);
            void overviewQuery.refetch();
          }
        }}
      />
    );
  }

  if (
    teacherQuery.isLoading
    || (teacherQuery.data && overviewQuery.isLoading)
    || loadingApprovals
  ) {
    return <WorkspaceRequestState workspace="Pending approvals" state="loading" />;
  }

  return (
    <div className="min-h-[100dvh] bg-neutral-50 text-neutral-900 font-sans">
      <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/90 backdrop-blur">
        <div className="max-w-4xl mx-auto px-6 py-4 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">
              The Assisted Climb <span className="text-neutral-400 font-normal ml-2">Pending Approvals</span>
            </h1>
          </div>
          <div className="flex max-w-full flex-wrap items-center gap-x-4 gap-y-2 text-sm sm:gap-6">
            <span className="text-neutral-600">{teacherQuery.data?.name}</span>
            <Link href="/teacher/dashboard" className="text-neutral-500 hover:text-black transition-colors">
              Dashboard
            </Link>
            <Link href="/teacher/settings" className="text-neutral-500 hover:text-black transition-colors">
              Settings
            </Link>
            <button onClick={handleSignOut} className="text-neutral-500 hover:text-black transition-colors">
              Sign Out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-12">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between mb-8">
          <div>
            <Link href="/teacher/dashboard" className="text-sm text-neutral-500 hover:text-black">
              ← Back to dashboard
            </Link>
            <h2 className="text-3xl font-semibold tracking-tight mt-4">Students waiting for approval</h2>
            <p className="text-neutral-500 mt-2">
              Review registrations from students who have joined one of your classes.
            </p>
          </div>
          <span className="self-start rounded-full bg-amber-50 border border-amber-200 px-3 py-1 text-sm font-medium text-amber-800">
            {approvals.length} waiting
          </span>
        </div>

        {approvals.length === 0 ? (
          <div className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm p-10 text-center">
            <div className="text-4xl mb-4">✓</div>
            <h3 className="text-xl font-semibold">No registrations need approval</h3>
            <p className="text-sm text-neutral-500 mt-2">
              New student registrations will appear here.
            </p>
            <Link
              href="/teacher/dashboard"
              className="inline-flex mt-6 rounded-2xl bg-black text-white px-5 py-3 text-sm font-medium hover:bg-neutral-800"
            >
              Return to dashboard
            </Link>
          </div>
        ) : (
          <div className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden divide-y divide-neutral-100">
            {approvals.map((approval) => {
              const key = `${approval.classId}:${approval.id}`;
              const isReviewing = reviewing === key;
              return (
                <div key={key} className="p-5 sm:p-6 flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-lg font-semibold break-words">{approval.studentName}</p>
                    <p className="text-sm text-neutral-500 mt-1">
                      Class: <span className="font-medium text-neutral-700">{approval.className}</span>
                    </p>
                    <p className="text-xs text-neutral-400 mt-2">
                      Registered {new Date(approval.createdAt).toLocaleDateString("en-GB")}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <Link
                      href={`/teacher/class/${approval.classId}`}
                      className="rounded-xl border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50"
                    >
                      View class
                    </Link>
                    <button
                      type="button"
                      onClick={() => void handleDecision(approval, "reject")}
                      disabled={isReviewing}
                      className="rounded-xl border border-red-200 text-red-700 px-3 py-2 text-sm font-medium hover:bg-red-50 disabled:opacity-50"
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDecision(approval, "approve")}
                      disabled={isReviewing}
                      className="rounded-xl bg-emerald-600 text-white px-3 py-2 text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {isReviewing ? "Saving…" : "Approve"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}