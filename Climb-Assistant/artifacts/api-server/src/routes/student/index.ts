import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { randomUUID } from "crypto";
import { eq, and, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import {
  db,
  classesTable,
  teachersTable,
  organisationsTable,
  studentSessionsTable,
  stageEntriesTable,
  chatMessagesTable,
  teacherFeedbackTable,
  stageEnum,
} from "@workspace/db";
import { requireStudentSession } from "../../middlewares/studentAuth";
import { callAI, callAIOneShot, type OrgAiConfig, type MapContent, type ConversationContext } from "../../lib/ai";
import { moderateStudentMessage } from "../../lib/moderation";
import {
  CheckStudentJoinBody,
  StudentJoinBody,
  UpdateStudentStageBody,
  UpdateStudentStageParams,
  ResetStudentStageParams,
  SendChatMessageBody,
  StudentJoinResponse,
  GetStudentSessionResponse,
  GetStudentStagesResponseItem,
  UpdateStudentStageResponse,
  SendChatMessageResponse,
  GetStudentTaskResponse,
} from "@workspace/api-zod";
import { tasksTable } from "@workspace/db";
import type { StageType } from "@workspace/db";

async function getOrgAiConfig(classId: number): Promise<OrgAiConfig | null> {
  const [cls] = await db
    .select({ teacherId: classesTable.teacherId })
    .from(classesTable)
    .where(eq(classesTable.id, classId));
  if (!cls) return null;

  const [teacher] = await db
    .select({ organisationId: teachersTable.organisationId })
    .from(teachersTable)
    .where(eq(teachersTable.id, cls.teacherId));
  if (!teacher?.organisationId) return null;

  const [org] = await db
    .select({
      aiProvider: organisationsTable.aiProvider,
      aiKeyEncrypted: organisationsTable.aiKeyEncrypted,
      azureEndpoint: organisationsTable.azureEndpoint,
    })
    .from(organisationsTable)
    .where(eq(organisationsTable.id, teacher.organisationId));

  return org ?? null;
}

const router: IRouter = Router();

const joinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many attempts. Please wait 15 minutes before trying again." },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/student/check-join", joinLimiter, async (req, res): Promise<void> => {
  const parsed = CheckStudentJoinBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { studentName, classCode } = parsed.data;

  const [cls] = await db
    .select()
    .from(classesTable)
    .where(eq(classesTable.code, classCode.toUpperCase()));

  if (!cls) {
    res.status(404).json({ error: "Class not found" });
    return;
  }

  const [existing] = await db
    .select({ id: studentSessionsTable.id, pinHash: studentSessionsTable.pinHash, isBlocked: studentSessionsTable.isBlocked })
    .from(studentSessionsTable)
    .where(
      and(
        eq(studentSessionsTable.classId, cls.id),
        eq(studentSessionsTable.studentName, studentName),
      ),
    );

  if (existing?.isBlocked) {
    res.status(403).json({ error: "Your access to this class has been removed. Please speak to your teacher." });
    return;
  }

  res.json({
    exists: !!existing,
    hasPinSet: !!(existing?.pinHash),
  });
});

router.post("/student/join", joinLimiter, async (req, res): Promise<void> => {
  const parsed = StudentJoinBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { studentName, classCode, pin } = parsed.data;

  const [cls] = await db
    .select()
    .from(classesTable)
    .where(eq(classesTable.code, classCode.toUpperCase()));

  if (!cls) {
    res.status(404).json({ error: "Class not found" });
    return;
  }

  const [existing] = await db
    .select()
    .from(studentSessionsTable)
    .where(
      and(
        eq(studentSessionsTable.classId, cls.id),
        eq(studentSessionsTable.studentName, studentName),
      ),
    );

  if (existing?.isBlocked) {
    res.status(403).json({ error: "Your access to this class has been removed. Please speak to your teacher." });
    return;
  }

  let session: typeof existing;

  if (existing) {
    // Check PIN lockout
    if (existing.pinLockedUntil && existing.pinLockedUntil > new Date()) {
      const minutesLeft = Math.ceil((existing.pinLockedUntil.getTime() - Date.now()) / 60000);
      res.status(429).json({
        error: `Too many incorrect PINs. Your access is temporarily locked. Please ask your teacher to unlock your account, or try again in ${minutesLeft} minute${minutesLeft !== 1 ? "s" : ""}.`,
      });
      return;
    }

    if (!existing.pinHash) {
      // Teacher reset the PIN — allow student to set a new one
      const pinHash = await bcrypt.hash(pin, 10);
      const sessionNonce = randomUUID();
      const [updated] = await db
        .update(studentSessionsTable)
        .set({ pinHash, failedPinAttempts: 0, pinLockedUntil: null, sessionNonce })
        .where(eq(studentSessionsTable.id, existing.id))
        .returning();
      session = updated;
    } else {
      const valid = await bcrypt.compare(pin, existing.pinHash);
      if (!valid) {
        const newAttempts = existing.failedPinAttempts + 1;
        const shouldLock = newAttempts >= 5;
        const pinLockedUntil = shouldLock ? new Date(Date.now() + 15 * 60 * 1000) : undefined;
        await db
          .update(studentSessionsTable)
          .set({ failedPinAttempts: newAttempts, ...(pinLockedUntil ? { pinLockedUntil } : {}) })
          .where(eq(studentSessionsTable.id, existing.id));
        if (shouldLock) {
          res.status(429).json({
            error: "Too many incorrect PINs. Your access is temporarily locked. Please ask your teacher to unlock your account.",
          });
        } else {
          res.status(401).json({ error: `Incorrect PIN. Please try again. (${5 - newAttempts} attempt${5 - newAttempts !== 1 ? "s" : ""} remaining before lockout)` });
        }
        return;
      }
      // Correct PIN — rotate nonce to invalidate any previous sessions
      const sessionNonce = randomUUID();
      const [updated] = await db
        .update(studentSessionsTable)
        .set({ failedPinAttempts: 0, pinLockedUntil: null, sessionNonce })
        .where(eq(studentSessionsTable.id, existing.id))
        .returning();
      session = updated;
    }
  } else {
    const pinHash = await bcrypt.hash(pin, 10);
    const sessionNonce = randomUUID();
    const [created] = await db
      .insert(studentSessionsTable)
      .values({ classId: cls.id, studentName, pinHash, sessionNonce })
      .returning();
    session = created;
  }

  const nonce = session.sessionNonce!;
  req.session.studentSessionId = session.id;
  req.session.studentNonce = nonce;
  // NOTE: intentionally do NOT clear req.session.teacherId here.
  // Teacher and student sessions can coexist in the same browser cookie —
  // clearing the teacher session on student join used to kick the teacher
  // out of the platform when someone joined as a student from the same
  // browser (Error 4 in Dawn's testing).

  await new Promise<void>((resolve, reject) =>
    req.session.save((err) => (err ? reject(err) : resolve())),
  );

  res.json({
    ...StudentJoinResponse.parse({
      id: session.id,
      classId: session.classId,
      studentName: session.studentName,
      className: cls.name,
      createdAt: session.createdAt,
    }),
    nonce,
  });
});

router.get(
  "/student/task",
  requireStudentSession,
  async (req, res): Promise<void> => {
    const [task] = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.classId, req.studentSession!.classId));
    if (!task) {
      res.status(404).json({ error: "No task set" });
      return;
    }
    res.json(GetStudentTaskResponse.parse(task));
  },
);

router.get(
  "/student/chat",
  requireStudentSession,
  async (req, res): Promise<void> => {
    const messages = await db
      .select()
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.sessionId, req.studentSession!.id))
      .orderBy(chatMessagesTable.createdAt);

    res.json(messages.map((m) => ({ role: m.role, content: m.content })));
  },
);

router.get(
  "/student/session",
  requireStudentSession,
  async (req, res): Promise<void> => {
    res.json(
      GetStudentSessionResponse.parse({
        id: req.studentSession!.id,
        classId: req.studentSession!.classId,
        studentName: req.studentSession!.studentName,
        className: req.studentSession!.className,
        createdAt: req.studentSession!.createdAt,
      }),
    );
  },
);

router.get(
  "/student/stages",
  requireStudentSession,
  async (req, res): Promise<void> => {
    const entries = await db
      .select()
      .from(stageEntriesTable)
      .where(eq(stageEntriesTable.sessionId, req.studentSession!.id))
      .orderBy(stageEntriesTable.updatedAt);

    res.json(entries.map((e) => GetStudentStagesResponseItem.parse(e)));
  },
);

router.delete(
  "/student/stages/:stage",
  requireStudentSession,
  async (req, res): Promise<void> => {
    const stageParams = ResetStudentStageParams.safeParse({
      stage: typeof req.params.stage === "string"
        ? req.params.stage.toUpperCase()
        : req.params.stage,
    });
    if (!stageParams.success) {
      res.status(400).json({
        error: `Invalid stage. Must be one of: ${stageEnum.join(", ")}`,
      });
      return;
    }

    const stage = stageParams.data.stage as StageType;
    const sessionId = req.studentSession!.id;

    await db
      .delete(stageEntriesTable)
      .where(
        and(
          eq(stageEntriesTable.sessionId, sessionId),
          eq(stageEntriesTable.stage, stage),
        ),
      );

    res.status(204).send();
  },
);

router.put(
  "/student/stages/:stage",
  requireStudentSession,
  async (req, res): Promise<void> => {
    const stageParams = UpdateStudentStageParams.safeParse({
      stage: typeof req.params.stage === "string"
        ? req.params.stage.toUpperCase()
        : req.params.stage,
    });
    if (!stageParams.success) {
      res.status(400).json({
        error: `Invalid stage. Must be one of: ${stageEnum.join(", ")}`,
      });
      return;
    }

    const stage = stageParams.data.stage as StageType;

    const parsed = UpdateStudentStageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const sessionId = req.studentSession!.id;

    const [existing] = await db
      .select({ id: stageEntriesTable.id })
      .from(stageEntriesTable)
      .where(
        and(
          eq(stageEntriesTable.sessionId, sessionId),
          eq(stageEntriesTable.stage, stage),
        ),
      );

    let entry;
    if (existing) {
      [entry] = await db
        .update(stageEntriesTable)
        .set({ contentJson: parsed.data.contentJson, updatedAt: new Date() })
        .where(eq(stageEntriesTable.id, existing.id))
        .returning();
    } else {
      [entry] = await db
        .insert(stageEntriesTable)
        .values({ sessionId, stage, contentJson: parsed.data.contentJson })
        .returning();
    }

    res.json(UpdateStudentStageResponse.parse(entry));
  },
);

router.post(
  "/student/chat",
  requireStudentSession,
  async (req, res): Promise<void> => {
    const parsed = SendChatMessageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { message, history, bloomLevel } = parsed.data;
    const sessionId = req.studentSession!.id;
    const classId = req.studentSession!.classId;

    const moderation = moderateStudentMessage(message);
    if (moderation.blocked) {
      res.status(400).json({ error: moderation.reason });
      return;
    }

    await db.insert(chatMessagesTable).values({
      sessionId,
      role: "user",
      content: message,
      bloomLevel: bloomLevel ?? null,
    });

    const [taskRow] = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.classId, classId));

    const taskContext = taskRow
      ? {
          title: taskRow.title,
          question: taskRow.question,
          notes: taskRow.notes,
          bloomLevels: taskRow.bloomLevels as string[],
          successCriteria: taskRow.successCriteria as string[],
          keyVocabulary: taskRow.keyVocabulary as string[],
          suggestedSources: taskRow.resources as string[] | undefined,
        }
      : null;

    // Fetch MAP planning and prior bloom history in parallel
    const [mapEntry, priorUserMsgs] = await Promise.all([
      db.select({ contentJson: stageEntriesTable.contentJson })
        .from(stageEntriesTable)
        .where(and(eq(stageEntriesTable.sessionId, sessionId), eq(stageEntriesTable.stage, "MAP")))
        .then((rows) => rows[0] ?? null),
      db.select({ bloomLevel: chatMessagesTable.bloomLevel })
        .from(chatMessagesTable)
        .where(and(eq(chatMessagesTable.sessionId, sessionId), eq(chatMessagesTable.role, "user"))),
    ]);

    const mapContent: MapContent | null = mapEntry?.contentJson
      ? {
          taskUnderstanding: (mapEntry.contentJson as any).taskUnderstanding ?? undefined,
          priorKnowledge: (mapEntry.contentJson as any).priorKnowledge ?? undefined,
          knowledgeGaps: (mapEntry.contentJson as any).knowledgeGaps ?? undefined,
          enquiryQuestions: (mapEntry.contentJson as any).enquiryQuestions ?? undefined,
        }
      : null;

    const bloomCounts: Record<string, number> = {};
    for (const { bloomLevel: bl } of priorUserMsgs) {
      if (bl) bloomCounts[bl] = (bloomCounts[bl] ?? 0) + 1;
    }
    if (bloomLevel) bloomCounts[bloomLevel] = (bloomCounts[bloomLevel] ?? 0) + 1;
    const convCtx: ConversationContext = { turnCount: priorUserMsgs.length, bloomCounts };

    let assistantContent: string;
    try {
      const chatHistory = (history ?? []).map((h) => ({
        role: h.role,
        content: h.content,
      }));

      const orgConfig = await getOrgAiConfig(classId);
      assistantContent = await callAI(message, chatHistory, taskContext, bloomLevel ?? null, orgConfig, mapContent, convCtx);
    } catch (err) {
      req.log.error({ err }, "AI proxy error");
      const msg = err instanceof Error ? err.message : String(err);
      const isConfig = msg.includes("AI_PROVIDER") || msg.includes("AI_API_KEY") || msg.includes("not set") || msg.includes("Unknown AI_PROVIDER");
      const isQuota = msg.includes("429") || msg.includes("quota") || msg.includes("Too Many Requests") || msg.includes("RESOURCE_EXHAUSTED");
      const isModel = msg.includes("404") || msg.includes("NOT_FOUND") || msg.includes("not found") || msg.includes("no longer available");
      if (isConfig) {
        res.status(503).json({ error: "AI not configured. Ask your school technician to set the AI_PROVIDER and AI_API_KEY environment variables." });
      } else if (isQuota) {
        res.status(503).json({ error: "AI quota exceeded. The school's AI usage limit has been reached — try again later." });
      } else if (isModel) {
        res.status(503).json({ error: `AI model error: ${msg}` });
      } else {
        res.status(503).json({ error: `AI error: ${msg}` });
      }
      return;
    }

    await db.insert(chatMessagesTable).values({
      sessionId,
      role: "assistant",
      content: assistantContent,
    });

    res.json(
      SendChatMessageResponse.parse({ role: "assistant", content: assistantContent }),
    );
  },
);

router.post(
  "/student/logout",
  async (req, res): Promise<void> => {
    req.session.destroy(() => {});
    res.json({ ok: true });
  },
);

router.post(
  "/student/change-pin",
  requireStudentSession,
  async (req, res): Promise<void> => {
    const sessionId = req.studentSession!.id;
    const { currentPin, newPin } = req.body ?? {};

    if (typeof currentPin !== "string" || !/^\d{4}$/.test(currentPin) ||
        typeof newPin !== "string" || !/^\d{4}$/.test(newPin)) {
      res.status(400).json({ error: "Both current and new PIN must be exactly 4 digits" });
      return;
    }

    const [row] = await db
      .select({ pinHash: studentSessionsTable.pinHash })
      .from(studentSessionsTable)
      .where(eq(studentSessionsTable.id, sessionId));

    if (!row?.pinHash) {
      res.status(400).json({ error: "No PIN set on this account" });
      return;
    }

    const valid = await bcrypt.compare(currentPin, row.pinHash);
    if (!valid) {
      res.status(401).json({ error: "Current PIN is incorrect" });
      return;
    }

    const newPinHash = await bcrypt.hash(newPin, 10);
    await db
      .update(studentSessionsTable)
      .set({ pinHash: newPinHash })
      .where(eq(studentSessionsTable.id, sessionId));

    res.json({ ok: true });
  },
);

router.get(
  "/student/torch-suggestions",
  requireStudentSession,
  async (req, res): Promise<void> => {
    const classId = req.studentSession!.classId;
    const [taskRow] = await db.select().from(tasksTable).where(eq(tasksTable.classId, classId));
    if (!taskRow) {
      res.json({});
      return;
    }
    try {
      const { generateTorchSuggestions } = await import("../../lib/ai");
      const orgCfg = await getOrgAiConfig(classId);
      const result = await generateTorchSuggestions({
        title: taskRow.title,
        question: taskRow.question,
        notes: taskRow.notes,
      }, orgCfg);
      res.json(result);
    } catch (err) {
      req.log.warn({ err }, "Could not generate torch suggestions");
      res.json({});
    }
  },
);

router.get(
  "/student/feedback",
  requireStudentSession,
  async (req, res): Promise<void> => {
    const sessionId = req.studentSession!.id;
    const rows = await db.select().from(teacherFeedbackTable)
      .where(eq(teacherFeedbackTable.sessionId, sessionId));
    const byStage: Record<string, { grade: string | null; comment: string; formativeComment: string; studentAcknowledged: boolean }> = {};
    for (const row of rows) {
      byStage[row.stage] = {
        grade: row.grade ?? null,
        comment: row.comment,
        formativeComment: row.formativeComment,
        studentAcknowledged: row.studentAcknowledged,
      };
    }
    res.json(byStage);
  },
);

router.post(
  "/student/answer-feedback",
  requireStudentSession,
  async (req, res): Promise<void> => {
    const { answer } = req.body as { answer?: string };
    if (!answer || !answer.trim()) {
      res.status(400).json({ error: "Answer is required" });
      return;
    }

    const classId = req.studentSession!.classId;

    const [taskRow] = await db.select().from(tasksTable).where(eq(tasksTable.classId, classId));
    const orgConfig = await getOrgAiConfig(classId);

    const criteria = ((taskRow?.successCriteria ?? []) as string[]).filter(Boolean);
    const vocab = ((taskRow?.keyVocabulary ?? []) as string[]).filter(Boolean);
    const expectedLength = taskRow?.expectedLength ?? null;

    const systemPrompt = `You are an academic feedback assistant for a school learning platform. Your role is to review a student's final answer and cross-reference it against the task requirements.

Be honest, constructive, and specific. Do NOT write the answer for the student. Do NOT praise vaguely. Point to precise things that are present and things that are missing.

TASK TITLE: ${taskRow?.title ?? "Unknown"}
${taskRow?.question ? `TASK QUESTION: ${taskRow.question}` : ""}
${expectedLength ? `EXPECTED LENGTH / FORMAT: ${expectedLength}` : ""}
${criteria.length > 0 ? `\nSUCCESS CRITERIA:\n${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}` : ""}
${vocab.length > 0 ? `\nKEY VOCABULARY the student should use:\n${vocab.join(", ")}` : ""}

Your response must have exactly these four sections with these headings (use plain text, no markdown):

WHAT YOU'VE COVERED
List 2–4 specific things the student has addressed well in their answer. Be precise — quote or paraphrase from their answer.

WHAT'S MISSING OR UNDERDEVELOPED
List specific gaps, missing criteria, or areas that need more depth. If a success criterion is not addressed, name it. If key vocabulary is absent, name the missing words.

VOCABULARY CHECK
Note which key vocabulary terms were used correctly, which were missing, and which were used but could be used more precisely.

NEXT STEPS
Give 2–3 concrete, actionable suggestions for what the student should add or improve before submitting.`;

    try {
      const feedback = await callAIOneShot(systemPrompt, `Here is my answer:\n\n${answer.trim()}`, orgConfig);
      res.json({ feedback });
    } catch (err) {
      req.log.error({ err }, "Answer feedback AI error");
      const msg = err instanceof Error ? err.message : String(err);
      const isQuota = msg.includes("429") || msg.includes("quota") || msg.includes("RESOURCE_EXHAUSTED");
      res.status(isQuota ? 429 : 500).json({ error: isQuota ? "AI quota exceeded — try again shortly." : "Could not generate feedback right now." });
    }
  },
);

router.post(
  "/student/feedback/:stage/acknowledge",
  requireStudentSession,
  async (req, res): Promise<void> => {
    const sessionId = req.studentSession!.id;
    const stage = req.params.stage;
    await db
      .update(teacherFeedbackTable)
      .set({ studentAcknowledged: true })
      .where(sql`${teacherFeedbackTable.sessionId} = ${sessionId} AND ${teacherFeedbackTable.stage} = ${stage}`);
    res.json({ ok: true });
  },
);

export default router;
