import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { ownsDataset } from './datasets.js';
import {
  dailySeries, retentionCohorts, funnel, detectAnomalies, forecast,
} from '../lib/analytics.js';

const r = Router();
r.use(authenticate);

async function guard(req, res) {
  const datasetId = Number(req.query.datasetId || req.body?.datasetId);
  if (!datasetId || !(await ownsDataset(req.auth.orgId, datasetId))) {
    res.status(404).json({ error: 'dataset not found' });
    return null;
  }
  return datasetId;
}

r.get('/series', async (req, res) => {
  const id = await guard(req, res); if (!id) return;
  const series = await dailySeries(id, req.query.event || null, Number(req.query.days) || 90);
  res.json({ series });
});

r.get('/cohorts', async (req, res) => {
  const id = await guard(req, res); if (!id) return;
  res.json({ cohorts: await retentionCohorts(id, Number(req.query.weeks) || 8) });
});

r.post('/funnel', async (req, res) => {
  const id = await guard(req, res); if (!id) return;
  const steps = req.body?.steps;
  if (!Array.isArray(steps) || steps.length < 2)
    return res.status(400).json({ error: 'steps must be an array of >= 2 event names' });
  res.json({ funnel: await funnel(id, steps) });
});

r.get('/anomalies', async (req, res) => {
  const id = await guard(req, res); if (!id) return;
  const series = await dailySeries(id, req.query.event || null, Number(req.query.days) || 90);
  const flags = detectAnomalies(series.map((s) => s.n));
  res.json({ points: series.map((s, i) => ({ ...s, ...flags[i] })) });
});

r.get('/forecast', async (req, res) => {
  const id = await guard(req, res); if (!id) return;
  const series = await dailySeries(id, req.query.event || null, Number(req.query.days) || 90);
  const fc = forecast(series.map((s) => s.n), Number(req.query.horizon) || 14);
  res.json({ history: series, ...fc });
});

// Auto-insights: a quick scan that turns the raw series into plain-English
// observations. This is the "it tells you what's interesting" touch.
r.get('/insights', async (req, res) => {
  const id = await guard(req, res); if (!id) return;
  const series = await dailySeries(id, req.query.event || null, 60);
  const vals = series.map((s) => s.n);
  const insights = [];

  if (vals.length >= 14) {
    const recent = avg(vals.slice(-7)), prior = avg(vals.slice(-14, -7));
    if (prior > 0) {
      const change = ((recent - prior) / prior) * 100;
      if (Math.abs(change) >= 10)
        insights.push(`${change > 0 ? 'Up' : 'Down'} ${Math.abs(change).toFixed(0)}% week over week (${prior.toFixed(0)} → ${recent.toFixed(0)} events/day).`);
    }
    const flags = detectAnomalies(vals);
    const anomDays = flags.filter((f) => f.anomaly).length;
    if (anomDays) insights.push(`${anomDays} anomalous day${anomDays > 1 ? 's' : ''} detected in the last 60 days.`);
    const fc = forecast(vals, 7);
    const projected = fc.forecast.reduce((a, b) => a + b, 0);
    insights.push(`Projected ~${projected.toFixed(0)} events over the next 7 days.`);
  }
  if (!insights.length) insights.push('Not enough data yet for trend analysis. Upload more events.');
  res.json({ insights });
});

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

export default r;
