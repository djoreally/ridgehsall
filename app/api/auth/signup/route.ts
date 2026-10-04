import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { validateSignup } from "@/lib/validation";
import { createSession, setActiveWorkspaceCookie } from "@/lib/session";

export const dynamic = "force-dynamic";

// POST /api/auth/signup — {name, email, password} (JSON or form).
// Creates the user, a personal workspace (owner), and a session.
// JSON -> 201/4xx JSON. Form posts -> 303 redirect (/ or /signup?error=...).
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
      : NextResponse.redirect(new URL(`/signup?error=${encodeURIComponent(message)}`, req.url), 303);

  const v = validateSignup(body);
  if (!v.ok) return fail(v.error as string);

  const existing = await db.user.findUnique({ where: { email: v.email } });
  if (existing) return fail("an account with that email already exists", 409);

  const passwordHash = await hashPassword(v.password);
  const wsName = v.name ? `${v.name}'s workspace` : `${v.email.split("@")[0]}'s workspace`;

  const user = await db.user.create({
    data: {
      email: v.email,
      passwordHash,
      name: v.name || null,
      memberships: {
        create: { role: "owner", workspace: { create: { name: wsName } } },
      },
    },
    include: { memberships: { include: { workspace: true } } },
  });

  await createSession(user.id);
  await setActiveWorkspaceCookie(user.memberships[0].workspace.id);

  if (!isJson) return NextResponse.redirect(new URL("/", req.url), 303);
  return NextResponse.json(
    { ok: true, user: { id: user.id, email: user.email, name: user.name } },
    { status: 201 }
  );
}
