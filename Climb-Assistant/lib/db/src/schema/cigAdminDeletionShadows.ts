import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { cigAdminsTable } from "./cigAdmins";

export const cigAdminDeletionShadowsTable = pgTable("cig_admin_deletion_shadows", {
  id: serial("id").primaryKey(),
  cigAdminId: integer("cig_admin_id").notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().defaultNow(),
  deletedByCigAdminId: integer("deleted_by_cig_admin_id").references(() => cigAdminsTable.id, { onDelete: "set null" }),
});

export type CigAdminDeletionShadow = typeof cigAdminDeletionShadowsTable.$inferSelect;