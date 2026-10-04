// Mailchimp clients:
//  1. Marketing API — audience (list) member import: GET /3.0/lists/{id}/members
//  2. Transactional API (Mandrill) — sending: POST https://mandrillapp.com/api/1.0/messages/send.json

export interface MailchimpMember {
  email: string;
  firstName?: string;
  lastName?: string;
  status?: string;
  fields: Record<string, string>;
}

export class MailchimpError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`Mailchimp API error ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

function basicAuth(apiKey: string): string {
  return "Basic " + Buffer.from(`anystring:${apiKey}`).toString("base64");
}

export interface MailchimpMarketingOptions {
  apiKey: string;
  /** datacenter prefix from the API key suffix, e.g. "us21" for "...-us21" */
  serverPrefix: string;
}

export class MailchimpMarketingClient {
  constructor(private opts: MailchimpMarketingOptions) {}

  private base(): string {
    return `https://${this.opts.serverPrefix}.api.mailchimp.com/3.0`;
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.base()}${path}`, {
      headers: { Authorization: basicAuth(this.opts.apiKey) },
    });
    const text = await res.text();
    if (!res.ok) throw new MailchimpError(res.status, text);
    return text ? JSON.parse(text) : null;
  }

  /** Fetch one page of audience members (subscribed only by default). */
  async listMembers(
    audienceId: string,
    opts: { offset?: number; count?: number; status?: string } = {}
  ): Promise<{ members: MailchimpMember[]; total: number }> {
    const params = new URLSearchParams({
      count: String(opts.count ?? 1000),
      offset: String(opts.offset ?? 0),
      status: opts.status ?? "subscribed",
      fields: "members.email_address,members.status,members.merge_fields,total_items",
    });
    const raw = (await this.get(`/lists/${encodeURIComponent(audienceId)}/members?${params}`)) as {
      members?: Array<{ email_address?: string; status?: string; merge_fields?: Record<string, unknown> }>;
      total_items?: number;
    };
    const members: MailchimpMember[] = (raw.members ?? []).map((m) => {
      const mf = m.merge_fields ?? {};
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(mf)) {
        if (k === "FNAME" || k === "LNAME") continue;
        if (v != null && v !== "") fields[k] = String(v);
      }
      const email = (m.email_address ?? "").toLowerCase();
      return {
        email,
        firstName: (mf.FNAME as string) || undefined,
        lastName: (mf.LNAME as string) || undefined,
        status: m.status,
        fields,
      };
    }).filter((m) => m.email.includes("@"));
    return { members, total: raw.total_items ?? members.length };
  }

  /** Paginate through the whole audience. */
  async listAllMembers(audienceId: string, status = "subscribed"): Promise<MailchimpMember[]> {
    const all: MailchimpMember[] = [];
    let offset = 0;
    for (;;) {
      const { members, total } = await this.listMembers(audienceId, { offset, count: 1000, status });
      all.push(...members);
      offset += members.length;
      if (members.length === 0 || all.length >= total) break;
      if (offset > 100_000) break; // safety valve
    }
    return all;
  }
}

// ---------------------------------------------------------------------------
// Mandrill (Mailchimp Transactional) sending
// ---------------------------------------------------------------------------

export class MandrillClient {
  constructor(private apiKey: string) {}

  async send(opts: {
    fromEmail: string;
    fromName?: string;
    to: string;
    toName?: string;
    subject: string;
    html: string;
    text?: string;
    headers?: Record<string, string>;
  }): Promise<{ ok: boolean; messageId?: string; raw?: unknown }> {
    const res = await fetch("https://mandrillapp.com/api/1.0/messages/send.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: this.apiKey,
        message: {
          html: opts.html,
          ...(opts.text ? { text: opts.text } : {}),
          subject: opts.subject,
          from_email: opts.fromEmail,
          from_name: opts.fromName ?? opts.fromEmail,
          to: [{ email: opts.to, name: opts.toName ?? opts.to, type: "to" }],
          headers: opts.headers ?? {},
        },
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new MailchimpError(res.status, text);
    const parsed = (text ? JSON.parse(text) : []) as Array<{
      email?: string;
      status?: string;
      _id?: string;
      reject_reason?: string | null;
    }>;
    const first = parsed[0];
    if (!first) throw new MailchimpError(res.status, "empty mandrill response");
    const ok = first.status === "sent" || first.status === "queued";
    return { ok, messageId: first._id, raw: parsed };
  }
}
