import { query } from '../db.js';

// Fire-and-forget audit writer. Never blocks or breaks the request path.
export function audit(req, action, target, meta = {}) {
  const a = req.auth || {};
  query(
    `INSERT INTO audit_log (org_id, actor_id, actor_kind, action, target, meta, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      a.orgId || null,
      a.userId || null,
      a.kind || 'system',
      action,
      target ? String(target) : null,
      meta,
      req.ip,
    ]
  ).catch((err) => console.error('[audit] write failed:', err.message));
}
