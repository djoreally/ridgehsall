import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { upsertContacts, type IngestContact } from "@/lib/ingest";
import { EngineMailerClient } from "@/lib/enginemailer";
import { MailchimpMarketingClient } from "@/lib/mailchimp";
import { getDashboardContext } from "@/lib/authz";

export const dynamic = "force-dynamic";

// POST /api/integrations/:id/import — pull contacts from EngineMailer or
// Mailchimp into the integration's target list (dashboard button).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getDashboardContext(req);
  if ("error" in ctx) return ctx.error;
  const { workspace } = ctx;
  const integration = await db.integration.findFirst({ where: { id, workspaceId: workspace.id } });
  if (!integration) return NextResponse.json({ error: "integration not found" }, { status: 404 });

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(integration.config);
  } catch {
    return NextResponse.json({ error: "integration config is corrupt" }, { status: 500 });
  }
  const listId = String(config.listId ?? "");
  if (!listId) return NextResponse.json({ error: "integration has no target list" }, { status: 400 });

  let contacts: IngestContact[] = [];
  let note = "";

  if (integration.type === "enginemailer") {
    // EngineMailer's V1 API has no bulk subscriber-export endpoint, so import
    // works from an explicit email list: each address is enriched via
    // subscriber:get (id, email, status) and upserted.
    const apiKey = (config.apiKey as string) || process.env.ENGINEMAILER_API_KEY;
    if (!apiKey) {
      return NextResponse.redirect(new URL(`/lists/${listId}?import=errorkey`, req.url), 303);
    }
    const client = new EngineMailerClient({ apiKey });
    const emails = (config.emails as string[]) ?? [];
    for (const email of emails) {
      try {
        const sub = await client.getSubscriber(email);
        if (sub && sub.email) {
          contacts.push({ email: sub.email.toLowerCase(), fields: { enginemailerStatus: sub.status ?? "" } });
        } else {
          note += `not found in EngineMailer: ${email}; `;
        }
      } catch (e) {
        note += `error for ${email}: ${e instanceof Error ? e.message : String(e)}; `;
      }
    }
  } else if (integration.type === "mailchimp") {
    const client = new MailchimpMarketingClient({
      apiKey: String(config.apiKey ?? ""),
      serverPrefix: String(config.serverPrefix ?? ""),
    });
    const audienceId = String(config.audienceId ?? "");
    try {
      const members = await client.listAllMembers(audienceId, "subscribed");
      contacts = members.map((m) => ({
        email: m.email,
        firstName: m.firstName,
        lastName: m.lastName,
        fields: m.fields,
      }));
    } catch (e) {
      return NextResponse.redirect(
        new URL(`/lists/${listId}?import=error&msg=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`, req.url),
        303
      );
    }
  } else {
    return NextResponse.json({ error: "import not supported for webhook integrations" }, { status: 400 });
  }

  const result = await upsertContacts(listId, contacts, integration.type);
  const q = new URLSearchParams({
    import: "done",
    created: String(result.created),
    updated: String(result.updated),
    ...(note ? { note: note.slice(0, 200) } : {}),
  });
  return NextResponse.redirect(new URL(`/lists/${listId}?${q}`, req.url), 303);
}
