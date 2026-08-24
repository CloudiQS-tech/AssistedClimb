import { db, auditLogTable } from "@workspace/db";

export async function logAudit(opts: {
  organisationId?: number | null;
  teacherId?: number | null;
  action: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}): Promise<void> {
  try {
    await db.insert(auditLogTable).values({
      organisationId: opts.organisationId ?? null,
      teacherId: opts.teacherId ?? null,
      action: opts.action,
      metadata: opts.metadata ?? {},
      ipAddress: opts.ipAddress ?? null,
    });
  } catch {
    // audit failures must never break the main request
  }
}
