import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import { query } from '../db.js';
import { runMetric, compileMetric } from '../lib/analytics.js';
import { ownsDataset } from './datasets.js';
import { audit } from '../middleware/audit.js';

const r = Router();
r.use(authenticate);

r.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM metrics WHERE org_id = $1 ORDER BY created_at DESC`, [req.auth.orgId]
  );
  res.json({ metrics: rows });
});

// Save a metric from the visual builder. The spec is structured, never SQL.
r.post('/', requireRole('editor'), async (req, res) => {
  const { name, datasetId, spec } = req.body || {};
  if (!name || !datasetId || !spec) return res.status(400).json({ error: 'name, datasetId, spec required' });
  if (!(await ownsDataset(req.auth.orgId, datasetId)))
    return res.status(404).json({ error: 'dataset not found' });

  const { rows } = await query(
    `INSERT INTO metrics (org_id, dataset_id, name, spec, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.auth.orgId, datasetId, name, spec, req.auth.userId]
  );
  audit(req, 'metric.create', rows[0].id, { name });
  res.json({ metric: rows[0] });
});

// Run a metric ad-hoc (without saving), plus a rough query cost estimate
// based on EXPLAIN — the "I think about query cost" feature.
r.post('/run', async (req, res) => {
  const { datasetId, spec } = req.body || {};
  if (!(await ownsDataset(req.auth.orgId, datasetId)))
    return res.status(404).json({ error: 'dataset not found' });

  const fullSpec = { ...spec, datasetId };
  const { sql, params } = compileMetric(fullSpec);

  let cost = null;
  try {
    const ex = await query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
    cost = ex.rows[0]['QUERY PLAN'][0]['Plan']['Total Cost'];
  } catch { /* explain is best-effort */ }

  const result = await runMetric(fullSpec);
  res.json({ result, estimatedCost: cost });
});

r.delete('/:id', requireRole('editor'), async (req, res) => {
  await query(`DELETE FROM metrics WHERE id = $1 AND org_id = $2`,
    [req.params.id, req.auth.orgId]);
  res.json({ ok: true });
});

export default r;
