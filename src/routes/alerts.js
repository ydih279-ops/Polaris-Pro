import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import { query } from '../db.js';
import { audit } from '../middleware/audit.js';

const r = Router();
r.use(authenticate);

// ---- Alerts ----
r.get('/alerts', async (req, res) => {
  const { rows } = await query(
    `SELECT a.*, m.name AS metric_name FROM alerts a
       LEFT JOIN metrics m ON m.id = a.metric_id
      WHERE a.org_id = $1 ORDER BY a.created_at DESC`,
    [req.auth.orgId]
  );
  res.json({ alerts: rows });
});

r.post('/alerts', requireRole('editor'), async (req, res) => {
  const { name, metricId, rule, channel = 'email', target } = req.body || {};
  if (!name || !metricId || !rule || !target)
    return res.status(400).json({ error: 'name, metricId, rule, target required' });
  const { rows } = await query(
    `INSERT INTO alerts (org_id, metric_id, name, rule, channel, target)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.auth.orgId, metricId, name, rule, channel, target]
  );
  audit(req, 'alert.create', rows[0].id, { rule });
  res.json({ alert: rows[0] });
});

r.delete('/alerts/:id', requireRole('editor'), async (req, res) => {
  await query(`DELETE FROM alerts WHERE id = $1 AND org_id = $2`,
    [req.params.id, req.auth.orgId]);
  res.json({ ok: true });
});

// ---- Scheduled reports ----
r.get('/reports', async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM reports WHERE org_id = $1 ORDER BY created_at DESC`, [req.auth.orgId]
  );
  res.json({ reports: rows });
});

r.post('/reports', requireRole('editor'), async (req, res) => {
  const { name, cron = '0 9 * * 1', channel = 'email', target, config: cfg = {} } = req.body || {};
  if (!name || !target) return res.status(400).json({ error: 'name and target required' });
  const { rows } = await query(
    `INSERT INTO reports (org_id, name, cron, channel, target, config)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.auth.orgId, name, cron, channel, target, cfg]
  );
  audit(req, 'report.create', rows[0].id, { cron });
  res.json({ report: rows[0] });
});

r.delete('/reports/:id', requireRole('editor'), async (req, res) => {
  await query(`DELETE FROM reports WHERE id = $1 AND org_id = $2`,
    [req.params.id, req.auth.orgId]);
  res.json({ ok: true });
});

export default r;
