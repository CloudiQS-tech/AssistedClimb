import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  auditLogTable,
  classesTable,
  db,
  organisationsTable,
  safeguardingReviewItemsTable,
  studentSessionsTable,
  teachersTable,
} from "@workspace/db";
import { requireTeacher } from "../../middlewares/teacherAuth";

const router = Router();
const SAFEGUARDING_STATUSES = ["new", "under_review", "closed"] as const;
const SAFEGUARDING_REVIEWER_CONFIRMATION =
  "I confirm that this member of staff is authorised by the school to review safeguarding concerns within e-Assisted Climb.";
const safeguardingReviewerPermissionBody = z.object({
  canReviewSafeguarding: z.boolean(),
  confirmation: z.string().max(180).optional(),
}).strict();
const safeguardingReviewListQuery = z.object({
  status: z.enum(["all", ...SAFEGUARDING_STATUSES]).default("all"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
const safeguardingReviewUpdateBody = z.object({
  status: z.enum(SAFEGUARDING_STATUSES).optional(),
  actionTaken: z.string().max(2_000).optional(),
  decision: z.string().max(500).optional(),
  rationale: z.string().max(3_000).optional(),
  outcome: z.string().max(2_000).optional(),
  externalReference: z.string().max(250).optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

function requireSafeguardingSameOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get("origin");
  const host = req.get("x-forwarded-host") ?? req.get("host");
  try {
    if (!origin || !host || new URL(origin).host !== host) throw new Error("untrusted origin");
  } catch {
    res.status(403).json({ error: "This request must come from the school application." });
    return;
  }
  next();
}

function requireSchoolMaster(req: Request, res: Response, next: NextFunction): void {
  if (!req.teacher?.isItAdmin || req.teacher.schoolAdminRole !== "master") {
    res.status(403).json({ error: "School Admin access required." });
    return;
  }
  next();
}

async function lockActiveSafeguardingReviewer(tx: any, teacherId: number) {
  const [reviewer] = await tx
    .select({
      id: teachersTable.id,
      organisationId: teachersTable.organisationId,
    })
    .from(teachersTable)
    .innerJoin(organisationsTable, eq(teachersTable.organisationId, organisationsTable.id))
    .where(and(
      eq(teachersTable.id, teacherId),
      eq(teachersTable.canReviewSafeguarding, true),
      eq(teachersTable.accountStatus, "active"),
      eq(teachersTable.approvalStatus, "approved"),
      isNull(organisationsTable.deletedAt),
    ))
    .for("update");
  return reviewer ?? null;
}

async function requireSafeguardingReviewer(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.teacher) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  const [reviewer] = await db
    .select({ id: teachersTable.id })
    .from(teachersTable)
    .innerJoin(organisationsTable, eq(teachersTable.organisationId, organisationsTable.id))
    .where(and(
      eq(teachersTable.id, req.teacher.id),
      eq(teachersTable.canReviewSafeguarding, true),
      eq(teachersTable.accountStatus, "active"),
      eq(teachersTable.approvalStatus, "approved"),
      isNull(organisationsTable.deletedAt),
    ));
  if (!reviewer) {
    res.status(403).json({ error: "Safeguarding Reviewer permission required." });
    return;
  }
  next();
}

function safeguardingCaseReference(id: number): string {
  return `SGR-${String(id).padStart(8, "0")}`;
}

function safeguardingSourceLocation(sourceType: string, stage: string | null): string {
  return sourceType === "climb" ? `Climb stage${stage ? ` ${stage}` : ""}` : "Student AI message";
}

function safeSafeguardingAuditMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const metadata = value as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const key of ["fromStatus", "toStatus", "sourceType", "stage", "view"]) {
    if (typeof metadata[key] === "string" && metadata[key].length <= 80) safe[key] = metadata[key];
  }
  if (Array.isArray(metadata.updatedFields)) {
    safe.updatedFields = metadata.updatedFields
      .filter((field): field is string => typeof field === "string" && [
        "status", "actionTaken", "decision", "rationale", "outcome", "externalReference",
      ].includes(field));
  }
  return safe;
}

async function loadSafeguardingReviewDetail(
  tx: any,
  organisationId: number,
  itemId: number,
  actorId: number,
  ipAddress: string | undefined,
) {
  const [item] = await tx
    .select({
      id: safeguardingReviewItemsTable.id,
      organisationId: safeguardingReviewItemsTable.organisationId,
      sourceType: safeguardingReviewItemsTable.sourceType,
      stage: safeguardingReviewItemsTable.stage,
      category: safeguardingReviewItemsTable.category,
      technicalReason: safeguardingReviewItemsTable.technicalReason,
      excerpt: safeguardingReviewItemsTable.excerpt,
      surroundingContext: safeguardingReviewItemsTable.surroundingContext,
      detectedBy: safeguardingReviewItemsTable.detectedBy,
      providerSignals: safeguardingReviewItemsTable.providerSignals,
      status: safeguardingReviewItemsTable.status,
      reviewerId: safeguardingReviewItemsTable.reviewerId,
      reviewerName: teachersTable.name,
      reviewerEmail: teachersTable.email,
      reviewedAt: safeguardingReviewItemsTable.reviewedAt,
      actionTaken: safeguardingReviewItemsTable.actionTaken,
      decision: safeguardingReviewItemsTable.decision,
      rationale: safeguardingReviewItemsTable.rationale,
      outcome: safeguardingReviewItemsTable.outcome,
      externalReference: safeguardingReviewItemsTable.externalReference,
      notificationStatus: safeguardingReviewItemsTable.notificationStatus,
      createdAt: safeguardingReviewItemsTable.createdAt,
      updatedAt: safeguardingReviewItemsTable.updatedAt,
      closedAt: safeguardingReviewItemsTable.closedAt,
      schoolName: organisationsTable.name,
      studentName: studentSessionsTable.studentName,
      className: classesTable.name,
    })
    .from(safeguardingReviewItemsTable)
    .innerJoin(organisationsTable, eq(safeguardingReviewItemsTable.organisationId, organisationsTable.id))
    .innerJoin(studentSessionsTable, eq(safeguardingReviewItemsTable.studentSessionId, studentSessionsTable.id))
    .innerJoin(classesTable, eq(safeguardingReviewItemsTable.classId, classesTable.id))
    .leftJoin(teachersTable, eq(safeguardingReviewItemsTable.reviewerId, teachersTable.id))
    .where(and(
      eq(safeguardingReviewItemsTable.id, itemId),
      eq(safeguardingReviewItemsTable.organisationId, organisationId),
    ));
  if (!item) return null;

  await tx.insert(auditLogTable).values({
    organisationId,
    teacherId: actorId,
    action: "safeguarding.review_item.accessed",
    metadata: { reviewItemId: itemId, view: "detail" },
    ipAddress: ipAddress ?? null,
  });

  const history = await tx
    .select({
      id: auditLogTable.id,
      action: auditLogTable.action,
      createdAt: auditLogTable.createdAt,
      actorName: teachersTable.name,
      metadata: auditLogTable.metadata,
    })
    .from(auditLogTable)
    .leftJoin(teachersTable, eq(auditLogTable.teacherId, teachersTable.id))
    .where(and(
      eq(auditLogTable.organisationId, organisationId),
      sql`${auditLogTable.action} LIKE 'safeguarding.review_item.%'`,
      sql`${auditLogTable.metadata}->>'reviewItemId' = ${String(itemId)}`,
    ))
    .orderBy(desc(auditLogTable.createdAt));

  const { organisationId: _organisationId, sourceType, stage, studentName, className, ...details } = item;
  return {
    ...details,
    caseReference: safeguardingCaseReference(item.id),
    sourceType,
    sourceLocation: safeguardingSourceLocation(sourceType, stage),
    studentName,
    className,
    auditHistory: history.map((event: any) => ({
      id: event.id,
      action: event.action,
      createdAt: event.createdAt,
      actorName: event.actorName,
      metadata: safeSafeguardingAuditMetadata(event.metadata),
    })),
  };
}

router.put(
  "/teacher/org/teacher/:id/safeguarding-reviewer",
  requireTeacher,
  requireSchoolMaster,
  requireSafeguardingSameOrigin,
  async (req, res): Promise<void> => {
    const targetId = Number(String(req.params.id));
    if (!Number.isInteger(targetId) || targetId <= 0) {
      res.status(400).json({ error: "A valid teacher ID is required." });
      return;
    }
    const parsed = safeguardingReviewerPermissionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "A valid safeguarding permission change is required." });
      return;
    }
    const { canReviewSafeguarding, confirmation } = parsed.data;
    if (canReviewSafeguarding && confirmation !== SAFEGUARDING_REVIEWER_CONFIRMATION) {
      res.status(400).json({ error: "The school authorization confirmation must match exactly." });
      return;
    }

    const result = await db.transaction(async (tx) => {
      const [actor] = await tx
        .select({
          id: teachersTable.id,
          organisationId: teachersTable.organisationId,
          isItAdmin: teachersTable.isItAdmin,
          schoolAdminRole: teachersTable.schoolAdminRole,
        })
        .from(teachersTable)
        .where(eq(teachersTable.id, req.teacher!.id))
        .for("update");
      if (!actor?.organisationId || !actor.isItAdmin || actor.schoolAdminRole !== "master") {
        return { status: 403 as const };
      }
      const [target] = await tx
        .select({
          id: teachersTable.id,
          canReviewSafeguarding: teachersTable.canReviewSafeguarding,
          accountStatus: teachersTable.accountStatus,
          approvalStatus: teachersTable.approvalStatus,
        })
        .from(teachersTable)
        .where(and(
          eq(teachersTable.id, targetId),
          eq(teachersTable.organisationId, actor.organisationId),
        ))
        .for("update");
      if (!target) return { status: 404 as const };
      if (canReviewSafeguarding && (target.accountStatus !== "active" || target.approvalStatus !== "approved")) {
        return { status: 400 as const };
      }
      if (target.canReviewSafeguarding === canReviewSafeguarding) {
        return { status: 200 as const };
      }

      await tx
        .update(teachersTable)
        .set({ canReviewSafeguarding })
        .where(eq(teachersTable.id, target.id));
      await tx.insert(auditLogTable).values({
        organisationId: actor.organisationId,
        teacherId: actor.id,
        action: canReviewSafeguarding
          ? "safeguarding.reviewer_permission_assigned"
          : "safeguarding.reviewer_permission_removed",
        metadata: {
          targetTeacherId: target.id,
          ...(canReviewSafeguarding ? { confirmation: SAFEGUARDING_REVIEWER_CONFIRMATION } : {}),
        },
        ipAddress: req.ip,
      });
      return { status: 200 as const };
    });

    if (result.status === 404) {
      res.status(404).json({ error: "Teacher not found in the current school." });
      return;
    }
    if (result.status === 403) {
      res.status(403).json({ error: "School Admin access required." });
      return;
    }
    if (result.status === 400) {
      res.status(400).json({ error: "Only an active, approved teacher can be assigned as a reviewer." });
      return;
    }
    res.set("Cache-Control", "no-store").json({ id: targetId, canReviewSafeguarding });
  },
);

const SAFEGUARDING_REVIEW_PAGE_SIZE = 20;

router.get(
  "/teacher/safeguarding/items",
  requireTeacher,
  requireSafeguardingReviewer,
  async (req, res): Promise<void> => {
    const parsed = safeguardingReviewListQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Use a valid status and page number." });
      return;
    }
    const { status, page } = parsed.data;
    const result = await db.transaction(async (tx) => {
      const reviewer = await lockActiveSafeguardingReviewer(tx, req.teacher!.id);
      if (!reviewer?.organisationId) return null;
      const conditions = [
        eq(safeguardingReviewItemsTable.organisationId, reviewer.organisationId),
        status !== "all" ? eq(safeguardingReviewItemsTable.status, status) : undefined,
      ].filter(Boolean);
      const where = and(...conditions);
      const [rows, countRows] = await Promise.all([
        tx
          .select({
            id: safeguardingReviewItemsTable.id,
            category: safeguardingReviewItemsTable.category,
            technicalReason: safeguardingReviewItemsTable.technicalReason,
            status: safeguardingReviewItemsTable.status,
            sourceType: safeguardingReviewItemsTable.sourceType,
            stage: safeguardingReviewItemsTable.stage,
            createdAt: safeguardingReviewItemsTable.createdAt,
            studentName: studentSessionsTable.studentName,
            className: classesTable.name,
            reviewerName: teachersTable.name,
          })
          .from(safeguardingReviewItemsTable)
          .innerJoin(studentSessionsTable, eq(safeguardingReviewItemsTable.studentSessionId, studentSessionsTable.id))
          .innerJoin(classesTable, eq(safeguardingReviewItemsTable.classId, classesTable.id))
          .leftJoin(teachersTable, eq(safeguardingReviewItemsTable.reviewerId, teachersTable.id))
          .where(where)
          .orderBy(desc(safeguardingReviewItemsTable.createdAt), desc(safeguardingReviewItemsTable.id))
          .limit(SAFEGUARDING_REVIEW_PAGE_SIZE)
          .offset((page - 1) * SAFEGUARDING_REVIEW_PAGE_SIZE),
        tx
          .select({ total: sql<number>`count(*)::int` })
          .from(safeguardingReviewItemsTable)
          .where(where),
      ]);
      if (rows.length > 0) {
        await tx.insert(auditLogTable).values(rows.map((row: any) => ({
          organisationId: reviewer.organisationId,
          teacherId: reviewer.id,
          action: "safeguarding.review_item.accessed",
          metadata: { reviewItemId: row.id, view: "list" },
          ipAddress: req.ip ?? null,
        })));
      }
      return { rows, total: Number(countRows[0]?.total ?? 0) };
    });
    if (!result) {
      res.status(403).json({ error: "Safeguarding Reviewer permission required." });
      return;
    }

    res.set("Cache-Control", "no-store").json({
      items: result.rows.map((row: any) => ({
        id: row.id,
        caseReference: safeguardingCaseReference(row.id),
        category: row.category,
        technicalReason: row.technicalReason,
        status: row.status,
        sourceType: row.sourceType,
        sourceLocation: safeguardingSourceLocation(row.sourceType, row.stage),
        studentName: row.studentName,
        className: row.className,
        createdAt: row.createdAt,
        reviewerName: row.reviewerName,
      })),
      total: result.total,
      page,
      pageSize: SAFEGUARDING_REVIEW_PAGE_SIZE,
      totalPages: Math.max(1, Math.ceil(result.total / SAFEGUARDING_REVIEW_PAGE_SIZE)),
    });
  },
);

router.get(
  "/teacher/safeguarding/items/:id",
  requireTeacher,
  requireSafeguardingReviewer,
  async (req, res): Promise<void> => {
    const itemId = Number(String(req.params.id));
    if (!Number.isInteger(itemId) || itemId <= 0) {
      res.status(404).json({ error: "Review item not found." });
      return;
    }
    const detail = await db.transaction(async (tx) => {
      const reviewer = await lockActiveSafeguardingReviewer(tx, req.teacher!.id);
      if (!reviewer?.organisationId) return null;
      return loadSafeguardingReviewDetail(tx, reviewer.organisationId, itemId, reviewer.id, req.ip);
    });
    if (!detail) {
      res.status(404).json({ error: "Review item not found in the current school." });
      return;
    }
    res.set("Cache-Control", "no-store").json({ item: detail });
  },
);

router.patch(
  "/teacher/safeguarding/items/:id",
  requireTeacher,
  requireSafeguardingReviewer,
  requireSafeguardingSameOrigin,
  async (req, res): Promise<void> => {
    const itemId = Number(String(req.params.id));
    if (!Number.isInteger(itemId) || itemId <= 0) {
      res.status(404).json({ error: "Review item not found." });
      return;
    }
    const parsed = safeguardingReviewUpdateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Review fields are invalid." });
      return;
    }
    const updateResult = await db.transaction(async (tx) => {
      const reviewer = await lockActiveSafeguardingReviewer(tx, req.teacher!.id);
      if (!reviewer?.organisationId) return { status: 403 as const };
      const [current] = await tx
        .select({
          id: safeguardingReviewItemsTable.id,
          status: safeguardingReviewItemsTable.status,
        })
        .from(safeguardingReviewItemsTable)
        .where(and(
          eq(safeguardingReviewItemsTable.id, itemId),
          eq(safeguardingReviewItemsTable.organisationId, reviewer.organisationId),
        ))
        .for("update");
      if (!current) return { status: 404 as const };

      const now = new Date();
      const body = parsed.data;
      const changes: Partial<typeof safeguardingReviewItemsTable.$inferInsert> = {
        reviewerId: reviewer.id,
        reviewedAt: now,
        updatedAt: now,
      };
      const updatedFields: string[] = [];
      for (const field of ["status", "actionTaken", "decision", "rationale", "outcome", "externalReference"] as const) {
        if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
        changes[field] = body[field] as never;
        updatedFields.push(field);
      }
      if (body.status === "closed" && current.status !== "closed") changes.closedAt = now;
      else if (body.status && body.status !== "closed") changes.closedAt = null;

      await tx
        .update(safeguardingReviewItemsTable)
        .set(changes)
        .where(eq(safeguardingReviewItemsTable.id, current.id));

      if (body.status && body.status !== current.status) {
        await tx.insert(auditLogTable).values({
          organisationId: reviewer.organisationId,
          teacherId: reviewer.id,
          action: "safeguarding.review_item.status_changed",
          metadata: { reviewItemId: itemId, fromStatus: current.status, toStatus: body.status },
          ipAddress: req.ip,
        });
        if (body.status === "closed") {
          await tx.insert(auditLogTable).values({
            organisationId: reviewer.organisationId,
            teacherId: reviewer.id,
            action: "safeguarding.review_item.closed",
            metadata: { reviewItemId: itemId },
            ipAddress: req.ip,
          });
        }
      }
      const detailFields = updatedFields.filter((field) => field !== "status");
      if (detailFields.length > 0) {
        await tx.insert(auditLogTable).values({
          organisationId: reviewer.organisationId,
          teacherId: reviewer.id,
          action: "safeguarding.review_item.fields_updated",
          metadata: { reviewItemId: itemId, updatedFields: detailFields },
          ipAddress: req.ip,
        });
      }
      if (Object.prototype.hasOwnProperty.call(body, "actionTaken")) {
        await tx.insert(auditLogTable).values({
          organisationId: reviewer.organisationId,
          teacherId: reviewer.id,
          action: "safeguarding.review_item.action_recorded",
          metadata: { reviewItemId: itemId },
          ipAddress: req.ip,
        });
      }
      if (Object.prototype.hasOwnProperty.call(body, "outcome")) {
        await tx.insert(auditLogTable).values({
          organisationId: reviewer.organisationId,
          teacherId: reviewer.id,
          action: "safeguarding.review_item.outcome_recorded",
          metadata: { reviewItemId: itemId },
          ipAddress: req.ip,
        });
      }

      const item = await loadSafeguardingReviewDetail(
        tx,
        reviewer.organisationId,
        itemId,
        reviewer.id,
        req.ip,
      );
      return item ? { status: 200 as const, item } : { status: 404 as const };
    });
    if (updateResult.status === 403) {
      res.status(403).json({ error: "Safeguarding Reviewer permission required." });
      return;
    }
    if (updateResult.status === 404 || !updateResult.item) {
      res.status(404).json({ error: "Review item not found in the current school." });
      return;
    }
    res.set("Cache-Control", "no-store").json({ item: updateResult.item });
  },
);

export default router;