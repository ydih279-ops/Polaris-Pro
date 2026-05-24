import pg from 'pg';
import { config, isProd } from './config.js';

// Render's managed Postgres needs SSL; local dev usually doesn't.
const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: isProd ? { rejectUnauthorized: false } : false,
  max: 10,
});

pool.on('error', (err) => {
  console.error('[db] idle client error', err.message);
});

// Thin helper. Always parameterized — no string interpolation into SQL,
// anywhere in this codebase.
export const query = (text, params) => pool.query(text, params);

// Transaction helper: hand it an async fn, it gives you a client and
// commits/rolls back around it.
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export default pool;
