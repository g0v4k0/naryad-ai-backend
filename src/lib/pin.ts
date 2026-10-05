import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import bcrypt from "bcryptjs";

// scrypt runs on the libuv thread pool, so hashing does not block the event loop (bcryptjs does).
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } satisfies ScryptOptions;
const KEY_LENGTH = 32;
const PREFIX = "scrypt";

function derive(pin: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => scrypt(pin, salt, KEY_LENGTH, PARAMS, (error, key) => error ? reject(error) : resolve(key)));
}

export async function hashPin(pin: string) {
  const salt = randomBytes(16);
  const key = await derive(pin, salt);
  return `${PREFIX}$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** Verifies scrypt hashes and legacy bcrypt hashes; legacy matches report needsRehash. */
export async function verifyPin(pin: string, stored: string): Promise<{ ok: boolean; needsRehash: boolean }> {
  if (stored.startsWith(`${PREFIX}$`)) {
    const [, n, r, p, salt, key] = stored.split("$");
    const expected = Buffer.from(key, "base64");
    const actual = await new Promise<Buffer>((resolve, reject) =>
      scrypt(pin, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem }, (error, k) => error ? reject(error) : resolve(k)));
    return { ok: timingSafeEqual(actual, expected), needsRehash: Number(n) !== PARAMS.N };
  }
  const ok = await bcrypt.compare(pin, stored);
  return { ok, needsRehash: ok };
}
