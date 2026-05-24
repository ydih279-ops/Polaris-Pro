import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import pool, { query, tx } from '../db.js';
import { hashApiKey } from '../middleware/auth.js';

const DEMO_EMAIL = 'demo@polaris.app';
const DEMO_PASS = 'demo123';

function rng(seed) {
  // deterministic-ish PRNG so seeds look the same-ish each run
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

async function main() {
  // wipe demo user's prior data for idempotent re-seeding
  const existing = await query(`SELECT id FROM users WHERE email = $1`, [DEMO_EMAIL]);
  if (existing.rows[0]) {
    const uid = existing.rows[0].id;
    const orgs = await query(`SELECT org_id FROM memberships WHERE user_id = $1`, [uid]);
    for (const o of orgs.rows) await query(`DELETE FROM orgs WHERE id = $1`, [o.org_id]);
    await query(`DELETE FROM users WHERE id = $1`, [uid]);
  }

  const { user, org, dataset } = await tx(async (c) => {
    const hash = await bcrypt.hash(DEMO_PASS, 10);
    const u = (await c.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1,$2,'Demo') RETURNING *`,
      [DEMO_EMAIL, hash]
    )).rows[0];
    const o = (await c.query(
      `INSERT INTO orgs (name, slug, created_by) VALUES ('Demo Workspace',$1,$2) RETURNING *`,
      [`demo-${nanoid(6).toLowerCase()}`, u.id]
    )).rows[0];
    await c.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,'admin')`, [o.id, u.id]);
    const d = (await c.query(
      `INSERT INTO datasets (org_id, name, source) VALUES ($1,'Product Events','manual') RETURNING *`,
      [o.id]
    )).rows[0];
    return { user: u, org: o, dataset: d };
  });

  // ---- generate 90 days of events --------------------------------------
  const rand = rng(42);
  const days = 90;
  const funnelSteps = ['signup', 'activate', 'purchase', 'refer'];
  let total = 0;

  await tx(async (c) => {
    for (let d = days; d >= 0; d--) {
      const date = new Date(Date.now() - d * 86400e3);
      const dow = date.getDay();
      // base trend rises over time; weekends dip (seasonality)
      const trend = 40 + (days - d) * 0.8;
      const weekend = dow === 0 || dow === 6 ? 0.6 : 1;
      let count = Math.round(trend * weekend * (0.85 + rand() * 0.3));
      // inject two anomalies
      if (d === 30) count = Math.round(count * 3.2);   // spike
      if (d === 12) count = Math.round(count * 0.25);  // crash

      for (let i = 0; i < count; i++) {
        // ~40% of activity comes from a loyal core that recurs week to week
        // (this produces a realistic retention decay); the rest are new/churny.
        const subject = rand() < 0.4
          ? `loyal${Math.floor(rand() * 150)}`
          : `u${Math.floor(rand() * 1500)}`;
        await c.query(
          `INSERT INTO events (dataset_id, org_id, name, ts, value, subject_id, props)
           VALUES ($1,$2,'pageview',$3,$4,$5,$6)`,
          [dataset.id, org.id, date.toISOString(), 1, subject,
           { plan: rand() > 0.7 ? 'pro' : 'free', country: ['US','IN','DE','BR'][Math.floor(rand()*4)] }]
        );
        total++;

        // funnel: each user probabilistically advances through steps
        let p = 1;
        for (const step of funnelSteps) {
          if (rand() < p) {
            await c.query(
              `INSERT INTO events (dataset_id, org_id, name, ts, value, subject_id, props)
               VALUES ($1,$2,$3,$4,$5,$6,'{}')`,
              [dataset.id, org.id, step, new Date(date.getTime() + Math.floor(rand()*3600e3)).toISOString(),
               step === 'purchase' ? Math.round(20 + rand() * 180) : 1, subject]
            );
            total++;
            p *= 0.55; // drop-off between steps
          } else break;
        }
      }
    }
  });

  // ---- a saved metric, an alert, and an API key ------------------------
  const metric = (await query(
    `INSERT INTO metrics (org_id, dataset_id, name, spec, created_by)
     VALUES ($1,$2,'Daily signups',$3,$4) RETURNING *`,
    [org.id, dataset.id, { event: 'signup', agg: 'count', window: '24h', filters: [] }, user.id]
  )).rows[0];

  await query(
    `INSERT INTO alerts (org_id, metric_id, name, rule, channel, target)
     VALUES ($1,$2,'Signups dropped',$3,'email',$4)`,
    [org.id, metric.id, { type: 'threshold', op: 'lt', value: 10 }, DEMO_EMAIL]
  );

  const apiKeyPlain = `pk_${nanoid(32)}`;
  await query(
    `INSERT INTO api_keys (org_id, name, prefix, key_hash, scopes)
     VALUES ($1,'Demo key',$2,$3,ARRAY['read','write'])`,
    [org.id, apiKeyPlain.slice(0, 8), hashApiKey(apiKeyPlain)]
  );

  try { await query('REFRESH MATERIALIZED VIEW daily_rollup'); } catch {}

  console.log(`✓ Seeded ${total} events across ${days} days.`);
  console.log(`  Login: ${DEMO_EMAIL} / ${DEMO_PASS}`);
  console.log(`  Demo API key (read+write): ${apiKeyPlain}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
