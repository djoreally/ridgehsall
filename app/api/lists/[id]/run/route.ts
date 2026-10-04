import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeTodaysBatches, dateKey, startOfDayUtc } from "@/lib/scheduler";
import { sendBatch } from "@/lib/send";
import { getDashboardContext } from "@/lib/authz";

export const dynamic = "force-dynamic";

// POST /api/lists/:id/run — "Run today's batches now" (dashboard button).
// Computes today's batch for this list and sends it immediately.
// Idempotent: re-running reuses today's batch; already-sent batches are skipped.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getDashboardContext(req);
  if ("error" in ctx) return ctx.error;
  const { workspace } = ctx;
  const list = await db.contactList.findFirst({ where: { id, workspaceId: workspace.id } });
  if (!list) return NextResponse.json({ error: "list not found" }, { status: 404 });

  const today = startOfDayUtc(new Date());
  const summaries = await computeTodaysBatches(workspace.id, today);
  const mine = summaries.find((s) => s.listId === id);
  if (!mine) return NextResponse.json({ error: "list is not active" }, { status: 400 });

  let sent = 0, failed = 0, skipped = 0;
  const existing = await db.batch.findUnique({ where: { id: mine.batchId } });
  if (existing && existing.status !== "sent") {
    const r = await sendBatch(mine.batchId);
    sent = r.sent; failed = r.failed; skipped = r.skipped;
  }
  const q = new URLSearchParams({
    ran: "done",
    date: dateKey(today),
    sent: String(sent),
    failed: String(failed),
    skipped: String(skipped),
  });
  return NextResponse.redirect(new URL(`/lists/${id}?${q}`, req.url), 303);
}
