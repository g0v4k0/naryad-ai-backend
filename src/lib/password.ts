import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";

// scrypt runs on the libuv thread pool, so hashing does not block the event loop (bcryptjs does).
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } satisfies ScryptOptions;
const KEY_LENGTH = 32;
const PREFIX = "scrypt";

function derive(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => scrypt(password, salt, KEY_LENGTH, PARAMS, (error, key) => error ? reject(error) : resolve(key)));
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `${PREFIX}$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** Verifies scrypt hashes and legacy bcrypt hashes; legacy matches report needsRehash. */
export async function verifyPassword(password: string, stored: string): Promise<{ ok: boolean; needsRehash: boolean }> {
  if (stored.startsWith(`${PREFIX}$`)) {
    const [, n, r, p, salt, key] = stored.split("$");
    const expected = Buffer.from(key, "base64");
    const actual = await new Promise<Buffer>((resolve, reject) =>
      scrypt(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem }, (error, k) => error ? reject(error) : resolve(k)));
    return { ok: timingSafeEqual(actual, expected), needsRehash: Number(n) !== PARAMS.N };
  }
  const ok = await bcrypt.compare(password, stored);
  return { ok, needsRehash: ok };
}

/** Rules for a new password (set by an admin or changed by the user). */
export const newPasswordSchema = z.string().min(6, "Пароль должен быть не короче 6 символов").max(128);
