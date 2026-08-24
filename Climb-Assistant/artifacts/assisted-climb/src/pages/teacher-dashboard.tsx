import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { apiFetch, clearTeacherToken } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
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

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button
      onClick={copy}
      className={`mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
        copied
          ? "bg-emerald-100 text-emerald-700 border border-emerald-200"
          : "bg-white text-neutral-500 border border-neutral-200 hover:text-neutral-800 hover:border-neutral-300"
      }`}
    >
      {copied ? (
        <>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          Copied
        </>
      ) : (
        <>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="4" y="4" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.2"/><path d="M3 8H2.5A1.5 1.5 0 0 1 1 6.5v-5A1.5 1.5 0 0 1 2.5 0h5A1.5 1.5 0 0 1 9 1.5V2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
          Copy code
        </>
      )}
    </button>
  );
}

export default function TeacherDashboard() {
  const [classes, setClasses] = useState<any[]>([]);
  const [teacher, setTeacher] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [showNewClass, setShowNewClass] = useState(false);
  const [newClassName, setNewClassName] = useState("");
  const [newClassSubject, setNewClassSubject] = useState("");

  const [classToDelete, setClassToDelete] = useState<{ id: number; name: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    apiFetch("/auth/me")
      .then((data) => {
        if (data?.isItAdmin) { setLocation("/teacher/settings"); return; }
        setTeacher(data);
      })
      .catch(() => setLocation("/teacher/login"));

    apiFetch("/teacher/classes")
      .then((data) => {
        setClasses(data);
        setLoading(false);
      })
      .catch(() => { setLocation("/teacher/login"); setLoading(false); });
  }, [setLocation]);

  const handleSignOut = async () => {
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } catch (e) {}
    clearTeacherToken();
    setLocation("/");
  };

  const handleCreateClass = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const cls = await apiFetch("/teacher/classes", {
        method: "POST",
        body: JSON.stringify({ name: newClassName, subject: newClassSubject || undefined })
      });
      setLocation(`/teacher/class/${cls.id}`);
    } catch (err: any) {
      toast({
        title: "Error creating class",
        description: err.message,
        variant: "destructive"
      });
    }
  };

  const handleDeleteClass = async () => {
    if (!classToDelete) return;
    setIsDeleting(true);
    try {
      await apiFetch(`/teacher/classes/${classToDelete.id}`, { method: "DELETE" });
      setClasses((prev) => prev.filter((c) => c.id !== classToDelete.id));
      toast({ title: "Class deleted", description: `"${classToDelete.name}" and all its student data have been removed.` });
    } catch (err: any) {
      toast({ title: "Error deleting class", description: err.message, variant: "destructive" });
    } finally {
      setIsDeleting(false);
      setClassToDelete(null);
    }
  };

  if (loading) return null;

  return (
    <div className="min-h-[100dvh] bg-neutral-50 text-neutral-900 font-sans">
      <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              The Assisted Climb <span className="text-neutral-400 font-normal ml-2">Teacher Dashboard</span>
            </h1>
          </div>

          <div className="flex items-center gap-6 text-sm">
            <span className="flex items-center gap-2 text-neutral-600">
              {teacher?.name}
              {teacher?.isItAdmin && (
                <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">IT Admin</span>
              )}
            </span>
            <Link href="/teacher/settings" className="text-neutral-500 hover:text-black transition-colors" data-testid="link-settings">
              Settings
            </Link>
            <button onClick={handleSignOut} className="hover:text-black transition-colors text-neutral-500">
              Sign Out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-12">
        <div className="flex items-center justify-between mb-8">
          <h2 className="text-3xl font-semibold tracking-tight">Your Classes</h2>
          <button 
            onClick={() => setShowNewClass(!showNewClass)}
            className="rounded-2xl bg-black text-white px-5 py-3 text-sm font-medium hover:opacity-90 transition-opacity"
            data-testid="button-new-class"
          >
            {showNewClass ? "Cancel" : "New Class"}
          </button>
        </div>

        {showNewClass && (
          <div className="mb-8 rounded-[2rem] bg-white border border-neutral-200 p-6 shadow-sm">
            <h3 className="text-lg font-semibold mb-4">Create New Class</h3>
            <form onSubmit={handleCreateClass} className="flex flex-col sm:flex-row gap-4 items-start sm:items-end">
              <div className="w-full sm:flex-1">
                <label className="block text-sm font-medium mb-2">Class Code</label>
                <input 
                  required
                  type="text"
                  value={newClassName}
                  onChange={(e) => setNewClassName(e.target.value)}
                  className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10"
                  placeholder="e.g. 10A"
                  data-testid="input-class-name"
                />
              </div>
              <div className="w-full sm:flex-1">
                <label className="block text-sm font-medium mb-2">Subject</label>
                <input 
                  type="text"
                  value={newClassSubject}
                  onChange={(e) => setNewClassSubject(e.target.value)}
                  className="w-full rounded-2xl border border-neutral-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black/10"
                  placeholder="e.g. Literature"
                  data-testid="input-class-subject"
                />
              </div>
              <button 
                type="submit"
                className="w-full sm:w-auto rounded-2xl bg-black text-white px-6 py-3 h-[50px] text-sm font-medium hover:opacity-90 transition-opacity"
                data-testid="button-create-class"
              >
                Create Class
              </button>
            </form>
          </div>
        )}

        {classes.length === 0 ? (
          <div className="text-center py-20 bg-white rounded-[2rem] border border-neutral-200 shadow-sm">
            <p className="text-neutral-500">You don't have any classes yet.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {classes.map((cls) => (
              <div key={cls.id} className="relative group rounded-[2rem] bg-white border border-neutral-200 shadow-sm hover:shadow-md transition-shadow flex flex-col h-full">
                <Link 
                  href={`/teacher/class/${cls.id}`}
                  className="flex-1 p-6 flex flex-col block"
                  data-testid={`card-class-${cls.id}`}
                >
                  <div className="flex-1">
                    <h4 className="text-xl font-semibold tracking-tight mb-1">
                      {cls.name}
                    </h4>
                    {cls.subject && (
                      <p className="text-sm text-neutral-500 mb-6">{cls.subject}</p>
                    )}
                    
                    <div className="my-6">
                      <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-2">Join Code</p>
                      <p className="text-3xl font-mono font-bold tracking-widest">{cls.code}</p>
                      <CopyButton code={cls.code} />
                    </div>
                  </div>
                  
                  <div className="pt-4 border-t border-neutral-100 flex items-center justify-between">
                    <span className="text-sm text-neutral-500">{new Date(cls.createdAt).toLocaleDateString()}</span>
                    <span className="rounded-2xl bg-black text-white px-4 py-2 text-sm font-medium">
                      View Class →
                    </span>
                  </div>
                </Link>

                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setClassToDelete({ id: cls.id, name: cls.name });
                  }}
                  className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity rounded-xl p-2 text-neutral-400 hover:text-red-500 hover:bg-red-50"
                  title="Delete class"
                  data-testid={`button-delete-class-${cls.id}`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18"/>
                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </main>

      <AlertDialog open={!!classToDelete} onOpenChange={(open) => { if (!open) setClassToDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{classToDelete?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the class and all student progress, stage entries, and chat history within it. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteClass}
              disabled={isDeleting}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
              data-testid="button-confirm-delete-class"
            >
              {isDeleting ? "Deleting…" : "Delete Class"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
