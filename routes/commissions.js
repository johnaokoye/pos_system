const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');

// ── Shared calculation helper (also exported for use in other routes) ──
async function calcCommission(employeeId, saleAmount, sourceType, sourceId, sourceRef) {
  if (!employeeId || saleAmount <= 0) return null;
  const today = new Date().toISOString().split('T')[0];
  const period = today.slice(0, 7);

  const { rows: [asgn] } = await db.execute({ sql: `SELECT ecp.id as asgn_id, ecp.plan_id, cp.type, cp.rate, cp.tiers, cp.apply_to, cp.min_sale_amount FROM employee_commission_plans ecp JOIN commission_plans cp ON ecp.plan_id = cp.id WHERE ecp.employee_id = ? AND cp.active = 1 AND ecp.effective_from <= ? AND (ecp.effective_to IS NULL OR ecp.effective_to >= ?) ORDER BY ecp.effective_from DESC LIMIT 1`, args: [employeeId, today, today] });

  if (!asgn) return null;

  const applyMap = { pos: 'transaction', quotes: 'quotation', crm: 'opportunity', rentals: 'rental' };
  if (asgn.apply_to !== 'all' && applyMap[asgn.apply_to] !== sourceType) return null;
  if (saleAmount < (asgn.min_sale_amount || 0)) return null;

  let commissionAmount = 0;
  let commissionRate = 0;

  if (asgn.type === 'flat') {
    commissionAmount = parseFloat((asgn.rate || 0).toFixed(2));
    commissionRate = saleAmount > 0 ? parseFloat((commissionAmount / saleAmount * 100).toFixed(2)) : 0;
  } else if (asgn.type === 'percentage') {
    commissionRate = asgn.rate || 0;
    commissionAmount = parseFloat((saleAmount * commissionRate / 100).toFixed(2));
  } else if (asgn.type === 'tiered') {
    const tiers = JSON.parse(asgn.tiers || '[]');
    const { rows: [cumRow] } = await db.execute({ sql: `SELECT COALESCE(SUM(sale_amount),0) as total FROM commission_records WHERE employee_id=? AND period=?`, args: [employeeId, period] });
    let cumSales = cumRow.total;
    let remaining = saleAmount;
    let totalComm = 0;

    for (const tier of tiers) {
      if (remaining <= 0) break;
      const tierMax = (tier.max != null) ? tier.max : Infinity;
      if (cumSales >= tierMax) { cumSales -= (tierMax - (tier.min || 0)); continue; }
      const tierStart = Math.max(cumSales, tier.min || 0);
      const tierRoom = tierMax - tierStart;
      const amountInTier = Math.min(remaining, tierRoom);
      totalComm += amountInTier * (tier.rate || 0) / 100;
      cumSales += amountInTier;
      remaining -= amountInTier;
    }
    commissionAmount = parseFloat(totalComm.toFixed(2));
    commissionRate = saleAmount > 0 ? parseFloat((commissionAmount / saleAmount * 100).toFixed(2)) : 0;
  }

  if (commissionAmount <= 0) return null;

  const result = await db.execute({ sql: `INSERT INTO commission_records (employee_id,plan_id,source_type,source_id,source_ref,sale_amount,commission_rate,commission_amount,status,period) VALUES (?,?,?,?,?,?,?,?,'pending',?)`, args: [employeeId, asgn.plan_id, sourceType, sourceId, sourceRef, saleAmount, commissionRate, commissionAmount, period] });
  const { rows: [rec] } = await db.execute({ sql: 'SELECT * FROM commission_records WHERE id = ?', args: [Number(result.lastInsertRowid)] });
  return rec;
}

module.exports.calcCommission = calcCommission;

// Rentals never call calcCommission() directly — commission on a rental is
// deliberately deferred (see routes/rentals.js and routes/accounts.js call
// sites) rather than fired at booking time, so both trigger points share
// this one revenue formula + duplicate-guard instead of duplicating them.
// `source_id` is always the rental's checkout_transaction_id — stable for
// the agreement's whole lifetime, so calling this twice (e.g. a credit
// payment trigger firing after a return trigger already did, in some future
// edge case) is a safe no-op rather than a duplicate commission_records row.
async function calcRentalCommission(agreement, checkoutTx) {
  if (!agreement.checkout_transaction_id) return null;
  const { rows: [existing] } = await db.execute({ sql: "SELECT id FROM commission_records WHERE source_type='rental' AND source_id=?", args: [agreement.checkout_transaction_id] });
  if (existing) return null;

  // Deposit is refundable collateral, not revenue — excluded here even
  // though it's part of checkoutTx.subtotal. damage_fee_total/
  // duration_adjustment_total/tax_adjustment_total are the settlement-time
  // accumulators on rental_agreements (already net of any credits for an
  // early return), added on top of the original checkout revenue.
  const revenueAmount = parseFloat((
    (checkoutTx.subtotal - agreement.deposit_total) +
    checkoutTx.tax_amount +
    (agreement.damage_fee_total || 0) +
    (agreement.duration_adjustment_total || 0) +
    (agreement.tax_adjustment_total || 0)
  ).toFixed(2));

  return calcCommission(agreement.employee_id, revenueAmount, 'rental', agreement.checkout_transaction_id, agreement.agreement_number);
}

router.use(requirePermission('commissions'));

// ── Plans ──────────────────────────────────────────────────
// Gated by commissions_plans (not just the blanket module check above) so a
// view-only commissions user — granted `commissions` but with this sub-key
// unchecked — can't see or touch plan rate structures or assignments.
router.get('/plans', requirePermission('commissions_plans'), async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: 'SELECT * FROM commission_plans ORDER BY active DESC, name', args: [] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/plans', requirePermission('commissions_plans'), async (req, res) => {
  const { name, type, rate, tiers, apply_to, min_sale_amount, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const valid = ['percentage','tiered','flat'];
  if (!valid.includes(type)) return res.status(400).json({ error: 'Invalid type' });
  if (type === 'tiered') {
    try { JSON.parse(tiers || '[]'); } catch(e) { return res.status(400).json({ error: 'Invalid tiers JSON' }); }
  }
  try {
    const result = await db.execute({ sql: `INSERT INTO commission_plans (name,type,rate,tiers,apply_to,min_sale_amount,notes) VALUES (?,?,?,?,?,?,?)`, args: [name, type, parseFloat(rate||0), tiers||null, apply_to||'all', parseFloat(min_sale_amount||0), notes||null] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM commission_plans WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.put('/plans/:id', requirePermission('commissions_plans'), async (req, res) => {
  try {
    const { rows: [plan] } = await db.execute({ sql: 'SELECT * FROM commission_plans WHERE id = ?', args: [req.params.id] });
    if (!plan) return res.status(404).json({ error: 'Not found' });
    const { name, type, rate, tiers, apply_to, min_sale_amount, active, notes } = req.body;
    await db.execute({ sql: `UPDATE commission_plans SET name=?,type=?,rate=?,tiers=?,apply_to=?,min_sale_amount=?,active=?,notes=? WHERE id=?`, args: [name||plan.name, type||plan.type, parseFloat(rate||0), tiers||null, apply_to||plan.apply_to, parseFloat(min_sale_amount||0), active !== undefined ? (active ? 1 : 0) : plan.active, notes||null, req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM commission_plans WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/plans/:id', requirePermission('commissions_plans'), async (req, res) => {
  try {
    const { rows: [used] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM employee_commission_plans WHERE plan_id = ?', args: [req.params.id] });
    if (Number(used.c) > 0) return res.status(400).json({ error: 'Plan is assigned to employees — remove assignments first' });
    await db.execute({ sql: 'DELETE FROM commission_plans WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Assignments ────────────────────────────────────────────
router.get('/assignments', requirePermission('commissions_plans'), async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: `SELECT ecp.*, e.first_name || ' ' || e.last_name as employee_name, e.employee_number, cp.name as plan_name, cp.type as plan_type, cp.rate as plan_rate FROM employee_commission_plans ecp JOIN employees e ON ecp.employee_id = e.id JOIN commission_plans cp ON ecp.plan_id = cp.id ORDER BY e.last_name, ecp.effective_from DESC`, args: [] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/assignments', requirePermission('commissions_plans'), async (req, res) => {
  const { employee_id, plan_id, effective_from, effective_to } = req.body;
  if (!employee_id || !plan_id || !effective_from) return res.status(400).json({ error: 'employee_id, plan_id, effective_from required' });
  try {
    const result = await db.execute({ sql: `INSERT INTO employee_commission_plans (employee_id,plan_id,effective_from,effective_to) VALUES (?,?,?,?)`, args: [employee_id, plan_id, effective_from, effective_to||null] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM employee_commission_plans WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.delete('/assignments/:id', requirePermission('commissions_plans'), async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM employee_commission_plans WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Records ────────────────────────────────────────────────
router.get('/records', async (req, res) => {
  try {
    const { employee_id, period, status } = req.query;
    let sql = `SELECT cr.*, e.first_name || ' ' || e.last_name as employee_name, e.employee_number, cp.name as plan_name, cp.type as plan_type FROM commission_records cr JOIN employees e ON cr.employee_id = e.id LEFT JOIN commission_plans cp ON cr.plan_id = cp.id WHERE 1=1`;
    const params = [];
    // A salesperson only ever sees their own commission records, regardless
    // of what employee_id filter the client asked for.
    if (req.employee?.is_salesperson) { sql += ' AND cr.employee_id = ?'; params.push(req.employee.id); }
    else if (employee_id) { sql += ' AND cr.employee_id = ?'; params.push(employee_id); }
    if (period) { sql += ' AND cr.period = ?'; params.push(period); }
    if (status) { sql += ' AND cr.status = ?'; params.push(status); }
    sql += ' ORDER BY cr.created_at DESC LIMIT 500';
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/records', async (req, res) => {
  const { employee_id, source_type, source_ref, sale_amount, commission_rate, commission_amount, period, notes } = req.body;
  if (!employee_id || !commission_amount) return res.status(400).json({ error: 'employee_id and commission_amount required' });
  const p = period || new Date().toISOString().slice(0, 7);
  try {
    const result = await db.execute({ sql: `INSERT INTO commission_records (employee_id,source_type,source_id,source_ref,sale_amount,commission_rate,commission_amount,status,period,notes) VALUES (?,?,?,?,?,?,?,'pending',?,?)`, args: [employee_id, source_type||'manual', 0, source_ref||'Manual entry', parseFloat(sale_amount||0), parseFloat(commission_rate||0), parseFloat(commission_amount), p, notes||null] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM commission_records WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.patch('/records/:id/approve', requirePermission('commissions_approve'), async (req, res) => {
  try {
    const { rows: [rec] } = await db.execute({ sql: 'SELECT * FROM commission_records WHERE id = ?', args: [req.params.id] });
    if (!rec) return res.status(404).json({ error: 'Not found' });
    if (rec.status === 'paid') return res.status(400).json({ error: 'Already paid' });
    await db.execute({ sql: "UPDATE commission_records SET status='approved', approved_at=datetime('now') WHERE id=?", args: [req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM commission_records WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/records/:id/pay', requirePermission('commissions_pay'), async (req, res) => {
  try {
    const { rows: [rec] } = await db.execute({ sql: 'SELECT * FROM commission_records WHERE id = ?', args: [req.params.id] });
    if (!rec) return res.status(404).json({ error: 'Not found' });
    await db.execute({ sql: "UPDATE commission_records SET status='paid', paid_at=datetime('now') WHERE id=?", args: [req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM commission_records WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/records/bulk-approve', requirePermission('commissions_approve'), async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
    for (const id of ids) {
      await db.execute({ sql: "UPDATE commission_records SET status='approved', approved_at=datetime('now') WHERE id=? AND status='pending'", args: [id] });
    }
    res.json({ updated: ids.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/records/bulk-pay', requirePermission('commissions_pay'), async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
    for (const id of ids) {
      await db.execute({ sql: "UPDATE commission_records SET status='paid', paid_at=datetime('now') WHERE id=? AND status='approved'", args: [id] });
    }
    res.json({ updated: ids.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/records/:id', requirePermission('commissions_delete'), async (req, res) => {
  try {
    const { rows: [rec] } = await db.execute({ sql: 'SELECT * FROM commission_records WHERE id = ?', args: [req.params.id] });
    if (!rec) return res.status(404).json({ error: 'Not found' });
    if (rec.status === 'paid') return res.status(400).json({ error: 'Cannot delete a paid record' });
    await db.execute({ sql: 'DELETE FROM commission_records WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Summary / Dashboard ────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const { period } = req.query;
    const p = period || new Date().toISOString().slice(0, 7);
    // A salesperson only ever sees their own commission totals/status
    // breakdown here, never the whole store's.
    const mine = !!req.employee?.is_salesperson;
    const empScope = mine ? ' AND cr.employee_id = ?' : '';
    const empScopeUnaliased = mine ? ' AND employee_id = ?' : '';
    const empArgs = mine ? [req.employee.id] : [];

    const { rows: byEmployee } = await db.execute({ sql: `SELECT cr.employee_id, e.first_name || ' ' || e.last_name as employee_name, e.employee_number, COUNT(*) as record_count, COALESCE(SUM(cr.sale_amount),0) as total_sales, COALESCE(SUM(cr.commission_amount),0) as total_commission, COALESCE(SUM(CASE WHEN cr.status='pending' THEN cr.commission_amount ELSE 0 END),0) as pending, COALESCE(SUM(CASE WHEN cr.status='approved' THEN cr.commission_amount ELSE 0 END),0) as approved, COALESCE(SUM(CASE WHEN cr.status='paid' THEN cr.commission_amount ELSE 0 END),0) as paid FROM commission_records cr JOIN employees e ON cr.employee_id = e.id WHERE cr.period = ?${empScope} GROUP BY cr.employee_id ORDER BY total_commission DESC`, args: [p, ...empArgs] });
    const { rows: [totals] } = await db.execute({ sql: `SELECT COALESCE(SUM(commission_amount),0) as total, COALESCE(SUM(CASE WHEN status='pending' THEN commission_amount ELSE 0 END),0) as pending, COALESCE(SUM(CASE WHEN status='approved' THEN commission_amount ELSE 0 END),0) as approved, COALESCE(SUM(CASE WHEN status='paid' THEN commission_amount ELSE 0 END),0) as paid, COUNT(*) as count FROM commission_records WHERE period = ?${empScopeUnaliased}`, args: [p, ...empArgs] });
    const { rows: bySource } = await db.execute({ sql: `SELECT source_type, COUNT(*) as count, COALESCE(SUM(commission_amount),0) as total FROM commission_records WHERE period = ?${empScopeUnaliased} GROUP BY source_type`, args: [p, ...empArgs] });
    const { rows: periodsRows } = await db.execute({ sql: `SELECT DISTINCT period FROM commission_records${mine ? ' WHERE employee_id = ?' : ''} ORDER BY period DESC LIMIT 24`, args: empArgs });

    res.json({ period: p, byEmployee, totals, bySource, periods: periodsRows.map(r => r.period) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Manual recalculate a single transaction
router.post('/calculate/transaction/:txId', async (req, res) => {
  try {
    const { rows: [tx] } = await db.execute({ sql: 'SELECT * FROM transactions WHERE id = ?', args: [req.params.txId] });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (!tx.employee_id) return res.status(400).json({ error: 'Transaction has no employee' });
    const { rows: [existing] } = await db.execute({ sql: "SELECT id FROM commission_records WHERE source_type='transaction' AND source_id=?", args: [tx.id] });
    if (existing) return res.status(400).json({ error: 'Commission already calculated for this transaction' });
    const rec = await calcCommission(tx.employee_id, tx.total, 'transaction', tx.id, tx.transaction_number);
    if (!rec) return res.status(400).json({ error: 'No active commission plan found for this employee' });
    res.status(201).json(rec);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.calcCommission = calcCommission;
module.exports.calcRentalCommission = calcRentalCommission;
