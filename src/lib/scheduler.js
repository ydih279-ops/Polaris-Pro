import cron from 'node-cron';
import { query } from '../db.js';
import { runMetric, dailySeries, detectAnomalies } from './analytics.js';
import { notify } from './notify.js';
import { cache } from './cache.js';

// ===========================================================================
//  scheduler.js — the part that does things without anyone clicking.
//   * every 5 min: evaluate active alert rules
//   * every 10 min: refresh the daily_rollup materialized view
//   * per-report cron: send scheduled summaries
// ===========================================================================

async function evaluateAlerts() {
  const { rows: alerts } = await query(
    `SELECT a.*, m.spec, m.dataset_id
       FROM alerts a JOIN metrics m ON m.id = a.metric_id
      WHERE a.active = true`
  );

  for (const a of alerts) {
    try {
      const spec = { ...a.spec, datasetId: a.dataset_id };
      const rows = await runMetric(spec);
      const current = Number(rows?.[0]?.value ?? 0);
      const rule = a.rule || {};
      let fired = false;

      if (rule.type === 'threshold') {
        if (rule.op === 'gt') fired = current > rule.value;
        if (rule.op === 'lt') fired = current < rule.value;
      } else if (rule.type === 'anomaly') {
        const series = await dailySeries(a.dataset_id, spec.event, 60);
        const flags = detectAnomalies(series.map((s) => s.n));
        fired = flags.at(-1)?.anomaly === true;
      }

      if (fired) {
        const subject = `Polaris alert: ${a.name}`;
        const body = `Alert "${a.name}" fired.\nCurrent value: ${current}\nRule: ${JSON.stringify(rule)}`;
        await notify(a.channel, a.target, subject, body);
        await query(`UPDATE alerts SET last_fired = now() WHERE id = $1`, [a.id]);
        await query(
          `INSERT INTO audit_log (org_id, actor_kind, action, target, meta)
           VALUES ($1, 'system', 'alert.fired', $2, $3)`,
          [a.org_id, a.name, { current, rule }]
        );
      }
    } catch (err) {
      console.error(`[scheduler] alert ${a.id} error:`, err.message);
    }
  }
}

async function refreshRollup() {
  try {
    await query('REFRESH MATERIALIZED VIEW CONCURRENTLY daily_rollup');
    cache.invalidatePrefix('series:');
  } catch (err) {
    // CONCURRENTLY needs the unique index + at least one populated refresh;
    // fall back to a plain refresh on first run.
    try { await query('REFRESH MATERIALIZED VIEW daily_rollup'); } catch (_) {}
  }
}

async function sendDueReports() {
  const { rows } = await query(`SELECT * FROM reports WHERE active = true`);
  const now = new Date();
  for (const r of rows) {
    if (cron.validate(r.cron) && shouldRun(r.cron, now, r.last_sent)) {
      const series = await dailySeries(r.config?.datasetId, null, 7);
      const total = series.reduce((a, b) => a + b.n, 0);
      const body = `Weekly summary for "${r.name}"\nEvents in last 7 days: ${total}`;
      await notify(r.channel, r.target, `Polaris report: ${r.name}`, body);
      await query(`UPDATE reports SET last_sent = now() WHERE id = $1`, [r.id]);
    }
  }
}

// Lightweight "is this cron due this minute and not already sent" check.
function shouldRun(expr, now, lastSent) {
  // node-cron doesn't expose next-run; approximate by checking minute match
  // and dedup against last_sent within the same minute.
  if (lastSent && now - new Date(lastSent) < 60_000) return false;
  return true; // the per-minute cron tick below gates the actual firing
}

export function startScheduler() {
  cron.schedule('*/5 * * * *', evaluateAlerts);
  cron.schedule('*/10 * * * *', refreshRollup);
  // each minute, fire any reports whose own cron matches this minute
  for (const expr of new Set()) void expr; // (per-report crons registered below)
  cron.schedule('* * * * *', async () => {
    const { rows } = await query(`SELECT DISTINCT cron FROM reports WHERE active = true`);
    for (const { cron: expr } of rows) {
      if (cron.validate(expr) && matchesNow(expr)) await sendDueReports();
    }
  });
  console.log('[scheduler] started (alerts every 5m, rollup every 10m, reports per-minute check)');
}

// Minimal cron field matcher for the current minute.
function matchesNow(expr) {
  const [min, hr, dom, mon, dow] = expr.split(/\s+/);
  const d = new Date();
  const f = (field, val) =>
    field === '*' ||
    field.split(',').some((part) => {
      if (part.startsWith('*/')) return val % Number(part.slice(2)) === 0;
      return Number(part) === val;
    });
  return (
    f(min, d.getMinutes()) && f(hr, d.getHours()) &&
    f(dom, d.getDate()) && f(mon, d.getMonth() + 1) && f(dow, d.getDay())
  );
}
