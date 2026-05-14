# Agentic Publicist

AI-powered PR outreach tool. Paste a brief → agent finds journalists → drafts personalized pitches → you approve → pitches send.

**Stack:** Single Cloudflare Worker · D1 (SQLite) · Cloudflare Queues · Resend · Anthropic Claude
**Auth:** Cloudflare Access (Zero Trust, Google SSO)
**Dashboard:** `publicist.engageengine.ai`

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create D1 database

```bash
wrangler d1 create publicist
```

Copy the `database_id` output and paste it into `wrangler.toml`.

### 3. Create the queue

```bash
wrangler queues create publicist-pipeline
wrangler queues create publicist-pipeline-dlq
```

### 4. Initialize schema + seed entities

```bash
npm run db:init      # local dev
npm run db:seed      # local dev
```

### 5. Set secrets

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put HUNTER_API_KEY
wrangler secret put RESEND_API_KEY
wrangler secret put RESEND_WEBHOOK_SECRET   # From Resend dashboard → Webhooks
wrangler secret put TELEGRAM_BOT_TOKEN      # Optional
wrangler secret put TELEGRAM_CHAT_ID        # Optional
```

### 6. Configure Cloudflare Access

In [Zero Trust dashboard](https://one.dash.cloudflare.com):
1. Access → Applications → Add application → Self-hosted
2. Application domain: `publicist.engageengine.ai`
3. Identity providers: Google
4. Policy: Allow your email address

### 7. Configure Resend webhook

In [Resend dashboard](https://resend.com/webhooks):
1. Add webhook URL: `https://publicist.engageengine.ai/api/webhook/resend`
2. Events: `email.bounced`, `email.complained`
3. Copy signing secret → `wrangler secret put RESEND_WEBHOOK_SECRET`

### 8. Set up external cron (coverage monitoring)

On [cron-job.org](https://cron-job.org):
- URL: `https://publicist.engageengine.ai/api/coverage/poll`
- Method: POST
- Schedule: Daily at 7:00 AM

### 9. Deploy

```bash
npm run deploy
```

---

## Development

```bash
npm run dev          # Local dev server (wrangler dev)
npm run db:init      # Initialize local D1
npm run db:seed      # Seed entities locally
npm test             # Run test suite
```

---

## User Flow

1. Go to `/brief` → select entity → paste announcement brief → click "Generate Pitches"
2. Wait ~45 seconds on the progress screen (Queue Consumer runs the pipeline)
3. Go to `/queue` → review pitches → APPROVE or SKIP each one
4. Click "Send N Approved" to send all approved pitches via Resend
5. Go to `/coverage` to track media mentions

---

## Architecture

```
POST /api/generate
  → validates brief
  → inserts into D1 briefs table (status: pending)
  → enqueues { briefId } to Cloudflare Queue
  → redirects to /progress/:briefId

Queue Consumer (async, up to 15 min):
  → idempotency check (brief.status field)
  → Call 1: Claude generates 3 story angles
  → Call 2: Hunter.io finds journalists per beat domain
  → filter by 30-day cooldown (cross-brief rate limiting)
  → Call 3: Claude drafts personalized pitch per journalist
  → writes pitches to D1 (status: pending)
  → updates brief.status = complete

/queue polls /api/pitches every 3s until complete
User approves pitches → POST /api/pitches/:id/approve
POST /api/send → Resend delivers approved pitches
POST /api/webhook/resend → marks bounced pitches in D1
POST /api/coverage/poll → Google News RSS → D1 → Telegram
```

---

## Entity Configuration

Entities (Robbie Butt, EngageEngine, Marketing Performance) are seeded via `seed.sql`. To add or update an entity, edit `seed.sql` and re-run `npm run db:seed`.

---

## Test Suite

Tests cover the 5 critical paths identified in the engineering review:

| Test | What it covers |
|------|----------------|
| `idempotency.test.js` | Queue Consumer: `complete` brief acks, `error` brief cleans + retries |
| `beat_domains.test.js` | Unknown beat returns `[]` — pipeline continues |
| `hash_url.test.js` | Same URL ±query params → same hash (Web Crypto) |
| `journalist_cooldown.test.js` | 15-day cooldown = excluded, 45-day = included |
| `promise_allsettled.test.js` | 1 of 3 pitch drafts fails → 2 pitches saved, no throw |

```bash
npm test
```
