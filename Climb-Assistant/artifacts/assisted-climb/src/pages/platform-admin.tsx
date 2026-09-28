import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { classifyWorkspaceError, WorkspaceRequestState, type WorkspaceFailureState } from "@/components/WorkspaceRequestState";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface ItAdmin {
  id: number;
  name: string;
  email: string;
}
type CigAdminRole = "master" | "subadmin";

interface CigAdmin {
  id: number;
  name: string;
  email: string;
  role: CigAdminRole;
  active: boolean;
  totpEnabled: boolean;
  createdAt: string;
  deleted: boolean;
  deletedAt: string | null;
}

interface Org {
  id: number;
  name: string;
  slug: string;
  active: boolean;
  status: "active" | "suspended" | "deleted";
  deleted: boolean;
  deletedAt: string | null;
  teacherInviteCode: string | null;
  teacherCount: number;
  classCount: number;
  studentCount: number;
  climbsStarted: number;
  climbsFinished?: number;
  climbsInProgress?: number;
  createdAt: string;
  itAdmin: ItAdmin | null;
}

interface EmailStatus {
  configured: boolean;
  host: string | null;
  port: number | null;
  secure: boolean;
  from: string | null;
  credentialSource: "environment";
  testRecipient: string | null;
}

interface HibpOutageEvent {
  occurredAt: string;
}

interface DeletionSummary {
  id: number;
  name: string;
  teachers: number;
  classes: number;
  studentSessions: number;
  stageEntries: number;
  chatMessages: number;
  feedback: number;
  tasks: number;
  auditLogs: number;
}

type AuthView =
  | "loading"
  | "bootstrap"
  | "bootstrap-totp"
  | "recovery-codes"
  | "login"
  | "verify-totp"
  | "recover"
  | "claim-account-link"
  | "dashboard";

type AdminTab = "schools" | "administrators" | "retention" | "activity" | "reports" | "email" | "security";
interface PlatformRetentionSettings {
  archiveRetentionDays: number;
  minimumDays: number;
  maximumDays: number;
  standardChoices: number[];
}

interface ActivityLogItem {
  id: string;
  source: "cig-admin-security" | "audit";
  category: "administrator-security" | "school-administration";
  action: string;
  label: string;
  occurredAt: string;
  actor: { name: string | null; email: string | null; role: string } | null;
  school: { name: string; slug: string | null } | null;
  account: { label: string } | null;
  outcome: string;
  context: string;
}

interface ActivityLogResponse {
  items: ActivityLogItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface ArchiveWarningReviewItem {
  id: string;
  school: { name: string; slug: string | null };
  attemptedAt: string;
  archiveExpiresAt: string;
  ageHours: number;
  providerMessageId: string;
}

type SchoolMasterResetOrg = Pick<Org, "id" | "name" | "itAdmin">;

type Modal =
  | { type: "create-school" }
  | { type: "school-master-manual-reset"; org: SchoolMasterResetOrg; emailStatus: "not-configured" | "failed" }
  | { type: "school-master-manual-link"; schoolMasterName: string; resetUrl: string; expiresAt: string }
  | { type: "new-admin"; orgId: number; orgName: string }
  | { type: "new-cig-admin" }
  | { type: "cig-admin-manual-link"; admin: Pick<CigAdmin, "id" | "name" | "email">; emailStatus: "not-configured" | "failed" }
  | { type: "cig-admin-account-link"; adminName: string; accountLinkUrl: string; expiresAt: string }
  | { type: "change-password" }
  | { type: "fresh-mfa" }
  | { type: "regenerate-recovery-prompt" }
  | { type: "show-recovery-codes"; codes: string[] }
  | { type: "school-lifecycle"; org: Org; action: "remove" | "restore" | "permanent" };

function ShieldIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

interface ArchiveWarningReviewResponse {
  generatedAt: string;
  thresholdHours: number;
  thresholdAt: string;
  items: ArchiveWarningReviewItem[];
  truncated: boolean;
  privacy: string;
  guidance: string[];
}

function AlertTriangleIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

const inputClass = "block w-full rounded-lg border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900 shadow-sm transition-shadow";
const labelClass = "block text-xs font-medium text-zinc-700 mb-1.5";
const btnPrimary = "px-4 py-2 text-sm font-medium text-white bg-zinc-900 rounded-lg hover:bg-zinc-800 shadow-sm transition-colors disabled:opacity-50";
const btnSecondary = "px-4 py-2 text-sm font-medium text-zinc-700 bg-white border border-zinc-300 rounded-lg hover:bg-zinc-50 shadow-sm transition-colors disabled:opacity-50";
const passwordCharacters = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";

function combinePersonName(firstName: string, surname: string): string {
  return `${firstName.trim()} ${surname.trim()}`.trim();
}

function generateTemporaryPassword(length = 16): string {
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  return Array.from(values, value => passwordCharacters[value % passwordCharacters.length]).join("");
}

const RecoveryCodesContent = ({ codes, onDone, buttonText }: { codes: string[], onDone: () => void, buttonText: string }) => {
  const { toast } = useToast();
  return (
    <div>
      <div className="text-center mb-6">
        <div className="mx-auto w-12 h-12 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center mb-3">
          <AlertTriangleIcon className="w-6 h-6" />
        </div>
        <h2 className="text-lg font-semibold text-zinc-900">Save Your Recovery Codes</h2>
        <p className="text-sm text-zinc-600 mt-1">
          These codes are the only way to access your account if you lose your authenticator app. <strong>They will not be shown again.</strong>
        </p>
      </div>
      <div className="bg-zinc-50 border border-zinc-200 rounded-lg p-4 mb-6">
        <div className="grid grid-cols-2 gap-3">
          {codes.map((code, i) => (
            <div key={i} className="font-mono text-sm bg-white border border-zinc-200 rounded px-3 py-2 text-center text-zinc-800 select-all tracking-widest">
              {code}
            </div>
          ))}
        </div>
      </div>
      <div className="flex gap-3">
        <button type="button" onClick={() => {
          navigator.clipboard.writeText(codes.join('\n'));
          toast({ title: "Copied", description: "Recovery codes copied to clipboard." });
        }} className={btnSecondary + " flex-1 py-2.5"}>
          Copy Codes
        </button>
        <button type="button" onClick={onDone} className={btnPrimary + " flex-1 py-2.5"}>
          {buttonText}
        </button>
      </div>
    </div>
  );
};

export default function PlatformAdmin() {
  const { toast } = useToast();
  const [view, setView] = useState<AuthView>("loading");
  const [loadError, setLoadError] = useState<WorkspaceFailureState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [modal, setModal] = useState<Modal | null>(null);

  const [orgs, setOrgs] = useState<Org[]>([]);
  const [orgTotal, setOrgTotal] = useState(0);
  const [orgTotalPages, setOrgTotalPages] = useState(1);
  const [schoolFilters, setSchoolFilters] = useState({ q: "", status: "active", from: "", to: "", page: 1 });
  const [totpData, setTotpData] = useState<{ qrCode: string; secret: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);

  // Forms
  const [bootstrapForm, setBootstrapForm] = useState({ bootstrapSecret: "", firstName: "", surname: "", email: "", password: "" });
  const [totpCode, setTotpCode] = useState("");
  const [loginForm, setLoginForm] = useState({ email: "", password: "" });
  const [recoverForm, setRecoverForm] = useState({
    email: "",
    newPassword: "",
    code: "",
    method: "totp" as "totp" | "recovery",
    action: "password" as "password" | "device",
  });

  const [createForm, setCreateForm] = useState({ name: "", slug: "", itAdminEmail: "", itAdminPassword: "", itAdminFirstName: "", itAdminSurname: "" });
  const [newAdminForm, setNewAdminForm] = useState({ firstName: "", surname: "", email: "", password: "" });
  const [newCigAdminForm, setNewCigAdminForm] = useState({ firstName: "", surname: "", email: "" });
  const [accountLinkToken, setAccountLinkToken] = useState("");
  const [accountLinkForm, setAccountLinkForm] = useState({ password: "", confirmPassword: "" });
  const [freshMfaCode, setFreshMfaCode] = useState("");
  const [pendingFreshMfaAction, setPendingFreshMfaAction] = useState<(() => Promise<void>) | null>(null);
  const [changePwForm, setChangePwForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [hibpWarning, setHibpWarning] = useState<string | null>(null);
  const [acceptHibpWarning, setAcceptHibpWarning] = useState(false);

  const [deletionSummary, setDeletionSummary] = useState<DeletionSummary | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [currentAdmin, setCurrentAdmin] = useState<{ name: string; email: string; role: CigAdminRole } | null>(null);
  const [cigAdmins, setCigAdmins] = useState<CigAdmin[]>([]);
  const [cigAdminTotal, setCigAdminTotal] = useState(0);
  const [cigAdminTotalPages, setCigAdminTotalPages] = useState(1);
  const [adminFilters, setAdminFilters] = useState({ q: "", status: "active", from: "", to: "", page: 1 });
  const [activeTab, setActiveTab] = useState<AdminTab>("schools");
  const [retentionSettings, setRetentionSettings] = useState<PlatformRetentionSettings | null>(null);
  const [retentionForm, setRetentionForm] = useState({ defaultDays: "30", minimumDays: "1", maximumDays: "3650", choices: "30, 60, 90, 180, 365" });
  const [retentionSaving, setRetentionSaving] = useState(false);
  const [emailStatus, setEmailStatus] = useState<EmailStatus | null>(null);
  const [hibpOutageEvents, setHibpOutageEvents] = useState<HibpOutageEvent[] | null>(null);
  const [hibpOutageEventsLoading, setHibpOutageEventsLoading] = useState(false);
  const [hibpOutageEventsError, setHibpOutageEventsError] = useState(false);
  const [testingPlatformEmail, setTestingPlatformEmail] = useState(false);
  const [activityLog, setActivityLog] = useState<ActivityLogResponse | null>(null);
  const [activityLogFilters, setActivityLogFilters] = useState({ category: "", action: "", from: "", to: "", page: 1 });
  const [activityLogLoading, setActivityLogLoading] = useState(false);
  const [activityLogError, setActivityLogError] = useState(false);
  const [activityLogInvalidFilter, setActivityLogInvalidFilter] = useState(false);
  const [activityReportLoading, setActivityReportLoading] = useState(false);
  const [activityReportError, setActivityReportError] = useState(false);
  const [activityReportEmpty, setActivityReportEmpty] = useState(false);
  const [archiveWarningReview, setArchiveWarningReview] = useState<ArchiveWarningReviewResponse | null>(null);
  const [archiveWarningReviewOpen, setArchiveWarningReviewOpen] = useState(false);
  const [archiveWarningReviewLoading, setArchiveWarningReviewLoading] = useState(false);
  const [archiveWarningReviewError, setArchiveWarningReviewError] = useState(false);
  const [sendingSchoolMasterResetId, setSendingSchoolMasterResetId] = useState<number | null>(null);
  const [statusChangeOrg, setStatusChangeOrg] = useState<Org | null>(null);
  const [statusChangeSubmitting, setStatusChangeSubmitting] = useState(false);
  const isMaster = currentAdmin?.role === "master";
  const activeCigAdminCount = cigAdmins.filter((admin) => admin.active && !admin.deleted).length;
  const currentOrgs = orgs.filter((org) => !org.deleted);
  const deletedOrgs = orgs.filter((org) => org.deleted);
  const showingSuspendedSchools = schoolFilters.status === "suspended"
    || (currentOrgs.length > 0 && currentOrgs.every((org) => !org.active));
  const currentCigAdmins = cigAdmins.filter((admin) => !admin.deleted);
  const deletedCigAdmins = cigAdmins.filter((admin) => admin.deleted);
  const [reportScope, setReportScope] = useState<"all" | number>("all");
  const [reportOrgs, setReportOrgs] = useState<Org[] | null>(null);
  const [reportLoading, setReportLoading] = useState(false);

  const showAdminLogin = (message?: string) => {
    setView("login");
    setModal(null);
    setLoadError(null);
    setCurrentAdmin(null);
    setOrgs([]);
    setOrgTotal(0);
    setOrgTotalPages(1);
    setCigAdmins([]);
    setCigAdminTotal(0);
    setCigAdminTotalPages(1);
    setEmailStatus(null);
    setRetentionSettings(null);
    setHibpOutageEvents(null);
    setHibpOutageEventsError(false);
    setArchiveWarningReview(null);
    setActivityLog(null);
    setReportOrgs(null);
    setActiveTab("schools");
    if (message) {
      toast({ title: "Administrator session ended", description: message });
    }
  };

  const directoryUrl = (path: string, filters: { q: string; status: string; from: string; to: string; page: number }) => {
    const params = new URLSearchParams({ status: filters.status, page: String(filters.page), pageSize: "25" });
    if (filters.q.trim()) params.set("q", filters.q.trim());
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    return `${path}?${params.toString()}`;
  };

  const loadSchools = async (filters = schoolFilters) => {
    const data = await apiFetch(directoryUrl("/admin/organisations", filters));
    setOrgs(Array.isArray(data) ? data : data.items);
    setOrgTotal(Array.isArray(data) ? data.length : data.total);
    setOrgTotalPages(Array.isArray(data) ? 1 : data.totalPages);
  };

  const loadCigAdmins = async (filters = adminFilters) => {
    const data = await apiFetch(directoryUrl("/admin/auth/cig-admins", filters));
    setCigAdmins(data.admins);
    setCigAdminTotal(data.total);
    setCigAdminTotalPages(data.totalPages);
  };

  const loadHibpOutageEvents = async () => {
    setHibpOutageEventsLoading(true);
    setHibpOutageEventsError(false);
    try {
      const data = await apiFetch("/admin/security/hibp-outages");
      setHibpOutageEvents(Array.isArray(data?.events) ? data.events : []);
    } catch (error: any) {
      setHibpOutageEvents(null);
      setHibpOutageEventsError(true);
      if (error?.status === 401) {
        showAdminLogin("Please sign in again to continue.");
      }
    } finally {
      setHibpOutageEventsLoading(false);
    }
  };

  const loadArchiveWarningReview = async () => {
    setArchiveWarningReviewLoading(true);
    setArchiveWarningReviewError(false);
    try {
      const data = await apiFetch("/admin/archive-warning-deliveries") as ArchiveWarningReviewResponse;
      setArchiveWarningReview(data);
    } catch {
      setArchiveWarningReviewError(true);
    } finally {
      setArchiveWarningReviewLoading(false);
    }
  };

  const activityLogUrl = (filters = activityLogFilters) => {
    const params = new URLSearchParams({ page: String(filters.page), pageSize: "25" });
    if (filters.category) params.set("category", filters.category);
    if (filters.action) params.set("action", filters.action);
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    return `/admin/activity-log?${params.toString()}`;
  };

  const activityLogReportUrl = (filters = activityLogFilters) => {
    const params = new URLSearchParams();
    if (filters.category) params.set("category", filters.category);
    if (filters.action) params.set("action", filters.action);
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    return `/admin/activity-log/report?${params.toString()}`;
  };

  const loadActivityLog = async (filters = activityLogFilters) => {
    setActivityLogLoading(true);
    setActivityLogError(false);
    setActivityLogInvalidFilter(false);
    try {
      const data = await apiFetch(activityLogUrl(filters)) as ActivityLogResponse;
      setActivityLog(data);
    } catch (error: any) {
      if (error?.status === 400) setActivityLogInvalidFilter(true);
      else setActivityLogError(true);
    } finally {
      setActivityLogLoading(false);
    }
  };

  const runActivityReport = async () => {
    setActivityReportLoading(true);
    setActivityReportError(false);
    setActivityReportEmpty(false);
    setActivityLogInvalidFilter(false);
    try {
      const filters = { ...activityLogFilters, page: 1 };
      const current = await apiFetch(activityLogUrl(filters)) as ActivityLogResponse;
      setActivityLog(current);
      if (!current.items.length) {
        setActivityReportEmpty(true);
        return;
      }
      const csv = await apiFetch(activityLogReportUrl(filters), {
        headers: { Accept: "text/csv" },
      }) as string;
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "platform-activity-report.csv";
      link.click();
      URL.revokeObjectURL(url);
      toast({ title: "Activity report downloaded", description: "The report contains the filtered, redacted activity entries." });
    } catch (error: any) {
      if (error?.status === 400) setActivityLogInvalidFilter(true);
      else setActivityReportError(true);
    } finally {
      setActivityReportLoading(false);
    }
  };

  const init = async () => {
    setLoadError(null);
    setView("loading");
    try {
      const token = new URLSearchParams(window.location.search).get("cigAccountToken");
      if (token) {
        setAccountLinkToken(token);
        setView("claim-account-link");
        return;
      }
      const status = await apiFetch("/admin/auth/status");
      if (!status.hasAdmins) {
        setView("bootstrap");
        return;
      }
      if (!status.signedIn) {
        setCurrentAdmin(null);
        setCigAdmins([]);
        setView("login");
        return;
      }
      const [me, data] = await Promise.all([
        apiFetch("/admin/auth/me"),
        apiFetch("/admin/organisations?status=active&page=1&pageSize=25"),
      ]);
      setCurrentAdmin(me.admin);
       setOrgs(Array.isArray(data) ? data : data.items);
       setOrgTotal(Array.isArray(data) ? data.length : data.total);
       setOrgTotalPages(Array.isArray(data) ? 1 : data.totalPages);
      if (me.admin.role === "master") {
        const [admins, status, retention] = await Promise.all([
          apiFetch("/admin/auth/cig-admins?status=active&page=1&pageSize=25"),
          apiFetch("/admin/email-status").catch(() => null),
          apiFetch("/admin/retention-settings").catch(() => null),
        ]);
        setCigAdmins(admins.admins);
       setCigAdminTotal(admins.total);
       setCigAdminTotalPages(admins.totalPages);
        setEmailStatus(status);
        if (retention) {
          setRetentionSettings(retention);
          setRetentionForm({
            defaultDays: String(retention.archiveRetentionDays),
            minimumDays: String(retention.minimumDays),
            maximumDays: String(retention.maximumDays),
            choices: retention.standardChoices.join(", "),
          });
        }
        await Promise.all([
          loadHibpOutageEvents(),
          loadActivityLog(),
          loadArchiveWarningReview(),
        ]);
      } else {
        setCigAdmins([]);
        setEmailStatus(null);
        setHibpOutageEvents(null);
        setArchiveWarningReview(null);
        setActiveTab("schools");
      }
      setView("dashboard");
    } catch (error: any) {
      if (error?.status !== 401) {
        setLoadError(classifyWorkspaceError(error));
        return;
      }
      setCurrentAdmin(null);
      setCigAdmins([]);
      setEmailStatus(null);
      setActiveTab("schools");
      setView("login");
    }
  };

  useEffect(() => { init(); }, []);

  const openFreshMfa = (action: () => Promise<void>) => {
    setSubmitting(false);
    setFreshMfaCode("");
    setPendingFreshMfaAction(() => action);
    setModal({ type: "fresh-mfa" });
  };

  const runWithFreshMfa = (action: () => Promise<void>) => {
    openFreshMfa(action);
  };

  const handleFreshMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    const action = pendingFreshMfaAction;
    if (!action) return;
    setSubmitting(true);
    try {
      await apiFetch("/admin/auth/step-up", { method: "POST", body: JSON.stringify({ code: freshMfaCode }) });
      setModal(null);
      setPendingFreshMfaAction(null);
      setFreshMfaCode("");
      await action();
    } catch (err: any) {
      toast({ title: "Fresh authentication failed", description: err.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleClaimAccountLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (accountLinkForm.password !== accountLinkForm.confirmPassword) {
      toast({ title: "Passwords do not match", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const result = await apiFetch("/admin/auth/claim-account-link", {
        method: "POST",
        body: JSON.stringify({ token: accountLinkToken, password: accountLinkForm.password }),
      });
      setAccountLinkToken("");
      setAccountLinkForm({ password: "", confirmPassword: "" });
      window.history.replaceState({}, document.title, window.location.pathname);
      if (result.setupRequired) {
        setTotpData({ qrCode: result.qrCode, secret: result.secret });
        setTotpCode("");
        setView("bootstrap-totp");
      } else {
        setTotpCode("");
        setView("verify-totp");
      }
    } catch (err: any) {
      toast({ title: "Account link could not be used", description: err.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleBootstrap = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await apiFetch("/admin/auth/bootstrap", {
        method: "POST",
        body: JSON.stringify({
          bootstrapSecret: bootstrapForm.bootstrapSecret,
          name: combinePersonName(bootstrapForm.firstName, bootstrapForm.surname),
          email: bootstrapForm.email,
          password: bootstrapForm.password,
        })
      });
      setTotpData({ qrCode: res.qrCode, secret: res.secret });
      setView("bootstrap-totp");
      setTotpCode("");
    } catch (err: any) {
      toast({ title: "Bootstrap failed", description: err.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSetupTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await apiFetch("/admin/auth/setup-totp", {
        method: "POST",
        body: JSON.stringify({ code: totpCode })
      });
      setRecoveryCodes(res.recoveryCodes);
      setView("recovery-codes");
    } catch (err: any) {
      toast({ title: "Setup failed", description: err.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await apiFetch("/admin/auth/login", {
        method: "POST",
        body: JSON.stringify(loginForm)
      });
      if (res.setupRequired) {
        setTotpData({ qrCode: res.qrCode, secret: res.secret });
        setView("bootstrap-totp");
        setTotpCode("");
      } else if (res.totpRequired) {
        setView("verify-totp");
        setTotpCode("");
      } else {
        await init();
      }
    } catch (err: any) {
      toast({ title: "Sign in failed", description: err.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerifyTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiFetch("/admin/auth/verify-totp", {
        method: "POST",
        body: JSON.stringify({ code: totpCode })
      });
      await init();
    } catch (err: any) {
      toast({ title: "Verification failed", description: err.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleRecover = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      if (recoverForm.action === "device") {
        const res = await apiFetch("/admin/auth/recover-device", {
          method: "POST",
          body: JSON.stringify({ email: recoverForm.email, recoveryCode: recoverForm.code }),
        });
        setTotpData({ qrCode: res.qrCode, secret: res.secret });
        setTotpCode("");
        setView("bootstrap-totp");
        toast({ title: "Recovery code accepted", description: "Set up your new authenticator to finish recovery." });
        return;
      }
      const payload = {
        email: recoverForm.email,
        newPassword: recoverForm.newPassword,
        ...(recoverForm.method === "totp" ? { totpCode: recoverForm.code } : { recoveryCode: recoverForm.code })
      };
      await apiFetch("/admin/auth/recover", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      toast({ title: "Password reset", description: "You can now sign in with your new password." });
      setView("login");
      setRecoverForm({ email: "", newPassword: "", code: "", method: "totp", action: "password" });
    } catch (err: any) {
      toast({ title: "Recovery failed", description: err.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogout = async () => {
    try {
      await apiFetch("/admin/auth/logout", { method: "POST" });
      showAdminLogin();
    } catch (err: any) {
      if (err?.status === 401) {
        showAdminLogin();
        return;
      }
      toast({ title: "Sign out failed", description: err.message, variant: "destructive" });
    }
  };

  // Dashboard Actions
  const handleToggleActive = (org: Org) => {
    setStatusChangeOrg(org);
  };

  const handleConfirmToggleActive = async () => {
    if (!statusChangeOrg) return;
    const org = statusChangeOrg;
    const nextActive = !org.active;
    openFreshMfa(async () => {
      setStatusChangeSubmitting(true);
      try {
        await apiFetch(`/admin/organisations/${org.id}/active`, {
          method: "PATCH", body: JSON.stringify({ active: nextActive }),
        });
        await loadSchools();
         toast({ title: nextActive ? "School reactivated" : "School suspended", description: org.name });
      } catch (err: any) {
        toast({ title: "Error", description: err.message, variant: "destructive" });
      } finally {
        setStatusChangeSubmitting(false);
        setStatusChangeOrg(null);
      }
    });
  };

  const handleCreateSchool = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const result = await apiFetch("/admin/organisations", {
        method: "POST",
        body: JSON.stringify({
          name: createForm.name,
          slug: createForm.slug,
          itAdminEmail: createForm.itAdminEmail,
          itAdminPassword: createForm.itAdminPassword,
          itAdminName: combinePersonName(createForm.itAdminFirstName, createForm.itAdminSurname),
          acceptHibpWarning,
        }),
      });
      toast({
        title: "School created",
        description: result.warning
          ? `${result.organisation.name} is ready. The password breach check was unavailable.`
          : result.emailStatus === "sent"
          ? `${result.organisation.name} is ready and the school administrator received sign-in details.`
          : `${result.organisation.name} is ready. School administrator email: ${result.emailStatus === "failed" ? "delivery failed" : "not configured"}.`,
      });
      setCreateForm({ name: "", slug: "", itAdminEmail: "", itAdminPassword: "", itAdminFirstName: "", itAdminSurname: "" });
      setHibpWarning(null);
      setAcceptHibpWarning(false);
      await init();
      if (result.emailStatus === "sent") {
        setModal(null);
      } else {
        setModal({
          type: "school-master-manual-reset",
          org: {
            id: result.organisation.id,
            name: result.organisation.name,
            itAdmin: result.itAdmin,
          },
          emailStatus: result.emailStatus === "failed" ? "failed" : "not-configured",
        });
      }
    } catch (err: any) {
      if (err.code === "HIBP_UNAVAILABLE") {
        setHibpWarning(err.warning ?? err.message);
        setAcceptHibpWarning(false);
        return;
      }
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateItAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (modal?.type !== "new-admin") return;
    const name = combinePersonName(newAdminForm.firstName, newAdminForm.surname);
    const createRequest = async () => {
      setSubmitting(true);
      try {
        const result = await apiFetch(`/admin/organisations/${modal.orgId}/it-admin`, {
          method: "POST",
          body: JSON.stringify({
            name,
            email: newAdminForm.email,
            password: newAdminForm.password,
            acceptHibpWarning,
          }),
        });
        toast({
          title: "School Admin created",
          description: result.warning
            ? `${name} was added. The password breach check was unavailable.`
            : result.emailStatus === "sent"
            ? `${name} was added and received sign-in details.`
            : `${name} was added, but email is ${result.emailStatus === "failed" ? "not delivered" : "not configured"}.`,
        });
        setNewAdminForm({ firstName: "", surname: "", email: "", password: "" });
        setHibpWarning(null);
        setAcceptHibpWarning(false);
        await init();
        if (result.emailStatus === "sent") {
          setModal(null);
        } else {
          setModal({
            type: "school-master-manual-reset",
            org: {
              id: modal.orgId,
              name: modal.orgName,
              itAdmin: result.teacher,
            },
            emailStatus: result.emailStatus === "failed" ? "failed" : "not-configured",
          });
        }
      } catch (err: any) {
        if (err.code === "HIBP_UNAVAILABLE") {
          setHibpWarning(err.warning ?? err.message);
          setAcceptHibpWarning(false);
          return;
        }
        toast({ title: "Error", description: err.message, variant: "destructive" });
      } finally {
        setSubmitting(false);
      }
    };
    await runWithFreshMfa(createRequest);
  };

  const handleCreateCigAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = combinePersonName(newCigAdminForm.firstName, newCigAdminForm.surname);
    const createRequest = async () => {
      setSubmitting(true);
      try {
        const result = await apiFetch("/admin/auth/cig-admins", {
          method: "POST",
          body: JSON.stringify({ name, email: newCigAdminForm.email }),
        });
        setNewCigAdminForm({ firstName: "", surname: "", email: "" });
        if (result.emailStatus === "sent") {
          toast({
            title: "CIG administrator created",
            description: `${result.admin.name} was created and received a one-time account setup link.`,
          });
          setModal(null);
        } else {
          setModal({
            type: "cig-admin-manual-link",
            admin: result.admin,
            emailStatus: result.emailStatus === "failed" ? "failed" : "not-configured",
          });
        }
        await refreshCigAdmins();
      } catch (err: any) {
        if (err?.status === 401) {
          showAdminLogin("Please sign in again to continue.");
          return;
        }
        toast({ title: "Error", description: err.message, variant: "destructive" });
      } finally {
        setSubmitting(false);
      }
    };
    await runWithFreshMfa(createRequest);
  };

  const handleCreateCigAdminManualLink = async (admin: Pick<CigAdmin, "id" | "name" | "email">) => {
    const createManualLink = async () => {
      try {
        const result = await apiFetch(`/admin/auth/cig-admins/${admin.id}/manual-account-link`, { method: "POST" });
        setModal({
          type: "cig-admin-account-link",
          adminName: admin.name,
          accountLinkUrl: result.manualAccountLinkUrl,
          expiresAt: result.expiresAt,
        });
      } catch (err: any) {
        if (err?.status === 401) {
          showAdminLogin("Please sign in again to continue.");
          return;
        }
        toast({ title: "Manual account link could not be created", description: err.message, variant: "destructive" });
      }
    };
    await runWithFreshMfa(createManualLink);
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (changePwForm.newPassword !== changePwForm.confirmPassword) {
      toast({ title: "Passwords do not match", variant: "destructive" });
      return;
    }
    openFreshMfa(async () => {
      try {
        await apiFetch("/admin/auth/change-password", {
          method: "POST",
          body: JSON.stringify({ currentPassword: changePwForm.currentPassword, newPassword: changePwForm.newPassword })
        });
        setChangePwForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
        showAdminLogin("Your password was changed successfully. Sign in again with the new password.");
      } catch (err: any) {
        if (err?.status === 401 && err.message === "Your session has expired. Please sign in again.") {
          showAdminLogin("Please sign in again to continue.");
          return;
        }
        toast({ title: "Error", description: err.message, variant: "destructive" });
      }
    });
  };

  const handleRegenerateRecovery = async () => {
    try {
      await runWithFreshMfa(async () => {
        const res = await apiFetch("/admin/auth/regenerate-recovery-codes", { method: "POST" });
        setModal({ type: "show-recovery-codes", codes: res.recoveryCodes });
      });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const refreshCigAdmins = async () => {
    if (!isMaster) return;
    await loadCigAdmins();
  };

  const runSchoolSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const next = { ...schoolFilters, page: 1 };
    setSchoolFilters(next);
    try {
      await loadSchools(next);
    } catch (err: any) {
      toast({ title: "School search failed", description: err.message, variant: "destructive" });
    }
  };

  const runAdminSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const next = { ...adminFilters, page: 1 };
    setAdminFilters(next);
    try {
      await loadCigAdmins(next);
    } catch (err: any) {
      toast({ title: "Administrator search failed", description: err.message, variant: "destructive" });
    }
  };

  const reportCurrentOrgs = (reportOrgs ?? []).filter((org) => !org.deleted);
  const selectedReportOrgs = reportScope === "all" ? reportCurrentOrgs : reportCurrentOrgs.filter((org) => org.id === reportScope);
  const reportTotals = selectedReportOrgs.reduce((totals, org) => ({
    schools: totals.schools + 1,
    teachers: totals.teachers + org.teacherCount,
    students: totals.students + org.studentCount,
    finished: totals.finished + (org.climbsFinished ?? 0),
    inProgress: totals.inProgress + (org.climbsInProgress ?? 0),
  }), { schools: 0, teachers: 0, students: 0, finished: 0, inProgress: 0 });

  const downloadReportCsv = () => {
    const header = ["School", "Slug", "Status", "Enrolled", "Teachers", "Students", "Climbs finished", "Climbs in progress"];
    const quote = (value: string | number) => {
      const text = String(value);
      const spreadsheetSafe = /^[=+\-@]/.test(text) ? `'${text}` : text;
      return `"${spreadsheetSafe.replaceAll('"', '""')}"`;
    };
    const rows = selectedReportOrgs.map((org) => [
      org.name, org.slug, org.status, new Date(org.createdAt).toLocaleDateString("en-GB"),
      org.teacherCount, org.studentCount, org.climbsFinished ?? 0, org.climbsInProgress ?? 0,
    ].map(quote).join(","));
    const blob = new Blob([[header.map(quote).join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `assisted-climb-${reportScope === "all" ? "platform" : "school"}-report.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const runReport = async () => {
    setReportLoading(true);
    try {
      const report = await apiFetch("/admin/reports");
      setReportOrgs(report.items as Org[]);
    } catch (err: any) {
      toast({ title: "Report could not be prepared", description: err.message, variant: "destructive" });
    } finally {
      setReportLoading(false);
    }
  };

  const handleTestPlatformEmail = async () => {
    setTestingPlatformEmail(true);
    try {
      await apiFetch("/admin/email-test", { method: "POST" });
      toast({
        title: "Test email sent",
        description: `Check ${emailStatus?.testRecipient ?? "the Master account inbox"}.`,
      });
      setEmailStatus((current) => current ? { ...current, configured: true } : current);
    } catch (err: any) {
      toast({
        title: err.message?.includes("not configured") ? "Email service is not configured" : "Test email failed",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setTestingPlatformEmail(false);
    }
  };

  const handleToggleCigAdmin = async (admin: CigAdmin) => {
    if (!window.confirm(`${admin.active ? "Suspend" : "Reactivate"} ${admin.name}'s CIG sub-admin access?`)) return;
    openFreshMfa(async () => {
      await apiFetch(`/admin/auth/cig-admins/${admin.id}/active`, {
        method: "PATCH",
        body: JSON.stringify({ active: !admin.active }),
      });
      await refreshCigAdmins();
      toast({ title: admin.active ? "Sub-admin suspended" : "Sub-admin reactivated", description: admin.email });
    });
  };

  const handleResetCigPassword = async (admin: CigAdmin) => {
    if (!window.confirm(`Reset ${admin.name}'s password and email a one-time password setup link?`)) return;
    const resetRequest = async () => {
      try {
        const result = await apiFetch(`/admin/auth/cig-admins/${admin.id}/reset-password`, { method: "POST" });
        if (result.emailStatus === "sent") {
          toast({ title: "Password reset link sent", description: `A one-time password setup link was sent to ${admin.email}.` });
        } else {
          toast({ title: "Password reset link not sent", description: `Email is ${result.emailStatus === "failed" ? "not delivered" : "not configured"}. Configure delivery, then issue a new reset link.`, variant: "destructive" });
        }
      } catch (err: any) {
        toast({ title: "Password reset failed", description: err.message, variant: "destructive" });
      }
    };
    await runWithFreshMfa(resetRequest);
  };

  const handleSendSchoolMasterReset = async (org: Org) => {
    if (!org.itAdmin) return;
    if (!window.confirm(`Reset ${org.itAdmin.name}'s password and send a one-time link to ${org.itAdmin.email}? This will sign out their active sessions.`)) return;
    setSendingSchoolMasterResetId(org.id);
    const sendRequest = async () => {
      try {
        const result = await apiFetch(`/admin/organisations/${org.id}/school-master/reset-link`, {
          method: "POST",
          body: JSON.stringify({ teacherId: org.itAdmin!.id, deliveryMethod: "email" }),
        });
        if (result.emailStatus === "sent") {
          toast({ title: "Reset link sent", description: `A password reset link was sent to ${org.itAdmin!.email}.` });
        } else {
          setModal({ type: "school-master-manual-reset", org, emailStatus: result.emailStatus });
        }
      } catch (err: any) {
        toast({ title: "Reset link failed", description: err.message, variant: "destructive" });
      } finally {
        setSendingSchoolMasterResetId(null);
      }
    };
    await runWithFreshMfa(sendRequest);
  };

  const handleCreateSchoolMasterManualReset = async (org: SchoolMasterResetOrg) => {
    if (!org.itAdmin) return;
    const createManualLink = async () => {
      setSubmitting(true);
      try {
        const result = await apiFetch(`/admin/organisations/${org.id}/school-master/reset-link`, {
          method: "POST",
          body: JSON.stringify({ teacherId: org.itAdmin!.id, deliveryMethod: "manual" }),
        });
        setModal({
          type: "school-master-manual-link",
          schoolMasterName: org.itAdmin!.name,
          resetUrl: result.manualResetUrl,
          expiresAt: result.expiresAt,
        });
      } catch (err: any) {
        toast({ title: "Manual reset link could not be created", description: err.message, variant: "destructive" });
      } finally {
        setSubmitting(false);
      }
    };
    await runWithFreshMfa(createManualLink);
  };

  const handleResetCigMfa = async (admin: CigAdmin) => {
    if (!window.confirm(`Reset ${admin.name}'s authenticator? Their recovery codes will stop working until they set up MFA again.`)) return;
    const resetMfa = async () => {
      let result: any;
      try {
        result = await apiFetch(`/admin/auth/cig-admins/${admin.id}/reset-mfa`, { method: "POST" });
        toast({
          title: "Authenticator reset",
          description: result.emailStatus === "sent"
            ? `${admin.name} was notified to enrol a new authenticator.`
            : `${admin.name}'s authenticator was reset; email is ${result.emailStatus === "failed" ? "not delivered" : "not configured"}.`,
        });
        await refreshCigAdmins();
      } catch (err: any) {
        toast({ title: "Authenticator reset failed", description: err.message, variant: "destructive" });
      }
    };
    openFreshMfa(resetMfa);
  };

  const handleTransferMaster = async (admin: CigAdmin) => {
    if (!window.confirm(`Transfer Master CIG administrator responsibility to ${admin.name}? You will become a sub-admin immediately.`)) return;
    const transfer = async () => {
      try {
        await apiFetch(`/admin/auth/cig-admins/${admin.id}/role`, {
          method: "PATCH",
          body: JSON.stringify({ role: "master" }),
        });
        toast({ title: "Master responsibility transferred", description: `${admin.name} is now the protected Master CIG administrator.` });
        await init();
      } catch (err: any) {
        toast({ title: "Transfer failed", description: err.message, variant: "destructive" });
      }
    };
    openFreshMfa(transfer);
  };

  const handleRemoveCigAdmin = async (admin: CigAdmin) => {
    if (!window.confirm(`Permanently delete ${admin.name}'s CIG sub-admin account? This cannot be undone.`)) return;
    openFreshMfa(async () => {
      await apiFetch(`/admin/auth/cig-admins/${admin.id}`, { method: "DELETE" });
      await refreshCigAdmins();
      toast({ title: "Sub-admin deleted", description: admin.email });
    });
  };

  const openSchoolLifecycleModal = async (org: Org, action: "remove" | "restore" | "permanent") => {
    setModal({ type: "school-lifecycle", org, action });
    setDeletionSummary(null);
    setDeleteConfirmation("");
    try {
      const summary = await apiFetch(`/admin/organisations/${org.id}/deletion-summary`);
      setDeletionSummary(summary);
    } catch (err: any) {
      toast({ title: "Error fetching summary", description: err.message, variant: "destructive" });
      setModal(null);
    }
  };

  const handleSchoolLifecycle = async () => {
    if (modal?.type !== "school-lifecycle") return;
    const action = modal.action;
    const request = action === "remove"
      ? { path: `/admin/organisations/${modal.org.id}`, method: "DELETE", body: { confirmation: deleteConfirmation } }
      : action === "restore"
        ? { path: `/admin/organisations/${modal.org.id}/restore`, method: "POST", body: { confirmation: deleteConfirmation } }
        : { path: `/admin/organisations/${modal.org.id}/permanent`, method: "DELETE", body: { confirmation: deleteConfirmation, permanent: true } };
    const sendRequest = async () => {
      await apiFetch(request.path, { method: request.method, body: JSON.stringify(request.body) });
    };
    const finish = async () => {
      const message = action === "remove"
        ? `${modal.org.name} is hidden and blocked for 30 days. Its data can still be restored.`
        : action === "restore"
          ? `${modal.org.name} and its saved data are available again.`
          : `${modal.org.name} and all dependent data have been permanently destroyed.`;
      toast({ title: action === "remove" ? "School removed for recovery" : action === "restore" ? "School restored" : "School permanently deleted", description: message });
      setModal(null);
      await loadSchools();
    };
    if (action === "remove" || action === "permanent") {
      openFreshMfa(async () => {
        try {
          await sendRequest();
          await finish();
        } catch (err: any) {
          toast({ title: "Deletion failed", description: err.message, variant: "destructive" });
        }
      });
      return;
    }
    setSubmitting(true);
    try {
      await sendRequest();
      await finish();
    } catch (err: any) {
      toast({ title: "Deletion failed", description: err.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const renderModal = () => {
    if (!modal) return null;

    if (modal.type === "create-school") {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-900/60 backdrop-blur-sm">
          <div className="w-full max-w-lg bg-white rounded-xl shadow-xl overflow-hidden border border-zinc-200">
            <div className="px-6 py-5 border-b border-zinc-100 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-zinc-900">Register a School</h3>
              <button type="button" onClick={() => setModal(null)} className="text-zinc-400 hover:text-zinc-600">
                 <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <form onSubmit={handleCreateSchool}>
              <div className="px-6 py-5 space-y-5">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="platform-create-school-name" className={labelClass}>School Name</label>
                    <input id="platform-create-school-name" required type="text" value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} placeholder="St Mary's Academy" className={inputClass} />
                  </div>
                  <div>
                    <label htmlFor="platform-create-school-slug" className={labelClass}>Slug</label>
                    <input
                      id="platform-create-school-slug"
                      required
                      type="text"
                      value={createForm.slug}
                      onChange={(e) => setCreateForm({ ...createForm, slug: e.target.value.toLowerCase().replace(/[^a-z0-9.-]/g, "-") })}
                      pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*"
                      title="Use lowercase letters, numbers, hyphens, and dots. Do not start or end with a hyphen or dot."
                      placeholder="st-marys-academy.com"
                      className={inputClass}
                    />
                    <p className="text-xs text-zinc-500 mt-1.5">Lowercase letters, numbers, hyphens, and dots are allowed.</p>
                  </div>
                </div>
                <div className="pt-4 border-t border-zinc-100">
                  <h4 className="text-sm font-semibold text-zinc-900 mb-4">Initial School Admin</h4>
                  <div className="grid grid-cols-2 gap-4 mb-4">
                    <div>
                      <label htmlFor="platform-create-school-master-first-name" className={labelClass}>First name</label>
                      <input id="platform-create-school-master-first-name" required type="text" autoComplete="given-name" value={createForm.itAdminFirstName} onChange={(e) => setCreateForm({ ...createForm, itAdminFirstName: e.target.value })} placeholder="Jane" className={inputClass} />
                    </div>
                    <div>
                      <label htmlFor="platform-create-school-master-surname" className={labelClass}>Surname</label>
                      <input id="platform-create-school-master-surname" required type="text" autoComplete="family-name" value={createForm.itAdminSurname} onChange={(e) => setCreateForm({ ...createForm, itAdminSurname: e.target.value })} placeholder="Smith" className={inputClass} />
                    </div>
                    <div className="col-span-2">
                      <label htmlFor="platform-create-school-master-email" className={labelClass}>Admin Email</label>
                      <input id="platform-create-school-master-email" required type="email" autoComplete="email" value={createForm.itAdminEmail} onChange={(e) => setCreateForm({ ...createForm, itAdminEmail: e.target.value })} placeholder="it@school.edu" className={inputClass} />
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                       <label htmlFor="platform-create-school-master-password" className={labelClass + " mb-0"}>Temporary Password</label>
                      <button
                        type="button"
                        onClick={() => {
                          setCreateForm({ ...createForm, itAdminPassword: generateTemporaryPassword() });
                        }}
                        className="text-xs font-medium text-zinc-600 hover:text-zinc-900"
                      >
                        Generate secure password
                      </button>
                    </div>
                    <input
                      id="platform-create-school-master-password"
                      required
                      type="password"
                      autoComplete="new-password"
                      value={createForm.itAdminPassword}
                      minLength={12}
                      onChange={(e) => {
                        setCreateForm({ ...createForm, itAdminPassword: e.target.value });
                        setHibpWarning(null);
                        setAcceptHibpWarning(false);
                      }}
                      placeholder="Min 12 characters"
                      className={inputClass}
                    />
                    <p className="text-xs text-zinc-500 mt-1.5">They will be required to change this on their first login.</p>
                  </div>
                  {hibpWarning && (
                    <div role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                      <p className="font-medium">Breach check temporarily unavailable</p>
                      <p className="mt-1">{hibpWarning}</p>
                      <label className="mt-3 flex items-start gap-2">
                        <input type="checkbox" checked={acceptHibpWarning} onChange={(e) => setAcceptHibpWarning(e.target.checked)} className="mt-0.5" />
                        <span>I understand and want to continue with this temporary password.</span>
                      </label>
                    </div>
                  )}
                </div>
              </div>
              <div className="px-6 py-4 bg-zinc-50 border-t border-zinc-100 flex gap-3 justify-end">
                <button type="button" onClick={() => setModal(null)} className={btnSecondary}>Cancel</button>
                <button type="submit" disabled={submitting || Boolean(hibpWarning && !acceptHibpWarning)} className={btnPrimary}>
                  {submitting ? "Creating..." : "Create School"}
                </button>
              </div>
            </form>
          </div>
        </div>
      );
    }

    if (modal.type === "new-admin") {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-900/60 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-white rounded-xl shadow-xl overflow-hidden border border-zinc-200">
            <div className="px-6 py-5 border-b border-zinc-100">
              <h3 className="text-lg font-semibold text-zinc-900">New School Admin</h3>
              <p className="text-sm text-zinc-600 mt-1">{modal.orgName}</p>
            </div>
            <form onSubmit={handleCreateItAdmin}>
              <div className="px-6 py-5 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="platform-new-school-master-first-name" className={labelClass}>First name</label>
                    <input id="platform-new-school-master-first-name" required type="text" autoComplete="given-name" value={newAdminForm.firstName} onChange={(e) => setNewAdminForm({ ...newAdminForm, firstName: e.target.value })} placeholder="Jane" className={inputClass} />
                  </div>
                  <div>
                    <label htmlFor="platform-new-school-master-surname" className={labelClass}>Surname</label>
                    <input id="platform-new-school-master-surname" required type="text" autoComplete="family-name" value={newAdminForm.surname} onChange={(e) => setNewAdminForm({ ...newAdminForm, surname: e.target.value })} placeholder="Smith" className={inputClass} />
                  </div>
                </div>
                <div>
                  <label htmlFor="platform-new-school-master-email" className={labelClass}>Email address</label>
                  <input id="platform-new-school-master-email" required type="email" autoComplete="email" value={newAdminForm.email} onChange={(e) => setNewAdminForm({ ...newAdminForm, email: e.target.value })} placeholder="it@school.edu" className={inputClass} />
                </div>
                <div>
                  <label htmlFor="platform-new-school-master-password" className={labelClass}>Temporary password</label>
                  <input
                    id="platform-new-school-master-password"
                    required
                    type="password"
                    autoComplete="new-password"
                    value={newAdminForm.password}
                    minLength={12}
                    onChange={(e) => {
                      setNewAdminForm({ ...newAdminForm, password: e.target.value });
                      setHibpWarning(null);
                      setAcceptHibpWarning(false);
                    }}
                    placeholder="Min. 12 characters"
                    className={inputClass}
                  />
                  <p className="text-xs text-zinc-500 mt-1.5">They'll be asked to change this on first login.</p>
                </div>
                {hibpWarning && (
                  <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                    <p className="font-medium">Breach check temporarily unavailable</p>
                    <p className="mt-1">{hibpWarning}</p>
                    <label className="mt-3 flex items-start gap-2">
                      <input type="checkbox" checked={acceptHibpWarning} onChange={(e) => setAcceptHibpWarning(e.target.checked)} className="mt-0.5" />
                      <span>I understand and want to continue with this temporary password.</span>
                    </label>
                  </div>
                )}
              </div>
              <div className="px-6 py-4 bg-zinc-50 border-t border-zinc-100 flex gap-3 justify-end">
                <button type="button" onClick={() => setModal(null)} className={btnSecondary}>Cancel</button>
                <button type="submit" disabled={submitting || Boolean(hibpWarning && !acceptHibpWarning)} className={btnPrimary}>
                  {submitting ? "Creating..." : "Create Admin"}
                </button>
              </div>
            </form>
          </div>
        </div>
      );
    }

    if (modal.type === "new-cig-admin") {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-900/60 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-white rounded-xl shadow-xl overflow-hidden border border-zinc-200">
            <div className="px-6 py-5 border-b border-zinc-100">
              <h3 className="text-lg font-semibold text-zinc-900">Add CIG Sub-admin</h3>
                   <p className="text-sm text-zinc-600 mt-1">Adding an administrator is a high-risk action. After fresh MFA confirmation, they will receive a one-time link to choose their own password and set up MFA.</p>
            </div>
            <form onSubmit={handleCreateCigAdmin}>
              <div className="px-6 py-5 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="platform-new-cig-admin-first-name" className={labelClass}>First name</label>
                    <input id="platform-new-cig-admin-first-name" required type="text" autoComplete="given-name" value={newCigAdminForm.firstName} onChange={(e) => setNewCigAdminForm({ ...newCigAdminForm, firstName: e.target.value })} className={inputClass} />
                  </div>
                  <div>
                    <label htmlFor="platform-new-cig-admin-surname" className={labelClass}>Surname</label>
                    <input id="platform-new-cig-admin-surname" required type="text" autoComplete="family-name" value={newCigAdminForm.surname} onChange={(e) => setNewCigAdminForm({ ...newCigAdminForm, surname: e.target.value })} className={inputClass} />
                  </div>
                </div>
                <div>
                  <label htmlFor="platform-new-cig-admin-email" className={labelClass}>Email address</label>
                  <input id="platform-new-cig-admin-email" required type="email" autoComplete="email" value={newCigAdminForm.email} onChange={(e) => setNewCigAdminForm({ ...newCigAdminForm, email: e.target.value })} className={inputClass} />
                </div>
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950">
                  No temporary password is generated, displayed or emailed. The link expires after one hour and is single-use.
                </div>
                <p className="text-xs text-zinc-500">This account will be a sub-admin and cannot manage CIG administrator access or platform security.</p>
              </div>
              <div className="px-6 py-4 bg-zinc-50 border-t border-zinc-100 flex gap-3 justify-end">
                <button type="button" onClick={() => setModal(null)} className={btnSecondary}>Cancel</button>
                <button type="submit" disabled={submitting} className={btnPrimary}>{submitting ? "Creating..." : "Create sub-admin"}</button>
              </div>
            </form>
          </div>
        </div>
      );
    }

    if (modal.type === "cig-admin-manual-link") {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-900/60 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-white rounded-xl shadow-xl overflow-hidden border border-zinc-200 p-6 text-center">
            <div className="mx-auto w-12 h-12 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center mb-4">
              <AlertTriangleIcon className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-semibold text-zinc-900">Email unavailable</h3>
            <p className="text-sm text-zinc-600 mt-1 mb-6">
              {modal.emailStatus === "not-configured"
                ? "Email delivery is not configured."
                : "The account setup email could not be delivered."} Create a replacement one-time link for <strong>{modal.admin.name}</strong> instead?
            </p>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 mb-6 text-left text-sm text-amber-900">
              This replaces the undelivered link. Treat the new link like a password: share it only through an approved secure channel, not ordinary email or chat.
            </div>
            <div className="flex gap-3">
              <button onClick={() => setModal(null)} className={btnSecondary + " flex-1 py-2.5"}>Cancel</button>
              <button onClick={() => handleCreateCigAdminManualLink(modal.admin)} disabled={submitting} className={btnPrimary + " flex-1 py-2.5"}>
                {submitting ? "Creating…" : "Create manual link"}
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (modal.type === "cig-admin-account-link") {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-900/60 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-white rounded-xl shadow-xl overflow-hidden border border-zinc-200 p-6 text-center">
            <div className="mx-auto w-12 h-12 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mb-4">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
            </div>
            <h3 className="text-lg font-semibold text-zinc-900">One-time account link created</h3>
            <p className="text-sm text-zinc-600 mt-1 mb-4">
              Give this link directly to <strong>{modal.adminName}</strong>. It expires on {new Date(modal.expiresAt).toLocaleDateString("en-GB")} and works once.
            </p>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 mb-4 text-left text-sm text-amber-900">
              Treat this link like a password. Do not send it by ordinary email or chat.
            </div>
            <textarea readOnly value={modal.accountLinkUrl} aria-label="One-time CIG administrator account link" className="w-full min-h-24 rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-xs text-zinc-800 mb-4" />
            <div className="flex gap-3">
              <button onClick={() => navigator.clipboard.writeText(modal.accountLinkUrl).then(() => toast({ title: "Account link copied", description: "Share it only through an approved secure channel." })).catch(() => toast({ title: "Unable to copy", description: "Select and copy the link manually.", variant: "destructive" }))} className={btnSecondary + " flex-1 py-2.5"}>
                Copy link
              </button>
              <button onClick={() => setModal(null)} className={btnPrimary + " flex-1 py-2.5"}>
                Done
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (modal.type === "fresh-mfa") {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-900/60 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-white rounded-xl shadow-xl overflow-hidden border border-zinc-200">
            <div className="px-6 py-5 border-b border-zinc-100">
              <h3 className="text-lg font-semibold text-zinc-900">Confirm it’s you</h3>
              <p className="text-sm text-zinc-600 mt-1">This is a high-risk action. Enter a fresh authenticator code to continue.</p>
            </div>
            <form onSubmit={handleFreshMfa}>
              <div className="px-6 py-5">
                <label htmlFor="platform-fresh-mfa-code" className={labelClass}>Authenticator code</label>
                <input
                  id="platform-fresh-mfa-code"
                  required
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={freshMfaCode}
                  onChange={(event) => setFreshMfaCode(event.target.value.replace(/\s/g, ""))}
                  maxLength={8}
                  placeholder="123456"
                  className={inputClass}
                />
                <p className="mt-2 text-xs text-zinc-500">The confirmation is valid only for the next 10 minutes in this session.</p>
              </div>
              <div className="px-6 py-4 bg-zinc-50 border-t border-zinc-100 flex gap-3 justify-end">
                <button type="button" onClick={() => { setPendingFreshMfaAction(null); setModal(null); }} className={btnSecondary}>Cancel</button>
                <button type="submit" disabled={submitting || !freshMfaCode} className={btnPrimary}>{submitting ? "Confirming..." : "Confirm"}</button>
              </div>
            </form>
          </div>
        </div>
      );
    }

    if (modal.type === "school-master-manual-reset") {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-900/60 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-white rounded-xl shadow-xl overflow-hidden border border-zinc-200 p-6 text-center">
            <div className="mx-auto w-12 h-12 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center mb-4">
              <AlertTriangleIcon className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-semibold text-zinc-900">Email unavailable</h3>
            <p className="text-sm text-zinc-600 mt-1 mb-6">
              {modal.emailStatus === "not-configured"
                ? "Email delivery is not configured."
                : "The reset email could not be delivered."} Create a new one-time link to give directly to <strong>{modal.org.itAdmin?.name}</strong> instead?
            </p>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 mb-6 text-left text-sm text-amber-900">
              This replaces the undelivered link. Treat the new link like a password: share it only through an approved secure channel, not ordinary email or chat.
            </div>
            <div className="flex gap-3">
              <button onClick={() => setModal(null)} className={btnSecondary + " flex-1 py-2.5"}>Cancel</button>
              <button onClick={() => handleCreateSchoolMasterManualReset(modal.org)} disabled={submitting} className={btnPrimary + " flex-1 py-2.5 bg-zinc-900"}>
                {submitting ? "Creating…" : "Create manual link"}
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (modal.type === "school-master-manual-link") {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-900/60 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-white rounded-xl shadow-xl overflow-hidden border border-zinc-200 p-6 text-center">
            <div className="mx-auto w-12 h-12 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mb-4">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
            </div>
            <h3 className="text-lg font-semibold text-zinc-900">One-time reset link created</h3>
            <p className="text-sm text-zinc-600 mt-1 mb-4">
              Give this link directly to <strong>{modal.schoolMasterName}</strong>. It expires on {new Date(modal.expiresAt).toLocaleDateString("en-GB")} and works once.
            </p>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 mb-4 text-left text-sm text-amber-900">
              Treat this link like a password. Do not send it by ordinary email or chat.
            </div>
            <textarea readOnly value={modal.resetUrl} aria-label="One-time School Admin reset link" className="w-full min-h-24 rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-xs text-zinc-800 mb-4" />
            <div className="flex gap-3">
              <button onClick={() => navigator.clipboard.writeText(modal.resetUrl).then(() => toast({ title: "Reset link copied", description: "Share it only through an approved secure channel." })).catch(() => toast({ title: "Unable to copy", description: "Select and copy the link manually.", variant: "destructive" }))} className={btnSecondary + " flex-1 py-2.5"}>
                Copy link
              </button>
              <button onClick={() => setModal(null)} className={btnPrimary + " flex-1 py-2.5"}>
                Done
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (modal.type === "change-password") {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-900/60 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-white rounded-xl shadow-xl overflow-hidden border border-zinc-200">
            <div className="px-6 py-5 border-b border-zinc-100">
              <h3 className="text-lg font-semibold text-zinc-900">Change Password</h3>
              <p className="text-sm text-zinc-600 mt-1">Update your platform admin password.</p>
            </div>
            <form onSubmit={handleChangePassword}>
              <div className="px-6 py-5 space-y-4">
                <div>
                  <label htmlFor="platform-change-password-current" className={labelClass}>Current Password</label>
                  <input id="platform-change-password-current" type="password" required autoComplete="current-password" value={changePwForm.currentPassword} onChange={e => setChangePwForm({...changePwForm, currentPassword: e.target.value})} className={inputClass} />
                </div>
                <div>
                  <label htmlFor="platform-change-password-new" className={labelClass}>New Password</label>
                  <input id="platform-change-password-new" type="password" required minLength={12} autoComplete="new-password" value={changePwForm.newPassword} onChange={e => setChangePwForm({...changePwForm, newPassword: e.target.value})} className={inputClass} placeholder="Min 12 characters" />
                </div>
                <div>
                  <label htmlFor="platform-change-password-confirm" className={labelClass}>Confirm New Password</label>
                  <input id="platform-change-password-confirm" type="password" required minLength={12} autoComplete="new-password" value={changePwForm.confirmPassword} onChange={e => setChangePwForm({...changePwForm, confirmPassword: e.target.value})} className={inputClass} />
                </div>
              </div>
              <div className="px-6 py-4 bg-zinc-50 border-t border-zinc-100 flex gap-3 justify-end">
                <button type="button" onClick={() => setModal(null)} className={btnSecondary}>Cancel</button>
                <button type="submit" disabled={submitting} className={btnPrimary}>
                  {submitting ? "Saving..." : "Save Password"}
                </button>
              </div>
            </form>
          </div>
        </div>
      );
    }

    if (modal.type === "regenerate-recovery-prompt") {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-900/60 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-white rounded-xl shadow-xl overflow-hidden border border-zinc-200">
            <div className="px-6 py-6">
              <div className="flex items-center justify-center w-12 h-12 bg-zinc-100 rounded-full mx-auto mb-4">
                <ShieldIcon className="w-6 h-6 text-zinc-900" />
              </div>
              <h3 className="text-lg font-semibold text-center text-zinc-900">Regenerate Codes?</h3>
              <p className="text-sm text-center text-zinc-600 mt-2">
                This will immediately invalidate all your existing recovery codes. You will be given a new set of codes to save.
              </p>
            </div>
            <div className="px-6 py-4 bg-zinc-50 border-t border-zinc-100 flex gap-3">
              <button onClick={() => setModal(null)} className={btnSecondary + " flex-1"}>Cancel</button>
              <button onClick={handleRegenerateRecovery} disabled={submitting} className={btnPrimary + " flex-1"}>
                {submitting ? "Generating..." : "Regenerate"}
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (modal.type === "show-recovery-codes") {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-900/60 backdrop-blur-sm">
          <div className="w-full max-w-lg bg-white rounded-xl shadow-xl overflow-hidden border border-zinc-200 p-8">
            <RecoveryCodesContent codes={modal.codes} onDone={() => setModal(null)} buttonText="Done" />
          </div>
        </div>
      );
    }

    if (modal.type === "school-lifecycle") {
      const isRemoval = modal.action === "remove";
      const isRestore = modal.action === "restore";
      const isPermanent = modal.action === "permanent";
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-900/60 backdrop-blur-sm">
          <div className="w-full max-w-lg bg-white rounded-xl shadow-xl overflow-hidden border border-zinc-200">
            <div className="px-6 py-5 border-b border-zinc-100 flex items-start gap-4">
              <div className="bg-red-100 text-red-600 p-2 rounded-full shrink-0">
                <AlertTriangleIcon className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-zinc-900">{isRemoval ? "Remove school for recovery" : isRestore ? "Restore school" : "Permanently destroy school"}</h3>
                <p className="text-sm text-zinc-600 mt-1">
                  {isRemoval
                    ? <>Access to <strong>{modal.org.name}</strong> will stop immediately. All data stays recoverable for 30 days.</>
                    : isRestore
                      ? <><strong>{modal.org.name}</strong> will be made available again with its teachers, classes, and student work.</>
                      : <>This will permanently destroy <strong>{modal.org.name}</strong> and all dependent data. It cannot be undone.</>}
                </p>
              </div>
            </div>

            <div className="px-6 py-5 space-y-4">
              {deletionSummary ? (
                <div className="bg-zinc-50 rounded-lg p-4 border border-zinc-200">
                  <h4 className="text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-3">{isPermanent ? "Data to be destroyed" : isRestore ? "Data to be restored" : "Data retained for 30 days"}</h4>
                  <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-sm">
                    <div className="flex justify-between text-zinc-600"><span>Teachers:</span> <span className="font-medium text-zinc-900">{deletionSummary.teachers}</span></div>
                    <div className="flex justify-between text-zinc-600"><span>Classes:</span> <span className="font-medium text-zinc-900">{deletionSummary.classes}</span></div>
                    <div className="flex justify-between text-zinc-600"><span>Sessions:</span> <span className="font-medium text-zinc-900">{deletionSummary.studentSessions}</span></div>
                    <div className="flex justify-between text-zinc-600"><span>Stage Entries:</span> <span className="font-medium text-zinc-900">{deletionSummary.stageEntries}</span></div>
                    <div className="flex justify-between text-zinc-600"><span>Chat Msgs:</span> <span className="font-medium text-zinc-900">{deletionSummary.chatMessages}</span></div>
                    <div className="flex justify-between text-zinc-600"><span>Feedback:</span> <span className="font-medium text-zinc-900">{deletionSummary.feedback}</span></div>
                    <div className="flex justify-between text-zinc-600"><span>Tasks:</span> <span className="font-medium text-zinc-900">{deletionSummary.tasks}</span></div>
                    <div className="flex justify-between text-zinc-600"><span>Audit Logs:</span> <span className="font-medium text-zinc-900">{deletionSummary.auditLogs}</span></div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center p-8 text-zinc-500">
                  <div className="w-5 h-5 border-2 border-zinc-300 border-t-zinc-600 rounded-full animate-spin"></div>
                  <span className="ml-3 text-sm font-medium">Calculating data volume...</span>
                </div>
              )}

              <div className="pt-2">
                <label className="block text-sm font-medium text-zinc-900 mb-1.5">
                  Type <span className="font-mono bg-zinc-100 px-1 py-0.5 rounded text-red-600 select-all">{modal.org.name}</span> to confirm
                </label>
                <input
                  type="text"
                  value={deleteConfirmation}
                  onChange={e => setDeleteConfirmation(e.target.value)}
                  className="block w-full rounded-lg border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500 shadow-sm"
                  placeholder={modal.org.name}
                />
              </div>
            </div>

            <div className="px-6 py-4 bg-zinc-50 border-t border-zinc-100 flex gap-3 justify-end">
              <button type="button" onClick={() => { setModal(null); setDeleteConfirmation(""); setDeletionSummary(null); }} className={btnSecondary}>
                Cancel
              </button>
              <button type="button" onClick={handleSchoolLifecycle} disabled={submitting || deleteConfirmation !== modal.org.name} className={`px-4 py-2 text-sm font-medium text-white rounded-lg shadow-sm disabled:opacity-50 transition-colors ${isRestore ? "bg-emerald-600 hover:bg-emerald-700" : "bg-red-600 hover:bg-red-700"}`}>
                {submitting ? "Saving..." : isRemoval ? "Remove for 30 days" : isRestore ? "Restore school" : "Permanently destroy"}
              </button>
            </div>
          </div>
        </div>
      );
    }
    return null;
  };

  if (view === "loading") {
    return loadError
      ? <WorkspaceRequestState workspace="Platform administration" state={loadError} onRetry={init} />
      : <WorkspaceRequestState workspace="Platform administration" state="loading" />;
  }

  if (view === "bootstrap") {
    return (
      <div className="min-h-[100dvh] bg-zinc-50 flex items-center justify-center p-6 font-sans">
        <div className="w-full max-w-md bg-white border border-zinc-200 shadow-sm rounded-2xl overflow-hidden p-8">
          <div className="text-center mb-6">
            <div className="mx-auto w-12 h-12 bg-zinc-100 text-zinc-900 rounded-full flex items-center justify-center mb-3">
              <ShieldIcon className="w-6 h-6" />
            </div>
            <h1 className="text-xl font-semibold text-zinc-900">Initialize Platform</h1>
            <p className="text-sm text-zinc-600 mt-1">Create the primary platform admin account</p>
          </div>
          <form onSubmit={handleBootstrap} className="space-y-4">
              <div>
                <label htmlFor="platform-bootstrap-secret" className={labelClass}>Bootstrap Secret</label>
                <input id="platform-bootstrap-secret" type="password" required autoComplete="off" value={bootstrapForm.bootstrapSecret} onChange={e => setBootstrapForm({...bootstrapForm, bootstrapSecret: e.target.value})} className={inputClass} autoFocus />
              <p className="text-xs text-zinc-500 mt-1.5">Found in your server environment variables.</p>
            </div>
            <div className="border-t border-zinc-100 pt-5 mt-2">
              <div className="mb-4 grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="platform-bootstrap-first-name" className={labelClass}>First name</label>
                  <input id="platform-bootstrap-first-name" type="text" required autoComplete="given-name" value={bootstrapForm.firstName} onChange={e => setBootstrapForm({...bootstrapForm, firstName: e.target.value})} className={inputClass} placeholder="Jane" />
                </div>
                <div>
                  <label htmlFor="platform-bootstrap-surname" className={labelClass}>Surname</label>
                  <input id="platform-bootstrap-surname" type="text" required autoComplete="family-name" value={bootstrapForm.surname} onChange={e => setBootstrapForm({...bootstrapForm, surname: e.target.value})} className={inputClass} placeholder="Smith" />
                </div>
              </div>

              <label htmlFor="platform-bootstrap-email" className={labelClass}>Email Address</label>
              <input id="platform-bootstrap-email" type="email" required autoComplete="email" value={bootstrapForm.email} onChange={e => setBootstrapForm({...bootstrapForm, email: e.target.value})} className={inputClass + " mb-4"} placeholder="admin@domain.com" />

              <label htmlFor="platform-bootstrap-password" className={labelClass}>Master Password</label>
              <input id="platform-bootstrap-password" type="password" required autoComplete="new-password" minLength={12} value={bootstrapForm.password} onChange={e => setBootstrapForm({...bootstrapForm, password: e.target.value})} className={inputClass} placeholder="Min 12 characters" />
            </div>
            <button type="submit" disabled={submitting || !bootstrapForm.bootstrapSecret || !bootstrapForm.email || !bootstrapForm.password || !bootstrapForm.firstName || !bootstrapForm.surname} className={btnPrimary + " w-full py-3 mt-4"}>
              {submitting ? "Initializing..." : "Create Admin Account"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (view === "bootstrap-totp" && totpData) {
    return (
      <div className="min-h-[100dvh] bg-zinc-50 flex items-center justify-center p-6 font-sans">
        <div className="w-full max-w-md bg-white border border-zinc-200 shadow-sm rounded-2xl overflow-hidden p-8">
          <div className="text-center mb-6">
            <div className="mx-auto w-12 h-12 bg-zinc-100 text-zinc-900 rounded-full flex items-center justify-center mb-3">
              <ShieldIcon className="w-6 h-6" />
            </div>
            <h1 className="text-xl font-semibold text-zinc-900">Set up 2FA</h1>
            <p className="text-sm text-zinc-600 mt-1">Scan the QR code with your authenticator app</p>
          </div>
          <div className="bg-zinc-50 p-5 rounded-xl flex flex-col items-center justify-center border border-zinc-200 mb-6">
            <img src={totpData.qrCode} alt="TOTP QR Code" className="w-48 h-48 mb-4 bg-white p-2 rounded-lg shadow-sm" />
            <p className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Manual Entry Key</p>
            <code className="text-sm font-mono font-medium text-zinc-900 bg-white border border-zinc-200 px-3 py-1.5 rounded mt-2 inline-block select-all tracking-widest">{totpData.secret}</code>
          </div>
          <form onSubmit={handleSetupTotp} className="space-y-4">
            <div>
              <label htmlFor="platform-bootstrap-totp-code" className={labelClass}>6-digit code</label>
              <input id="platform-bootstrap-totp-code" type="text" required inputMode="numeric" autoComplete="one-time-code" value={totpCode} onChange={e => setTotpCode(e.target.value)} maxLength={6} placeholder="123456" className={inputClass} autoFocus />
            </div>
            <button type="submit" disabled={submitting || totpCode.length < 6} className={btnPrimary + " w-full py-3 mt-2"}>
              {submitting ? "Verifying..." : "Complete Setup"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (view === "recovery-codes") {
    return (
      <div className="min-h-[100dvh] bg-zinc-50 flex items-center justify-center p-6 font-sans">
        <div className="w-full max-w-lg bg-white border border-zinc-200 shadow-sm rounded-2xl p-8">
          <RecoveryCodesContent codes={recoveryCodes} onDone={init} buttonText="I have saved them" />
        </div>
      </div>
    );
  }

  if (view === "login") {
    return (
      <div className="min-h-[100dvh] bg-zinc-50 flex items-center justify-center p-6 font-sans">
        <div className="w-full max-w-sm bg-white border border-zinc-200 shadow-sm rounded-2xl overflow-hidden">
          <div className="bg-zinc-900 px-6 py-8 text-center">
             <ShieldIcon className="w-8 h-8 text-zinc-100 mx-auto mb-4" />
             <h1 className="text-xl font-semibold text-white">Platform Administration</h1>
             <p className="text-zinc-400 text-sm mt-2">Secure access required</p>
          </div>
          <div className="p-7">
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label htmlFor="platform-admin-email" className={labelClass}>Email Address</label>
                <input id="platform-admin-email" type="email" required autoComplete="email" value={loginForm.email} onChange={e => setLoginForm({...loginForm, email: e.target.value})} placeholder="admin@domain.com" className={inputClass} autoFocus />
              </div>
              <div>
                <label htmlFor="platform-admin-password" className={labelClass}>Password</label>
                <input id="platform-admin-password" type="password" required autoComplete="current-password" value={loginForm.password} onChange={e => setLoginForm({...loginForm, password: e.target.value})} placeholder="••••••••" className={inputClass} />
              </div>
              <button type="submit" disabled={submitting || !loginForm.email || !loginForm.password} className={btnPrimary + " w-full py-3 mt-2"}>
                {submitting ? "Signing in..." : "Sign In"}
              </button>
              <button type="button" onClick={() => setView("recover")} className="block w-full text-center text-sm font-medium text-zinc-500 hover:text-zinc-900 pt-3 transition-colors">
                Forgot your password?
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  if (view === "verify-totp") {
    return (
      <div className="min-h-[100dvh] bg-zinc-50 flex items-center justify-center p-6 font-sans">
        <div className="w-full max-w-sm bg-white border border-zinc-200 shadow-sm rounded-2xl overflow-hidden p-8">
          <div className="text-center mb-6">
            <div className="mx-auto w-12 h-12 bg-zinc-100 text-zinc-900 rounded-full flex items-center justify-center mb-3">
              <ShieldIcon className="w-6 h-6" />
            </div>
            <h1 className="text-xl font-semibold text-zinc-900">Two-Factor Auth</h1>
            <p className="text-sm text-zinc-600 mt-1">Enter the code from your authenticator app</p>
          </div>
          <form onSubmit={handleVerifyTotp} className="space-y-4">
            <div>
              <label htmlFor="platform-admin-totp-code" className={labelClass}>6-digit code</label>
              <input id="platform-admin-totp-code" type="text" required inputMode="numeric" autoComplete="one-time-code" value={totpCode} onChange={e => setTotpCode(e.target.value)} maxLength={6} placeholder="123456" className={inputClass} autoFocus />
            </div>
            <button type="submit" disabled={submitting || !totpCode} className={btnPrimary + " w-full py-3 mt-2"}>
              {submitting ? "Verifying..." : "Verify & Sign In"}
            </button>
             <button
               type="button"
               onClick={() => {
                 setRecoverForm((current) => ({
                   ...current,
                   email: loginForm.email,
                   newPassword: "",
                   code: "",
                   method: "recovery",
                   action: "device",
                 }));
                 setView("recover");
               }}
               className="block w-full text-center text-sm font-medium text-zinc-500 hover:text-zinc-900 pt-3 transition-colors"
             >
               Can’t access your authenticator?
             </button>
            <button type="button" onClick={() => setView("login")} className="block w-full text-center text-sm font-medium text-zinc-500 hover:text-zinc-900 pt-3 transition-colors">
              Cancel
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (view === "recover") {
    return (
      <div className="min-h-[100dvh] bg-zinc-50 flex items-center justify-center p-6 font-sans">
        <div className="w-full max-w-sm bg-white border border-zinc-200 shadow-sm rounded-2xl overflow-hidden p-8">
          <div className="text-center mb-6">
            <div className="mx-auto w-12 h-12 bg-zinc-100 text-zinc-900 rounded-full flex items-center justify-center mb-3">
              <ShieldIcon className="w-6 h-6" />
            </div>
             <h1 className="text-xl font-semibold text-zinc-900">
               {recoverForm.action === "device" ? "Recover Authenticator Access" : "Recover Access"}
             </h1>
            <p className="text-sm text-zinc-600 mt-1">
               {recoverForm.action === "device"
                 ? "Use a one-time recovery code to replace your lost authenticator"
                 : "Reset your platform admin password"}
            </p>
          </div>
          <form onSubmit={handleRecover} className="space-y-4">
            <div>
                <label htmlFor="platform-admin-recovery-email" className={labelClass}>Admin Email</label>
                <input id="platform-admin-recovery-email" type="email" required autoComplete="email" value={recoverForm.email} onChange={e => setRecoverForm({...recoverForm, email: e.target.value})} className={inputClass} autoFocus />
            </div>
            <div className="pt-3 mt-2 border-t border-zinc-100">
              <label className="block text-xs font-semibold text-zinc-900 mb-2 uppercase tracking-wider">Recovery Type</label>
              <div className="flex bg-zinc-100 p-1 rounded-lg">
                <button type="button" onClick={() => setRecoverForm({...recoverForm, action: "password", code: ""})} className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-colors ${recoverForm.action === "password" ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-900"}`}>
                  Reset Password
                </button>
                <button type="button" onClick={() => setRecoverForm({...recoverForm, action: "device", method: "recovery", code: ""})} className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-colors ${recoverForm.action === "device" ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-900"}`}>
                  Replace Device
                </button>
              </div>
            </div>
            {recoverForm.action === "password" && (
              <div>
                <label htmlFor="platform-admin-recovery-password" className={labelClass}>New Password</label>
                <input id="platform-admin-recovery-password" type="password" required minLength={12} autoComplete="new-password" value={recoverForm.newPassword} onChange={e => setRecoverForm({...recoverForm, newPassword: e.target.value})} className={inputClass} />
              </div>
            )}

            <div className="pt-3 mt-2 border-t border-zinc-100">
              {recoverForm.action === "password" && (
                <>
                  <label className="block text-xs font-semibold text-zinc-900 mb-2 uppercase tracking-wider">Verification Method</label>
                  <div className="flex bg-zinc-100 p-1 rounded-lg mb-4">
                    <button type="button" onClick={() => setRecoverForm({...recoverForm, method: "totp", code: ""})} className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-colors ${recoverForm.method === "totp" ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-900"}`}>
                      Authenticator App
                    </button>
                    <button type="button" onClick={() => setRecoverForm({...recoverForm, method: "recovery", code: ""})} className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-colors ${recoverForm.method === "recovery" ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-900"}`}>
                      Recovery Code
                    </button>
                  </div>
                </>
              )}

              <label htmlFor="platform-admin-recovery-code" className={labelClass}>
                {recoverForm.action === "device" ? "Single-use Recovery Code" : recoverForm.method === "totp" ? "6-digit Authenticator Code" : "Recovery Code"}
              </label>
              <input
                id="platform-admin-recovery-code"
                type="text"
                required
                inputMode={recoverForm.action === "password" && recoverForm.method === "totp" ? "numeric" : "text"}
                autoComplete={recoverForm.action === "password" && recoverForm.method === "totp" ? "one-time-code" : "off"}
                value={recoverForm.code}
                onChange={e => setRecoverForm({...recoverForm, code: e.target.value})}
                className={inputClass}
                placeholder={recoverForm.action === "device" || recoverForm.method === "recovery" ? "CIG-xxxx-xxxx-xxxx" : "123456"}
                maxLength={recoverForm.action === "device" || recoverForm.method === "recovery" ? undefined : 6}
              />
              {recoverForm.action === "device" && (
                <div className="mt-2 space-y-1.5 text-xs text-zinc-500">
                  <p>This invalidates your old authenticator and remaining recovery codes. You will enrol a new authenticator before signing in.</p>
                  <p>Do not have a recovery code? Contact the Master CIG administrator to reset your authenticator.</p>
                </div>
              )}
            </div>

            <button type="submit" disabled={submitting || !recoverForm.email || !recoverForm.code || (recoverForm.action === "password" && !recoverForm.newPassword)} className={btnPrimary + " w-full py-3 mt-4"}>
              {submitting ? "Checking..." : recoverForm.action === "device" ? "Start Device Recovery" : "Reset Password"}
            </button>
            <button type="button" onClick={() => setView("login")} className="block w-full text-center text-sm font-medium text-zinc-500 hover:text-zinc-900 pt-3 transition-colors">
              Back to Sign In
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (view === "claim-account-link") {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-zinc-50 px-4 py-10">
        <div className="w-full max-w-md bg-white rounded-xl shadow-sm border border-zinc-200 p-8">
          <div className="w-10 h-10 bg-zinc-900 rounded-lg flex items-center justify-center mb-5">
            <ShieldIcon className="w-5 h-5 text-white" />
          </div>
          <h1 className="text-xl font-semibold text-zinc-900">Set up your CIG account</h1>
          <p className="text-sm text-zinc-600 mt-2">Choose a password to continue. You will then confirm your authenticator app before accessing Central Admin.</p>
          <form onSubmit={handleClaimAccountLink} className="mt-6 space-y-4">
            <div>
              <label htmlFor="platform-admin-claim-password" className={labelClass}>New password</label>
              <input id="platform-admin-claim-password" required type="password" minLength={12} autoComplete="new-password" value={accountLinkForm.password} onChange={(event) => setAccountLinkForm({ ...accountLinkForm, password: event.target.value })} className={inputClass} />
            </div>
            <div>
              <label htmlFor="platform-admin-claim-confirm-password" className={labelClass}>Confirm new password</label>
              <input id="platform-admin-claim-confirm-password" required type="password" minLength={12} autoComplete="new-password" value={accountLinkForm.confirmPassword} onChange={(event) => setAccountLinkForm({ ...accountLinkForm, confirmPassword: event.target.value })} className={inputClass} />
            </div>
            <button type="submit" disabled={submitting || !accountLinkToken} className={btnPrimary + " w-full py-3"}>
              {submitting ? "Checking link..." : "Continue securely"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-zinc-50 text-zinc-900 font-sans">
      {renderModal()}
      <header className="bg-white border-b border-zinc-200 px-6 py-4 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-10">
        <div className="flex min-w-0 items-center gap-3">
          <div className="bg-zinc-900 p-2 rounded-lg">
            <ShieldIcon className="w-5 h-5 text-white" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-zinc-900">Platform Admin</h1>
            <p className="text-xs text-zinc-500 [overflow-wrap:anywhere]">
              {currentAdmin ? `${currentAdmin.name} · ${isMaster ? "Master CIG Admin" : "CIG Sub-admin"}` : "The Assisted Climb"}
            </p>
          </div>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-4">
          {isMaster && (
            <button onClick={() => {
              setNewCigAdminForm({ firstName: "", surname: "", email: "" });
              setModal({ type: "new-cig-admin" });
            }} className="text-sm font-medium text-zinc-600 hover:text-zinc-900 transition-colors">
              Add CIG Sub-admin
            </button>
          )}
          <button onClick={() => setModal({ type: "change-password" })} className="text-sm font-medium text-zinc-600 hover:text-zinc-900 transition-colors">
            Change Password
          </button>
          <button onClick={() => setModal({ type: "regenerate-recovery-prompt" })} className="text-sm font-medium text-zinc-600 hover:text-zinc-900 transition-colors">
            Recovery Codes
          </button>
          <div className="w-px h-4 bg-zinc-300"></div>
          <button onClick={handleLogout} className="text-sm font-medium text-zinc-600 hover:text-zinc-900 transition-colors">
            Sign Out
          </button>
        </div>
      </header>

      <main className="mx-auto w-full min-w-0 max-w-6xl overflow-x-hidden px-6 py-10">
        {isMaster && (
          <nav className="flex max-w-full items-center gap-1 overflow-x-auto border-b border-zinc-200 mb-8" aria-label="Platform Admin sections">
            <button
              type="button"
              onClick={() => setActiveTab("schools")}
              aria-selected={activeTab === "schools"}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${activeTab === "schools" ? "border-zinc-900 text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-900"}`}
            >
              Schools <span className="ml-1 text-xs text-zinc-400">{orgs.length}</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("administrators")}
              aria-selected={activeTab === "administrators"}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${activeTab === "administrators" ? "border-zinc-900 text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-900"}`}
            >
              CIG Administrators <span className="ml-1 text-xs text-zinc-400">{activeCigAdminCount}</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("retention")}
              aria-selected={activeTab === "retention"}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${activeTab === "retention" ? "border-zinc-900 text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-900"}`}
            >
              Retention
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("reports")}
              aria-selected={activeTab === "reports"}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${activeTab === "reports" ? "border-zinc-900 text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-900"}`}
            >
              Reports
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("activity")}
              aria-selected={activeTab === "activity"}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${activeTab === "activity" ? "border-zinc-900 text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-900"}`}
            >
              Activity Log {archiveWarningReview?.items.length ? <span className="ml-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">{archiveWarningReview.items.length}</span> : null}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("email")}
              aria-selected={activeTab === "email"}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${activeTab === "email" ? "border-zinc-900 text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-900"}`}
            >
              Email Service
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("security")}
              aria-selected={activeTab === "security"}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${activeTab === "security" ? "border-zinc-900 text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-900"}`}
            >
              Password Security
            </button>
          </nav>
        )}
        {isMaster && activeTab === "retention" && (
          <section className="max-w-3xl">
            <div className="mb-5">
              <h2 className="text-lg font-semibold text-zinc-900">Archive retention policy</h2>
              <p className="mt-1 text-sm text-zinc-500">Set the platform default, the choices offered to schools, and the allowed custom-period limits.</p>
            </div>
            <form onSubmit={(event) => {
              event.preventDefault();
              const save = async () => {
                setRetentionSaving(true);
                try {
                  const minimumDays = Number(retentionForm.minimumDays);
                  const maximumDays = Number(retentionForm.maximumDays);
                  const defaultDays = Number(retentionForm.defaultDays);
                  const standardChoices = retentionForm.choices.split(",").map((value) => Number(value.trim())).filter(Number.isFinite);
                  if (
                    !Number.isInteger(minimumDays)
                    || !Number.isInteger(maximumDays)
                    || !Number.isInteger(defaultDays)
                    || minimumDays < 1
                    || maximumDays < minimumDays
                    || defaultDays < minimumDays
                    || defaultDays > maximumDays
                    || standardChoices.length === 0
                    || standardChoices.some((days) => !Number.isInteger(days) || days < minimumDays || days > maximumDays)
                  ) {
                    throw new Error("Enter a default and standard choices between the allowed minimum and maximum.");
                  }
                  const updated = await apiFetch("/admin/retention-settings", {
                    method: "PUT",
                    body: JSON.stringify({
                      defaultArchiveRetentionDays: defaultDays,
                      minimumDays,
                      maximumDays,
                      standardChoices,
                    }),
                  });
                  setRetentionSettings(updated);
                  setRetentionForm({
                    defaultDays: String(updated.archiveRetentionDays),
                    minimumDays: String(updated.minimumDays),
                    maximumDays: String(updated.maximumDays),
                    choices: updated.standardChoices.join(", "),
                  });
                  toast({ title: "Platform retention settings saved", description: "The change and previous policy were recorded in the administrator audit log." });
                } finally {
                  setRetentionSaving(false);
                }
              };
              openFreshMfa(async () => {
                try {
                  await save();
                } catch (error: any) {
                  toast({ title: "Retention settings could not be saved", description: error.message, variant: "destructive" });
                }
              });
            }} className="space-y-5 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
              <div className="grid gap-4 sm:grid-cols-3">
                <label><span className={labelClass}>Default retention (days)</span><input type="number" required min={retentionForm.minimumDays} max={retentionForm.maximumDays} value={retentionForm.defaultDays} onChange={(e) => setRetentionForm({ ...retentionForm, defaultDays: e.target.value })} className={inputClass} /></label>
                <label><span className={labelClass}>Allowed minimum</span><input type="number" required min="1" max="36500" value={retentionForm.minimumDays} onChange={(e) => setRetentionForm({ ...retentionForm, minimumDays: e.target.value })} className={inputClass} /></label>
                <label><span className={labelClass}>Allowed maximum</span><input type="number" required min="1" max="36500" value={retentionForm.maximumDays} onChange={(e) => setRetentionForm({ ...retentionForm, maximumDays: e.target.value })} className={inputClass} /></label>
              </div>
              <label><span className={labelClass}>Standard school choices (comma-separated days)</span><input required value={retentionForm.choices} onChange={(e) => setRetentionForm({ ...retentionForm, choices: e.target.value })} className={inputClass} /><span className="mt-1 block text-xs text-zinc-500">For example: 30, 60, 90, 180, 365. Schools also receive a Custom period choice.</span></label>
              <div className="rounded-lg bg-zinc-50 p-4 text-sm text-zinc-600" data-testid="platform-retention-current-policy">
                Current policy: default {retentionSettings?.archiveRetentionDays ?? 30} days; standard choices {retentionSettings?.standardChoices.join(", ") ?? "30, 60, 90, 180, 365"}; custom values from {retentionSettings?.minimumDays ?? 1} to {retentionSettings?.maximumDays ?? 3650} days. Schools may choose any permitted period; the default applies only when a school has not selected another period.
              </div>
              <button disabled={retentionSaving} className={btnPrimary}>{retentionSaving ? "Saving…" : "Save retention policy"}</button>
            </form>
          </section>
        )}
        {isMaster && activeTab === "activity" && (
          <section className="max-w-6xl">
            <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-5 shadow-sm" data-testid="archive-warning-review">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-semibold text-amber-950">
                    <button
                      type="button"
                      onClick={() => setArchiveWarningReviewOpen((open) => !open)}
                      aria-expanded={archiveWarningReviewOpen}
                      aria-controls="archive-warning-review-content"
                      className="flex items-center gap-2 text-left hover:text-amber-800"
                    >
                      <span aria-hidden="true" className="w-4 text-center text-base">
                        {archiveWarningReviewOpen ? "−" : "+"}
                      </span>
                      <span>Archive warning delivery review</span>
                    </button>
                  </h2>
                  <p className="mt-1 max-w-3xl text-sm leading-6 text-amber-900/80">
                    These warning attempts have had no final sent, failed, or superseded outcome for at least {archiveWarningReview?.thresholdHours ?? 24} hours. SMTP acceptance is ambiguous, so no automatic retry was made.
                  </p>
                </div>
                <button type="button" onClick={loadArchiveWarningReview} disabled={archiveWarningReviewLoading} className={btnSecondary}>
                  {archiveWarningReviewLoading ? "Checking…" : "Refresh review"}
                </button>
              </div>
              {archiveWarningReviewOpen && (
                <div id="archive-warning-review-content">
                  {archiveWarningReviewError ? (
                    <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                      The archive warning review could not be loaded. Try refreshing.
                    </div>
                  ) : archiveWarningReviewLoading && !archiveWarningReview ? (
                    <div role="status" className="mt-4 rounded-lg bg-white/70 p-5 text-sm text-amber-900/70">Checking unresolved warning deliveries…</div>
                  ) : !archiveWarningReview?.items.length ? (
                    <div className="mt-4 rounded-lg bg-white/70 p-5 text-sm text-amber-900/70">No archive warning deliveries currently need review.</div>
                  ) : (
                    <>
                      <div className="mt-4 overflow-hidden rounded-lg border border-amber-200 bg-white">
                        <div className="overflow-x-auto">
                          <table className="w-full min-w-[760px] text-left text-sm">
                            <thead className="border-b border-amber-100 bg-amber-50/60 text-xs uppercase tracking-wider text-amber-900/70">
                              <tr><th className="px-4 py-3">School</th><th className="px-4 py-3">Claimed</th><th className="px-4 py-3">Archive expiry</th><th className="px-4 py-3">Provider lookup</th></tr>
                            </thead>
                            <tbody className="divide-y divide-amber-100">
                              {archiveWarningReview.items.map((item) => (
                                <tr key={item.id} className="align-top">
                                  <td className="px-4 py-4"><div className="font-medium text-zinc-900">{item.school.name || "School record"}</div>{item.school.slug && <div className="text-xs text-zinc-500">{item.school.slug}</div>}</td>
                                  <td className="whitespace-nowrap px-4 py-4 text-zinc-600"><time dateTime={item.attemptedAt}>{new Date(item.attemptedAt).toLocaleDateString("en-GB")}</time><div className="text-xs text-amber-800">{item.ageHours} hours unresolved</div></td>
                                  <td className="whitespace-nowrap px-4 py-4 text-zinc-600"><time dateTime={item.archiveExpiresAt}>{new Date(item.archiveExpiresAt).toLocaleDateString("en-GB")}</time></td>
                                  <td className="px-4 py-4"><span className="break-all font-mono text-xs text-zinc-700">{item.providerMessageId}</span></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                      {archiveWarningReview.truncated && <p className="mt-3 text-xs text-amber-900/70">The review is limited to the oldest 100 unresolved attempts. Refresh after investigating them to continue.</p>}
                    </>
                  )}
                  <div className="mt-4 rounded-lg border border-amber-200 bg-white/70 p-4 text-sm text-amber-950">
                    <p className="font-semibold">Before deciding whether a manual retry is safe</p>
                    <ol className="mt-2 list-decimal space-y-1 pl-5 text-amber-900/80">
                      {(archiveWarningReview?.guidance ?? [
                        "Check the SMTP provider delivery or event log for the deterministic Message-ID shown for each attempt.",
                        "Only manually retry after the provider confirms that it did not accept the message.",
                        "If the provider accepted the message, do not retry: the claim remains retained to prevent a duplicate compliance notice.",
                      ]).map((step) => <li key={step}>{step}</li>)}
                    </ol>
                  </div>
                  <p className="mt-3 text-xs text-amber-900/70">This review is redacted: it contains no student names, class names, learning content, recipient details, or raw provider response.</p>
                </div>
              )}
            </div>
            <div className="mb-5 flex items-end justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-zinc-900">Platform activity log</h2>
                <p className="mt-1 max-w-3xl text-sm text-zinc-500">Read-only security and platform administration history. Credentials, student data, chat content, raw metadata, and IP addresses are intentionally not shown.</p>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => loadActivityLog()} disabled={activityLogLoading || activityReportLoading} className={btnSecondary}>{activityLogLoading ? "Refreshing…" : "Refresh"}</button>
                <button type="button" onClick={runActivityReport} disabled={activityLogLoading || activityReportLoading} className={btnPrimary}>{activityReportLoading ? "Running report…" : "Run report"}</button>
              </div>
            </div>
            <p className="mb-4 text-xs text-zinc-500">Reports use the filters below and include up to 500 matching entries.</p>
            <form onSubmit={(event) => { event.preventDefault(); const next = { ...activityLogFilters, page: 1 }; setActivityLogFilters(next); loadActivityLog(next); }} className="mb-4 grid gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-4 md:grid-cols-5">
              <label><span className={labelClass}>Category</span><select value={activityLogFilters.category} onChange={(event) => setActivityLogFilters({ ...activityLogFilters, category: event.target.value })} className={inputClass}><option value="">All activity</option><option value="administrator-security">Administrator security</option><option value="school-administration">School administration</option></select></label>
              <label><span className={labelClass}>Action</span><select value={activityLogFilters.action} onChange={(event) => setActivityLogFilters({ ...activityLogFilters, action: event.target.value })} className={inputClass}><option value="">All actions</option><optgroup label="Administrator security"><option value="cig_admin.login">Signed in</option><option value="cig_admin.login_failed">Sign-in failed</option><option value="cig_admin.password_changed">Password changed</option><option value="cig_admin.created">Sub-admin created</option><option value="cig_admin.subadmin_removed">Sub-admin removed</option><option value="cig_admin.mfa_enabled">MFA enabled</option><option value="cig_admin.recovery_failed">Recovery failed</option></optgroup><optgroup label="School administration"><option value="organisation.soft_deleted">School removal started</option><option value="organisation.restored">School restored</option><option value="teacher.password_reset_requested">School Admin reset requested</option><option value="teacher.password_reset_delivery_failed">School Admin reset delivery failed</option></optgroup></select></label>
              <label><span className={labelClass}>From</span><input type="date" value={activityLogFilters.from} onChange={(event) => setActivityLogFilters({ ...activityLogFilters, from: event.target.value })} className={inputClass} /></label>
              <label><span className={labelClass}>To</span><input type="date" value={activityLogFilters.to} onChange={(event) => setActivityLogFilters({ ...activityLogFilters, to: event.target.value })} className={inputClass} /></label>
              <div className="flex items-end gap-2"><button className={btnPrimary}>Filter</button><button type="button" className={btnSecondary} onClick={() => { const next = { category: "", action: "", from: "", to: "", page: 1 }; setActivityLogFilters(next); loadActivityLog(next); }}>Reset</button></div>
            </form>
            {activityLogInvalidFilter ? <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">Those filters are not valid. Choose a listed action and make sure the start date is before the end date.</div>
              : activityReportEmpty ? <div role="status" className="mb-4 rounded-xl border border-zinc-200 bg-zinc-50 p-5 text-sm text-zinc-600">No matching activity was found, so there is no report to download.</div>
                : activityReportError ? <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800">The activity report could not be prepared. Try running it again.</div>
              : activityLogError ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800">The activity log could not be loaded. Try refreshing.</div>
                : activityLogLoading && !activityLog ? <div role="status" className="rounded-xl border border-zinc-200 bg-white p-8 text-sm text-zinc-500">Loading activity log…</div>
                  : !activityLog?.items.length ? <div className="rounded-xl border border-zinc-200 bg-white p-8 text-sm text-zinc-500">No activity matches these filters.</div>
                    : <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
                      <div className="overflow-x-auto"><table className="w-full min-w-[980px] text-left text-sm"><thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wider text-zinc-500"><tr><th className="px-5 py-3">Event</th><th className="px-5 py-3">When</th><th className="px-5 py-3">Actor</th><th className="px-5 py-3">School / account</th><th className="px-5 py-3">Outcome / context</th></tr></thead><tbody className="divide-y divide-zinc-100">{activityLog.items.map((item) => <tr key={item.id} className="align-top"><td className="px-5 py-4"><div className="font-medium text-zinc-900">{item.label}</div><div className="mt-1 text-xs text-zinc-400">{item.category === "administrator-security" ? "Administrator security" : "School administration"}</div></td><td className="whitespace-nowrap px-5 py-4 text-zinc-600"><time dateTime={item.occurredAt}>{new Date(item.occurredAt).toLocaleDateString("en-GB")}</time></td><td className="px-5 py-4">{item.actor ? <><div className="font-medium text-zinc-800">{item.actor.name}</div><div className="text-xs text-zinc-500">{item.actor.email} · {item.actor.role}</div></> : <span className="text-zinc-500">Administrator record unavailable</span>}</td><td className="px-5 py-4">{item.school ? <><div className="font-medium text-zinc-800">{item.school.name}</div>{item.school.slug && <div className="text-xs text-zinc-500">{item.school.slug}</div>}</> : item.account ? <span className="text-zinc-700">{item.account.label}</span> : <span className="text-zinc-400">—</span>}</td><td className="max-w-sm px-5 py-4"><span className={`inline-flex rounded-md px-2 py-1 text-xs font-semibold ${item.outcome === "Succeeded" ? "bg-emerald-100 text-emerald-800" : item.outcome === "Blocked" ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800"}`}>{item.outcome}</span><div className="mt-2 text-xs leading-5 text-zinc-600">{item.context}</div></td></tr>)}</tbody></table></div>
                      <div className="flex items-center justify-between border-t border-zinc-100 px-5 py-4 text-sm text-zinc-600"><span>Page {activityLog.page} of {activityLog.totalPages} · {activityLog.total} matching</span><div className="flex gap-2"><button type="button" className={btnSecondary} disabled={activityLog.page <= 1 || activityLogLoading} onClick={() => { const next = { ...activityLogFilters, page: activityLog.page - 1 }; setActivityLogFilters(next); loadActivityLog(next); }}>Previous</button><button type="button" className={btnSecondary} disabled={activityLog.page >= activityLog.totalPages || activityLogLoading} onClick={() => { const next = { ...activityLogFilters, page: activityLog.page + 1 }; setActivityLogFilters(next); loadActivityLog(next); }}>Next</button></div></div>
                    </div>}
          </section>
        )}
        {isMaster && activeTab === "reports" && (
          <section className="max-w-5xl">
            <div className="mb-5">
              <h2 className="text-lg font-semibold text-zinc-900">Platform reports</h2>
              <p className="mt-1 text-sm text-zinc-500">Aggregate school totals only. Student names, PINs, activity, and chat content are never included.</p>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <label className="flex-1"><span className={labelClass}>Report scope</span><select value={String(reportScope)} onChange={(e) => setReportScope(e.target.value === "all" ? "all" : Number(e.target.value))} className={inputClass} disabled={!reportOrgs}><option value="all">Cumulative platform report</option>{reportCurrentOrgs.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}</select></label>
                <button type="button" onClick={runReport} disabled={reportLoading} className={btnSecondary}>{reportLoading ? "Preparing…" : "Run report"}</button>
                <button type="button" onClick={downloadReportCsv} disabled={!selectedReportOrgs.length} className={btnPrimary}>Download CSV</button>
              </div>
              {!reportOrgs ? <div className="mt-6 rounded-lg bg-zinc-50 p-6 text-sm text-zinc-500">Run a report to retrieve the complete current school directory. This is independent of the Schools search and filters.</div> : !selectedReportOrgs.length ? <div className="mt-6 rounded-lg bg-zinc-50 p-6 text-sm text-zinc-500">No current schools are available for this report.</div> : <>
                <div className="mt-6 grid gap-3 sm:grid-cols-5">{[["Schools", reportTotals.schools], ["Teachers", reportTotals.teachers], ["Students", reportTotals.students], ["Climbs finished", reportTotals.finished], ["Climbs in progress", reportTotals.inProgress]].map(([label, value]) => <div key={String(label)} className="rounded-lg border border-zinc-200 p-4"><div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div><div className="mt-1 text-2xl font-semibold text-zinc-900">{value}</div></div>)}</div>
                <div className="mt-6 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500"><tr><th className="py-3">School / enrolled</th><th>Status</th><th>Teachers</th><th>Students</th><th>Climbs finished</th><th>Climbs in progress</th></tr></thead><tbody className="divide-y divide-zinc-100">{selectedReportOrgs.map((org) => <tr key={org.id}><td className="py-3"><div className="font-medium">{org.name}</div><div className="text-xs text-zinc-500">{new Date(org.createdAt).toLocaleDateString("en-GB")}</div></td><td className="capitalize">{org.status}</td><td>{org.teacherCount}</td><td>{org.studentCount}</td><td>{org.climbsFinished ?? 0}</td><td>{org.climbsInProgress ?? 0}</td></tr>)}</tbody></table></div>
              </>}
            </div>
          </section>
        )}
        {isMaster && activeTab === "email" && (
          <section className="max-w-3xl">
            <div className="flex items-end justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-zinc-900">Platform email service</h2>
                <p className="text-sm text-zinc-500 mt-1">One email service sends platform notifications, account details, and security alerts for every school.</p>
              </div>
              <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${
                emailStatus?.configured ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
              }`}>
                {emailStatus ? (emailStatus.configured ? "Configured" : "Not configured") : "Checking…"}
              </span>
            </div>

            <div className="bg-white border border-zinc-200 rounded-xl shadow-sm p-6 space-y-6">
              {emailStatus?.configured ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500">SMTP host</div>
                    <div className="mt-1 text-sm font-medium text-zinc-900">{emailStatus.host ?? "Hidden"}</div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Connection</div>
                    <div className="mt-1 text-sm font-medium text-zinc-900">
                      Port {emailStatus.port ?? "—"} · {emailStatus.secure ? "TLS" : "STARTTLS"}
                    </div>
                  </div>
                  <div className="sm:col-span-2">
                    <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Sender</div>
                    <div className="mt-1 text-sm font-medium text-zinc-900">{emailStatus.from ?? "Not set"}</div>
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                  <h3 className="text-sm font-semibold text-amber-900">Add the deployment email settings</h3>
                  <p className="mt-1 text-sm text-amber-800">
                    Configure these values once in AWS Secrets Manager or the standalone deployment environment. They are intentionally not entered or stored in this application.
                  </p>
                </div>
              )}

              <div className="border-t border-zinc-100 pt-5">
                <h3 className="text-sm font-semibold text-zinc-900">AWS deployment checklist</h3>
                <p className="mt-1 text-sm text-zinc-500">Set the public application address and email variables in the API deployment, then restart the API service.</p>
                <div className="mt-3 rounded-lg bg-zinc-950 p-4 font-mono text-xs leading-6 text-zinc-200 overflow-x-auto">
                  <div>APP_URL=https://app.your-domain.org</div>
                  <div>APP_ALLOWED_ORIGINS=https://app.your-domain.org</div>
                  <div>SMTP_HOST=your.smtp.provider</div>
                  <div>SMTP_PORT=587</div>
                  <div>SMTP_SECURE=false</div>
                  <div>SMTP_FROM=The Assisted Climb &lt;no-reply@example.org&gt;</div>
                  <div className="text-amber-300">SMTP_USER=stored-in-your-secret-store</div>
                  <div className="text-amber-300">SMTP_PASS=stored-in-your-secret-store</div>
                </div>
                <p className="mt-3 text-xs text-zinc-500">
                  Keep SMTP_USER and SMTP_PASS in AWS Secrets Manager. Never paste credentials into this page, ordinary database records, or chat.
                </p>
              </div>

              <div className="flex flex-col gap-3 border-t border-zinc-100 pt-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-sm font-medium text-zinc-900">Delivery test</div>
                  <div className="text-xs text-zinc-500 mt-1">
                    Sends a test message to {emailStatus?.testRecipient ?? "the signed-in Master account"}.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleTestPlatformEmail}
                  disabled={!emailStatus?.configured || testingPlatformEmail}
                  className={btnPrimary}
                >
                  {testingPlatformEmail ? "Sending…" : "Send test email"}
                </button>
              </div>
            </div>
          </section>
        )}
        {isMaster && activeTab === "security" && (
          <section className="max-w-3xl">
            <div className="flex items-end justify-between mb-4 gap-4">
              <div>
                <h2 className="text-lg font-semibold text-zinc-900">Password security service</h2>
                <p className="text-sm text-zinc-500 mt-1">
                  Recent times a password was accepted while the Have I Been Pwned breach check was unavailable.
                </p>
              </div>
              <button type="button" onClick={loadHibpOutageEvents} disabled={hibpOutageEventsLoading} className={btnSecondary}>
                {hibpOutageEventsLoading ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            <div className="bg-white border border-zinc-200 rounded-xl shadow-sm p-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900">Acknowledged service outages</h3>
                  <p className="text-xs text-zinc-500 mt-1">Only timestamps are shown. Passwords, hashes, breach-check prefixes, and user details are not recorded.</p>
                </div>
                <span className="inline-flex shrink-0 items-center rounded-full bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-700">
                  {hibpOutageEventsError
                    ? "Unavailable"
                    : hibpOutageEventsLoading && hibpOutageEvents === null
                      ? "Loading…"
                      : `${hibpOutageEvents?.length ?? 0} recent`}
                </span>
              </div>
              {hibpOutageEventsError ? (
                <div className="mt-5 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                  The outage history could not be loaded. Your administrator session may have expired; sign in again and refresh.
                </div>
              ) : hibpOutageEventsLoading && hibpOutageEvents === null ? (
                <div className="mt-5 rounded-lg bg-zinc-50 p-5 text-sm text-zinc-500">Loading outage history…</div>
              ) : !hibpOutageEvents || hibpOutageEvents.length === 0 ? (
                <div className="mt-5 rounded-lg bg-zinc-50 p-5 text-sm text-zinc-500">No acknowledged password security service outages.</div>
              ) : (
                <ul className="mt-5 divide-y divide-zinc-100 border-t border-zinc-100">
                  {hibpOutageEvents.map((event, index) => (
                    <li key={`${event.occurredAt}-${index}`} className="flex items-center justify-between gap-4 py-3 text-sm">
                      <span className="font-medium text-zinc-800">Password breach check unavailable</span>
                      <time dateTime={event.occurredAt} className="shrink-0 text-zinc-500">
                        {new Date(event.occurredAt).toLocaleDateString("en-GB")}
                      </time>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        )}
        {isMaster && activeTab === "administrators" && (
          <section className="mb-10">
            <div className="flex items-end justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-zinc-900">CIG Administrator Access</h2>
                <p className="text-sm text-zinc-500 mt-1">The Master account is protected. Sub-admins can manage schools but cannot alter administrator access.</p>
              </div>
              <span className="inline-flex items-center rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">Master-only controls</span>
            </div>
            <form onSubmit={runAdminSearch} className="mb-4 grid gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-4 md:grid-cols-5">
              <input value={adminFilters.q} onChange={(e) => setAdminFilters({ ...adminFilters, q: e.target.value })} className={inputClass} placeholder="Search name or email" aria-label="Search administrators" />
              <select value={adminFilters.status} onChange={(e) => setAdminFilters({ ...adminFilters, status: e.target.value })} className={inputClass}><option value="active">Active</option><option value="suspended">Suspended</option><option value="deleted">Deleted</option></select>
              <input type="date" value={adminFilters.from} onChange={(e) => setAdminFilters({ ...adminFilters, from: e.target.value })} className={inputClass} aria-label="Created or deleted from" />
              <input type="date" value={adminFilters.to} onChange={(e) => setAdminFilters({ ...adminFilters, to: e.target.value })} className={inputClass} aria-label="Created or deleted to" />
              <div className="flex gap-2"><button className={btnPrimary}>Search</button><button type="button" className={btnSecondary} onClick={() => { const next = { q: "", status: "active", from: "", to: "", page: 1 }; setAdminFilters(next); loadCigAdmins(next); }}>Reset</button></div>
            </form>
            <div className="bg-white border border-zinc-200 rounded-xl shadow-sm overflow-hidden">
              <div role="list" aria-label="CIG administrator accounts" className="divide-y divide-zinc-200">
                {currentCigAdmins.map(admin => (
                  <article
                    key={admin.deleted ? `deleted-${admin.id}-${admin.deletedAt}` : `admin-${admin.id}`}
                    role="listitem"
                    className={`p-5 transition-colors hover:bg-zinc-50 ${admin.deleted ? "bg-zinc-50/70" : ""}`}
                  >
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                      <div className="min-w-0">
                        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Administrator</div>
                        <div className={`truncate text-sm font-medium ${admin.deleted ? "text-zinc-600" : "text-zinc-900"}`}>{admin.name}</div>
                      </div>
                      <div className="min-w-0">
                        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Email</div>
                        <div className="truncate text-sm text-zinc-600">{admin.email}</div>
                      </div>
                      <div>
                        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Role</div>
                        <span className={`inline-flex items-center rounded-md px-2.5 py-1 text-xs font-semibold ${admin.role === "master" ? "bg-amber-100 text-amber-800" : admin.deleted ? "bg-red-100 text-red-800" : "bg-zinc-100 text-zinc-700"}`}>
                          {admin.role === "master" ? "Master (protected)" : admin.deleted ? "Sub-admin · deleted" : "Sub-admin"}
                        </span>
                      </div>
                      <div>
                        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Created</div>
                        <div className="text-sm text-zinc-600">{new Date(admin.createdAt).toLocaleDateString("en-GB")}</div>
                      </div>
                      <div>
                        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Access</div>
                        <span className={`inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium ${
                          admin.deleted
                            ? "bg-red-100 text-red-800"
                            : admin.active
                              ? "bg-emerald-100 text-emerald-800"
                              : "bg-zinc-100 text-zinc-700"
                        }`}>
                          {admin.deleted ? "Permanently deleted" : admin.active ? (admin.totpEnabled ? "Active · MFA enrolled" : "Active · MFA setup needed") : "Suspended"}
                        </span>
                      </div>
                      <div>
                        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Deleted</div>
                        <div className="text-sm text-zinc-600">{admin.deletedAt ? new Date(admin.deletedAt).toLocaleDateString("en-GB") : "—"}</div>
                      </div>
                    </div>

                    <div className="mt-5 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3">
                      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Account controls</div>
                      {admin.deleted ? (
                        <span className="text-xs font-medium text-zinc-400">Deletion record</span>
                      ) : admin.role === "master" ? (
                        <span className="text-xs font-medium text-zinc-400">Protected account</span>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2">
                          {admin.active && (
                            <button onClick={() => handleTransferMaster(admin)} className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700 hover:border-amber-300 hover:bg-amber-100">
                              Make Master
                            </button>
                          )}
                          <button onClick={() => handleResetCigPassword(admin)} className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 hover:border-zinc-300 hover:bg-zinc-100">
                            Reset password
                          </button>
                          <button onClick={() => handleResetCigMfa(admin)} className="rounded-md border border-amber-200 bg-white px-3 py-2 text-xs font-semibold text-amber-700 hover:bg-amber-50">
                            Reset authenticator
                          </button>
                          <button onClick={() => handleToggleCigAdmin(admin)} className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 hover:border-zinc-300 hover:bg-zinc-100">
                            {admin.active ? "Suspend" : "Reactivate"}
                          </button>
                          <button
                            onClick={() => handleRemoveCigAdmin(admin)}
                            title="Permanently delete this sub-admin account"
                            aria-label={`Permanently delete ${admin.name}`}
                            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:border-red-300 hover:bg-red-100"
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  </article>
                ))}
              </div>
              {currentCigAdmins.length === 0 && (
                <div className="p-8 text-center text-sm text-zinc-500">No CIG administrator accounts found.</div>
              )}
            </div>
            <div className="mt-4 flex items-center justify-between text-sm text-zinc-600">
              <span>Page {adminFilters.page} of {cigAdminTotalPages} · {cigAdminTotal} matching</span>
              <div className="flex gap-2"><button type="button" className={btnSecondary} disabled={adminFilters.page <= 1} onClick={() => { const next = { ...adminFilters, page: adminFilters.page - 1 }; setAdminFilters(next); loadCigAdmins(next); }}>Previous</button><button type="button" className={btnSecondary} disabled={adminFilters.page >= cigAdminTotalPages} onClick={() => { const next = { ...adminFilters, page: adminFilters.page + 1 }; setAdminFilters(next); loadCigAdmins(next); }}>Next</button></div>
            </div>
            {deletedCigAdmins.length > 0 && (
              <div className="mt-5 rounded-xl border border-red-200 bg-red-50/50 overflow-hidden">
                <div className="p-5 pb-3">
                  <h3 className="font-semibold text-red-900">Deleted administrators</h3>
                  <p className="mt-1 text-sm text-red-800">Historical, display-only records. They cannot be edited or restored.</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-left">
                    <thead className="border-y border-red-200 bg-red-100/50">
                      <tr>
                        <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-red-900">Administrator</th>
                        <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-red-900">Email</th>
                        <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-red-900">Role</th>
                        <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-red-900">Deleted</th>
                        <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-red-900">Record type</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-red-100">
                      {deletedCigAdmins.map((admin) => (
                        <tr key={`${admin.id}-${admin.deletedAt}`} className="text-sm">
                          <td className="px-5 py-3 font-medium text-zinc-700">{admin.name}</td>
                          <td className="px-5 py-3 text-zinc-600">{admin.email}</td>
                          <td className="px-5 py-3 text-zinc-600">Sub-admin</td>
                          <td className="px-5 py-3 text-zinc-600">{admin.deletedAt && new Date(admin.deletedAt).toLocaleDateString("en-GB")}</td>
                          <td className="px-5 py-3 text-xs text-zinc-500">Display-only history</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        )}
        {activeTab === "schools" && (
          <>
         <div className="flex items-center justify-between mb-8">
           <div>
             <div className="flex flex-wrap items-center gap-2">
               <h2 className="text-lg font-semibold text-zinc-900">Organizations</h2>
               {!isMaster && <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-semibold text-zinc-700">Read-only access</span>}
             </div>
             <p className="mt-1 text-sm text-zinc-500">{orgTotal} matching school{orgTotal === 1 ? "" : "s"}</p>
             {!isMaster && (
               <p className="mt-2 max-w-2xl text-sm text-zinc-600">
                 You can search and review school information. School access, administrator-account and deletion actions are restricted to the CIG Master Administrator.
               </p>
             )}
           </div>
           {isMaster && (
             <button onClick={() => setModal({ type: "create-school" })} className={btnPrimary}>
               Register School
             </button>
           )}
        </div>

         <form onSubmit={runSchoolSearch} className="mb-4 grid gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-4 md:grid-cols-5">
           <label><span className={labelClass}>{isMaster ? "Search by school name, slug or School Admin" : "Search by school name or slug"}</span><input value={schoolFilters.q} onChange={(e) => setSchoolFilters({ ...schoolFilters, q: e.target.value })} className={inputClass} placeholder={isMaster ? "School name, slug or School Admin" : "School name or slug"} aria-label={isMaster ? "Search by school name, slug or School Admin" : "Search by school name or slug"} /></label>
           <label><span className={labelClass}>Status</span><select value={schoolFilters.status} onChange={(e) => setSchoolFilters({ ...schoolFilters, status: e.target.value })} className={inputClass}><option value="active">Active</option><option value="suspended">Suspended</option><option value="deleted">Deleted</option></select></label>
           <label><span className={labelClass}>Enrolled or deleted from</span><input type="date" value={schoolFilters.from} onChange={(e) => setSchoolFilters({ ...schoolFilters, from: e.target.value })} className={inputClass} aria-label="Enrolled or deleted from" /></label>
           <label><span className={labelClass}>Enrolled or deleted to</span><input type="date" value={schoolFilters.to} onChange={(e) => setSchoolFilters({ ...schoolFilters, to: e.target.value })} className={inputClass} aria-label="Enrolled or deleted to" /></label>
          <div className="flex gap-2"><button className={btnPrimary}>Search</button><button type="button" className={btnSecondary} onClick={() => { const next = { q: "", status: "active", from: "", to: "", page: 1 }; setSchoolFilters(next); loadSchools(next); }}>Reset</button></div>
         </form>
          {schoolFilters.status !== "deleted" && (
           <>
           <div className="bg-white border border-zinc-200 rounded-xl shadow-sm overflow-hidden">
           <div className="border-b border-zinc-200 px-5 py-4">
             <h3 className="text-sm font-semibold text-zinc-900">School directory</h3>
             <p className="mt-1 text-xs text-zinc-500">Manage school access, School Admins, and account actions.</p>
           </div>
           {showingSuspendedSchools ? (
           <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-left border-collapse">
             <thead>
               <tr className="bg-zinc-50 border-b border-zinc-200">
                 <th className="px-5 py-4 text-xs font-semibold text-zinc-500 uppercase tracking-wider">School</th>
                 <th className="px-5 py-4 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Status</th>
                   {isMaster && <th className="px-5 py-4 text-center text-xs font-semibold text-zinc-500 uppercase tracking-wider">School access</th>}
                   {isMaster && <th className="px-5 py-4 text-center text-xs font-semibold text-zinc-500 uppercase tracking-wider">School deletion</th>}
               </tr>
             </thead>
             <tbody className="divide-y divide-zinc-200">
               {currentOrgs.map(org => (
                 <tr key={`suspended-org-${org.id}`} className="hover:bg-zinc-50 transition-colors">
                   <td className="px-5 py-4">
                     <div className="font-medium text-sm text-zinc-900">{org.name}</div>
                   </td>
                   <td className="px-5 py-4">
                     <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium bg-zinc-100 text-zinc-800">
                       Suspended
                     </span>
                   </td>
                    {isMaster && <td className="px-5 py-4 text-center">
                      {isMaster ? (
                        <button type="button" onClick={() => handleToggleActive(org)} aria-label={`Reactivate ${org.name}`} className="text-xs font-medium text-zinc-600 hover:text-zinc-900">
                          Reactivate
                        </button>
                      ) : (
                        <span className="text-xs text-zinc-400" title="Only a Master CIG administrator can reactivate a school">Not available</span>
                      )}
                    </td>}
                    {isMaster && <td className="px-5 py-4 text-center">
                     {isMaster ? (
                       <button
                         type="button"
                         onClick={() => openSchoolLifecycleModal(org, "remove")}
                          aria-label={`Remove ${org.name} for 30 days`}
                         className="text-xs font-medium text-red-600 hover:text-red-700"
                       >
                          Remove for 30 days
                       </button>
                     ) : (
                        <span className="text-xs text-zinc-400" title="Only a Master CIG administrator can remove a school for recovery">Not available</span>
                     )}
                    </td>}
                 </tr>
               ))}
             </tbody>
            </table>
           </div>
           ) : (
           <div className="max-w-full overflow-x-auto overscroll-x-contain pb-2">
            <table className="w-full min-w-[1240px] text-left border-collapse">
            <thead>
              <tr className="bg-zinc-50 border-b border-zinc-200">
                <th className="px-5 py-4 text-xs font-semibold text-zinc-500 uppercase tracking-wider">School</th>
                <th className="px-5 py-4 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Slug</th>
                <th className="px-5 py-4 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Enrolled</th>
                <th className="px-5 py-4 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Status</th>
                <th className="px-5 py-4 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Teachers</th>
                <th className="px-5 py-4 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Students</th>
                <th className="px-5 py-4 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Climbs started</th>
                 <th className="min-w-[240px] px-5 py-4 text-xs font-semibold text-zinc-500 uppercase tracking-wider">School Admin</th>
                 {isMaster && <th className="min-w-[150px] px-5 py-4 text-center text-xs font-semibold text-zinc-500 uppercase tracking-wider">School access</th>}
                 {isMaster && <th className="min-w-[180px] px-5 py-4 text-center text-xs font-semibold text-zinc-500 uppercase tracking-wider">School Admin account</th>}
                 {isMaster && <th className="min-w-[180px] px-5 py-4 text-center text-xs font-semibold text-zinc-500 uppercase tracking-wider">School deletion</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200">
              {currentOrgs.map(org => (
                <tr key={org.deleted ? `deleted-${org.id}-${org.deletedAt}` : `org-${org.id}`} className={`hover:bg-zinc-50 transition-colors ${org.deleted ? "bg-zinc-50/70" : ""}`}>
                   <td className="px-5 py-4">
                    <div className={`font-medium text-sm ${org.deleted ? "text-zinc-600" : "text-zinc-900"}`}>{org.name}</div>
                  </td>
                   <td className="px-5 py-4">
                    <span className="font-mono text-xs text-zinc-600">{org.slug}</span>
                  </td>
                  <td className="px-5 py-4 text-sm text-zinc-700">
                    {new Date(org.createdAt).toLocaleDateString("en-GB")}
                  </td>
                  <td className="px-5 py-4">
                    <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium ${
                      org.deleted
                        ? "bg-red-100 text-red-800"
                        : org.active
                          ? "bg-emerald-100 text-emerald-800"
                          : "bg-zinc-100 text-zinc-800"
                    }`}>
                      {org.deleted ? "Permanently deleted" : org.active ? "Active" : "Suspended"}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-sm text-zinc-700">{org.deleted || !org.active ? "—" : org.teacherCount}</td>
                  <td className="px-5 py-4 text-sm text-zinc-700">{org.deleted || !org.active ? "—" : org.studentCount}</td>
                  <td className="px-5 py-4">
                    <div className={`text-sm font-medium ${org.deleted || !org.active ? "text-zinc-400" : "text-zinc-900"}`}>{org.deleted || !org.active ? "—" : org.climbsStarted}</div>
                  </td>
                  <td className="min-w-[240px] px-5 py-4">
                    {org.deleted ? (
                      <span className="text-xs text-zinc-400">Recovery window active</span>
                    ) : !org.active ? (
                       <span className="text-xs text-zinc-400" title="School Admin details are hidden while the school is suspended">Not available</span>
                     ) : !isMaster ? (
                       <span className="text-xs text-zinc-400" title="School Admin details are available only to a Master CIG administrator">Not available</span>
                     ) : org.itAdmin ? (
                      <div>
                        <div className="text-sm font-medium text-zinc-900">{org.itAdmin.name}</div>
                        <div className="text-xs text-zinc-500 mt-0.5">{org.itAdmin.email}</div>
                      </div>
                    ) : (
                      <span className="text-xs text-zinc-400 italic">None</span>
                    )}
                  </td>
                    {isMaster && <td className="min-w-[150px] px-5 py-4 text-center">
                     {isMaster ? (
                       <button
                         type="button"
                         onClick={() => handleToggleActive(org)}
                         aria-label={`${org.active ? "Suspend" : "Reactivate"} ${org.name}`}
                         className="whitespace-nowrap text-xs font-medium text-zinc-600 hover:text-zinc-900"
                       >
                         {org.active ? "Suspend" : "Reactivate"}
                       </button>
                     ) : (
                       <span className="text-xs text-zinc-400" title={`Only a Master CIG administrator can ${org.active ? "suspend" : "reactivate"} a school`}>Not available</span>
                     )}
                    </td>}
                    {isMaster && <td className="min-w-[180px] px-5 py-4 text-center">
                     {org.active && isMaster ? (
                       org.itAdmin ? (
                         <button
                           type="button"
                           onClick={() => handleSendSchoolMasterReset(org)}
                           disabled={sendingSchoolMasterResetId === org.id}
                           aria-label={`Reset password for ${org.itAdmin.name}`}
                           className="mx-auto max-w-[160px] whitespace-nowrap text-center text-xs font-medium text-zinc-600 hover:text-zinc-900 disabled:opacity-50"
                         >
                           {sendingSchoolMasterResetId === org.id ? "Sending…" : "Reset password"}
                         </button>
                       ) : (
                         <button
                           type="button"
                           onClick={() => setModal({ type: "new-admin", orgId: org.id, orgName: org.name })}
                           aria-label={`Create School Admin for ${org.name}`}
                           className="mx-auto max-w-[160px] whitespace-nowrap text-center text-xs font-medium text-zinc-600 hover:text-zinc-900"
                         >
                           Create School Admin
                         </button>
                       )
                     ) : org.active && !isMaster ? (
                       <span className="text-xs text-zinc-400" title="Only a Master CIG administrator can manage the School Admin account">Not available</span>
                     ) : (
                       <span className="text-xs text-zinc-400" title="School Admin actions are unavailable while the school is suspended">Not available</span>
                     )}
                   </td>}
                   {isMaster && <td className="min-w-[180px] px-5 py-4 text-center">
                     {!org.active ? (
                       isMaster ? (
                         <button
                           type="button"
                           onClick={() => openSchoolLifecycleModal(org, "remove")}
                           aria-label={`Remove ${org.name} for 30 days`}
                           className="whitespace-nowrap text-xs font-medium text-red-600 hover:text-red-700"
                         >
                           Remove for 30 days
                         </button>
                       ) : (
                         <span className="text-xs text-zinc-400" title="Only a Master CIG administrator can remove a school for recovery">Not available</span>
                       )
                     ) : (
                       <span className="text-xs text-zinc-400" title="Suspend the school before removing it for recovery">Not available</span>
                     )}
                   </td>}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
           )}
           {currentOrgs.length === 0 && (
            <div className="p-12 text-center text-zinc-500 text-sm">
              <h2 className="text-lg font-semibold text-zinc-900">No schools registered yet.</h2>
              <p className="mt-2">Add a school when it is ready, or refresh to check for changes.</p>
              <button type="button" onClick={() => void loadSchools()} className={btnSecondary + " mt-5"} data-testid="workspace-refresh">Refresh workspace</button>
            </div>
          )}
        </div>
        <div className="mt-4 flex items-center justify-between text-sm text-zinc-600">
          <span>Page {schoolFilters.page} of {orgTotalPages} · {orgTotal} matching</span>
          <div className="flex gap-2"><button type="button" className={btnSecondary} disabled={schoolFilters.page <= 1} onClick={() => { const next = { ...schoolFilters, page: schoolFilters.page - 1 }; setSchoolFilters(next); loadSchools(next); }}>Previous</button><button type="button" className={btnSecondary} disabled={schoolFilters.page >= orgTotalPages} onClick={() => { const next = { ...schoolFilters, page: schoolFilters.page + 1 }; setSchoolFilters(next); loadSchools(next); }}>Next</button></div>
         </div>
           </>
          )}
        {deletedOrgs.length > 0 && (
          <div className="mt-5 rounded-xl border border-red-200 bg-red-50/50 overflow-hidden">
            <div className="p-5 pb-3">
            <h3 className="font-semibold text-red-900">Deleted schools</h3>
             <p className="mt-1 text-sm text-red-800">These schools are hidden and blocked. They are Restorable for 30 days.</p>
            </div>
            <div className="overflow-x-auto">
               <table className="w-full min-w-[760px] text-left">
                <thead className="border-y border-red-200 bg-red-100/50">
                  <tr>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-red-900">School</th>
                     <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-red-900">School Admin</th>
                     <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-red-900">Enrolled</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-red-900">Deleted</th>
                     <th className="px-5 py-3 text-center text-xs font-semibold uppercase tracking-wider text-red-900">Restore school</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-red-100">
                  {deletedOrgs.map((org) => (
                    <tr key={`${org.id}-${org.deletedAt}`} className="text-sm">
                      <td className="px-5 py-3 font-medium text-zinc-700">{org.name}</td>
                       <td className="px-5 py-3">
                         {org.itAdmin ? (
                           <div>
                             <div className="font-medium text-zinc-700">{org.itAdmin.name}</div>
                             <div className="mt-0.5 text-xs text-zinc-500">{org.itAdmin.email}</div>
                           </div>
                         ) : (
                           <span className="text-xs text-zinc-400">Not available</span>
                         )}
                       </td>
                       <td className="px-5 py-3 text-zinc-600">{new Date(org.createdAt).toLocaleDateString("en-GB")}</td>
                      <td className="px-5 py-3 text-zinc-600">{org.deletedAt && new Date(org.deletedAt).toLocaleDateString("en-GB")}</td>
                       <td className="px-5 py-3 text-center">
                         {isMaster ? (
                            <button type="button" onClick={() => openSchoolLifecycleModal(org, "restore")} aria-label={`Restore ${org.name}`} className="text-xs font-medium text-emerald-700 hover:text-emerald-800">Restore school</button>
                          ) : (
                            <span className="text-xs text-zinc-400" title="Only a Master CIG administrator can restore a deleted school">Not available</span>
                         )}
                        </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
          </>
        )}
      </main>

      <AlertDialog
        open={!!statusChangeOrg}
        onOpenChange={(open) => {
          if (!open && !statusChangeSubmitting) setStatusChangeOrg(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {statusChangeOrg?.active ? "Suspend school?" : "Reactivate school?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium text-zinc-900">{statusChangeOrg?.name}</span>
              <span className="mt-2 block">
                {statusChangeOrg?.active
                   ? "The School Admin, teachers, and students will be unable to access this school until it is reactivated."
                   : "The School Admin, teachers, and students will be able to access this school again."}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={statusChangeSubmitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmToggleActive}
              disabled={statusChangeSubmitting}
              className={statusChangeOrg?.active ? "bg-red-600 hover:bg-red-700 focus:ring-red-600" : ""}
            >
              {statusChangeSubmitting
                ? "Saving…"
                : statusChangeOrg?.active
                  ? "Suspend school"
                   : "Reactivate school"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
