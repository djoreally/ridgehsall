// Per-contact signed unsubscribe tokens. One click, no login:
//   GET /api/unsubscribe/:token  (also accepts POST for one-click RFC 8058)
//
// Token format: base64url(contactId) + "." + base64url(HMAC_SHA256(secret, contactId))

import { createHmac, randomBytes } from "crypto";

function getSecret(): string {
  const s = process.env.UNSUBSCRIBE_SECRET;
  if (s && s.length >= 16) return s;
  // v0 fallback: random per-process secret. Tokens invalidate on restart.
  // Set UNSUBSCRIBE_SECRET in production.
  if (!globalThis.__unsubSecret) {
    globalThis.__unsubSecret = randomBytes(32).toString("hex");
    console.warn("[ridgehsall] UNSUBSCRIBE_SECRET not set — using ephemeral per-process secret");
  }
  return globalThis.__unsubSecret as string;
}

declare global {
  // eslint-disable-next-line no-var
  var __unsubSecret: string | undefined;
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

export function signUnsubscribeToken(contactId: string): string {
  const idPart = b64urlEncode(Buffer.from(contactId, "utf8"));
  const sig = createHmac("sha256", getSecret()).update(contactId, "utf8").digest();
  return `${idPart}.${b64urlEncode(sig)}`;
}

/** Returns the contactId if the token is valid, otherwise null. */
export function verifyUnsubscribeToken(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  let contactId: string;
  try {
    contactId = b64urlDecode(parts[0]).toString("utf8");
  } catch {
    return null;
  }
  if (!contactId) return null;
  const expected = createHmac("sha256", getSecret()).update(contactId, "utf8").digest();
  let provided: Buffer;
  try {
    provided = b64urlDecode(parts[1]);
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  // timing-safe compare
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ provided[i];
  return diff === 0 ? contactId : null;
}

export function unsubscribeUrlFor(contactId: string): string {
  const base = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
  return `${base}/api/unsubscribe/${signUnsubscribeToken(contactId)}`;
}
