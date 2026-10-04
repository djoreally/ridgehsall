// POST /api/workspaces/settings — update the active workspace's hosted
// sending identity (from display name + reply-to address).
// Session-guarded dashboard route. Accepts JSON or form posts.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getDashboardContext } from "@/lib/authz";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  const ctx = await getDashboardContext(req);
  if ("error" in ctx) return ctx.error;
  const { workspace } = ctx;

  const contentType = req.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  let body: Record<string, unknown> = {};
  try {
    body = isJson ? await req.json() : Object.fromEntries((await req.formData()).entries());
  } catch {
    body = {};
  }

  const fromName = typeof body.fromName === "string" ? body.fromName.trim().slice(0, 80) : "";
  const replyToEmail = typeof body.replyToEmail === "string" ? body.replyToEmail.trim().slice(0, 160) : "";

  if (replyToEmail && !EMAIL_RE.test(replyToEmail)) {
    const msg = "reply-to address is not a valid email";
    return isJson
      ? NextResponse.json({ error: msg }, { status: 400 })
      : NextResponse.redirect(new URL("/?settings=bademail", req.url), 303);
  }

  await db.workspace.update({
    where: { id: workspace.id },
    data: {
      fromName: fromName || null,
      replyToEmail: replyToEmail || null,
    },
  });

  if (!isJson) return NextResponse.redirect(new URL("/?settings=saved", req.url), 303);
  return NextResponse.json({ ok: true, fromName: fromName || null, replyToEmail: replyToEmail || null });
}
