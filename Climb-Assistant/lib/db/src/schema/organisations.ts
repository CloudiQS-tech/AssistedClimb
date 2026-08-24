import { pgTable, serial, text, timestamp, boolean } from "drizzle-orm/pg-core";

export const organisationsTable = pgTable("organisations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  active: boolean("active").notNull().default(true),
  aiProvider: text("ai_provider"),
  aiKeyEncrypted: text("ai_key_encrypted"),
  azureEndpoint: text("azure_endpoint"),
  teacherInviteCode: text("teacher_invite_code").notNull().unique(),
  allowedEmailDomains: text("allowed_email_domains").array(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Organisation = typeof organisationsTable.$inferSelect;
