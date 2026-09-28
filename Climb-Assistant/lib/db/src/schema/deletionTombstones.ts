import { pgTable, bigserial, text, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

export const deletionTombstoneEntityTypes = [
  "organisation",
  "teacher",
  "class",
  "student_record",
  "stage_entry",
  "chat_message",
  "teacher_feedback",
  "student_activity",
  "security_audit",
  "student_identity",
  "teacher_identity",
] as const;

/**
 * Append-only, non-personal identifiers used only to stop deleted application
 * records being resurrected by restoration of an older database backup.
 */
export const deletionTombstonesTable = pgTable(
  "deletion_tombstones",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    entityType: text("entity_type", { enum: deletionTombstoneEntityTypes }).notNull(),
    entityId: integer("entity_id").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("deletion_tombstones_entity_unique").on(table.entityType, table.entityId),
    index("deletion_tombstones_deleted_at_idx").on(table.deletedAt),
  ],
);

export type DeletionTombstoneEntityType = typeof deletionTombstoneEntityTypes[number];