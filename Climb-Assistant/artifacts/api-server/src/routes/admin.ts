import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { randomBytes } from "crypto";
import { and, eq, max, sql } from "drizzle-orm";
import { db, organisationsTable, teachersTable, classesTable, studentSessionsTable, stageEntriesTable } from "@workspace/db";
import { encrypt, maskApiKey } from "../lib/crypto";
import { z } from "zod/v4";

function generateTempPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

const router: IRouter = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.PLATFORM_ADMIN_SECRET;
  if (!secret || req.headers["x-admin-secret"] !== secret) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

function generateInviteCode(): string {
  return randomBytes(4).toString("hex").toUpperCase();
}

const CreateOrgBody = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers, and hyphens only"),
  itAdminEmail: z.string().email(),
  itAdminPassword: z.string().min(8),
  itAdminName: z.string().min(1),
});

router.post("/admin/organisations", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateOrgBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, slug, itAdminEmail, itAdminPassword, itAdminName } = parsed.data;

  const [existing] = await db
    .select({ id: organisationsTable.id })
    .from(organisationsTable)
    .where(eq(organisationsTable.slug, slug));

  if (existing) {
    res.status(409).json({ error: "Slug already in use" });
    return;
  }

  const [existingEmail] = await db
    .select({ id: teachersTable.id })
    .from(teachersTable)
    .where(eq(teachersTable.email, itAdminEmail.toLowerCase()));

  if (existingEmail) {
    res.status(409).json({ error: "IT admin email already in use" });
    return;
  }

  const teacherInviteCode = generateInviteCode();

  const [org] = await db
    .insert(organisationsTable)
    .values({ name, slug, active: true, teacherInviteCode })
    .returning();

  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.hash(itAdminPassword, 12);

  const [itAdmin] = await db
    .insert(teachersTable)
    .values({
      organisationId: org.id,
      email: itAdminEmail.toLowerCase(),
      passwordHash,
      name: itAdminName,
      isItAdmin: true,
    })
    .returning({ id: teachersTable.id, email: teachersTable.email, name: teachersTable.name });

  res.status(201).json({
    organisation: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      active: org.active,
      teacherInviteCode: org.teacherInviteCode,
      createdAt: org.createdAt,
    },
    itAdmin: { id: itAdmin.id, email: itAdmin.email, name: itAdmin.name },
  });
});

router.get("/admin/organisations", requireAdmin, async (req, res): Promise<void> => {
  const orgs = await db.select().from(organisationsTable).orderBy(organisationsTable.createdAt);

  const orgsWithStats = await Promise.all(
    orgs.map(async (org) => {
      const [teacherRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(teachersTable)
        .where(eq(teachersTable.organisationId, org.id));

      const [itAdmin] = await db
        .select({ id: teachersTable.id, name: teachersTable.name, email: teachersTable.email })
        .from(teachersTable)
        .where(and(eq(teachersTable.organisationId, org.id), eq(teachersTable.isItAdmin, true)));

      // Classes created across all teachers in this org
      const [classRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(classesTable)
        .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
        .where(eq(teachersTable.organisationId, org.id));

      // Students joined + last activity across all classes in this org
      const [studentRow] = await db
        .select({
          count: sql<number>`count(*)::int`,
          lastActive: max(studentSessionsTable.createdAt),
        })
        .from(studentSessionsTable)
        .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
        .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
        .where(eq(teachersTable.organisationId, org.id));

      // Climbs started = distinct student sessions with at least one stage entry
      const [climbRow] = await db
        .select({ count: sql<number>`count(distinct ${stageEntriesTable.sessionId})::int` })
        .from(stageEntriesTable)
        .innerJoin(studentSessionsTable, eq(stageEntriesTable.sessionId, studentSessionsTable.id))
        .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
        .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
        .where(eq(teachersTable.organisationId, org.id));

      return {
        id: org.id,
        name: org.name,
        slug: org.slug,
        active: org.active,
        teacherInviteCode: org.teacherInviteCode,
        aiConfigured: !!org.aiKeyEncrypted,
        aiProvider: org.aiProvider,
        allowedEmailDomains: org.allowedEmailDomains ?? [],
        teacherCount: teacherRow?.count ?? 0,
        classCount: classRow?.count ?? 0,
        studentCount: studentRow?.count ?? 0,
        climbsStarted: climbRow?.count ?? 0,
        lastActiveAt: studentRow?.lastActive ?? null,
        createdAt: org.createdAt,
        itAdmin: itAdmin ?? null,
      };
    }),
  );

  res.json(orgsWithStats);
});

router.patch("/admin/organisations/:id/active", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid organisation ID" });
    return;
  }

  const { active } = req.body ?? {};
  if (typeof active !== "boolean") {
    res.status(400).json({ error: "active (boolean) required" });
    return;
  }

  const [org] = await db
    .update(organisationsTable)
    .set({ active })
    .where(eq(organisationsTable.id, id))
    .returning({ id: organisationsTable.id, name: organisationsTable.name, active: organisationsTable.active });

  if (!org) {
    res.status(404).json({ error: "Organisation not found" });
    return;
  }

  res.json(org);
});

router.get("/admin/organisations/:id/invite-code", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid organisation ID" });
    return;
  }

  const [org] = await db
    .select({ id: organisationsTable.id, name: organisationsTable.name, teacherInviteCode: organisationsTable.teacherInviteCode })
    .from(organisationsTable)
    .where(eq(organisationsTable.id, id));

  if (!org) {
    res.status(404).json({ error: "Organisation not found" });
    return;
  }

  res.json({ id: org.id, name: org.name, teacherInviteCode: org.teacherInviteCode });
});

const UpdateOrgAiBody = z.object({
  aiProvider: z.enum(["gemini", "azure"]),
  aiKey: z.string().min(1),
  azureEndpoint: z.string().optional(),
});

router.put("/admin/organisations/:id/ai-settings", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid organisation ID" });
    return;
  }

  const parsed = UpdateOrgAiBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { aiProvider, aiKey, azureEndpoint } = parsed.data;

  if (aiProvider === "azure" && !azureEndpoint) {
    res.status(400).json({ error: "azureEndpoint required for Azure provider" });
    return;
  }

  const encrypted = encrypt(aiKey);

  const [org] = await db
    .update(organisationsTable)
    .set({
      aiProvider,
      aiKeyEncrypted: encrypted,
      azureEndpoint: azureEndpoint ?? null,
    })
    .where(eq(organisationsTable.id, id))
    .returning({ id: organisationsTable.id, name: organisationsTable.name, aiProvider: organisationsTable.aiProvider });

  if (!org) {
    res.status(404).json({ error: "Organisation not found" });
    return;
  }

  res.json({ id: org.id, name: org.name, aiProvider: org.aiProvider, aiKeyMasked: maskApiKey(aiKey) });
});

const CreateItAdminBody = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

router.post("/admin/organisations/:id/it-admin", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid organisation ID" });
    return;
  }

  const [org] = await db
    .select({ id: organisationsTable.id, name: organisationsTable.name })
    .from(organisationsTable)
    .where(eq(organisationsTable.id, id));

  if (!org) {
    res.status(404).json({ error: "Organisation not found" });
    return;
  }

  const parsed = CreateItAdminBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, email, password } = parsed.data;

  const [existing] = await db
    .select({ id: teachersTable.id })
    .from(teachersTable)
    .where(eq(teachersTable.email, email.toLowerCase()));

  if (existing) {
    res.status(409).json({ error: "A teacher with that email already exists" });
    return;
  }

  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.hash(password, 12);

  const [created] = await db
    .insert(teachersTable)
    .values({
      organisationId: id,
      email: email.toLowerCase(),
      passwordHash,
      name,
      isItAdmin: true,
      mustChangePassword: true,
    })
    .returning({ id: teachersTable.id, name: teachersTable.name, email: teachersTable.email });

  res.status(201).json({ ok: true, teacher: created });
});

router.get("/admin/organisations/:id/teachers", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid organisation ID" });
    return;
  }

  const teachers = await db
    .select({
      id: teachersTable.id,
      name: teachersTable.name,
      email: teachersTable.email,
      isItAdmin: teachersTable.isItAdmin,
      createdAt: teachersTable.createdAt,
    })
    .from(teachersTable)
    .where(eq(teachersTable.organisationId, id))
    .orderBy(teachersTable.createdAt);

  res.json(teachers);
});

// ── Change admin secret ───────────────────────────────────────────────────────

const ChangeAdminSecretBody = z.object({
  currentSecret: z.string().min(1),
  newSecret: z.string().min(8, "New secret must be at least 8 characters"),
});

router.post("/admin/change-secret", requireAdmin, async (req, res): Promise<void> => {
  const parsed = ChangeAdminSecretBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { currentSecret, newSecret } = parsed.data;
  const envSecret = process.env.PLATFORM_ADMIN_SECRET;

  if (currentSecret !== envSecret) {
    res.status(401).json({ error: "Current secret is incorrect" });
    return;
  }

  // Update the environment variable at runtime
  process.env.PLATFORM_ADMIN_SECRET = newSecret;

  res.json({ ok: true, message: "Admin secret updated. Note: this change persists only until the server restarts. Update the environment variable for permanent changes." });
});

// ── Verify recovery key (forgot password flow) ───────────────────────────────

router.post("/admin/verify-recovery-key", async (req, res): Promise<void> => {
  const { recoveryKey } = req.body ?? {};
  if (!recoveryKey || typeof recoveryKey !== "string") {
    res.status(400).json({ error: "Recovery key is required" });
    return;
  }

  // The recovery key is the SESSION_SECRET — a separate env var that serves as
  // a backup credential the platform owner keeps safe.
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    res.status(503).json({ error: "Recovery is not configured on this server" });
    return;
  }

  if (recoveryKey !== sessionSecret) {
    res.status(401).json({ error: "Invalid recovery key" });
    return;
  }

  // Key is valid — return the current admin secret so they can log in
  const adminSecret = process.env.PLATFORM_ADMIN_SECRET;
  res.json({ ok: true, adminSecret });
});

router.post("/admin/teachers/:teacherId/reset-password", requireAdmin, async (req, res): Promise<void> => {
  const teacherId = Number(req.params.teacherId);
  if (isNaN(teacherId)) {
    res.status(400).json({ error: "Invalid teacher ID" });
    return;
  }

  const [teacher] = await db
    .select({ id: teachersTable.id, email: teachersTable.email, name: teachersTable.name, organisationId: teachersTable.organisationId })
    .from(teachersTable)
    .where(eq(teachersTable.id, teacherId));

  if (!teacher) {
    res.status(404).json({ error: "Teacher not found" });
    return;
  }

  const tempPassword = generateTempPassword();
  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.hash(tempPassword, 12);

  await db
    .update(teachersTable)
    .set({
      passwordHash,
      mustChangePassword: true,
      failedLoginAttempts: 0,
      lockedUntil: null,
      passwordResetToken: null,
      passwordResetExpiresAt: null,
    })
    .where(eq(teachersTable.id, teacherId));

  res.json({
    ok: true,
    teacherEmail: teacher.email,
    teacherName: teacher.name,
    tempPassword,
  });
});

export default router;
