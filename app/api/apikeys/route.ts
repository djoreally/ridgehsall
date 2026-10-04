import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { generateApiKey } from "@/lib/apikey";
import { getDashboardContext } from "@/lib/authz";

export const dynamic = "force-dynamic";

// POST /api/apikeys — create an API key for the default workspace (dashboard).
// The raw key is shown ONCE via ?newkey=... — store it, it can't be retrieved again.
export async function POST(req: NextRequest) {
  const ctx = await getDashboardContext(req);
  if ("error" in ctx) return ctx.error;
  const { workspace } = ctx;
  const form = await req.formData().catch(() => null);
  const name = (form?.get("name") ? String(form.get("name")) : "default").trim() || "default";

  const { raw, hash, prefix } = generateApiKey();
  await db.apiKey.create({ data: { workspaceId: workspace.id, name, keyHash: hash, keyPrefix: prefix } });

  const q = new URLSearchParams({ newkey: raw, keyname: name });
  return NextResponse.redirect(new URL(`/?${q}`, req.url), 303);
}
