import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await getSessionUser();
  if (s) redirect("/");
  const sp = await searchParams;

  return (
    <div className="auth-wrap">
      <div className="card">
        <h2>Log in to ridgehsall</h2>
        {sp.error && <div className="notice err">{sp.error}</div>}
        <form method="post" action="/api/auth/login" className="form-stack">
          <label className="field">
            Email
            <input type="email" name="email" required autoComplete="email" placeholder="you@example.com" />
          </label>
          <label className="field">
            Password
            <input type="password" name="password" required autoComplete="current-password" />
          </label>
          <button type="submit">Log in</button>
        </form>
        <p className="small muted" style={{ marginTop: 14 }}>
          No account yet? <a href="/signup">Sign up</a>
        </p>
      </div>
    </div>
  );
}
