## JunkQuoteAgent Service

Messenger-first junk removal quoting agent built on the OpenAI Agents SDK. Ships a single Fastify service with Prisma/Postgres persistence, a lightweight admin UI, and Render deployment manifest.

### Requirements

- Node.js 22+
- `npm` (or `pnpm`/`yarn`)
- Postgres 14+
- OpenAI API key with Responses + vision access

### Environment Variables

| Name | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Used by the agent and image analysis tool. |
| `DATABASE_URL` | Prisma connection string for Postgres. |
| `ADMIN_PASSWORD` | Required password for `/admin` basic auth. |
| `BASE_URL` | Public base URL used for calendar links (e.g. `https://junkquote.onrender.com`). |
| `FB_PAGE_ID` | Facebook Page ID for Messenger. |
| `FB_APP_ID` | Facebook App ID (webhook verification). |
| `FB_APP_SECRET` | Facebook App secret. |
| `FB_PAGE_ACCESS_TOKEN` | Page access token for sending messages. |
| `FB_VERIFY_TOKEN` | Shared secret used during webhook verification. |
| `TWILIO_ACCOUNT_SID` | Account SID for Twilio REST API (SMS). |
| `TWILIO_AUTH_TOKEN` | Auth token for Twilio REST API and webhook validation. |
| `TWILIO_FROM_NUMBER` | Twilio phone number (E.164) used to send outbound SMS. |
| `TWILIO_WEBHOOK_URL` *(optional)* | Absolute URL Twilio should send webhooks to (used for signature validation when behind proxies). |
| `PORT` *(optional)* | Port to bind locally (default `3000`). |

### Local Development

```bash
npm install
npx prisma migrate dev
npm run seed          # optional demo data
npm run dev           # starts Fastify with hot reload
npm run test          # vitest unit tests for pricing engine
```
`npm run start` (and the Render service) automatically runs `npm run prisma:migrate:deploy` before the server launches so your database schema is always up to date. You can still execute the command manually if you prefer to control migrations yourself.

Messenger webhook:

- Expose via ngrok/tunnel and configure the Facebook App with `https://<tunnel>/api/messenger`.
- Verify token must match `FB_VERIFY_TOKEN`.

Twilio webhook:

- Point your Twilio phone number's Messaging webhook to `https://<tunnel>/api/twilio/sms`.
- Set `TWILIO_WEBHOOK_URL` to the public callback URL if you are behind a proxy so signature validation succeeds.

Admin panel:

- Visit `http://localhost:3000/admin`. Supply `ADMIN_PASSWORD` via browser basic auth.
- Seed script (`npm run seed`) loads two demo leads/quotes plus the config from `config/junk.json`.

### Render Deployment

1. Provision a Postgres instance (Render dashboard → **New** → **PostgreSQL**). Note the database name for `render.yaml`.
2. Add a **Web Service** pointing to this repository.
3. Render automatically detects `render.yaml`:
   - Web service `junkquote-agent` with build `npm ci && npm run build` and start `npm run start`.
   - Postgres database `junkquote-db`.
4. In the Render dashboard, set the environment variables listed above. `DATABASE_URL` is auto-wired from the database.
5. Deploy. After first boot, run `npm run seed` locally (or via Render shell) if you want demo data.
6. Update the Facebook webhook URL to `https://<render-service>/api/messenger` and reverify with `FB_VERIFY_TOKEN`.

### Project Layout

```
config/             Tenant configuration (loaded + stored in DB)
prisma/             Prisma schema, migrations, seed data
src/agent/          JunkQuoteAgent definition
src/tools/          Tool implementations (vision, pricing, scheduling, messaging)
src/routes/         Fastify routes (Messenger, SMS, Admin, Approval)
src/lib/            Shared utilities (OpenAI, Prisma, runner, pricing engine)
src/views/          EJS templates for admin + approvals
storage/calendar/   Generated iCal holds (served at /calendar/*)
```

### Snapshot Data

The pricebook and service area live in `config/junk.json`. Update this file and re-run `npm run seed` to refresh system config for local demos.
