import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getDashboardContext } from "@/lib/authz";
import { setActiveWorkspaceCookie } from "@/lib/session";

export const dynamic = "force-dynamic";

// POST /api/workspaces — create a new workspace (owner) and switch to it.
// Accepts JSON or form posts (form -> 303 redirect to /).
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
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
  if (!name) {
    return isJson
      ? NextResponse.json({ error: "name is required" }, { status: 400 })
      : NextResponse.redirect(new URL("/?error=workspacename", req.url), 303);
  }

  const workspace = await db.workspace.create({ data: { name } });
  const membership = await db.workspaceMember.create({
    data: { userId: user.id, role: "owner", workspaceId: workspace.id },
    include: { workspace: true },
  });
  await setActiveWorkspaceCookie(membership.workspace.id);

  if (!isJson) return NextResponse.redirect(new URL("/", req.url), 303);
  return NextResponse.json({ id: membership.workspace.id, name }, { status: 201 });
}
