import { Router } from 'express';
import { nanoid } from 'nanoid';
import { query } from '../db.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { notify } from '../lib/notify.js';
import { config } from '../config.js';

const r = Router();
r.use(authenticate);

r.get('/members', async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.email, u.name, m.role, m.created_at
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1 ORDER BY m.created_at`,
    [req.auth.orgId]
  );
  res.json({ members: rows });
});

// Invite a teammate. Admin only. We email a join link; if SMTP is off it logs.
r.post('/invites', requireRole('admin'), async (req, res) => {
  const { email, role = 'editor' } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });
  const token = nanoid(24);
  await query(
    `INSERT INTO invites (org_id, email, role, token, invited_by) VALUES ($1,$2,$3,$4,$5)`,
    [req.auth.orgId, email, role, token, req.auth.userId]
  );
  const link = `${config.publicUrl}/?invite=${token}`;
  await notify('email', email, 'You have been invited to Polaris',
    `Join the workspace: ${link}`);
  audit(req, 'invite.create', email, { role });
  res.json({ ok: true, inviteLink: link });
});

// Accept an invite (the invited user must be logged in).
r.post('/invites/accept', async (req, res) => {
  const { token } = req.body || {};
  const { rows } = await query(
    `SELECT * FROM invites WHERE token = $1 AND accepted_at IS NULL`, [token]
  );
  const inv = rows[0];
  if (!inv) return res.status(404).json({ error: 'invite not found or used' });

  await query(
    `INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [inv.org_id, req.auth.userId, inv.role]
  );
  await query(`UPDATE invites SET accepted_at = now() WHERE id = $1`, [inv.id]);
  audit(req, 'invite.accept', inv.org_id, {});
  res.json({ ok: true, orgId: inv.org_id });
});

// Change a member's role. Admin only.
r.patch('/members/:userId/role', requireRole('admin'), async (req, res) => {
  const { role } = req.body || {};
  if (!['viewer', 'editor', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'invalid role' });
  }
  await query(
    `UPDATE memberships SET role = $1 WHERE org_id = $2 AND user_id = $3`,
    [role, req.auth.orgId, req.params.userId]
  );
  audit(req, 'member.role_change', req.params.userId, { role });
  res.json({ ok: true });
});

// Audit trail — who did what, when. Admin only.
r.get('/audit', requireRole('admin'), async (req, res) => {
  const { rows } = await query(
    `SELECT a.*, u.email AS actor_email
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.org_id = $1 ORDER BY a.created_at DESC LIMIT 200`,
    [req.auth.orgId]
  );
  res.json({ entries: rows });
});

export default r;
