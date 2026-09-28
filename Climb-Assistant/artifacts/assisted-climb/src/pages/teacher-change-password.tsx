import { useState } from "react";
import { useLocation } from "wouter";
import { apiFetch, clearTeacherToken } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

export default function TeacherChangePassword() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [hibpWarning, setHibpWarning] = useState<string | null>(null);
  const [acceptHibpWarning, setAcceptHibpWarning] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirm) {
      toast({ title: "Passwords don't match", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      const result = await apiFetch("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ newPassword, acceptHibpWarning }),
      });
      clearTeacherToken();
      toast({
        title: "Password updated",
        description: result?.warning
          ? "Password updated. The breach check was unavailable, so choose a different password if you are unsure this one is unique."
          : "For your security, sign in again with your new password.",
      });
      setLocation("/teacher/login");
    } catch (err: any) {
      if (err.code === "HIBP_UNAVAILABLE") {
        setHibpWarning(err.warning ?? err.message);
        setAcceptHibpWarning(false);
        return;
      }
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-neutral-50 flex items-center justify-center p-6 font-sans">
      <div className="w-full max-w-md bg-white rounded-[2rem] p-8 shadow-sm border border-neutral-200">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-amber-100 mb-4">
            <svg className="w-6 h-6 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight mb-2">Set a new password</h1>
          <p className="text-sm text-neutral-500">
            Your account requires a password change before you can continue.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="teacher-change-password-new" className="block text-sm font-medium mb-2">New password</label>
            <input
              id="teacher-change-password-new"
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
              className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10"
              placeholder="At least 12 characters"
            />
          </div>
          <div>
            <label htmlFor="teacher-change-password-confirm" className="block text-sm font-medium mb-2">Confirm new password</label>
            <input
              id="teacher-change-password-confirm"
              required
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              minLength={12}
              className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10"
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
            disabled={loading || Boolean(hibpWarning && !acceptHibpWarning)}
            className="w-full rounded-2xl bg-black text-white px-6 py-4 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {loading ? "Saving…" : "Set Password & Continue"}
          </button>
        </form>
      </div>
    </div>
  );
}
