// Auth tests: passwords, signup validation, sessions, cross-user isolation.
// DB-backed tests run against an isolated SQLite file (DATABASE_URL is set
// before lib/db is first imported, so the app code under test uses it).

import { describe, expect, it, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { hashPassword, verifyPassword } from "../lib/password";
import { validateSignup } from "../lib/validation";

const TEST_DB_PATH = "/tmp/ridgehsall-auth-test.db";
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;

let db: import("@prisma/client").PrismaClient;
let sessionStore: typeof import("../lib/session-store");
let workspacesLib: typeof import("../lib/workspaces");

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
  sessionStore = await import("../lib/session-store");
  workspacesLib = await import("../lib/workspaces");
}, 120_000);

describe("password hashing (scrypt)", () => {
  it("round-trips: hash then verify accepts the right password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("uses a unique salt per hash", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
  });

  it("rejects malformed stored hashes", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "scrypt$zz$zz")).toBe(false);
    expect(await verifyPassword("x", "")).toBe(false);
  });
});

describe("signup validation", () => {
  it("rejects a bad email", () => {
    const r = validateSignup({ name: "A", email: "not-an-email", password: "longenough1" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/email/i);
  });

  it("rejects a short password", () => {
    const r = validateSignup({ name: "A", email: "a@example.com", password: "short7" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/8 characters/);
  });

  it("rejects a missing password", () => {
    const r = validateSignup({ name: "A", email: "a@example.com" });
    expect(r.ok).toBe(false);
  });

  it("accepts valid input and normalizes the email", () => {
    const r = validateSignup({ name: "  Alice  ", email: "  ALICE@Example.COM ", password: "longenough1" });
    expect(r.ok).toBe(true);
    expect(r.email).toBe("alice@example.com");
    expect(r.name).toBe("Alice");
  });
});

describe("sessions", () => {
  it("create -> validate round-trips the user", async () => {
    const user = await db.user.create({
      data: { email: "sess@example.com", passwordHash: await hashPassword("password123") },
    });
    const { token } = await sessionStore.createSessionRecord(user.id);
    // Only the SHA-256 of the token is stored — never the raw token.
    const row = await db.session.findFirst({ where: { userId: user.id } });
    expect(row!.tokenHash).toBe(sessionStore.hashSessionToken(token));
    expect(row!.tokenHash).not.toContain(token);

    const found = await sessionStore.findSessionUserByToken(token);
    expect(found?.user.id).toBe(user.id);
  });

  it("rejects unknown tokens", async () => {
    expect(await sessionStore.findSessionUserByToken("nope-not-a-token")).toBeNull();
    expect(await sessionStore.findSessionUserByToken(undefined)).toBeNull();
  });

  it("expires sessions and cleans them up", async () => {
    const user = await db.user.create({
      data: { email: "exp@example.com", passwordHash: await hashPassword("password123") },
    });
    const { token, session } = await sessionStore.createSessionRecord(user.id);
    await db.session.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await sessionStore.findSessionUserByToken(token)).toBeNull();
    expect(await db.session.findUnique({ where: { id: session.id } })).toBeNull();
  });

  it("destroy removes the session", async () => {
    const user = await db.user.create({
      data: { email: "bye@example.com", passwordHash: await hashPassword("password123") },
    });
    const { token } = await sessionStore.createSessionRecord(user.id);
    await sessionStore.destroySessionRecord(token);
    expect(await sessionStore.findSessionUserByToken(token)).toBeNull();
  });
});

describe("cross-user workspace isolation", () => {
  let userA: { id: string };
  let userB: { id: string };
  let wsA: { id: string };
  let wsB: { id: string };
  let listA: { id: string };

  beforeAll(async () => {
    const mk = async (email: string, wsName: string) => {
      const user = await db.user.create({
        data: {
          email,
          passwordHash: await hashPassword("password123"),
          memberships: { create: { role: "owner", workspace: { create: { name: wsName } } } },
        },
        include: { memberships: { include: { workspace: true } } },
      });
      return { user, ws: user.memberships[0].workspace };
    };
    const a = await mk("alice@example.com", "Alice WS");
    const b = await mk("bob@example.com", "Bob WS");
    userA = a.user;
    userB = b.user;
    wsA = a.ws;
    wsB = b.ws;
    listA = await db.contactList.create({
      data: { workspaceId: wsA.id, name: "Alice's list", frequency: "weekly" },
    });
  });

  it("never resolves another user's workspace, even when requested by id", async () => {
    const resolved = await workspacesLib.resolveActiveWorkspace(userB.id, wsA.id);
    expect(resolved.id).toBe(wsB.id);
    expect(resolved.id).not.toBe(wsA.id);
  });

  it("resolves the requested workspace when the user IS a member", async () => {
    const resolved = await workspacesLib.resolveActiveWorkspace(userA.id, wsA.id);
    expect(resolved.id).toBe(wsA.id);
  });

  it("falls back to the user's own workspace when nothing is requested", async () => {
    const resolved = await workspacesLib.resolveActiveWorkspace(userB.id, null);
    expect(resolved.id).toBe(wsB.id);
  });

  it("workspace-scoped list queries cannot see another user's list", async () => {
    // This is the exact query shape the dashboard routes use.
    const leak = await db.contactList.findFirst({
      where: { id: listA.id, workspaceId: wsB.id },
    });
    expect(leak).toBeNull();
  });

  it("getUserWorkspaces only returns the user's own workspaces", async () => {
    const mine = await workspacesLib.getUserWorkspaces(userB.id);
    expect(mine.map((w) => w.id)).toEqual([wsB.id]);
  });

  it("throws for a user with no workspace", async () => {
    const lonely = await db.user.create({
      data: { email: "lonely@example.com", passwordHash: await hashPassword("password123") },
    });
    await expect(workspacesLib.resolveActiveWorkspace(lonely.id, null)).rejects.toThrow();
  });
});

describe("email uniqueness backstop", () => {
  it("the database rejects a second user with the same email", async () => {
    await db.user.create({
      data: { email: "dupe@example.com", passwordHash: await hashPassword("password123") },
    });
    await expect(
      db.user.create({
        data: { email: "dupe@example.com", passwordHash: await hashPassword("password123") },
      })
    ).rejects.toThrow();
  });
});
