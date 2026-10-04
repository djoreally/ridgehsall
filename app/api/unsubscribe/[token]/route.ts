import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyUnsubscribeToken } from "@/lib/unsubscribe";

export const dynamic = "force-dynamic";

// GET /api/unsubscribe/:token — one click, no login. Also accepts POST (RFC 8058 one-click).
async function handle(token: string) {
  const contactId = verifyUnsubscribeToken(token);
  if (!contactId) {
    return new NextResponse(unsubPage("Invalid link", "This unsubscribe link is invalid or expired."), {
      status: 400,
      headers: { "Content-Type": "text/html" },
    });
  }
  const contact = await db.contact.findUnique({ where: { id: contactId } });
  if (!contact) {
    return new NextResponse(unsubPage("Not found", "This contact no longer exists."), {
      status: 404,
      headers: { "Content-Type": "text/html" },
    });
  }
  await db.contact.update({ where: { id: contactId }, data: { status: "unsubscribed" } });
  // also add to the workspace suppression list so re-ingests can't resurrect them
  const list = await db.contactList.findUnique({ where: { id: contact.listId }, select: { workspaceId: true } });
  if (list) {
    await db.suppression.upsert({
      where: { workspaceId_email: { workspaceId: list.workspaceId, email: contact.email.toLowerCase() } },
      update: { reason: "unsubscribed via one-click link" },
      create: { workspaceId: list.workspaceId, email: contact.email.toLowerCase(), reason: "unsubscribed via one-click link" },
    });
  }
  return new NextResponse(unsubPage("Unsubscribed", `Done — ${escapeHtml(contact.email)} won't receive these emails anymore.`), {
    headers: { "Content-Type": "text/html" },
  });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return handle(token);
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return handle(token);
}

function unsubPage(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:520px;margin:80px auto;padding:0 20px;text-align:center"><h1>${escapeHtml(title)}</h1><p>${message}</p></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
