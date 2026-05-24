// Standalone worker. Run with `npm run worker` if you want to process the
// queue in a separate dyno from the web server. The web server also runs a
// worker in-process by default, so this is optional for scale-out.
import { query } from '../db.js';
import { startWorker } from '../lib/queue.js';

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

console.log('[worker] standalone worker started');
startWorker(handlers);
