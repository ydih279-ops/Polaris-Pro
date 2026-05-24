import { Router } from 'express';
import Papa from 'papaparse';
import { query, tx } from '../db.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { cache } from '../lib/cache.js';

const r = Router();
r.use(authenticate);

r.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT d.*, (SELECT count(*) FROM events e WHERE e.dataset_id = d.id)::int AS event_count
       FROM datasets d WHERE d.org_id = $1 ORDER BY d.created_at DESC`,
    [req.auth.orgId]
  );
  res.json({ datasets: rows });
});

r.post('/', requireRole('editor'), async (req, res) => {
  const { name, source = 'manual' } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const { rows } = await query(
    `INSERT INTO datasets (org_id, name, source) VALUES ($1,$2,$3) RETURNING *`,
    [req.auth.orgId, name, source]
  );
  audit(req, 'dataset.create', rows[0].id, { name });
  res.json({ dataset: rows[0] });
});

// CSV upload. Expected columns (flexible): name, ts, value, subject_id, + any
// extra columns get folded into props. Inserted in one transaction.
r.post('/:id/upload', requireRole('editor'), async (req, res) => {
  const datasetId = Number(req.params.id);
  const owned = await ownsDataset(req.auth.orgId, datasetId);
  if (!owned) return res.status(404).json({ error: 'dataset not found' });

  const csv = req.body?.csv;
  if (!csv) return res.status(400).json({ error: 'csv field required' });

  const parsed = Papa.parse(csv.trim(), { header: true, skipEmptyLines: true });
  if (parsed.errors.length) {
    return res.status(400).json({ error: 'csv parse error', details: parsed.errors.slice(0, 3) });
  }

  const reserved = new Set(['name', 'ts', 'value', 'subject_id']);
  let inserted = 0;
  await tx(async (c) => {
    for (const row of parsed.data) {
      const props = {};
      for (const [k, v] of Object.entries(row)) {
        if (!reserved.has(k)) props[k] = v;
      }
      await c.query(
        `INSERT INTO events (dataset_id, org_id, name, ts, value, subject_id, props)
         VALUES ($1,$2,$3, COALESCE($4::timestamptz, now()), $5, $6, $7)`,
        [
          datasetId, req.auth.orgId,
          row.name || 'event',
          row.ts || null,
          Number(row.value) || 0,
          row.subject_id || null,
          props,
        ]
      );
      inserted++;
    }
  });
  cache.invalidatePrefix(`series:${datasetId}:`);
  audit(req, 'dataset.upload', datasetId, { rows: inserted });
  res.json({ ok: true, inserted });
});

r.get('/:id/events', async (req, res) => {
  const datasetId = Number(req.params.id);
  if (!(await ownsDataset(req.auth.orgId, datasetId)))
    return res.status(404).json({ error: 'not found' });
  const { rows } = await query(
    `SELECT id, name, ts, value, subject_id, props FROM events
      WHERE dataset_id = $1 ORDER BY ts DESC LIMIT 500`,
    [datasetId]
  );
  res.json({ events: rows });
});

export async function ownsDataset(orgId, datasetId) {
  const { rows } = await query(
    `SELECT 1 FROM datasets WHERE id = $1 AND org_id = $2`, [datasetId, orgId]
  );
  return !!rows[0];
}

export default r;
