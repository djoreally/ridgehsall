import { NextRequest, NextResponse } from "next/server";
import { destroySession } from "@/lib/session";

export const dynamic = "force-dynamic";

// POST /api/auth/logout — destroys the session, clears cookies.
export async function POST(req: NextRequest) {
  await destroySession();
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return NextResponse.redirect(new URL("/login", req.url), 303);
  }
  return NextResponse.json({ ok: true });
}
