import { NextRequest, NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { computeTodaysBatches, dateKey, startOfDayUtc } from "@/lib/scheduler";
import { sendBatch } from "@/lib/send";
import { getDefaultWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

// Daily scheduler trigger. Guarded by CRON_SECRET (Bearer token or ?secret=).
// Vercel Cron issues GET requests; manual runs may POST. Both are accepted.
// Idempotent: computeTodaysBatches reuses today's batch rows; sendBatch skips
// batches already marked sent.
async function run(_req: NextRequest) {
  const workspace = await getDefaultWorkspace();
  const today = startOfDayUtc(new Date());
  const summaries = await computeTodaysBatches(workspace.id, today);
  const results = [];
  for (const s of summaries) {
    if (s.picked === 0 && s.reused) {
      results.push({ ...s, send: { sent: 0, failed: 0, skipped: 0, note: "already sent" } });
      continue;
    }
    const send = await sendBatch(s.batchId).catch((e: Error) => ({
      batchId: s.batchId,
      sent: 0,
      failed: 0,
      skipped: 0,
      error: e.message,
    }));
    results.push({ ...s, send });
  }
  return NextResponse.json({ date: dateKey(today), workspaceId: workspace.id, batches: results });
}

export async function GET(req: NextRequest) {
  if (!checkCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return run(req);
}

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return run(req);
}
