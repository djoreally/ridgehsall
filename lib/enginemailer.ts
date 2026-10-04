// EngineMailer REST API client (https://api.enginemailer.com).
// Auth: `APIKey` request header. Subscriber endpoints work on all plans;
// campaign endpoints require a paid account. Shapes verified against the
// enginemailer skill's probed reference (2026-09-25/26) unless marked UNPROBED.

const BASE = "https://api.enginemailer.com";

export interface EngineMailerClientOptions {
  apiKey: string;
}

export class EngineMailerError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`EngineMailer API error ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

export class EngineMailerClient {
  private apiKey: string;
  constructor(opts: EngineMailerClientOptions) {
    this.apiKey = opts.apiKey;
  }

  private async request(path: string, method: "GET" | "POST", body?: unknown): Promise<unknown> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        APIKey: this.apiKey,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep raw text */
    }
    if (!res.ok) throw new EngineMailerError(res.status, text);
    return parsed;
  }

  /** GET /restapi/subscriber/emsubscriber/getSubscriber?email=... -> {SubscriberID, Email, Status} */
  async getSubscriber(email: string): Promise<{ id?: string | number; email?: string; status?: string } | null> {
    const raw = (await this.request(
      `/restapi/subscriber/emsubscriber/getSubscriber?email=${encodeURIComponent(email)}`,
      "GET"
    )) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") return null;
    return {
      id: (raw.SubscriberID as string | number | undefined) ?? (raw.subscriberID as string | number | undefined),
      email: (raw.Email as string | undefined) ?? (raw.email as string | undefined),
      status: (raw.Status as string | undefined) ?? (raw.status as string | undefined),
    };
  }

  /**
   * Transactional send via V2 /RESTAPI/V2/Submission/SendEmail.
   * UNPROBED: this body shape follows EngineMailer's public V2 docs but has not
   * been verified live against the account. Verify with one test send before
   * using in production; the `console` provider is the safe default.
   */
  async sendTransactional(opts: {
    fromEmail: string;
    fromName?: string;
    to: string;
    toName?: string;
    subject: string;
    html: string;
    text?: string;
    headers?: Record<string, string>;
  }): Promise<{ ok: boolean; messageId?: string; raw?: unknown }> {
    const raw = await this.request("/RESTAPI/V2/Submission/SendEmail", "POST", {
      from: { email: opts.fromEmail, name: opts.fromName ?? opts.fromEmail },
      to: [{ email: opts.to, name: opts.toName ?? opts.to }],
      subject: opts.subject,
      html: opts.html,
      ...(opts.text ? { text: opts.text } : {}),
      ...(opts.headers ? { headers: opts.headers } : {}),
    });
    return { ok: true, messageId: undefined, raw };
  }
}

export function engineMailerClientFromEnv(): EngineMailerClient | null {
  const key = process.env.ENGINEMAILER_API_KEY;
  if (!key) return null;
  return new EngineMailerClient({ apiKey: key });
}
