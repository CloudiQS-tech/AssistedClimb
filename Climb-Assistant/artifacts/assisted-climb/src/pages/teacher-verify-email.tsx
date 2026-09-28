import { useEffect, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

export default function TeacherVerifyEmail() {
  const search = useSearch();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const params = new URLSearchParams(search);
  const token = params.get("token");
  const [email, setEmail] = useState(() => params.get("email") ?? "");
  const [status, setStatus] = useState<"idle" | "verifying" | "verified" | "failed">(
    token ? "verifying" : "idle",
  );
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    apiFetch(`/auth/verify-email?token=${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(() => {
        if (!cancelled) {
          setStatus("verified");
          setMessage("Your school email has been verified. You can now sign in.");
        }
      })
      .catch((err: any) => {
        if (!cancelled) {
          setStatus("failed");
          setMessage(err.message ?? "This verification link is no longer valid.");
        }
      });
    return () => { cancelled = true; };
  }, [token]);

  const resend = async (event: React.FormEvent) => {
    event.preventDefault();
    setSending(true);
    try {
      await apiFetch("/auth/resend-verification", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      toast({
        title: "If an account needs verification, a new link has been sent",
        description: "Check your school inbox and spam folder.",
      });
    } catch (err: any) {
      toast({ title: "Could not request a new link", description: err.message, variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-neutral-50 flex items-center justify-center p-6 font-sans">
      <div className="w-full max-w-md rounded-[2rem] border border-neutral-200 bg-white p-8 shadow-sm">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-50 text-xl">✉</div>
        <h1 className="text-center text-2xl font-semibold tracking-tight">Verify your school email</h1>

        {status === "verifying" && (
          <p className="mt-4 text-center text-sm text-neutral-500">Checking your verification link…</p>
        )}
        {status === "verified" && (
          <>
            <p className="mt-4 text-center text-sm leading-6 text-emerald-700">{message}</p>
            <button
              onClick={() => setLocation("/teacher/login")}
              className="mt-7 w-full rounded-2xl bg-black px-6 py-3 text-sm font-medium text-white hover:opacity-90"
            >
              Sign in
            </button>
          </>
        )}
        {status === "failed" && (
          <p className="mt-4 text-center text-sm leading-6 text-red-600">{message}</p>
        )}

        {status !== "verified" && (
          <>
            <p className="mt-5 text-center text-sm leading-6 text-neutral-500">
              Enter your school email to request a fresh, single-use verification link.
            </p>
            <form onSubmit={resend} className="mt-5 space-y-4">
              <label className="block text-sm font-medium">
                School email
                <input
                  required
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="mt-2 w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10"
                  placeholder="teacher@school.edu"
                />
              </label>
              <button
                type="submit"
                disabled={sending}
                className="w-full rounded-2xl border border-neutral-300 px-6 py-3 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50"
              >
                {sending ? "Requesting…" : "Send a new link"}
              </button>
            </form>
          </>
        )}

        <p className="mt-6 text-center text-xs text-neutral-400">
          <Link href="/teacher/login" className="underline hover:text-neutral-600">Back to teacher sign in</Link>
        </p>
      </div>
    </div>
  );
}