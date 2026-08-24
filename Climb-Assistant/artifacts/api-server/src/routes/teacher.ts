import { Router } from "express";
import { db } from "@workspace/db";
import {
  classesTable,
  studentSessionsTable,
  stageEntriesTable,
  chatMessagesTable,
} from "@workspace/db";
import { eq, desc, count, inArray } from "drizzle-orm";
import { requireTeacher } from "../middleware/requireTeacher";

const router = Router();

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function uniqueCode(): Promise<string> {
  let code = generateCode();
  for (let attempt = 0; attempt < 10; attempt++) {
    const existing = await db
      .select()
      .from(classesTable)
      .where(eq(classesTable.code, code))
      .limit(1);
    if (existing.length === 0) return code;
    code = generateCode();
  }
  throw new Error("Could not generate a unique class code");
}

router.get("/teacher/classes", requireTeacher, async (req, res) => {
  const teacherId = req.session.teacherId!;
  const classes = await db
    .select({
      id: classesTable.id,
      name: classesTable.name,
      subject: classesTable.subject,
      code: classesTable.code,
      createdAt: classesTable.createdAt,
      studentCount: count(studentSessionsTable.id),
    })
    .from(classesTable)
    .leftJoin(
      studentSessionsTable,
      eq(studentSessionsTable.classId, classesTable.id),
    )
    .where(eq(classesTable.teacherId, teacherId))
    .groupBy(classesTable.id)
    .orderBy(desc(classesTable.createdAt));

  res.json(classes);
});

router.post("/teacher/classes", requireTeacher, async (req, res) => {
  const teacherId = req.session.teacherId!;
  const { name, subject } = req.body;
  if (!name) {
    res.status(400).json({ error: "Class name is required" });
    return;
  }

  const code = await uniqueCode();
  const [cls] = await db
    .insert(classesTable)
    .values({ teacherId, name, subject: subject ?? null, code })
    .returning();

  res.status(201).json(cls);
});

router.get("/teacher/classes/:classId", requireTeacher, async (req, res) => {
  const teacherId = req.session.teacherId!;
  const classId = parseInt(String(req.params.classId), 10);

  const [cls] = await db
    .select()
    .from(classesTable)
    .where(eq(classesTable.id, classId))
    .limit(1);

  if (!cls || cls.teacherId !== teacherId) {
    res.status(404).json({ error: "Class not found" });
    return;
  }

  res.json(cls);
});

router.get("/teacher/classes/:classId/students", requireTeacher, async (req, res) => {
  const teacherId = req.session.teacherId!;
  const classId = parseInt(String(req.params.classId), 10);

  const [cls] = await db
    .select()
    .from(classesTable)
    .where(eq(classesTable.id, classId))
    .limit(1);

  if (!cls || cls.teacherId !== teacherId) {
    res.status(404).json({ error: "Class not found" });
    return;
  }

  const sessions = await db
    .select()
    .from(studentSessionsTable)
    .where(eq(studentSessionsTable.classId, classId))
    .orderBy(desc(studentSessionsTable.createdAt));

  const sessionIds = sessions.map((s) => s.id);

  const allEntries =
    sessionIds.length > 0
      ? await db
          .select()
          .from(stageEntriesTable)
          .where(
            sessionIds.length === 1
              ? eq(stageEntriesTable.sessionId, sessionIds[0])
              : inArray(stageEntriesTable.sessionId, sessionIds),
          )
      : [];

  const entriesBySession: Record<number, typeof allEntries> = {};
  for (const entry of allEntries) {
    if (!entriesBySession[entry.sessionId]) {
      entriesBySession[entry.sessionId] = [];
    }
    entriesBySession[entry.sessionId].push(entry);
  }

  const stageOrder = ["MAP", "TORCH", "COMPASS", "EMBED"];

  const result = sessions.map((session) => {
    const entries = entriesBySession[session.id] ?? [];
    const completedStages = entries.map((e) => e.stage);
    const furthestStageIndex = Math.max(
      -1,
      ...completedStages.map((s) => stageOrder.indexOf(s)),
    );
    const currentStage =
      furthestStageIndex >= 0 ? stageOrder[furthestStageIndex] : null;
    const progress = Math.round(((furthestStageIndex + 1) / 4) * 100);

    return {
      ...session,
      currentStage,
      progress,
      stagesCompleted: completedStages,
    };
  });

  res.json(result);
});

router.get("/teacher/classes/:classId/students/:sessionId", requireTeacher, async (req, res) => {
  const teacherId = req.session.teacherId!;
  const classId = parseInt(String(req.params.classId), 10);
  const sessionId = parseInt(String(req.params.sessionId), 10);

  const [cls] = await db
    .select()
    .from(classesTable)
    .where(eq(classesTable.id, classId))
    .limit(1);

  if (!cls || cls.teacherId !== teacherId) {
    res.status(404).json({ error: "Class not found" });
    return;
  }

  const [session] = await db
    .select()
    .from(studentSessionsTable)
    .where(eq(studentSessionsTable.id, sessionId))
    .limit(1);

  if (!session || session.classId !== classId) {
    res.status(404).json({ error: "Student session not found" });
    return;
  }

  const [entries, messages] = await Promise.all([
    db
      .select()
      .from(stageEntriesTable)
      .where(eq(stageEntriesTable.sessionId, sessionId)),
    db
      .select()
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.sessionId, sessionId))
      .orderBy(chatMessagesTable.createdAt),
  ]);

  res.json({ session, entries, messages });
});

router.get("/teacher/ai-status", requireTeacher, (_req, res) => {
  res.json({ configured: !!process.env.AI_API_KEY, provider: process.env.AI_PROVIDER ?? "gemini" });
});

export default router;
