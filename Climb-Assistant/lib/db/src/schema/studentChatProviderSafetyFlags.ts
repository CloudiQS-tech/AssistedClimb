import { integer, pgTable } from "drizzle-orm/pg-core";
import { chatMessagesTable } from "./chatMessages";

export const studentChatProviderSafetyFlagsTable = pgTable(
  "student_chat_provider_safety_flags",
  {
    chatMessageId: integer("chat_message_id")
      .primaryKey()
      .references(() => chatMessagesTable.id, { onDelete: "cascade" }),
  },
);