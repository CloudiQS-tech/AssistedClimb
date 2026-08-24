import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { eq, sql, and, desc, lt, inArray } from "drizzle-orm";
import {
  db,
  teachersTable,
  classesTable,
  studentSessionsTable,
  stageEntriesTable,
  chatMessagesTable,
  tasksTable,
  teacherFeedbackTable,
  organisationsTable,
  auditLogTable,
} from "@workspace/db";
import { logAudit } from "../../lib/audit";
import { requireTeacher } from "../../middlewares/teacherAuth";
import { synthesiseAssessment, synthesiseClassInsights, generateFormativeFeedback, generateSummativePerStage, type OrgAiConfig } from "../../lib/ai";
import { encrypt, maskApiKey, decrypt } from "../../lib/crypto";
import { z } from "zod/v4";
import {
  CreateClassBody,
  ListClassesResponseItem,
  GetClassParams,
  GetClassResponse,
  ListClassStudentsParams,
  ListClassStudentsResponseItem,
  GetStudentDetailParams,
  GetStudentDetailResponse,
  GetStudentStagesResponseItem,
  GetClassTaskParams,
  UpsertClassTaskParams,
  UpsertClassTaskBody,
  GetClassTaskResponse,
  UpsertClassTaskResponse,
  DeleteClassParams,
  ResetStudentPinParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

function generateClassCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function computeStageStatus(stage: string, contentJson: unknown, msgCount: number): "none" | "started" | "finished" {
  const c = (contentJson ?? {}) as Record<string, any>;
  switch (stage) {
    case "MAP": {
      const u = (c.taskUnderstanding ?? "").trim();
      const pk = (c.priorKnowledge ?? []).filter((p: string) => p?.trim());
      const kg = (c.knowledgeGaps ?? []).filter((g: string) => g?.trim());
      const eq2 = (c.enquiryQuestions ?? []).filter((q: string) => q?.trim());
      if (!u && !pk.length && !eq2.length) return "none";
      if (u.length >= 20 && pk.length >= 2 && kg.length >= 3 && eq2.length >= 3) return "finished";
      return "started";
    }
    case "TORCH":
      if (msgCount === 0) return "none";
      return msgCount >= 6 ? "finished" : "started";
    case "RESEARCH": {
      const sources = (c.entries ?? []) as any[];
      if (!sources.some((s: any) => s.source || s.findings)) return "none";
      if (sources.some((s: any) => (s.source || s.title) && s.findings)) return "finished";
      return "started";
    }
    case "COMPASS": {
      const { check1, check2, check3, check4, check5 } = c;
      if (!check1 && !check2 && !check3 && !check4 && !check5) return "none";
      if (check1?.trim() && check2?.trim() && check3?.trim() && check4?.trim() && check5?.trim()) return "finished";
      return "started";
    }
    case "EMBED": {
      const { finalAnswer, q1, q2, q3, q4 } = c;
      if (!finalAnswer && !q1 && !q2 && !q3 && !q4) return "none";
      if (finalAnswer?.trim() && q1?.trim() && q2?.trim() && q3?.trim() && q4?.trim()) return "finished";
      return "started";
    }
    default: return "none";
  }
}

router.post("/teacher/classes", requireTeacher, async (req, res): Promise<void> => {
  const parsed = CreateClassBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  let code: string = "";
  let attempts = 0;
  do {
    code = generateClassCode();
    const [existing] = await db
      .select({ id: classesTable.id })
      .from(classesTable)
      .where(eq(classesTable.code, code));
    if (!existing) break;
    attempts++;
  } while (attempts < 10);

  const [cls] = await db
    .insert(classesTable)
    .values({ teacherId: req.teacher!.id, name: parsed.data.name, subject: parsed.data.subject ?? null, code })
    .returning();

  res.status(201).json(ListClassesResponseItem.parse(cls));
});

router.get("/teacher/classes", requireTeacher, async (req, res): Promise<void> => {
  const classes = await db
    .select()
    .from(classesTable)
    .where(eq(classesTable.teacherId, req.teacher!.id))
    .orderBy(classesTable.createdAt);

  res.json(classes.map((c) => ListClassesResponseItem.parse(c)));
});

router.get("/teacher/classes/:classId", requireTeacher, async (req, res): Promise<void> => {
  const params = GetClassParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [cls] = await db
    .select()
    .from(classesTable)
    .where(
      and(
        eq(classesTable.id, params.data.classId),
        eq(classesTable.teacherId, req.teacher!.id),
      ),
    );

  if (!cls) {
    res.status(404).json({ error: "Class not found" });
    return;
  }

  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(studentSessionsTable)
    .where(eq(studentSessionsTable.classId, params.data.classId));

  res.json(
    GetClassResponse.parse({
      ...cls,
      studentCount: countResult?.count ?? 0,
    }),
  );
});

router.delete("/teacher/classes/:classId", requireTeacher, async (req, res): Promise<void> => {
  const params = DeleteClassParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [cls] = await db
    .select({ id: classesTable.id })
    .from(classesTable)
    .where(
      and(
        eq(classesTable.id, params.data.classId),
        eq(classesTable.teacherId, req.teacher!.id),
      ),
    );

  if (!cls) {
    res.status(404).json({ error: "Class not found" });
    return;
  }

  const sessions = await db
    .select({ id: studentSessionsTable.id })
    .from(studentSessionsTable)
    .where(eq(studentSessionsTable.classId, cls.id));

  const sessionIds = sessions.map((s) => s.id);

  if (sessionIds.length > 0) {
    for (const sessionId of sessionIds) {
      await db.delete(chatMessagesTable).where(eq(chatMessagesTable.sessionId, sessionId));
      await db.delete(stageEntriesTable).where(eq(stageEntriesTable.sessionId, sessionId));
    }
    await db.delete(studentSessionsTable).where(eq(studentSessionsTable.classId, cls.id));
  }

  await db.delete(classesTable).where(eq(classesTable.id, cls.id));

  res.status(204).send();
});

router.get(
  "/teacher/classes/:classId/task",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = GetClassTaskParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [cls] = await db
      .select({ id: classesTable.id })
      .from(classesTable)
      .where(and(eq(classesTable.id, params.data.classId), eq(classesTable.teacherId, req.teacher!.id)));
    if (!cls) {
      res.status(404).json({ error: "Class not found" });
      return;
    }
    const [task] = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.classId, params.data.classId));
    if (!task) {
      res.status(404).json({ error: "No task set" });
      return;
    }
    res.json(GetClassTaskResponse.parse(task));
  },
);

router.put(
  "/teacher/classes/:classId/task",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = UpsertClassTaskParams.safeParse(req.params);
    if (!params.success) {
      req.log?.warn({ err: params.error, params: req.params }, "Task upsert: invalid params");
      res.status(400).json({ error: "Invalid class id" });
      return;
    }
    const body = UpsertClassTaskBody.safeParse(req.body);
    if (!body.success) {
      req.log?.warn({ err: body.error, bodyKeys: Object.keys(req.body ?? {}) }, "Task upsert: invalid body");
      res.status(400).json({ error: body.error.message });
      return;
    }
    const [cls] = await db
      .select({ id: classesTable.id })
      .from(classesTable)
      .where(and(eq(classesTable.id, params.data.classId), eq(classesTable.teacherId, req.teacher!.id)));
    if (!cls) {
      res.status(404).json({ error: "Class not found" });
      return;
    }
    const values = {
      classId: params.data.classId,
      title: body.data.title,
      question: body.data.question,
      notes: body.data.notes ?? null,
      bloomLevels: body.data.bloomLevels ?? [],
      dueDate: body.data.dueDate ?? null,
      successCriteria: body.data.successCriteria ?? [],
      keyVocabulary: body.data.keyVocabulary ?? [],
      enabledStages: body.data.enabledStages ?? ["MAP", "TORCH", "COMPASS", "EMBED", "RESEARCH"],
      stageInstructions: body.data.stageInstructions ?? {},
      expectedLength: body.data.expectedLength ?? null,
      resources: body.data.resources ?? [],
    };
    try {
      const [task] = await db
        .insert(tasksTable)
        .values(values)
        .onConflictDoUpdate({ target: tasksTable.classId, set: { ...values, updatedAt: new Date() } })
        .returning();
      res.json(UpsertClassTaskResponse.parse(task));
    } catch (err) {
      req.log?.error({ err, classId: params.data.classId }, "Task upsert failed");
      res.status(500).json({ error: "Failed to save task" });
    }
  },
);

router.get(
  "/teacher/classes/:classId/students",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = ListClassStudentsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { classId } = params.data;

    const [cls] = await db
      .select({ id: classesTable.id })
      .from(classesTable)
      .where(
        and(
          eq(classesTable.id, classId),
          eq(classesTable.teacherId, req.teacher!.id),
        ),
      );

    if (!cls) {
      res.status(404).json({ error: "Class not found" });
      return;
    }

    const sessions = await db
      .select()
      .from(studentSessionsTable)
      .where(eq(studentSessionsTable.classId, classId))
      .orderBy(studentSessionsTable.createdAt);

    if (sessions.length === 0) { res.json([]); return; }

    const sessionIds = sessions.map((s) => s.id);

    const allStageRows = await db
      .select({ sessionId: stageEntriesTable.sessionId, stage: stageEntriesTable.stage, contentJson: stageEntriesTable.contentJson, updatedAt: stageEntriesTable.updatedAt })
      .from(stageEntriesTable)
      .where(inArray(stageEntriesTable.sessionId, sessionIds))
      .orderBy(desc(stageEntriesTable.updatedAt));

    const msgCountRows = await db
      .select({ sessionId: chatMessagesTable.sessionId, count: sql<number>`count(*)::int` })
      .from(chatMessagesTable)
      .where(inArray(chatMessagesTable.sessionId, sessionIds))
      .groupBy(chatMessagesTable.sessionId);

    const msgCountMap = new Map<number, number>(msgCountRows.map((r) => [r.sessionId, r.count]));

    const stageRowsBySession = new Map<number, typeof allStageRows>();
    for (const row of allStageRows) {
      const arr = stageRowsBySession.get(row.sessionId) ?? [];
      arr.push(row);
      stageRowsBySession.set(row.sessionId, arr);
    }

    const summaries = sessions.map((session) => {
      const stageRows = stageRowsBySession.get(session.id) ?? [];
      const latestStage = stageRows[0]?.stage ?? null;
      const completedStages = stageRows.map((r) => r.stage);
      const msgCount = msgCountMap.get(session.id) ?? 0;
      const stageStatuses: Record<string, "none" | "started" | "finished"> = {};
      for (const row of stageRows) {
        stageStatuses[row.stage] = computeStageStatus(row.stage, row.contentJson, msgCount);
      }
      return ListClassStudentsResponseItem.parse({
        id: session.id,
        classId: session.classId,
        studentName: session.studentName,
        createdAt: session.createdAt,
        latestStage,
        completedStages,
        stageStatuses,
      });
    });

    res.json(summaries);
  },
);

router.get(
  "/teacher/classes/:classId/students/:sessionId",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = GetStudentDetailParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { classId, sessionId } = params.data;

    const [cls] = await db
      .select({ id: classesTable.id })
      .from(classesTable)
      .where(
        and(
          eq(classesTable.id, classId),
          eq(classesTable.teacherId, req.teacher!.id),
        ),
      );

    if (!cls) {
      res.status(404).json({ error: "Class not found" });
      return;
    }

    const [session] = await db
      .select()
      .from(studentSessionsTable)
      .where(
        and(
          eq(studentSessionsTable.id, sessionId),
          eq(studentSessionsTable.classId, classId),
        ),
      );

    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const stageEntries = await db
      .select()
      .from(stageEntriesTable)
      .where(eq(stageEntriesTable.sessionId, sessionId))
      .orderBy(desc(stageEntriesTable.updatedAt));

    const latestStage = stageEntries[0]?.stage ?? null;
    const completedStages = stageEntries.map((e) => e.stage);

    const chatMessages = await db
      .select()
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.sessionId, sessionId))
      .orderBy(chatMessagesTable.createdAt);

    const msgCount = chatMessages.filter((m) => m.role === "user").length;
    const stageStatuses: Record<string, "none" | "started" | "finished"> = {};
    for (const entry of stageEntries) {
      stageStatuses[entry.stage] = computeStageStatus(entry.stage, entry.contentJson, msgCount);
    }

    res.json(
      GetStudentDetailResponse.parse({
        session: {
          id: session.id,
          classId: session.classId,
          studentName: session.studentName,
          createdAt: session.createdAt,
          latestStage,
          completedStages,
          stageStatuses,
        },
        stageEntries: stageEntries.map((e) =>
          GetStudentStagesResponseItem.parse(e),
        ),
        chatMessages,
      }),
    );
  },
);

router.post(
  "/teacher/classes/:classId/students/:sessionId/reset-pin",
  requireTeacher,
  async (req, res): Promise<void> => {
    const params = ResetStudentPinParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { classId, sessionId } = params.data;

    const [cls] = await db
      .select({ id: classesTable.id })
      .from(classesTable)
      .where(
        and(
          eq(classesTable.id, classId),
          eq(classesTable.teacherId, req.teacher!.id),
        ),
      );

    if (!cls) {
      res.status(404).json({ error: "Class not found" });
      return;
    }

    const [session] = await db
      .select({ id: studentSessionsTable.id })
      .from(studentSessionsTable)
      .where(
        and(
          eq(studentSessionsTable.id, sessionId),
          eq(studentSessionsTable.classId, classId),
        ),
      );

    if (!session) {
      res.status(404).json({ error: "Student not found" });
      return;
    }

    await db
      .update(studentSessionsTable)
      .set({ pinHash: null, failedPinAttempts: 0, pinLockedUntil: null })
      .where(eq(studentSessionsTable.id, sessionId));

    res.status(204).end();
  },
);

router.post(
  "/teacher/classes/:classId/students/:sessionId/unlock-pin",
  requireTeacher,
  async (req, res): Promise<void> => {
    const classId = Number(req.params.classId);
    const sessionId = Number(req.params.sessionId);
    if (isNaN(classId) || isNaN(sessionId)) {
      res.status(400).json({ error: "Invalid IDs" });
      return;
    }

    const [cls] = await db
      .select({ id: classesTable.id })
      .from(classesTable)
      .where(and(eq(classesTable.id, classId), eq(classesTable.teacherId, req.teacher!.id)));

    if (!cls) {
      res.status(404).json({ error: "Class not found" });
      return;
    }

    const [session] = await db
      .select({ id: studentSessionsTable.id })
      .from(studentSessionsTable)
      .where(and(eq(studentSessionsTable.id, sessionId), eq(studentSessionsTable.classId, classId)));

    if (!session) {
      res.status(404).json({ error: "Student not found" });
      return;
    }

    await db
      .update(studentSessionsTable)
      .set({ failedPinAttempts: 0, pinLockedUntil: null })
      .where(eq(studentSessionsTable.id, sessionId));

    res.json({ ok: true });
  },
);

router.get(
  "/teacher/classes/:classId/torch-stats",
  requireTeacher,
  async (req, res): Promise<void> => {
    const classId = Number(req.params.classId);
    if (isNaN(classId)) { res.status(400).json({ error: "Invalid class ID" }); return; }

    const [cls] = await db.select({ id: classesTable.id, teacherId: classesTable.teacherId })
      .from(classesTable).where(eq(classesTable.id, classId));
    if (!cls || cls.teacherId !== req.teacher!.id) { res.status(404).json({ error: "Class not found" }); return; }

    const rows = await db
      .select({
        content: chatMessagesTable.content,
        bloomLevel: chatMessagesTable.bloomLevel,
        role: chatMessagesTable.role,
        sessionId: studentSessionsTable.id,
        studentName: studentSessionsTable.studentName,
      })
      .from(chatMessagesTable)
      .innerJoin(studentSessionsTable, eq(chatMessagesTable.sessionId, studentSessionsTable.id))
      .where(and(eq(studentSessionsTable.classId, classId), eq(chatMessagesTable.role, "user")));

    const byStudentMap = new Map<number, { sessionId: number; studentName: string; messages: { content: string; bloomLevel: string | null }[] }>();
    for (const row of rows) {
      if (!byStudentMap.has(row.sessionId)) {
        byStudentMap.set(row.sessionId, { sessionId: row.sessionId, studentName: row.studentName, messages: [] });
      }
      byStudentMap.get(row.sessionId)!.messages.push({ content: row.content, bloomLevel: row.bloomLevel });
    }

    res.json({
      messages: rows.map((r) => ({ content: r.content, bloomLevel: r.bloomLevel, role: r.role })),
      byStudent: Array.from(byStudentMap.values()),
    });
  },
);

// ── Class Insights ────────────────────────────────────────────────────────────

router.get(
  "/teacher/classes/:classId/class-insights",
  requireTeacher,
  async (req, res): Promise<void> => {
    const classId = Number(req.params.classId);
    if (isNaN(classId)) { res.status(400).json({ error: "Invalid class ID" }); return; }

    const [cls] = await db.select({
      id: classesTable.id,
      lastInsights: classesTable.lastInsights,
      lastInsightsAt: classesTable.lastInsightsAt,
    }).from(classesTable)
      .where(and(eq(classesTable.id, classId), eq(classesTable.teacherId, req.teacher!.id)));
    if (!cls) { res.status(404).json({ error: "Class not found" }); return; }

    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.classId, classId));
    const sessions = await db.select().from(studentSessionsTable)
      .where(eq(studentSessionsTable.classId, classId));
    const sessionIds = sessions.map(s => s.id);

    if (sessionIds.length === 0) {
      res.json({ task: task ?? null, students: [], torchMessages: [], answerSamples: [], gradeDistribution: {}, assessedCount: 0, lastInsights: cls.lastInsights ?? null, lastInsightsAt: cls.lastInsightsAt ?? null });
      return;
    }

    const allEntries = await db.select({ sessionId: stageEntriesTable.sessionId, stage: stageEntriesTable.stage, contentJson: stageEntriesTable.contentJson })
      .from(stageEntriesTable)
      .where(sql`${stageEntriesTable.sessionId} = ANY(${sql.raw(`ARRAY[${sessionIds.join(",")}]`)})`);

    const torchMessages = await db.select({ content: chatMessagesTable.content, sessionId: chatMessagesTable.sessionId, role: chatMessagesTable.role })
      .from(chatMessagesTable)
      .where(and(
        sql`${chatMessagesTable.sessionId} = ANY(${sql.raw(`ARRAY[${sessionIds.join(",")}]`)})`,
        eq(chatMessagesTable.role, "user"),
      ));

    const feedbackRows = await db.select().from(teacherFeedbackTable)
      .where(sql`${teacherFeedbackTable.sessionId} = ANY(${sql.raw(`ARRAY[${sessionIds.join(",")}]`)})`);

    // Index entries and message counts per session for stageStatuses computation
    const entriesBySession = new Map<number, { stage: string; contentJson: unknown }[]>();
    const answerSamples: string[] = [];
    for (const entry of allEntries) {
      const list = entriesBySession.get(entry.sessionId) ?? [];
      list.push({ stage: entry.stage, contentJson: entry.contentJson });
      entriesBySession.set(entry.sessionId, list);
      if (entry.stage === "EMBED") {
        const content = entry.contentJson as any;
        if (content?.finalAnswer) answerSamples.push(content.finalAnswer);
      }
    }

    const msgCountBySession = new Map<number, number>();
    for (const m of torchMessages) {
      msgCountBySession.set(m.sessionId, (msgCountBySession.get(m.sessionId) ?? 0) + 1);
    }

    const students = sessions.map(s => {
      const entries = entriesBySession.get(s.id) ?? [];
      const msgCount = msgCountBySession.get(s.id) ?? 0;
      const stageStatuses: Record<string, "none" | "started" | "finished"> = {};
      for (const { stage, contentJson } of entries) {
        stageStatuses[stage] = computeStageStatus(stage, contentJson, msgCount);
      }
      // Stages with no entry at all are "none" (default via undefined lookup)
      return { id: s.id, studentName: s.studentName, stageStatuses };
    });

    const gradeDistribution: Record<string, Record<string, number>> = {};
    const assessedSessions = new Set<number>();
    for (const fb of feedbackRows) {
      if (fb.stage === "OVERALL" || !fb.grade) continue;
      if (!gradeDistribution[fb.stage]) gradeDistribution[fb.stage] = {};
      gradeDistribution[fb.stage][fb.grade] = (gradeDistribution[fb.stage][fb.grade] ?? 0) + 1;
      assessedSessions.add(fb.sessionId);
    }

    res.json({
      task: task ?? null,
      students,
      torchMessages,
      answerSamples,
      gradeDistribution,
      assessedCount: assessedSessions.size,
      lastInsights: cls.lastInsights ?? null,
      lastInsightsAt: cls.lastInsightsAt ?? null,
    });
  },
);

router.post(
  "/teacher/classes/:classId/class-insights/synthesize",
  requireTeacher,
  async (req, res): Promise<void> => {
    const classId = Number(req.params.classId);
    if (isNaN(classId)) { res.status(400).json({ error: "Invalid class ID" }); return; }

    const [cls] = await db.select({ id: classesTable.id }).from(classesTable)
      .where(and(eq(classesTable.id, classId), eq(classesTable.teacherId, req.teacher!.id)));
    if (!cls) { res.status(404).json({ error: "Class not found" }); return; }

    const { questionTypeCounts, totalMessages, torchSamples, stageCompletion, studentCount } =
      req.body as {
        questionTypeCounts: Record<string, number>;
        totalMessages: number;
        torchSamples: string[];
        stageCompletion: Record<string, number>;
        studentCount: number;
      };

    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.classId, classId));
    const sessions = await db.select({ id: studentSessionsTable.id }).from(studentSessionsTable)
      .where(eq(studentSessionsTable.classId, classId));
    const sessionIds = sessions.map(s => s.id);

    const answerSamples: string[] = [];
    const mapSamples: string[] = [];
    const compassSamples: string[] = [];

    if (sessionIds.length > 0) {
      const writtenEntries = await db.select({ stage: stageEntriesTable.stage, contentJson: stageEntriesTable.contentJson })
        .from(stageEntriesTable)
        .where(and(
          sql`${stageEntriesTable.sessionId} = ANY(${sql.raw(`ARRAY[${sessionIds.join(",")}]`)})`,
          sql`${stageEntriesTable.stage} = ANY(ARRAY['MAP','COMPASS','EMBED'])`,
        ));
      for (const e of writtenEntries) {
        const c = e.contentJson as any;
        if (e.stage === "EMBED" && c?.finalAnswer) {
          answerSamples.push(c.finalAnswer);
        } else if (e.stage === "MAP") {
          const parts = [c?.taskUnderstanding, c?.priorKnowledge, c?.whatIWantToFind].filter((v): v is string => typeof v === "string" && v.trim().length > 0).map(s => s.trim());
          if (parts.length) mapSamples.push(parts.join(" | ").slice(0, 400));
        } else if (e.stage === "COMPASS") {
          const parts = [c?.check1, c?.check2, c?.check3, c?.check4, c?.check5].filter((v): v is string => typeof v === "string" && v.trim().length > 0).map(s => s.trim());
          if (parts.length) compassSamples.push(parts.join(" | ").slice(0, 500));
        }
      }
    }

    const feedbackRows = sessionIds.length > 0
      ? await db.select().from(teacherFeedbackTable)
          .where(sql`${teacherFeedbackTable.sessionId} = ANY(${sql.raw(`ARRAY[${sessionIds.join(",")}]`)})`)
      : [];

    const gradeDistribution: Record<string, Record<string, number>> = {};
    const assessedSessions = new Set<number>();
    for (const fb of feedbackRows) {
      if (fb.stage === "OVERALL" || !fb.grade) continue;
      if (!gradeDistribution[fb.stage]) gradeDistribution[fb.stage] = {};
      gradeDistribution[fb.stage][fb.grade] = (gradeDistribution[fb.stage][fb.grade] ?? 0) + 1;
      assessedSessions.add(fb.sessionId);
    }

    let orgConfigForInsights: OrgAiConfig | null = null;
    if (req.teacher!.organisationId) {
      const [orgRow] = await db
        .select({ aiProvider: organisationsTable.aiProvider, aiKeyEncrypted: organisationsTable.aiKeyEncrypted, azureEndpoint: organisationsTable.azureEndpoint })
        .from(organisationsTable)
        .where(eq(organisationsTable.id, req.teacher!.organisationId));
      if (orgRow) orgConfigForInsights = orgRow;
    }

    const result = await synthesiseClassInsights({
      taskTitle: task?.title ?? "Untitled",
      taskQuestion: task?.question ?? "",
      studentCount,
      stageCompletion,
      questionTypeCounts,
      totalMessages,
      torchSamples,
      answerSamples,
      mapSamples,
      compassSamples,
      gradeDistribution,
      assessedCount: assessedSessions.size,
    }, orgConfigForInsights);

    // Persist result so it survives page refresh
    await db.update(classesTable)
      .set({ lastInsights: result as any, lastInsightsAt: new Date() })
      .where(eq(classesTable.id, classId));

    res.json({ ...result, generatedAt: new Date().toISOString() });
  },
);

// ── Teacher Feedback ──────────────────────────────────────────────────────────

router.get(
  "/teacher/classes/:classId/students/:sessionId/feedback",
  requireTeacher,
  async (req, res): Promise<void> => {
    const { classId, sessionId } = req.params;
    const [cls] = await db.select({ id: classesTable.id }).from(classesTable)
      .where(and(eq(classesTable.id, Number(classId)), eq(classesTable.teacherId, req.teacher!.id)));
    if (!cls) { res.status(404).json({ error: "Class not found" }); return; }

    const rows = await db.select().from(teacherFeedbackTable)
      .where(eq(teacherFeedbackTable.sessionId, Number(sessionId)));

    const byStage: Record<string, { grade: string | null; comment: string; formativeComment: string }> = {};
    for (const row of rows) {
      byStage[row.stage] = { grade: row.grade ?? null, comment: row.comment, formativeComment: row.formativeComment };
    }
    res.json(byStage);
  },
);

router.put(
  "/teacher/classes/:classId/students/:sessionId/feedback/:stage",
  requireTeacher,
  async (req, res): Promise<void> => {
    const classId = String(req.params.classId);
    const sessionId = String(req.params.sessionId);
    const stage = String(req.params.stage);
    const { grade, comment, formativeComment } = req.body as { grade?: string | null; comment?: string; formativeComment?: string };

    const [cls] = await db.select({ id: classesTable.id }).from(classesTable)
      .where(and(eq(classesTable.id, Number(classId)), eq(classesTable.teacherId, req.teacher!.id)));
    if (!cls) { res.status(404).json({ error: "Class not found" }); return; }

    type GradeVal = "emerging" | "developing" | "secure" | "exceeding";
    const gradeVal = (grade ?? null) as GradeVal | null;
    const commentVal = comment ?? "";
    const formativeVal = formativeComment ?? "";

    const existing = await db.select({ id: teacherFeedbackTable.id }).from(teacherFeedbackTable)
      .where(and(eq(teacherFeedbackTable.sessionId, Number(sessionId)), eq(teacherFeedbackTable.stage, stage)));

    if (existing.length > 0) {
      await db.update(teacherFeedbackTable)
        .set({ grade: gradeVal, comment: commentVal, formativeComment: formativeVal, updatedAt: new Date() })
        .where(and(eq(teacherFeedbackTable.sessionId, Number(sessionId)), eq(teacherFeedbackTable.stage, stage)));
    } else {
      await db.insert(teacherFeedbackTable).values({
        sessionId: Number(sessionId),
        stage,
        grade: gradeVal,
        comment: commentVal,
        formativeComment: formativeVal,
      });
    }

    res.json({ ok: true });
  },
);

router.post(
  "/teacher/classes/:classId/students/:sessionId/feedback/synthesize",
  requireTeacher,
  async (req, res): Promise<void> => {
    const { classId, sessionId } = req.params;

    const [cls] = await db.select({ id: classesTable.id }).from(classesTable)
      .where(and(eq(classesTable.id, Number(classId)), eq(classesTable.teacherId, req.teacher!.id)));
    if (!cls) { res.status(404).json({ error: "Class not found" }); return; }

    const [session] = await db.select().from(studentSessionsTable)
      .where(eq(studentSessionsTable.id, Number(sessionId)));
    if (!session) { res.status(404).json({ error: "Session not found" }); return; }

    const [task] = await db.select().from(tasksTable)
      .where(eq(tasksTable.classId, Number(classId)));

    const feedbackRows = await db.select().from(teacherFeedbackTable)
      .where(eq(teacherFeedbackTable.sessionId, Number(sessionId)));

    const stageEntries = await db.select().from(stageEntriesTable)
      .where(eq(stageEntriesTable.sessionId, Number(sessionId)));

    const chatMessages = await db.select().from(chatMessagesTable)
      .where(eq(chatMessagesTable.sessionId, Number(sessionId)))
      .orderBy(chatMessagesTable.createdAt);

    const stageFeedbacks = ["MAP", "TORCH", "COMPASS", "EMBED", "RESEARCH"].map((stage) => {
      const fb = feedbackRows.find((r) => r.stage === stage);
      const entry = stageEntries.find((e) => e.stage === stage);
      const c = (entry?.contentJson ?? {}) as any;
      let studentContent = "";

      if (stage === "MAP") {
        const parts: string[] = [];
        if (c.taskUnderstanding?.trim()) parts.push(`Task understanding: ${c.taskUnderstanding.slice(0, 400)}`);
        const pk = (c.priorKnowledge ?? []).filter((s: string) => s?.trim());
        if (pk.length) parts.push(`Prior knowledge: ${pk.join("; ")}`);
        const kg = (c.knowledgeGaps ?? []).filter((s: string) => s?.trim());
        if (kg.length) parts.push(`Knowledge gaps: ${kg.join("; ")}`);
        const eq = (c.enquiryQuestions ?? []).filter((s: string) => s?.trim());
        if (eq.length) parts.push(`Enquiry questions: ${eq.join("; ")}`);
        studentContent = parts.join("\n");
      } else if (stage === "TORCH") {
        const sample = chatMessages
          .filter((m) => m.role === "user")
          .slice(0, 8)
          .map((m) => m.content.slice(0, 150))
          .join(" | ");
        studentContent = sample ? `${chatMessages.filter(m => m.role === "user").length} questions asked. Samples: ${sample}` : "";
      } else if (stage === "RESEARCH") {
        const sources: any[] = c.entries ?? [];
        studentContent = sources
          .filter((s: any) => s.source || s.title || s.findings)
          .slice(0, 4)
          .map((s: any) => `${s.title || s.source || "untitled"}: ${(s.findings ?? "").slice(0, 150)}`)
          .join(" | ");
      } else if (stage === "COMPASS") {
        const parts: string[] = [];
        if (c.check1?.trim()) parts.push(`In own words: ${c.check1.slice(0, 200)}`);
        if (c.check2?.trim()) parts.push(`Challenge: ${c.check2.slice(0, 200)}`);
        if (c.check3?.trim()) parts.push(`Least confident: ${c.check3.slice(0, 200)}`);
        if (c.check4?.trim()) parts.push(`Evidence balance: ${c.check4.slice(0, 150)}`);
        if (c.check5?.trim()) parts.push(`Ready to write: ${c.check5.slice(0, 150)}`);
        studentContent = parts.join("\n");
      } else if (stage === "EMBED") {
        const parts: string[] = [];
        if (c.finalAnswer?.trim()) parts.push(`Final answer: ${c.finalAnswer.slice(0, 400)}`);
        if (c.q1?.trim()) parts.push(`Changed understanding: ${c.q1.slice(0, 200)}`);
        if (c.q2?.trim()) parts.push(`Own thinking: ${c.q2.slice(0, 200)}`);
        if (c.q3?.trim()) parts.push(`AI help reflection: ${c.q3.slice(0, 150)}`);
        if (c.q4?.trim()) parts.push(`What not to trust: ${c.q4.slice(0, 150)}`);
        studentContent = parts.join("\n");
      }

      return {
        stage,
        grade: fb?.grade ?? null,
        comment: fb?.comment ?? "",
        formativeComment: fb?.formativeComment ?? "",
        studentContent,
      };
    });

    let orgConfig: OrgAiConfig | null = null;
    if (req.teacher!.organisationId) {
      const [org] = await db
        .select({ aiProvider: organisationsTable.aiProvider, aiKeyEncrypted: organisationsTable.aiKeyEncrypted, azureEndpoint: organisationsTable.azureEndpoint })
        .from(organisationsTable)
        .where(eq(organisationsTable.id, req.teacher!.organisationId));
      if (org) orgConfig = org;
    }

    const result = await synthesiseAssessment(
      session.studentName,
      task?.title ?? "Untitled task",
      task?.question ?? "",
      stageFeedbacks,
      orgConfig,
    );

    res.json(result);
  },
);

// ── Generate Formative Feedback ───────────────────────────────────────────────

router.post(
  "/teacher/classes/:classId/students/:sessionId/generate-formative-feedback",
  requireTeacher,
  async (req, res): Promise<void> => {
    const { classId, sessionId } = req.params;

    const [cls] = await db.select({ id: classesTable.id }).from(classesTable)
      .where(and(eq(classesTable.id, Number(classId)), eq(classesTable.teacherId, req.teacher!.id)));
    if (!cls) { res.status(404).json({ error: "Class not found" }); return; }

    const [session] = await db.select().from(studentSessionsTable)
      .where(eq(studentSessionsTable.id, Number(sessionId)));
    if (!session) { res.status(404).json({ error: "Session not found" }); return; }

    const [task] = await db.select().from(tasksTable)
      .where(eq(tasksTable.classId, Number(classId)));

    const stageEntries = await db.select().from(stageEntriesTable)
      .where(eq(stageEntriesTable.sessionId, Number(sessionId)));

    const chatMessages = await db.select().from(chatMessagesTable)
      .where(eq(chatMessagesTable.sessionId, Number(sessionId)))
      .orderBy(chatMessagesTable.createdAt);

    // Build human-readable content summaries per stage
    const stageInputs = (["MAP", "TORCH", "COMPASS", "RESEARCH", "EMBED"] as const).map((stage) => {
      const entry = stageEntries.find((e) => e.stage === stage);
      const c = (entry?.contentJson ?? {}) as any;
      let content = "";

      if (stage === "MAP") {
        const parts: string[] = [];
        if (c.taskUnderstanding?.trim()) parts.push(`Task understanding: ${c.taskUnderstanding.slice(0, 400)}`);
        const pk = (c.priorKnowledge ?? []).filter((s: string) => s?.trim());
        if (pk.length) parts.push(`Prior knowledge: ${pk.join("; ")}`);
        const kg = (c.knowledgeGaps ?? []).filter((s: string) => s?.trim());
        if (kg.length) parts.push(`Knowledge gaps: ${kg.join("; ")}`);
        const eq = (c.enquiryQuestions ?? []).filter((s: string) => s?.trim());
        if (eq.length) parts.push(`Enquiry questions: ${eq.join("; ")}`);
        content = parts.join("\n");
      } else if (stage === "TORCH") {
        const sample = chatMessages.slice(0, 20)
          .map((m) => `${m.role === "user" ? "Student" : "AI"}: ${m.content.slice(0, 200)}`)
          .join("\n");
        content = sample;
      } else if (stage === "RESEARCH") {
        const sources: any[] = c.entries ?? [];
        content = sources
          .filter((s: any) => s.source || s.title || s.findings)
          .slice(0, 6)
          .map((s: any) => `Source: ${s.title || s.source || s.url || "untitled"}\nFindings: ${(s.findings ?? "").slice(0, 200)}`)
          .join("\n\n");
      } else if (stage === "COMPASS") {
        const parts: string[] = [];
        if (c.check1?.trim()) parts.push(`Verified: ${c.check1.slice(0, 200)}`);
        if (c.check2?.trim()) parts.push(`Alternative view: ${c.check2.slice(0, 200)}`);
        if (c.check3?.trim()) parts.push(`Bias check: ${c.check3.slice(0, 200)}`);
        if (c.check4?.trim()) parts.push(`Evidence balance: ${c.check4.slice(0, 200)}`);
        if (c.check5?.trim()) parts.push(`Reliability: ${c.check5.slice(0, 200)}`);
        content = parts.join("\n");
      } else if (stage === "EMBED") {
        const parts: string[] = [];
        if (c.q1?.trim()) parts.push(`Q1: ${c.q1.slice(0, 200)}`);
        if (c.q2?.trim()) parts.push(`Q2: ${c.q2.slice(0, 200)}`);
        if (c.q3?.trim()) parts.push(`Q3: ${c.q3.slice(0, 200)}`);
        if (c.q4?.trim()) parts.push(`Q4: ${c.q4.slice(0, 200)}`);
        if (c.finalAnswer?.trim()) parts.push(`Final answer: ${c.finalAnswer.slice(0, 400)}`);
        content = parts.join("\n");
      }

      return { stage, content };
    });

    let orgConfig: OrgAiConfig | null = null;
    if (req.teacher!.organisationId) {
      const [org] = await db
        .select({ aiProvider: organisationsTable.aiProvider, aiKeyEncrypted: organisationsTable.aiKeyEncrypted, azureEndpoint: organisationsTable.azureEndpoint })
        .from(organisationsTable)
        .where(eq(organisationsTable.id, req.teacher!.organisationId));
      if (org) orgConfig = org;
    }

    const result = await generateFormativeFeedback(
      task?.title ?? "Untitled task",
      task?.question ?? "",
      task?.notes ?? "",
      stageInputs,
      orgConfig,
    );

    res.json(result);
  },
);

// ── Generate Summative Feedback Per Stage ────────────────────────────────────

router.post(
  "/teacher/classes/:classId/students/:sessionId/generate-summative-per-stage",
  requireTeacher,
  async (req, res): Promise<void> => {
    const { classId, sessionId } = req.params;

    const [cls] = await db.select({ id: classesTable.id }).from(classesTable)
      .where(and(eq(classesTable.id, Number(classId)), eq(classesTable.teacherId, req.teacher!.id)));
    if (!cls) { res.status(404).json({ error: "Class not found" }); return; }

    const [session] = await db.select().from(studentSessionsTable)
      .where(eq(studentSessionsTable.id, Number(sessionId)));
    if (!session) { res.status(404).json({ error: "Session not found" }); return; }

    const [task] = await db.select().from(tasksTable)
      .where(eq(tasksTable.classId, Number(classId)));

    const stageEntries = await db.select().from(stageEntriesTable)
      .where(eq(stageEntriesTable.sessionId, Number(sessionId)));

    const chatMessages = await db.select().from(chatMessagesTable)
      .where(eq(chatMessagesTable.sessionId, Number(sessionId)))
      .orderBy(chatMessagesTable.createdAt);

    const stageInputs = (["MAP", "TORCH", "COMPASS", "RESEARCH", "EMBED"] as const).map((stage) => {
      const entry = stageEntries.find((e) => e.stage === stage);
      const c = (entry?.contentJson ?? {}) as any;
      let content = "";

      if (stage === "MAP") {
        const parts: string[] = [];
        if (c.taskUnderstanding?.trim()) parts.push(`Task understanding: ${c.taskUnderstanding.slice(0, 400)}`);
        const pk = (c.priorKnowledge ?? []).filter((s: string) => s?.trim());
        if (pk.length) parts.push(`Prior knowledge: ${pk.join("; ")}`);
        const kg = (c.knowledgeGaps ?? []).filter((s: string) => s?.trim());
        if (kg.length) parts.push(`Knowledge gaps: ${kg.join("; ")}`);
        const eq2 = (c.enquiryQuestions ?? []).filter((s: string) => s?.trim());
        if (eq2.length) parts.push(`Enquiry questions: ${eq2.join("; ")}`);
        content = parts.join("\n");
      } else if (stage === "TORCH") {
        const userMsgs = chatMessages.filter((m) => m.role === "user");
        const sample = userMsgs.slice(0, 10).map((m) => m.content.slice(0, 200)).join(" | ");
        content = sample ? `${userMsgs.length} questions asked. Sample questions: ${sample}` : "";
      } else if (stage === "RESEARCH") {
        const sources: any[] = c.entries ?? [];
        content = sources
          .filter((s: any) => s.source || s.title || s.findings)
          .slice(0, 5)
          .map((s: any) => `Source: ${s.title || s.source || "untitled"}\nFindings: ${(s.findings ?? "").slice(0, 200)}`)
          .join("\n\n");
      } else if (stage === "COMPASS") {
        const parts: string[] = [];
        if (c.check1?.trim()) parts.push(`In own words: ${c.check1.slice(0, 200)}`);
        if (c.check2?.trim()) parts.push(`Challenge to thinking: ${c.check2.slice(0, 200)}`);
        if (c.check3?.trim()) parts.push(`Least confident: ${c.check3.slice(0, 200)}`);
        if (c.check4?.trim()) parts.push(`Evidence balance: ${c.check4.slice(0, 150)}`);
        if (c.check5?.trim()) parts.push(`Ready to write: ${c.check5.slice(0, 150)}`);
        content = parts.join("\n");
      } else if (stage === "EMBED") {
        const parts: string[] = [];
        if (c.finalAnswer?.trim()) parts.push(`Final answer: ${c.finalAnswer.slice(0, 500)}`);
        if (c.q1?.trim()) parts.push(`Changed understanding: ${c.q1.slice(0, 200)}`);
        if (c.q2?.trim()) parts.push(`Own thinking: ${c.q2.slice(0, 200)}`);
        if (c.q3?.trim()) parts.push(`AI help reflection: ${c.q3.slice(0, 150)}`);
        if (c.q4?.trim()) parts.push(`What not to trust: ${c.q4.slice(0, 150)}`);
        content = parts.join("\n");
      }

      return { stage, content };
    });

    let orgConfig: OrgAiConfig | null = null;
    if (req.teacher!.organisationId) {
      const [org] = await db
        .select({ aiProvider: organisationsTable.aiProvider, aiKeyEncrypted: organisationsTable.aiKeyEncrypted, azureEndpoint: organisationsTable.azureEndpoint })
        .from(organisationsTable)
        .where(eq(organisationsTable.id, req.teacher!.organisationId));
      if (org) orgConfig = org;
    }

    const result = await generateSummativePerStage(
      task?.title ?? "Untitled task",
      task?.question ?? "",
      task?.notes ?? "",
      stageInputs,
      orgConfig,
    );

    res.json(result);
  },
);

// ── IT Admin — Org AI Settings ────────────────────────────────────────────────

function requireItAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!(req as any).teacher?.isItAdmin) {
    res.status(403).json({ error: "IT admin access required" });
    return;
  }
  next();
}

router.get(
  "/teacher/org/ai-settings",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }

    const [org] = await db
      .select({ aiProvider: organisationsTable.aiProvider, aiKeyEncrypted: organisationsTable.aiKeyEncrypted, azureEndpoint: organisationsTable.azureEndpoint })
      .from(organisationsTable)
      .where(eq(organisationsTable.id, orgId));

    if (!org) {
      res.status(404).json({ error: "Organisation not found" });
      return;
    }

    const masked = org.aiKeyEncrypted ? maskApiKey(decrypt(org.aiKeyEncrypted)) : null;

    res.json({
      configured: !!org.aiKeyEncrypted,
      aiProvider: org.aiProvider,
      aiKeyMasked: masked,
      azureEndpoint: org.azureEndpoint,
    });
  },
);

const UpdateOrgAiSettingsBody = z.object({
  aiProvider: z.enum(["gemini", "azure"]),
  aiKey: z.string().min(1),
  azureEndpoint: z.string().optional(),
});

router.put(
  "/teacher/org/ai-settings",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const parsed = UpdateOrgAiSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
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
      .set({ aiProvider, aiKeyEncrypted: encrypted, azureEndpoint: azureEndpoint ?? null })
      .where(eq(organisationsTable.id, orgId))
      .returning({ id: organisationsTable.id, aiProvider: organisationsTable.aiProvider });

    if (!org) {
      res.status(404).json({ error: "Organisation not found" });
      return;
    }

    res.json({ configured: true, aiProvider: org.aiProvider, aiKeyMasked: maskApiKey(aiKey) });
  },
);

// ── IT Admin — Invite Code ─────────────────────────────────────────────────────

router.get(
  "/teacher/org/invite-code",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }
    const [org] = await db
      .select({ teacherInviteCode: organisationsTable.teacherInviteCode })
      .from(organisationsTable)
      .where(eq(organisationsTable.id, orgId));
    if (!org) {
      res.status(404).json({ error: "Organisation not found" });
      return;
    }
    res.json({ inviteCode: org.teacherInviteCode });
  },
);

router.post(
  "/teacher/org/invite-code/rotate",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }
    const { randomBytes } = await import("crypto");
    const newCode = randomBytes(4).toString("hex").toUpperCase();
    const [org] = await db
      .update(organisationsTable)
      .set({ teacherInviteCode: newCode })
      .where(eq(organisationsTable.id, orgId))
      .returning({ teacherInviteCode: organisationsTable.teacherInviteCode });
    if (!org) {
      res.status(404).json({ error: "Organisation not found" });
      return;
    }
    await logAudit({
      organisationId: orgId,
      teacherId: req.teacher!.id,
      action: "org.invite_code_rotated",
      ipAddress: req.ip,
    });
    res.json({ inviteCode: org.teacherInviteCode });
  },
);

// ── IT Admin — Allowed Email Domains ──────────────────────────────────────────

router.get(
  "/teacher/org/email-domains",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }
    const [org] = await db
      .select({ allowedEmailDomains: organisationsTable.allowedEmailDomains })
      .from(organisationsTable)
      .where(eq(organisationsTable.id, orgId));
    if (!org) {
      res.status(404).json({ error: "Organisation not found" });
      return;
    }
    res.json({ allowedEmailDomains: org.allowedEmailDomains ?? [] });
  },
);

const UpdateEmailDomainsBody = z.object({
  allowedEmailDomains: z.array(
    z.string().regex(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, "Enter a valid domain (e.g. school.edu.au)")
  ),
});

router.put(
  "/teacher/org/email-domains",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation linked to this account" });
      return;
    }
    const parsed = UpdateEmailDomainsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid domains" });
      return;
    }
    const domains = parsed.data.allowedEmailDomains.map((d) => d.toLowerCase().replace(/^@/, ""));
    const [org] = await db
      .update(organisationsTable)
      .set({ allowedEmailDomains: domains.length > 0 ? domains : null })
      .where(eq(organisationsTable.id, orgId))
      .returning({ allowedEmailDomains: organisationsTable.allowedEmailDomains });
    if (!org) {
      res.status(404).json({ error: "Organisation not found" });
      return;
    }
    await logAudit({
      organisationId: orgId,
      teacherId: req.teacher!.id,
      action: "org.email_domains_updated",
      metadata: { domains },
      ipAddress: req.ip,
    });
    res.json({ allowedEmailDomains: org.allowedEmailDomains ?? [] });
  },
);

// ── Remove (block) student from class ─────────────────────────────────────────

router.delete(
  "/teacher/class/:classId/student/:sessionId",
  requireTeacher,
  async (req, res): Promise<void> => {
    const classId = Number(req.params.classId);
    const sessionId = Number(req.params.sessionId);

    const [cls] = await db
      .select({ teacherId: classesTable.teacherId })
      .from(classesTable)
      .where(and(eq(classesTable.id, classId), eq(classesTable.teacherId, req.teacher!.id)));

    if (!cls) {
      res.status(404).json({ error: "Class not found or access denied" });
      return;
    }

    const [updated] = await db
      .update(studentSessionsTable)
      .set({ isBlocked: true })
      .where(and(eq(studentSessionsTable.id, sessionId), eq(studentSessionsTable.classId, classId)))
      .returning({ id: studentSessionsTable.id, studentName: studentSessionsTable.studentName });

    if (!updated) {
      res.status(404).json({ error: "Student not found" });
      return;
    }

    await logAudit({
      organisationId: req.teacher!.organisationId,
      teacherId: req.teacher!.id,
      action: "student.removed",
      metadata: { classId, sessionId, studentName: updated.studentName },
      ipAddress: req.ip,
    });

    res.json({ ok: true });
  },
);

// ── TOTP setup / enable / disable ─────────────────────────────────────────────

router.get("/teacher/totp/setup", requireTeacher, async (req, res): Promise<void> => {
  const { generateSecret, generateURI } = await import("otplib");
  const QRCode = (await import("qrcode")).default;

  const secret = generateSecret();
  const teacher = req.teacher!;

  await db
    .update(teachersTable)
    .set({ totpSecret: secret, totpEnabled: false })
    .where(eq(teachersTable.id, teacher.id));

  const otpAuthUrl = generateURI({ issuer: "The Assisted Climb", label: teacher.email, secret });
  const qrCode = await QRCode.toDataURL(otpAuthUrl);

  res.json({ secret, qrCode });
});

const TotpEnableBody = z.object({ code: z.string().min(6).max(8) });

router.post("/teacher/totp/enable", requireTeacher, async (req, res): Promise<void> => {
  const { verifySync } = await import("otplib");

  const parsed = TotpEnableBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "6-digit code required" });
    return;
  }

  const teacher = req.teacher!;
  const [fresh] = await db.select().from(teachersTable).where(eq(teachersTable.id, teacher.id));
  if (!fresh?.totpSecret) {
    res.status(400).json({ error: "No TOTP setup in progress. Please start setup first." });
    return;
  }

  const isValid = verifySync({ token: parsed.data.code, secret: fresh.totpSecret }).valid;
  if (!isValid) {
    res.status(401).json({ error: "Invalid code. Check your authenticator app and try again." });
    return;
  }

  await db.update(teachersTable).set({ totpEnabled: true }).where(eq(teachersTable.id, teacher.id));

  await logAudit({
    organisationId: teacher.organisationId,
    teacherId: teacher.id,
    action: "teacher.totp_enabled",
    ipAddress: req.ip,
  });

  res.json({ ok: true });
});

const TotpDisableBody = z.object({ code: z.string().min(6).max(8) });

router.post("/teacher/totp/disable", requireTeacher, async (req, res): Promise<void> => {
  const { verifySync } = await import("otplib");

  const parsed = TotpDisableBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "TOTP code required to disable 2FA" });
    return;
  }

  const teacher = req.teacher!;
  const [fresh] = await db.select().from(teachersTable).where(eq(teachersTable.id, teacher.id));
  if (!fresh?.totpSecret || !fresh.totpEnabled) {
    res.status(400).json({ error: "2FA is not currently enabled" });
    return;
  }

  const isValid = verifySync({ token: parsed.data.code, secret: fresh.totpSecret }).valid;
  if (!isValid) {
    res.status(401).json({ error: "Invalid code. You must enter a valid code to disable 2FA." });
    return;
  }

  await db
    .update(teachersTable)
    .set({ totpEnabled: false, totpSecret: null })
    .where(eq(teachersTable.id, teacher.id));

  await logAudit({
    organisationId: teacher.organisationId,
    teacherId: teacher.id,
    action: "teacher.totp_disabled",
    ipAddress: req.ip,
  });

  res.json({ ok: true });
});

// ── Audit log (IT admin only) ─────────────────────────────────────────────────

router.get(
  "/teacher/audit-log",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation" });
      return;
    }

    const entries = await db
      .select({
        id: auditLogTable.id,
        action: auditLogTable.action,
        metadata: auditLogTable.metadata,
        ipAddress: auditLogTable.ipAddress,
        createdAt: auditLogTable.createdAt,
        teacherName: teachersTable.name,
        teacherEmail: teachersTable.email,
      })
      .from(auditLogTable)
      .leftJoin(teachersTable, eq(auditLogTable.teacherId, teachersTable.id))
      .where(eq(auditLogTable.organisationId, orgId))
      .orderBy(desc(auditLogTable.createdAt))
      .limit(200);

    res.json(entries);
  },
);

// ── List teachers in org (IT admin only) ──────────────────────────────────────

router.get(
  "/teacher/org/teachers",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation" });
      return;
    }

    const teachers = await db
      .select({
        id: teachersTable.id,
        name: teachersTable.name,
        email: teachersTable.email,
        isItAdmin: teachersTable.isItAdmin,
        mustChangePassword: teachersTable.mustChangePassword,
        failedLoginAttempts: teachersTable.failedLoginAttempts,
        lockedUntil: teachersTable.lockedUntil,
        createdAt: teachersTable.createdAt,
      })
      .from(teachersTable)
      .where(eq(teachersTable.organisationId, orgId))
      .orderBy(teachersTable.name);

    res.json(teachers);
  },
);

// ── Generate password reset link for teacher (IT admin only) ──────────────────

router.post(
  "/teacher/org/teacher/:id/request-reset",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const targetId = Number(req.params.id);
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation" });
      return;
    }

    const [target] = await db
      .select({ id: teachersTable.id, email: teachersTable.email, organisationId: teachersTable.organisationId })
      .from(teachersTable)
      .where(and(eq(teachersTable.id, targetId), eq(teachersTable.organisationId, orgId)));

    if (!target) {
      res.status(404).json({ error: "Teacher not found in your organisation" });
      return;
    }

    const { randomUUID } = await import("crypto");
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await db
      .update(teachersTable)
      .set({ passwordResetToken: token, passwordResetExpiresAt: expiresAt, mustChangePassword: true })
      .where(eq(teachersTable.id, targetId));

    await logAudit({
      organisationId: orgId,
      teacherId: req.teacher!.id,
      action: "teacher.reset_link_generated",
      metadata: { forTeacherId: targetId, forTeacherEmail: target.email },
      ipAddress: req.ip,
    });

    res.json({ resetToken: token, expiresAt });
  },
);

// ── Unlock locked teacher account (IT admin only) ─────────────────────────────

router.post(
  "/teacher/org/teacher/:id/unlock",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const targetId = Number(req.params.id);
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation" });
      return;
    }

    const [target] = await db
      .select({ id: teachersTable.id, email: teachersTable.email })
      .from(teachersTable)
      .where(and(eq(teachersTable.id, targetId), eq(teachersTable.organisationId, orgId)));

    if (!target) {
      res.status(404).json({ error: "Teacher not found in your organisation" });
      return;
    }

    await db
      .update(teachersTable)
      .set({ failedLoginAttempts: 0, lockedUntil: null })
      .where(eq(teachersTable.id, targetId));

    await logAudit({
      organisationId: orgId,
      teacherId: req.teacher!.id,
      action: "teacher.account_unlocked",
      metadata: { forTeacherId: targetId, forTeacherEmail: target.email },
      ipAddress: req.ip,
    });

    res.json({ ok: true });
  },
);

// ── Promote / demote IT admin (IT admin only) ──────────────────────────────────

router.patch(
  "/teacher/org/teacher/:id/set-admin",
  requireTeacher,
  requireItAdmin,
  async (req, res): Promise<void> => {
    const targetId = Number(req.params.id);
    const orgId = req.teacher!.organisationId;
    if (!orgId) {
      res.status(404).json({ error: "No organisation" });
      return;
    }
    if (targetId === req.teacher!.id) {
      res.status(400).json({ error: "You cannot change your own admin status" });
      return;
    }
    const { isItAdmin } = req.body ?? {};
    if (typeof isItAdmin !== "boolean") {
      res.status(400).json({ error: "isItAdmin (boolean) required" });
      return;
    }

    const [target] = await db
      .select({ id: teachersTable.id, email: teachersTable.email })
      .from(teachersTable)
      .where(and(eq(teachersTable.id, targetId), eq(teachersTable.organisationId, orgId)));

    if (!target) {
      res.status(404).json({ error: "Teacher not found in your organisation" });
      return;
    }

    await db.update(teachersTable).set({ isItAdmin }).where(eq(teachersTable.id, targetId));

    await logAudit({
      organisationId: orgId,
      teacherId: req.teacher!.id,
      action: isItAdmin ? "teacher.promoted_to_admin" : "teacher.demoted_from_admin",
      metadata: { forTeacherId: targetId, forTeacherEmail: target.email },
      ipAddress: req.ip,
    });

    res.json({ ok: true, isItAdmin });
  },
);

export default router;
