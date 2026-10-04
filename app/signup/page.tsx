import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function Signup({
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
        <h2>Create your account</h2>
        <p className="small muted" style={{ marginTop: -6 }}>
          Signing up creates your personal workspace — your lists live there, private to you.
        </p>
        {sp.error && <div className="notice err">{sp.error}</div>}
        <form method="post" action="/api/auth/signup" className="form-stack">
          <label className="field">
            Name
            <input type="text" name="name" autoComplete="name" placeholder="Jane Doe" maxLength={80} />
          </label>
          <label className="field">
            Email
            <input type="email" name="email" required autoComplete="email" placeholder="you@example.com" />
          </label>
          <label className="field">
            Password
            <input type="password" name="password" required autoComplete="new-password" placeholder="At least 8 characters" />
          </label>
          <button type="submit">Sign up</button>
        </form>
        <p className="small muted" style={{ marginTop: 14 }}>
          Already have an account? <a href="/login">Log in</a>
        </p>
      </div>
    </div>
  );
}
