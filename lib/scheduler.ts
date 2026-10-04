// Scheduler core — the heart of ridgehsall.
//
// The contract: every day, each active list deals out a batch containing only
// contacts whose cooldown has expired. A contact is NEVER in two batches less
// than intervalDays apart. The pure functions below encode that invariant; the
// orchestration layer (`computeTodaysBatches` / `sendBatch`) applies them with
// Prisma and enforces idempotency via the Batch @@unique([listId, date]) key.

import { db } from "./db";
import type { Frequency } from "./enums";

export const INTERVAL_DAYS: Record<Exclude<Frequency, "custom">, number> = {
  daily: 1,
  weekly: 7,
  biweekly: 14,
  monthly: 30,
};

/** Resolve a list's frequency to a cooldown in days. Throws on invalid config. */
export function intervalDaysFor(frequency: Frequency, customDays?: number | null): number {
  if (frequency === "custom") {
    if (!customDays || !Number.isInteger(customDays) || customDays < 1) {
      throw new Error("custom frequency requires customDays to be a positive integer");
    }
    return customDays;
  }
  return INTERVAL_DAYS[frequency];
}

/**
 * Default daily batch size: sized so the whole active list rotates exactly
 * within one frequency window. e.g. 1,019 contacts on a 21-day custom cycle
 * -> ceil(1019/21) = 49/day.
 */
export function defaultDailyCap(activeCount: number, intervalDays: number): number {
  if (activeCount <= 0) return 0;
  return Math.max(1, Math.ceil(activeCount / intervalDays));
}

export interface DueCandidate {
  id: string;
  email: string;
  nextDueAt: Date;
  status: string;
}

export interface PickOptions {
  /** "today" at day granularity — contacts due at or before this instant are eligible */
  today: Date;
  dailyCap: number;
  /** workspace-level suppression emails (lowercased) */
  suppression: Set<string>;
}

/**
 * Pick today's batch from eligible contacts.
 * Eligible = status active, nextDueAt <= today, not suppressed.
 * Ordered oldest-due first (nextDueAt asc, id tiebreak) so the rotation is fair,
 * then capped at dailyCap.
 */
export function pickBatchContacts(
  candidates: DueCandidate[],
  opts: PickOptions
): DueCandidate[] {
  const todayMs = opts.today.getTime();
  return candidates
    .filter(
      (c) =>
        c.status === "active" &&
        c.nextDueAt.getTime() <= todayMs &&
        !opts.suppression.has(c.email.toLowerCase())
    )
    .sort((a, b) => {
      const d = a.nextDueAt.getTime() - b.nextDueAt.getTime();
      return d !== 0 ? d : a.id.localeCompare(b.id);
    })
    .slice(0, Math.max(0, opts.dailyCap));
}

/** After a successful send: lastSentAt=now, nextDueAt=now+intervalDays. */
export function applySend(now: Date, intervalDays: number): { lastSentAt: Date; nextDueAt: Date } {
  return {
    lastSentAt: now,
    nextDueAt: new Date(now.getTime() + intervalDays * 24 * 60 * 60 * 1000),
  };
}

/** New contacts join the rotation immediately: due now, so they sit at the
 *  back of the due queue behind everyone already waiting. */
export function nextDueAtForNewContact(now: Date): Date {
  return now;
}

export function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export function startOfDayUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ---------------------------------------------------------------------------
// Orchestration (Prisma-backed)
// ---------------------------------------------------------------------------

export interface BatchSummary {
  listId: string;
  listName: string;
  date: string;
  batchId: string;
  reused: boolean; // true if today's batch already existed (idempotent re-run)
  picked: number;
  intervalDays: number;
  dailyCap: number;
}

/**
 * Compute (but do not send) today's batches for every active list in the
 * workspace. Idempotent: re-running for the same date reuses the existing
 * batch row (@@unique([listId, date])) and never duplicates items.
 */
export async function computeTodaysBatches(
  workspaceId: string,
  today: Date = new Date()
): Promise<BatchSummary[]> {
  const day = startOfDayUtc(today);
  const key = dateKey(day);
  const suppressions = await db.suppression.findMany({ where: { workspaceId } });
  const suppressionSet = new Set(suppressions.map((s) => s.email.toLowerCase()));

  const lists = await db.contactList.findMany({
    where: { workspaceId, status: "active" },
    orderBy: { createdAt: "asc" },
  });

  const summaries: BatchSummary[] = [];
  for (const list of lists) {
    const intervalDays = intervalDaysFor(list.frequency as Frequency, list.customDays);
    const activeCount = await db.contact.count({
      where: { listId: list.id, status: "active" },
    });
    const cap = list.dailyCap ?? defaultDailyCap(activeCount, intervalDays);

    // Idempotent get-or-create: concurrent runners collapse onto one batch row.
    let batch = await db.batch.findUnique({
      where: { listId_date: { listId: list.id, date: key } },
    });
    let reused = true;
    if (!batch) {
      batch = await db.batch.create({ data: { listId: list.id, date: key, status: "pending" } });
      reused = false;
    }
    if (batch.status === "sent") {
      summaries.push({ listId: list.id, listName: list.name, date: key, batchId: batch.id, reused: true, picked: 0, intervalDays, dailyCap: cap });
      continue;
    }

    const alreadyQueued = new Set(
      (await db.batchItem.findMany({ where: { batchId: batch.id }, select: { contactId: true } })).map(
        (i) => i.contactId
      )
    );

    const candidates = await db.contact.findMany({
      where: {
        listId: list.id,
        status: "active",
        nextDueAt: { lte: day },
        id: { notIn: [...alreadyQueued] },
      },
      orderBy: [{ nextDueAt: "asc" }, { id: "asc" }],
      take: Math.max(0, cap),
      select: { id: true, email: true, nextDueAt: true, status: true },
    });

    // Belt-and-braces: re-apply suppression at compute time (the DB query
    // can't easily do a case-insensitive NOT IN against the suppression table).
    const picked = pickBatchContacts(candidates, { today: day, dailyCap: cap, suppression: suppressionSet });

    if (picked.length > 0) {
      await db.batchItem.createMany({
        data: picked.map((c) => ({ batchId: batch!.id, contactId: c.id, status: "queued" })),
        skipDuplicates: true,
      });
    }

    summaries.push({
      listId: list.id,
      listName: list.name,
      date: key,
      batchId: batch.id,
      reused,
      picked: picked.length,
      intervalDays,
      dailyCap: cap,
    });
  }
  return summaries;
}
