// Contact ingestion: upsert on (listId, email). New contacts enter the
// rotation immediately (nextDueAt = now, back of the due queue).

import { db } from "./db";
import { nextDueAtForNewContact } from "./scheduler";

export interface IngestContact {
  email: string;
  firstName?: string;
  lastName?: string;
  fields?: Record<string, string>;
}

export interface IngestResult {
  created: number;
  updated: number;
  errors: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_BULK = 5000;

export async function upsertContacts(
  listId: string,
  contacts: IngestContact[],
  source: string
): Promise<IngestResult> {
  const result: IngestResult = { created: 0, updated: 0, errors: [] };
  if (contacts.length > MAX_BULK) {
    result.errors.push(`bulk limit is ${MAX_BULK} contacts per request`);
    contacts = contacts.slice(0, MAX_BULK);
  }

  // normalize + dedupe within the payload (last wins)
  const byEmail = new Map<string, IngestContact>();
  contacts.forEach((c, i) => {
    const email = (c.email ?? "").trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      result.errors.push(`item ${i}: invalid email`);
      return;
    }
    byEmail.set(email, {
      email,
      firstName: c.firstName?.trim() || undefined,
      lastName: c.lastName?.trim() || undefined,
      fields: c.fields,
    });
  });
  if (byEmail.size === 0) return result;

  const emails = [...byEmail.keys()];
  const existing = await db.contact.findMany({
    where: { listId, email: { in: emails } },
    select: { id: true, email: true },
  });
  const existingSet = new Set(existing.map((e) => e.email));
  const now = new Date();

  const toCreate = [...byEmail.values()].filter((c) => !existingSet.has(c.email));
  const toUpdate = [...byEmail.values()].filter((c) => existingSet.has(c.email));

  if (toCreate.length > 0) {
    await db.contact.createMany({
      data: toCreate.map((c) => ({
        listId,
        email: c.email,
        firstName: c.firstName,
        lastName: c.lastName,
        fields: c.fields ? JSON.stringify(c.fields) : null,
        status: "active",
        source,
        nextDueAt: nextDueAtForNewContact(now),
      })),
    });
    result.created = toCreate.length;
  }

  await db.$transaction(
    toUpdate.map((c) =>
      db.contact.update({
        where: { listId_email: { listId, email: c.email } },
        data: {
          firstName: c.firstName,
          lastName: c.lastName,
          ...(c.fields ? { fields: JSON.stringify(c.fields) } : {}),
          source,
          // Re-activate on re-ingest? No — respect explicit unsubscribe/bounce.
          // Leave status and nextDueAt untouched.
        },
      })
    )
  );
  result.updated = toUpdate.length;
  return result;
}
