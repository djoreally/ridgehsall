// Session management: httpOnly cookie sessions backed by the Session table.
// The cookie holds a random token; only its SHA-256 is stored server-side.

import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import {
  createSessionRecord,
  destroySessionRecord,
  findSessionUserByToken,
  SESSION_MAX_AGE_SECONDS,
} from "./session-store";

export const SESSION_COOKIE = "rh_session";
export const WORKSPACE_COOKIE = "rh_workspace";

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

export async function createSession(userId: string): Promise<string> {
  const { token } = await createSessionRecord(userId);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, cookieOptions());
  return token;
}

/** Server components / layouts: read the session from the request cookies. */
export async function getSessionUser() {
  const jar = await cookies();
  return findSessionUserByToken(jar.get(SESSION_COOKIE)?.value);
}

/** Route handlers: read the session from a NextRequest. */
export async function getSessionUserFromRequest(req: NextRequest) {
  return findSessionUserByToken(req.cookies.get(SESSION_COOKIE)?.value);
}

export async function destroySession() {
  const jar = await cookies();
  await destroySessionRecord(jar.get(SESSION_COOKIE)?.value);
  jar.delete(SESSION_COOKIE);
  jar.delete(WORKSPACE_COOKIE);
}

export async function setActiveWorkspaceCookie(workspaceId: string) {
  const jar = await cookies();
  jar.set(WORKSPACE_COOKIE, workspaceId, {
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export { hashSessionToken } from "./session-store";
