import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authenticateApiKey } from "@/lib/auth";
import { upsertContacts, type IngestContact } from "@/lib/ingest";

export const dynamic = "force-dynamic";

// POST /api/v1/lists/:id/contacts — ingest one contact or a bulk array.
// Upserts on (listId, email). Auth: x-api-key.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApiKey(req);
  if (!auth) return NextResponse.json({ error: "invalid or missing x-api-key" }, { status: 401 });
  const { id } = await params;

  const list = await db.contactList.findFirst({ where: { id, workspaceId: auth.workspaceId } });
  if (!list) return NextResponse.json({ error: "list not found" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const items = Array.isArray(body) ? body : [body];
  const contacts: IngestContact[] = items.map((it: Record<string, unknown>) => ({
    email: String(it.email ?? ""),
    firstName: typeof it.firstName === "string" ? it.firstName : undefined,
    lastName: typeof it.lastName === "string" ? it.lastName : undefined,
    fields:
      it.fields && typeof it.fields === "object"
        ? Object.fromEntries(Object.entries(it.fields as object).map(([k, v]) => [k, String(v)]))
        : undefined,
  }));

  const result = await upsertContacts(id, contacts, "api");
  return NextResponse.json(result, { status: 201 });
}
