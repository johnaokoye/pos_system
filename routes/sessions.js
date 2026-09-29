const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAuth, requirePermission } = require('../lib/permissions');
const { logActivity, clientIp, pruneActivity } = require('../lib/sessionActivity');

// Admin > Active Sessions dashboard: who is logged in, where from, and what
// they've been doing. Viewing is gated on the `security` module (same as
// Security Groups, which sits beside it in the Admin hub); force-logging a
// session out needs `security_manage`.

// A session counts as "online" if it made any request within this window.
// The SPA doesn't poll on idle screens, so this is "recently active" rather
// than a true presence signal.
const ONLINE_WINDOW_MIN = 5;

// Any logged-in employee — the SPA reports each screen it navigates to so the
// dashboard can show what someone is currently looking at.
router.post('/section', requireAuth, async (req, res) => {
  try {
    if (!req.sessionId) return res.json({ success: true }); // API-key caller, nothing to track
    const section = String(req.body?.section || '').slice(0, 60);
    if (!section) return res.status(400).json({ error: 'section is required' });
    const branchId = Number.isInteger(req.body?.branch_id) ? req.body.branch_id : null;
    const { rows: [prev] } = await db.execute({ sql: 'SELECT last_section FROM sessions WHERE id = ?', args: [req.sessionId] });
    await db.execute({
      sql: 'UPDATE sessions SET last_section = ?, branch_id = COALESCE(?, branch_id) WHERE id = ?',
      args: [section, branchId, req.sessionId],
    });
    // Re-opening the screen you're already on (refresh button, hub re-entry)
    // isn't new activity — don't flood the feed with it.
    if (!prev || prev.last_section !== section) {
      logActivity({ sessionId: req.sessionId, employeeId: req.employee.id, kind: 'view', detail: section, ip: clientIp(req) });
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/', requirePermission('security'), async (req, res) => {
  try {
    pruneActivity();
    const includeEnded = req.query.status === 'all';
    const where = includeEnded
      ? "s.created_at >= datetime('now', '-7 days')"
      : "s.revoked_at IS NULL AND s.expires_at > datetime('now')";
    const { rows: sessions } = await db.execute({
      sql: `SELECT s.id, s.employee_id, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at,
              s.ip_address, s.user_agent, s.last_section, s.branch_id,
              e.first_name, e.last_name, e.username, sg.name AS security_group_name, b.name AS branch_name,
              CAST((julianday('now') - julianday(s.last_seen_at)) * 1440 AS INTEGER) AS idle_minutes,
              (SELECT COUNT(*) FROM session_activity a WHERE a.session_id = s.id AND a.kind = 'action') AS action_count,
              (SELECT a.method || ' ' || a.path FROM session_activity a WHERE a.session_id = s.id AND a.kind = 'action' ORDER BY a.id DESC LIMIT 1) AS last_action,
              (SELECT a.created_at FROM session_activity a WHERE a.session_id = s.id AND a.kind = 'action' ORDER BY a.id DESC LIMIT 1) AS last_action_at
            FROM sessions s
            JOIN employees e ON e.id = s.employee_id
            LEFT JOIN security_groups sg ON sg.id = e.security_group_id
            LEFT JOIN branches b ON b.id = s.branch_id
            WHERE ${where}
            ORDER BY s.last_seen_at DESC
            LIMIT 500`,
      args: [],
    });
    for (const s of sessions) {
      s.is_current = s.id === req.sessionId;
      s.online = !s.revoked_at && s.idle_minutes != null && s.idle_minutes < ONLINE_WINDOW_MIN;
      s.ended = !!s.revoked_at || s.expires_at <= new Date().toISOString();
    }
    const { rows: [counts] } = await db.execute({
      sql: `SELECT
              (SELECT COUNT(*) FROM session_activity WHERE kind = 'login_failed' AND created_at >= datetime('now', '-1 day')) AS failed_logins_24h,
              (SELECT COUNT(*) FROM session_activity WHERE kind = 'login' AND created_at >= datetime('now', '-1 day')) AS logins_24h,
              (SELECT COUNT(*) FROM session_activity WHERE kind = 'action' AND created_at >= datetime('now', '-1 day')) AS actions_24h`,
      args: [],
    });
    const live = sessions.filter(s => !s.ended);
    res.json({
      sessions,
      stats: {
        active_sessions: live.length,
        online_now: live.filter(s => s.online).length,
        users_logged_in: new Set(live.map(s => s.employee_id)).size,
        ...counts,
      },
      online_window_min: ONLINE_WINDOW_MIN,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Recent activity across every session (or one employee), newest first.
// Failed logins have no session/employee, so they only show up here.
router.get('/activity', requirePermission('security'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const args = [];
    let where = '1=1';
    if (req.query.employee_id) { where += ' AND a.employee_id = ?'; args.push(parseInt(req.query.employee_id, 10)); }
    if (req.query.session_id) { where += ' AND a.session_id = ?'; args.push(parseInt(req.query.session_id, 10)); }
    if (req.query.kind) { where += ' AND a.kind = ?'; args.push(String(req.query.kind)); }
    args.push(limit);
    const { rows } = await db.execute({
      sql: `SELECT a.*, e.first_name, e.last_name, e.username
            FROM session_activity a
            LEFT JOIN employees e ON e.id = a.employee_id
            WHERE ${where}
            ORDER BY a.id DESC
            LIMIT ?`,
      args,
    });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Force-logout: the next request from that browser fails sessionAuth and the
// SPA bounces it to the login screen.
router.post('/:id/revoke', requirePermission('security_manage'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: [s] } = await db.execute({ sql: 'SELECT id, employee_id, revoked_at FROM sessions WHERE id = ?', args: [id] });
    if (!s) return res.status(404).json({ error: 'Session not found' });
    if (s.revoked_at) return res.json({ success: true, already: true });
    await db.execute({ sql: "UPDATE sessions SET revoked_at = datetime('now') WHERE id = ?", args: [id] });
    logActivity({
      sessionId: id, employeeId: s.employee_id, kind: 'revoked',
      detail: req.employee ? `by ${req.employee.first_name} ${req.employee.last_name}` : 'by API key',
      ip: clientIp(req),
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
