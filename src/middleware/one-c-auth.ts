import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { HttpError } from "../lib/http.js";

export function oneCAuth(req: Request, _res: Response, next: NextFunction) {
  const supplied = String(req.headers["x-1c-api-key"] ?? "");
  const expected = config.ONE_C_API_KEY;
  const valid = supplied.length === expected.length && supplied.length > 0 && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) return next(new HttpError(401, "Неверный ключ интеграции 1С"));
  next();
}
