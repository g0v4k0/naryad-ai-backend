import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const asyncHandler =
  (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof HttpError) {
    if (error.status === 429 && "retryAfter" in error) res.setHeader("retry-after", String(error.retryAfter));
    return res.status(error.status).json({ error: error.message });
  }
  if (error instanceof Error && error.name === "ZodError") {
    return res.status(400).json({ error: "Ошибка в данных запроса", details: error.message });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2025") return res.status(404).json({ error: "Запись не найдена" });
    if (error.code === "P2003") return res.status(409).json({ error: "Запись используется в других данных и не может быть изменена или удалена" });
    if (error.code === "P2002") return res.status(409).json({ error: "Такая запись уже существует" });
  }
  console.error(error);
  return res.status(500).json({ error: "Внутренняя ошибка сервера" });
}
