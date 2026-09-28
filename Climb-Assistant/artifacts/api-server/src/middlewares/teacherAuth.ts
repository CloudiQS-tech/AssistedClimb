import type { Request, Response, NextFunction } from "express";
import { db, organisationsTable, teachersTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { isEmailVerificationBypassed } from "../lib/email-verification-policy";

export async function requireTeacher(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Primary: session cookie
  const teacherId = req.session.teacherId;
  if (teacherId) {
    const [result] = await db
      .select({
        teacher: teachersTable,
        organisationActive: organisationsTable.active,
      })
      .from(teachersTable)
      .leftJoin(organisationsTable, eq(teachersTable.organisationId, organisationsTable.id))
      .where(and(
        eq(teachersTable.id, teacherId),
        isNull(organisationsTable.deletedAt),
      ));
    const teacher = result?.teacher;

    if (teacher && teacher.accountStatus !== "active") {
      req.session.destroy(() => {});
      res.status(403).json({
        error: teacher.accountStatus === "suspended"
          ? "This teacher account is suspended. Contact your school administrator."
          : "This teacher account is no longer available.",
      });
      return;
    }

    if (teacher && teacher.approvalStatus !== "approved") {
      req.session.destroy(() => {});
      res.status(403).json({
        error: teacher.approvalStatus === "pending"
          ? "Your teacher account is awaiting approval from a school administrator."
          : "Your teacher account registration was not approved. Please contact your school administrator.",
        approvalStatus: teacher.approvalStatus,
      });
      return;
    }

    if (teacher && teacher.organisationId && !result?.organisationActive) {
      req.session.destroy(() => {});
      res.status(403).json({
        error: "This school is currently suspended. Contact your school administrator.",
      });
      return;
    }

    if (teacher && !teacher.emailVerified && !isEmailVerificationBypassed()) {
      res.status(403).json({
        error: "Verify your school email address before accessing teacher features.",
        emailVerificationRequired: true,
      });
      return;
    }

    if (teacher?.totpEnabled && teacher.totpSecret && !teacher.mustChangePassword) {
      req.teacher = teacher;
      next();
      return;
    }

    if (teacher?.mustChangePassword) {
      res.status(403).json({
        error: "You must set a new password before accessing teacher features.",
        mustChangePassword: true,
      });
      return;
    }

    req.session.destroy(() => {});
  }

  res.status(401).json({ error: "Sign in and complete authenticator setup to continue." });
}
