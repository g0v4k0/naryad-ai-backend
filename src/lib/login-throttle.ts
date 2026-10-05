import { config } from "../config.js";
import { HttpError } from "./http.js";

type Bucket = { failures: number; firstAt: number; lockedUntil: number };
const byLogin = new Map<string, Bucket>();
const byIp = new Map<string, Bucket>();

class TooManyAttempts extends HttpError {
  constructor(public retryAfter: number) {
    super(429, `Слишком много неудачных попыток входа. Повторите через ${Math.ceil(retryAfter / 60)} мин.`);
  }
}

function check(map: Map<string, Bucket>, key: string, now: number) {
  const bucket = map.get(key);
  if (bucket && bucket.lockedUntil > now) throw new TooManyAttempts(Math.ceil((bucket.lockedUntil - now) / 1000));
}

function fail(map: Map<string, Bucket>, key: string, limit: number, now: number) {
  const windowMs = config.LOGIN_LOCK_MINUTES * 60_000;
  let bucket = map.get(key);
  if (!bucket || now - bucket.firstAt > windowMs) bucket = { failures: 0, firstAt: now, lockedUntil: 0 };
  bucket.failures++;
  if (bucket.failures >= limit) bucket.lockedUntil = now + windowMs;
  map.set(key, bucket);
}

/** Throws 429 while the login or the client IP is locked out. */
export function assertLoginAllowed(login: string, ip: string, now = Date.now()) {
  check(byLogin, login.toLowerCase(), now);
  check(byIp, ip, now);
}

export function registerLoginFailure(login: string, ip: string, now = Date.now()) {
  fail(byLogin, login.toLowerCase(), config.LOGIN_MAX_ATTEMPTS, now);
  fail(byIp, ip, config.LOGIN_MAX_ATTEMPTS_PER_IP, now);
}

export function registerLoginSuccess(login: string) {
  byLogin.delete(login.toLowerCase());
}

export function resetLoginThrottle() {
  byLogin.clear();
  byIp.clear();
}
