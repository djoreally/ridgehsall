import type { Metadata } from "next";
import "./globals.css";
import { getSessionUser } from "@/lib/session";
import { getUserWorkspaces, getPageWorkspace } from "@/lib/authz";

export const metadata: Metadata = {
  title: "ridgehsall — email list batching",
  description: "Ingest contact lists, set a frequency, and let the scheduler deal out compliant daily batches.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const s = await getSessionUser();
  const user = s?.user ?? null;
  const workspaces = user ? await getUserWorkspaces(user.id) : [];
  const active = user ? await getPageWorkspace(user.id).catch(() => null) : null;

  return (
    <html lang="en">
      <body>
        <div className="wrap">
          <header className="top">
            <h1><a href="/">ridgehsall</a></h1>
            {user ? (
              <div className="header-right">
                {workspaces.length > 1 && active && (
                  <form method="post" action="/api/workspaces/switch" className="inline">
                    <label className="field">
                      <select name="id" defaultValue={active.id}>
                        {workspaces.map((w) => (
                          <option key={w.id} value={w.id}>{w.name}</option>
                        ))}
                      </select>
                    </label>
                    <button type="submit" className="secondary">Switch</button>
                  </form>
                )}
                {workspaces.length <= 1 && active && (
                  <span className="muted small" title={active.id}>{active.name}</span>
                )}
                <form method="post" action="/api/workspaces" className="inline">
                  <input type="text" name="name" placeholder="New workspace…" required maxLength={80} style={{ width: 140 }} />
                  <button type="submit" className="secondary">+ New</button>
                </form>
                <span className="muted small">{user.email}</span>
                <form method="post" action="/api/auth/logout">
                  <button type="submit" className="secondary">Log out</button>
                </form>
              </div>
            ) : (
              <div className="header-right">
                <span className="muted small">v0 prototype · email list batching</span>
                <a className="btn secondary" href="/login">Log in</a>
                <a className="btn" href="/signup">Sign up</a>
              </div>
            )}
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
