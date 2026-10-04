import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authenticateApiKey } from "@/lib/auth";
import { createContactList, ListInputError, parseCreateListBody } from "@/lib/lists";

export const dynamic = "force-dynamic";

// GET /api/v1/lists — list all lists in the workspace (x-api-key)
export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return NextResponse.json({ error: "invalid or missing x-api-key" }, { status: 401 });
  const lists = await db.contactList.findMany({
    where: { workspaceId: auth.workspaceId },
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { contacts: true } } },
  });
  return NextResponse.json({
    lists: lists.map((l) => ({
      id: l.id,
      name: l.name,
      frequency: l.frequency,
      customDays: l.customDays,
      dailyCap: l.dailyCap,
      status: l.status,
      contacts: l._count.contacts,
    })),
  });
}

// POST /api/v1/lists — create a list in the API key's workspace (x-api-key required).
export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return NextResponse.json({ error: "invalid or missing x-api-key" }, { status: 401 });

  const contentType = req.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  let body: Record<string, unknown>;
  try {
    body = isJson ? await req.json() : Object.fromEntries((await req.formData()).entries());
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  let list;
  try {
    list = await createContactList(auth.workspaceId, parseCreateListBody(body));
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
