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
      await apiFetch("/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, newPassword }),
      });
      toast({ title: "Password reset", description: "You can now sign in with your new password." });
      setLocation("/teacher/login");
    } catch (err: any) {
      if (err.message && err.message.toLowerCase().includes("expired")) {
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
            <label className="block text-sm font-medium mb-2">New password</label>
            <input
              required
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              minLength={8}
              disabled={!token}
              className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10 disabled:opacity-50"
              placeholder="At least 8 characters"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">Confirm new password</label>
            <input
              required
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              minLength={8}
              disabled={!token}
              className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10 disabled:opacity-50"
              placeholder="Same password again"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !token}
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
