import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'schema.sql'), 'utf8');

try {
  await pool.query(sql);
  console.log('✓ Schema applied successfully.');
} catch (err) {
  console.error('Schema failed:', err.message);
  process.exit(1);
} finally {
  await pool.end();
}
