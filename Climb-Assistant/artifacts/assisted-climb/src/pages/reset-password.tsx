import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

export default function ResetPassword() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const { toast } = useToast();
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState("");
  const [expired, setExpired] = useState(false);
  const [hibpWarning, setHibpWarning] = useState<string | null>(null);
  const [acceptHibpWarning, setAcceptHibpWarning] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(search);
    const t = params.get("token");
    if (!t) {
      toast({ title: "Invalid link", description: "No reset token found. Please request a new link.", variant: "destructive" });
    } else {
      setToken(t);
    }
  }, [search]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirm) {
      toast({ title: "Passwords don't match", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      const result = await apiFetch("/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, newPassword, acceptHibpWarning }),
      });
      toast({
        title: "Password reset",
        description: result?.warning
          ? "Password reset. The breach check was unavailable, so choose a different password if you are unsure this one is unique."
          : "You can now sign in with your new password.",
      });
      setLocation("/teacher/login");
    } catch (err: any) {
      if (err.code === "HIBP_UNAVAILABLE") {
        setHibpWarning(err.warning ?? err.message);
        setAcceptHibpWarning(false);
        return;
      }
      if (err.message && err.message.toLowerCase().includes("has expired")) {
        setExpired(true);
      } else {
        toast({ title: "Error", description: err.message, variant: "destructive" });
      }
    } finally {
      setLoading(false);
    }
  };

  if (expired) {
    return (
      <div className="min-h-[100dvh] bg-neutral-50 flex items-center justify-center p-6 font-sans">
        <div className="w-full max-w-md bg-white rounded-[2rem] p-8 shadow-sm border border-neutral-200 text-center space-y-5">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-amber-100 mb-2">
            <svg className="w-7 h-7 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Link expired</h1>
          <p className="text-sm text-neutral-500">
            This reset link has expired. Reset links are only valid for 1 hour.
          </p>
          <button
            onClick={() => setLocation("/forgot-password")}
            className="w-full rounded-2xl bg-black text-white px-6 py-4 text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Request a new link
          </button>
          <div>
            <a href="/teacher/login" className="text-sm text-neutral-500 hover:text-black transition-colors">
              Back to sign in
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-neutral-50 flex items-center justify-center p-6 font-sans">
      <div className="w-full max-w-md bg-white rounded-[2rem] p-8 shadow-sm border border-neutral-200">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight mb-2">Reset your password</h1>
          <p className="text-sm text-neutral-500">Choose a new password for your account.</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="reset-password-new" className="block text-sm font-medium mb-2">New password</label>
            <input
              id="reset-password-new"
              required
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => {
                setNewPassword(e.target.value);
                setHibpWarning(null);
                setAcceptHibpWarning(false);
              }}
              minLength={12}
              disabled={!token}
              className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10 disabled:opacity-50"
              placeholder="At least 12 characters"
            />
          </div>
          <div>
            <label htmlFor="reset-password-confirm" className="block text-sm font-medium mb-2">Confirm new password</label>
            <input
              id="reset-password-confirm"
              required
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              minLength={12}
              disabled={!token}
              className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10 disabled:opacity-50"
              placeholder="Same password again"
            />
          </div>
          {hibpWarning && (
            <div role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="font-medium">Breach check temporarily unavailable</p>
              <p className="mt-1">{hibpWarning}</p>
              <label className="mt-3 flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={acceptHibpWarning}
                  onChange={(e) => setAcceptHibpWarning(e.target.checked)}
                  className="mt-0.5"
                />
                <span>I understand and want to continue with this password.</span>
              </label>
            </div>
          )}
          <button
            type="submit"
            disabled={loading || !token || Boolean(hibpWarning && !acceptHibpWarning)}
            className="w-full rounded-2xl bg-black text-white px-6 py-4 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {loading ? "Resetting…" : "Reset Password"}
          </button>
        </form>

        <div className="mt-6 text-center">
          <a href="/teacher/login" className="text-sm text-neutral-500 hover:text-black transition-colors">
            Back to sign in
          </a>
        </div>
      </div>
    </div>
  );
}
