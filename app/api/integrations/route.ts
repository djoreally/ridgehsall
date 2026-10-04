import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { isIntegrationType } from "@/lib/enums";
import { getDefaultWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

// POST /api/integrations — create an integration (dashboard form).
// Types:
//   webhook:     listId, mapEmail, mapFirstName?, mapLastName?  -> returns URL + secret
//   enginemailer: listId, apiKey? (falls back to ENGINEMAILER_API_KEY), emails (one per line)
//   mailchimp:   listId, apiKey, serverPrefix, audienceId
export async function POST(req: NextRequest) {
  const workspace = await getDefaultWorkspace();
  const form = await req.formData();
  const type = String(form.get("type") ?? "");
  const name = String(form.get("name") ?? "").trim() || `${type} integration`;
  const listId = String(form.get("listId") ?? "");

  if (!isIntegrationType(type)) return NextResponse.json({ error: "bad type" }, { status: 400 });
  if (!listId) return NextResponse.json({ error: "listId is required" }, { status: 400 });
  const list = await db.contactList.findFirst({ where: { id: listId, workspaceId: workspace.id } });
  if (!list) return NextResponse.json({ error: "list not found" }, { status: 400 });

  let config: Record<string, unknown> = { listId };
  let secret: string | null = null;

  if (type === "webhook") {
    secret = randomBytes(24).toString("hex");
    config.mapping = {
      email: String(form.get("mapEmail") ?? "email"),
      ...(form.get("mapFirstName") ? { firstName: String(form.get("mapFirstName")) } : {}),
      ...(form.get("mapLastName") ? { lastName: String(form.get("mapLastName")) } : {}),
    };
    config.extraFields = "passthrough";
  } else if (type === "enginemailer") {
    const emails = String(form.get("emails") ?? "")
      .split(/[\n,;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    config = { listId, emails, apiKey: String(form.get("apiKey") ?? "") || null };
  } else if (type === "mailchimp") {
    const apiKey = String(form.get("apiKey") ?? "");
    const serverPrefix = String(form.get("serverPrefix") ?? "");
    const audienceId = String(form.get("audienceId") ?? "");
    if (!apiKey || !serverPrefix || !audienceId) {
      return NextResponse.json({ error: "mailchimp needs apiKey, serverPrefix, audienceId" }, { status: 400 });
    }
    config = { listId, apiKey, serverPrefix, audienceId };
  }

  const integration = await db.integration.create({
    data: { workspaceId: workspace.id, type, name, config: JSON.stringify(config), secret },
  });

  const q = new URLSearchParams({ integrated: "done", integrationId: integration.id });
  return NextResponse.redirect(new URL(`/lists/${listId}?${q}`, req.url), 303);
}
