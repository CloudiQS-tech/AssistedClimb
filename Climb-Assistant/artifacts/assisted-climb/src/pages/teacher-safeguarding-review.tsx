import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useGetTeacherMe, getGetTeacherMeQueryKey } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import { WorkspaceRequestState, classifyWorkspaceError, isUnauthorizedError } from "@/components/WorkspaceRequestState";

type ReviewStatus = "new" | "under_review" | "closed";
type ReviewQueueItem = {
  id: number;
  caseReference: string;
  category: string;
  technicalReason: string;
  status: ReviewStatus;
  sourceType: "student_ai" | "climb";
  sourceLocation: string;
  studentName: string;
  className: string;
  createdAt: string;
  reviewerName: string | null;
};
type AuditEntry = {
  id: number;
  action: string;
  createdAt: string;
  actorName: string | null;
  metadata: Record<string, unknown>;
};
type ReviewItem = ReviewQueueItem & {
  schoolName: string;
  excerpt: string;
  surroundingContext: string;
  detectedBy: "local" | "provider" | "both";
  providerSignals: Array<{ provider: "azure" | "gemini"; categories: string[] }>;
  reviewerId: number | null;
  reviewerEmail: string | null;
  reviewedAt: string | null;
  actionTaken: string | null;
  decision: string | null;
  rationale: string | null;
  outcome: string | null;
  externalReference: string | null;
  notificationStatus: string;
  updatedAt: string;
  closedAt: string | null;
  auditHistory: AuditEntry[];
};
type ReviewListResponse = {
  items: ReviewQueueItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};
type ReviewDetailResponse = { item: ReviewItem };

const CATEGORY_LABELS: Record<string, string> = {
  self_harm_or_suicide: "Self-harm or suicide",
  harm_by_another_person: "Harm by another person",
  sexual_abuse_or_exploitation: "Sexual abuse or exploitation",
  serious_violence_or_threat: "Serious violence or threat",
  grooming_coercion_or_blackmail: "Grooming, coercion or blackmail",
  immediate_danger: "Immediate danger",
  other_serious_concern: "Other serious concern",
  provider_safety_signal: "AI provider safety flag",
};

function providerSignalCategoryLabel(category: string): string {
  if (category === "assistant_output_blocked") return "AI reply blocked by provider safety filter";
  return category.replaceAll("_", " ");
}

function formatDate(value: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Not recorded"
    : date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

function statusLabel(status: ReviewStatus): string {
  return status === "under_review" ? "Under review" : status === "closed" ? "Closed" : "New";
}

function isForbiddenError(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && "status" in error
      && (error as { status?: unknown }).status === 403,
  );
}

export default function TeacherSafeguardingReview() {
  const [, setLocation] = useLocation();
  const teacherQuery = useGetTeacherMe({
    query: {
      queryKey: getGetTeacherMeQueryKey(),
      retry: false,
      refetchOnWindowFocus: false,
    },
  });
  const { data: teacher, isLoading: teacherLoading } = teacherQuery;
  const [accessRevoked, setAccessRevoked] = useState(false);
  const [status, setStatus] = useState<"all" | ReviewStatus>("all");
  const [page, setPage] = useState(1);
  const [list, setList] = useState<ReviewListResponse | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ReviewItem | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus>("new");
  const [actionTaken, setActionTaken] = useState("");
  const [decision, setDecision] = useState("");
  const [rationale, setRationale] = useState("");
  const [outcome, setOutcome] = useState("");
  const [externalReference, setExternalReference] = useState("");

  const clearReviewerData = useCallback(() => {
    setAccessRevoked(true);
    setList(null);
    setListLoading(false);
    setListError("");
    setSelectedId(null);
    setDetail(null);
    setDetailLoading(false);
    setDetailError("");
    setSaveError("");
    setSaving(false);
    setReviewStatus("new");
    setActionTaken("");
    setDecision("");
    setRationale("");
    setOutcome("");
    setExternalReference("");
    void teacherQuery.refetch();
  }, [teacherQuery.refetch]);

  useEffect(() => {
    if (teacherQuery.error && isUnauthorizedError(teacherQuery.error)) {
      setLocation("/teacher/login");
    }
  }, [teacherQuery.error, setLocation]);

  useEffect(() => {
    if (accessRevoked) return;
    const revalidateAccess = () => {
      if (document.visibilityState === "visible") void teacherQuery.refetch();
    };
    window.addEventListener("focus", revalidateAccess);
    document.addEventListener("visibilitychange", revalidateAccess);
    return () => {
      window.removeEventListener("focus", revalidateAccess);
      document.removeEventListener("visibilitychange", revalidateAccess);
    };
  }, [accessRevoked, teacherQuery.refetch]);

  useEffect(() => {
    if (!accessRevoked && teacher && !teacher.canReviewSafeguarding) {
      clearReviewerData();
    }
  }, [accessRevoked, clearReviewerData, teacher?.canReviewSafeguarding]);

  useEffect(() => {
    if (accessRevoked || !teacher?.canReviewSafeguarding) return;
    let current = true;
    setListLoading(true);
    setListError("");
    apiFetch(`/teacher/safeguarding/items?status=${status}&page=${page}`)
      .then((result) => {
        if (current) setList(result as ReviewListResponse);
      })
      .catch((error) => {
        if (!current) return;
        if (isForbiddenError(error)) {
          clearReviewerData();
          return;
        }
        setListError(error instanceof Error ? error.message : "Could not load review items.");
      })
      .finally(() => {
        if (current) setListLoading(false);
      });
    return () => { current = false; };
  }, [accessRevoked, clearReviewerData, teacher?.canReviewSafeguarding, status, page]);

  useEffect(() => {
    if (accessRevoked || selectedId === null || !teacher?.canReviewSafeguarding) {
      setDetail(null);
      return;
    }
    let current = true;
    setDetailLoading(true);
    setDetailError("");
    apiFetch(`/teacher/safeguarding/items/${selectedId}`)
      .then((result) => {
        if (!current) return;
        const response = result as ReviewDetailResponse;
        setDetail(response.item);
        setReviewStatus(response.item.status);
        setActionTaken(response.item.actionTaken ?? "");
        setDecision(response.item.decision ?? "");
        setRationale(response.item.rationale ?? "");
        setOutcome(response.item.outcome ?? "");
        setExternalReference(response.item.externalReference ?? "");
      })
      .catch((error) => {
        if (!current) return;
        if (isForbiddenError(error)) {
          clearReviewerData();
          return;
        }
        setDetailError(error instanceof Error ? error.message : "Could not open this review item.");
      })
      .finally(() => {
        if (current) setDetailLoading(false);
      });
    return () => { current = false; };
  }, [accessRevoked, clearReviewerData, selectedId, teacher?.canReviewSafeguarding]);

  const saveReview = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!detail) return;
    setSaving(true);
    setSaveError("");
    try {
      const result = await apiFetch(`/teacher/safeguarding/items/${detail.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: reviewStatus,
          actionTaken,
          decision,
          rationale,
          outcome,
          externalReference,
        }),
      });
      const response = result as ReviewDetailResponse;
      setDetail(response.item);
      setList((current) => current
        ? {
            ...current,
            items: current.items.map((item) => item.id === response.item.id
              ? { ...item, status: response.item.status, reviewerName: response.item.reviewerName }
              : item),
          }
        : current);
    } catch (error) {
      if (isForbiddenError(error)) {
        clearReviewerData();
        return;
      }
      setSaveError(error instanceof Error ? error.message : "Could not save your review.");
    } finally {
      setSaving(false);
    }
  };

  if (accessRevoked || (teacher && !teacher.canReviewSafeguarding)) {
    return (
      <main className="min-h-[100dvh] bg-neutral-50 px-4 py-10">
        <section className="mx-auto max-w-xl rounded-3xl border border-neutral-200 bg-white p-7 text-center shadow-sm">
          <h1 className="text-xl font-semibold">Reviewer access required</h1>
          <p className="mt-2 text-sm leading-6 text-neutral-600">A School Admin must explicitly assign you as a Safeguarding Reviewer before you can open review items.</p>
          <Link href="/teacher" className="mt-5 inline-flex rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white">Back to dashboard</Link>
        </section>
      </main>
    );
  }

  if (teacherQuery.error && !isUnauthorizedError(teacherQuery.error)) {
    return (
      <WorkspaceRequestState
        workspace="Safeguarding review"
        state={classifyWorkspaceError(teacherQuery.error)}
        onRetry={() => void teacherQuery.refetch()}
      />
    );
  }
  if (teacherLoading || !teacher) {
    return <WorkspaceRequestState workspace="Safeguarding review" state="loading" />;
  }
  return (
    <main className="min-h-[100dvh] bg-neutral-50 px-4 py-7 text-neutral-900 sm:px-8">
      <div className="mx-auto max-w-7xl">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-400">Restricted safeguarding area</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">Safeguarding review</h1>
          </div>
          <Link href="/teacher" className="rounded-xl border border-neutral-200 bg-white px-4 py-2 text-sm font-medium hover:border-neutral-400">Back to dashboard</Link>
        </header>

        <p className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
          These items prompt a human review. Screening signals are not a finding, diagnosis, risk score, or safeguarding decision. Follow your school’s safeguarding policy and local procedures.
        </p>

        <div className="grid gap-5 lg:grid-cols-[minmax(300px,0.8fr)_minmax(0,1.4fr)]">
          <section className="overflow-hidden rounded-3xl border border-neutral-200 bg-white shadow-sm" aria-label="Review queue">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-100 p-4">
              <div>
                <h2 className="font-semibold">Review items</h2>
                <p className="mt-0.5 text-xs text-neutral-500">{list?.total ?? 0} matching items</p>
              </div>
              <label className="text-xs font-medium text-neutral-600">
                Status
                <select
                  value={status}
                  onChange={(event) => { setStatus(event.target.value as typeof status); setPage(1); }}
                  className="ml-2 rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-sm"
                >
                  <option value="all">All</option>
                  <option value="new">New</option>
                  <option value="under_review">Under review</option>
                  <option value="closed">Closed</option>
                </select>
              </label>
            </div>
            {listError && <p role="alert" className="m-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{listError}</p>}
            {listLoading ? (
              <p className="p-5 text-sm text-neutral-500">Loading review items…</p>
            ) : !list || list.items.length === 0 ? (
              <p className="p-5 text-sm text-neutral-500">No review items match this filter.</p>
            ) : (
              <ul className="max-h-[68vh] divide-y divide-neutral-100 overflow-auto">
                {list.items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(item.id)}
                      aria-current={selectedId === item.id ? "true" : undefined}
                      className={`w-full px-4 py-4 text-left transition hover:bg-neutral-50 ${selectedId === item.id ? "bg-neutral-50 ring-2 ring-inset ring-neutral-900" : ""}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <span className="font-mono text-xs font-semibold text-neutral-500">{item.caseReference}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${item.status === "closed" ? "bg-neutral-100 text-neutral-600" : item.status === "under_review" ? "bg-sky-50 text-sky-800" : "bg-amber-50 text-amber-800"}`}>
                          {statusLabel(item.status)}
                        </span>
                      </div>
                      <p className="mt-2 text-sm font-semibold">{CATEGORY_LABELS[item.category] ?? "Safeguarding review"}</p>
                      <p className="mt-1 text-sm text-neutral-600">{item.studentName} · {item.className}</p>
                      <p className="mt-1 text-xs text-neutral-500">{item.sourceLocation} · {formatDate(item.createdAt)}</p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center justify-between border-t border-neutral-100 px-4 py-3">
              <button type="button" disabled={page <= 1 || listLoading} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm disabled:opacity-40">Previous</button>
              <span className="text-xs text-neutral-500">Page {list?.page ?? page} of {list?.totalPages ?? 1}</span>
              <button type="button" disabled={!list || page >= list.totalPages || listLoading} onClick={() => setPage((value) => value + 1)} className="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm disabled:opacity-40">Next</button>
            </div>
          </section>

          <section className="min-w-0 rounded-3xl border border-neutral-200 bg-white p-5 shadow-sm sm:p-7" aria-label="Review item details">
            {!selectedId ? (
              <div className="flex min-h-64 items-center justify-center text-center text-sm text-neutral-500">Select an item to review.</div>
            ) : detailLoading ? (
              <p className="py-8 text-sm text-neutral-500">Opening review item…</p>
            ) : detailError ? (
              <p role="alert" className="rounded-xl bg-rose-50 p-4 text-sm text-rose-800">{detailError}</p>
            ) : detail ? (
              <div className="space-y-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-mono text-xs font-semibold text-neutral-500">{detail.caseReference}</p>
                    <h2 className="mt-1 text-xl font-semibold">{CATEGORY_LABELS[detail.category] ?? "Safeguarding review"}</h2>
                    <p className="mt-1 text-sm text-neutral-500">{detail.studentName} · {detail.className} · {detail.schoolName}</p>
                  </div>
                  <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-semibold">{statusLabel(detail.status)}</span>
                </div>

                <dl className="grid gap-3 rounded-2xl bg-neutral-50 p-4 text-sm sm:grid-cols-2">
                  <div><dt className="text-xs text-neutral-500">Source</dt><dd className="mt-1 font-medium">{detail.sourceLocation}</dd></div>
                  <div><dt className="text-xs text-neutral-500">Received</dt><dd className="mt-1 font-medium">{formatDate(detail.createdAt)}</dd></div>
                  <div><dt className="text-xs text-neutral-500">Reviewer</dt><dd className="mt-1 font-medium">{detail.reviewerName ?? "Not yet assigned through review"}</dd></div>
                  <div><dt className="text-xs text-neutral-500">Notification status</dt><dd className="mt-1 font-medium">{detail.notificationStatus.replaceAll("_", " ")}</dd></div>
                </dl>

                <section>
                  <h3 className="text-sm font-semibold">Submitted text excerpt</h3>
                  <blockquote className="mt-2 whitespace-pre-wrap rounded-2xl border border-neutral-200 bg-neutral-50 p-4 text-sm leading-6 text-neutral-800">{detail.excerpt}</blockquote>
                  {detail.surroundingContext && (
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-neutral-600">{detail.surroundingContext}</p>
                  )}
                </section>

                {(detail.detectedBy !== "local" || detail.providerSignals.length > 0) && (
                  <section className="rounded-2xl border border-sky-200 bg-sky-50 p-4">
                    <h3 className="text-sm font-semibold text-sky-950">Supporting screening context</h3>
                    <p className="mt-1 text-xs leading-5 text-sky-900">Provider signals are annotations returned by an existing Student AI request. They do not decide whether a concern is present.</p>
                    {detail.providerSignals.map((signal, index) => (
                      <p key={`${signal.provider}-${index}`} className="mt-2 text-sm text-sky-950">
                        {signal.provider === "azure" ? "Azure OpenAI" : "Gemini"}: {signal.categories.map(providerSignalCategoryLabel).join(", ")}
                      </p>
                    ))}
                  </section>
                )}

                <form onSubmit={saveReview} className="space-y-4 border-t border-neutral-100 pt-5">
                  <h3 className="font-semibold">Record your review</h3>
                  <label className="block text-sm font-medium">
                    Review status
                    <select value={reviewStatus} onChange={(event) => setReviewStatus(event.target.value as ReviewStatus)} className="mt-1.5 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2">
                      <option value="new">New</option>
                      <option value="under_review">Under review</option>
                      <option value="closed">Closed</option>
                    </select>
                  </label>
                  <label className="block text-sm font-medium">
                    Action taken
                    <textarea value={actionTaken} onChange={(event) => setActionTaken(event.target.value)} rows={3} maxLength={2000} className="mt-1.5 w-full rounded-xl border border-neutral-200 px-3 py-2 font-normal" />
                  </label>
                  <label className="block text-sm font-medium">
                    Decision
                    <textarea value={decision} onChange={(event) => setDecision(event.target.value)} rows={2} maxLength={500} className="mt-1.5 w-full rounded-xl border border-neutral-200 px-3 py-2 font-normal" />
                  </label>
                  <label className="block text-sm font-medium">
                    Rationale
                    <textarea value={rationale} onChange={(event) => setRationale(event.target.value)} rows={3} maxLength={3000} className="mt-1.5 w-full rounded-xl border border-neutral-200 px-3 py-2 font-normal" />
                  </label>
                  <label className="block text-sm font-medium">
                    Outcome
                    <textarea value={outcome} onChange={(event) => setOutcome(event.target.value)} rows={3} maxLength={2000} className="mt-1.5 w-full rounded-xl border border-neutral-200 px-3 py-2 font-normal" />
                  </label>
                  <label className="block text-sm font-medium">
                    External reference (optional)
                    <input value={externalReference} onChange={(event) => setExternalReference(event.target.value)} maxLength={250} className="mt-1.5 w-full rounded-xl border border-neutral-200 px-3 py-2 font-normal" />
                  </label>
                  {saveError && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{saveError}</p>}
                  <button type="submit" disabled={saving} className="rounded-xl bg-neutral-900 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
                    {saving ? "Saving…" : "Save review"}
                  </button>
                </form>

                <details className="border-t border-neutral-100 pt-4">
                  <summary className="cursor-pointer text-sm font-semibold">Audit history ({detail.auditHistory.length})</summary>
                  {detail.auditHistory.length === 0 ? (
                    <p className="mt-3 text-sm text-neutral-500">No audit events recorded.</p>
                  ) : (
                    <ol className="mt-3 space-y-3">
                      {detail.auditHistory.map((event) => (
                        <li key={event.id} className="rounded-xl bg-neutral-50 p-3">
                          <p className="text-sm font-medium">{event.action.replaceAll(".", " ")}</p>
                          <p className="mt-1 text-xs text-neutral-500">{event.actorName ?? "System"} · {formatDate(event.createdAt)}</p>
                        </li>
                      ))}
                    </ol>
                  )}
                </details>
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </main>
  );
}