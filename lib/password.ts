// Password hashing with node:crypto scrypt (no extra deps).
// Stored format: "scrypt$<salt-hex>$<hash-hex>$<N>$<r>$<p>".

import { scrypt as _scrypt, randomBytes, timingSafeEqual } from "node:crypto";

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_LEN = 16;

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    _scrypt(password, salt, keylen, opts, (err, derived) => {
      if (err) reject(err);
      else resolve(derived as Buffer);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const derived = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}$${N}$${R}$${P}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, saltHex, hashHex, nStr, rStr, pStr] = parts;
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    if (salt.length === 0 || expected.length === 0) return false;
    const derived = await scryptAsync(password, salt, expected.length, {
      N: Number(nStr),
      r: Number(rStr),
      p: Number(pStr),
    });
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
