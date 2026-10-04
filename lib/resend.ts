// Resend provider: single + batch sends, Svix webhook verification,
// and bounce/complaint handlers.
//
// Reputation note (hosted mode): every workspace sends from the platform's
// shared verified domain. One workspace's bounces or spam complaints hurt
// deliverability for everyone, so Resend's bounce/complaint webhooks
// auto-suppress the offending addresses workspace-wide the moment they arrive.
// This is checked on top of the per-send suppression checks in lib/send.ts.

import { createHmac, timingSafeEqual } from "crypto";
import { db } from "./db";

const RESEND_API = "https://api.resend.com";
const BATCH_LIMIT = 100;

export interface ResendSendItem {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** maps to Resend's `reply_to` */
  replyTo?: string;
  headers?: Record<string, string>;
  tags?: { name: string; value: string }[];
  idempotencyKey?: string;
}

function toPayload(item: ResendSendItem): Record<string, unknown> {
  return {
    from: item.from,
    to: [item.to],
    subject: item.subject,
    html: item.html,
    ...(item.text ? { text: item.text } : {}),
    ...(item.replyTo ? { reply_to: item.replyTo } : {}),
    ...(item.headers ? { headers: item.headers } : {}),
    ...(item.tags && item.tags.length > 0 ? { tags: item.tags } : {}),
  };
}

export class ResendClient {
  constructor(private apiKey: string) {}

  private async post(path: string, body: unknown, idempotencyKey?: string): Promise<any> {
    const res = await fetch(`${RESEND_API}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.message ?? data?.error ?? `Resend ${path} failed with status ${res.status}`;
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    return data;
  }

  /** Single send -> Resend email id. */
  async sendEmail(item: ResendSendItem): Promise<string> {
    const data = await this.post("/emails", toPayload(item), item.idempotencyKey);
    if (!data?.id) throw new Error("Resend /emails returned no id");
    return data.id as string;
  }

  /**
   * Batch send -> one id per item, in order.
   * Chunks into groups of 100 (Resend's limit). Each chunk gets a stable
   * idempotency key derived from the chunk's first item so a retried chunk
   * doesn't double-send.
   */
  async sendBatch(items: ResendSendItem[], keyPrefix: string): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < items.length; i += BATCH_LIMIT) {
      const chunk = items.slice(i, i + BATCH_LIMIT);
      const data = await this.post(
        "/emails/batch",
        chunk.map(toPayload),
        `${keyPrefix}-chunk-${i / BATCH_LIMIT}`
      );
      const arr = data?.data;
      if (!Array.isArray(arr)) throw new Error("Resend /emails/batch returned an unexpected shape");
      ids.push(...arr.map((e: any) => e.id as string));
    }
    return ids;
  }
}

// ---------------------------------------------------------------------------
// Svix webhook verification (Resend signs webhooks in the Svix format).
//
// Signed content:  "<svix-id>.<svix-timestamp>.<raw body bytes>"
// Key:             base64-decode(RESEND_WEBHOOK_SECRET minus the "whsec_" prefix)
// Signature:       base64(HMAC-SHA256(key, signed content)), sent as
//                  "v1,<sig>" in the svix-signature header (space-separated if rotated).
// The raw body must be verified — never JSON.parse then re-stringify.
// ---------------------------------------------------------------------------

export interface SvixHeaders {
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
}

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export function verifySvixWebhook(rawBody: string, headers: SvixHeaders, secret: string): unknown {
  if (!headers.svixId || !headers.svixTimestamp || !headers.svixSignature) {
    throw new Error("missing svix headers");
  }
  const ts = Number(headers.svixTimestamp);
  if (!Number.isFinite(ts)) throw new Error("invalid svix timestamp");
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > SIGNATURE_TOLERANCE_SECONDS) {
    throw new Error("svix timestamp outside tolerance (possible replay)");
  }

  const b64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const key = Buffer.from(b64, "base64");
  if (key.length === 0) throw new Error("invalid webhook secret");

  const signed = `${headers.svixId}.${headers.svixTimestamp}.${rawBody}`;
  const expected = createHmac("sha256", key).update(signed, "utf8").digest();

  let ok = false;
  for (const part of headers.svixSignature.split(" ")) {
    const v = part.startsWith("v1,") ? part.slice(3) : part;
    let candidate: Buffer;
    try {
      candidate = Buffer.from(v, "base64");
    } catch {
      continue;
    }
    if (candidate.length !== expected.length) continue;
    if (timingSafeEqual(candidate, expected)) {
      ok = true;
      break;
    }
  }
  if (!ok) throw new Error("svix signature mismatch");
  return JSON.parse(rawBody);
}

// ---------------------------------------------------------------------------
// Webhook event handlers. Bounces and complaints are applied to EVERY contact
// row carrying the address (it may exist in several lists/workspaces) and to
// each workspace's suppression list, so the address can never be mailed again.
// Both operations are idempotent — Resend retries are safe.
// ---------------------------------------------------------------------------

export interface ResendWebhookEvent {
  type: string;
  data?: { to?: string[]; email_id?: string };
}

async function suppressEverywhere(email: string, status: "bounced" | "unsubscribed", reason: string): Promise<number> {
  const lower = email.toLowerCase();
  const contacts = await db.contact.findMany({
    where: { OR: [{ email: lower }, { email }] },
    include: { list: { select: { workspaceId: true } } },
  });
  for (const c of contacts) {
    if (c.status !== status) {
      await db.contact.update({ where: { id: c.id }, data: { status } });
    }
    await db.suppression.upsert({
      where: { workspaceId_email: { workspaceId: c.list.workspaceId, email: lower } },
      update: { reason },
      create: { workspaceId: c.list.workspaceId, email: lower, reason },
    });
  }
  // Even with no matching contact, the address must never be mailed from a
  // workspace that imported it later — but without a workspace to attach to,
  // there is nothing to suppress against. Contacts are the source of truth.
  return contacts.length;
}

export async function applyResendBounce(email: string): Promise<number> {
  return suppressEverywhere(email, "bounced", "resend hard bounce");
}

export async function applyResendComplaint(email: string): Promise<number> {
  return suppressEverywhere(email, "unsubscribed", "resend spam complaint");
}

export async function handleResendEvent(event: ResendWebhookEvent): Promise<{ handled: boolean; affected: number }> {
  const recipients = event.data?.to ?? [];
  if (event.type === "email.bounced") {
    let affected = 0;
    for (const email of recipients) affected += await applyResendBounce(email);
    return { handled: true, affected };
  }
  if (event.type === "email.complained") {
    let affected = 0;
    for (const email of recipients) affected += await applyResendComplaint(email);
    return { handled: true, affected };
  }
  return { handled: false, affected: 0 };
}
