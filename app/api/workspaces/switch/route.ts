import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getDashboardContext } from "@/lib/authz";
import { setActiveWorkspaceCookie } from "@/lib/session";

export const dynamic = "force-dynamic";

// POST /api/workspaces/switch — set the active workspace (must be a member).
// Accepts JSON {id} or form posts (form -> 303 redirect to /).
export async function POST(req: NextRequest) {
  const ctx = await getDashboardContext(req);
  if ("error" in ctx) return ctx.error;
  const { user } = ctx;

  const contentType = req.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  let body: Record<string, unknown> = {};
  try {
    body = isJson ? await req.json() : Object.fromEntries((await req.formData()).entries());
  } catch {
    body = {};
  }
  const id = typeof body.id === "string" ? body.id : "";
  const membership = id
    ? await db.workspaceMember.findUnique({
        where: { userId_workspaceId: { userId: user.id, workspaceId: id } },
        include: { workspace: true },
      })
    : null;
  if (!membership) {
    return isJson
      ? NextResponse.json({ error: "workspace not found" }, { status: 404 })
      : NextResponse.redirect(new URL("/", req.url), 303);
  }
  await setActiveWorkspaceCookie(membership.workspace.id);

  if (!isJson) return NextResponse.redirect(new URL("/", req.url), 303);
  return NextResponse.json({ ok: true, id: membership.workspace.id, name: membership.workspace.name });
}
