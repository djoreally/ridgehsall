// String-union "enums" (the schema uses plain String columns so the same
// schema works on SQLite and Postgres; validation happens here).

export const FREQUENCIES = ["daily", "weekly", "biweekly", "monthly", "custom"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const LIST_STATUSES = ["active", "paused", "archived"] as const;
export type ListStatus = (typeof LIST_STATUSES)[number];

export const CONTACT_STATUSES = ["active", "unsubscribed", "bounced"] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const BATCH_STATUSES = ["pending", "sending", "sent", "failed"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const ITEM_STATUSES = ["queued", "sent", "failed", "skipped"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const INTEGRATION_TYPES = ["webhook", "enginemailer", "mailchimp"] as const;
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];

export function isFrequency(v: unknown): v is Frequency {
  return typeof v === "string" && (FREQUENCIES as readonly string[]).includes(v);
}
export function isListStatus(v: unknown): v is ListStatus {
  return typeof v === "string" && (LIST_STATUSES as readonly string[]).includes(v);
}
export function isContactStatus(v: unknown): v is ContactStatus {
  return typeof v === "string" && (CONTACT_STATUSES as readonly string[]).includes(v);
}
export function isIntegrationType(v: unknown): v is IntegrationType {
  return typeof v === "string" && (INTEGRATION_TYPES as readonly string[]).includes(v);
}
