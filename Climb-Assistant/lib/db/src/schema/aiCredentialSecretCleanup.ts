import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const aiCredentialSecretCleanupTable = pgTable(
  "ai_credential_secret_cleanup",
  {
    id: serial("id").primaryKey(),
    organisationId: integer("organisation_id").notNull(),
    secretRef: text("secret_ref").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    uniqueReference: uniqueIndex("ai_credential_secret_cleanup_unique_ref")
      .on(table.organisationId, table.secretRef),
    pendingJobs: index("ai_credential_secret_cleanup_pending_idx")
      .on(table.completedAt, table.nextAttemptAt),
  }),
);

export type AiCredentialSecretCleanup = typeof aiCredentialSecretCleanupTable.$inferSelect;