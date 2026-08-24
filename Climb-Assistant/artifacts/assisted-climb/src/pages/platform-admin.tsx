import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

interface ItAdmin {
  id: number;
  name: string;
  email: string;
}

interface Org {
  id: number;
  name: string;
  slug: string;
  active: boolean;
  teacherInviteCode: string;
  teacherCount: number;
  studentCount: number;
  climbsStarted: number;
  createdAt: string;
  itAdmin: ItAdmin | null;
}

interface ResetResult {
  teacherName: string;
  teacherEmail: string;
  tempPassword: string;
}

type Modal =
  | { type: "reset"; teacherId: number; teacherName: string; teacherEmail: string }
  | { type: "new-admin"; orgId: number; orgName: string }
  | { type: "result"; result: ResetResult };

export default function PlatformAdmin() {
  const { toast } = useToast();
  const [secret, setSecret] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [copiedCode, setCopiedCode] = useState<number | null>(null);
  const [copiedPassword, setCopiedPassword] = useState(false);
  const [modal, setModal] = useState<Modal | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Forgot password / recovery
  const [showForgot, setShowForgot] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState("");
  const [recoveredSecret, setRecoveredSecret] = useState("");
  const [recoveryError, setRecoveryError] = useState("");
  const [recoveryLoading, setRecoveryLoading] = useState(false);

  // Change password
  const [showChangeSecret, setShowChangeSecret] = useState(false);
  const [changeForm, setChangeForm] = useState({ current: "", next: "", confirm: "" });
  const [changeLoading, setChangeLoading] = useState(false);

  const [createForm, setCreateForm] = useState({
    name: "", slug: "", itAdminEmail: "", itAdminPassword: "", itAdminName: "",
  });

  const [newAdminForm, setNewAdminForm] = useState({ name: "", email: "", password: "" });

  const headers = { "x-admin-secret": secret };

  const loadOrgs = async (adminSecret: string) => {
    setLoading(true);
    try {
      const data = await apiFetch("/admin/organisations", { headers: { "x-admin-secret": adminSecret } });
      setOrgs(data);
      setAuthenticated(true);
    } catch (err: any) {
      toast({ title: "Access denied", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    await loadOrgs(secret);
  };

  const handleRecovery = async () => {
    setRecoveryLoading(true);
    setRecoveryError("");
    setRecoveredSecret("");
    try {
      const result = await apiFetch("/admin/verify-recovery-key", {
        method: "POST",
        body: JSON.stringify({ recoveryKey }),
      });
      setRecoveredSecret(result.adminSecret);
    } catch (err: any) {
      setRecoveryError(err.message || "Invalid recovery key");
    } finally {
      setRecoveryLoading(false);
    }
  };

  const handleLogout = () => {
    setSecret("");
    setAuthenticated(false);
    setOrgs([]);
  };

  const handleChangeSecret = async (e: React.FormEvent) => {
    e.preventDefault();
    if (changeForm.next !== changeForm.confirm) {
      toast({ title: "New secrets don't match", variant: "destructive" });
      return;
    }
    setChangeLoading(true);
    try {
      await apiFetch("/admin/change-secret", {
        method: "POST",
        headers,
        body: JSON.stringify({ currentSecret: changeForm.current, newSecret: changeForm.next }),
      });
      setSecret(changeForm.next);
      setChangeForm({ current: "", next: "", confirm: "" });
      setShowChangeSecret(false);
      toast({ title: "Admin secret updated" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setChangeLoading(false);
    }
  };

  const handleToggleActive = async (org: Org) => {
    try {
      const updated = await apiFetch(`/admin/organisations/${org.id}/active`, {
        method: "PATCH", headers, body: JSON.stringify({ active: !org.active }),
      });
      setOrgs((prev) => prev.map((o) => o.id === org.id ? { ...o, active: updated.active } : o));
      toast({ title: org.active ? "School suspended" : "School activated", description: org.name });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const handleCreateSchool = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const result = await apiFetch("/admin/organisations", {
        method: "POST", headers, body: JSON.stringify(createForm),
      });
      toast({ title: "School created", description: `${result.organisation.name} — invite code: ${result.organisation.teacherInviteCode}` });
      setCreateForm({ name: "", slug: "", itAdminEmail: "", itAdminPassword: "", itAdminName: "" });
      setShowCreate(false);
      await loadOrgs(secret);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetPassword = async () => {
    if (!modal || modal.type !== "reset") return;
    setSubmitting(true);
    try {
      const result = await apiFetch(`/admin/teachers/${modal.teacherId}/reset-password`, {
        method: "POST", headers,
      });
      setCopiedPassword(false);
      setModal({ type: "result", result });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
      setModal(null);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateItAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modal || modal.type !== "new-admin") return;
    setSubmitting(true);
    try {
      await apiFetch(`/admin/organisations/${modal.orgId}/it-admin`, {
        method: "POST", headers, body: JSON.stringify(newAdminForm),
      });
      toast({ title: "IT admin created", description: `${newAdminForm.name} added to ${modal.orgName}` });
      setNewAdminForm({ name: "", email: "", password: "" });
      setModal(null);
      await loadOrgs(secret);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const copyInviteCode = (orgId: number, code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(orgId);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  const copyTempPassword = (pw: string) => {
    navigator.clipboard.writeText(pw);
    setCopiedPassword(true);
  };

  // ── Login gate ────────────────────────────────────────────────────────────────
  if (!authenticated) {
    return (
      <div className="min-h-[100dvh] bg-neutral-950 flex items-center justify-center p-6 font-sans">
        <div className="w-full max-w-sm">
          <div className="mb-8 text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-white/10 mb-4">
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <h1 className="text-2xl font-semibold text-white mb-1">Platform Admin</h1>
            <p className="text-sm text-neutral-500">Enter your admin secret to continue</p>
          </div>
          {!showForgot ? (
            <>
              <form onSubmit={handleAuth} className="space-y-4">
                <input
                  type="password" value={secret} onChange={(e) => setSecret(e.target.value)}
                  placeholder="Admin secret" autoFocus
                  className="w-full rounded-2xl bg-white/10 border border-white/10 px-4 py-3 text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/20 text-sm"
                />
                <button type="submit" disabled={loading || !secret}
                  className="w-full rounded-2xl bg-white text-black px-6 py-3.5 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-40">
                  {loading ? "Checking…" : "Continue"}
                </button>
              </form>
              <div className="mt-4 text-center">
                <button onClick={() => setShowForgot(true)} className="text-sm text-neutral-500 hover:text-white transition-colors">
                  Forgot your admin secret?
                </button>
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-neutral-400 text-center">Enter your recovery key to retrieve your admin secret.</p>
              <input
                type="password" value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)}
                placeholder="Recovery key" autoFocus
                className="w-full rounded-2xl bg-white/10 border border-white/10 px-4 py-3 text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/20 text-sm"
              />
              {recoveredSecret && (
                <div className="rounded-2xl bg-emerald-500/10 border border-emerald-500/20 p-4 space-y-2">
                  <p className="text-xs text-emerald-400 font-medium">Your admin secret:</p>
                  <code className="block text-sm text-white font-mono bg-white/10 rounded-xl px-3 py-2 break-all">{recoveredSecret}</code>
                  <p className="text-xs text-neutral-500">Use this to log in above.</p>
                </div>
              )}
              {recoveryError && (
                <p className="text-sm text-red-400 text-center">{recoveryError}</p>
              )}
              <div className="flex gap-3">
                <button onClick={() => { setShowForgot(false); setRecoveryKey(""); setRecoveredSecret(""); setRecoveryError(""); }}
                  className="flex-1 rounded-2xl border border-white/20 px-4 py-3 text-sm text-neutral-400 hover:text-white transition-colors">
                  Back
                </button>
                <button onClick={handleRecovery} disabled={!recoveryKey || recoveryLoading}
                  className="flex-1 rounded-2xl bg-white text-black px-6 py-3 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-40">
                  {recoveryLoading ? "Verifying…" : "Verify"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Modals ────────────────────────────────────────────────────────────────────
  const renderModal = () => {
    if (!modal) return null;

    if (modal.type === "reset") {
      return (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-sm bg-neutral-900 rounded-[2rem] border border-white/10 p-7 space-y-5">
            <div className="text-center space-y-2">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-amber-500/20 mb-1">
                <svg className="w-6 h-6 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-white">Reset password?</h2>
              <p className="text-sm text-neutral-400">
                This will generate a temporary password for <span className="text-white font-medium">{modal.teacherName}</span> ({modal.teacherEmail}). They'll be prompted to set a new one on login.
              </p>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setModal(null)}
                className="flex-1 rounded-2xl border border-white/20 px-4 py-3 text-sm text-neutral-400 hover:text-white transition-colors">
                Cancel
              </button>
              <button onClick={handleResetPassword} disabled={submitting}
                className="flex-1 rounded-2xl bg-amber-500 text-black px-4 py-3 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50">
                {submitting ? "Resetting…" : "Reset password"}
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (modal.type === "result") {
      const { result } = modal;
      return (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-sm bg-neutral-900 rounded-[2rem] border border-white/10 p-7 space-y-5">
            <div className="text-center space-y-2">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-emerald-500/20 mb-1">
                <svg className="w-6 h-6 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-white">Password reset</h2>
              <p className="text-sm text-neutral-400">
                Share this temporary password with <span className="text-white font-medium">{result.teacherName}</span>. They must change it on first login.
              </p>
            </div>
            <div>
              <p className="text-xs text-neutral-500 mb-2">Temporary password — shown once</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-white/10 rounded-xl px-4 py-3 text-sm font-mono text-white tracking-widest">
                  {result.tempPassword}
                </code>
                <button onClick={() => copyTempPassword(result.tempPassword)}
                  className={`rounded-xl px-3 py-3 text-xs font-medium transition-colors shrink-0 ${copiedPassword ? "bg-emerald-500/20 text-emerald-400" : "bg-white/10 hover:bg-white/20 text-neutral-300"}`}>
                  {copiedPassword ? "✓" : "Copy"}
                </button>
              </div>
            </div>
            <button onClick={() => setModal(null)}
              className="w-full rounded-2xl bg-white text-black px-6 py-3 text-sm font-medium hover:opacity-90 transition-opacity">
              Done
            </button>
          </div>
        </div>
      );
    }

    if (modal.type === "new-admin") {
      return (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-sm bg-neutral-900 rounded-[2rem] border border-white/10 p-7 space-y-5">
            <div className="text-center space-y-1">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-violet-500/20 mb-1">
                <svg className="w-6 h-6 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-white">New IT admin</h2>
              <p className="text-sm text-neutral-400">{modal.orgName}</p>
            </div>
            <form onSubmit={handleCreateItAdmin} className="space-y-3">
              <div>
                <label className="block text-xs text-neutral-500 mb-1.5">Full name</label>
                <input required type="text" value={newAdminForm.name}
                  onChange={(e) => setNewAdminForm({ ...newAdminForm, name: e.target.value })}
                  placeholder="Jane Smith"
                  className="w-full rounded-xl bg-white/10 border border-white/10 px-4 py-2.5 text-sm text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/20"
                />
              </div>
              <div>
                <label className="block text-xs text-neutral-500 mb-1.5">Email address</label>
                <input required type="email" value={newAdminForm.email}
                  onChange={(e) => setNewAdminForm({ ...newAdminForm, email: e.target.value })}
                  placeholder="it@school.edu"
                  className="w-full rounded-xl bg-white/10 border border-white/10 px-4 py-2.5 text-sm text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/20"
                />
              </div>
              <div>
                <label className="block text-xs text-neutral-500 mb-1.5">Temporary password</label>
                <input required type="password" value={newAdminForm.password} minLength={8}
                  onChange={(e) => setNewAdminForm({ ...newAdminForm, password: e.target.value })}
                  placeholder="Min. 8 characters"
                  className="w-full rounded-xl bg-white/10 border border-white/10 px-4 py-2.5 text-sm text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/20"
                />
              </div>
              <p className="text-xs text-neutral-500">They'll be asked to change this password on first login.</p>
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setModal(null)}
                  className="flex-1 rounded-2xl border border-white/20 px-4 py-3 text-sm text-neutral-400 hover:text-white transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={submitting}
                  className="flex-1 rounded-2xl bg-violet-500 text-white px-4 py-3 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50">
                  {submitting ? "Creating…" : "Create admin"}
                </button>
              </div>
            </form>
          </div>
        </div>
      );
    }
  };

  // ── Main dashboard ────────────────────────────────────────────────────────────
  return (
    <div className="min-h-[100dvh] bg-neutral-950 text-white font-sans">
      {renderModal()}

      <header className="border-b border-white/10 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Platform Admin</h1>
          <p className="text-xs text-neutral-500 mt-0.5">The Assisted Climb</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowChangeSecret(!showChangeSecret)}
            className="rounded-2xl border border-white/20 text-neutral-300 hover:text-white px-4 py-2 text-sm font-medium transition-colors">
            Change Secret
          </button>
          <button onClick={handleLogout}
            className="rounded-2xl border border-red-500/30 text-red-400 hover:bg-red-500/10 px-4 py-2 text-sm font-medium transition-colors">
            Log Out
          </button>
          <button onClick={() => setShowCreate(!showCreate)}
            className="rounded-2xl bg-white text-black px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity">
            + New School
          </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8 space-y-6">

        {/* Change admin secret form */}
        {showChangeSecret && (
          <div className="rounded-[2rem] bg-white/5 border border-white/10 p-8">
            <h2 className="text-base font-semibold mb-4">Change Admin Secret</h2>
            <form onSubmit={handleChangeSecret} className="space-y-4 max-w-sm">
              <div>
                <label className="block text-xs text-neutral-400 mb-1.5">Current secret</label>
                <input
                  type="password" required value={changeForm.current}
                  onChange={(e) => setChangeForm({ ...changeForm, current: e.target.value })}
                  className="w-full rounded-xl bg-white/10 border border-white/10 px-4 py-2.5 text-sm text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/20"
                />
              </div>
              <div>
                <label className="block text-xs text-neutral-400 mb-1.5">New secret (min. 8 characters)</label>
                <input
                  type="password" required minLength={8} value={changeForm.next}
                  onChange={(e) => setChangeForm({ ...changeForm, next: e.target.value })}
                  className="w-full rounded-xl bg-white/10 border border-white/10 px-4 py-2.5 text-sm text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/20"
                />
              </div>
              <div>
                <label className="block text-xs text-neutral-400 mb-1.5">Confirm new secret</label>
                <input
                  type="password" required value={changeForm.confirm}
                  onChange={(e) => setChangeForm({ ...changeForm, confirm: e.target.value })}
                  className="w-full rounded-xl bg-white/10 border border-white/10 px-4 py-2.5 text-sm text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/20"
                />
              </div>
              <p className="text-xs text-neutral-500">Note: this change lasts until the server restarts. Update your environment variable for a permanent change.</p>
              <div className="flex gap-3">
                <button type="submit" disabled={changeLoading}
                  className="rounded-2xl bg-white text-black px-6 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50">
                  {changeLoading ? "Saving…" : "Update Secret"}
                </button>
                <button type="button" onClick={() => { setShowChangeSecret(false); setChangeForm({ current: "", next: "", confirm: "" }); }}
                  className="rounded-2xl border border-white/20 px-6 py-2.5 text-sm text-neutral-400 hover:text-white transition-colors">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Create school form */}
        {showCreate && (
          <div className="rounded-[2rem] bg-white/5 border border-white/10 p-8">
            <h2 className="text-base font-semibold mb-6">Register a School</h2>
            <form onSubmit={handleCreateSchool} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-neutral-400 mb-1.5">School Name</label>
                  <input required type="text" value={createForm.name}
                    onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                    placeholder="St Mary's Academy"
                    className="w-full rounded-xl bg-white/10 border border-white/10 px-4 py-2.5 text-sm text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/20"
                  />
                </div>
                <div>
                  <label className="block text-xs text-neutral-400 mb-1.5">Slug</label>
                  <input required type="text" value={createForm.slug}
                    onChange={(e) => setCreateForm({ ...createForm, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })}
                    placeholder="st-marys-academy"
                    className="w-full rounded-xl bg-white/10 border border-white/10 px-4 py-2.5 text-sm text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/20"
                  />
                </div>
              </div>
              <div className="pt-2 border-t border-white/10">
                <p className="text-xs text-neutral-500 mb-3">IT Administrator account</p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-neutral-400 mb-1.5">Name</label>
                    <input required type="text" value={createForm.itAdminName}
                      onChange={(e) => setCreateForm({ ...createForm, itAdminName: e.target.value })}
                      placeholder="Jane Smith"
                      className="w-full rounded-xl bg-white/10 border border-white/10 px-4 py-2.5 text-sm text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/20"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-neutral-400 mb-1.5">Email</label>
                    <input required type="email" value={createForm.itAdminEmail}
                      onChange={(e) => setCreateForm({ ...createForm, itAdminEmail: e.target.value })}
                      placeholder="it@school.edu"
                      className="w-full rounded-xl bg-white/10 border border-white/10 px-4 py-2.5 text-sm text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/20"
                    />
                  </div>
                </div>
                <div className="mt-4">
                  <label className="block text-xs text-neutral-400 mb-1.5">Password</label>
                  <input required type="password" value={createForm.itAdminPassword} minLength={8}
                    onChange={(e) => setCreateForm({ ...createForm, itAdminPassword: e.target.value })}
                    placeholder="Min. 8 characters"
                    className="w-full rounded-xl bg-white/10 border border-white/10 px-4 py-2.5 text-sm text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/20"
                  />
                </div>
              </div>
              <div className="flex gap-3 pt-2">
                <button type="submit" disabled={submitting}
                  className="rounded-2xl bg-white text-black px-6 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50">
                  {submitting ? "Creating…" : "Register School"}
                </button>
                <button type="button" onClick={() => setShowCreate(false)}
                  className="rounded-2xl border border-white/20 px-6 py-2.5 text-sm text-neutral-400 hover:text-white transition-colors">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {/* School list */}
        <div className="space-y-3">
          <h2 className="text-xs font-medium text-neutral-500 uppercase tracking-widest">
            Schools ({orgs.length})
          </h2>

          {orgs.length === 0 && (
            <div className="rounded-[2rem] bg-white/5 border border-white/10 p-12 text-center">
              <p className="text-neutral-500 text-sm">No schools registered yet.</p>
            </div>
          )}

          {orgs.map((org) => (
            <div key={org.id}
              className={`rounded-[2rem] border ${org.active ? "bg-white/5 border-white/10" : "bg-white/[0.02] border-white/5 opacity-60"}`}>

              {/* Top row: name + status + actions */}
              <div className="px-6 pt-5 pb-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <h3 className="font-semibold text-white text-base">{org.name}</h3>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${org.active ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"}`}>
                      {org.active ? "Active" : "Suspended"}
                    </span>
                  </div>
                  {/* Headline stats */}
                  <div className="flex items-center gap-4 mt-2 flex-wrap">
                    <span className="text-sm text-neutral-300">
                      <span className="font-semibold">{org.teacherCount}</span>
                      <span className="text-neutral-500 ml-1">teacher{org.teacherCount !== 1 ? "s" : ""}</span>
                    </span>
                    <span className="text-sm text-neutral-300">
                      <span className="font-semibold">{org.studentCount}</span>
                      <span className="text-neutral-500 ml-1">student{org.studentCount !== 1 ? "s" : ""}</span>
                    </span>
                    <span className="text-sm text-neutral-300">
                      <span className="font-semibold">{org.climbsStarted}</span>
                      <span className="text-neutral-500 ml-1">climb{org.climbsStarted !== 1 ? "s" : ""} started</span>
                    </span>
                    <span className="text-xs text-neutral-600">since {new Date(org.createdAt).toLocaleDateString("en-GB")}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => copyInviteCode(org.id, org.teacherInviteCode)}
                    title="Copy teacher invite code"
                    className="rounded-xl bg-white/10 hover:bg-white/15 px-3 py-1.5 text-xs text-neutral-300 transition-colors font-mono">
                    {copiedCode === org.id ? "✓ Copied" : org.teacherInviteCode}
                  </button>
                  <button onClick={() => handleToggleActive(org)}
                    className={`rounded-xl px-3 py-1.5 text-xs font-medium transition-colors ${org.active ? "bg-red-500/10 text-red-400 hover:bg-red-500/20" : "bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20"}`}>
                    {org.active ? "Suspend" : "Activate"}
                  </button>
                </div>
              </div>

              {/* IT admin row */}
              <div className="mx-6 mb-5 rounded-2xl bg-white/5 border border-white/5 px-4 py-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="shrink-0 w-8 h-8 rounded-full bg-violet-500/20 flex items-center justify-center">
                    <svg className="w-4 h-4 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5.121 17.804A13.937 13.937 0 0112 16c2.5 0 4.847.655 6.879 1.804M15 10a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-medium text-white truncate">{org.itAdmin?.name ?? "No IT admin"}</p>
                      <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-violet-500/20 text-violet-400">IT Admin</span>
                    </div>
                    <p className="text-xs text-neutral-500 truncate">{org.itAdmin?.email ?? "—"}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {org.itAdmin && (
                    <button
                      onClick={() => setModal({ type: "reset", teacherId: org.itAdmin!.id, teacherName: org.itAdmin!.name, teacherEmail: org.itAdmin!.email })}
                      className="rounded-xl bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 px-3 py-1.5 text-xs font-medium transition-colors">
                      Reset password
                    </button>
                  )}
                  <button
                    onClick={() => { setNewAdminForm({ name: "", email: "", password: "" }); setModal({ type: "new-admin", orgId: org.id, orgName: org.name }); }}
                    className="rounded-xl bg-violet-500/10 text-violet-400 hover:bg-violet-500/20 px-3 py-1.5 text-xs font-medium transition-colors">
                    {org.itAdmin ? "New admin" : "Add IT admin"}
                  </button>
                </div>
              </div>

            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
