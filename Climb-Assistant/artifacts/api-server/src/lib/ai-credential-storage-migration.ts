import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { createHash, timingSafeEqual } from "crypto";
import { db, organisationsTable } from "@workspace/db";
import { decryptAiCredential, encryptAiCredential } from "./crypto";
import {
  createAiCredentialSecret,
  deleteAiCredentialSecret,
  getAiCredentialSecret,
} from "./ai-credential-secret-store";
import { enqueueAiCredentialSecretCleanup } from "./ai-credential-secret-cleanup-queue";

function sameCredential(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left, "utf8").digest();
  const rightHash = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftHash, rightHash);
}

export function deriveAiCredentialMigrationReference(
  organisationId: number,
  ciphertext: string,
): string {
  return createHash("sha256")
    .update(`ai-credential-migration:${organisationId}:${ciphertext}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

export type AiCredentialMigrationCounts = {
  examined: number;
  eligible: number;
  processed: number;
  skipped: number;
  failures: number;
};

export async function dryRunAiCredentialStorageMigration(): Promise<AiCredentialMigrationCounts> {
  const rows = await db
    .select({
      id: organisationsTable.id,
      ciphertext: organisationsTable.aiKeyEncrypted,
      secretRef: organisationsTable.aiKeySecretRef,
    })
    .from(organisationsTable)
    .where(isNotNull(organisationsTable.aiKeyEncrypted));

  let eligible = 0;
  let failures = 0;
  for (const row of rows) {
    if (row.secretRef || !row.ciphertext) continue;
    eligible += 1;
    try {
      decryptAiCredential(row.ciphertext);
    } catch {
      failures += 1;
    }
  }
  return {
    examined: rows.length,
    eligible,
    processed: 0,
    skipped: 0,
    failures,
  };
}

export async function migrateAiCredentialStorage(): Promise<AiCredentialMigrationCounts> {
  const candidates = await db
    .select({ id: organisationsTable.id })
    .from(organisationsTable)
    .where(and(
      isNotNull(organisationsTable.aiKeyEncrypted),
      isNull(organisationsTable.aiKeySecretRef),
    ));

  let processed = 0;
  let skipped = 0;
  let failures = 0;
  for (const candidate of candidates) {
    let reference: string | null = null;
    let organisationId = candidate.id;
    try {
      const result = await db.transaction(async (tx) => {
        const [current] = await tx
          .select({
            id: organisationsTable.id,
            ciphertext: organisationsTable.aiKeyEncrypted,
            secretRef: organisationsTable.aiKeySecretRef,
          })
          .from(organisationsTable)
          .where(eq(organisationsTable.id, candidate.id))
          .for("update");
        if (!current?.ciphertext || current.secretRef) return "skipped" as const;

        organisationId = current.id;
        const credential = decryptAiCredential(current.ciphertext);
        reference = deriveAiCredentialMigrationReference(current.id, current.ciphertext);
        await createAiCredentialSecret(current.id, credential, reference);
        const updated = await tx
          .update(organisationsTable)
          .set({ aiKeySecretRef: reference })
          .where(and(
            eq(organisationsTable.id, current.id),
            eq(organisationsTable.aiKeyEncrypted, current.ciphertext),
            isNull(organisationsTable.aiKeySecretRef),
          ))
          .returning({ id: organisationsTable.id });
        return updated.length === 1 ? "processed" as const : "skipped" as const;
      });
      if (result === "processed") processed += 1;
      else skipped += 1;
    } catch {
      failures += 1;
      if (reference) {
        try {
          const [current] = await db
            .select({ secretRef: organisationsTable.aiKeySecretRef })
            .from(organisationsTable)
            .where(eq(organisationsTable.id, organisationId));
          if (current?.secretRef !== reference) {
            await deleteAiCredentialSecret(organisationId, reference);
          }
        } catch {
          // Do not log the secret or delete a reference whose commit outcome is unknown.
        }
      }
    }
  }
  return {
    examined: candidates.length,
    eligible: candidates.length,
    processed,
    skipped,
    failures,
  };
}

export async function verifyAiCredentialStorageMigration(): Promise<AiCredentialMigrationCounts> {
  const rows = await db
    .select({
      id: organisationsTable.id,
      ciphertext: organisationsTable.aiKeyEncrypted,
      secretRef: organisationsTable.aiKeySecretRef,
    })
    .from(organisationsTable)
    .where(isNotNull(organisationsTable.aiKeySecretRef));
  let failures = 0;
  for (const row of rows) {
    try {
      if (!row.secretRef) throw new Error();
      const secret = await getAiCredentialSecret(row.id, row.secretRef);
      if (!secret) throw new Error();
      if (row.ciphertext && !sameCredential(decryptAiCredential(row.ciphertext), secret)) {
        failures += 1;
      }
    } catch {
      failures += 1;
    }
  }
  return {
    examined: rows.length,
    eligible: rows.length,
    processed: rows.length - failures,
    skipped: 0,
    failures,
  };
}

export async function retireVerifiedAiCredentialCiphertexts(): Promise<AiCredentialMigrationCounts> {
  const candidates = await db
    .select({ id: organisationsTable.id })
    .from(organisationsTable)
    .where(and(
      isNotNull(organisationsTable.aiKeySecretRef),
      isNotNull(organisationsTable.aiKeyEncrypted),
    ));
  let processed = 0;
  let skipped = 0;
  let failures = 0;

  for (const candidate of candidates) {
    try {
      const result = await db.transaction(async (tx) => {
        const [current] = await tx
          .select({
            id: organisationsTable.id,
            ciphertext: organisationsTable.aiKeyEncrypted,
            secretRef: organisationsTable.aiKeySecretRef,
          })
          .from(organisationsTable)
          .where(eq(organisationsTable.id, candidate.id))
          .for("update");
        if (!current?.ciphertext || !current.secretRef) return "skipped" as const;

        const secret = await getAiCredentialSecret(current.id, current.secretRef);
        const legacyCredential = decryptAiCredential(current.ciphertext);
        if (!sameCredential(secret, legacyCredential)) return "skipped" as const;

        const updated = await tx
          .update(organisationsTable)
          .set({ aiKeyEncrypted: null })
          .where(and(
            eq(organisationsTable.id, current.id),
            eq(organisationsTable.aiKeyEncrypted, current.ciphertext),
            eq(organisationsTable.aiKeySecretRef, current.secretRef),
          ))
          .returning({ id: organisationsTable.id });
        return updated.length === 1 ? "processed" as const : "skipped" as const;
      });
      if (result === "processed") processed += 1;
      else skipped += 1;
    } catch {
      failures += 1;
    }
  }

  return {
    examined: candidates.length,
    eligible: candidates.length,
    processed,
    skipped,
    failures,
  };
}

export async function rollbackAiCredentialStorageMigration(): Promise<AiCredentialMigrationCounts> {
  const candidates = await db
    .select({ id: organisationsTable.id })
    .from(organisationsTable)
    .where(isNotNull(organisationsTable.aiKeySecretRef));
  let processed = 0;
  let skipped = 0;
  let failures = 0;

  for (const candidate of candidates) {
    try {
      const result = await db.transaction(async (tx) => {
        const [current] = await tx
          .select({
            id: organisationsTable.id,
            secretRef: organisationsTable.aiKeySecretRef,
          })
          .from(organisationsTable)
          .where(eq(organisationsTable.id, candidate.id))
          .for("update");
        if (!current?.secretRef) return "skipped" as const;

        const credential = await getAiCredentialSecret(current.id, current.secretRef);
        const updated = await tx
          .update(organisationsTable)
          .set({
            aiKeyEncrypted: encryptAiCredential(credential),
            aiKeySecretRef: null,
          })
          .where(and(
            eq(organisationsTable.id, current.id),
            eq(organisationsTable.aiKeySecretRef, current.secretRef),
          ))
          .returning({ id: organisationsTable.id });
        if (updated.length !== 1) return "skipped" as const;
        await enqueueAiCredentialSecretCleanup(tx, current.id, current.secretRef);
        return "processed" as const;
      });
      if (result === "processed") processed += 1;
      else skipped += 1;
    } catch {
      failures += 1;
    }
  }

  return {
    examined: candidates.length,
    eligible: candidates.length,
    processed,
    skipped,
    failures,
  };
}