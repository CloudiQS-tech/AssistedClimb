import { eq } from "drizzle-orm";
import { db, organisationsTable } from "@workspace/db";
import { deleteAiCredentialSecret } from "./ai-credential-secret-store";
import { enqueueAiCredentialSecretCleanup } from "./ai-credential-secret-cleanup-queue";

export async function cleanupAiCredentialSecretIfUnreferenced(
  organisationId: number,
  secretRef: string,
): Promise<void> {
  const result = await db.transaction(async (tx) => {
    const [organisation] = await tx
      .select({ secretRef: organisationsTable.aiKeySecretRef })
      .from(organisationsTable)
      .where(eq(organisationsTable.id, organisationId))
      .for("update");

    if (organisation?.secretRef === secretRef) return "referenced" as const;
    if (organisation) {
      await enqueueAiCredentialSecretCleanup(tx, organisationId, secretRef);
      return "queued" as const;
    }
    return "unreferenced" as const;
  });

  if (result === "referenced") return;
  try {
    await deleteAiCredentialSecret(organisationId, secretRef);
  } catch {
    if (result === "queued") return;
    try {
      await enqueueAiCredentialSecretCleanup(db, organisationId, secretRef);
    } catch {
      // If the organisation no longer exists, a queue row may not be permitted.
    }
  }
}