// Shared contact-list creation logic used by the dashboard (/api/lists,
// session auth) and the programmatic API (/api/v1/lists, API-key auth).

import { db } from "./db";
import { isFrequency } from "./enums";
import { intervalDaysFor } from "./scheduler";

export class ListInputError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ListInputError";
  }
}

export interface CreateListFields {
  name: string;
  frequency: string;
  customDays: number | null;
  dailyCap: number | null;
}

export function parseCreateListBody(body: Record<string, unknown>): CreateListFields {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const frequency = body.frequency ?? "weekly";
  if (!name) throw new ListInputError("name is required");
  if (!isFrequency(frequency)) {
    throw new ListInputError("frequency must be one of daily|weekly|biweekly|monthly|custom");
  }
  let customDays: number | null = null;
  if (frequency === "custom") {
    customDays = Number(body.customDays);
    if (!Number.isInteger(customDays) || customDays < 1) {
      throw new ListInputError("custom frequency requires customDays >= 1");
    }
  }
  try {
    intervalDaysFor(frequency, customDays);
  } catch (e) {
    throw new ListInputError(e instanceof Error ? e.message : "bad frequency");
  }
  const capRaw = body.dailyCap;
  const dailyCap =
    typeof capRaw === "number" && capRaw > 0
      ? Math.floor(capRaw)
      : typeof capRaw === "string" && capRaw.trim() !== "" && Number(capRaw) > 0
        ? Math.floor(Number(capRaw))
        : null;
  return { name, frequency, customDays, dailyCap };
}

export async function createContactList(workspaceId: string, fields: CreateListFields) {
  return db.contactList.create({
    data: {
      workspaceId,
      name: fields.name,
      frequency: fields.frequency,
      customDays: fields.customDays,
      dailyCap: fields.dailyCap,
      template: { create: {} },
    },
  });
}
