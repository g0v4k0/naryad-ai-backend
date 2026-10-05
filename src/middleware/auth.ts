import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { Role } from "@prisma/client";
import { config } from "../config.js";
import { HttpError } from "../lib/http.js";

type TokenPayload = { sub: string | number; role: Role };

export function auth(req: Request, _res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return next(new HttpError(401, "Нужна авторизация"));
  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as unknown as TokenPayload;
    req.user = { id: Number(payload.sub), role: payload.role };
    next();
  } catch {
    next(new HttpError(401, "Недействительный токен"));
  }
}

export function allow(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) return next(new HttpError(403, "Недостаточно прав"));
    next();
  };
}
