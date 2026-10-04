import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authenticateApiKey } from "@/lib/auth";

export const dynamic = "force-dynamic";

// POST /api/bounces — register bounces (from a provider webhook or manual report).
// Body: { email: "...", listId?: "...", reason?: "..." } or an array of those.
// Bounced contacts are excluded from all future batches. Auth: x-api-key.
export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return NextResponse.json({ error: "invalid or missing x-api-key" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const items = (Array.isArray(body) ? body : [body]) as Array<{
    email?: unknown;
    listId?: unknown;
    reason?: unknown;
  }>;

  let marked = 0;
  const errors: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const email = String(items[i]?.email ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      errors.push(`item ${i}: invalid email`);
      continue;
    }
    const listFilter =
      typeof items[i]?.listId === "string"
        ? { listId: items[i].listId as string }
        : { list: { workspaceId: auth.workspaceId } };
    const contacts = await db.contact.findMany({ where: { email, ...listFilter }, select: { id: true } });
    for (const c of contacts) {
      await db.contact.update({ where: { id: c.id }, data: { status: "bounced" } });
      marked++;
    }
    await db.suppression.upsert({
      where: { workspaceId_email: { workspaceId: auth.workspaceId, email } },
      update: { reason: (items[i]?.reason as string) ?? "bounce" },
      create: { workspaceId: auth.workspaceId, email, reason: (items[i]?.reason as string) ?? "bounce" },
    });
  }
  return NextResponse.json({ marked, errors });
}
