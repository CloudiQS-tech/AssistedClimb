import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { apiFetch, clearTeacherToken } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

interface OrgAiSettings {
  configured: boolean;
  aiProvider: string | null;
  aiKeyMasked: string | null;
  azureEndpoint: string | null;
}

interface OrgTeacher {
  id: number;
  name: string;
  email: string;
  isItAdmin: boolean;
  mustChangePassword: boolean;
  failedLoginAttempts: number;
  lockedUntil: string | null;
  createdAt: string;
}

interface AuditEntry {
  id: number;
  action: string;
  metadata: Record<string, any> | null;
  ipAddress: string | null;
  createdAt: string;
  teacherName: string | null;
  teacherEmail: string | null;
}

export default function TeacherSettings() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [teacher, setTeacher] = useState<any>(null);
  const [aiSettings, setAiSettings] = useState<OrgAiSettings | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiForm, setAiForm] = useState({ aiProvider: "gemini" as "gemini" | "azure", aiKey: "", azureEndpoint: "" });
  const [showAiForm, setShowAiForm] = useState(false);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [rotatingCode, setRotatingCode] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);

  // TOTP
  const [totpSetup, setTotpSetup] = useState<{ qrCode: string; secret: string } | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [totpDisableCode, setTotpDisableCode] = useState("");
  const [totpLoading, setTotpLoading] = useState(false);
  const [showTotpDisable, setShowTotpDisable] = useState(false);

  // IT admin: teacher list
  const [orgTeachers, setOrgTeachers] = useState<OrgTeacher[]>([]);
  const [resetLinks, setResetLinks] = useState<Record<number, string>>({});
  const [generatingReset, setGeneratingReset] = useState<number | null>(null);
  const [unlocking, setUnlocking] = useState<number | null>(null);
  const [togglingAdmin, setTogglingAdmin] = useState<number | null>(null);

  // IT admin: audit log
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [showAuditLog, setShowAuditLog] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);

  // Change password
  const [cpForm, setCpForm] = useState({ current: "", next: "", confirm: "" });
  const [cpLoading, setCpLoading] = useState(false);
  const [cpSuccess, setCpSuccess] = useState(false);

  // IT admin: SMTP / email status
  const [smtpConfigured, setSmtpConfigured] = useState<boolean | null>(null);
  const [testEmailSending, setTestEmailSending] = useState(false);
  const [testEmailResult, setTestEmailResult] = useState<{ ok: boolean; message: string } | null>(null);

  // IT admin: email domain allowlist
  const [allowedDomains, setAllowedDomains] = useState<string[]>([]);
  const [domainsLoaded, setDomainsLoaded] = useState(false);
  const [newDomain, setNewDomain] = useState("");
  const [domainError, setDomainError] = useState("");
  const [savingDomains, setSavingDomains] = useState(false);

  useEffect(() => {
    apiFetch("/auth/me")
      .then((t) => {
        setTeacher(t);
        if (t.isItAdmin) {
          return Promise.all([
            apiFetch("/teacher/org/ai-settings").then(setAiSettings).catch(() => null),
            apiFetch("/teacher/org/invite-code").then((d: any) => setInviteCode(d.inviteCode)).catch(() => null),
            apiFetch("/teacher/org/teachers").then(setOrgTeachers).catch(() => null),
            apiFetch("/teacher/org/email-domains").then((d: any) => { setAllowedDomains(d.allowedEmailDomains ?? []); setDomainsLoaded(true); }).catch(() => null),
            apiFetch("/auth/email-status").then((d: any) => setSmtpConfigured(d.configured)).catch(() => null),
          ]);
        }
        return null;
      })
      .catch(() => setLocation("/teacher/login"))
      .finally(() => setLoading(false));
  }, [setLocation]);

  const handleAddDomain = () => {
    const raw = newDomain.trim().toLowerCase().replace(/^@/, "");
    if (!raw) return;
    if (!/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(raw)) {
      setDomainError("Enter a valid domain, e.g. school.edu.au");
      return;
    }
    if (allowedDomains.includes(raw)) {
      setDomainError("Domain already in the list");
      return;
    }
    setAllowedDomains((prev) => [...prev, raw]);
    setNewDomain("");
    setDomainError("");
  };

  const handleRemoveDomain = (domain: string) => {
    setAllowedDomains((prev) => prev.filter((d) => d !== domain));
  };

  const handleSaveDomains = async () => {
    setSavingDomains(true);
    try {
      const result = await apiFetch("/teacher/org/email-domains", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedEmailDomains: allowedDomains }),
      });
      setAllowedDomains(result.allowedEmailDomains ?? []);
      toast({ title: allowedDomains.length > 0 ? "Domain restriction saved" : "Domain restriction removed — registration is now open" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSavingDomains(false);
    }
  };

  const handleCopyCode = () => {
    if (!inviteCode) return;
    navigator.clipboard.writeText(inviteCode);
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 2000);
  };

  const handleRotateCode = async () => {
    if (!confirm("This will invalidate the current invite code. Teachers who haven't registered yet will need the new code. Continue?")) return;
    setRotatingCode(true);
    try {
      const result = await apiFetch("/teacher/org/invite-code/rotate", { method: "POST" });
      setInviteCode(result.inviteCode);
      toast({ title: "Invite code rotated" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setRotatingCode(false);
    }
  };

  const handleSignOut = async () => {
    try { await apiFetch("/auth/logout", { method: "POST" }); } catch {}
    clearTeacherToken();
    setLocation("/");
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cpForm.next !== cpForm.confirm) {
      toast({ title: "Passwords don't match", variant: "destructive" });
      return;
    }
    setCpLoading(true);
    setCpSuccess(false);
    try {
      await apiFetch("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: cpForm.current, newPassword: cpForm.next }),
      });
      setCpSuccess(true);
      setCpForm({ current: "", next: "", confirm: "" });
      toast({ title: "Password updated", description: "Your new password is active." });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setCpLoading(false);
    }
  };

  const handleSaveAiSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setAiLoading(true);
    try {
      const body: any = { aiProvider: aiForm.aiProvider, aiKey: aiForm.aiKey };
      if (aiForm.aiProvider === "azure" && aiForm.azureEndpoint) body.azureEndpoint = aiForm.azureEndpoint;
      const result = await apiFetch("/teacher/org/ai-settings", { method: "PUT", body: JSON.stringify(body) });
      setAiSettings({ configured: true, aiProvider: result.aiProvider, aiKeyMasked: result.aiKeyMasked, azureEndpoint: aiForm.aiProvider === "azure" ? aiForm.azureEndpoint : null });
      setAiForm({ ...aiForm, aiKey: "", azureEndpoint: "" });
      setShowAiForm(false);
      toast({ title: "AI key saved" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setAiLoading(false);
    }
  };

  // TOTP handlers
  const handleTotpSetup = async () => {
    setTotpLoading(true);
    try {
      const result = await apiFetch("/teacher/totp/setup");
      setTotpSetup(result);
      setTotpCode("");
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setTotpLoading(false);
    }
  };

  const handleTotpEnable = async (e: React.FormEvent) => {
    e.preventDefault();
    setTotpLoading(true);
    try {
      await apiFetch("/teacher/totp/enable", { method: "POST", body: JSON.stringify({ code: totpCode.replace(/\s/g, "") }) });
      setTeacher({ ...teacher, totpEnabled: true });
      setTotpSetup(null);
      setTotpCode("");
      toast({ title: "Two-factor authentication enabled", description: "Your account is now protected with 2FA." });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setTotpLoading(false);
    }
  };

  const handleTotpDisable = async (e: React.FormEvent) => {
    e.preventDefault();
    setTotpLoading(true);
    try {
      await apiFetch("/teacher/totp/disable", { method: "POST", body: JSON.stringify({ code: totpDisableCode.replace(/\s/g, "") }) });
      setTeacher({ ...teacher, totpEnabled: false });
      setShowTotpDisable(false);
      setTotpDisableCode("");
      toast({ title: "Two-factor authentication disabled" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setTotpLoading(false);
    }
  };

  // IT admin: generate reset link
  const handleGenerateReset = async (teacherId: number) => {
    setGeneratingReset(teacherId);
    try {
      const result = await apiFetch(`/teacher/org/teacher/${teacherId}/request-reset`, { method: "POST" });
      const url = `${window.location.origin}/reset-password?token=${result.resetToken}`;
      setResetLinks((prev) => ({ ...prev, [teacherId]: url }));
      toast({ title: "Reset link generated", description: "Copy the link and share it securely with the teacher." });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setGeneratingReset(null);
    }
  };

  const handleUnlock = async (teacherId: number) => {
    setUnlocking(teacherId);
    try {
      await apiFetch(`/teacher/org/teacher/${teacherId}/unlock`, { method: "POST" });
      setOrgTeachers((prev) => prev.map((t) => t.id === teacherId ? { ...t, failedLoginAttempts: 0, lockedUntil: null } : t));
      toast({ title: "Account unlocked" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setUnlocking(null);
    }
  };

  const handleToggleAdmin = async (t: OrgTeacher) => {
    setTogglingAdmin(t.id);
    try {
      await apiFetch(`/teacher/org/teacher/${t.id}/set-admin`, {
        method: "PATCH",
        body: JSON.stringify({ isItAdmin: !t.isItAdmin }),
      });
      setOrgTeachers((prev) => prev.map((o) => o.id === t.id ? { ...o, isItAdmin: !t.isItAdmin } : o));
      toast({ title: t.isItAdmin ? "Admin removed" : "IT Admin granted", description: t.name });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setTogglingAdmin(null);
    }
  };

  const handleTestEmail = async () => {
    setTestEmailSending(true);
    setTestEmailResult(null);
    try {
      await apiFetch("/auth/test-email", { method: "POST" });
      setTestEmailResult({ ok: true, message: `Test email sent to ${teacher?.email}. Check your inbox.` });
    } catch (err: any) {
      setTestEmailResult({ ok: false, message: err.message ?? "Failed to send test email" });
    } finally {
      setTestEmailSending(false);
    }
  };

  // IT admin: load audit log
  const handleLoadAuditLog = async () => {
    if (showAuditLog) { setShowAuditLog(false); return; }
    setAuditLoading(true);
    try {
      const entries = await apiFetch("/teacher/audit-log");
      setAuditLog(entries);
      setShowAuditLog(true);
    } catch (err: any) {
      toast({ title: "Error loading audit log", description: err.message, variant: "destructive" });
    } finally {
      setAuditLoading(false);
    }
  };

  if (loading) return null;

  const isLocked = (t: OrgTeacher) => t.lockedUntil && new Date(t.lockedUntil) > new Date();

  return (
    <div className="min-h-[100dvh] bg-neutral-50 text-neutral-900 font-sans">
      <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm">
            <Link href="/teacher/dashboard" className="text-neutral-500 hover:text-black transition-colors">Dashboard</Link>
            <span className="text-neutral-300">/</span>
            <span className="font-medium">Settings</span>
          </div>
          <div className="flex items-center gap-6 text-sm">
            <span className="flex items-center gap-2 text-neutral-600">
              {teacher?.name}
              {teacher?.isItAdmin && (
                <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">IT Admin</span>
              )}
            </span>
            <button onClick={handleSignOut} className="hover:text-black transition-colors text-neutral-500">Sign Out</button>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-12 space-y-6">
        <div className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight mb-2">Account</h1>
          {teacher?.isItAdmin && (
            <span className="inline-block px-2.5 py-1 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">IT Admin</span>
          )}
        </div>

        {/* Profile card */}
        <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm space-y-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-1">Name</p>
            <p className="font-medium">{teacher?.name}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-1">Email</p>
            <p className="font-medium">{teacher?.email}</p>
          </div>
        </div>

        {/* Invite code (IT admin only) */}
        {teacher?.isItAdmin && inviteCode !== null && (
          <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm space-y-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-1">Teacher Invite Code</p>
              <p className="text-sm text-neutral-600">Teachers enter this when they register.</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-mono text-2xl font-semibold tracking-widest">{inviteCode}</span>
              <button
                onClick={handleCopyCode}
                className="rounded-xl border border-neutral-200 px-3 py-1.5 text-xs hover:bg-neutral-50 transition-colors"
              >
                {codeCopied ? "✓ Copied" : "Copy"}
              </button>
            </div>
            <div className="pt-1 border-t border-neutral-100">
              <button
                onClick={handleRotateCode}
                disabled={rotatingCode}
                className="rounded-2xl border border-red-200 text-red-600 px-4 py-2 text-sm hover:bg-red-50 transition-colors disabled:opacity-50"
              >
                {rotatingCode ? "Rotating…" : "Rotate code (invalidates current)"}
              </button>
              <p className="text-xs text-neutral-400 mt-2">Existing teacher accounts are unaffected — only new registrations need the new code.</p>
            </div>
          </div>
        )}

        {/* Email domain allowlist (IT admin only) */}
        {teacher?.isItAdmin && domainsLoaded && (
          <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm space-y-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-1">Allowed Email Domains</p>
              <p className="text-sm text-neutral-600">
                {allowedDomains.length === 0
                  ? "No restriction — anyone with the invite code can register. Add a domain to limit registration to school email addresses."
                  : "Only email addresses from these domains can register with your invite code."}
              </p>
            </div>

            {allowedDomains.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {allowedDomains.map((d) => (
                  <span key={d} className="inline-flex items-center gap-1.5 rounded-full bg-neutral-100 px-3 py-1 text-sm font-mono">
                    @{d}
                    <button
                      onClick={() => handleRemoveDomain(d)}
                      className="text-neutral-400 hover:text-red-500 transition-colors leading-none"
                      aria-label={`Remove ${d}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="flex gap-2 items-start">
              <div className="flex-1">
                <input
                  type="text"
                  value={newDomain}
                  onChange={(e) => { setNewDomain(e.target.value); setDomainError(""); }}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAddDomain(); } }}
                  placeholder="school.edu.au"
                  className="w-full rounded-2xl border border-neutral-200 px-4 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-neutral-300"
                />
                {domainError && <p className="text-xs text-red-500 mt-1">{domainError}</p>}
              </div>
              <button
                onClick={handleAddDomain}
                className="rounded-2xl border border-neutral-200 px-4 py-2 text-sm hover:bg-neutral-50 transition-colors"
              >
                Add
              </button>
            </div>

            <div className="pt-1 border-t border-neutral-100 flex items-center justify-between gap-4">
              <p className="text-xs text-neutral-400">
                {allowedDomains.length === 0 ? "Save with no domains to remove the restriction." : `${allowedDomains.length} domain${allowedDomains.length !== 1 ? "s" : ""} will be enforced.`}
              </p>
              <button
                onClick={handleSaveDomains}
                disabled={savingDomains}
                className="rounded-2xl bg-neutral-900 text-white px-5 py-2 text-sm hover:bg-neutral-700 transition-colors disabled:opacity-50"
              >
                {savingDomains ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        )}

        {/* Teachers list (IT admin only) */}
        {teacher?.isItAdmin && orgTeachers.length > 0 && (
          <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm space-y-4">
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-1">Teacher Accounts</p>
            <div className="divide-y divide-neutral-100">
              {orgTeachers.map((t) => (
                <div key={t.id} className="py-4 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-medium text-sm">
                        {t.name}
                        {t.isItAdmin && <span className="ml-2 text-xs text-blue-600 font-normal">IT Admin</span>}
                        {t.mustChangePassword && <span className="ml-2 text-xs text-amber-600 font-normal">Must change password</span>}
                        {isLocked(t) && <span className="ml-2 text-xs text-red-600 font-normal">Locked</span>}
                      </p>
                      <p className="text-xs text-neutral-400 mt-0.5">{t.email}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {isLocked(t) && (
                        <button
                          onClick={() => handleUnlock(t.id)}
                          disabled={unlocking === t.id}
                          className="rounded-xl border border-amber-200 text-amber-700 px-3 py-1.5 text-xs hover:bg-amber-50 transition-colors disabled:opacity-50"
                        >
                          {unlocking === t.id ? "Unlocking…" : "Unlock"}
                        </button>
                      )}
                      {t.id !== teacher.id && (
                        <>
                          <button
                            onClick={() => handleToggleAdmin(t)}
                            disabled={togglingAdmin === t.id}
                            className={`rounded-xl border px-3 py-1.5 text-xs transition-colors disabled:opacity-50 ${t.isItAdmin ? "border-blue-200 text-blue-700 hover:bg-blue-50" : "border-neutral-200 text-neutral-600 hover:bg-neutral-50"}`}
                          >
                            {togglingAdmin === t.id ? "Saving…" : t.isItAdmin ? "Remove admin" : "Make IT Admin"}
                          </button>
                          <button
                            onClick={() => handleGenerateReset(t.id)}
                            disabled={generatingReset === t.id}
                            className="rounded-xl border border-neutral-200 px-3 py-1.5 text-xs hover:bg-neutral-50 transition-colors disabled:opacity-50"
                          >
                            {generatingReset === t.id ? "Generating…" : "Reset password"}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {resetLinks[t.id] && (
                    <div className="mt-2 p-3 rounded-xl bg-amber-50 border border-amber-200">
                      <p className="text-xs text-amber-700 font-medium mb-1">Share this link securely (expires in 1 hour):</p>
                      <div className="flex items-center gap-2">
                        <input
                          readOnly
                          value={resetLinks[t.id]}
                          className="text-xs font-mono flex-1 bg-transparent border-0 outline-none text-neutral-700 truncate"
                        />
                        <button
                          onClick={() => { navigator.clipboard.writeText(resetLinks[t.id]); toast({ title: "Copied" }); }}
                          className="text-xs text-amber-700 hover:text-amber-900 shrink-0"
                        >
                          Copy
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* AI Configuration */}
        {teacher?.isItAdmin ? (
          <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-1">AI Configuration</p>
                <p className="text-sm text-neutral-600">Set or update your school's AI provider key.</p>
              </div>
              {aiSettings?.configured && !showAiForm && (
                <button
                  onClick={() => setShowAiForm(true)}
                  className="rounded-2xl border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50 transition-colors"
                >
                  Update Key
                </button>
              )}
            </div>

            {aiSettings?.configured && !showAiForm ? (
              <div className="rounded-2xl bg-neutral-50 border border-neutral-100 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                  <p className="text-sm font-medium">
                    {aiSettings.aiProvider === "gemini" ? "Google Gemini" : "Azure OpenAI"} — configured
                  </p>
                </div>
                <p className="text-xs text-neutral-400 font-mono pl-4">{aiSettings.aiKeyMasked}</p>
                {aiSettings.aiProvider === "azure" && aiSettings.azureEndpoint && (
                  <p className="text-xs text-neutral-400 pl-4">Endpoint: {aiSettings.azureEndpoint}</p>
                )}
              </div>
            ) : (
              (!aiSettings?.configured || showAiForm) && (
                <form onSubmit={handleSaveAiSettings} className="space-y-4 pt-2">
                  <div>
                    <label className="block text-sm font-medium mb-2">AI Provider</label>
                    <div className="flex gap-3">
                      {(["gemini", "azure"] as const).map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setAiForm({ ...aiForm, aiProvider: p })}
                          className={`flex-1 rounded-2xl border py-2.5 text-sm font-medium transition-colors ${
                            aiForm.aiProvider === p ? "border-black bg-black text-white" : "border-neutral-200 hover:border-neutral-400"
                          }`}
                        >
                          {p === "gemini" ? "Google Gemini" : "Azure OpenAI"}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">API Key</label>
                    <input
                      required
                      type="password"
                      value={aiForm.aiKey}
                      onChange={(e) => setAiForm({ ...aiForm, aiKey: e.target.value })}
                      placeholder="Paste your API key here"
                      className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10 font-mono text-sm"
                    />
                  </div>
                  {aiForm.aiProvider === "azure" && (
                    <div>
                      <label className="block text-sm font-medium mb-2">Azure Endpoint</label>
                      <input
                        required
                        type="url"
                        value={aiForm.azureEndpoint}
                        onChange={(e) => setAiForm({ ...aiForm, azureEndpoint: e.target.value })}
                        placeholder="https://your-resource.openai.azure.com"
                        className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10 text-sm"
                      />
                    </div>
                  )}
                  <div className="flex gap-3">
                    <button
                      type="submit"
                      disabled={aiLoading}
                      className="rounded-2xl bg-black text-white px-6 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                    >
                      {aiLoading ? "Saving…" : "Save AI Key"}
                    </button>
                    {showAiForm && (
                      <button
                        type="button"
                        onClick={() => setShowAiForm(false)}
                        className="rounded-2xl border border-neutral-300 px-6 py-2.5 text-sm hover:bg-neutral-50 transition-colors"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-neutral-400">The key is encrypted before storage. It is never readable by teachers or students.</p>
                </form>
              )
            )}
          </div>
        ) : (
          <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm">
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-3">AI Configuration</p>
            <p className="text-sm text-neutral-600">AI is configured by your school's IT administrator.</p>
          </div>
        )}

        {/* Email / SMTP Status (IT admin only) */}
        {teacher?.isItAdmin && smtpConfigured !== null && (
          <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm space-y-4">
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-400">Email (Password Reset)</p>
            {smtpConfigured ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                  <p className="text-sm font-medium">Email configured — teachers can reset their own password.</p>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    onClick={handleTestEmail}
                    disabled={testEmailSending}
                    className="rounded-2xl border border-neutral-200 px-4 py-2 text-sm hover:bg-neutral-50 transition-colors disabled:opacity-50"
                  >
                    {testEmailSending ? "Sending…" : "Send test email"}
                  </button>
                  {testEmailResult && (
                    <p className={`text-sm ${testEmailResult.ok ? "text-emerald-600" : "text-red-600"}`}>
                      {testEmailResult.ok ? "✓ " : "✗ "}{testEmailResult.message}
                    </p>
                  )}
                </div>
                <p className="text-xs text-neutral-400">Sends a test message to your own address ({teacher?.email}) to confirm delivery is working.</p>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-neutral-300 shrink-0" />
                  <p className="text-sm font-medium text-neutral-600">Email not configured.</p>
                </div>
                <p className="text-xs text-neutral-400">
                  Set <code className="font-mono bg-neutral-100 px-1 rounded">SMTP_HOST</code>, <code className="font-mono bg-neutral-100 px-1 rounded">SMTP_USER</code>, <code className="font-mono bg-neutral-100 px-1 rounded">SMTP_PASS</code>, and optionally <code className="font-mono bg-neutral-100 px-1 rounded">SMTP_PORT</code> / <code className="font-mono bg-neutral-100 px-1 rounded">SMTP_FROM</code> as environment variables to enable self-service password reset emails. Until then, reset links must be generated manually in the Teacher Accounts section above.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Two-Factor Authentication */}
        <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-1">Two-Factor Authentication</p>
              <p className="text-sm text-neutral-600">
                {teacher?.totpEnabled ? "2FA is active on your account." : "Add an extra layer of security to your account."}
              </p>
            </div>
            {teacher?.totpEnabled && !showTotpDisable && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-50 text-emerald-700 text-xs font-medium border border-emerald-200">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                Active
              </span>
            )}
          </div>

          {teacher?.totpEnabled ? (
            !showTotpDisable ? (
              <button
                onClick={() => setShowTotpDisable(true)}
                className="rounded-2xl border border-red-200 text-red-600 px-4 py-2 text-sm hover:bg-red-50 transition-colors"
              >
                Disable 2FA
              </button>
            ) : (
              <form onSubmit={handleTotpDisable} className="space-y-4">
                <p className="text-sm text-neutral-600">Enter your authenticator code to confirm disabling 2FA:</p>
                <input
                  required
                  type="text"
                  inputMode="numeric"
                  autoFocus
                  value={totpDisableCode}
                  onChange={(e) => setTotpDisableCode(e.target.value)}
                  maxLength={8}
                  className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-center text-xl tracking-widest font-mono focus:outline-none focus:ring-2 focus:ring-black/10"
                  placeholder="000 000"
                />
                <div className="flex gap-3">
                  <button
                    type="submit"
                    disabled={totpLoading}
                    className="rounded-2xl border border-red-300 bg-red-50 text-red-700 px-5 py-2 text-sm font-medium hover:bg-red-100 transition-colors disabled:opacity-50"
                  >
                    {totpLoading ? "Disabling…" : "Confirm Disable"}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowTotpDisable(false); setTotpDisableCode(""); }}
                    className="rounded-2xl border border-neutral-300 px-5 py-2 text-sm hover:bg-neutral-50 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )
          ) : totpSetup ? (
            <div className="space-y-5">
              <div className="rounded-2xl border border-neutral-200 p-5 text-center">
                <p className="text-sm font-medium mb-4">Scan this QR code with your authenticator app</p>
                <img src={totpSetup.qrCode} alt="TOTP QR code" className="inline-block w-48 h-48 rounded-xl" />
                <p className="text-xs text-neutral-400 mt-3">
                  Or enter manually: <span className="font-mono font-medium text-neutral-700">{totpSetup.secret}</span>
                </p>
              </div>
              <form onSubmit={handleTotpEnable} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-2">Enter the 6-digit code to confirm setup</label>
                  <input
                    required
                    type="text"
                    inputMode="numeric"
                    autoFocus
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value)}
                    maxLength={8}
                    className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-center text-xl tracking-widest font-mono focus:outline-none focus:ring-2 focus:ring-black/10"
                    placeholder="000 000"
                  />
                </div>
                <div className="flex gap-3">
                  <button
                    type="submit"
                    disabled={totpLoading || totpCode.replace(/\s/g, "").length < 6}
                    className="rounded-2xl bg-black text-white px-6 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {totpLoading ? "Enabling…" : "Enable 2FA"}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setTotpSetup(null); setTotpCode(""); }}
                    className="rounded-2xl border border-neutral-300 px-6 py-2.5 text-sm hover:bg-neutral-50 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          ) : (
            <button
              onClick={handleTotpSetup}
              disabled={totpLoading}
              className="rounded-2xl bg-black text-white px-6 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {totpLoading ? "Loading…" : "Set up 2FA"}
            </button>
          )}
        </div>

        {/* Audit log (IT admin only) */}
        {teacher?.isItAdmin && (
          <div className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
            <div className="px-8 py-6 flex items-center justify-between border-b border-neutral-200">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-1">Security Audit Log</p>
                <p className="text-sm text-neutral-600">Last 200 security events for your school.</p>
              </div>
              <button
                onClick={handleLoadAuditLog}
                disabled={auditLoading}
                className="rounded-2xl border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50 transition-colors disabled:opacity-50"
              >
                {auditLoading ? "Loading…" : showAuditLog ? "Hide" : "View Log"}
              </button>
            </div>
            {showAuditLog && (
              <div className="overflow-x-auto">
                {auditLog.length === 0 ? (
                  <p className="p-8 text-sm text-neutral-500 text-center">No audit entries yet.</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-neutral-100 bg-neutral-50">
                        <th className="text-left px-6 py-3 text-neutral-500 font-medium">Time</th>
                        <th className="text-left px-4 py-3 text-neutral-500 font-medium">Action</th>
                        <th className="text-left px-4 py-3 text-neutral-500 font-medium">User</th>
                        <th className="text-left px-4 py-3 text-neutral-500 font-medium">IP</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-50">
                      {auditLog.map((entry) => (
                        <tr key={entry.id} className="hover:bg-neutral-50">
                          <td className="px-6 py-3 text-neutral-400 whitespace-nowrap font-mono">
                            {new Date(entry.createdAt).toLocaleString()}
                          </td>
                          <td className="px-4 py-3 font-medium text-neutral-700">{entry.action}</td>
                          <td className="px-4 py-3 text-neutral-500">{entry.teacherName ?? "—"}</td>
                          <td className="px-4 py-3 text-neutral-400 font-mono">{entry.ipAddress ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        )}

        {/* Change password */}
        <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm space-y-5">
          <p className="text-xs uppercase tracking-[0.2em] text-neutral-400">Change Password</p>
          <form onSubmit={handleChangePassword} className="space-y-4 max-w-sm">
            <div>
              <label className="block text-sm font-medium mb-2">Current password</label>
              <input
                required
                type="password"
                value={cpForm.current}
                onChange={(e) => setCpForm({ ...cpForm, current: e.target.value })}
                className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                placeholder="Your current password"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">New password</label>
              <input
                required
                type="password"
                value={cpForm.next}
                onChange={(e) => setCpForm({ ...cpForm, next: e.target.value })}
                minLength={8}
                className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                placeholder="At least 8 characters"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Confirm new password</label>
              <input
                required
                type="password"
                value={cpForm.confirm}
                onChange={(e) => setCpForm({ ...cpForm, confirm: e.target.value })}
                minLength={8}
                className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                placeholder="Same password again"
              />
            </div>
            <button
              type="submit"
              disabled={cpLoading}
              className="rounded-2xl bg-black text-white px-6 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {cpLoading ? "Saving…" : "Update password"}
            </button>
            {cpSuccess && <p className="text-sm text-emerald-600">✓ Password updated successfully.</p>}
          </form>
        </div>

        {/* Sign out */}
        <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm">
          <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-4">Session</p>
          <button
            onClick={handleSignOut}
            className="rounded-2xl border border-neutral-300 px-5 py-2.5 text-sm font-medium hover:bg-neutral-50 transition-colors"
          >
            Sign Out
          </button>
        </div>
      </main>
    </div>
  );
}
