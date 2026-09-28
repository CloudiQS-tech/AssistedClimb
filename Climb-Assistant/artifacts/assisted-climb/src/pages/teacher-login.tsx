import { useState } from "react";
import { useLocation, Link } from "wouter";
import { apiFetch, setPreviewSessionToken } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Shield, Key, Copy, Check, ArrowLeft, ShieldCheck, Download, AlertCircle, Clock } from "lucide-react";

type Step = "credentials" | "totp" | "totp-setup" | "recovery-codes" | "approval-pending" | "recovery";

function combinePersonName(firstName: string, surname: string): string {
  return `${firstName.trim()} ${surname.trim()}`.trim();
}

export default function TeacherLogin() {
  const [isLogin, setIsLogin] = useState(true);
  const [step, setStep] = useState<Step>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [surname, setSurname] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [totpLoginToken, setTotpLoginToken] = useState<string | null>(null);
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [totpData, setTotpData] = useState<{ secret: string; qrCode: string; setupToken: string; deviceReplacement?: boolean } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [loginResult, setLoginResult] = useState<{
    mustChangePassword?: boolean;
    isItAdmin?: boolean;
    sessionResumeToken?: string;
    approvalPending?: boolean;
  } | null>(null);
  const [recoveryForm, setRecoveryForm] = useState({
    email: "",
    newPassword: "",
    code: "",
    method: "totp" as "totp" | "recovery",
    action: "password" as "password" | "device",
  });
  
  const [hasCopied, setHasCopied] = useState(false);
  const [hasAcknowledged, setHasAcknowledged] = useState(false);
  const [hibpWarning, setHibpWarning] = useState<string | null>(null);
  const [acceptHibpWarning, setAcceptHibpWarning] = useState(false);

  const completeLogin = async (result: any) => {
    if (result?.approvalPending) {
      setStep(isLogin ? "credentials" : "approval-pending");
      setTotpCode("");
      if (isLogin) {
        toast({
          title: "Awaiting school approval",
          description: result.message ?? "Your account setup is complete. A school administrator must approve your account before you can sign in.",
        });
      }
      return;
    }
    setPreviewSessionToken(result?.previewSessionToken);
    let sessionReady = false;
    for (const delayMs of [0, 150, 400]) {
      if (delayMs > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      }
      try {
        await apiFetch("/auth/me", { cache: "no-store" });
        sessionReady = true;
        break;
      } catch {
        // Embedded browsers can apply the renewed session cookie slightly after
        // the MFA response resolves. Give the browser a short settling window.
      }
    }
    if (!sessionReady) {
      if (typeof result?.sessionResumeToken === "string") {
        try {
          await apiFetch("/auth/session/restore", {
            method: "POST",
            body: JSON.stringify({ sessionResumeToken: result.sessionResumeToken }),
          });
          await apiFetch("/auth/me", { cache: "no-store" });
          sessionReady = true;
        } catch {
          // The one-time recovery handoff was unavailable or the webview also
          // dropped the replacement cookie. Do not retry or persist the ticket.
        }
      }
    }
    if (!sessionReady) {
      toast({
        title: "Sign-in could not be completed",
        description: "Your two-step code was accepted, but the sign-in session was not retained. Please try again.",
        variant: "destructive",
      });
      return;
    }
    if (result?.emailVerified === false) {
      setLocation(`/teacher/verify-email?email=${encodeURIComponent(result?.email ?? email)}`);
      return;
    }
    if (result?.mustChangePassword) {
      setLocation("/teacher/change-password");
    } else {
      setLocation(result?.isItAdmin ? "/teacher/settings" : "/teacher/dashboard");
    }
  };

  const handleCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isLogin && password.length < 12) {
      toast({ title: "Password too short", description: "Registration requires a password of at least 12 characters.", variant: "destructive" });
      return;
    }

    setLoading(true);
    try {
      let result;
      if (isLogin) {
        result = await apiFetch("/auth/login", {
          method: "POST",
          body: JSON.stringify({ email, password }),
        });
      } else {
        const body: any = {
          email,
          password,
          name: combinePersonName(firstName, surname),
          acceptHibpWarning,
        };
        body.inviteCode = inviteCode.trim().toUpperCase();
        result = await apiFetch("/auth/register", {
          method: "POST",
          body: JSON.stringify(body),
        });
      }

      if (result?.totpRequired) {
        setTotpLoginToken(result.totpLoginToken ?? null);
        setStep("totp");
        return;
      }
      
      if (result?.totpSetupRequired) {
        setTotpData({ secret: result.secret, qrCode: result.qrCode, setupToken: result.setupToken, deviceReplacement: result.deviceReplacement });
        setStep("totp-setup");
        return;
      }

      await completeLogin(result);
    } catch (err: any) {
      if (!isLogin && err.code === "HIBP_UNAVAILABLE") {
        setHibpWarning(err.warning ?? err.message);
        setAcceptHibpWarning(false);
        return;
      }
      toast({
        title: isLogin ? "Sign in failed" : "Registration failed",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleTotpVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (useRecoveryCode) {
        const result = await apiFetch("/auth/totp/recover", {
          method: "POST",
          body: JSON.stringify({ code: totpCode.replace(/\s/g, ""), ...(totpLoginToken ? { loginToken: totpLoginToken } : {}) }),
        });
        if (result?.totpSetupRequired) {
          setTotpData({ secret: result.secret, qrCode: result.qrCode, setupToken: result.setupToken, deviceReplacement: result.deviceReplacement });
          setStep("totp-setup");
          setTotpCode("");
          setUseRecoveryCode(false);
        }
      } else {
        const result = await apiFetch("/auth/totp/verify", {
          method: "POST",
          body: JSON.stringify({ code: totpCode.replace(/\s/g, ""), ...(totpLoginToken ? { loginToken: totpLoginToken } : {}) }),
        });
        await completeLogin(result);
      }
    } catch (err: any) {
      toast({ title: "Verification failed", description: err.message, variant: "destructive" });
      setTotpCode("");
    } finally {
      setLoading(false);
    }
  };

  const handleTotpSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (!totpData?.setupToken) {
        throw new Error("Authenticator setup details are missing. Please start setup again.");
      }
      const result = await apiFetch("/auth/totp/enable", {
        method: "POST",
        body: JSON.stringify({ code: totpCode.replace(/\s/g, ""), setupToken: totpData.setupToken }),
      });
      if (result?.recoveryCodes) {
        setRecoveryCodes(result.recoveryCodes);
        setLoginResult(result);
        setStep("recovery-codes");
      } else {
        await completeLogin(result);
      }
    } catch (err: any) {
      toast({ title: "Setup failed", description: err.message, variant: "destructive" });
      setTotpCode("");
    } finally {
      setLoading(false);
    }
  };

  const handleAccountRecovery = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (recoveryForm.action === "device") {
        const result = await apiFetch("/auth/recover-device", {
          method: "POST",
          body: JSON.stringify({ email: recoveryForm.email, recoveryCode: recoveryForm.code.replace(/\s/g, "") }),
        });
        setTotpData({ secret: result.secret, qrCode: result.qrCode, setupToken: result.setupToken, deviceReplacement: true });
        setTotpCode("");
        setStep("totp-setup");
        return;
      }

      await apiFetch("/auth/recover-password", {
        method: "POST",
        body: JSON.stringify({
          email: recoveryForm.email,
          newPassword: recoveryForm.newPassword,
          ...(recoveryForm.method === "totp"
            ? { totpCode: recoveryForm.code.replace(/\s/g, "") }
            : { recoveryCode: recoveryForm.code.replace(/\s/g, "") }),
          acceptHibpWarning,
        }),
      });
      setEmail(recoveryForm.email);
      setPassword("");
      setRecoveryForm((current) => ({ ...current, newPassword: "", code: "" }));
      setHibpWarning(null);
      setAcceptHibpWarning(false);
      setStep("credentials");
      toast({ title: "Password reset", description: "Your password has been updated. Sign in with your new password." });
    } catch (err: any) {
      if (err.code === "HIBP_UNAVAILABLE") {
        setHibpWarning(err.warning ?? err.message);
        setAcceptHibpWarning(false);
        return;
      }
      toast({ title: "Recovery failed", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const switchMode = () => {
    setIsLogin(!isLogin);
    setStep("credentials");
    setTotpCode("");
    setTotpLoginToken(null);
    setHibpWarning(null);
    setAcceptHibpWarning(false);
  };

  if (step === "recovery") {
    const recoveringDevice = recoveryForm.action === "device";
    const usingRecoveryCode = recoveringDevice || recoveryForm.method === "recovery";
    return (
      <div className="min-h-[100dvh] bg-neutral-50 flex items-center justify-center p-6 font-sans">
        <div className="w-full max-w-md bg-white rounded-[2rem] p-8 shadow-sm border border-neutral-200">
          <div className="mb-6 text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-neutral-100 mb-4">
              <Key className="w-6 h-6 text-neutral-700" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight mb-2">Account recovery</h1>
            <p className="text-sm text-neutral-500">
              For Teachers and School Admins: reset your password or replace a lost authenticator.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2 rounded-2xl bg-neutral-100 p-1 mb-6">
            <button
              type="button"
              onClick={() => setRecoveryForm((current) => ({ ...current, action: "password", code: "" }))}
              className={`rounded-xl px-3 py-2 text-sm font-medium transition-colors ${!recoveringDevice ? "bg-white text-black shadow-sm" : "text-neutral-500 hover:text-black"}`}
            >
              Reset password
            </button>
            <button
              type="button"
              onClick={() => setRecoveryForm((current) => ({ ...current, action: "device", method: "recovery", code: "" }))}
              className={`rounded-xl px-3 py-2 text-sm font-medium transition-colors ${recoveringDevice ? "bg-white text-black shadow-sm" : "text-neutral-500 hover:text-black"}`}
            >
              Replace authenticator
            </button>
          </div>

          <form onSubmit={handleAccountRecovery} className="space-y-5">
            <div>
              <label htmlFor="teacher-recovery-email" className="block text-sm font-medium mb-2">School email</label>
              <input
                id="teacher-recovery-email"
                required
                type="email"
                autoComplete="email"
                value={recoveryForm.email}
                onChange={(e) => setRecoveryForm((current) => ({ ...current, email: e.target.value }))}
                className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10"
                placeholder="teacher@school.edu"
              />
            </div>

            {!recoveringDevice && (
              <>
                <div>
                  <label htmlFor="teacher-recovery-password" className="block text-sm font-medium mb-2">New password</label>
                  <input
                    id="teacher-recovery-password"
                    required
                    type="password"
                    minLength={12}
                    autoComplete="new-password"
                    value={recoveryForm.newPassword}
                    onChange={(e) => {
                      setRecoveryForm((current) => ({ ...current, newPassword: e.target.value }));
                      setHibpWarning(null);
                      setAcceptHibpWarning(false);
                    }}
                    className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10"
                    placeholder="At least 12 characters"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2 rounded-2xl bg-neutral-100 p-1">
                  <button
                    type="button"
                    onClick={() => setRecoveryForm((current) => ({ ...current, method: "totp", code: "" }))}
                    className={`rounded-xl px-3 py-2 text-sm font-medium transition-colors ${recoveryForm.method === "totp" ? "bg-white text-black shadow-sm" : "text-neutral-500 hover:text-black"}`}
                  >
                    Authenticator
                  </button>
                  <button
                    type="button"
                    onClick={() => setRecoveryForm((current) => ({ ...current, method: "recovery", code: "" }))}
                    className={`rounded-xl px-3 py-2 text-sm font-medium transition-colors ${recoveryForm.method === "recovery" ? "bg-white text-black shadow-sm" : "text-neutral-500 hover:text-black"}`}
                  >
                    Recovery code
                  </button>
                </div>
              </>
            )}

            <div>
              <label htmlFor="teacher-recovery-code" className="block text-sm font-medium mb-2">
                {usingRecoveryCode ? "Recovery code" : "Authenticator code"}
              </label>
              <input
                id="teacher-recovery-code"
                required
                type="text"
                inputMode={usingRecoveryCode ? "text" : "numeric"}
                autoComplete={usingRecoveryCode ? "off" : "one-time-code"}
                value={recoveryForm.code}
                onChange={(e) => setRecoveryForm((current) => ({ ...current, code: e.target.value }))}
                maxLength={usingRecoveryCode ? 80 : 8}
                className={`w-full rounded-2xl border border-neutral-200 px-4 py-3 text-center focus:outline-none focus:ring-2 focus:ring-black/10 ${usingRecoveryCode ? "text-lg tracking-wide" : "text-2xl tracking-widest font-mono"}`}
                placeholder={usingRecoveryCode ? "XXXX-XXXX-XXXX" : "000 000"}
              />
              {recoveringDevice && (
                <p className="mt-2 text-xs text-neutral-500">Your code is single-use. You will set up a new authenticator before you can sign in.</p>
              )}
            </div>

            {!recoveringDevice && hibpWarning && (
              <div role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                <p className="font-medium">Breach check temporarily unavailable</p>
                <p className="mt-1">{hibpWarning}</p>
                <label className="mt-3 flex items-start gap-2">
                  <input type="checkbox" checked={acceptHibpWarning} onChange={(e) => setAcceptHibpWarning(e.target.checked)} className="mt-0.5" />
                  <span>I understand and want to continue with this password.</span>
                </label>
              </div>
            )}

            <button
              type="submit"
              disabled={loading || recoveryForm.code.replace(/\s/g, "").length < 6 || (!recoveringDevice && (!recoveryForm.newPassword || Boolean(hibpWarning && !acceptHibpWarning)))}
              className="w-full rounded-2xl bg-black text-white px-6 py-4 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {loading ? "Please wait…" : recoveringDevice ? "Verify and replace authenticator" : "Verify and reset password"}
            </button>
          </form>

          <div className="mt-6 text-center space-y-3">
            {!recoveringDevice && (
              <Link href={`/forgot-password?email=${encodeURIComponent(recoveryForm.email)}`} className="block text-sm text-neutral-500 hover:text-black transition-colors">
                Reset by email instead
              </Link>
            )}
            <button
              type="button"
              onClick={() => { setStep("credentials"); setHibpWarning(null); setAcceptHibpWarning(false); }}
              className="text-sm text-neutral-400 hover:text-black transition-colors"
            >
              Back to sign in
            </button>
          </div>
        </div>
      </div>
    );
  }

  const copySecret = () => {
    if (totpData?.secret) {
      navigator.clipboard.writeText(totpData.secret);
      setHasCopied(true);
      setTimeout(() => setHasCopied(false), 2000);
    }
  };

  const copyCodes = () => {
    if (recoveryCodes.length > 0) {
      navigator.clipboard.writeText(recoveryCodes.join("\n"));
      setHasCopied(true);
      setTimeout(() => setHasCopied(false), 2000);
    }
  };

  const downloadCodes = () => {
    const element = document.createElement("a");
    const file = new Blob([`Assisted Climb Recovery Codes\n\n${recoveryCodes.join("\n")}`], {type: 'text/plain'});
    element.href = URL.createObjectURL(file);
    element.download = "assisted-climb-recovery-codes.txt";
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  if (step === "recovery-codes") {
    return (
      <div data-testid="teacher-recovery-codes" className="min-h-[100dvh] bg-neutral-50 flex items-center justify-center p-6 font-sans">
        <div className="w-full max-w-md bg-white rounded-[2rem] p-8 shadow-sm border border-neutral-200">
          <div className="mb-6 text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-amber-100 text-amber-700 mb-4">
              <AlertCircle className="w-6 h-6" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight mb-2">Save your recovery codes</h1>
            <p className="text-sm text-neutral-500">
              These codes are shown <strong className="text-black font-semibold">only once</strong>. 
              You will need them to sign in if you lose access to your authenticator app.
            </p>
          </div>

          <div className="bg-neutral-50 rounded-2xl p-6 mb-6 border border-neutral-100">
            <div className="grid grid-cols-2 gap-3 mb-4">
              {recoveryCodes.map((code, idx) => (
                <div key={idx} className="bg-white px-3 py-2 rounded-lg border border-neutral-200 font-mono text-sm text-center tracking-widest text-neutral-700">
                  {code}
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <button 
                type="button"
                onClick={copyCodes}
                className="flex-1 flex items-center justify-center gap-2 bg-white border border-neutral-200 rounded-xl px-4 py-2 text-sm font-medium hover:bg-neutral-50 transition-colors"
              >
                {hasCopied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                {hasCopied ? "Copied" : "Copy"}
              </button>
              <button 
                type="button"
                onClick={downloadCodes}
                className="flex-1 flex items-center justify-center gap-2 bg-white border border-neutral-200 rounded-xl px-4 py-2 text-sm font-medium hover:bg-neutral-50 transition-colors"
              >
                <Download className="w-4 h-4" />
                Download
              </button>
            </div>
          </div>

          <label className="flex items-start gap-3 mb-6 cursor-pointer group">
            <div className="flex-shrink-0 mt-0.5">
              <input 
                type="checkbox" 
                className="w-4 h-4 rounded border-neutral-300 accent-black focus:ring-black/20"
                checked={hasAcknowledged}
                onChange={(e) => setHasAcknowledged(e.target.checked)}
              />
            </div>
            <span className="text-sm text-neutral-600 group-hover:text-black transition-colors leading-tight">
              I have safely recorded these codes and understand they will not be shown again.
            </span>
          </label>

          <button
            type="button"
            disabled={!hasAcknowledged || loading}
            onClick={() => {
              if (loginResult?.approvalPending) {
                setStep("approval-pending");
                return;
              }
              setLoading(true);
              void completeLogin(loginResult).finally(() => setLoading(false));
            }}
            className="w-full rounded-2xl bg-black text-white px-6 py-4 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {loginResult?.approvalPending ? "Finish registration" : "Continue to Dashboard"}
          </button>
        </div>
      </div>
    );
  }

  if (step === "approval-pending") {
    return (
      <div data-testid="teacher-approval-pending" className="min-h-[100dvh] bg-neutral-50 flex items-center justify-center p-6 font-sans">
        <div className="w-full max-w-md bg-white rounded-[2rem] p-8 shadow-sm border border-neutral-200">
          <div className="mb-6 text-center">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-amber-100 text-amber-700 mb-4">
              <Clock className="w-7 h-7" aria-hidden="true" />
            </div>
            <p className="text-xs uppercase tracking-[0.2em] text-amber-700 font-semibold mb-2">Registration complete</p>
            <h1 className="text-2xl font-semibold tracking-tight mb-2">Approval required</h1>
            <p className="text-sm text-neutral-600">
              Your teacher account is now <strong className="font-semibold text-amber-900">waiting for approval</strong> from your school administrator.
            </p>
          </div>

          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-950 space-y-2">
            <p className="font-semibold">You cannot access classrooms yet.</p>
            <p>Your authenticator setup is complete. A school administrator must approve your registration before you can sign in and access classroom tools.</p>
          </div>

          <div className="mt-6 space-y-3 text-sm text-neutral-600">
            <p>What happens next:</p>
            <ul className="list-disc space-y-1.5 pl-5">
              <li>Your school administrator reviews your registration.</li>
              <li>Once approved, return here and sign in with your school email and password.</li>
            </ul>
          </div>

          <button
            type="button"
            onClick={() => {
              setIsLogin(true);
              setStep("credentials");
              setPassword("");
              setFirstName("");
              setSurname("");
              setInviteCode("");
              setTotpCode("");
              setRecoveryCodes([]);
              setLoginResult(null);
              setHasAcknowledged(false);
            }}
            className="mt-8 w-full rounded-2xl bg-black text-white px-6 py-4 text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Return to teacher sign in
          </button>
        </div>
      </div>
    );
  }

  if (step === "totp-setup" && totpData) {
    return (
      <div data-testid="teacher-totp-setup" className="min-h-[100dvh] bg-neutral-50 flex items-center justify-center p-6 font-sans">
        <div className="w-full max-w-md bg-white rounded-[2rem] p-8 shadow-sm border border-neutral-200">
          <div className="mb-6 text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-neutral-100 mb-4">
              <Shield className="w-6 h-6 text-neutral-700" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight mb-2">
              {totpData.deviceReplacement ? "Replace authenticator" : "Secure your account"}
            </h1>
            <p className="text-sm text-neutral-500">
              {totpData.deviceReplacement 
                ? "Set up your new authenticator device to secure your account."
                : "To protect student data, we require two-factor authentication."}
            </p>
          </div>

          <div className="bg-neutral-50 rounded-2xl p-6 mb-6 flex flex-col items-center border border-neutral-100">
            <p className="text-sm font-medium mb-4 text-center">1. Scan this QR code in your authenticator app</p>
            <div className="bg-white p-2 rounded-xl shadow-sm border border-neutral-200 mb-4">
              <img src={totpData.qrCode} alt="QR Code" className="w-40 h-40" />
            </div>
            
            <div className="w-full">
              <p className="text-xs text-neutral-500 mb-2 text-center">Or enter this code manually:</p>
              <div className="flex items-center justify-between bg-white rounded-xl border border-neutral-200 p-3">
                <code className="text-xs font-mono font-medium text-neutral-700">{totpData.secret}</code>
                <button 
                  type="button" 
                  onClick={copySecret}
                  className="text-neutral-500 hover:text-black transition-colors"
                  title="Copy secret"
                >
                  {hasCopied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>

          <form onSubmit={handleTotpSetup} className="space-y-5">
            <div>
              <label htmlFor="teacher-totp-setup-code" className="block text-sm font-medium mb-2 text-center">2. Enter the 6-digit code</label>
              <input
                id="teacher-totp-setup-code"
                required
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                maxLength={8}
                data-testid="input-teacher-totp-setup-code"
                className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-center text-2xl tracking-widest font-mono focus:outline-none focus:ring-2 focus:ring-black/10"
                placeholder="000 000"
              />
            </div>
            <button
              type="submit"
              disabled={loading || totpCode.replace(/\s/g, "").length < 6}
              data-testid="button-enable-teacher-totp"
              className="w-full rounded-2xl bg-black text-white px-6 py-4 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {loading ? "Verifying…" : "Enable Two-Factor Auth"}
            </button>
          </form>

          <div className="mt-6 text-center">
            <button
              type="button"
              onClick={() => { setStep("credentials"); setTotpCode(""); }}
              className="text-sm text-neutral-400 hover:text-black transition-colors flex items-center justify-center w-full gap-2"
            >
              <ArrowLeft className="w-4 h-4" /> Back to sign in
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (step === "totp") {
    return (
      <div className="min-h-[100dvh] bg-neutral-50 flex items-center justify-center p-6 font-sans">
        <div className="w-full max-w-md bg-white rounded-[2rem] p-8 shadow-sm border border-neutral-200">
          <div className="mb-8 text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-neutral-100 mb-4">
              {useRecoveryCode ? <Key className="w-6 h-6 text-neutral-700" /> : <ShieldCheck className="w-6 h-6 text-neutral-700" />}
            </div>
            <h1 className="text-2xl font-semibold tracking-tight mb-2">
              {useRecoveryCode ? "Recovery verification" : "Two-factor authentication"}
            </h1>
            <p className="text-sm text-neutral-500">
              {useRecoveryCode 
                ? "Enter one of your saved recovery codes." 
                : "Enter the 6-digit code from your authenticator app."}
            </p>
          </div>

          <form onSubmit={handleTotpVerify} className="space-y-5">
            <div>
              <label htmlFor="teacher-totp-code" className="block text-sm font-medium mb-2">
                {useRecoveryCode ? "Recovery code" : "Authenticator code"}
              </label>
              <input
                id="teacher-totp-code"
                required
                type="text"
                inputMode={useRecoveryCode ? "text" : "numeric"}
                autoComplete={useRecoveryCode ? "off" : "one-time-code"}
                autoFocus
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                maxLength={useRecoveryCode ? 64 : 8}
                className={`w-full rounded-2xl border border-neutral-200 px-4 py-3 text-center ${useRecoveryCode ? 'text-lg tracking-wide' : 'text-2xl tracking-widest font-mono'} focus:outline-none focus:ring-2 focus:ring-black/10`}
                placeholder={useRecoveryCode ? "XXXX-XXXX-XXXX" : "000 000"}
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

          <div className="mt-6 text-center space-y-4">
            <button
              type="button"
              onClick={() => { setUseRecoveryCode(!useRecoveryCode); setTotpCode(""); }}
              className="text-sm text-neutral-600 hover:text-black font-medium transition-colors"
            >
              {useRecoveryCode ? "Use authenticator app instead" : "Lost your authenticator?"}
            </button>
            <div className="border-t border-neutral-100 pt-4">
              <button
                type="button"
                onClick={() => { setStep("credentials"); setTotpCode(""); setTotpLoginToken(null); setUseRecoveryCode(false); }}
                className="text-sm text-neutral-400 hover:text-black transition-colors"
              >
                Back to sign in
              </button>
            </div>
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
          {isLogin ? "Sign in to manage your classes." : "Use your school invite code to register. A school administrator must approve your account before classroom access is available."}
        </p>

        <form onSubmit={handleCredentials} className="space-y-5">
          {!isLogin && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="teacher-first-name" className="block text-sm font-medium mb-2">First name</label>
                  <input
                    id="teacher-first-name"
                    required
                    type="text"
                    autoComplete="given-name"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10"
                    placeholder="Jane"
                    data-testid="input-teacher-first-name"
                  />
                </div>
                <div>
                  <label htmlFor="teacher-surname" className="block text-sm font-medium mb-2">Surname</label>
                  <input
                    id="teacher-surname"
                    required
                    type="text"
                    autoComplete="family-name"
                    value={surname}
                    onChange={(e) => setSurname(e.target.value)}
                    className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10"
                    placeholder="Smith"
                    data-testid="input-teacher-surname"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="teacher-invite-code" className="block text-sm font-medium mb-2">
                  School Invite Code
                  <span className="ml-1.5 text-neutral-400 font-normal text-xs">(required, from your school's IT team)</span>
                </label>
                <input
                  id="teacher-invite-code"
                  required
                  type="text"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                  className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10 font-mono tracking-widest uppercase"
                  placeholder="e.g. A1B2C3D4"
                  maxLength={16}
                />
                <p className="text-xs text-neutral-400 mt-1.5">Your registration will await review by a school administrator.</p>
              </div>
            </>
          )}
          <div>
            <label htmlFor="teacher-email" className="block text-sm font-medium mb-2">Email</label>
            <input
              id="teacher-email"
              required
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10"
              placeholder="teacher@school.edu"
              data-testid="input-teacher-email"
            />
          </div>
          <div>
            <label htmlFor="teacher-password" className="block text-sm font-medium mb-2">Password</label>
            <input
              id="teacher-password"
              required
              type="password"
              autoComplete={isLogin ? "current-password" : "new-password"}
              minLength={!isLogin ? 12 : undefined}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (!isLogin) {
                  setHibpWarning(null);
                  setAcceptHibpWarning(false);
                }
              }}
              className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10"
              placeholder="••••••••"
              data-testid="input-teacher-password"
            />
            {!isLogin && (
              <p className="text-xs text-neutral-500 mt-1.5">Password must be at least 12 characters.</p>
            )}
          </div>
          {!isLogin && hibpWarning && (
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
            disabled={loading || Boolean(!isLogin && hibpWarning && !acceptHibpWarning)}
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
            <button
              type="button"
              onClick={() => {
                setRecoveryForm((current) => ({ ...current, email, code: "", newPassword: "" }));
                setHibpWarning(null);
                setAcceptHibpWarning(false);
                setStep("recovery");
              }}
              className="text-sm text-neutral-500 hover:text-black transition-colors"
            >
              Recover password or authenticator
            </button>
          )}
          <div className="border-t border-neutral-100 pt-3">
            <Link href="/join" className="text-sm text-neutral-400 hover:text-black transition-colors">
              Student? Join a class here.
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
