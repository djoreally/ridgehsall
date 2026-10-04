// Resend webhook receiver: POST /api/webhooks/resend
//
// Handles email.bounced -> contact marked bounced + workspace suppression,
// and email.complained -> contact unsubscribed + workspace suppression.
//
// This endpoint is PUBLIC, so Svix signature verification is the only thing
// standing between real Resend events and forged ones. We fail closed: no
// secret configured, or a bad signature, means no processing.

import { NextRequest, NextResponse } from "next/server";
import { verifySvixWebhook, handleResendEvent, type ResendWebhookEvent } from "@/lib/resend";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "webhook secret not configured" }, { status: 500 });
  }

  // The raw bytes must be verified — never JSON.parse then re-stringify.
  const raw = await req.text();
  let event: ResendWebhookEvent;
  try {
    event = verifySvixWebhook(
      raw,
      {
        svixId: req.headers.get("svix-id") ?? "",
        svixTimestamp: req.headers.get("svix-timestamp") ?? "",
        svixSignature: req.headers.get("svix-signature") ?? "",
      },
      secret
    ) as ResendWebhookEvent;
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  if (!event || typeof event.type !== "string") {
    return NextResponse.json({ error: "malformed event" }, { status: 400 });
  }

  const result = await handleResendEvent(event);
  return NextResponse.json({ ok: true, type: event.type, ...result });
}
