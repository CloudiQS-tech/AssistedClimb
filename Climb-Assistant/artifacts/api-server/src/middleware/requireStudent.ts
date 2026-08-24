import type { Request, Response, NextFunction } from "express";

export function requireStudent(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.session?.studentSessionId) {
    res.status(401).json({ error: "Student session required" });
    return;
  }
  next();
}
