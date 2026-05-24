import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { query, tx } from '../db.js';
import { signToken, authenticate } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';

const r = Router();

// Sign up. Also spins up a personal org and makes the user its admin, so a
// fresh account is immediately usable.
r.post('/signup', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const exists = await query(`SELECT 1 FROM users WHERE email = $1`, [email]);
  if (exists.rows[0]) return res.status(409).json({ error: 'email already registered' });

  const hash = await bcrypt.hash(password, 10);
  const result = await tx(async (c) => {
    const u = await c.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3) RETURNING *`,
      [email, hash, name || email.split('@')[0]]
    );
    const user = u.rows[0];
    const org = await c.query(
      `INSERT INTO orgs (name, slug, created_by) VALUES ($1,$2,$3) RETURNING *`,
      [`${user.name}'s workspace`, `ws-${nanoid(8).toLowerCase()}`, user.id]
    );
    await c.query(
      `INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,'admin')`,
      [org.rows[0].id, user.id]
    );
    return { user, org: org.rows[0] };
  });

  const token = signToken(result.user);
  res.json({ token, user: publicUser(result.user), org: result.org });
});

r.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  const { rows } = await query(`SELECT * FROM users WHERE email = $1`, [email]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const token = signToken(user);
  const { rows: orgs } = await query(
    `SELECT o.*, m.role FROM orgs o
       JOIN memberships m ON m.org_id = o.id
      WHERE m.user_id = $1 ORDER BY o.id`,
    [user.id]
  );
  res.json({ token, user: publicUser(user), orgs });
});

r.get('/me', authenticate, async (req, res) => {
  const { rows: orgs } = await query(
    `SELECT o.*, m.role FROM orgs o
       JOIN memberships m ON m.org_id = o.id
      WHERE m.user_id = $1 ORDER BY o.id`,
    [req.auth.userId]
  );
  res.json({ user: { id: req.auth.userId, email: req.auth.email }, orgs, currentOrg: req.auth.orgId });
});

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name };
}

export default r;
