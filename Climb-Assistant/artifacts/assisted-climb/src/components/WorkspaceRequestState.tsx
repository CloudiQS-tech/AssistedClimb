export type WorkspaceFailureState = "offline" | "timeout" | "provider-error" | "error";

export function isUnauthorizedError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "status" in error && (error as { status?: unknown }).status === 401);
}

export function classifyWorkspaceError(error: unknown): WorkspaceFailureState {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = Number(record.status ?? 0);
  const data = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : {};
  const code = String(record.code ?? data.code ?? "");
  const message = String(record.message ?? error ?? "");
  if (code.includes("AI_PROVIDER") || /AI provider/i.test(message)) return "provider-error";
  if (status === 408 || status === 504 || code.includes("TIMEOUT")) return "timeout";
  if (/failed to fetch|network|internet|offline|load failed/i.test(message)) return "offline";
  return "error";
}

const copy = {
  loading: {
    eyebrow: "Please wait",
    title: "Loading your workspace",
    guidance: "We are getting the latest information. Keep this page open while it loads.",
  },
  offline: {
    eyebrow: "Connection needed",
    title: "You appear to be offline",
    guidance: "Check your internet connection. Nothing has been changed or lost; try again when you are back online.",
  },
  timeout: {
    eyebrow: "The request took too long",
    title: "We could not load this workspace in time",
    guidance: "The service may be busy. Retrying will not duplicate saved work.",
  },
  "provider-error": {
    eyebrow: "AI service unavailable",
    title: "AI guidance is temporarily unavailable",
    guidance: "Your existing work is safe. You can continue without AI after the workspace loads, or try again in a moment.",
  },
  error: {
    eyebrow: "Workspace unavailable",
    title: "We could not load this workspace",
    guidance: "Your existing work is safe. Please try again.",
  },
} as const;

export function WorkspaceRequestState({
  workspace,
  state,
  onRetry,
}: {
  workspace: string;
  state: WorkspaceFailureState | "loading";
  onRetry?: () => void | Promise<unknown>;
}) {
  const content = copy[state];
  const loading = state === "loading";
  return (
    <main
      className="min-h-[100dvh] bg-neutral-50 px-4 py-10 font-sans text-neutral-900 sm:px-6 sm:py-16"
      data-testid="workspace-request-state"
      data-state={state}
    >
      <section
        className="mx-auto max-w-2xl rounded-[2rem] border border-neutral-200 bg-white p-6 shadow-sm sm:p-10"
        aria-labelledby="workspace-request-title"
        aria-busy={loading}
        aria-live="polite"
      >
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-400">{workspace}</p>
        <div className="mt-8 flex flex-col gap-6 sm:flex-row sm:items-start">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-amber-50 text-amber-700" aria-hidden="true">
            {loading
              ? <span className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-800" />
              : <span className="text-xl font-bold">!</span>}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-400">{content.eyebrow}</p>
            <h1 id="workspace-request-title" className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{content.title}</h1>
            <p className="mt-3 text-sm leading-7 text-neutral-600">{content.guidance}</p>
          </div>
        </div>
        <div className="mt-8 border-t border-neutral-100 pt-6">
          <button
            type="button"
            disabled={loading}
            onClick={() => void onRetry?.()}
            data-testid="workspace-retry"
            className="min-h-11 w-full rounded-2xl bg-neutral-900 px-5 py-3 text-sm font-semibold text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-500 sm:w-auto"
          >
            {loading ? "Loading…" : state === "provider-error" ? "Try AI again" : "Try again"}
          </button>
        </div>
      </section>
    </main>
  );
}