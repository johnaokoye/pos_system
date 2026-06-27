const express = require('express');
const router = express.Router();
const { db } = require('../database');

// ── Cash Drawers (configuration) ─────────────────────────────────────────────

router.get('/', async (req, res) => {
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

router.post('/', async (req, res) => {
  try {
    const { branch_id, name } = req.body;
    if (!name || !branch_id) return res.status(400).json({ error: 'branch_id and name required' });
    const result = await db.execute({ sql: 'INSERT INTO cash_drawers (branch_id, name) VALUES (?,?)', args: [branch_id, name] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM cash_drawers WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const { name, active } = req.body;
    await db.execute({ sql: 'UPDATE cash_drawers SET name=?, active=? WHERE id=?', args: [name, active ?? 1, req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM cash_drawers WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE cash_drawers SET active=0 WHERE id=?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Drawer Sessions ───────────────────────────────────────────────────────────

router.get('/sessions', async (req, res) => {
  try {
    const { branch_id, date, status, employee_id } = req.query;
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
    sql += ' ORDER BY ds.opened_at DESC';
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/sessions/:id', async (req, res) => {
  try {
    const { rows: [session] } = await db.execute({ sql: `
      SELECT ds.*,
        d.name as drawer_name,
        b.name as branch_name,
        e.first_name || ' ' || e.last_name as employee_name
      FROM drawer_sessions ds
      LEFT JOIN cash_drawers d ON ds.drawer_id = d.id
      LEFT JOIN branches b ON ds.branch_id = b.id
      LEFT JOIN employees e ON ds.employee_id = e.id
      WHERE ds.id = ?`, args: [req.params.id] });
    if (!session) return res.status(404).json({ error: 'Not found' });

    const { rows: tenders } = await db.execute({ sql: `
      SELECT payment_method,
        COUNT(*) as tx_count,
        COALESCE(SUM(total), 0) as total
      FROM transactions WHERE drawer_session_id = ?
      GROUP BY payment_method`, args: [req.params.id] });
    session.tenders = tenders;

    const { rows: [reconciliation] } = await db.execute({ sql: `SELECT dr.*, e.first_name || ' ' || e.last_name as reconciled_by_name FROM drawer_reconciliations dr LEFT JOIN employees e ON e.id = dr.reconciled_by WHERE dr.session_id = ?`, args: [req.params.id] });
    session.reconciliation = reconciliation || null;

    if (session.reconciliation) {
      const { rows: note_counts } = await db.execute({ sql: `
        SELECT rnc.denomination_id, rnc.quantity, cd.value, cd.label, cd.currency, cd.sort_order
        FROM reconciliation_note_counts rnc
        JOIN currency_denominations cd ON cd.id = rnc.denomination_id
        WHERE rnc.reconciliation_id = ?
        ORDER BY cd.sort_order, cd.value DESC
      `, args: [session.reconciliation.id] });
      session.reconciliation.note_counts = note_counts;
    }

    res.json(session);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Open a session — returns existing open session for the employee if present
router.post('/sessions', async (req, res) => {
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

router.patch('/sessions/:id/close', async (req, res) => {
  try {
    await db.execute({ sql: "UPDATE drawer_sessions SET status='closed', closed_at=CURRENT_TIMESTAMP WHERE id=?", args: [req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM drawer_sessions WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/sessions/:id/reconcile', async (req, res) => {
  try {
    const { cash_counted, card_counted, check_counted, gift_card_counted, credit_counted, direct_deposit_counted, notes, reconciled_by, note_counts } = req.body;
    const tx = await db.transaction('write');
    try {
      await tx.execute({ sql: 'INSERT OR REPLACE INTO drawer_reconciliations (session_id, cash_counted, card_counted, check_counted, gift_card_counted, credit_counted, direct_deposit_counted, notes, reconciled_by) VALUES (?,?,?,?,?,?,?,?,?)', args: [req.params.id, cash_counted || 0, card_counted || 0, check_counted || 0, gift_card_counted || 0, credit_counted || 0, direct_deposit_counted || 0, notes || null, reconciled_by || null] });
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

// ── Drawer Employee Access ────────────────────────────────────────────────────

router.get('/:id/access', async (req, res) => {
  try {
    const { rows: access } = await db.execute({ sql: `
      SELECT dea.*, e.first_name || ' ' || e.last_name as employee_name, e.employee_number
      FROM drawer_employee_access dea
      JOIN employees e ON e.id = dea.employee_id
      WHERE dea.drawer_id = ? ORDER BY e.first_name`, args: [req.params.id] });
    res.json(access);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id/access', async (req, res) => {
  try {
    const { employee_id, can_use, can_reconcile } = req.body;
    if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
    await db.execute({ sql: 'INSERT OR REPLACE INTO drawer_employee_access (drawer_id, employee_id, can_use, can_reconcile) VALUES (?,?,?,?)', args: [req.params.id, employee_id, can_use ? 1 : 0, can_reconcile ? 1 : 0] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/access/:empId', async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM drawer_employee_access WHERE drawer_id = ? AND employee_id = ?', args: [req.params.id, req.params.empId] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
