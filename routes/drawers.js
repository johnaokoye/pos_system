const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAuth, requirePermission, drawerScope } = require('../lib/permissions');
const { loadDrawerSession, currencySettings, round2 } = require('../lib/drawerReport');

// ── Cash Drawers (configuration) ─────────────────────────────────────────────

// requireAuth only — any cashier needs to see available drawers to open a
// session (App.checkPOSDrawer()), not just users who manage drawer config.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { branch_id } = req.query;
    let sql = `SELECT d.*, b.name as branch_name,
      ds.id as active_session_id,
      ds.employee_id as active_employee_id,
      e.first_name || ' ' || e.last_name as active_employee_name
      FROM cash_drawers d
      LEFT JOIN branches b ON d.branch_id = b.id
      LEFT JOIN drawer_sessions ds ON ds.drawer_id = d.id AND ds.status = 'open'
      LEFT JOIN employees e ON e.id = ds.employee_id
      WHERE d.active = 1`;
    const params = [];
    if (branch_id) { sql += ' AND d.branch_id = ?'; params.push(branch_id); }
    sql += ' ORDER BY b.name, d.name';
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requirePermission('drawers'), async (req, res) => {
  try {
    const { branch_id, name } = req.body;
    if (!name || !branch_id) return res.status(400).json({ error: 'branch_id and name required' });
    const result = await db.execute({ sql: 'INSERT INTO cash_drawers (branch_id, name) VALUES (?,?)', args: [branch_id, name] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM cash_drawers WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', requirePermission('drawers'), async (req, res) => {
  try {
    const { name, active } = req.body;
    await db.execute({ sql: 'UPDATE cash_drawers SET name=?, active=? WHERE id=?', args: [name, active ?? 1, req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM cash_drawers WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', requirePermission('drawers'), async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE cash_drawers SET active=0 WHERE id=?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Drawer Sessions ───────────────────────────────────────────────────────────

// Your own session, or anyone's with drawers_reconcile_all (drawerScope).
function canActOnSession(req, session) {
  return drawerScope(req) === 'all' || (!!req.employee && session.employee_id === req.employee.id);
}

// requireAuth only — App.checkPOSDrawer() calls this on every page load to
// find the current user's own open session, regardless of drawers permission.
router.get('/sessions', requireAuth, async (req, res) => {
  try {
    // `unreconciled=1` returns every session not yet reconciled (open, or
    // closed but not counted) regardless of when it was opened, so a drawer
    // left open from a previous day is never hidden behind the date filter.
    // `from`/`to` bound opened_at to a caller-local day (UTC 'YYYY-MM-DD
    // HH:MM:SS', matching CURRENT_TIMESTAMP) — `date` alone matches the UTC
    // calendar day, which splits a Jamaica evening across two dates.
    // Without drawers_reconcile_all only the employee's own sessions are
    // listed (App.checkPOSDrawer() only ever asks for its own).
    const { branch_id, date, from, to, status, unreconciled } = req.query;
    const employee_id = drawerScope(req) === 'all' ? req.query.employee_id : req.employee?.id;
    let sql = `
      SELECT ds.*,
        d.name as drawer_name,
        b.name as branch_name,
        e.first_name || ' ' || e.last_name as employee_name,
        (SELECT COUNT(*) FROM transactions t WHERE t.drawer_session_id = ds.id) as tx_count,
        (SELECT COALESCE(SUM(t.total),0) FROM transactions t WHERE t.drawer_session_id = ds.id) as tx_total,
        dr.reconciled_at
      FROM drawer_sessions ds
      LEFT JOIN cash_drawers d ON ds.drawer_id = d.id
      LEFT JOIN branches b ON ds.branch_id = b.id
      LEFT JOIN employees e ON ds.employee_id = e.id
      LEFT JOIN drawer_reconciliations dr ON dr.session_id = ds.id
      WHERE 1=1`;
    const params = [];
    if (branch_id)   { sql += ' AND ds.branch_id = ?';   params.push(branch_id); }
    if (status)      { sql += ' AND ds.status = ?';       params.push(status); }
    if (employee_id) { sql += ' AND ds.employee_id = ?';  params.push(employee_id); }
    if (date)        { sql += ' AND DATE(ds.opened_at) = ?'; params.push(date); }
    if (from)        { sql += ' AND ds.opened_at >= ?';   params.push(from); }
    if (to)          { sql += ' AND ds.opened_at < ?';    params.push(to); }
    if (unreconciled) { sql += " AND ds.status != 'reconciled'"; }
    sql += ' ORDER BY ds.opened_at DESC';
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// The session with its tenders, account payments, petty cash payouts,
// reconciliation and the computed report (lib/drawerReport.js).
router.get('/sessions/:id', requireAuth, async (req, res) => {
  try {
    const session = await loadDrawerSession(db, req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });
    if (!canActOnSession(req, session)) return res.status(403).json({ error: 'You can only view your own drawer sessions' });
    res.json(session);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Open a session — returns existing open session for the employee if present
// requireAuth only — opening/closing/reconciling a drawer session is a
// routine daily task for any cashier, not gated by a management permission.
router.post('/sessions', requireAuth, async (req, res) => {
  try {
    const { drawer_id, branch_id, employee_id, opening_float } = req.body;
    if (!drawer_id || !employee_id) return res.status(400).json({ error: 'drawer_id and employee_id required' });
    const { rows: [existing] } = await db.execute({ sql: "SELECT * FROM drawer_sessions WHERE employee_id = ? AND status = 'open'", args: [employee_id] });
    if (existing) return res.json(existing);
    const result = await db.execute({ sql: 'INSERT INTO drawer_sessions (drawer_id, branch_id, employee_id, opening_float) VALUES (?,?,?,?)', args: [drawer_id, branch_id || null, employee_id, opening_float || 0] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM drawer_sessions WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// A cashier can always close their own session (the POS closes a stale
// one from a previous day); anyone else's needs drawers_reconcile_all.
router.patch('/sessions/:id/close', requireAuth, async (req, res) => {
  try {
    const { rows: [session] } = await db.execute({ sql: 'SELECT id, employee_id FROM drawer_sessions WHERE id = ?', args: [req.params.id] });
    if (!session) return res.status(404).json({ error: 'Drawer session not found' });
    if (!canActOnSession(req, session)) return res.status(403).json({ error: 'You can only close your own drawer session' });
    await db.execute({ sql: "UPDATE drawer_sessions SET status='closed', closed_at=CURRENT_TIMESTAMP WHERE id=?", args: [req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM drawer_sessions WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Reconcile: your own session with drawers_close, anyone's with
// drawers_reconcile_all.
router.post('/sessions/:id/reconcile', requireAuth, async (req, res) => {
  try {
    const { rows: [session] } = await db.execute({ sql: 'SELECT id, employee_id, status FROM drawer_sessions WHERE id = ?', args: [req.params.id] });
    if (!session) return res.status(404).json({ error: 'Drawer session not found' });
    const scope = drawerScope(req);
    if (!scope) return res.status(403).json({ error: 'Missing permission: Close & Reconcile Own Drawer' });
    if (!canActOnSession(req, session)) return res.status(403).json({ error: 'You can only reconcile your own drawer — reconciling other drawers needs Reconcile All Drawers' });
    if (session.status === 'reconciled') return res.status(400).json({ error: 'This drawer session is already reconciled' });
    const { cash_counted, card_counted, check_counted, gift_card_counted, credit_counted, direct_deposit_counted, notes, reconciled_by, note_counts } = req.body;
    // The float is handed back before the cash count (lib/drawerReport.js);
    // the rates valuing any foreign notes are kept with the count.
    const floatReturned = req.body.float_returned == null || req.body.float_returned === '' ? null : round2(req.body.float_returned);
    if (floatReturned == null) return res.status(400).json({ error: 'Enter the float returned (0 if none)' });
    const { rates } = await currencySettings(db);
    const tx = await db.transaction('write');
    try {
      await tx.execute({ sql: 'INSERT OR REPLACE INTO drawer_reconciliations (session_id, cash_counted, card_counted, check_counted, gift_card_counted, credit_counted, direct_deposit_counted, notes, reconciled_by, float_returned, fx_rates) VALUES (?,?,?,?,?,?,?,?,?,?,?)', args: [req.params.id, cash_counted || 0, card_counted || 0, check_counted || 0, gift_card_counted || 0, credit_counted || 0, direct_deposit_counted || 0, notes || null, reconciled_by || null, floatReturned, JSON.stringify(rates)] });
      const { rows: [rec] } = await tx.execute({ sql: 'SELECT id FROM drawer_reconciliations WHERE session_id = ?', args: [req.params.id] });
      if (rec && Array.isArray(note_counts) && note_counts.length > 0) {
        for (const { denomination_id, quantity } of note_counts) {
          if (denomination_id && quantity != null) {
            await tx.execute({ sql: 'INSERT OR REPLACE INTO reconciliation_note_counts (reconciliation_id, denomination_id, quantity) VALUES (?,?,?)', args: [rec.id, denomination_id, quantity] });
          }
        }
      }
      await tx.execute({ sql: "UPDATE drawer_sessions SET status='reconciled', closed_at=COALESCE(closed_at, CURRENT_TIMESTAMP) WHERE id=?", args: [req.params.id] });
      await tx.commit();
    } catch(e) {
      await tx.rollback();
      return res.status(400).json({ error: e.message });
    }
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM drawer_sessions WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Petty Cash Payouts ────────────────────────────────────────────────────────

// Pay petty cash out of an open drawer against a numbered petty cash
// request slip. A cashier pays from their own open session;
// drawers_reconcile_all can record one on any open session. Never more than the cash in the
// drawer (float + cash takings − payouts so far).
router.post('/sessions/:id/payouts', requirePermission('pos_petty_cash'), async (req, res) => {
  try {
    const amount = round2(req.body.amount);
    const voucher = String(req.body.voucher_number || '').trim();
    const paidTo = String(req.body.paid_to || '').trim() || null;
    const reason = String(req.body.reason || '').trim() || null;
    if (!(amount > 0)) return res.status(400).json({ error: 'Enter an amount above 0' });
    if (!voucher) return res.status(400).json({ error: 'Enter the petty cash voucher number' });
    if (!reason) return res.status(400).json({ error: 'Enter what the petty cash is for' });

    const session = await loadDrawerSession(db, req.params.id);
    if (!session) return res.status(404).json({ error: 'Drawer session not found' });
    if (session.status !== 'open') return res.status(400).json({ error: 'Petty cash can only be paid from an open drawer' });
    if (!canActOnSession(req, session)) {
      return res.status(403).json({ error: 'You can only pay petty cash from your own open drawer' });
    }
    const { rows: [dupe] } = await db.execute({ sql: 'SELECT p.id, p.voucher_number, ds.id as session_id FROM drawer_payouts p JOIN drawer_sessions ds ON ds.id = p.session_id WHERE LOWER(TRIM(p.voucher_number)) = LOWER(?) AND p.voided_at IS NULL', args: [voucher] });
    if (dupe) return res.status(400).json({ error: `Voucher ${dupe.voucher_number} has already been paid out (drawer session #${dupe.session_id})` });
    const inDrawer = round2(session.report.float.opening + session.report.cash_sales - session.report.payouts_total);
    if (amount > inDrawer + 0.001) return res.status(400).json({ error: `Only ${inDrawer.toFixed(2)} cash is in this drawer` });

    const result = await db.execute({ sql: 'INSERT INTO drawer_payouts (session_id, amount, voucher_number, paid_to, reason, employee_id) VALUES (?,?,?,?,?,?)', args: [session.id, amount, voucher, paidTo, reason, req.employee?.id || null] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM drawer_payouts WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Void a payout entered in error (drawers_reconcile_all), until the drawer
// is reconciled. The voucher number can then be used again.
router.patch('/payouts/:id/void', requireAuth, async (req, res) => {
  try {
    if (drawerScope(req) !== 'all') return res.status(403).json({ error: 'Missing permission: Reconcile All Drawers' });
    const { rows: [p] } = await db.execute({ sql: 'SELECT p.*, ds.status as session_status FROM drawer_payouts p JOIN drawer_sessions ds ON ds.id = p.session_id WHERE p.id = ?', args: [req.params.id] });
    if (!p) return res.status(404).json({ error: 'Payout not found' });
    if (p.voided_at) return res.status(400).json({ error: 'Already voided' });
    if (p.session_status === 'reconciled') return res.status(400).json({ error: 'This drawer is already reconciled' });
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Enter a reason for voiding' });
    await db.execute({ sql: 'UPDATE drawer_payouts SET voided_at = CURRENT_TIMESTAMP, voided_by = ?, void_reason = ? WHERE id = ?', args: [req.employee?.id || null, reason, p.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Drawer Employee Access ────────────────────────────────────────────────────

router.get('/:id/access', requirePermission('drawers'), async (req, res) => {
  try {
    const { rows: access } = await db.execute({ sql: `
      SELECT dea.*, e.first_name || ' ' || e.last_name as employee_name, e.employee_number
      FROM drawer_employee_access dea
      JOIN employees e ON e.id = dea.employee_id
      WHERE dea.drawer_id = ? ORDER BY e.first_name`, args: [req.params.id] });
    res.json(access);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id/access', requirePermission('drawers'), async (req, res) => {
  try {
    const { employee_id, can_use, can_reconcile } = req.body;
    if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
    await db.execute({ sql: 'INSERT OR REPLACE INTO drawer_employee_access (drawer_id, employee_id, can_use, can_reconcile) VALUES (?,?,?,?)', args: [req.params.id, employee_id, can_use ? 1 : 0, can_reconcile ? 1 : 0] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/access/:empId', requirePermission('drawers'), async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM drawer_employee_access WHERE drawer_id = ? AND employee_id = ?', args: [req.params.id, req.params.empId] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
