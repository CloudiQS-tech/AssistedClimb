import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  auditLogTable,
  classesTable,
  db,
  organisationsTable,
  safeguardingReviewItemsTable,
  studentSessionsTable,
  teachersTable,
  type SafeguardingCategory,
  type SafeguardingProviderSignal,
} from "@workspace/db";
import { isEmailConfigured, sendEmail } from "./email";
import type { LocalSafeguardingMatch } from "./safeguarding-screening";

export type SafeguardingSourceType = "student_ai" | "climb";

export type SafeguardingSubmission = {
  organisationId: number;
  classId: number;
  studentSessionId: number;
  sourceType: SafeguardingSourceType;
  sourceSubmissionId: string;
  stage?: string | null;
  studentText: string;
  localMatch?: LocalSafeguardingMatch | null;
  providerSignals?: SafeguardingProviderSignal[];
};

export type SafeguardingCreateResult = {
  id: number;
  created: boolean;
} | null;

function makeDedupeKey(input: SafeguardingSubmission): string {
  return createHash("sha256")
    .update(`${input.studentSessionId}\u0000${input.sourceType}\u0000${input.sourceSubmissionId}`)
    .digest("hex");
}

function safeExcerpt(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 700);
}

function mergeProviderSignals(
  existing: SafeguardingProviderSignal[],
  incoming: SafeguardingProviderSignal[],
): SafeguardingProviderSignal[] {
  const merged = new Map<string, Set<string>>();
  for (const signal of [...existing, ...incoming]) {
    if (!signal || !["azure", "gemini"].includes(signal.provider) || !Array.isArray(signal.categories)) continue;
    const categories = merged.get(signal.provider) ?? new Set<string>();
    for (const category of signal.categories) {
      if (typeof category === "string" && category.length <= 80) categories.add(category);
    }
    merged.set(signal.provider, categories);
  }
  return [...merged.entries()]
    .map(([provider, categories]) => ({
      provider: provider as "azure" | "gemini",
      categories: [...categories].sort(),
    }))
    .filter((signal) => signal.categories.length > 0);
}

export async function recordSafeguardingSubmission(
  tx: any,
  input: SafeguardingSubmission,
): Promise<SafeguardingCreateResult> {
  const providerSignals = input.providerSignals ?? [];
  const localMatch = input.localMatch ?? null;
  if (!localMatch && providerSignals.length === 0) return null;
  const providerOutputBlocked = providerSignals.some((signal) =>
    signal?.categories?.includes("assistant_output_blocked"),
  );

  const [ownership] = await tx
    .select({ sessionId: studentSessionsTable.id })
    .from(studentSessionsTable)
    .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
    .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
    .innerJoin(organisationsTable, eq(teachersTable.organisationId, organisationsTable.id))
    .where(and(
      eq(studentSessionsTable.id, input.studentSessionId),
      eq(classesTable.id, input.classId),
      eq(organisationsTable.id, input.organisationId),
      isNull(organisationsTable.deletedAt),
    ));
  if (!ownership) return null;

  const dedupeKey = makeDedupeKey(input);
  const existingRows = await tx
    .select({
      id: safeguardingReviewItemsTable.id,
      category: safeguardingReviewItemsTable.category,
      detectedBy: safeguardingReviewItemsTable.detectedBy,
      providerSignals: safeguardingReviewItemsTable.providerSignals,
    })
    .from(safeguardingReviewItemsTable)
    .where(and(
      eq(safeguardingReviewItemsTable.organisationId, input.organisationId),
      eq(safeguardingReviewItemsTable.studentSessionId, input.studentSessionId),
      eq(safeguardingReviewItemsTable.dedupeKey, dedupeKey),
    ));
  const existing = existingRows[0];

  if (existing) {
    const mergedSignals = mergeProviderSignals(
      (existing.providerSignals ?? []) as SafeguardingProviderSignal[],
      providerSignals,
    );
    const signalsChanged = JSON.stringify(mergedSignals)
      !== JSON.stringify((existing.providerSignals ?? []) as SafeguardingProviderSignal[]);
    const nextDetectedBy = localMatch
      ? (mergedSignals.length > 0 ? "both" : "local")
      : (existing.detectedBy === "local" ? "both" : existing.detectedBy);
    const nextCategory: SafeguardingCategory = localMatch?.category
      ?? existing.category as SafeguardingCategory;
    await tx
      .update(safeguardingReviewItemsTable)
      .set({
        category: nextCategory,
        detectedBy: nextDetectedBy,
        providerSignals: mergedSignals,
        technicalReason: localMatch?.ruleId
          ?? (providerOutputBlocked
            ? "provider.output_filter.blocked"
            : existing.category === "provider_safety_signal"
            ? "provider.prompt_filter.blocked"
            : undefined),
        updatedAt: new Date(),
      })
      .where(eq(safeguardingReviewItemsTable.id, existing.id));
    if (signalsChanged && providerSignals.length > 0) {
      await tx.insert(auditLogTable).values({
        organisationId: input.organisationId,
        teacherId: null,
        action: "safeguarding.review_item.provider_signal_added",
        metadata: { reviewItemId: existing.id },
        ipAddress: null,
      });
    }
    return { id: existing.id, created: false };
  }

  const category: SafeguardingCategory = localMatch?.category ?? "provider_safety_signal";
  const detectedBy = localMatch
    ? (providerSignals.length > 0 ? "both" : "local")
    : "provider";
  const [created] = await tx
    .insert(safeguardingReviewItemsTable)
    .values({
      organisationId: input.organisationId,
      classId: input.classId,
      studentSessionId: input.studentSessionId,
      sourceType: input.sourceType,
      sourceSubmissionId: input.sourceSubmissionId,
      stage: input.stage ?? null,
      dedupeKey,
      category,
      technicalReason: localMatch?.ruleId
        ?? (providerOutputBlocked
          ? "provider.output_filter.blocked"
          : "provider.prompt_filter.blocked"),
      excerpt: localMatch?.excerpt ?? safeExcerpt(input.studentText),
      surroundingContext: localMatch?.surroundingContext ?? "",
      detectedBy,
      providerSignals,
    })
    .onConflictDoNothing({
      target: [safeguardingReviewItemsTable.studentSessionId, safeguardingReviewItemsTable.dedupeKey],
    })
    .returning({ id: safeguardingReviewItemsTable.id });

  if (!created) {
    const [duplicate] = await tx
      .select({ id: safeguardingReviewItemsTable.id })
      .from(safeguardingReviewItemsTable)
      .where(and(
        eq(safeguardingReviewItemsTable.organisationId, input.organisationId),
        eq(safeguardingReviewItemsTable.studentSessionId, input.studentSessionId),
        eq(safeguardingReviewItemsTable.dedupeKey, dedupeKey),
      ));
    return duplicate ? { id: duplicate.id, created: false } : null;
  }

  await tx.insert(auditLogTable).values({
    organisationId: input.organisationId,
    teacherId: null,
    action: "safeguarding.review_item.created",
    metadata: {
      reviewItemId: created.id,
      sourceType: input.sourceType,
      stage: input.stage ?? null,
    },
    ipAddress: null,
  });
  return { id: created.id, created: true };
}

export async function notifySafeguardingReviewers(reviewItemId: number): Promise<void> {
  const [item] = await db
    .select({ organisationId: safeguardingReviewItemsTable.organisationId })
    .from(safeguardingReviewItemsTable)
    .where(eq(safeguardingReviewItemsTable.id, reviewItemId));
  if (!item) return;

  const setStatus = async (notificationStatus: "sent" | "partial" | "failed" | "ambiguous" | "not_configured" | "no_reviewer") => {
    await db
      .update(safeguardingReviewItemsTable)
      .set({ notificationStatus, updatedAt: new Date() })
      .where(eq(safeguardingReviewItemsTable.id, reviewItemId));
  };

  if (!isEmailConfigured()) {
    await setStatus("not_configured");
    return;
  }

  const reviewers = await db
    .select({ email: teachersTable.email })
    .from(teachersTable)
    .innerJoin(organisationsTable, eq(teachersTable.organisationId, organisationsTable.id))
    .where(and(
      eq(teachersTable.organisationId, item.organisationId),
      isNull(organisationsTable.deletedAt),
      eq(teachersTable.canReviewSafeguarding, true),
      eq(teachersTable.accountStatus, "active"),
      eq(teachersTable.approvalStatus, "approved"),
      eq(teachersTable.emailVerified, true),
    ));
  if (reviewers.length === 0) {
    await setStatus("no_reviewer");
    return;
  }

  const subject = "Safeguarding Review Item requires attention";
  const text = "A Safeguarding Review Item requires attention in e-Assisted Climb. Please sign in securely to review it.";
  const html = "<p>A Safeguarding Review Item requires attention in e-Assisted Climb. Please sign in securely to review it.</p>";
  const results = await Promise.allSettled(reviewers.map(({ email }) =>
    sendEmail({ to: email, subject, text, html }),
  ));
  const sentCount = results.filter((result) => result.status === "fulfilled").length;
  if (sentCount === results.length) {
    await setStatus("sent");
    return;
  }
  if (sentCount > 0) {
    await setStatus("partial");
    return;
  }
  const ambiguous = results.some((result) => {
    if (result.status !== "rejected") return false;
    const error = result.reason as { responseCode?: unknown } | null;
    return !Number.isInteger(error?.responseCode);
  });
  await setStatus(ambiguous ? "ambiguous" : "failed");
}