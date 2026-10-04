// API keys: `rh_` + 32 random bytes (hex). Only the SHA-256 hash is stored;
// the raw key is shown once at creation time.

import { createHash, randomBytes, timingSafeEqual } from "crypto";

export function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const raw = "rh_" + randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash, prefix: raw.slice(0, 11) };
}

export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
