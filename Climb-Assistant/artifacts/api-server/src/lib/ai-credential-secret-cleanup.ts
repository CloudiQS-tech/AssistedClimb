import { and, eq, isNull, lte } from "drizzle-orm";
import {
  aiCredentialSecretCleanupTable,
  db,
} from "@workspace/db";
import { logger } from "./logger";
import { deleteAiCredentialSecret } from "./ai-credential-secret-store";

const BATCH_SIZE = 25;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

let cleanupRunning = false;

export async function processAiCredentialSecretCleanup(
  now = new Date(),
): Promise<{ processed: number; failed: number }> {
  const jobs = await db
    .select()
    .from(aiCredentialSecretCleanupTable)
    .where(and(
      isNull(aiCredentialSecretCleanupTable.completedAt),
      lte(aiCredentialSecretCleanupTable.nextAttemptAt, now),
    ))
    .orderBy(aiCredentialSecretCleanupTable.id)
    .limit(BATCH_SIZE);

  let processed = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      await deleteAiCredentialSecret(job.organisationId, job.secretRef);
      await db
        .update(aiCredentialSecretCleanupTable)
        .set({ completedAt: new Date() })
        .where(and(
          eq(aiCredentialSecretCleanupTable.id, job.id),
          isNull(aiCredentialSecretCleanupTable.completedAt),
        ));
      processed += 1;
    } catch {
      const attempts = job.attempts + 1;
      const retryDelay = Math.min(30_000 * (2 ** Math.min(attempts - 1, 10)), MAX_RETRY_DELAY_MS);
      await db
        .update(aiCredentialSecretCleanupTable)
        .set({
          attempts,
          nextAttemptAt: new Date(Date.now() + retryDelay),
        })
        .where(and(
          eq(aiCredentialSecretCleanupTable.id, job.id),
          isNull(aiCredentialSecretCleanupTable.completedAt),
        ));
      failed += 1;
      logger.warn({ cleanupJobId: job.id, attempts }, "AI credential secret cleanup will retry");
    }
  }
  return { processed, failed };
}

async function runCleanupSafely(): Promise<void> {
  if (cleanupRunning) return;
  cleanupRunning = true;
  try {
    const result = await processAiCredentialSecretCleanup();
    if (result.processed > 0 || result.failed > 0) {
      logger.info(result, "AI credential secret cleanup processed");
    }
  } catch (error) {
    logger.error({ err: error }, "AI credential secret cleanup failed");
  } finally {
    cleanupRunning = false;
  }
}

export function startAiCredentialSecretCleanup(): void {
  void runCleanupSafely();
  const interval = setInterval(() => void runCleanupSafely(), CLEANUP_INTERVAL_MS);
  interval.unref();
}