import { useState } from "react";
import { useLocation } from "wouter";
import { apiFetch, setTeacherToken } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

type Step = "credentials" | "totp";

export default function TeacherLogin() {
  const [isLogin, setIsLogin] = useState(true);
  const [step, setStep] = useState<Step>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const handleCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      let result;
      if (isLogin) {
        result = await apiFetch("/auth/login", {
          method: "POST",
          body: JSON.stringify({ email, password }),
        });
      } else {
        const body: any = { email, password, name };
        if (inviteCode.trim()) body.inviteCode = inviteCode.trim().toUpperCase();
        result = await apiFetch("/auth/register", {
          method: "POST",
          body: JSON.stringify(body),
        });
      }

      if (result?.totpRequired) {
        setStep("totp");
        return;
      }

      if (result?.loginToken) setTeacherToken(result.loginToken);

      if (result?.mustChangePassword) {
        setLocation("/teacher/change-password");
      } else {
        setLocation(result?.isItAdmin ? "/teacher/settings" : "/teacher/dashboard");
      }
    } catch (err: any) {
      toast({
        title: isLogin ? "Sign in failed" : "Registration failed",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const result = await apiFetch("/auth/totp/verify", {
        method: "POST",
        body: JSON.stringify({ code: totpCode.replace(/\s/g, "") }),
      });
      if (result?.loginToken) setTeacherToken(result.loginToken);
      if (result?.mustChangePassword) {
        setLocation("/teacher/change-password");
      } else {
        setLocation(result?.isItAdmin ? "/teacher/settings" : "/teacher/dashboard");
      }
    } catch (err: any) {
      toast({ title: "Verification failed", description: err.message, variant: "destructive" });
      setTotpCode("");
    } finally {
      setLoading(false);
    }
  };

  const switchMode = () => {
    setIsLogin(!isLogin);
    setStep("credentials");
  };

  if (step === "totp") {
    return (
      <div className="min-h-[100dvh] bg-neutral-50 flex items-center justify-center p-6 font-sans">
        <div className="w-full max-w-md bg-white rounded-[2rem] p-8 shadow-sm border border-neutral-200">
          <div className="mb-8 text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-neutral-100 mb-4">
              <svg className="w-6 h-6 text-neutral-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight mb-2">Two-factor authentication</h1>
            <p className="text-sm text-neutral-500">Enter the 6-digit code from your authenticator app.</p>
          </div>

          <form onSubmit={handleTotp} className="space-y-5">
            <div>
              <label className="block text-sm font-medium mb-2">Authenticator code</label>
              <input
                required
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                maxLength={8}
                className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-center text-2xl tracking-widest font-mono focus:outline-none focus:ring-2 focus:ring-black/10"
                placeholder="000 000"
              />
            </div>
            <button
              type="submit"
              disabled={loading || totpCode.replace(/\s/g, "").length < 6}
              className="w-full rounded-2xl bg-black text-white px-6 py-4 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {loading ? "Verifying…" : "Verify & Sign In"}
            </button>
          </form>

          <div className="mt-6 text-center">
            <button
              type="button"
              onClick={() => { setStep("credentials"); setTotpCode(""); }}
              className="text-sm text-neutral-500 hover:text-black transition-colors"
            >
              Back to sign in
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-neutral-50 flex items-center justify-center p-6 font-sans">
      <div className="w-full max-w-md bg-white rounded-[2rem] p-8 shadow-sm border border-neutral-200">
        <h1 className="text-3xl font-semibold tracking-tight mb-2 text-center">
          {isLogin ? "Teacher Sign In" : "Teacher Registration"}
        </h1>
        <p className="text-sm text-neutral-500 mb-8 text-center">
          {isLogin ? "Sign in to manage your classes." : "Create an account to start teaching."}
        </p>

        <form onSubmit={handleCredentials} className="space-y-5">
          {!isLogin && (
            <>
              <div>
                <label className="block text-sm font-medium mb-2">Name</label>
                <input
                  required
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10"
                  placeholder="e.g. Mr. Smith"
                  data-testid="input-teacher-name"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">
                  School Invite Code
                  <span className="ml-1.5 text-neutral-400 font-normal text-xs">(from your school's IT team)</span>
                </label>
                <input
                  type="text"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                  className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10 font-mono tracking-widest uppercase"
                  placeholder="e.g. A1B2C3D4"
                  maxLength={16}
                />
                <p className="text-xs text-neutral-400 mt-1.5">Leave blank if your school hasn't set up a code yet.</p>
              </div>
            </>
          )}
          <div>
            <label className="block text-sm font-medium mb-2">Email</label>
            <input
              required
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10"
              placeholder="teacher@school.edu"
              data-testid="input-teacher-email"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">Password</label>
            <input
              required
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10"
              placeholder="••••••••"
              data-testid="input-teacher-password"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-2xl bg-black text-white px-6 py-4 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
            data-testid={isLogin ? "button-teacher-login" : "button-teacher-register"}
          >
            {loading ? "Please wait…" : isLogin ? "Sign In" : "Create Account"}
          </button>
        </form>

        <div className="mt-6 text-center space-y-3">
          <button
            type="button"
            onClick={switchMode}
            className="text-sm text-neutral-500 hover:text-black transition-colors"
          >
            {isLogin ? "Need an account? Create one." : "Already have an account? Sign in."}
          </button>
          {isLogin && (
            <div>
              <a href="/forgot-password" className="text-sm text-neutral-400 hover:text-black transition-colors">
                Forgot your password?
              </a>
            </div>
          )}
          <div className="border-t border-neutral-100 pt-3">
            <a href="/join" className="text-sm text-neutral-400 hover:text-black transition-colors">
              Student? Join a class here.
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
