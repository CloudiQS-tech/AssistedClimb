import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { apiFetch } from "@/lib/api";

export default function Landing() {
  const [, setLocation] = useLocation();

  useEffect(() => {
    // Check teacher session
    apiFetch("/auth/me")
      .then(() => setLocation("/teacher/dashboard"))
      .catch(() => {
        // Not a teacher, check student session
        apiFetch("/student/session")
          .then(() => setLocation("/climb"))
          .catch(() => {});
      });
  }, [setLocation]);

  return (
    <div className="min-h-[100dvh] bg-neutral-50 flex flex-col items-center justify-center p-6 font-sans">
      <div className="text-center mb-12">
        <h1 className="text-4xl md:text-5xl font-semibold tracking-tight mb-4">
          The Assisted Climb
        </h1>
        <p className="text-lg text-neutral-500">
          A guided workspace for learning with AI.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full max-w-3xl">
        <Link href="/join" className="flex flex-col items-center justify-center p-10 rounded-[2rem] bg-black text-white hover:opacity-90 transition-opacity" data-testid="button-student-landing">
          <span className="text-xl font-semibold mb-2">I'm a Student</span>
          <span className="text-sm text-neutral-400">Join a class workspace</span>
        </Link>
        
        <Link href="/teacher/login" className="flex flex-col items-center justify-center p-10 rounded-[2rem] bg-white border-2 border-neutral-200 text-black hover:bg-neutral-50 transition-colors" data-testid="button-teacher-landing">
          <span className="text-xl font-semibold mb-2">I'm a Teacher</span>
          <span className="text-sm text-neutral-500">Manage your classes</span>
        </Link>
      </div>
    </div>
  );
}
