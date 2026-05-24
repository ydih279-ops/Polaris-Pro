import { query } from '../db.js';
import { cache } from './cache.js';

// ===========================================================================
//  analytics.js — the math.
//
//  Nothing here takes raw SQL from a user. Custom metrics arrive as a
//  structured spec and we compile them into parameterized queries with a
//  strict allow-list. The stats (anomaly, forecast) are implemented from
//  scratch rather than pulled from a library, on purpose — it's a portfolio
//  piece, the point is to show the work.
// ===========================================================================

const AGGS = {
  count: 'count(*)',
  sum: 'sum(value)',
  avg: 'avg(value)',
  min: 'min(value)',
  max: 'max(value)',
};

const OPS = { eq: '=', neq: '!=', gt: '>', lt: '<', gte: '>=', lte: '<=' };

const WINDOW_MS = {
  '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3, '90d': 90 * 86400e3,
};

// --- Compile a metric spec into a safe parameterized query ----------------
// spec = { event, agg, filters:[{prop,op,value}], groupBy, window }
export function compileMetric(spec) {
  const agg = AGGS[spec.agg] || AGGS.count;
  const params = [spec.datasetId];
  const where = ['dataset_id = $1'];

  if (spec.event) {
    params.push(spec.event);
    where.push(`name = $${params.length}`);
  }
  if (spec.window && WINDOW_MS[spec.window]) {
    const since = new Date(Date.now() - WINDOW_MS[spec.window]).toISOString();
    params.push(since);
    where.push(`ts >= $${params.length}`);
  }
  for (const f of spec.filters || []) {
    const op = OPS[f.op];
    if (!op) continue;
    // props are jsonb; compare as text or numeric depending on value type
    params.push(f.value);
    if (typeof f.value === 'number') {
      where.push(`(props->>'${sanitizeKey(f.prop)}')::numeric ${op} $${params.length}`);
    } else {
      where.push(`props->>'${sanitizeKey(f.prop)}' ${op} $${params.length}`);
    }
  }

  let select = `SELECT ${agg} AS value`;
  let group = '';
  if (spec.groupBy) {
    const key = sanitizeKey(spec.groupBy);
    select = `SELECT props->>'${key}' AS bucket, ${agg} AS value`;
    group = ` GROUP BY props->>'${key}' ORDER BY value DESC`;
  }

  const sql = `${select} FROM events WHERE ${where.join(' AND ')}${group}`;
  return { sql, params };
}

// jsonb keys can't be parameterized, so we hard-restrict the charset.
function sanitizeKey(k) {
  return String(k).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 64);
}

export async function runMetric(spec) {
  const { sql, params } = compileMetric(spec);
  const { rows } = await query(sql, params);
  return rows;
}

// --- Time series (daily) --------------------------------------------------
export async function dailySeries(datasetId, eventName, days = 90) {
  const cacheKey = `series:${datasetId}:${eventName}:${days}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const { rows } = await query(
    `SELECT date_trunc('day', ts) AS day, count(*)::int AS n, sum(value) AS total
       FROM events
      WHERE dataset_id = $1 AND ($2::text IS NULL OR name = $2)
        AND ts >= now() - ($3 || ' days')::interval
      GROUP BY 1 ORDER BY 1`,
    [datasetId, eventName || null, days]
  );
  const series = rows.map((r) => ({
    day: r.day,
    n: r.n,
    total: Number(r.total) || 0,
  }));
  cache.set(cacheKey, series, 60_000); // 1-min TTL
  return series;
}

// --- Retention cohorts ----------------------------------------------------
// Group subjects by the week they first appeared, then measure what fraction
// came back in each subsequent week. Classic triangular cohort matrix.
export async function retentionCohorts(datasetId, weeks = 8) {
  const { rows } = await query(
    `WITH firsts AS (
       SELECT subject_id, date_trunc('week', min(ts)) AS cohort
         FROM events
        WHERE dataset_id = $1 AND subject_id IS NOT NULL
        GROUP BY subject_id
     ),
     activity AS (
       SELECT DISTINCT e.subject_id,
              f.cohort,
              date_trunc('week', e.ts) AS active_week
         FROM events e
         JOIN firsts f ON f.subject_id = e.subject_id
        WHERE e.dataset_id = $1
     )
     SELECT cohort,
            floor(extract(epoch FROM (active_week - cohort)) / 604800)::int AS week_offset,
            count(DISTINCT subject_id)::int AS active
       FROM activity
      GROUP BY cohort, week_offset
      ORDER BY cohort, week_offset`,
    [datasetId]
  );

  // Pivot into { cohort, size, retention: [1, 0.62, 0.4, ...] }
  const byCohort = new Map();
  for (const r of rows) {
    const key = r.cohort.toISOString();
    if (!byCohort.has(key)) byCohort.set(key, { cohort: key, counts: {} });
    byCohort.get(key).counts[r.week_offset] = r.active;
  }
  const out = [];
  for (const c of byCohort.values()) {
    const size = c.counts[0] || 0;
    if (!size) continue;
    const retention = [];
    for (let w = 0; w < weeks; w++) {
      retention.push(size ? +((c.counts[w] || 0) / size).toFixed(4) : 0);
    }
    out.push({ cohort: c.cohort, size, retention });
  }
  return out.slice(-weeks);
}

// --- Funnel ---------------------------------------------------------------
// Ordered steps by event name. A subject counts at step k only if they did
// every prior step, in time order. Reports drop-off between steps.
export async function funnel(datasetId, steps) {
  const { rows } = await query(
    `SELECT subject_id, name, min(ts) AS first_ts
       FROM events
      WHERE dataset_id = $1 AND name = ANY($2) AND subject_id IS NOT NULL
      GROUP BY subject_id, name`,
    [datasetId, steps]
  );

  // subject -> { stepName: firstTs }
  const bySubject = new Map();
  for (const r of rows) {
    if (!bySubject.has(r.subject_id)) bySubject.set(r.subject_id, {});
    bySubject.get(r.subject_id)[r.name] = new Date(r.first_ts).getTime();
  }

  const counts = new Array(steps.length).fill(0);
  for (const times of bySubject.values()) {
    let prevTs = -Infinity;
    for (let i = 0; i < steps.length; i++) {
      const t = times[steps[i]];
      if (t === undefined || t < prevTs) break; // must be present and in order
      counts[i]++;
      prevTs = t;
    }
  }

  return steps.map((name, i) => ({
    step: name,
    count: counts[i],
    rateFromStart: counts[0] ? +(counts[i] / counts[0]).toFixed(4) : 0,
    rateFromPrev: i === 0 ? 1 : counts[i - 1] ? +(counts[i] / counts[i - 1]).toFixed(4) : 0,
  }));
}

// --- Anomaly detection ----------------------------------------------------
// Two independent flags per point: a robust IQR fence and a rolling z-score.
// A point is anomalous if either trips. Robust + classic, cheap to explain.
export function detectAnomalies(values, { z = 3, window = 14 } = {}) {
  const n = values.length;
  if (n < 4) return values.map(() => ({ anomaly: false, score: 0 }));

  // IQR fences over the whole series
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p) => {
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };
  const q1 = q(0.25), q3 = q(0.75), iqr = q3 - q1;
  const lowFence = q1 - 1.5 * iqr, highFence = q3 + 1.5 * iqr;

  return values.map((v, i) => {
    // rolling z-score against the trailing window
    const start = Math.max(0, i - window);
    const slice = values.slice(start, i);
    let zScore = 0;
    if (slice.length >= 3) {
      const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
      const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length) || 1e-9;
      zScore = (v - mean) / sd;
    }
    const iqrFlag = v < lowFence || v > highFence;
    const zFlag = Math.abs(zScore) > z;
    return { anomaly: iqrFlag || zFlag, score: +Math.abs(zScore).toFixed(2) };
  });
}

// --- Forecasting: Holt's linear trend (double exponential smoothing) ------
// Captures level + trend, projects `horizon` steps ahead, and returns a
// crude prediction band from the in-sample residual spread.
export function forecast(values, horizon = 14, { alpha = 0.5, beta = 0.3 } = {}) {
  const n = values.length;
  if (n < 2) return { fitted: values.slice(), forecast: [], band: [] };

  let level = values[0];
  let trend = values[1] - values[0];
  const fitted = [level];
  const residuals = [];

  for (let i = 1; i < n; i++) {
    const predicted = level + trend;
    fitted.push(predicted);
    residuals.push(values[i] - predicted);
    const prevLevel = level;
    level = alpha * values[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }

  // residual std for the band
  const rMean = residuals.reduce((a, b) => a + b, 0) / (residuals.length || 1);
  const rSd = Math.sqrt(
    residuals.reduce((a, b) => a + (b - rMean) ** 2, 0) / (residuals.length || 1)
  ) || 0;

  const fc = [];
  const band = [];
  for (let h = 1; h <= horizon; h++) {
    const point = level + h * trend;
    fc.push(+point.toFixed(2));
    // band widens with horizon (uncertainty compounds)
    const spread = 1.96 * rSd * Math.sqrt(h);
    band.push({ lo: +(point - spread).toFixed(2), hi: +(point + spread).toFixed(2) });
  }
  return { fitted, forecast: fc, band };
}
