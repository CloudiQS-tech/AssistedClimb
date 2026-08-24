import type { Request, Response, NextFunction } from "express";
import { db, studentSessionsTable, classesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export async function requireStudentSession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Accept session ID from cookie-based session OR from the X-Student-Session-Id
  // header (used by the frontend when cookies are blocked in cross-origin iframes).
  const cookieSessionId = req.session.studentSessionId;
  const headerSessionId = req.headers["x-student-session-id"];
  const studentSessionId = cookieSessionId ??
    (typeof headerSessionId === "string" && headerSessionId ? Number(headerSessionId) : undefined);

  if (!studentSessionId) {
    res.status(401).json({ error: "No active student session" });
    return;
  }

  const [session] = await db
    .select({
      id: studentSessionsTable.id,
      classId: studentSessionsTable.classId,
      studentName: studentSessionsTable.studentName,
      sessionNonce: studentSessionsTable.sessionNonce,
      createdAt: studentSessionsTable.createdAt,
      className: classesTable.name,
    })
    .from(studentSessionsTable)
    .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
    .where(eq(studentSessionsTable.id, studentSessionId));

  if (!session) {
    req.session.destroy(() => {});
    res.status(401).json({ error: "No active student session" });
    return;
  }

  // Single-session enforcement: if the DB has a nonce, the client must present
  // the matching one. A mismatch means someone else joined with the same PIN.
  if (session.sessionNonce) {
    const cookieNonce = req.session.studentNonce;
    const headerNonce = req.headers["x-student-nonce"];
    const clientNonce = cookieNonce ?? (typeof headerNonce === "string" ? headerNonce : undefined);

    if (clientNonce !== session.sessionNonce) {
      req.session.destroy(() => {});
      res.status(401).json({
        error: "Your session is no longer active — someone may have joined using your name and PIN. Please rejoin and let your teacher know.",
        sessionTakenOver: true,
      });
      return;
    }
  }

  req.studentSession = session;
  next();
}
