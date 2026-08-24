import type { Request, Response, NextFunction } from "express";

export function requireTeacher(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.session?.teacherId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}
