import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createContactList, ListInputError, parseCreateListBody } from "@/lib/lists";
import { getDashboardContext } from "@/lib/authz";

export const dynamic = "force-dynamic";

// POST /api/lists — create a list in the active workspace (dashboard, session auth).
// Accepts JSON or dashboard form posts (form -> 303 redirect to the new list).
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
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  let list;
  try {
    list = await createContactList(workspace.id, parseCreateListBody(body));
  } catch (e) {
    if (e instanceof ListInputError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  if (!isJson) {
    return NextResponse.redirect(new URL(`/lists/${list.id}`, req.url), 303);
  }
  return NextResponse.json({ id: list.id, name: list.name, frequency: list.frequency }, { status: 201 });
}

// GET /api/lists — lists in the active workspace (dashboard, session auth).
export async function GET(req: NextRequest) {
  const ctx = await getDashboardContext(req);
  if ("error" in ctx) return ctx.error;
  const lists = await db.contactList.findMany({
    where: { workspaceId: ctx.workspace.id },
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { contacts: true } } },
  });
  return NextResponse.json({
    lists: lists.map((l) => ({
      id: l.id, name: l.name, frequency: l.frequency, customDays: l.customDays,
      dailyCap: l.dailyCap, status: l.status, contacts: l._count.contacts,
    })),
  });
}
