import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import { upsertContacts, type IngestContact } from "@/lib/ingest";

export const dynamic = "force-dynamic";

// POST /api/v1/ingest/:integrationId — inbound webhook ingest.
// Auth: shared secret (x-webhook-secret header) or HMAC-SHA256 of the raw body
// (x-signature-256 header, hex). Field mapping lives on the integration config:
//   { listId, mapping: { email, firstName?, lastName? }, extraFields: "passthrough"|"ignore" }
export async function POST(req: NextRequest, { params }: { params: Promise<{ integrationId: string }> }) {
  const { integrationId } = await params;
  const integration = await db.integration.findUnique({ where: { id: integrationId } });
  if (!integration || integration.type !== "webhook") {
    return NextResponse.json({ error: "integration not found" }, { status: 404 });
  }

  const rawBody = await req.text();
  if (!checkWebhookAuth(req, rawBody, integration.secret)) {
    return NextResponse.json({ error: "invalid webhook signature or secret" }, { status: 401 });
  }

  let config: { listId?: string; mapping?: Record<string, string>; extraFields?: string };
  try {
    config = JSON.parse(integration.config);
  } catch {
    return NextResponse.json({ error: "integration config is corrupt" }, { status: 500 });
  }
  if (!config.listId) return NextResponse.json({ error: "webhook has no target list" }, { status: 500 });

  const list = await db.contactList.findFirst({
    where: { id: config.listId, workspaceId: integration.workspaceId },
  });
  if (!list) return NextResponse.json({ error: "target list not found" }, { status: 500 });

  let payload: unknown;
  try {
    payload = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const records = normalizeRecords(payload);
  if (records.length === 0) return NextResponse.json({ error: "no contact records in body" }, { status: 400 });

  const mapping = config.mapping ?? { email: "email" };
  const contacts: IngestContact[] = records.map((r) => {
    const fields: Record<string, string> = {};
    if (config.extraFields !== "ignore") {
      for (const [k, v] of Object.entries(r)) {
        if (v != null && v !== "") fields[k] = String(v);
      }
    }
    return {
      email: String(r[mapping.email] ?? ""),
      firstName: mapping.firstName ? String(r[mapping.firstName] ?? "") || undefined : undefined,
      lastName: mapping.lastName ? String(r[mapping.lastName] ?? "") || undefined : undefined,
      fields: Object.keys(fields).length > 0 ? fields : undefined,
    };
  });

  const result = await upsertContacts(list.id, contacts, "webhook");
  return NextResponse.json({ listId: list.id, ...result }, { status: 201 });
}

function normalizeRecords(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    // tolerate common wrappers: { contacts: [...] } / { data: [...] }
    for (const key of ["contacts", "data", "records", "items"]) {
      if (Array.isArray(obj[key])) return normalizeRecords(obj[key]);
    }
    return [obj];
  }
  return [];
}

function checkWebhookAuth(req: NextRequest, rawBody: string, secret: string | null): boolean {
  if (!secret) return false;
  const shared = req.headers.get("x-webhook-secret");
  if (shared && shared === secret) return true;
  const sig = req.headers.get("x-signature-256");
  if (sig) {
    const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
    const a = Buffer.from(sig.replace(/^sha256=/, ""), "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}
