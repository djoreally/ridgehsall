import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authenticateApiKey } from "@/lib/auth";
import { isFrequency } from "@/lib/enums";
import { intervalDaysFor } from "@/lib/scheduler";
import { getDefaultWorkspace } from "@/lib/workspace";

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

// POST /api/v1/lists — create a list. Also used by the dashboard (falls back
// to the default workspace when no API key is present — v0 open dashboard).
export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  const workspaceId = auth?.workspaceId ?? (await getDefaultWorkspace()).id;

  let body: Record<string, unknown>;
  const contentType = req.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  try {
    body = isJson ? await req.json() : Object.fromEntries((await req.formData()).entries());
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const frequency = body.frequency ?? "weekly";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (!isFrequency(frequency)) {
    return NextResponse.json({ error: "frequency must be one of daily|weekly|biweekly|monthly|custom" }, { status: 400 });
  }
  let customDays: number | null = null;
  if (frequency === "custom") {
    customDays = Number(body.customDays);
    if (!Number.isInteger(customDays) || customDays < 1) {
      return NextResponse.json({ error: "custom frequency requires customDays >= 1" }, { status: 400 });
    }
  }
  try {
    intervalDaysFor(frequency, customDays);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "bad frequency" }, { status: 400 });
  }

  const list = await db.contactList.create({
    data: {
      workspaceId,
      name,
      frequency,
      customDays,
      dailyCap: typeof body.dailyCap === "number" && body.dailyCap > 0 ? Math.floor(body.dailyCap) : null,
      template: { create: {} },
    },
  });
  if (!isJson) {
    return NextResponse.redirect(new URL(`/lists/${list.id}`, req.url), 303);
  }
  return NextResponse.json({ id: list.id, name: list.name, frequency: list.frequency }, { status: 201 });
}
