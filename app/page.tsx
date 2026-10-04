import { db } from "@/lib/db";
import { defaultDailyCap, endOfDayUtc, intervalDaysFor } from "@/lib/scheduler";
import { getDefaultWorkspace } from "@/lib/workspace";
import type { Frequency } from "@/lib/enums";

export const dynamic = "force-dynamic";

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return d.toISOString().slice(0, 16).replace("T", " ");
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const workspace = await getDefaultWorkspace();
  const today = endOfDayUtc(new Date());

  const lists = await db.contactList.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "asc" },
    include: {
      _count: { select: { contacts: true } },
      batches: { orderBy: { date: "desc" }, take: 1 },
    },
  });

  const overview = await Promise.all(
    lists.map(async (l) => {
      const intervalDays = intervalDaysFor(l.frequency as Frequency, l.customDays);
      const activeCount = await db.contact.count({ where: { listId: l.id, status: "active" } });
      const dueCount = await db.contact.count({
        where: { listId: l.id, status: "active", nextDueAt: { lte: today } },
      });
      const cap = l.dailyCap ?? defaultDailyCap(activeCount, intervalDays);
      return { list: l, activeCount, dueToday: Math.min(dueCount, cap), cap, intervalDays };
    })
  );

  const apiKeys = await db.apiKey.findMany({
    where: { workspaceId: workspace.id, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });

  return (
    <>
      {sp.newkey && (
        <div className="notice ok">
          <b>API key created ({sp.keyname}).</b> Copy it now — it won't be shown again:
          <div className="keybox">{sp.newkey}</div>
          Use it as the <code className="k">x-api-key</code> header.
        </div>
      )}

      <div className="card">
        <h2>Lists</h2>
        {overview.length === 0 && <p className="muted">No lists yet — create one below.</p>}
        {overview.length > 0 && (
          <table>
            <thead>
              <tr><th>Name</th><th>Size</th><th>Frequency</th><th>Today's batch</th><th>Last run</th><th>Status</th></tr>
            </thead>
            <tbody>
              {overview.map((o) => (
                <tr key={o.list.id}>
                  <td><a href={`/lists/${o.list.id}`}>{o.list.name}</a></td>
                  <td>{o.list._count.contacts} <span className="muted small">({o.activeCount} active)</span></td>
                  <td>
                    {o.list.frequency}
                    {o.list.frequency === "custom" ? ` (${o.list.customDays}d)` : ""}
                    <span className="muted small"> · cap {o.cap}/day</span>
                  </td>
                  <td><b>{o.dueToday}</b> due</td>
                  <td className="small">
                    {o.list.batches[0] ? (
                      <>{o.list.batches[0].date} <span className={`badge ${o.list.batches[0].status}`}>{o.list.batches[0].status}</span></>
                    ) : "—"}
                  </td>
                  <td><span className={`badge ${o.list.status}`}>{o.list.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h3>Create a list</h3>
        <form className="inline" method="post" action="/api/v1/lists">
          <label className="field">Name<input type="text" name="name" required placeholder="Newsletter" /></label>
          <label className="field">Frequency
            <select name="frequency" defaultValue="weekly">
              <option value="daily">daily</option>
              <option value="weekly">weekly</option>
              <option value="biweekly">biweekly</option>
              <option value="monthly">monthly</option>
              <option value="custom">custom</option>
            </select>
          </label>
          <button type="submit">Create list</button>
        </form>
        <p className="muted small">Note: the dashboard create form only sends name + frequency; fine-tune custom days and caps on the list page. The JSON API accepts the full shape.</p>
      </div>

      <div className="card">
        <h2>API keys</h2>
        <p className="muted small">Keys authenticate the <code className="k">/api/v1/*</code> ingest API and <code className="k">/api/bounces</code> via the <code className="k">x-api-key</code> header.</p>
        {apiKeys.length > 0 && (
          <table>
            <thead><tr><th>Name</th><th>Prefix</th><th>Created</th><th>Last used</th></tr></thead>
            <tbody>
              {apiKeys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td><code className="k">{k.keyPrefix}…</code></td>
                  <td className="small">{fmtDate(k.createdAt)}</td>
                  <td className="small">{fmtDate(k.lastUsedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form className="inline" method="post" action="/api/apikeys" style={{ marginTop: 12 }}>
          <label className="field">Key name<input type="text" name="name" placeholder="default" /></label>
          <button type="submit">Create API key</button>
        </form>
      </div>

      <div className="card">
        <h2>How it works</h2>
        <p className="small">
          Each list has a frequency (daily / weekly / biweekly / monthly / custom N days).
          Every day the scheduler picks contacts whose cooldown has expired (<code className="k">nextDueAt ≤ today</code>),
          oldest-due first, up to the daily cap (default: <code className="k">ceil(list size ÷ interval days)</code> so the
          whole list rotates exactly once per frequency window). After a send, the contact's next due date advances by the
          full interval — so a contact can never appear in two batches less than the interval apart.
          Unsubscribed, bounced, and suppressed contacts are excluded at both batch-compute and send time.
        </p>
        <p className="small muted">
          Scheduler trigger: <code className="k">POST /api/cron/daily</code> with <code className="k">CRON_SECRET</code> (Vercel Cron-ready, idempotent).
          See README for the API reference.
        </p>
      </div>
    </>
  );
}
