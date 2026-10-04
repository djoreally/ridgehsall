// Dashboard authorization: session guards + per-user workspace scoping.
// Every dashboard page/route goes through these — a user can only ever see
// workspaces they are a member of.

import { redirect } from "next/navigation";
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  getSessionUser,
  getSessionUserFromRequest,
  WORKSPACE_COOKIE,
} from "./session";
import { getUserWorkspaces, resolveActiveWorkspace } from "./workspaces";

export { getUserWorkspaces };

/** Pages: redirect to /login when there is no valid session. */
export async function requirePageUser() {
  const s = await getSessionUser();
  if (!s) redirect("/login");
  return s.user;
}

/** API routes: null when there is no valid session (caller returns 401). */
export async function getApiUser(req: NextRequest) {
  const s = await getSessionUserFromRequest(req);
  return s?.user ?? null;
}

export function unauthorizedJson() {
  return NextResponse.json({ error: "unauthorized — please log in" }, { status: 401 });
}

/** Route handlers: active workspace from the rh_workspace cookie. */
export async function getRequestWorkspace(req: NextRequest, userId: string) {
  return resolveActiveWorkspace(userId, req.cookies.get(WORKSPACE_COOKIE)?.value ?? null);
}

/** Server components: active workspace from the rh_workspace cookie. */
export async function getPageWorkspace(userId: string) {
  const jar = await cookies();
  return resolveActiveWorkspace(userId, jar.get(WORKSPACE_COOKIE)?.value ?? null);
}

/** Helper for dashboard API routes: session user + their active workspace. */
export async function getDashboardContext(req: NextRequest) {
  const user = await getApiUser(req);
  if (!user) return { error: unauthorizedJson() as NextResponse };
  const workspace = await getRequestWorkspace(req, user.id);
  return { user, workspace };
}
