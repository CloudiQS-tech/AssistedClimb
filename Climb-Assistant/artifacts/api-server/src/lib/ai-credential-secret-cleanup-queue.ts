import { aiCredentialSecretCleanupTable } from "@workspace/db";

type InsertExecutor = {
  insert(table: typeof aiCredentialSecretCleanupTable): {
    values(value: {
      organisationId: number;
      secretRef: string;
    }): {
      onConflictDoNothing(): Promise<unknown>;
    };
  };
};

export async function enqueueAiCredentialSecretCleanup(
  executor: InsertExecutor,
  organisationId: number,
  secretRef: string,
): Promise<void> {
  if (!Number.isSafeInteger(organisationId) || organisationId < 1 || !/^[a-f0-9]{32}$/.test(secretRef)) {
    throw new Error("Invalid AI credential cleanup reference.");
  }
  await executor
    .insert(aiCredentialSecretCleanupTable)
    .values({ organisationId, secretRef })
    .onConflictDoNothing();
}