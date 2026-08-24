import type { Request, Response, NextFunction } from "express";
import { db, teachersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export async function requireTeacher(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Primary: session cookie
  const teacherId = req.session.teacherId;
  if (teacherId) {
    const [teacher] = await db
      .select()
      .from(teachersTable)
      .where(eq(teachersTable.id, teacherId));

    if (teacher) {
      req.teacher = teacher;
      next();
      return;
    }

    req.session.destroy(() => {});
  }

  // Fallback: X-Teacher-Token header (for environments where cookies are blocked)
  const headerToken = req.headers["x-teacher-token"];
  if (typeof headerToken === "string" && headerToken.length > 0) {
    const [teacher] = await db
      .select()
      .from(teachersTable)
      .where(eq(teachersTable.loginToken, headerToken));

    if (teacher) {
      req.teacher = teacher;
      // Restore session for future requests in this process
      req.session.teacherId = teacher.id;
      next();
      return;
    }
  }

  res.status(401).json({ error: "Not authenticated" });
}
