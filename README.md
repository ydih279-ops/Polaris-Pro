# Polaris

A multi-tenant analytics platform. You upload data (CSV or live webhooks), and Polaris turns it into retention cohorts, conversion funnels, anomaly detection, and forecasts — with alerting, a visual query builder, team roles, and a public REST API on top.

Built as a single deployable Node service: Express, PostgreSQL, and a hand-rolled SVG frontend with no chart library. The whole thing runs on a free tier with no Redis or external queue.

**Live:** set after deploy · **Demo login:** `demo@polaris.app` / `demo123`

## Why it's built the way it is

A few decisions worth calling out, because they're the interesting part:

**The job queue is Postgres, not Redis.** Webhook deliveries get verified, deduped, and dropped onto a `jobs` table; a worker claims them with `SELECT ... FOR UPDATE SKIP LOCKED`. That's a real, contention-free queue pattern — multiple workers can poll the same table without stepping on each other — and it means the app deploys as one service with one datastore. Swapping in Redis later would mean changing one file.

**Custom metrics are a structured spec, never raw SQL.** The visual query builder emits a JSON spec (`{event, agg, filters, groupBy, window}`) that the engine compiles into a parameterized query against an allow-list of aggregates and operators. Users get flexible querying; the database never sees user-authored SQL.

**The statistics are written out, not imported.** Anomaly detection runs a robust IQR fence alongside a rolling z-score. Forecasting is Holt's linear-trend method (double exponential smoothing) with a confidence band that widens by horizon. It's a portfolio piece — the point is to show the work, not to hide it behind a library call.

**Multi-tenancy is enforced, not assumed.** Every row hangs off an `org_id`, every write checks role (`viewer < editor < admin`) in middleware, and every admin action lands in an append-only audit log.

## Features

- **Ingestion** — CSV upload, or signed webhooks (HMAC verification + idempotency keys) with provider adapters for GitHub / Stripe / Slack / generic sources, processed asynchronously through the queue.
- **Analytics** — daily series, retention cohorts, conversion funnels with drop-off, IQR + z-score anomaly detection, Holt's-method forecasting, and auto-generated plain-English insights.
- **Query builder** — visual metric composition with a live EXPLAIN-based cost estimate.
- **Automation** — threshold and anomaly alerts evaluated every 5 minutes; scheduled email/webhook reports via cron.
- **Teams** — invites, three roles, row-level ownership, full audit trail.
- **Public API** — `/api/v1` authenticated by API key with token-bucket rate limiting; everything the UI does is available programmatically.
- **Performance** — in-memory LRU caching and a `daily_rollup` materialized view refreshed on a schedule.

## Run locally

```bash
npm install
cp .env.example .env            # point DATABASE_URL at your Postgres
npm run init-db                 # apply schema (idempotent)
npm run seed                    # 90 days of demo data + a demo API key
npm start                       # http://localhost:5000
```

The worker and scheduler run in-process by default. For scale-out, run `npm run worker` as a separate process — the code already supports it.

## Deploy to Render

Push to GitHub, then in Render: **New > Blueprint**, point it at the repo. `render.yaml` provisions the web service and a free Postgres and wires `DATABASE_URL` automatically. After the first deploy, set `PUBLIC_URL` to your Render URL (so webhook endpoints print correctly), then run `npm run seed` once from the Render shell if you want demo data.

## API example

```bash
curl "$PUBLIC_URL/api/v1/series?datasetId=1" -H "X-API-Key: pk_your_key"
curl -X POST "$PUBLIC_URL/api/v1/events" -H "X-API-Key: pk_your_key" \
  -H "Content-Type: application/json" \
  -d '{"datasetId":1,"events":[{"name":"signup","subject_id":"u_42"}]}'
```

## Layout

```
src/
  server.js              Express app, route wiring, in-process worker + scheduler
  db.js                  pool + transaction helper
  lib/
    analytics.js         metric compiler, cohorts, funnels, anomaly, forecast
    queue.js             Postgres-backed job queue (SKIP LOCKED) + worker loop
    scheduler.js         cron: alert evaluation, rollup refresh, reports
    cache.js             LRU + TTL
    notify.js            email (SMTP) / outbound webhook
  middleware/            auth (JWT + API key), rate limit, audit
  routes/                auth, teams, datasets, webhooks, analytics, metrics, alerts, apikeys
  scripts/               init-db, seed, worker
public/index.html        entire frontend (vanilla JS, SVG charts)
schema.sql               tables, indexes, materialized view
render.yaml              one-click deploy blueprint
```
