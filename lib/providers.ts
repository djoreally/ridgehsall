// Sending providers. One clean interface; four implementations:
//   console      — logs to stdout (default for local dev)
//   enginemailer — real, via lib/enginemailer.ts (V2 transactional; UNPROBED shape)
//   mailchimp    — real, via Mandrill (Mailchimp Transactional)
//   resend       — real, via lib/resend.ts (single + batch endpoints; the hosted-mode default)

import { EngineMailerClient } from "./enginemailer";
import { MandrillClient } from "./mailchimp";
import { ResendClient } from "./resend";

export interface SendRequest {
  to: string;
  toName?: string;
  subject: string;
  html: string;
  text?: string;
  fromEmail: string;
  fromName?: string;
  /** maps to Resend `reply_to`; ignored by providers without reply-to support */
  replyTo?: string;
  headers?: Record<string, string>;
  tags?: { name: string; value: string }[];
  /** stable per item — used as the Resend Idempotency-Key so retries never double-send */
  idempotencyKey?: string;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface EmailProvider {
  name: string;
  send(req: SendRequest): Promise<SendResult>;
  /** Bulk path. When absent, callers fall back to sequential send(). */
  sendMany?(reqs: SendRequest[]): Promise<SendResult[]>;
}

export class ConsoleProvider implements EmailProvider {
  name = "console";
  async send(req: SendRequest): Promise<SendResult> {
    const id = `console-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(
      `[console-provider] to=${req.to} subject=${JSON.stringify(req.subject)} id=${id}`
    );
    return { ok: true, messageId: id };
  }
}

export class EngineMailerProvider implements EmailProvider {
  name = "enginemailer";
  private client: EngineMailerClient;
  constructor(apiKey: string) {
    this.client = new EngineMailerClient({ apiKey });
  }
  async send(req: SendRequest): Promise<SendResult> {
    try {
      const r = await this.client.sendTransactional({
        fromEmail: req.fromEmail,
        fromName: req.fromName,
        to: req.to,
        toName: req.toName,
        subject: req.subject,
        html: req.html,
        text: req.text,
        headers: req.headers,
      });
      return { ok: r.ok, messageId: r.messageId };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

export class MandrillProvider implements EmailProvider {
  name = "mailchimp";
  private client: MandrillClient;
  constructor(apiKey: string) {
    this.client = new MandrillClient(apiKey);
  }
  async send(req: SendRequest): Promise<SendResult> {
    try {
      const r = await this.client.send({
        fromEmail: req.fromEmail,
        fromName: req.fromName,
        to: req.to,
        toName: req.toName,
        subject: req.subject,
        html: req.html,
        text: req.text,
        headers: req.headers,
      });
      return { ok: r.ok, messageId: r.messageId };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

export type ProviderName = "console" | "enginemailer" | "mailchimp" | "resend";

export class ResendProvider implements EmailProvider {
  name = "resend";
  private client: ResendClient;
  constructor(apiKey: string) {
    this.client = new ResendClient(apiKey);
  }

  private toItem(req: SendRequest) {
    const from = req.fromName ? `${req.fromName} <${req.fromEmail}>` : req.fromEmail;
    return {
      from,
      to: req.to,
      subject: req.subject,
      html: req.html,
      text: req.text,
      replyTo: req.replyTo,
      headers: req.headers,
      tags: req.tags,
      idempotencyKey: req.idempotencyKey,
    };
  }

  async send(req: SendRequest): Promise<SendResult> {
    try {
      const id = await this.client.sendEmail(this.toItem(req));
      return { ok: true, messageId: id };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Bulk path via POST /emails/batch (max 100/request, chunked internally).
   * Never throws: a failed chunk marks every item in it failed, so the caller
   * can record per-contact results. Length of the returned array always
   * matches reqs.
   */
  async sendMany(reqs: SendRequest[]): Promise<SendResult[]> {
    const out: SendResult[] = new Array(reqs.length);
    for (let i = 0; i < reqs.length; i += 100) {
      const chunk = reqs.slice(i, i + 100);
      const keyPrefix = chunk[0]?.idempotencyKey ?? `ridgehsall-batch-${Date.now()}`;
      try {
        const ids = await this.client.sendBatch(chunk.map((r) => this.toItem(r)), keyPrefix);
        chunk.forEach((_, j) => {
          out[i + j] = { ok: true, messageId: ids[j] };
        });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        chunk.forEach((_, j) => {
          out[i + j] = { ok: false, error };
        });
      }
    }
    return out;
  }
}

/**
 * Resolve the configured provider from env. Throws with a clear message when misconfigured.
 * In hosted mode (HOSTED_MODE=true) the default is resend so a new signup can
 * send immediately with zero provider setup; otherwise the default is console.
 */
export function getProvider(name?: string): EmailProvider {
  const hosted = process.env.HOSTED_MODE === "true";
  const n = (name ?? process.env.EMAIL_PROVIDER ?? (hosted ? "resend" : "console")).toLowerCase();
  if (n === "console") return new ConsoleProvider();
  if (n === "enginemailer") {
    const key = process.env.ENGINEMAILER_API_KEY;
    if (!key) throw new Error("EMAIL_PROVIDER=enginemailer requires ENGINEMAILER_API_KEY");
    return new EngineMailerProvider(key);
  }
  if (n === "mailchimp") {
    const key = process.env.MANDRILL_API_KEY;
    if (!key) throw new Error("EMAIL_PROVIDER=mailchimp requires MANDRILL_API_KEY (Mailchimp Transactional)");
    return new MandrillProvider(key);
  }
  if (n === "resend") {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error("EMAIL_PROVIDER=resend requires RESEND_API_KEY");
    if (!process.env.RESEND_FROM_DOMAIN) {
      throw new Error("EMAIL_PROVIDER=resend requires RESEND_FROM_DOMAIN (a domain verified in the Resend dashboard)");
    }
    return new ResendProvider(key);
  }
  throw new Error(`unknown EMAIL_PROVIDER: ${n}`);
}
