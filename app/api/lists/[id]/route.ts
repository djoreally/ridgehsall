import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isFrequency, isListStatus } from "@/lib/enums";
import { intervalDaysFor } from "@/lib/scheduler";
import { getDefaultWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

// PATCH /api/lists/:id — update frequency settings, dailyCap, status, and/or template.
// Accepts JSON (API-ish) or form posts from the dashboard. HTML forms can't
// send PATCH, so POST is also accepted (dashboard forms post here directly).
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleUpdate(req, ctx);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleUpdate(req, ctx);
}

async function handleUpdate(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspace = await getDefaultWorkspace();
  const list = await db.contactList.findFirst({ where: { id, workspaceId: workspace.id } });
  if (!list) return NextResponse.json({ error: "list not found" }, { status: 404 });

  const contentType = req.headers.get("content-type") ?? "";
  const body: Record<string, unknown> = contentType.includes("application/json")
    ? await req.json()
    : Object.fromEntries((await req.formData()).entries());

  const data: Record<string, unknown> = {};
  if (body.frequency !== undefined) {
    if (!isFrequency(body.frequency)) return NextResponse.json({ error: "bad frequency" }, { status: 400 });
    let customDays: number | null = null;
    if (body.frequency === "custom") {
      customDays = Number(body.customDays ?? list.customDays);
      if (!Number.isInteger(customDays) || customDays < 1) {
        return NextResponse.json({ error: "custom frequency requires customDays >= 1" }, { status: 400 });
      }
    }
    intervalDaysFor(body.frequency, customDays); // validates
    data.frequency = body.frequency;
    data.customDays = customDays;
  }
  if (body.dailyCap !== undefined) {
    const cap = Number(body.dailyCap);
    data.dailyCap = cap > 0 ? Math.floor(cap) : null; // empty/0 = auto
  }
  if (body.status !== undefined) {
    if (!isListStatus(body.status)) return NextResponse.json({ error: "bad status" }, { status: 400 });
    data.status = body.status;
  }
  if (Object.keys(data).length > 0) {
    await db.contactList.update({ where: { id }, data });
  }

  if (body.subject !== undefined || body.htmlBody !== undefined || body.fromName !== undefined || body.fromEmail !== undefined) {
    await db.template.upsert({
      where: { listId: id },
      update: {
        ...(body.subject !== undefined ? { subject: String(body.subject) } : {}),
        ...(body.htmlBody !== undefined ? { htmlBody: String(body.htmlBody) } : {}),
        ...(body.fromName !== undefined ? { fromName: String(body.fromName) || null } : {}),
        ...(body.fromEmail !== undefined ? { fromEmail: String(body.fromEmail) || null } : {}),
      },
      create: {
        listId: id,
        subject: String(body.subject ?? "Hello {{firstName}}"),
        htmlBody: String(body.htmlBody ?? "<p>Hi {{firstName}},</p>"),
        fromName: body.fromName ? String(body.fromName) : null,
        fromEmail: body.fromEmail ? String(body.fromEmail) : null,
      },
    });
  }

  if (!contentType.includes("application/json")) {
    return NextResponse.redirect(new URL(`/lists/${id}`, req.url), 303);
  }
  return NextResponse.json({ ok: true });
}
