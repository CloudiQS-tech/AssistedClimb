import "express-session";

declare module "express-session" {
  interface SessionData {
    teacherId?: number;
    studentSessionId?: number;
    studentNonce?: string;
    siteAuthed?: boolean;
    pendingTotpTeacherId?: number;
  }
}
