import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { defaultDailyCap, endOfDayUtc, intervalDaysFor } from "@/lib/scheduler";
import { requirePageUser, getPageWorkspace } from "@/lib/authz";
import type { Frequency } from "@/lib/enums";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

function fmtDT(d: Date | null): string {
  if (!d) return "—";
  return d.toISOString().slice(0, 16).replace("T", " ");
}
function fmtD(d: Date | null): string {
  if (!d) return "—";
  return d.toISOString().slice(0, 10);
}

export default async function ListDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requirePageUser();
  const workspace = await getPageWorkspace(user.id);
  const list = await db.contactList.findFirst({
    where: { id, workspaceId: workspace.id },
    include: { template: true },
  });
  if (!list) notFound();

  const today = endOfDayUtc(new Date());
  const intervalDays = intervalDaysFor(list.frequency as Frequency, list.customDays);
  const activeCount = await db.contact.count({ where: { listId: id, status: "active" } });
  const totalCount = await db.contact.count({ where: { listId: id } });
  const dueCount = await db.contact.count({
    where: { listId: id, status: "active", nextDueAt: { lte: today } },
  });
  const cap = list.dailyCap ?? defaultDailyCap(activeCount, intervalDays);
  const todaysBatchSize = Math.min(dueCount, cap);

  const page = Math.max(1, Number(sp.page ?? "1") || 1);
  const [contacts, contactPages] = await Promise.all([
    db.contact.findMany({
      where: { listId: id },
      orderBy: [{ nextDueAt: "asc" }, { email: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.contact.count({ where: { listId: id } }),
  ]);
  const totalPages = Math.max(1, Math.ceil(contactPages / PAGE_SIZE));

  const integrations = await db.integration.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "desc" },
  });
  const myIntegrations = integrations.filter((i) => {
    try {
      return (JSON.parse(i.config) as { listId?: string }).listId === id;
    } catch {
      return false;
    }
  });

  const sendLogs = await (async () => {
    const contactIds = (
      await db.contact.findMany({ where: { listId: id }, select: { id: true } })
    ).map((c) => c.id);
    if (contactIds.length === 0) return [];
    return db.sendLog.findMany({
      where: { contactId: { in: contactIds } },
      orderBy: { sentAt: "desc" },
      take: 25,
    });
  })();
  // attach contact emails
  const logContactIds = [...new Set(sendLogs.map((l) => l.contactId))];
  const logContacts = await db.contact.findMany({
    where: { id: { in: logContactIds } },
    select: { id: true, email: true },
  });
  const emailById = new Map(logContacts.map((c) => [c.id, c.email]));

  const suppressionCount = await db.suppression.count({ where: { workspaceId: workspace.id } });
  const baseUrl = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");

  return (
    <>
      <p><a href="/">← all lists</a></p>
      <div className="card">
        <h2 style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {list.name} <span className={`badge ${list.status}`}>{list.status}</span>
        </h2>
        <div className="stat-row">
          <div className="stat"><b>{totalCount}</b><span>contacts</span></div>
          <div className="stat"><b>{activeCount}</b><span>active</span></div>
          <div className="stat"><b>{list.frequency}{list.frequency === "custom" ? ` (${list.customDays}d)` : ""}</b><span>frequency</span></div>
          <div className="stat"><b>{intervalDays}d</b><span>cooldown</span></div>
          <div className="stat"><b>{cap}/day</b><span>{list.dailyCap ? "cap (manual)" : "cap (auto)"}</span></div>
          <div className="stat"><b>{todaysBatchSize}</b><span>due today</span></div>
        </div>

        {sp.upload === "done" && (
          <div className="notice ok">CSV imported: {sp.created} created, {sp.updated} updated, {sp.skipped} skipped.</div>
        )}
        {sp.upload?.startsWith("error") && (
          <div className="notice err">CSV upload failed ({sp.upload}). Make sure the file has a header row with an email column.</div>
        )}
        {sp.ran === "done" && (
          <div className="notice ok">
            Batch run for {sp.date}: {sp.sent} sent, {sp.failed} failed, {sp.skipped} skipped.
          </div>
        )}
        {sp.import === "done" && (
          <div className="notice ok">Import finished: {sp.created} created, {sp.updated} updated.{sp.note ? ` Note: ${sp.note}` : ""}</div>
        )}
        {sp.import === "error" && <div className="notice err">Import failed{sp.msg ? `: ${sp.msg}` : "."}</div>}
        {sp.import === "errorkey" && <div className="notice err">EngineMailer API key missing — set ENGINEMAILER_API_KEY or add one on the integration.</div>}
        {sp.integrated === "done" && <div className="notice ok">Integration created. Details below.</div>}

        <h3>Today's batch</h3>
        <p className="small">
          <b>{todaysBatchSize}</b> contacts are due today (cooldown expired, active, not suppressed).
          Running is idempotent — re-running reuses today's batch and never double-sends.
        </p>
        <form method="post" action={`/api/lists/${id}/run`}>
          <button type="submit">Run today's batch now</button>
        </form>
      </div>

      <div className="grid two">
        <div className="card">
          <h2>Frequency settings</h2>
          <form className="inline" method="post" action={`/api/lists/${id}`}>
            <label className="field">Frequency
              <select name="frequency" defaultValue={list.frequency}>
                <option value="daily">daily (1 day)</option>
                <option value="weekly">weekly (7 days)</option>
                <option value="biweekly">biweekly (14 days)</option>
                <option value="monthly">monthly (30 days)</option>
                <option value="custom">custom</option>
              </select>
            </label>
            <label className="field">Custom days<input type="number" name="customDays" min={1} defaultValue={list.customDays ?? ""} placeholder="e.g. 21" /></label>
            <label className="field">Daily cap<input type="number" name="dailyCap" min={0} defaultValue={list.dailyCap ?? ""} placeholder="auto" /></label>
            <label className="field">Status
              <select name="status" defaultValue={list.status}>
                <option value="active">active</option>
                <option value="paused">paused</option>
                <option value="archived">archived</option>
              </select>
            </label>
            <button type="submit">Save</button>
          </form>
          <p className="muted small">Leave daily cap empty for auto: ceil(active contacts ÷ cooldown days). Paused lists are skipped by the scheduler.</p>
        </div>

        <div className="card">
          <h2>CSV upload</h2>
          <form method="post" action={`/api/lists/${id}/upload`} encType="multipart/form-data">
            <label className="field">CSV file<input type="file" name="file" accept=".csv,text/csv" required /></label>
            <p className="muted small">Header row is auto-mapped (email required; first/last name guessed). Custom columns become passthrough fields. Upserts on email.</p>
            <button type="submit">Upload &amp; ingest</button>
          </form>
        </div>
      </div>

      <div className="card">
        <h2>Email template</h2>
        <form method="post" action={`/api/lists/${id}`}>
          <div className="grid two">
            <label className="field">Subject<input type="text" name="subject" defaultValue={list.template?.subject ?? ""} /></label>
          </div>
          <div className="grid two" style={{ marginTop: 8 }}>
            <label className="field">From name<input type="text" name="fromName" defaultValue={list.template?.fromName ?? ""} placeholder="optional" /></label>
            <label className="field">From email<input type="email" name="fromEmail" defaultValue={list.template?.fromEmail ?? ""} placeholder="optional" /></label>
          </div>
          <label className="field" style={{ marginTop: 8 }}>HTML body
            <textarea name="htmlBody" defaultValue={list.template?.htmlBody ?? ""} />
          </label>
          <p className="muted small">Tokens: <code className="k">{"{{firstName}}"}</code> <code className="k">{"{{lastName}}"}</code> <code className="k">{"{{email}}"}</code> <code className="k">{"{{unsubscribeUrl}}"}</code>. An unsubscribe link is appended automatically if the template omits it.</p>
          <button type="submit">Save template</button>
        </form>
      </div>

      <div className="card">
        <h2>Integrations</h2>
        {myIntegrations.length === 0 && <p className="muted small">No integrations for this list yet.</p>}
        {myIntegrations.map((integ) => (
          <div key={integ.id} style={{ borderTop: "1px solid var(--line)", padding: "12px 0" }}>
            <b>{integ.name}</b> <span className="badge">{integ.type}</span>
            {integ.type === "webhook" && (
              <div className="small" style={{ marginTop: 6 }}>
                <div>URL: <code className="k">{baseUrl}/api/v1/ingest/{integ.id}</code></div>
                <div>Secret: <code className="k">{integ.secret}</code> <span className="muted">(send as <code className="k">x-webhook-secret</code>, or HMAC-SHA256 of the raw body as <code className="k">x-signature-256</code>)</span></div>
              </div>
            )}
            {(integ.type === "enginemailer" || integ.type === "mailchimp") && (
              <form method="post" action={`/api/integrations/${integ.id}/import`} style={{ marginTop: 6 }}>
                <button type="submit" className="secondary">Import contacts now</button>
              </form>
            )}
          </div>
        ))}

        <h3>Add webhook</h3>
        <form className="inline" method="post" action="/api/integrations">
          <input type="hidden" name="type" value="webhook" />
          <input type="hidden" name="listId" value={id} />
          <label className="field">Name<input type="text" name="name" placeholder="Signup form" /></label>
          <label className="field">Email field<input type="text" name="mapEmail" defaultValue="email" /></label>
          <label className="field">First-name field<input type="text" name="mapFirstName" placeholder="firstName" /></label>
          <label className="field">Last-name field<input type="text" name="mapLastName" placeholder="lastName" /></label>
          <button type="submit">Create webhook</button>
        </form>

        <h3>Connect EngineMailer</h3>
        <form method="post" action="/api/integrations">
          <input type="hidden" name="type" value="enginemailer" />
          <input type="hidden" name="listId" value={id} />
          <div className="inline">
            <label className="field">Name<input type="text" name="name" placeholder="EngineMailer import" /></label>
            <label className="field">API key (optional)<input type="password" name="apiKey" placeholder="falls back to ENGINEMAILER_API_KEY" /></label>
            <button type="submit">Save</button>
          </div>
          <label className="field" style={{ marginTop: 8 }}>Subscriber emails (one per line — enriched via subscriber:get)
            <textarea name="emails" style={{ minHeight: 70 }} placeholder="a@example.com&#10;b@example.com" />
          </label>
        </form>
        <p className="muted small">EngineMailer's API has no bulk subscriber-export endpoint, so import works from an explicit email list (each address is looked up and enriched). See README.</p>

        <h3>Connect Mailchimp</h3>
        <form className="inline" method="post" action="/api/integrations">
          <input type="hidden" name="type" value="mailchimp" />
          <input type="hidden" name="listId" value={id} />
          <label className="field">Name<input type="text" name="name" placeholder="Mailchimp audience" /></label>
          <label className="field">API key<input type="password" name="apiKey" required /></label>
          <label className="field">Server prefix<input type="text" name="serverPrefix" required placeholder="us21" /></label>
          <label className="field">Audience ID<input type="text" name="audienceId" required placeholder="a1b2c3d4e5" /></label>
          <button type="submit">Save</button>
        </form>
      </div>

      <div className="card">
        <h2>Contacts <span className="muted small">({contactPages})</span></h2>
        <table>
          <thead><tr><th>Email</th><th>Name</th><th>Status</th><th>Source</th><th>Last sent</th><th>Next due</th></tr></thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.id}>
                <td className="small">{c.email}</td>
                <td className="small">{[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}</td>
                <td><span className={`badge ${c.status}`}>{c.status}</span></td>
                <td className="small muted">{c.source ?? "—"}</td>
                <td className="small">{fmtDT(c.lastSentAt)}</td>
                <td className="small">{fmtD(c.nextDueAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="pager">
          {page > 1 && <a href={`/lists/${id}?page=${page - 1}`}>← prev</a>}
          <span className="muted">page {page} of {totalPages}</span>
          {page < totalPages && <a href={`/lists/${id}?page=${page + 1}`}>next →</a>}
        </div>
      </div>

      <div className="card">
        <h2>Send log <span className="muted small">(latest 25)</span></h2>
        {sendLogs.length === 0 && <p className="muted small">Nothing sent yet.</p>}
        {sendLogs.length > 0 && (
          <table>
            <thead><tr><th>Time</th><th>Contact</th><th>Provider</th><th>Status</th><th>Message ID / error</th></tr></thead>
            <tbody>
              {sendLogs.map((l) => (
                <tr key={l.id}>
                  <td className="small">{fmtDT(l.sentAt)}</td>
                  <td className="small">{emailById.get(l.contactId) ?? l.contactId}</td>
                  <td className="small">{l.provider}</td>
                  <td><span className={`badge ${l.status === "sent" ? "sent" : l.status === "failed" ? "failed" : "pending"}`}>{l.status}</span></td>
                  <td className="small muted">{l.messageId ?? l.error ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">Workspace suppression list: {suppressionCount} addresses (checked at batch-compute and send time).</p>
      </div>
    </>
  );
}
