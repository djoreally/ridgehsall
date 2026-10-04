// Auth helpers for the v1 API (API-key) and the cron endpoint (CRON_SECRET).

import { NextRequest } from "next/server";
import { db } from "./db";
import { hashApiKey } from "./apikey";

export interface ApiAuth {
  workspaceId: string;
  keyId: string;
}

/** Authenticate via the `x-api-key` header. Returns null when missing/invalid/revoked. */
export async function authenticateApiKey(req: NextRequest): Promise<ApiAuth | null> {
  const raw = req.headers.get("x-api-key");
  if (!raw) return null;
  const keyHash = hashApiKey(raw);
  const key = await db.apiKey.findUnique({ where: { keyHash } });
  if (!key || key.revokedAt) return null;
  await db.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return { workspaceId: key.workspaceId, keyId: key.id };
}

/** Guard for /api/cron/daily: Bearer CRON_SECRET or ?secret=CRON_SECRET. */
export function checkCronSecret(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${expected}`) return true;
  const url = new URL(req.url);
  if (url.searchParams.get("secret") === expected) return true;
  return false;
}
