import { db } from "./db";

/** v0: a single default workspace. Real multi-user auth is a follow-up. */
export async function getDefaultWorkspace() {
  let ws = await db.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  if (!ws) {
    ws = await db.workspace.create({ data: { name: "Default workspace" } });
  }
  return ws;
}
