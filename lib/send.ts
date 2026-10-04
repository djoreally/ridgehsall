// Batch sending orchestration.
//
// Compliance is checked TWICE: at batch-compute time (scheduler) and again at
// send time here — a contact that unsubscribed, bounced, or was suppressed
// between compute and send is skipped, never mailed.

import { db } from "./db";
import { applySend, intervalDaysFor } from "./scheduler";
import { getProvider } from "./providers";
import { renderTemplate } from "./templates";
import { unsubscribeUrlFor } from "./unsubscribe";
import type { Frequency } from "./enums";

export interface SendBatchResult {
  batchId: string;
  sent: number;
  failed: number;
  skipped: number;
}

function listUnsubscribeHeaders(unsubscribeUrl: string): Record<string, string> {
  // RFC 2369 + RFC 8058 one-click. The mailto fallback uses the same token.
  const token = unsubscribeUrl.split("/").pop() ?? "";
  const base = unsubscribeUrl.split("/api/unsubscribe/")[0];
  return {
    "List-Unsubscribe": `<${unsubscribeUrl}>, <mailto:unsubscribe@${new URL(base).hostname}?subject=unsubscribe-${token}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

export async function sendBatch(batchId: string, providerName?: string): Promise<SendBatchResult> {
  const batch = await db.batch.findUnique({
    where: { id: batchId },
    include: {
      list: { include: { workspace: true, template: true } },
      items: { where: { status: "queued" }, include: { contact: true } },
    },
  });
  if (!batch) throw new Error(`batch not found: ${batchId}`);
  if (batch.status === "sent") return { batchId, sent: 0, failed: 0, skipped: 0 };

  const intervalDays = intervalDaysFor(batch.list.frequency as Frequency, batch.list.customDays);
  const suppressions = await db.suppression.findMany({ where: { workspaceId: batch.list.workspaceId } });
  const suppressionSet = new Set(suppressions.map((s) => s.email.toLowerCase()));

  const provider = getProvider(providerName);
  const template = batch.list.template;
  const now = new Date();

  await db.batch.update({ where: { id: batch.id }, data: { status: "sending" } });

  let sent = 0, failed = 0, skipped = 0;

  for (const item of batch.items) {
    const contact = item.contact;
    const emailLower = contact.email.toLowerCase();

    // ---- send-time compliance re-check ----
    if (contact.status !== "active" || suppressionSet.has(emailLower)) {
      await db.batchItem.update({ where: { id: item.id }, data: { status: "skipped" } });
      await db.sendLog.create({
        data: { contactId: contact.id, batchId: batch.id, provider: provider.name, status: "skipped" },
      });
      skipped++;
      continue;
    }

    const unsubscribeUrl = unsubscribeUrlFor(contact.id);
    const subject = renderTemplate(template?.subject ?? "Hello {{firstName}}", {
      firstName: contact.firstName, lastName: contact.lastName, email: contact.email, unsubscribeUrl,
    });
    let html = renderTemplate(
      template?.htmlBody ?? "<p>Hi {{firstName}},</p>",
      { firstName: contact.firstName, lastName: contact.lastName, email: contact.email, unsubscribeUrl }
    );
    // Guarantee an unsubscribe link exists even if the template omitted the token.
    if (!html.includes(unsubscribeUrl)) {
      html += `<p style="font-size:12px;color:#666"><a href="${unsubscribeUrl}">Unsubscribe</a></p>`;
    }

    const fromEmail =
      template?.fromEmail ?? process.env.ENGINEMAILER_FROM_EMAIL ?? process.env.MANDRILL_FROM_EMAIL ?? "noreply@example.com";
    const fromName = template?.fromName ?? process.env.ENGINEMAILER_FROM_NAME ?? process.env.MANDRILL_FROM_NAME;

    const result = await provider.send({
      to: contact.email,
      toName: [contact.firstName, contact.lastName].filter(Boolean).join(" ") || undefined,
      subject,
      html,
      fromEmail,
      fromName,
      headers: listUnsubscribeHeaders(unsubscribeUrl),
    });

    if (result.ok) {
      const { lastSentAt, nextDueAt } = applySend(now, intervalDays);
      await db.contact.update({
        where: { id: contact.id },
        data: { lastSentAt, nextDueAt },
      });
      await db.batchItem.update({ where: { id: item.id }, data: { status: "sent" } });
      await db.sendLog.create({
        data: { contactId: contact.id, batchId: batch.id, provider: provider.name, status: "sent", messageId: result.messageId },
      });
      sent++;
    } else {
      await db.batchItem.update({ where: { id: item.id }, data: { status: "failed" } });
      await db.sendLog.create({
        data: { contactId: contact.id, batchId: batch.id, provider: provider.name, status: "failed", error: result.error },
      });
      failed++;
    }
  }

  await db.batch.update({
    where: { id: batch.id },
    data: { status: failed > 0 && sent === 0 ? "failed" : "sent" },
  });

  return { batchId, sent, failed, skipped };
}
