import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { query } from './db.js';

import authRoutes from './routes/auth.js';
import teamRoutes from './routes/teams.js';
import datasetRoutes from './routes/datasets.js';
import webhookRoutes, { ingestRouter } from './routes/webhooks.js';
import analyticsRoutes from './routes/analytics.js';
import metricRoutes from './routes/metrics.js';
import alertRoutes from './routes/alerts.js';
import apiKeyRoutes, { publicApi } from './routes/apikeys.js';

import { startWorker } from './lib/queue.js';
import { startScheduler } from './lib/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);

// Capture the raw body so webhook HMAC verification can sign the exact bytes.
app.use(express.json({
  limit: '5mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));

// Static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check (Render pings this)
app.get('/healthz', async (_req, res) => {
  try { await query('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(500).json({ ok: false }); }
});

// Routes
app.use('/auth', authRoutes);
app.use('/team', teamRoutes);
app.use('/datasets', datasetRoutes);
app.use('/webhooks', webhookRoutes);
app.use('/ingest', ingestRouter);        // public, signed
app.use('/analytics', analyticsRoutes);
app.use('/metrics', metricRoutes);
app.use('/automation', alertRoutes);      // alerts + reports
app.use('/apikeys', apiKeyRoutes);
app.use('/api/v1', publicApi);            // public, API-key auth

// SPA fallback
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: 'internal error' });
});

// ---- Worker: handles queued jobs (webhook events become rows here) -------
const handlers = {
  async ingest_event(payload) {
    const { datasetId, orgId, event } = payload;
    await query(
      `INSERT INTO events (dataset_id, org_id, name, ts, value, subject_id, props)
       VALUES ($1,$2,$3, COALESCE($4::timestamptz, now()), $5, $6, $7)`,
      [datasetId, orgId, event.name || 'event', event.ts || null,
       Number(event.value) || 0, event.subject_id || null, event.props || {}]
    );
  },
};

const server = app.listen(config.port, () => {
  console.log(`[polaris] API running on :${config.port} (${config.nodeEnv})`);
  // Defer worker start by 5 seconds to let DB come online
  setTimeout(() => {
    startWorker(handlers);
    startScheduler();
  }, 5000);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
