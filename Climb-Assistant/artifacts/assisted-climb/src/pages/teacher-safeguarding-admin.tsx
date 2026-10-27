import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useGetTeacherMe, getGetTeacherMeQueryKey } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { WorkspaceRequestState, classifyWorkspaceError, isUnauthorizedError } from "@/components/WorkspaceRequestState";

type TeacherDirectoryItem = {
  id: number;
  name: string;
  email: string;
  schoolAdminRole: "master" | "subadmin" | null;
  accountStatus: "active" | "suspended" | "deleted";
  approvalStatus: "pending" | "approved" | "rejected";
  canReviewSafeguarding: boolean;
};

type TeacherDirectoryResponse = { items: TeacherDirectoryItem[] };

const AUTHORIZATION_CONFIRMATION =
  "I confirm that this member of staff is authorised by the school to review safeguarding concerns within e-Assisted Climb.";

export default function TeacherSafeguardingAdmin() {
  const [, setLocation] = useLocation();
  const teacherQuery = useGetTeacherMe({ query: { queryKey: getGetTeacherMeQueryKey(), retry: false } });
  const { data: teacher, isLoading } = teacherQuery;
  const [items, setItems] = useState<TeacherDirectoryItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [error, setError] = useState("");
  const [savingId, setSavingId] = useState<number | null>(null);
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const directoryQuery = useQuery({
    queryKey: ["safeguarding-reviewer-directory"],
    enabled: teacher?.schoolAdminRole === "master",
    retry: false,
    queryFn: async () => await apiFetch(
      "/teacher/org/teachers?status=active&approvalStatus=approved&sort=name&direction=asc&page=1&pageSize=100",
    ) as TeacherDirectoryResponse,
  });

  useEffect(() => {
    if (teacherQuery.error && isUnauthorizedError(teacherQuery.error)) {
      setLocation("/teacher/login");
    } else if (teacher && teacher.schoolAdminRole !== "master") {
      setLocation("/teacher");
    }
  }, [teacher, teacherQuery.error, setLocation]);

  useEffect(() => {
    setLoadingItems(directoryQuery.isLoading);
    if (directoryQuery.data) setItems(directoryQuery.data.items);
    if (directoryQuery.error) {
      setError(directoryQuery.error instanceof Error ? directoryQuery.error.message : "Could not load staff.");
    }
  }, [directoryQuery.data, directoryQuery.error, directoryQuery.isLoading]);

  const updatePermission = async (target: TeacherDirectoryItem, enabled: boolean) => {
    setSavingId(target.id);
    setError("");
    try {
      await apiFetch(`/teacher/org/teacher/${target.id}/safeguarding-reviewer`, {
        method: "PUT",
        body: JSON.stringify({
          canReviewSafeguarding: enabled,
          ...(enabled ? { confirmation: AUTHORIZATION_CONFIRMATION } : {}),
        }),
      });
      setItems((current) => current.map((item) =>
        item.id === target.id ? { ...item, canReviewSafeguarding: enabled } : item,
      ));
      setConfirmingId(null);
      setConfirmed(false);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Could not update reviewer access.");
    } finally {
      setSavingId(null);
    }
  };

  if (teacherQuery.error && !isUnauthorizedError(teacherQuery.error)) {
    return (
      <WorkspaceRequestState
        workspace="Safeguarding reviewer access"
        state={classifyWorkspaceError(teacherQuery.error)}
        onRetry={() => void teacherQuery.refetch()}
      />
    );
  }
  if (isLoading || !teacher) {
    return <WorkspaceRequestState workspace="Safeguarding reviewer access" state="loading" />;
  }

  return (
    <main className="min-h-[100dvh] bg-neutral-50 px-4 py-8 text-neutral-900 sm:px-8">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-400">School governance</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">Safeguarding reviewer access</h1>
          </div>
          <Link href="/teacher" className="rounded-xl border border-neutral-200 bg-white px-4 py-2 text-sm font-medium hover:border-neutral-400">
            Back to dashboard
          </Link>
        </header>

        <section className="rounded-3xl border border-neutral-200 bg-white p-5 shadow-sm sm:p-7">
          <p className="max-w-3xl text-sm leading-6 text-neutral-600">
            Only staff explicitly assigned by the School Admin can open review items. School Admin status alone does not grant access. Removing access takes effect on the next request.
          </p>
          {error && <p role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</p>}

          {loadingItems ? (
            <p className="mt-6 text-sm text-neutral-500">Loading approved staff…</p>
          ) : items.length === 0 ? (
            <p className="mt-6 rounded-xl bg-neutral-50 px-4 py-3 text-sm text-neutral-600">No active, approved staff accounts were found.</p>
          ) : (
            <ul className="mt-6 divide-y divide-neutral-100">
              {items.map((member) => (
                <li key={member.id} className="py-5 first:pt-0 last:pb-0">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="break-words font-semibold">{member.name}</p>
                      <p className="break-all text-sm text-neutral-500">{member.email}</p>
                      {member.schoolAdminRole && (
                        <span className="mt-2 inline-flex rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-800">
                          {member.schoolAdminRole === "master" ? "School Admin" : "School Sub-admin"}
                        </span>
                      )}
                      {member.canReviewSafeguarding && (
                        <span className="mt-2 inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 sm:ml-2">
                          Safeguarding Reviewer
                        </span>
                      )}
                    </div>

                    {member.canReviewSafeguarding ? (
                      <button
                        type="button"
                        disabled={savingId === member.id}
                        onClick={() => void updatePermission(member, false)}
                        className="shrink-0 rounded-xl border border-rose-200 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                      >
                        {savingId === member.id ? "Saving…" : "Remove reviewer access"}
                      </button>
                    ) : confirmingId === member.id ? (
                      <div className="w-full max-w-md rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
                        <label className="flex items-start gap-3 text-sm leading-5 text-neutral-700">
                          <input
                            type="checkbox"
                            checked={confirmed}
                            onChange={(event) => setConfirmed(event.target.checked)}
                            className="mt-1 size-4 shrink-0 accent-neutral-900"
                          />
                          <span>{AUTHORIZATION_CONFIRMATION}</span>
                        </label>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={!confirmed || savingId === member.id}
                            onClick={() => void updatePermission(member, true)}
                            className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {savingId === member.id ? "Saving…" : "Confirm assignment"}
                          </button>
                          <button
                            type="button"
                            onClick={() => { setConfirmingId(null); setConfirmed(false); }}
                            className="rounded-xl border border-neutral-200 bg-white px-4 py-2 text-sm font-medium"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setConfirmingId(member.id); setConfirmed(false); }}
                        className="shrink-0 rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
                      >
                        Assign reviewer
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}