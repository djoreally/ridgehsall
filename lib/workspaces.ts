// Workspace membership helpers: pure DB, no Next context (testable).
// The golden rule: these NEVER return a workspace the user is not a member of.

import { db } from "./db";

/**
 * Resolve the user's active workspace: the requested id when the user is a
 * member of it, otherwise the user's oldest membership.
 * Throws when the user belongs to no workspace at all.
 */
export async function resolveActiveWorkspace(userId: string, requestedId?: string | null) {
  if (requestedId) {
    const m = await db.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId: requestedId } },
      include: { workspace: true },
    });
    if (m) return m.workspace;
  }
  const first = await db.workspaceMember.findFirst({
    where: { userId },
    orderBy: { createdAt: "asc" },
    include: { workspace: true },
  });
  if (!first) throw new Error("user has no workspace");
  return first.workspace;
}

export async function getUserWorkspaces(userId: string) {
  const memberships = await db.workspaceMember.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    include: { workspace: true },
  });
  return memberships.map((m) => ({ ...m.workspace, role: m.role }));
}
