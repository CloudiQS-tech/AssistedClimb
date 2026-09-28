import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { cigAdminsTable } from "./cigAdmins";

export const organisationDeletionShadowsTable = pgTable("organisation_deletion_shadows", {
  id: serial("id").primaryKey(),
  organisationId: integer("organisation_id").notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().defaultNow(),
  deletedByCigAdminId: integer("deleted_by_cig_admin_id").references(() => cigAdminsTable.id, { onDelete: "set null" }),
});

export type OrganisationDeletionShadow = typeof organisationDeletionShadowsTable.$inferSelect;