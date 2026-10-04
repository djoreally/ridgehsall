// Hosted mode: the platform sends on the user's behalf via Resend, so a new
// signup can send immediately with zero provider setup.
//
// Reputation protection for the shared sending domain:
//  - a per-workspace daily send cap (HOSTED_DAILY_SEND_CAP, default 1000),
//    enforced in lib/send.ts before a batch goes out;
//  - Resend bounce/complaint webhooks auto-suppress offenders (lib/resend.ts);
//  - every send carries List-Unsubscribe headers (lib/send.ts).

import { db } from "./db";
import { startOfDayUtc } from "./scheduler";

export function isHostedMode(): boolean {
  return process.env.HOSTED_MODE === "true";
}

/** Max emails one workspace may send per UTC day in hosted mode. */
export function hostedDailyCap(): number {
  const raw = process.env.HOSTED_DAILY_SEND_CAP;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1000;
}

/** Successfully sent emails today (UTC) for a workspace — cap accounting. */
export async function sentTodayCount(workspaceId: string, now: Date = new Date()): Promise<number> {
  // SendLog carries contactId but no relation, so resolve the workspace's
  // contact ids first, then count today's sent rows against them.
  const contacts = await db.contact.findMany({
    where: { list: { workspaceId } },
    select: { id: true },
  });
  if (contacts.length === 0) return 0;
  return db.sendLog.count({
    where: {
      status: "sent",
      sentAt: { gte: startOfDayUtc(now) },
      contactId: { in: contacts.map((c) => c.id) },
    },
  });
}
