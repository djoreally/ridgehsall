// Sending providers. One clean interface; three implementations:
//   console      — logs to stdout (default for the prototype)
//   enginemailer — real, via lib/enginemailer.ts (V2 transactional; UNPROBED shape)
//   mailchimp    — real, via Mandrill (Mailchimp Transactional)

import { EngineMailerClient } from "./enginemailer";
import { MandrillClient } from "./mailchimp";

export interface SendRequest {
  to: string;
  toName?: string;
  subject: string;
  html: string;
  text?: string;
  fromEmail: string;
  fromName?: string;
  headers?: Record<string, string>;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface EmailProvider {
  name: string;
  send(req: SendRequest): Promise<SendResult>;
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

export type ProviderName = "console" | "enginemailer" | "mailchimp";

/** Resolve the configured provider from env. Throws with a clear message when misconfigured. */
export function getProvider(name?: string): EmailProvider {
  const n = (name ?? process.env.EMAIL_PROVIDER ?? "console").toLowerCase();
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
  throw new Error(`unknown EMAIL_PROVIDER: ${n}`);
}
