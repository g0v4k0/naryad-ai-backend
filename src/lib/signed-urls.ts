import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";

const PREFIX = "/uploads/";
const key = createHmac("sha256", config.JWT_SECRET).update("uploads-url-signing").digest();

function signature(path: string, expires: number) {
  return createHmac("sha256", key).update(`${path}:${expires}`).digest("base64url");
}

export function signUploadUrl(url: string, now = Date.now()) {
  const path = stripQuery(url);
  // Round expiry to the hour so repeated responses reuse the same URL and clients can cache images.
  const expires = Math.ceil((now + config.UPLOAD_URL_TTL_HOURS * 3_600_000) / 3_600_000) * 3600;
  return `${path}?exp=${expires}&sig=${signature(path, expires)}`;
}

export function stripQuery(url: string) {
  const index = url.indexOf("?");
  return index === -1 ? url : url.slice(0, index);
}

/** Clients send back the signed links they received; store our own uploads without the signature. */
export function normalizePhotoUrl(url: string) {
  return url.startsWith(PREFIX) ? stripQuery(url) : url;
}

/** Deep-copies plain JSON-like values, signing every "/uploads/..." string; Dates, Decimals etc. are kept as is. */
export function signUploadUrls<T>(value: T): T {
  if (typeof value === "string") return (value.startsWith(PREFIX) ? signUploadUrl(value) : value) as T;
  if (Array.isArray(value)) return value.map(signUploadUrls) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, signUploadUrls(v)])) as T;
  }
  return value;
}

/** Response middleware: signs upload links in every JSON body so <img src> keeps working without a header. */
export function signJsonUploadUrls(_req: Request, res: Response, next: NextFunction) {
  const json = res.json.bind(res);
  res.json = (body: unknown) => json(signUploadUrls(body));
  next();
}

/** Access to /uploads: a valid signature, or a Bearer JWT for API clients. */
export function requireUploadAccess(req: Request, res: Response, next: NextFunction) {
  const path = `${PREFIX}${req.path.replace(/^\//, "")}`;
  const expires = Number(req.query.exp);
  const sig = typeof req.query.sig === "string" ? req.query.sig : "";
  if (sig && Number.isFinite(expires) && expires * 1000 > Date.now()) {
    const expected = Buffer.from(signature(path, expires));
    const given = Buffer.from(sig);
    if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
  }
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (token) {
    try {
      jwt.verify(token, config.JWT_SECRET);
      return next();
    } catch { /* fall through */ }
  }
  res.status(401).json({ error: "Нужна авторизация или подписанная ссылка" });
}
