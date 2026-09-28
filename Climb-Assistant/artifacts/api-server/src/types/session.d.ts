import "express-session";

declare module "express-session" {
  interface SessionData {
    teacherId?: number;
    studentSessionId?: number;
    studentActivityId?: number;
    studentLoginSessionId?: string;
    studentNonce?: string;
    siteAuthed?: boolean;
    pendingTotpTeacherId?: number;
    pendingTotpSetupTeacherId?: number;
    cigAdminId?: number;
    cigAdminSessionVersion?: number;
    pendingCigAdminId?: number;
    pendingCigAdminSessionVersion?: number;
    cigAdminMfaStepUpAt?: number;
    cigAdminMfaStepUpSessionVersion?: number;
    sessionStartedAt?: number;
    lastActivityAt?: number;
  }
}
