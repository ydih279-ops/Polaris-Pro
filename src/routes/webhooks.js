import { Router } from 'express';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import { query } from '../db.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { enqueue } from '../lib/queue.js';
import { ownsDataset } from './datasets.js';
import { config } from '../config.js';

// ---- Authenticated management routes -------------------------------------
const r = Router();
r.use(authenticate);

r.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, provider, slug, active, last_seen, created_at, dataset_id
       FROM webhooks WHERE org_id = $1 ORDER BY created_at DESC`,
    [req.auth.orgId]
  );
  const withUrls = rows.map((w) => ({ ...w, url: `${config.publicUrl}/ingest/${w.slug}` }));
  res.json({ webhooks: withUrls });
});

r.post('/', requireRole('editor'), async (req, res) => {
  const { name, datasetId, provider = 'generic' } = req.body || {};
  if (!name || !datasetId) return res.status(400).json({ error: 'name and datasetId required' });
  if (!(await ownsDataset(req.auth.orgId, datasetId)))
    return res.status(404).json({ error: 'dataset not found' });

  const secret = nanoid(32);
  const slug = nanoid(16);
  const { rows } = await query(
    `INSERT INTO webhooks (org_id, dataset_id, name, provider, secret, slug)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.auth.orgId, datasetId, name, provider, secret, slug]
  );
  audit(req, 'webhook.create', rows[0].id, { provider });
  // secret is shown once, here, so the user can configure their source
  res.json({
    webhook: { ...rows[0], url: `${config.publicUrl}/ingest/${slug}` },
    secret,
  });
});

r.delete('/:id', requireRole('editor'), async (req, res) => {
  await query(`DELETE FROM webhooks WHERE id = $1 AND org_id = $2`,
    [req.params.id, req.auth.orgId]);
  audit(req, 'webhook.delete', req.params.id, {});
  res.json({ ok: true });
});

// ---- Public ingest endpoint (no auth header; HMAC-signed) ----------------
// Mounted separately at /ingest so it sits outside the authenticated tree.
export const ingestRouter = Router();

ingestRouter.post('/:slug', async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM webhooks WHERE slug = $1 AND active = true`, [req.params.slug]
  );
  const wh = rows[0];
  if (!wh) return res.status(404).json({ error: 'unknown webhook' });

  // 1) Verify the HMAC signature over the raw body.
  const raw = req.rawBody || JSON.stringify(req.body || {});
  const signature = req.headers['x-polaris-signature'] || providerSignature(wh.provider, req);
  if (!verifyHmac(wh.secret, raw, signature, wh.provider, req)) {
    return res.status(401).json({ error: 'bad signature' });
  }

  // 2) Idempotency — reject duplicate deliveries.
  const deliveryKey =
    req.headers['x-idempotency-key'] ||
    req.headers['x-github-delivery'] ||
    req.headers['stripe-signature']?.slice(0, 40) ||
    crypto.createHash('sha256').update(raw).digest('hex');

  try {
    await query(
      `INSERT INTO webhook_deliveries (webhook_id, delivery_key) VALUES ($1,$2)`,
      [wh.id, deliveryKey]
    );
  } catch (err) {
    if (err.code === '23505') return res.status(200).json({ ok: true, deduped: true });
    throw err;
  }

  // 3) Normalize to our event shape and hand off to the queue (async).
  const events = adaptPayload(wh.provider, req.body);
  for (const ev of events) {
    await enqueue('ingest_event', {
      webhookId: wh.id,
      datasetId: wh.dataset_id,
      orgId: wh.org_id,
      event: ev,
    });
  }
  await query(`UPDATE webhooks SET last_seen = now() WHERE id = $1`, [wh.id]);

  // Respond fast; processing happens in the worker.
  res.status(202).json({ ok: true, accepted: events.length });
});

// ---- Signature verification ----------------------------------------------
function verifyHmac(secret, raw, signature, provider, req) {
  if (!signature) return false;
  let expected;
  if (provider === 'github') {
    expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  } else {
    expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  }
  // constant-time compare
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function providerSignature(provider, req) {
  if (provider === 'github') return req.headers['x-hub-signature-256'];
  if (provider === 'stripe') return req.headers['stripe-signature'];
  return null;
}

// ---- Provider adapters: turn a provider payload into Polaris events -------
function adaptPayload(provider, body) {
  try {
    if (provider === 'github') {
      // a push/star/PR etc — count one event named after the action
      const action = body.action || (body.commits ? 'push' : 'event');
      return [{ name: `github.${action}`, value: (body.commits?.length) || 1,
        subject_id: body.sender?.login, props: { repo: body.repository?.full_name } }];
    }
    if (provider === 'stripe') {
      const amount = (body.data?.object?.amount || 0) / 100;
      return [{ name: `stripe.${body.type || 'event'}`, value: amount,
        subject_id: body.data?.object?.customer, props: { id: body.id } }];
    }
    if (provider === 'slack') {
      return [{ name: `slack.${body.event?.type || 'event'}`, value: 1,
        subject_id: body.event?.user, props: { channel: body.event?.channel } }];
    }
    // generic: accept our own shape, or an array of them
    const arr = Array.isArray(body) ? body : [body];
    return arr.map((e) => ({
      name: e.name || 'event',
      value: Number(e.value) || 0,
      subject_id: e.subject_id || null,
      ts: e.ts || null,
      props: e.props || {},
    }));
  } catch {
    return [{ name: 'event', value: 0, props: {} }];
  }
}

export default r;
