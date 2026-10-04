import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { checkCronSecret } from "@/lib/auth";
import { computeTodaysBatches, dateKey, startOfDayUtc } from "@/lib/scheduler";
import { sendBatch } from "@/lib/send";

export const dynamic = "force-dynamic";

// Daily scheduler trigger. Guarded by CRON_SECRET (Bearer token or ?secret=).
// Vercel Cron issues GET requests; manual runs may POST. Both are accepted.
// Runs across ALL workspaces. Idempotent: computeTodaysBatches reuses today's
// batch rows; sendBatch skips batches already marked sent.
async function run(_req: NextRequest) {
  const workspaces = await db.workspace.findMany({ select: { id: true, name: true } });
  const today = startOfDayUtc(new Date());
  const results = [];
  for (const workspace of workspaces) {
    const summaries = await computeTodaysBatches(workspace.id, today);
    const batches = [];
    for (const s of summaries) {
      if (s.picked === 0 && s.reused) {
        batches.push({ ...s, send: { sent: 0, failed: 0, skipped: 0, note: "already sent" } });
        continue;
      }
      const send = await sendBatch(s.batchId).catch((e: Error) => ({
        batchId: s.batchId,
        sent: 0,
        failed: 0,
        skipped: 0,
        error: e.message,
      }));
      batches.push({ ...s, send });
    }
    results.push({ workspaceId: workspace.id, workspaceName: workspace.name, batches });
  }
  return NextResponse.json({ date: dateKey(today), workspaces: results });
}

export async function GET(req: NextRequest) {
  if (!checkCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return run(req);
}

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return run(req);
}
