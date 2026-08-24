import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";

export default function SiteGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<"loading" | "open" | "locked">("loading");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const isAdminRoute = window.location.pathname.replace(/\/$/, "").endsWith("/admin");

  useEffect(() => {
    if (isAdminRoute) { setStatus("open"); return; }
    apiFetch("/auth/site-status")
      .then((data) => setStatus(data.authed ? "open" : "locked"))
      .catch(() => setStatus("locked"));
  }, [isAdminRoute]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await apiFetch("/auth/site-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      setStatus("open");
    } catch {
      setError("Incorrect password. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (status === "loading") {
    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center">
        <div className="w-6 h-6 rounded-full border-2 border-black border-t-transparent animate-spin" />
      </div>
    );
  }

  if (status === "locked") {
    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <div className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm p-10 space-y-8">
            <div className="text-center space-y-2">
              <div className="text-4xl mb-4">🔒</div>
              <h1 className="text-2xl font-semibold tracking-tight">The Assisted Climb</h1>
              <p className="text-sm text-neutral-500">Enter the site password to continue.</p>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <input
                type="password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
              />
              {error && <p className="text-sm text-red-500 text-center">{error}</p>}
              <button
                type="submit"
                disabled={submitting || !password}
                className="w-full rounded-2xl bg-black text-white py-3 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {submitting ? "Checking..." : "Enter"}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
