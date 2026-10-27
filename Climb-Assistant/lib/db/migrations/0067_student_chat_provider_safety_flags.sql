CREATE TABLE IF NOT EXISTS student_chat_provider_safety_flags (
  chat_message_id integer PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE
);