import { createServer } from "node:http";
import app from "../src/app";
import { createPreviewStudentSession, createPreviewTeacherSession } from "../src/lib/preview-session";
import { pool } from "@workspace/db";

const studentSessionId = Number(process.argv[2]);
const teacherId = Number(process.argv[3]);
if (!Number.isInteger(studentSessionId) || !Number.isInteger(teacherId)) {
  throw new Error("student session and teacher IDs are required");
}

const studentToken = createPreviewStudentSession(studentSessionId, `activity-test-${studentSessionId}`);
const teacherToken = createPreviewTeacherSession(teacherId);
if (!studentToken || !teacherToken) {
  throw new Error("preview sessions are required for the activity timing test");
}

const server = createServer(app);
const shutdown = async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
};
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not receive a TCP address");
  process.stdout.write(`${JSON.stringify({
    port: address.port,
    studentToken,
    teacherToken,
  })}\n`);
});