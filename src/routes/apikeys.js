import { Router } from 'express';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import { query } from '../db.js';
import { authenticate, requireRole, hashApiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { audit } from '../middleware/audit.js';
import { dailySeries, retentionCohorts, funnel } from '../lib/analytics.js';
import { ownsDataset } from './datasets.js';

// ---- Key management (UI, JWT-auth) ---------------------------------------
const r = Router();
r.use(authenticate);

r.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, prefix, scopes, last_used, revoked, created_at
       FROM api_keys WHERE org_id = $1 ORDER BY created_at DESC`,
    [req.auth.orgId]
  );
  res.json({ keys: rows });
});

r.post('/', requireRole('admin'), async (req, res) => {
  const { name, scopes = ['read'] } = req.body || {};
  const plain = `pk_${nanoid(32)}`;
  const prefix = plain.slice(0, 8);
  await query(
    `INSERT INTO api_keys (org_id, name, prefix, key_hash, scopes)
     VALUES ($1,$2,$3,$4,$5)`,
    [req.auth.orgId, name || 'default', prefix, hashApiKey(plain), scopes]
  );
  audit(req, 'apikey.create', prefix, { scopes });
  // plaintext shown exactly once
  res.json({ key: plain, prefix, note: 'Store this now — it will not be shown again.' });
});

r.post('/:id/revoke', requireRole('admin'), async (req, res) => {
  await query(`UPDATE api_keys SET revoked = true WHERE id = $1 AND org_id = $2`,
    [req.params.id, req.auth.orgId]);
  audit(req, 'apikey.revoke', req.params.id, {});
  res.json({ ok: true });
});

// ---- Public API v1 (X-API-Key auth + rate limit) -------------------------
// Everything the UI shows, available programmatically. Mounted at /api/v1.
export const publicApi = Router();
publicApi.use(authenticate);          // accepts X-API-Key
publicApi.use(rateLimit({ capacity: 120, refillPerSec: 2 }));

publicApi.get('/series', async (req, res) => {
  const id = Number(req.query.datasetId);
  if (!(await ownsDataset(req.auth.orgId, id))) return res.status(404).json({ error: 'not found' });
  res.json({ series: await dailySeries(id, req.query.event || null, Number(req.query.days) || 30) });
});

publicApi.get('/cohorts', async (req, res) => {
  const id = Number(req.query.datasetId);
  if (!(await ownsDataset(req.auth.orgId, id))) return res.status(404).json({ error: 'not found' });
  res.json({ cohorts: await retentionCohorts(id, Number(req.query.weeks) || 8) });
});

publicApi.post('/funnel', async (req, res) => {
  const id = Number(req.body?.datasetId);
  if (!(await ownsDataset(req.auth.orgId, id))) return res.status(404).json({ error: 'not found' });
  res.json({ funnel: await funnel(id, req.body.steps || []) });
});

// Programmatic event ingestion via API key (scope: write).
publicApi.post('/events', async (req, res) => {
  if (req.auth.role === 'viewer') return res.status(403).json({ error: 'write scope required' });
  const { datasetId, events } = req.body || {};
  if (!(await ownsDataset(req.auth.orgId, datasetId))) return res.status(404).json({ error: 'not found' });
  const list = Array.isArray(events) ? events : [events];
  for (const e of list) {
    await query(
      `INSERT INTO events (dataset_id, org_id, name, value, subject_id, props)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [datasetId, req.auth.orgId, e.name || 'event', Number(e.value) || 0,
       e.subject_id || null, e.props || {}]
    );
  }
  res.status(201).json({ ok: true, inserted: list.length });
});

export default r;
