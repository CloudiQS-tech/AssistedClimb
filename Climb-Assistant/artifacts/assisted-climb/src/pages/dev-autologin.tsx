import { useEffect } from "react";
import { useLocation } from "wouter";
import { apiFetch } from "@/lib/api";

export default function DevAutoLogin() {
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (import.meta.env.PROD) return;
    const params = new URLSearchParams(window.location.search);
    const to = params.get("to") || "/teacher/dashboard";
    const role = params.get("role") || "teacher";

    if (role === "student") {
      apiFetch("/student/join", {
        method: "POST",
        body: JSON.stringify({ studentName: "Emma Patel", classCode: "WNGNVD", pin: "1234" }),
      })
        .then(() => setLocation(to))
        .catch(() => setLocation("/join"));
    } else {
      apiFetch("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "demo2@school.edu", password: "demo1234" }),
      })
        .then(() => setLocation(to))
        .catch(() => setLocation("/teacher/login"));
    }
  }, [setLocation]);

  return (
    <div className="min-h-[100dvh] flex items-center justify-center text-neutral-500 text-sm">
      Signing in…
    </div>
  );
}
