import type { Teacher } from "@workspace/db";

declare global {
  namespace Express {
    interface Request {
      teacher?: Teacher;
      studentSession?: {
        id: number;
        classId: number;
        studentName: string;
        registrationStatus: "pending" | "approved" | "rejected";
        createdAt: Date;
        className: string;
        lockedAt: Date | null;
        archivedAt: Date | null;
        retentionUntil: Date | null;
        classArchivedAt: Date | null;
      };
    }
  }
}

export {};
