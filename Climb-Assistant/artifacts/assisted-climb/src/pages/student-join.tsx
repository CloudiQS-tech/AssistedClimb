import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import {
  apiFetch,
  consumeStudentRecoveryNotice,
  setStudentSession,
} from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

type Step = "identity" | "pin-new" | "pin-returning" | "pending" | "rejected";

function splitStudentName(name: string): { firstName: string; surname: string } {
  const trimmed = name.trim();
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace === -1) return { firstName: trimmed, surname: "" };
  return {
    firstName: trimmed.slice(0, firstSpace),
    surname: trimmed.slice(firstSpace + 1).trim(),
  };
}

function combineStudentName(firstName: string, surname: string): string {
  return `${firstName.trim()} ${surname.trim()}`.trim();
}

export default function StudentJoin() {
  const search = useSearch();
  const isSwitching = new URLSearchParams(search).get("switch") === "1";
  const [firstName, setFirstName] = useState(() => (
    isSwitching ? splitStudentName(sessionStorage.getItem("switchName") ?? "").firstName : ""
  ));
  const [surname, setSurname] = useState(() => (
    isSwitching ? splitStudentName(sessionStorage.getItem("switchName") ?? "").surname : ""
  ));
  const [classCode, setClassCode] = useState("");
  const [pin, setPin] = useState("");
  const [step, setStep] = useState<Step>("identity");
  const [pinWasReset, setPinWasReset] = useState(false);
  const [showRecoveryNotice, setShowRecoveryNotice] = useState(false);
  const [, setLocation] = useLocation();
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const name = combineStudentName(firstName, surname);

  useEffect(() => {
    const hasRecoveryNotice = consumeStudentRecoveryNotice();
    if (isSwitching) {
      sessionStorage.removeItem("switchName");
      return;
    }
    setShowRecoveryNotice(hasRecoveryNotice);
    apiFetch("/student/session")
      .then(() => setLocation("/climb"))
      .catch(() => {});
  }, [isSwitching, setLocation]);

  const handleIdentitySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim() || !surname.trim()) {
      toast({
        title: "Enter your full name",
        description: "Please enter both your first name and surname.",
        variant: "destructive",
      });
      return;
    }
    setLoading(true);
    try {
      const data = await apiFetch("/student/check-join", {
        method: "POST",
        body: JSON.stringify({
          studentName: name,
          classCode: classCode.toUpperCase().trim(),
        }),
      });
      if (data.registrationStatus === "pending" || data.registrationStatus === "rejected") {
        setStep(data.registrationStatus);
        return;
      }
      // exists + hasPinSet → enter PIN
      // exists + !hasPinSet → teacher reset PIN, create new one
      // !exists → brand new student, create PIN
      const returning = data.exists && !data.hasPinSet;
      setPinWasReset(returning);
      setStep(data.exists && data.hasPinSet ? "pin-returning" : "pin-new");
    } catch (err: any) {
      toast({
        title: "Could not check class",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handlePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim() || !surname.trim()) {
      setStep("identity");
      return;
    }
    if (pin.length !== 6 || !/^\d{6}$/.test(pin)) {
      toast({
        title: "Invalid PIN",
        description: "Your PIN must be exactly 6 digits.",
        variant: "destructive",
      });
      return;
    }
    setLoading(true);
    try {
      const data = await apiFetch("/student/join", {
        method: "POST",
        body: JSON.stringify({
          studentName: name,
          classCode: classCode.toUpperCase().trim(),
          pin,
        }),
      });
      if (data.registrationStatus === "pending" || data.registrationStatus === "rejected") {
        setStep(data.registrationStatus);
        return;
      }
      setStudentSession(data.id, data.nonce, data.previewSessionToken);
      setLocation("/climb");
    } catch (err: any) {
      toast({
        title: step === "pin-returning" ? "Incorrect PIN" : "Could not join",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-neutral-50 flex items-center justify-center p-6 font-sans">
      <div className="w-full max-w-md bg-white rounded-[2rem] p-8 shadow-sm border border-neutral-200">

        {showRecoveryNotice && (
          <div
            className="mb-6 rounded-2xl bg-amber-50 border border-amber-200 px-4 py-4 text-sm text-amber-800"
            role="status"
            data-testid="student-recovery-notice"
          >
            <h2 className="font-semibold text-center">Class temporarily unavailable</h2>
            <p className="mt-1 leading-6 text-center">
              This class is temporarily unavailable during its recovery period. A teacher or School Admin can restore access. Please try joining again after it has been restored.
            </p>
          </div>
        )}

        {step === "identity" && (
          <>
            {isSwitching && (
              <div className="mb-6 rounded-2xl bg-sky-50 border border-sky-200 px-4 py-3 text-sm text-sky-700 text-center">
                Switching class — your name is pre-filled. Just enter the new class code.
              </div>
            )}
            <h1 className="text-3xl font-semibold tracking-tight mb-2 text-center">
              {isSwitching ? "Switch Class" : "Join Climb"}
            </h1>
            <p className="text-sm text-neutral-500 mb-8 text-center">
              {isSwitching ? "Enter the code for the class you want to switch to." : "Enter your first name, surname and class code to start your climb."}
            </p>

            <form onSubmit={handleIdentitySubmit} className="space-y-5">
              <div>
                <label htmlFor="student-first-name" className="block text-sm font-medium mb-2">First name</label>
                <input
                  required
                  type="text"
                  id="student-first-name"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10"
                  placeholder="e.g. Alex"
                  autoComplete="given-name"
                  data-testid="input-student-first-name"
                />
              </div>

              <div>
                <label htmlFor="student-surname" className="block text-sm font-medium mb-2">Surname</label>
                <input
                  required
                  type="text"
                  id="student-surname"
                  value={surname}
                  onChange={(e) => setSurname(e.target.value)}
                  className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10"
                  placeholder="e.g. Smith"
                  autoComplete="family-name"
                  data-testid="input-student-surname"
                />
              </div>

              <div>
                <label htmlFor="student-class-code" className="block text-sm font-medium mb-2">Class Code</label>
                <input
                  required
                  type="text"
                  id="student-class-code"
                  value={classCode}
                  onChange={(e) => setClassCode(e.target.value.toUpperCase())}
                  className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10 font-mono tracking-widest uppercase"
                  placeholder="XXXXXX"
                  maxLength={6}
                  data-testid="input-class-code"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-2xl bg-black text-white px-6 py-4 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-40"
                data-testid="button-continue"
              >
                {loading ? "Checking..." : "Continue →"}
              </button>
            </form>
          </>
        )}

        {(step === "pin-new" || step === "pin-returning") && (
          <>
            <button
              onClick={() => { setStep("identity"); setPin(""); }}
              className="text-sm text-neutral-400 hover:text-neutral-700 mb-6 flex items-center gap-1 transition-colors"
            >
              ← Back
            </button>

            <h1 className="text-3xl font-semibold tracking-tight mb-2 text-center">
              {step === "pin-new" ? "Create a PIN" : "Welcome back!"}
            </h1>
            <p className="text-sm text-neutral-500 mb-2 text-center font-medium">
              {name}
            </p>
            <p className="text-sm text-neutral-400 mb-8 text-center">
              {step === "pin-new"
                ? "Choose a 6-digit PIN. You'll need it every time you join."
                : "Enter your 6-digit PIN to continue your climb."}
            </p>
            {pinWasReset && (
              <div className="mb-6 rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3 text-xs text-amber-700 text-center">
                Your teacher has reset your PIN — choose a new one to continue.
              </div>
            )}

            <form onSubmit={handlePinSubmit} className="space-y-5">
              <div>
                <label htmlFor="student-pin" className="block text-sm font-medium mb-2">
                  {step === "pin-new" ? "Choose a PIN" : "Your PIN"}
                </label>
                <input
                  id="student-pin"
                  required
                  type="password"
                  inputMode="numeric"
                  autoComplete={step === "pin-new" ? "new-password" : "current-password"}
                  pattern="\d{6}"
                  maxLength={6}
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  className="w-full rounded-2xl border border-neutral-200 px-4 py-3 text-center text-2xl tracking-[0.5em] focus:outline-none focus:ring-2 focus:ring-black/10"
                  placeholder="••••••"
                  data-testid="input-pin"
                  autoFocus
                />
              </div>

              <button
                type="submit"
                disabled={loading || pin.length !== 6}
                className="w-full rounded-2xl bg-black text-white px-6 py-4 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-40"
                data-testid="button-join"
              >
                {loading
                  ? step === "pin-new" ? "Joining..." : "Verifying..."
                  : step === "pin-new" ? "Join Climb" : "Continue Climb"}
              </button>
            </form>
          </>
        )}
        {step === "pending" && (
          <>
            <h1 className="text-3xl font-semibold tracking-tight mb-3 text-center">Waiting for approval</h1>
            <p className="text-sm leading-6 text-neutral-500 text-center">
              Registration has been sent to your teacher. You can return here once they've approved it. Use the same name, class code, and PIN number.
            </p>
            <button
              onClick={() => { setStep("identity"); setPin(""); }}
              className="mt-8 w-full rounded-2xl border border-neutral-300 px-6 py-3 text-sm font-medium hover:bg-neutral-50"
            >
              Try again later
            </button>
          </>
        )}
        {step === "rejected" && (
          <>
            <h1 className="text-3xl font-semibold tracking-tight mb-3 text-center">Registration not approved</h1>
            <p className="text-sm leading-6 text-neutral-500 text-center">
              Your teacher has not approved this registration. Please speak to them before trying again.
            </p>
            <button
              onClick={() => { setStep("identity"); setPin(""); }}
              className="mt-8 w-full rounded-2xl border border-neutral-300 px-6 py-3 text-sm font-medium hover:bg-neutral-50"
            >
              Back to class code
            </button>
          </>
        )}
        <p className="text-center text-xs text-neutral-400 mt-6">
          Teacher?{" "}
          <a href="/teacher/login" className="underline hover:text-neutral-600 transition-colors">
            Sign in here
          </a>
        </p>
      </div>
    </div>
  );
}
