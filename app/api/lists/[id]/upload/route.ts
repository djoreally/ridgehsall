import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseCsv, mapRowsToContacts, guessMapping } from "@/lib/csv";
import { upsertContacts, type IngestContact } from "@/lib/ingest";
import { getDefaultWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

// POST /api/lists/:id/upload — dashboard CSV upload (multipart form).
// Fields: file, plus optional emailCol/firstNameCol/lastNameCol indexes.
// When column indexes are omitted, the header row is auto-mapped.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspace = await getDefaultWorkspace();
  const list = await db.contactList.findFirst({ where: { id, workspaceId: workspace.id } });
  if (!list) return NextResponse.json({ error: "list not found" }, { status: 404 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.redirect(new URL(`/lists/${id}?upload=errornofile`, req.url), 303);
  }
  const text = await file.text();
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return NextResponse.redirect(new URL(`/lists/${id}?upload=errorempty`, req.url), 303);
  }

  const pick = (name: string): number | undefined => {
    const v = form.get(name);
    if (v == null || v === "") return undefined;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  };
  const mapping =
    pick("emailCol") !== undefined
      ? { email: pick("emailCol")!, firstName: pick("firstNameCol"), lastName: pick("lastNameCol") }
      : guessMapping(rows[0]);

  if (!mapping) {
    return NextResponse.redirect(new URL(`/lists/${id}?upload=errornomap`, req.url), 303);
  }

  const { contacts, errors } = mapRowsToContacts(rows, mapping);
  const ingest: IngestContact[] = contacts.map((c) => ({
    email: c.email,
    firstName: c.firstName,
    lastName: c.lastName,
    fields: c.fields,
  }));
  const result = await upsertContacts(id, ingest, "csv");
  const q = new URLSearchParams({
    upload: "done",
    created: String(result.created),
    updated: String(result.updated),
    skipped: String(errors.length + result.errors.length),
  });
  return NextResponse.redirect(new URL(`/lists/${id}?${q}`, req.url), 303);
}
