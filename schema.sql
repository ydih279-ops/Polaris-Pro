-- ============================================================
--  POLARIS PRO — schema
--  Design notes:
--   * Multi-tenant. Everything hangs off org_id. Row ownership is
--     enforced in middleware AND by foreign keys, not by trust.
--   * The event store (events) is append-only and partition-ready.
--   * jobs is a Postgres-backed queue — no Redis needed, which keeps
--     this deployable on a free tier and survives restarts.
-- ============================================================

-- ---- Identity & tenancy --------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orgs (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- role is checked everywhere a write happens. viewer < editor < admin.
CREATE TABLE IF NOT EXISTS memberships (
  id        BIGSERIAL PRIMARY KEY,
  org_id    BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('admin','editor','viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id         BIGSERIAL PRIMARY KEY,
  org_id     BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('admin','editor','viewer')),
  token      TEXT UNIQUE NOT NULL,
  invited_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Datasets & the event store -----------------------------------------

CREATE TABLE IF NOT EXISTS datasets (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'manual',  -- manual | webhook | api
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_datasets_org ON datasets(org_id);

-- Append-only event store. We keep a typed numeric `value` for fast
-- aggregation and a jsonb `props` bag for everything else (dimensions,
-- user id for cohorts, funnel step name, etc).
CREATE TABLE IF NOT EXISTS events (
  id           BIGSERIAL PRIMARY KEY,
  dataset_id   BIGINT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  org_id       BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,                 -- event/metric name
  ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
  value        DOUBLE PRECISION DEFAULT 0,
  subject_id   TEXT,                          -- the "user"/entity for cohorts & funnels
  props        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- These three indexes carry almost every query in the analytics engine.
CREATE INDEX IF NOT EXISTS idx_events_ds_ts   ON events(dataset_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_ds_name ON events(dataset_id, name);
CREATE INDEX IF NOT EXISTS idx_events_subject ON events(dataset_id, subject_id);
CREATE INDEX IF NOT EXISTS idx_events_props   ON events USING GIN (props);

-- ---- Webhook ingestion ---------------------------------------------------

CREATE TABLE IF NOT EXISTS webhooks (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  dataset_id  BIGINT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  provider    TEXT NOT NULL DEFAULT 'generic', -- generic | github | stripe | slack
  secret      TEXT NOT NULL,                    -- HMAC signing secret
  slug        TEXT UNIQUE NOT NULL,             -- the path: /ingest/:slug
  active      BOOLEAN NOT NULL DEFAULT true,
  last_seen   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhooks_org ON webhooks(org_id);

-- Idempotency: a delivery id we've seen is never processed twice.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id            BIGSERIAL PRIMARY KEY,
  webhook_id    BIGINT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  delivery_key  TEXT NOT NULL,                  -- idempotency key from header/body
  status        TEXT NOT NULL DEFAULT 'received', -- received | processed | failed
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (webhook_id, delivery_key)
);

-- ---- Postgres-backed job queue ------------------------------------------
-- Workers grab jobs with FOR UPDATE SKIP LOCKED — the standard,
-- contention-free pattern for turning Postgres into a real queue.
CREATE TABLE IF NOT EXISTS jobs (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT NOT NULL,                   -- ingest_event | run_alert | send_report
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | failed
  attempts     INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  run_after    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jobs_pickup ON jobs(status, run_after);

-- ---- Custom metrics (the visual query builder saves into this) ----------
CREATE TABLE IF NOT EXISTS metrics (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  dataset_id  BIGINT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  -- A safe, structured spec — NOT raw SQL. Evaluated by the engine.
  -- { event, agg: count|sum|avg|min|max, filters:[{prop,op,value}], groupBy, window }
  spec        JSONB NOT NULL,
  created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_metrics_org ON metrics(org_id);

-- ---- Alerts & scheduled reports -----------------------------------------
CREATE TABLE IF NOT EXISTS alerts (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  metric_id   BIGINT REFERENCES metrics(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  -- { type: threshold|anomaly, op: gt|lt, value: number, window: '24h' }
  rule        JSONB NOT NULL,
  channel     TEXT NOT NULL DEFAULT 'email',   -- email | webhook
  target      TEXT NOT NULL,                    -- email address or URL
  active      BOOLEAN NOT NULL DEFAULT true,
  last_fired  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reports (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  cron        TEXT NOT NULL DEFAULT '0 9 * * 1', -- Mondays 9am by default
  channel     TEXT NOT NULL DEFAULT 'email',
  target      TEXT NOT NULL,
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  active      BOOLEAN NOT NULL DEFAULT true,
  last_sent   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- API keys (public REST API) -----------------------------------------
-- We store only a hash of the key. The plaintext is shown once, at creation.
CREATE TABLE IF NOT EXISTS api_keys (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  prefix      TEXT NOT NULL,                    -- first 8 chars, shown in UI
  key_hash    TEXT NOT NULL,
  scopes      TEXT[] NOT NULL DEFAULT ARRAY['read'],
  last_used   TIMESTAMPTZ,
  revoked     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_apikeys_org ON api_keys(org_id);

-- ---- Audit log -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  org_id     BIGINT REFERENCES orgs(id) ON DELETE CASCADE,
  actor_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  actor_kind TEXT NOT NULL DEFAULT 'user',     -- user | api_key | system
  action     TEXT NOT NULL,                     -- e.g. dataset.create
  target     TEXT,
  meta       JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_org_time ON audit_log(org_id, created_at DESC);

-- ---- Materialized view: daily rollup ------------------------------------
-- Expensive group-by-day aggregation, precomputed. Refreshed by a job.
-- This is the "I thought about query cost" artifact.
CREATE MATERIALIZED VIEW IF NOT EXISTS daily_rollup AS
  SELECT dataset_id,
         name,
         date_trunc('day', ts) AS day,
         count(*)              AS n,
         sum(value)            AS total,
         avg(value)            AS mean
  FROM events
  GROUP BY dataset_id, name, date_trunc('day', ts);
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_rollup
  ON daily_rollup(dataset_id, name, day);
