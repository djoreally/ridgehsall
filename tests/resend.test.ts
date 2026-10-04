// Resend hosted-mode tests.
// Pure tests (provider payload, Svix verification) mock fetch / use crypto.
// DB-backed tests (bounce/complaint handlers, hosted daily cap) run against an
// isolated SQLite file — DATABASE_URL is set before lib/db is first imported,
// so the app code under test uses it. All lib imports are dynamic for that reason.

import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createHmac } from "node:crypto";

const TEST_DB_PATH = "/tmp/ridgehsall-resend-test.db";
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;

let db: import("@prisma/client").PrismaClient;
let providers: typeof import("../lib/providers");
let resendLib: typeof import("../lib/resend");
let sendLib: typeof import("../lib/send");
let schedulerLib: typeof import("../lib/scheduler");

beforeAll(async () => {
  try {
    rmSync(TEST_DB_PATH);
  } catch {
    /* fresh file */
  }
  execSync("npx prisma db push --schema prisma/schema.prisma", {
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}` },
    stdio: "pipe",
  });
  db = (await import("../lib/db")).db;
  providers = await import("../lib/providers");
  resendLib = await import("../lib/resend");
  sendLib = await import("../lib/send");
  schedulerLib = await import("../lib/scheduler");
}, 120_000);

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.HOSTED_MODE;
  delete process.env.HOSTED_DAILY_SEND_CAP;
});

function mockFetch(handler: (url: string, init: any) => any) {
  const calls: { url: string; init: any; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, init, body });
      return handler(url, init);
    })
  );
  return calls;
}

const okJson = (data: any) => ({ ok: true, status: 200, json: async () => data });

describe("ResendProvider single send", () => {
  it("posts the right payload shape to /emails", async () => {
    const calls = mockFetch(() => okJson({ id: "re_123" }));
    const p = new providers.ResendProvider("re_testkey");
    const res = await p.send({
      to: "a@b.com",
      toName: "Ann",
      subject: "Hi",
      html: "<p>hi</p>",
      fromEmail: "noreply@mail.example.com",
      fromName: "Acme",
      replyTo: "me@acme.com",
      headers: { "List-Unsubscribe": "<https://x/unsub>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      idempotencyKey: "ridgehsall-item-1",
    });
    expect(res).toEqual({ ok: true, messageId: "re_123" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["Authorization"]).toBe("Bearer re_testkey");
    expect(calls[0].init.headers["Idempotency-Key"]).toBe("ridgehsall-item-1");
    const body = calls[0].body;
    expect(body.from).toBe("Acme <noreply@mail.example.com>");
    expect(body.to).toEqual(["a@b.com"]);
    expect(body.subject).toBe("Hi");
    expect(body.html).toBe("<p>hi</p>");
    expect(body.reply_to).toBe("me@acme.com");
    expect(body.headers["List-Unsubscribe"]).toBe("<https://x/unsub>");
    expect(body.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("omits reply_to when no replyTo is set", async () => {
    const calls = mockFetch(() => okJson({ id: "re_1" }));
    const p = new providers.ResendProvider("re_testkey");
    await p.send({ to: "a@b.com", subject: "s", html: "<p/>", fromEmail: "noreply@mail.example.com" });
    expect(calls[0].body.reply_to).toBeUndefined();
    expect(calls[0].body.from).toBe("noreply@mail.example.com");
  });

  it("returns ok:false on API errors without throwing", async () => {
    mockFetch(() => ({ ok: false, status: 422, json: async () => ({ message: "invalid from" }) }));
    const p = new providers.ResendProvider("re_testkey");
    const res = await p.send({ to: "a@b.com", subject: "s", html: "<p/>", fromEmail: "noreply@mail.example.com" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("invalid from");
  });
});

describe("ResendProvider.sendMany (batch endpoint)", () => {
  const req = (i: number) => ({
    to: `u${i}@b.com`,
    subject: "s",
    html: "<p/>",
    fromEmail: "noreply@mail.example.com",
    idempotencyKey: `ridgehsall-item-${i}`,
  });

  it("uses POST /emails/batch with one entry per recipient", async () => {
    const calls = mockFetch(() => okJson({ data: [{ id: "re_a" }, { id: "re_b" }, { id: "re_c" }] }));
    const p = new providers.ResendProvider("re_testkey");
    const results = await p.sendMany([req(1), req(2), req(3)]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails/batch");
    expect(calls[0].body).toHaveLength(3);
    expect(calls[0].body[0].to).toEqual(["u1@b.com"]);
    expect(results).toEqual([
      { ok: true, messageId: "re_a" },
      { ok: true, messageId: "re_b" },
      { ok: true, messageId: "re_c" },
    ]);
  });

  it("chunks batches larger than 100", async () => {
    const calls = mockFetch((_url: string, init: any) => {
      const n = JSON.parse(init.body).length;
      return okJson({ data: Array.from({ length: n }, (_, i) => ({ id: `re_${i}` })) });
    });
    const p = new providers.ResendProvider("re_testkey");
    const reqs = Array.from({ length: 101 }, (_, i) => req(i));
    const results = await p.sendMany(reqs);
    expect(calls).toHaveLength(2);
    expect(calls[0].body).toHaveLength(100);
    expect(calls[1].body).toHaveLength(1);
    expect(results).toHaveLength(101);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("marks a failed chunk's items failed without throwing", async () => {
    mockFetch(() => ({ ok: false, status: 400, json: async () => ({ message: "batch rejected" }) }));
    const p = new providers.ResendProvider("re_testkey");
    const results = await p.sendMany([req(1), req(2)]);
    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results[0].error).toContain("batch rejected");
  });
});

describe("getProvider hosted default", () => {
  it("defaults to resend in hosted mode and validates config", () => {
    // vitest loads the repo .env, which pins EMAIL_PROVIDER=console — an
    // explicit EMAIL_PROVIDER always wins over the hosted default, so clear it.
    const origProvider = process.env.EMAIL_PROVIDER;
    delete process.env.EMAIL_PROVIDER;
    try {
      process.env.HOSTED_MODE = "true";
      process.env.RESEND_API_KEY = "re_x";
      process.env.RESEND_FROM_DOMAIN = "mail.example.com";
      expect(providers.getProvider().name).toBe("resend");
      delete process.env.RESEND_API_KEY;
      expect(() => providers.getProvider()).toThrow(/RESEND_API_KEY/);
    } finally {
      if (origProvider !== undefined) process.env.EMAIL_PROVIDER = origProvider;
      delete process.env.RESEND_API_KEY;
      delete process.env.RESEND_FROM_DOMAIN;
    }
  });

  it("defaults to console outside hosted mode", () => {
    const origProvider = process.env.EMAIL_PROVIDER;
    delete process.env.EMAIL_PROVIDER;
    delete process.env.HOSTED_MODE;
    try {
      expect(providers.getProvider().name).toBe("console");
    } finally {
      if (origProvider !== undefined) process.env.EMAIL_PROVIDER = origProvider;
    }
  });
});

// ---------------------------------------------------------------------------
// Svix verification
// ---------------------------------------------------------------------------

const TEST_SECRET = "whsec_" + Buffer.from("test-secret-key-1234567890abcdef").toString("base64");

function signPayload(raw: string, id: string, ts: string, secret: string = TEST_SECRET): string {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${raw}`, "utf8").digest("base64");
  return `v1,${sig}`;
}

describe("verifySvixWebhook", () => {
  const raw = JSON.stringify({ type: "email.bounced", data: { to: ["a@b.com"] } });
  const id = "msg_test123";
  const ts = () => String(Math.floor(Date.now() / 1000));

  it("accepts a validly signed payload and returns the parsed event", () => {
    const t = ts();
    const event: any = resendLib.verifySvixWebhook(
      raw,
      { svixId: id, svixTimestamp: t, svixSignature: signPayload(raw, id, t) },
      TEST_SECRET
    );
    expect(event.type).toBe("email.bounced");
    expect(event.data.to).toEqual(["a@b.com"]);
  });

  it("rejects a tampered body", () => {
    const t = ts();
    expect(() =>
      resendLib.verifySvixWebhook(
        raw + " ",
        { svixId: id, svixTimestamp: t, svixSignature: signPayload(raw, id, t) },
        TEST_SECRET
      )
    ).toThrow(/mismatch/);
  });

  it("rejects a forged signature", () => {
    const t = ts();
    expect(() =>
      resendLib.verifySvixWebhook(
        raw,
        { svixId: id, svixTimestamp: t, svixSignature: signPayload(raw, id, t, "whsec_" + Buffer.from("other-secret-0000000000000000").toString("base64")) },
        TEST_SECRET
      )
    ).toThrow(/mismatch/);
  });

  it("rejects an expired timestamp (replay protection)", () => {
    const old = String(Math.floor(Date.now() / 1000) - 600);
    expect(() =>
      resendLib.verifySvixWebhook(
        raw,
        { svixId: id, svixTimestamp: old, svixSignature: signPayload(raw, id, old) },
        TEST_SECRET
      )
    ).toThrow(/tolerance/);
  });

  it("rejects missing headers", () => {
    expect(() => resendLib.verifySvixWebhook(raw, { svixId: "", svixTimestamp: ts(), svixSignature: "v1,x" }, TEST_SECRET)).toThrow(/missing/);
  });
});

// ---------------------------------------------------------------------------
// DB-backed: bounce / complaint handlers
// ---------------------------------------------------------------------------

async function makeWorkspace(name = "WS") {
  return db.workspace.create({ data: { name } });
}

describe("resend webhook handlers (DB)", () => {
  it("email.bounced marks the contact bounced and suppresses the address", async () => {
    // Note: ingest normalizes all emails to lowercase (lib/ingest.ts), so the
    // handler's exact+lowercase lookup covers every real row.
    const ws = await makeWorkspace("BounceWS");
    const list = await db.contactList.create({ data: { workspaceId: ws.id, name: "L", frequency: "weekly" } });
    const contact = await db.contact.create({
      data: { listId: list.id, email: "bounce@example.com", firstName: "B" },
    });

    const affected = await resendLib.applyResendBounce("bounce@example.com");
    expect(affected).toBe(1);

    const updated = await db.contact.findUnique({ where: { id: contact.id } });
    expect(updated?.status).toBe("bounced");
    const sup = await db.suppression.findUnique({
      where: { workspaceId_email: { workspaceId: ws.id, email: "bounce@example.com" } },
    });
    expect(sup?.reason).toBe("resend hard bounce");
  });

  it("bounce handling is idempotent (Resend retries are safe)", async () => {
    const ws = await makeWorkspace("BounceWS2");
    const list = await db.contactList.create({ data: { workspaceId: ws.id, name: "L", frequency: "weekly" } });
    await db.contact.create({ data: { listId: list.id, email: "dup@example.com" } });
    await resendLib.applyResendBounce("dup@example.com");
    await resendLib.applyResendBounce("dup@example.com");
    const count = await db.suppression.count({ where: { workspaceId: ws.id, email: "dup@example.com" } });
    expect(count).toBe(1);
  });

  it("email.complained unsubscribes the contact and suppresses the address", async () => {
    const ws = await makeWorkspace("ComplaintWS");
    const list = await db.contactList.create({ data: { workspaceId: ws.id, name: "L", frequency: "weekly" } });
    const contact = await db.contact.create({ data: { listId: list.id, email: "spam@example.com" } });

    const result = await resendLib.handleResendEvent({ type: "email.complained", data: { to: ["spam@example.com"] } });
    expect(result).toEqual({ handled: true, affected: 1 });

    const updated = await db.contact.findUnique({ where: { id: contact.id } });
    expect(updated?.status).toBe("unsubscribed");
    const sup = await db.suppression.findUnique({
      where: { workspaceId_email: { workspaceId: ws.id, email: "spam@example.com" } },
    });
    expect(sup?.reason).toBe("resend spam complaint");
  });

  it("unknown event types are ignored", async () => {
    const result = await resendLib.handleResendEvent({ type: "email.opened", data: { to: ["x@example.com"] } });
    expect(result).toEqual({ handled: false, affected: 0 });
  });
});

// ---------------------------------------------------------------------------
// DB-backed: hosted daily cap
// ---------------------------------------------------------------------------

describe("hosted daily cap", () => {
  it("sends up to the cap and defers the rest for the next day", async () => {
    process.env.HOSTED_MODE = "true";
    process.env.HOSTED_DAILY_SEND_CAP = "2";

    const ws = await makeWorkspace("CapWS");
    const list = await db.contactList.create({
      data: { workspaceId: ws.id, name: "L", frequency: "weekly", dailyCap: 10 },
    });
    for (let i = 0; i < 5; i++) {
      await db.contact.create({ data: { listId: list.id, email: `cap${i}@example.com` } });
    }

    const summaries = await schedulerLib.computeTodaysBatches(ws.id, new Date());
    expect(summaries[0].picked).toBe(5);

    const result = await sendLib.sendBatch(summaries[0].batchId, "console");
    expect(result.sent).toBe(2);
    expect(result.capped).toBe(3);
    expect(result.failed).toBe(0);

    // Deferred items were removed from today's batch (not dropped, not sent)
    const remainingItems = await db.batchItem.count({ where: { batchId: summaries[0].batchId } });
    expect(remainingItems).toBe(2);
    const deferred = await db.contact.findMany({
      where: { listId: list.id, lastSentAt: null },
    });
    expect(deferred).toHaveLength(3);

    // Tomorrow's compute re-picks exactly the 3 deferred contacts
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    const next = await schedulerLib.computeTodaysBatches(ws.id, tomorrow);
    expect(next[0].picked).toBe(3);
  });

  it("sends nothing new once the cap is already reached, and logs the deferral", async () => {
    process.env.HOSTED_MODE = "true";
    process.env.HOSTED_DAILY_SEND_CAP = "1";

    const ws = await makeWorkspace("CapWS2");
    const list = await db.contactList.create({
      data: { workspaceId: ws.id, name: "L", frequency: "weekly", dailyCap: 10 },
    });
    const seed = await db.contact.create({ data: { listId: list.id, email: "seed@example.com" } });
    await db.contact.create({ data: { listId: list.id, email: "new@example.com" } });
    // Simulate one send already made today
    await db.sendLog.create({
      data: { contactId: seed.id, provider: "console", status: "sent" },
    });

    const summaries = await schedulerLib.computeTodaysBatches(ws.id, new Date());
    const result = await sendLib.sendBatch(summaries[0].batchId, "console");
    expect(result.sent).toBe(0);
    expect(result.capped).toBe(2);
  });
});
