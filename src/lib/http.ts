import type { NextFunction, Request, Response } from "express";

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
    return res.status(error.status).json({ error: error.message });
  }
  if (error instanceof Error && error.name === "ZodError") {
    return res.status(400).json({ error: "Ошибка в данных запроса", details: error.message });
  }
  console.error(error);
  return res.status(500).json({ error: "Внутренняя ошибка сервера" });
}
