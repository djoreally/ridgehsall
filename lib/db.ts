import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __ridgehsallPrisma: PrismaClient | undefined;
}

export const db: PrismaClient =
  globalThis.__ridgehsallPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__ridgehsallPrisma = db;
}
