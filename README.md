# ridgehsall — v0 prototype

Multi-tenant marketing-email **list batching** SaaS. Ingest contact lists through
every channel (CSV upload, REST API, inbound webhooks, EngineMailer import,
Mailchimp audience import), set a **frequency rule** per list (daily / weekly /
biweekly / monthly / custom N days), and the scheduler deals out a **batch every
day** containing only contacts whose cooldown has expired — so sends go out
daily without ever violating any list's frequency rule.

## How the scheduler works

- Each list has a frequency → cooldown in days (daily=1, weekly=7,
  biweekly=14, monthly=30, custom=N).
- Every contact carries `nextDueAt`. Each day the scheduler picks contacts with
  `status=active AND nextDueAt <= end of today AND not suppressed`, oldest-due
  first, up to the daily cap.
- Default daily cap = `ceil(active contacts ÷ cooldown days)`, so the whole
  list rotates exactly once per frequency window (e.g. 1,019 contacts on a
  21-day cycle → 49/day).
- After a send: `lastSentAt = now`, `nextDueAt = now + cooldown`.
- **Invariant (proven by tests): a contact is never in two batches less than
  the cooldown apart.** See `tests/scheduler.test.ts` — unit tests plus a
  day-by-day simulation over multiple windows asserting the invariant, full
  rotation coverage, unsubscribed/bounced/suppressed exclusion, new-contact
  fairness, and custom-N-day cycles.
- Compliance is checked **twice**: at batch-compute time and again at send
  time. Unsubscribed/bounced/suppressed contacts are never mailed.
- Running the scheduler twice for the same date is idempotent
  (`Batch @@unique([listId, date])`; sent batches are never re-sent).

## Local setup

```bash
npm install
cp .env.example .env
npm run db:push     # creates prisma/dev.db (SQLite)
npm run dev         # http://localhost:3000
```

Useful scripts: `npm run build`, `npm run typecheck` (`tsc --noEmit`),
`npm test` (`vitest run`).

## Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `PRISMA_SCHEMA` | no | `prisma/schema.prisma` | Set to `prisma/schema.postgres.prisma` for Postgres |
| `DATABASE_URL` | yes | `file:./dev.db` | SQLite path or Postgres connection string |
| `APP_BASE_URL` | no | `http://localhost:3000` | Used to build unsubscribe URLs |
| `CRON_SECRET` | yes (prod) | — | Guards `POST /api/cron/daily` (Bearer or `?secret=`) |
| `UNSUBSCRIBE_SECRET` | yes (prod) | ephemeral per-process | HMAC secret for unsubscribe tokens |
| `EMAIL_PROVIDER` | no | `console` | `console` \| `enginemailer` \| `mailchimp` |
| `ENGINEMAILER_API_KEY` | for provider | — | EngineMailer `APIKey` header |
| `ENGINEMAILER_FROM_EMAIL` / `_FROM_NAME` | for provider | — | Default sender |
| `MANDRILL_API_KEY` | for provider | — | Mailchimp Transactional (Mandrill) key |
| `MANDRILL_FROM_EMAIL` / `_FROM_NAME` | for provider | — | Default sender |

## API reference

All `/api/v1/*` routes (except the webhook ingest URL) authenticate with the
`x-api-key` header. Create a key in the dashboard (home page) — it's shown once.

```bash
KEY=rh_...
# lists
curl -s localhost:3000/api/v1/lists -H "x-api-key: $KEY"
curl -s -X POST localhost:3000/api/v1/lists -H "x-api-key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Newsletter","frequency":"weekly"}'
# custom frequency + manual cap:
#   {"name":"VIP","frequency":"custom","customDays":21,"dailyCap":50}

# ingest contacts (single object or array; upserts on email)
curl -s -X POST localhost:3000/api/v1/lists/<id>/contacts -H "x-api-key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '[{"email":"a@example.com","firstName":"Ann","fields":{"plan":"pro"}}]'

# inbound webhook (per-integration URL + secret from the dashboard):
#   POST /api/v1/ingest/<integrationId>
#   auth:  x-webhook-secret: <secret>
#      or  x-signature-256: <hex HMAC-SHA256 of raw body>
#   body:  single object or array (field mapping configured on the integration)

# register bounces (excluded from all future batches + added to suppression)
curl -s -X POST localhost:3000/api/bounces -H "x-api-key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"email":"b@example.com","reason":"hard bounce"}'

# run the daily scheduler (Vercel Cron or manual)
curl -s -X POST "localhost:3000/api/cron/daily?secret=$CRON_SECRET"

# unsubscribe (one click, no login; GET renders a confirmation page)
#   GET /api/unsubscribe/<token>   (also accepts POST — RFC 8058 one-click)
```

Every send carries `List-Unsubscribe` (https + mailto) and
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers. Templates support
`{{firstName}} {{lastName}} {{email}} {{unsubscribeUrl}}`; an unsubscribe link
is appended automatically if the template omits it.

## Vercel deploy

1. Set `PRISMA_SCHEMA=prisma/schema.postgres.prisma` and `DATABASE_URL` to your
   Postgres URL, plus `CRON_SECRET`, `UNSUBSCRIBE_SECRET`, `APP_BASE_URL`.
2. Build command: `npm run build` (runs `prisma generate` with the right schema).
   Run `npm run db:push` once against the Postgres DB to create tables.
3. Cron: `vercel.json` already schedules `GET /api/cron/daily?secret=$CRON_SECRET`
   daily at 09:00 ET (`0 13 * * *` UTC). Set `CRON_SECRET` in the project env —
   Vercel substitutes `$CRON_SECRET` in the cron path.

## Provider setup

**EngineMailer** — set `EMAIL_PROVIDER=enginemailer` + `ENGINEMAILER_API_KEY`
(the `APIKey` request header for `api.enginemailer.com`). Sending uses the V2
transactional endpoint `POST /RESTAPI/V2/Submission/SendEmail`.

> ⚠️ The V2 send body shape follows EngineMailer's public docs but is
> **unprobed** against a live account — verify with one test send (the
> `console` provider is the safe default). Subscriber endpoints used for
> import (`subscriber:get`) are probed and confirmed.

Import: EngineMailer's V1 API has **no bulk subscriber-export endpoint**, so
the EngineMailer integration imports from an explicit email list you provide —
each address is enriched via `subscriber:get` (id, email, status) and upserted.
Campaign endpoints require a paid EngineMailer account.

**Mailchimp** — two separate keys:
- *Import* (Marketing API): create an integration with your Mailchimp API key,
  the server prefix (the `usXX` suffix of the key), and the Audience ID.
  Members are paginated via `GET /3.0/lists/{id}/members` (`FNAME`/`LNAME` →
  first/last name, other merge fields → passthrough).
- *Sending* (Transactional/Mandrill): set `EMAIL_PROVIDER=mailchimp` +
  `MANDRILL_API_KEY` (a Mandrill API key from Mailchimp Transactional —
  **not** the Marketing API key). Sends via
  `POST https://mandrillapp.com/api/1.0/messages/send.json`.

## v0 limitations (honest)

- **Auth**: the dashboard is open (single default workspace); only the
  `/api/v1/*` ingest API and `/api/bounces` require API keys, and the cron
  endpoint requires `CRON_SECRET`. Real user auth (login, teams, roles) is a
  follow-up.
- **Single-node scheduler**: one process runs the cron. Multi-instance needs a
  distributed lock (the `@@unique([listId, date])` key prevents duplicate
  batches, but two nodes could both create items concurrently).
- **Integration secrets** (Mailchimp/EngineMailer API keys on integrations) are
  stored as plaintext JSON in the DB — encrypt at rest before production.
- **No open/click tracking** yet; `SendLog` records provider send/skip/fail only.
- **No email validation** beyond regex; no double opt-in flow.
- EngineMailer V2 transactional send shape is unprobed (see above).
- Timezone: scheduling is UTC day-granularity; per-workspace timezones are a
  follow-up.
- `prisma/dev.db` is gitignored; Postgres needs `PRISMA_SCHEMA` switching
  (Prisma doesn't allow `env()` in the provider field).
