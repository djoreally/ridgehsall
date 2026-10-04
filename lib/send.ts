// Batch sending orchestration.
//
// Compliance is checked TWICE: at batch-compute time (scheduler) and again at
// send time here — a contact that unsubscribed, bounced, or was suppressed
// between compute and send is skipped, never mailed.
//
// Hosted mode (HOSTED_MODE=true): sends go through Resend on the platform's
// shared verified domain, and a per-workspace daily cap is enforced BEFORE
// anything goes out. Contacts beyond the cap are NOT dropped — their queued
// batch items are deleted so tomorrow's compute re-picks them in order.

import { db } from "./db";
import { applySend, intervalDaysFor } from "./scheduler";
import { getProvider, type SendRequest, type SendResult } from "./providers";
import { renderTemplate } from "./templates";
import { unsubscribeUrlFor } from "./unsubscribe";
import { isHostedMode, hostedDailyCap, sentTodayCount } from "./hosted";
import type { Frequency } from "./enums";

export interface SendBatchResult {
  batchId: string;
  sent: number;
  failed: number;
  skipped: number;
  /** eligible contacts deferred by the hosted daily cap — retried tomorrow, never dropped */
  capped: number;
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

/** Minimal format gate. Resend's batch endpoint is atomic — one malformed
 *  address would fail the whole chunk — so invalid addresses are failed
 *  individually before batching. */
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

interface PendingSend {
  itemId: string;
  contactId: string;
  req: SendRequest;
}

export async function sendBatch(batchId: string, providerName?: string): Promise<SendBatchResult> {
  const batch = await db.batch.findUnique({
    where: { id: batchId },
    include: {
      list: { include: { workspace: true, template: true } },
      items: { where: { status: "queued" } },
    },
  });
  if (!batch) throw new Error(`batch not found: ${batchId}`);
  if (batch.status === "sent") return { batchId, sent: 0, failed: 0, skipped: 0, capped: 0 };

  const intervalDays = intervalDaysFor(batch.list.frequency as Frequency, batch.list.customDays);
  const suppressions = await db.suppression.findMany({ where: { workspaceId: batch.list.workspaceId } });
  const suppressionSet = new Set(suppressions.map((s) => s.email.toLowerCase()));

  const contacts = await db.contact.findMany({
    where: { id: { in: batch.items.map((i) => i.contactId) } },
  });
  const contactById = new Map(contacts.map((c) => [c.id, c]));

  const provider = getProvider(providerName);
  const isResend = provider.name === "resend";
  const hosted = isHostedMode();
  const template = batch.list.template;
  const workspace = batch.list.workspace;
  const now = new Date();

  // ---- sending identity ----
  // Resend only delivers from verified domains, so the From address is always
  // the platform's verified domain. The workspace's identity travels in the
  // display name and in reply_to — which is why the dashboard asks for a
  // "from name" and a reply-to address instead of a from address.
  let fromEmail: string;
  let fromName: string | undefined;
  let replyTo: string | undefined;
  if (isResend) {
    const domain = process.env.RESEND_FROM_DOMAIN; // validated by getProvider
    fromEmail = `noreply@${domain}`;
    fromName = workspace.fromName ?? template?.fromName ?? process.env.RESEND_FROM_NAME ?? workspace.name;
    replyTo = workspace.replyToEmail ?? undefined;
  } else {
    fromEmail =
      template?.fromEmail ?? process.env.ENGINEMAILER_FROM_EMAIL ?? process.env.MANDRILL_FROM_EMAIL ?? "noreply@example.com";
    fromName = template?.fromName ?? process.env.ENGINEMAILER_FROM_NAME ?? process.env.MANDRILL_FROM_NAME;
  }

  await db.batch.update({ where: { id: batch.id }, data: { status: "sending" } });

  let sent = 0, failed = 0, skipped = 0;
  const pending: PendingSend[] = [];

  const markItem = async (itemId: string, status: "skipped" | "failed", contactId?: string, error?: string) => {
    await db.batchItem.update({ where: { id: itemId }, data: { status } });
    if (contactId) {
      await db.sendLog.create({
        data: { contactId, batchId: batch.id, provider: provider.name, status, error },
      });
    }
  };

  for (const item of batch.items) {
    const contact = contactById.get(item.contactId);
    if (!contact) {
      await db.batchItem.update({ where: { id: item.id }, data: { status: "skipped" } });
      skipped++;
      continue;
    }
    const emailLower = contact.email.toLowerCase();

    // ---- send-time compliance re-check ----
    if (contact.status !== "active" || suppressionSet.has(emailLower)) {
      await markItem(item.id, "skipped", contact.id);
      skipped++;
      continue;
    }

    // ---- format gate (Resend batch atomicity) ----
    if (isResend && !isValidEmail(contact.email)) {
      await markItem(item.id, "failed", contact.id, "invalid email format");
      failed++;
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

    pending.push({
      itemId: item.id,
      contactId: contact.id,
      req: {
        to: contact.email,
        toName: [contact.firstName, contact.lastName].filter(Boolean).join(" ") || undefined,
        subject,
        html,
        fromEmail,
        fromName,
        replyTo,
        headers: listUnsubscribeHeaders(unsubscribeUrl),
        tags: [
          { name: "ridgehsall_batch", value: batch.id },
          { name: "ridgehsall_workspace", value: batch.list.workspaceId },
        ],
        idempotencyKey: `ridgehsall-item-${item.id}`,
      },
    });
  }

  // ---- hosted daily cap: send up to the cap, defer the rest to tomorrow ----
  let capped = 0;
  let toSend = pending;
  if (hosted) {
    const cap = hostedDailyCap();
    const used = await sentTodayCount(batch.list.workspaceId, now);
    const remaining = Math.max(0, cap - used);
    if (pending.length > remaining) {
      capped = pending.length - remaining;
      toSend = pending.slice(0, remaining);
      // Deferred contacts keep their due dates and lose their queued items, so
      // tomorrow's compute re-picks them in rotation order. Nothing is dropped.
      const deferredIds = pending.slice(remaining).map((p) => p.itemId);
      await db.batchItem.deleteMany({ where: { id: { in: deferredIds } } });
      console.warn(
        `[ridgehsall] hosted daily cap: workspace ${batch.list.workspaceId} sent ${toSend.length}, ` +
        `deferred ${capped} to tomorrow (cap ${cap}/day, ${used} already sent today)`
      );
    }
  }

  // ---- send ----
  const results: SendResult[] = [];
  if (toSend.length > 1 && typeof provider.sendMany === "function") {
    results.push(...await provider.sendMany(toSend.map((p) => p.req)));
  } else {
    for (const p of toSend) {
      try {
        results.push(await provider.send(p.req));
      } catch (e) {
        results.push({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  for (let i = 0; i < toSend.length; i++) {
    const p = toSend[i];
    const result = results[i] ?? { ok: false, error: "no result from provider" };
    if (result.ok) {
      const { lastSentAt, nextDueAt } = applySend(now, intervalDays);
      await db.contact.update({
        where: { id: p.contactId },
        data: { lastSentAt, nextDueAt },
      });
      await db.batchItem.update({ where: { id: p.itemId }, data: { status: "sent" } });
      await db.sendLog.create({
        data: { contactId: p.contactId, batchId: batch.id, provider: provider.name, status: "sent", messageId: result.messageId },
      });
      sent++;
    } else {
      await markItem(p.itemId, "failed", p.contactId, result.error);
      failed++;
    }
  }

  await db.batch.update({
    where: { id: batch.id },
    data: { status: failed > 0 && sent === 0 ? "failed" : "sent" },
  });

  return { batchId, sent, failed, skipped, capped };
}
