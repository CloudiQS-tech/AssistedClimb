import type { Request, Response, NextFunction } from "express";
import {
  db,
  studentSessionsTable,
  studentActivitySessionsTable,
  classesTable,
  organisationsTable,
  teachersTable,
} from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { regenerateAnonymousSessionPreservingSiteAccess } from "../lib/session-cookie";

export const STUDENT_RECOVERY_ERROR_CODE = "STUDENT_RECOVERY_PERIOD";

function isBestEffortActivityPause(req: Request): boolean {
  return req.method === "POST" && req.path.endsWith("/student/activity/pause");
}

async function closeStudentActivity(req: Request, endReason: string): Promise<void> {
  const activityId = req.session.studentActivityId;
  const studentSessionId = req.session.studentSessionId;
  if (!activityId || !studentSessionId) return;
  try {
    await db
      .update(studentActivitySessionsTable)
      .set({
        // A displaced browser must never gain time between its last activity
        // heartbeat and the request that discovers the displacement.
        endedAt: sql`${studentActivitySessionsTable.lastSeenAt}`,
        endReason,
      })
      .where(
        and(
          eq(studentActivitySessionsTable.id, activityId),
          eq(studentActivitySessionsTable.studentSessionId, studentSessionId),
          isNull(studentActivitySessionsTable.endedAt),
        ),
      );
  } catch {
    // An activity record must not prevent the session-security response.
  }
}

export async function requireStudentSession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const studentSessionId = req.session.studentSessionId;

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
      isBlocked: studentSessionsTable.isBlocked,
      registrationStatus: studentSessionsTable.registrationStatus,
      lockedAt: studentSessionsTable.lockedAt,
      archivedAt: studentSessionsTable.archivedAt,
      retentionUntil: studentSessionsTable.retentionUntil,
      deletionScheduledFor: studentSessionsTable.deletionScheduledFor,
      createdAt: studentSessionsTable.createdAt,
      className: classesTable.name,
      classArchivedAt: classesTable.archivedAt,
      classDeletionScheduledFor: classesTable.deletionScheduledFor,
      organisationActive: organisationsTable.active,
    })
    .from(studentSessionsTable)
    .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
    .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
    .innerJoin(organisationsTable, eq(teachersTable.organisationId, organisationsTable.id))
    .where(and(
      eq(studentSessionsTable.id, studentSessionId),
      isNull(organisationsTable.deletedAt),
    ));

  if (!session) {
    await closeStudentActivity(req, "account_missing");
    req.session.destroy(() => {});
    res.status(401).json({ error: "No active student session" });
    return;
  }

  if (session.isBlocked) {
    await closeStudentActivity(req, "blocked");
    req.session.destroy(() => {});
    res.status(403).json({ error: "Your access to this class has been removed. Please speak to your teacher." });
    return;
  }

  if (session.registrationStatus !== "approved") {
    await closeStudentActivity(req, `registration_${session.registrationStatus}`);
    req.session.destroy(() => {});
    res.status(403).json({
      error: session.registrationStatus === "pending"
        ? "Your registration is waiting for your teacher's approval."
        : "Your registration was not approved. Please speak to your teacher.",
    });
    return;
  }

  if (session.deletionScheduledFor || session.classDeletionScheduledFor) {
    await closeStudentActivity(req, "deletion_requested");
    // Browsers abort the unload-time pause request before accepting a rotated
    // cookie. Keep that request denied, then rotate on the next normal request
    // so the student reaches the join screen without retaining authentication.
    if (!isBestEffortActivityPause(req)) {
      await regenerateAnonymousSessionPreservingSiteAccess(req);
    }
    res.status(403).json({
      error: "This record is scheduled for deletion and is no longer available. Please speak to your teacher or School Admin during the recovery period.",
      code: STUDENT_RECOVERY_ERROR_CODE,
    });
    return;
  }

  if (!session.organisationActive) {
    await closeStudentActivity(req, "organisation_suspended");
    req.session.destroy(() => {});
    res.status(403).json({ error: "This school is currently suspended. Please contact your teacher or school administrator." });
    return;
  }

  // Single-session enforcement: the session nonce must match the authenticated
  // browser session. A mismatch means someone else joined with the same PIN.
  if (session.sessionNonce) {
    const clientNonce = req.session.studentNonce;

    if (clientNonce !== session.sessionNonce) {
      await closeStudentActivity(req, "replaced");
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
