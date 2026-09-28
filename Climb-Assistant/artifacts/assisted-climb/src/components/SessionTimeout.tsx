import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { apiFetch, clearStudentSession, clearTeacherToken } from "@/lib/api";
import { flushBeforeLogout } from "@/lib/session-lifecycle";

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const WARNING_WINDOW_MS = 5 * 60 * 1000;
const SERVER_ACTIVITY_INTERVAL_MS = 60 * 1000;
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "scroll", "touchstart"] as const;

type SessionRole = "student" | "teacher" | "admin";

function roleForPath(path: string): SessionRole | null {
  if (/\/climb(?:\/|$)/.test(path)) return "student";
  if (/\/teacher\/(dashboard|class|settings|change-password|student)/.test(path)) return "teacher";
  if (/\/admin(?:\/|$)/.test(path)) return "admin";
  return null;
}

function loginPath(role: SessionRole): string {
  if (role === "student") return "/join";
  if (role === "admin") return "/admin";
  return "/teacher/login";
}

function logoutPath(role: SessionRole): string {
  if (role === "student") return "/student/logout";
  if (role === "admin") return "/admin/auth/logout";
  return "/auth/logout";
}

function mePath(role: SessionRole): string {
  if (role === "student") return "/student/session";
  if (role === "admin") return "/admin/auth/me";
  return "/auth/me";
}

function getIdleTimeoutMs(): number {
  if (!import.meta.env.DEV) return IDLE_TIMEOUT_MS;
  const raw = new URLSearchParams(window.location.search).get("sessionTimeoutMs");
  const value = raw ? Number(raw) : NaN;
  return Number.isInteger(value) && value >= 10_000 && value <= IDLE_TIMEOUT_MS ? value : IDLE_TIMEOUT_MS;
}

export default function SessionTimeout() {
  const [location, setLocation] = useLocation();
  const role = useMemo(() => roleForPath(location), [location]);
  const idleTimeoutMs = useMemo(getIdleTimeoutMs, [location]);
  const warningWindowMs = Math.min(WARNING_WINDOW_MS, Math.floor(idleTimeoutMs / 2));
  const [authenticated, setAuthenticated] = useState(false);
  const [remainingMs, setRemainingMs] = useState(idleTimeoutMs);
  const [loggingOut, setLoggingOut] = useState(false);
  const lastActivityRef = useRef(Date.now());
  const lastServerActivityRef = useRef(Date.now());
  const absoluteExpiresAtRef = useRef<number | null>(null);

  const logout = useCallback(async (reason: "timeout" | "expired") => {
    if (!role || loggingOut) return;
    setLoggingOut(true);
    await flushBeforeLogout();
    try {
      await apiFetch(logoutPath(role), { method: "POST" });
    } catch {
      // The server may already have expired the session; local cleanup still applies.
    }
    clearStudentSession();
    clearTeacherToken();
    if (reason === "timeout") {
      sessionStorage.setItem("sessionTimeoutMessage", "You were signed out after 30 minutes of inactivity.");
    }
    setAuthenticated(false);
    setLocation(loginPath(role));
  }, [loggingOut, role, setLocation]);

  useEffect(() => {
    let cancelled = false;
    setAuthenticated(false);
    setLoggingOut(false);
    if (!role) return;
    apiFetch(mePath(role))
      .then(async () => {
        const status = await apiFetch("/session/status");
        if (cancelled) return;
        const now = Date.now();
        lastActivityRef.current = now;
        lastServerActivityRef.current = now;
        absoluteExpiresAtRef.current = new Date(status.absoluteExpiresAt).getTime();
        setRemainingMs(idleTimeoutMs);
        setAuthenticated(true);
      })
      .catch(() => { if (!cancelled) setAuthenticated(false); });
    return () => { cancelled = true; };
  }, [idleTimeoutMs, role]);

  useEffect(() => {
    if (!role || !authenticated) return;
    const markActivity = () => {
      const now = Date.now();
      lastActivityRef.current = now;
      if (now - lastServerActivityRef.current >= SERVER_ACTIVITY_INTERVAL_MS) {
        lastServerActivityRef.current = now;
        void apiFetch("/session/keep-alive", { method: "POST" })
          .then((status) => {
            absoluteExpiresAtRef.current = new Date(status.absoluteExpiresAt).getTime();
          })
          .catch(() => {
            void logout("expired");
          });
      }
    };
    ACTIVITY_EVENTS.forEach((event) => window.addEventListener(event, markActivity, { passive: true }));
    const timer = window.setInterval(() => {
      const idleRemaining = idleTimeoutMs - (Date.now() - lastActivityRef.current);
      const absoluteRemaining = absoluteExpiresAtRef.current === null
        ? Number.POSITIVE_INFINITY
        : absoluteExpiresAtRef.current - Date.now();
      const remaining = Math.max(0, Math.min(idleRemaining, absoluteRemaining));
      setRemainingMs(remaining);
      if (remaining === 0) void logout("timeout");
    }, 1000);
    return () => {
      ACTIVITY_EVENTS.forEach((event) => window.removeEventListener(event, markActivity));
      window.clearInterval(timer);
    };
  }, [authenticated, idleTimeoutMs, logout, role]);

  const handleStaySignedIn = async () => {
    try {
      const status = await apiFetch("/session/keep-alive", { method: "POST" });
      const now = Date.now();
      lastActivityRef.current = now;
      lastServerActivityRef.current = now;
      absoluteExpiresAtRef.current = new Date(status.absoluteExpiresAt).getTime();
      setRemainingMs(idleTimeoutMs);
    } catch {
      await logout("expired");
    }
  };

  if (!role || !authenticated || remainingMs > warningWindowMs || loggingOut) return null;
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const displaySeconds = String(seconds % 60).padStart(2, "0");

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/35 p-6" role="alertdialog" aria-modal="true" aria-labelledby="session-timeout-title">
      <div className="w-full max-w-md rounded-[2rem] bg-white p-8 shadow-2xl">
        <p className="mb-2 text-xs font-bold uppercase tracking-[0.2em] text-amber-600">Security reminder</p>
        <h2 id="session-timeout-title" className="text-2xl font-semibold tracking-tight text-neutral-900">Are you still there?</h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-600">
          You will be signed out in <strong>{minutes}:{displaySeconds}</strong> because there has been no activity. Any pending work will be saved first.
        </p>
        <div className="mt-6 flex gap-3">
          <button onClick={() => void logout("timeout")} className="flex-1 rounded-2xl border border-neutral-300 px-4 py-3 text-sm font-medium text-neutral-700 hover:bg-neutral-50">
            Sign out now
          </button>
          <button autoFocus onClick={handleStaySignedIn} className="flex-1 rounded-2xl bg-neutral-900 px-4 py-3 text-sm font-semibold text-white hover:bg-neutral-700">
            Stay signed in
          </button>
        </div>
      </div>
    </div>
  );
}