import type { Teacher } from "@workspace/db";

declare global {
  namespace Express {
    interface Request {
      teacher?: Teacher;
      studentSession?: {
        id: number;
        classId: number;
        studentName: string;
        createdAt: Date;
        className: string;
      };
    }
  }
}

export {};
