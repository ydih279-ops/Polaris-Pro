import { query } from '../db.js';

// ===========================================================================
//  queue.js — a job queue built on Postgres.
//
//  Why not Redis/Bull? Because a single Postgres table + SELECT ... FOR UPDATE
//  SKIP LOCKED is a genuinely robust queue: transactional, survives restarts,
//  no extra service to deploy. Multiple workers can poll the same table
//  without stepping on each other. This is a real pattern used in production.
// ===========================================================================

export async function enqueue(kind, payload = {}, { runAfter = new Date() } = {}) {
  const { rows } = await query(
    `INSERT INTO jobs (kind, payload, run_after) VALUES ($1, $2, $3) RETURNING id`,
    [kind, payload, runAfter]
  );
  return rows[0].id;
}

// Atomically claim one job. SKIP LOCKED means concurrent workers never block
// each other — they just grab the next free row.
async function claimNext() {
  const { rows } = await query(
    `UPDATE jobs
        SET status = 'running', attempts = attempts + 1
      WHERE id = (
        SELECT id FROM jobs
         WHERE status = 'queued' AND run_after <= now()
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING *`
  );
  return rows[0] || null;
}

async function complete(id) {
  await query(`UPDATE jobs SET status = 'done' WHERE id = $1`, [id]);
}

async function fail(job, err) {
  const give_up = job.attempts >= job.max_attempts;
  // exponential backoff: 2^attempts seconds
  const delay = Math.min(2 ** job.attempts, 300);
  await query(
    `UPDATE jobs
        SET status = $2,
            last_error = $3,
            run_after = now() + ($4 || ' seconds')::interval
      WHERE id = $1`,
    [job.id, give_up ? 'failed' : 'queued', String(err?.message || err).slice(0, 500), delay]
  );
}

// The worker loop. handlers maps job.kind -> async fn(payload).
export function startWorker(handlers, { intervalMs = 1000 } = {}) {
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      let job;
      // drain whatever's ready, then sleep
      while ((job = await claimNext())) {
        const handler = handlers[job.kind];
        if (!handler) {
          await fail(job, new Error(`no handler for kind: ${job.kind}`));
          continue;
        }
        try {
          await handler(job.payload, job);
          await complete(job.id);
        } catch (err) {
          console.error(`[worker] job ${job.id} (${job.kind}) failed:`, err.message);
          await fail(job, err);
        }
      }
    } catch (err) {
      console.error('[worker] loop error:', err.message);
    } finally {
      if (!stopped) setTimeout(tick, intervalMs);
    }
  }

  tick();
  return () => { stopped = true; };
}
