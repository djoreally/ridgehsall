// Signup/login input validation. Pure functions — easy to test.

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateEmail(email: string): string | null {
  const e = normalizeEmail(email);
  if (!e) return "email is required";
  if (e.length > 254) return "email is too long";
  if (!EMAIL_RE.test(e)) return "enter a valid email address";
  return null;
}

export function validatePassword(password: string): string | null {
  if (!password) return "password is required";
  if (password.length < 8) return "password must be at least 8 characters";
  if (password.length > 128) return "password is too long";
  return null;
}

export function validateSignup(input: { name?: unknown; email?: unknown; password?: unknown }): {
  ok: boolean;
  error?: string;
  name: string;
  email: string;
  password: string;
} {
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 80) : "";
  const email = typeof input.email === "string" ? normalizeEmail(input.email) : "";
  const password = typeof input.password === "string" ? input.password : "";
  const emailErr = validateEmail(email);
  if (emailErr) return { ok: false, error: emailErr, name, email, password };
  const pwErr = validatePassword(password);
  if (pwErr) return { ok: false, error: pwErr, name, email, password };
  return { ok: true, name, email, password };
}
