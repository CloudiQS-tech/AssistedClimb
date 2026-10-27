import { and, eq, isNotNull } from "drizzle-orm";
import { db, organisationsTable } from "@workspace/db";
import {
  decryptAiCredential,
  encryptAiCredential,
  isLegacyAiCredentialCiphertext,
} from "./crypto";

export type AiCredentialMigrationResult = {
  processed: number;
  concurrentChangesSkipped: number;
};

export async function migrateAiCredentialEncryption(
  apply: boolean,
): Promise<AiCredentialMigrationResult> {
  let processed = 0;
  let concurrentChangesSkipped = 0;

  await db.transaction(async (tx) => {
    const selection = tx
      .select({
        id: organisationsTable.id,
        ciphertext: organisationsTable.aiKeyEncrypted,
      })
      .from(organisationsTable)
      .where(isNotNull(organisationsTable.aiKeyEncrypted));
    const organisations = apply
      ? await selection.for("update")
      : await selection;

    for (const organisation of organisations) {
      const ciphertext = organisation.ciphertext;
      if (!ciphertext || !isLegacyAiCredentialCiphertext(ciphertext)) continue;

      const plaintext = decryptAiCredential(ciphertext);
      if (apply) {
        const updated = await tx
          .update(organisationsTable)
          .set({ aiKeyEncrypted: encryptAiCredential(plaintext) })
          .where(and(
            eq(organisationsTable.id, organisation.id),
            eq(organisationsTable.aiKeyEncrypted, ciphertext),
          ))
          .returning({ id: organisationsTable.id });
        if (updated.length !== 1) {
          concurrentChangesSkipped += 1;
          continue;
        }
      }
      processed += 1;
    }
  });

  return { processed, concurrentChangesSkipped };
}