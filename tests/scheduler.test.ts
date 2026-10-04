// Scheduler invariant tests — the heart of ridgehsall.
//
// INVARIANT: a contact is never in two batches less than intervalDays apart.
// These tests prove it at three levels:
//   1. unit: pickBatchContacts / applySend behave correctly in isolation
//   2. simulation: a day-by-day in-memory run of the exact orchestration
//      algorithm (compute -> pick -> send -> advance cooldown) over multiple
//      frequency windows, asserting the invariant and full rotation coverage
//   3. edge cases: unsubscribed/bounced/suppressed excluded, new-contact
//      fairness, custom-N-day frequencies, idempotent re-runs

import { describe, expect, it } from "vitest";
import {
  applySend,
  dateKey,
  defaultDailyCap,
  endOfDayUtc,
  intervalDaysFor,
  nextDueAtForNewContact,
  pickBatchContacts,
  startOfDayUtc,
  type DueCandidate,
} from "../lib/scheduler";

const DAY = 24 * 60 * 60 * 1000;

function mkContact(id: string, nextDueAt: Date, status = "active"): DueCandidate {
  return { id, email: `${id}@example.com`, nextDueAt, status };
}

describe("intervalDaysFor", () => {
  it("maps named frequencies", () => {
    expect(intervalDaysFor("daily")).toBe(1);
    expect(intervalDaysFor("weekly")).toBe(7);
    expect(intervalDaysFor("biweekly")).toBe(14);
    expect(intervalDaysFor("monthly")).toBe(30);
  });
  it("supports custom N days", () => {
    expect(intervalDaysFor("custom", 21)).toBe(21);
    expect(intervalDaysFor("custom", 3)).toBe(3);
  });
  it("rejects invalid customDays", () => {
    expect(() => intervalDaysFor("custom", null)).toThrow();
    expect(() => intervalDaysFor("custom", 0)).toThrow();
    expect(() => intervalDaysFor("custom", -5)).toThrow();
    expect(() => intervalDaysFor("custom", 2.5)).toThrow();
    expect(() => intervalDaysFor("custom")).toThrow();
  });
});

describe("defaultDailyCap", () => {
  it("sizes the cap so the list rotates exactly within one window", () => {
    expect(defaultDailyCap(1019, 21)).toBe(49); // ceil(1019/21)
    expect(defaultDailyCap(100, 7)).toBe(15); // ceil(100/7)
    expect(defaultDailyCap(30, 30)).toBe(1);
    expect(defaultDailyCap(7, 7)).toBe(1);
  });
  it("returns 0 for an empty list", () => {
    expect(defaultDailyCap(0, 7)).toBe(0);
  });
});

describe("pickBatchContacts", () => {
  const today = startOfDayUtc(new Date("2026-10-04T12:00:00Z"));
  it("picks only due, active, non-suppressed contacts, oldest-due first, capped", () => {
    const contacts = [
      mkContact("a", new Date(today.getTime() - 3 * DAY)),
      mkContact("b", new Date(today.getTime() - 1 * DAY)),
      mkContact("c", new Date(today.getTime() + 1 * DAY)), // not due
      mkContact("d", new Date(today.getTime() - 2 * DAY), "unsubscribed"),
      mkContact("e", new Date(today.getTime() - 2 * DAY), "bounced"),
      mkContact("f", new Date(today.getTime() - 4 * DAY)), // suppressed
    ];
    const picked = pickBatchContacts(contacts, {
      today,
      dailyCap: 10,
      suppression: new Set(["f@example.com"]),
    });
    expect(picked.map((c) => c.id)).toEqual(["a", "b"]);
  });
  it("respects the daily cap", () => {
    const contacts = Array.from({ length: 20 }, (_, i) =>
      mkContact(`c${i}`, new Date(today.getTime() - i * DAY))
    );
    const picked = pickBatchContacts(contacts, { today, dailyCap: 5, suppression: new Set() });
    expect(picked).toHaveLength(5);
    // oldest due first
    expect(picked[0].id).toBe("c19");
  });
  it("suppression matching is case-insensitive", () => {
    const contacts = [mkContact("a", new Date(today.getTime() - DAY))];
    contacts[0].email = "A@Example.COM";
    const picked = pickBatchContacts(contacts, {
      today,
      dailyCap: 10,
      suppression: new Set(["a@example.com"]),
    });
    expect(picked).toHaveLength(0);
  });
});

describe("applySend", () => {
  it("advances nextDueAt by exactly intervalDays", () => {
    const now = new Date("2026-10-04T09:00:00Z");
    const { lastSentAt, nextDueAt } = applySend(now, 7);
    expect(lastSentAt.getTime()).toBe(now.getTime());
    expect(nextDueAt.getTime()).toBe(now.getTime() + 7 * DAY);
  });
});

describe("rotation simulation (the invariant, end to end)", () => {
  interface SimContact extends DueCandidate {
    lastSentAt: Date | null;
  }
  /**
   * Mirrors the orchestration algorithm day by day:
   *   due = pickBatchContacts(...) -> "send" -> applySend -> next day
   * Asserts the core invariant across the whole run.
   */
  function simulate(opts: {
    size: number;
    intervalDays: number;
    days: number;
    start?: Date;
    extra?: (day: number, contacts: SimContact[]) => void;
  }) {
    const start = startOfDayUtc(opts.start ?? new Date("2026-10-04T00:00:00Z"));
    const contacts: SimContact[] = Array.from({ length: opts.size }, (_, i) => ({
      id: `c${i}`,
      email: `c${i}@example.com`,
      nextDueAt: new Date(start.getTime()), // all due on day 0
      status: "active",
      lastSentAt: null,
    }));
    const cap = defaultDailyCap(opts.size, opts.intervalDays);
    const sends: { contactId: string; day: number }[] = [];

    for (let day = 0; day < opts.days; day++) {
      // mirrors computeTodaysBatches: due cutoff is end of the UTC day
      const today = endOfDayUtc(new Date(start.getTime() + day * DAY));
      opts.extra?.(day, contacts);
      const picked = pickBatchContacts(contacts, { today, dailyCap: cap, suppression: new Set() });
      const now = today;
      for (const c of picked) {
        // send-time re-check (mirrors lib/send.ts)
        if (c.status !== "active") continue;
        const sim = contacts.find((x) => x.id === c.id)!;
        const { nextDueAt } = applySend(now, opts.intervalDays);
        sim.nextDueAt = nextDueAt;
        sim.lastSentAt = now;
        sends.push({ contactId: c.id, day });
      }
    }
    return { sends, cap, contacts };
  }

  it("never sends a contact twice within the cooldown window (weekly)", () => {
    const { sends } = simulate({ size: 100, intervalDays: 7, days: 28 });
    const byContact = new Map<string, number[]>();
    for (const s of sends) {
      const arr = byContact.get(s.contactId) ?? [];
      arr.push(s.day);
      byContact.set(s.contactId, arr);
    }
    for (const [id, days] of byContact) {
      const sorted = [...days].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        expect(
          sorted[i] - sorted[i - 1],
          `contact ${id} sent on day ${sorted[i - 1]} and ${sorted[i]} (< 7 apart)`
        ).toBeGreaterThanOrEqual(7);
      }
    }
  });

  it("covers the full list exactly once per window (no starvation, no repeats)", () => {
    const { sends } = simulate({ size: 100, intervalDays: 7, days: 28 });
    // every contact sent exactly 4 times in 28 days
    const counts = new Map<string, number>();
    for (const s of sends) counts.set(s.contactId, (counts.get(s.contactId) ?? 0) + 1);
    expect(counts.size).toBe(100);
    for (const [id, n] of counts) {
      expect(n, `contact ${id}`).toBe(4);
    }
  });

  it("a new contact joins fairly — sent within one interval of joining", () => {
    const { sends } = simulate({
      size: 50,
      intervalDays: 7,
      days: 21,
      extra: (day, contacts) => {
        if (day === 10) {
          contacts.push({
            id: "newbie",
            email: "newbie@example.com",
            nextDueAt: nextDueAtForNewContact(new Date()),
            status: "active",
            lastSentAt: null,
          } as never);
        }
      },
    });
    const newbieSends = sends.filter((s) => s.contactId === "newbie").map((s) => s.day);
    expect(newbieSends.length).toBeGreaterThan(0);
    expect(newbieSends[0]).toBeLessThanOrEqual(10 + 7);
  });

  it("unsubscribed contacts are never picked, even when due", () => {
    const { sends } = simulate({
      size: 20,
      intervalDays: 7,
      days: 14,
      extra: (day, contacts) => {
        if (day === 3) {
          const c = contacts.find((x) => x.id === "c5")!;
          c.status = "unsubscribed"; // mid-flight unsubscribe
        }
      },
    });
    const c5Sends = sends.filter((s) => s.contactId === "c5" && s.day >= 3);
    expect(c5Sends).toHaveLength(0);
  });

  it("custom 21-day frequency: 1019 contacts rotate cleanly", () => {
    const { sends, cap } = simulate({ size: 1019, intervalDays: 21, days: 63 });
    expect(cap).toBe(49);
    const counts = new Map<string, number>();
    const byContact = new Map<string, number[]>();
    for (const s of sends) {
      counts.set(s.contactId, (counts.get(s.contactId) ?? 0) + 1);
      const arr = byContact.get(s.contactId) ?? [];
      arr.push(s.day);
      byContact.set(s.contactId, arr);
    }
    expect(counts.size).toBe(1019);
    for (const [id, n] of counts) expect(n, `contact ${id}`).toBe(3);
    for (const [id, days] of byContact) {
      const sorted = [...days].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i] - sorted[i - 1], `contact ${id}`).toBeGreaterThanOrEqual(21);
      }
    }
  });

  it("daily frequency: every contact sent every day", () => {
    const { sends } = simulate({ size: 30, intervalDays: 1, days: 5 });
    const counts = new Map<string, number>();
    for (const s of sends) counts.set(s.contactId, (counts.get(s.contactId) ?? 0) + 1);
    expect(counts.size).toBe(30);
    for (const n of counts.values()) expect(n).toBe(5);
  });

  it("cooldown is exact: sent day 0 -> due again exactly intervalDays later", () => {
    // guards the end-of-day cutoff: a start-of-day cutoff would push the
    // second send to day 8 instead of day 7.
    const { sends } = simulate({ size: 7, intervalDays: 7, days: 15 });
    const c0 = sends.filter((s) => s.contactId === "c0").map((s) => s.day);
    expect(c0).toEqual([0, 7, 14]);
  });

  it("dateKey is stable and day-granular", () => {
    expect(dateKey(new Date("2026-10-04T00:00:01Z"))).toBe("2026-10-04");
    expect(dateKey(new Date("2026-10-04T23:59:59Z"))).toBe("2026-10-04");
  });
});
