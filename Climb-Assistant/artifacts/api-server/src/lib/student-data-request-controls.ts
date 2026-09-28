import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db, studentDataRequestControlsTable } from "@workspace/db";

type ControlDb = Pick<typeof db, "select">;

export type StudentDataControlOperation = "export" | "deletion";
export type StudentDataControlCategory =
  | "identity"
  | "learning"
  | "activity"
  | "feedback"
  | "ai_conversations";

export type StudentDataControlScope = {
  studentSessionIds?: number[];
  classIds?: number[];
  categories?: StudentDataControlCategory[];
};

export async function findBlockingStudentDataControl(
  tx: ControlDb,
  organisationId: number,
  operation: StudentDataControlOperation,
  scope: StudentDataControlScope,
) {
  const studentSessionIds = [...new Set(scope.studentSessionIds ?? [])];
  const classIds = [...new Set(scope.classIds ?? [])];
  if (!studentSessionIds.length && !classIds.length) return null;

  const references = [];
  if (studentSessionIds.length) {
    references.push(inArray(studentDataRequestControlsTable.affectedStudentSessionId, studentSessionIds));
  }
  if (classIds.length) {
    references.push(inArray(studentDataRequestControlsTable.affectedClassId, classIds));
  }

  const controls = await tx
    .select()
    .from(studentDataRequestControlsTable)
    .where(and(
      eq(studentDataRequestControlsTable.organisationId, organisationId),
      eq(studentDataRequestControlsTable.lifecycleState, "active"),
      or(...references),
    ));

  const categories = scope.categories?.length ? new Set(scope.categories) : null;
  return controls.find((control) => {
    if (
      categories
      && !control.affectedDataCategories.some((category) =>
        categories.has(category as StudentDataControlCategory))
    ) {
      return false;
    }
    if (operation === "export") {
      return control.accessLimits.includes("export") || control.processingLimits.includes("export");
    }
    return control.kind !== "restriction" || control.processingLimits.includes("deletion");
  }) ?? null;
}

export async function filterStudentSessionsAllowedForDeletion(
  tx: ControlDb,
  organisationId: number,
  sessions: Array<{ id: number; classId: number }>,
  categories?: StudentDataControlCategory[],
): Promise<Array<{ id: number; classId: number }>> {
  if (!sessions.length) return [];
  const controls = await tx
    .select()
    .from(studentDataRequestControlsTable)
    .where(and(
      eq(studentDataRequestControlsTable.organisationId, organisationId),
      eq(studentDataRequestControlsTable.lifecycleState, "active"),
      or(
        inArray(studentDataRequestControlsTable.affectedStudentSessionId, sessions.map((row) => row.id)),
        inArray(studentDataRequestControlsTable.affectedClassId, sessions.map((row) => row.classId)),
      ),
    ));
  const categorySet = categories?.length ? new Set(categories) : null;
  return sessions.filter((session) => !controls.some((control) => {
    if (
      control.affectedStudentSessionId !== session.id
      && control.affectedClassId !== session.classId
    ) {
      return false;
    }
    if (
      categorySet
      && !control.affectedDataCategories.some((category) =>
        categorySet.has(category as StudentDataControlCategory))
    ) {
      return false;
    }
    return control.kind !== "restriction" || control.processingLimits.includes("deletion");
  }));
}

export async function holdStudentDataControlLock(
  organisationId: number,
  operation: StudentDataControlOperation,
  scope: StudentDataControlScope,
): Promise<{ blockingControl: Awaited<ReturnType<typeof findBlockingStudentDataControl>>; release: () => Promise<void> }> {
  let releaseTransaction!: () => void;
  let reportReady!: (control: Awaited<ReturnType<typeof findBlockingStudentDataControl>>) => void;
  let reportFailure!: (error: unknown) => void;
  const held = new Promise<void>((resolve) => {
    releaseTransaction = resolve;
  });
  const ready = new Promise<Awaited<ReturnType<typeof findBlockingStudentDataControl>>>((resolve, reject) => {
    reportReady = resolve;
    reportFailure = reject;
  });
  const transaction = db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${8452102}, ${organisationId})`);
    const blockingControl = await findBlockingStudentDataControl(tx, organisationId, operation, scope);
    reportReady(blockingControl);
    await held;
  }).catch((error) => {
    reportFailure(error);
    throw error;
  });
  const blockingControl = await ready;
  return {
    blockingControl,
    release: async () => {
      releaseTransaction();
      await transaction;
    },
  };
}