// Pure session store: DB operations with no Next.js request context,
// so they can be unit-tested. Cookie handling lives in lib/session.ts.

import { createHash, randomBytes } from "node:crypto";
import { db } from "./db";

export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSessionRecord(userId: string) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  const session = await db.session.create({
    data: { tokenHash: hashSessionToken(token), userId, expiresAt },
  });
  return { session, token };
}

export async function findSessionUserByToken(token: string | undefined | null) {
  if (!token) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    // Lazy-expiry: drop dead sessions on sight.
    await db.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  return { user: session.user, session };
}

export async function destroySessionRecord(token: string | undefined | null) {
  if (!token) return;
  await db.session.delete({ where: { tokenHash: hashSessionToken(token) } }).catch(() => {});
}
