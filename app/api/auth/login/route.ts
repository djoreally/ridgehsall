import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { normalizeEmail } from "@/lib/validation";
import { createSession, setActiveWorkspaceCookie } from "@/lib/session";

export const dynamic = "force-dynamic";

// POST /api/auth/login — {email, password} (JSON or form).
// Always returns the generic "invalid email or password" on failure.
// Simple in-memory rate limit: 10 attempts/minute per IP.
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || rec.resetAt <= now) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    // Opportunistic cleanup so the map can't grow unbounded.
    if (attempts.size > 5000) {
      for (const [k, r] of attempts) if (r.resetAt <= now) attempts.delete(k);
    }
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_ATTEMPTS;
}

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  let body: Record<string, unknown> = {};
  try {
    body = isJson ? await req.json() : Object.fromEntries((await req.formData()).entries());
  } catch {
    body = {};
  }

  const fail = (message: string, status = 400) =>
    isJson
      ? NextResponse.json({ error: message }, { status })
      : NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(message)}`, req.url), 303);

  if (rateLimited(clientIp(req))) {
    return fail("too many attempts — please wait a minute and try again", 429);
  }

  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  const password = typeof body.password === "string" ? body.password : "";
  const bad = () => fail("invalid email or password", 401);

  if (!email || !password) return bad();
  const user = await db.user.findUnique({
    where: { email },
    include: { memberships: { orderBy: { createdAt: "asc" }, include: { workspace: true } } },
  });
  if (!user) return bad();
  if (!(await verifyPassword(password, user.passwordHash))) return bad();

  await createSession(user.id);
  if (user.memberships[0]) {
    await setActiveWorkspaceCookie(user.memberships[0].workspace.id);
  }

  if (!isJson) return NextResponse.redirect(new URL("/", req.url), 303);
  return NextResponse.json({ ok: true, user: { id: user.id, email: user.email, name: user.name } });
}
