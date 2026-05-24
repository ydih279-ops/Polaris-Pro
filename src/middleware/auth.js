import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config.js';
import { query } from '../db.js';

const ROLE_RANK = { viewer: 1, editor: 2, admin: 3 };

export function signToken(user) {
  return jwt.sign({ uid: user.id, email: user.email }, config.jwtSecret, {
    expiresIn: '7d',
  });
}

// Resolve the caller from either a Bearer JWT (UI) or an API key (public API).
// Attaches req.auth = { userId|null, orgId, role, kind }.
export async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const apiKey = req.headers['x-api-key'];

  try {
    if (apiKey) {
      const auth = await resolveApiKey(apiKey);
      if (!auth) return res.status(401).json({ error: 'invalid api key' });
      req.auth = auth;
      return next();
    }

    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'not authenticated' });

    const payload = jwt.verify(token, config.jwtSecret);
    // Resolve the org from header or the user's first membership.
    const orgId = req.headers['x-org-id'] || (await firstOrg(payload.uid));
    if (!orgId) return res.status(403).json({ error: 'no org' });

    const { rows } = await query(
      `SELECT role FROM memberships WHERE user_id = $1 AND org_id = $2`,
      [payload.uid, orgId]
    );
    if (!rows[0]) return res.status(403).json({ error: 'not a member of this org' });

    req.auth = {
      userId: payload.uid,
      email: payload.email,
      orgId: Number(orgId),
      role: rows[0].role,
      kind: 'user',
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'auth failed' });
  }
}

async function firstOrg(userId) {
  const { rows } = await query(
    `SELECT org_id FROM memberships WHERE user_id = $1 ORDER BY id LIMIT 1`,
    [userId]
  );
  return rows[0]?.org_id;
}

export function hashApiKey(plain) {
  return crypto.createHash('sha256').update(plain).digest('hex');
}

async function resolveApiKey(plain) {
  const keyHash = hashApiKey(plain);
  const { rows } = await query(
    `SELECT * FROM api_keys WHERE key_hash = $1 AND revoked = false`,
    [keyHash]
  );
  const key = rows[0];
  if (!key) return null;
  // touch last_used without blocking the request
  query(`UPDATE api_keys SET last_used = now() WHERE id = $1`, [key.id]).catch(() => {});
  return {
    userId: null,
    orgId: key.org_id,
    role: key.scopes.includes('write') ? 'editor' : 'viewer',
    kind: 'api_key',
    keyId: key.id,
  };
}

// Gate a route by minimum role.
export function requireRole(min) {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'not authenticated' });
    if (ROLE_RANK[req.auth.role] < ROLE_RANK[min]) {
      return res.status(403).json({ error: `requires ${min} role` });
    }
    next();
  };
}
