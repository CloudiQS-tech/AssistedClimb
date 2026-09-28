import { and, eq, gte, sql } from "drizzle-orm";
import { auditLogTable, db } from "@workspace/db";

export const TASK_RESEARCH_WINDOW_MS = 15 * 60 * 1000;
export const TASK_RESEARCH_LIMIT = 10;
const TASK_RESEARCH_ADVISORY_LOCK_KEY = 153;

export type TaskResearchAdmissionInput = {
  teacherId: number;
  organisationId: number | null;
  classId: number;
  ipAddress: string | null;
};

export async function admitTaskResearchRequest({
  teacherId,
  organisationId,
  classId,
  ipAddress,
}: TaskResearchAdmissionInput): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${teacherId}, ${TASK_RESEARCH_ADVISORY_LOCK_KEY})`);
    const windowStart = new Date(Date.now() - TASK_RESEARCH_WINDOW_MS);
    const [usage] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLogTable)
      .where(and(
        eq(auditLogTable.teacherId, teacherId),
        eq(auditLogTable.action, "class_task_research_requested"),
        gte(auditLogTable.createdAt, windowStart),
      ));

    if ((usage?.count ?? 0) >= TASK_RESEARCH_LIMIT) return false;

    await tx.insert(auditLogTable).values({
      organisationId,
      teacherId,
      action: "class_task_research_requested",
      metadata: { classId },
      ipAddress,
    });
    return true;
  });
}