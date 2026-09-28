import {
  deletionTombstonesTable,
  type DeletionTombstoneEntityType,
} from "@workspace/db";

type TombstoneWriter = Pick<typeof import("@workspace/db").db, "insert">;

export type DeletionTombstone = {
  entityType: DeletionTombstoneEntityType;
  entityId: number;
};

export async function recordDeletionTombstones(
  tx: TombstoneWriter,
  tombstones: DeletionTombstone[],
  deletedAt = new Date(),
): Promise<void> {
  const unique = new Map<string, DeletionTombstone>();
  for (const tombstone of tombstones) {
    if (!Number.isInteger(tombstone.entityId) || tombstone.entityId <= 0) {
      throw new Error("Deletion tombstones require positive integer identifiers");
    }
    unique.set(`${tombstone.entityType}:${tombstone.entityId}`, tombstone);
  }
  if (!unique.size) return;
  await tx.insert(deletionTombstonesTable)
    .values([...unique.values()].map((tombstone) => ({ ...tombstone, deletedAt })))
    .onConflictDoNothing({
      target: [deletionTombstonesTable.entityType, deletionTombstonesTable.entityId],
    });
}