const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { calcCommission } = require('./commissions');
const { getWcSettings, wcRequest } = require('./woocommerce');
const { syncBinQty } = require('../lib/binSync');
const { requireAuth, requirePermission, requireAnyPermission, can } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');
const { blockedMessage, creditLimitError } = require('../lib/creditBlock');
const { resolveUnit, lineName, parseQty, stockUnits } = require('../lib/units');
const { isSerialNumberProduct, serialNumberLabel, serialNumberOf, serialClashError } = require('../lib/serialNumber');
const { checkDiscountEligibility } = require('./promotions');
const { allocateTicketDiscount, returnedDiscountShare } = require('../lib/ticketDiscount');
const { UNAPPLIED_SQL } = require('../lib/customerPayments');

// Mirrors availableCashBack() in public/index.html — the frontend uses this
// same formula to decide whether to show the Cash Back bar; this copy is the
// server-side clamp applied below so a stale/tampered client value can never
// apply more than the customer is actually entitled to.
function computeAvailableCashBack(row) {
  if (!row || !row.active || !row.points_threshold || !row.reward_amount) return 0;
  const accrued = Math.floor((row.loyalty_points || 0) / row.points_threshold) * row.reward_amount;
  if (accrued <= 0) return 0;
  if (row.min_redeem_amount > 0 && accrued < row.min_redeem_amount) return 0;
  if (row.min_redeem_days > 0 && row.cash_back_last_redeemed_at) {
    const daysSince = (Date.now() - new Date(row.cash_back_last_redeemed_at).getTime()) / 86400000;
    if (daysSince < row.min_redeem_days) return 0;
  }
  return accrued;
}

// The POS ticket's Salesperson pick: must be an active employee flagged
// Salesperson; empty means the cashier. Throws a 400-worthy message otherwise.
async function resolveSalesperson(salespersonId) {
  if (salespersonId == null || salespersonId === '') return null;
  const { rows: [sp] } = await db.execute({ sql: 'SELECT id FROM employees WHERE id = ? AND active = 1 AND is_salesperson = 1', args: [salespersonId] });
  if (!sp) throw Object.assign(new Error('The selected salesperson is not an active Salesperson'), { status: 400 });
  return sp.id;
}

// Who a sale is credited to for sales targets: the person who started the
// ticket when they're a Salesperson (a hold they put up, their quote, a sale
// they rang up themselves) — not the cashier who finishes it or whoever the
// cashier picks; otherwise the Salesperson picked on the ticket. Stored in
// salesperson_id; reads use CREDITED_SQL so a sale with none falls back to
// whoever started it, then the cashier. A sales manager can change it after
// the sale (PATCH /salesperson).
async function ticketSalesperson(initiatorId, pickedId) {
  if (initiatorId) {
    const { rows: [sp] } = await db.execute({ sql: 'SELECT id FROM employees WHERE id = ? AND is_salesperson = 1 AND active = 1', args: [initiatorId] });
    if (sp) return sp.id;
  }
  return resolveSalesperson(pickedId);
}
const CREDITED_SQL = 'COALESCE(t.salesperson_id, t.created_by, t.employee_id)';

// Commission follows a sale to its new salesperson (PATCH /salesperson):
// the old person's unpaid commission on it (pending or approved) is removed
// and worked out again for the new one — their plan as of the sale date,
// counted in the sale's month, as a new pending record. Paid commission is
// never touched — the sale is listed back so it can be settled by hand —
// the same rule a void follows. Rental commission (source_type 'rental')
// stays with the rental agreement.
async function moveSaleCommissions(moved) {
  const result = { commissions_moved: 0, commissions_paid: [] };
  if (!moved.length) return result;
  const ids = moved.map(m => m.id);
  const { rows: recs } = await db.execute({ sql: `SELECT source_id, status, sale_amount FROM commission_records WHERE source_type = 'transaction' AND source_id IN (${ids.map(() => '?').join(',')})`, args: ids });
  const { rows: txs } = await db.execute({ sql: `SELECT id, total, created_at FROM transactions WHERE id IN (${ids.map(() => '?').join(',')})`, args: ids });
  const txById = Object.fromEntries(txs.map(t => [Number(t.id), t]));
  // Only employees with a commission plan can earn one — skip the rest.
  const { rows: planned } = await db.execute({ sql: 'SELECT DISTINCT employee_id FROM employee_commission_plans', args: [] });
  const hasPlan = new Set(planned.map(p => Number(p.employee_id)));
  for (const m of moved) {
    const own = recs.filter(r => Number(r.source_id) === Number(m.id));
    if (own.some(r => r.status === 'paid')) { result.commissions_paid.push(m.transaction_number); continue; }
    try {
      if (own.length) await db.execute({ sql: "DELETE FROM commission_records WHERE source_type = 'transaction' AND source_id = ? AND status != 'paid'", args: [m.id] });
      const tx = txById[Number(m.id)];
      const amount = own.length ? Number(own[0].sale_amount) : Number(tx?.total) || 0;
      const rec = hasPlan.has(Number(m.after)) ? await calcCommission(m.after, amount, 'transaction', m.id, m.transaction_number, tx?.created_at) : null;
      if (own.length || rec) result.commissions_moved++;
    } catch (e) { console.error('[salesperson] commission move failed for', m.transaction_number, e.message); }
  }
  return result;
}

// Put order on hold (no stock updates, no payment processing)
router.post('/hold', requirePermission('pos_hold'), async (req, res) => {
  try {
    const { customer_id, employee_id, created_by, branch_id, items, discount_amount, notes, promotion_code, promotion_name } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items in cart' });
    const discountSource = ['manual', 'promo_code', 'auto_promo', 'card'].includes(req.body.discount_source) ? req.body.discount_source : null;
    const ticketPct = discountSource === 'manual' ? Math.min(100, Math.max(0, parseFloat(req.body.ticket_discount_percent) || 0)) || null : null;
    let salespersonId;
    try { salespersonId = await ticketSalesperson(created_by || employee_id, req.body.salesperson_id); } catch (e) { return res.status(400).json({ error: e.message }); }

    const hold_number = 'HOLD-' + Date.now();
    // A line's manual % discount (and who overrode the store limit) is kept
    // so Hold Recall restores it; checkout re-validates it as usual. Line
    // totals are net of it, then the same before-tax ticket discount as
    // checkout (lib/ticketDiscount.js).
    // A "$" line discount (discount_fixed) is held as the amount, with its
    // equivalent % alongside.
    const lineGross = items.map(item => parseFloat(((parseFloat(item.unit_price) || 0) * (Number(item.quantity) || 0)).toFixed(2)));
    const lineFixed = items.map((item, i) => Math.min(lineGross[i], Math.max(0, parseFloat(item.discount_fixed) || 0)) || null);
    const linePct = items.map((item, i) => lineFixed[i] ? (lineGross[i] > 0 ? parseFloat((lineFixed[i] / lineGross[i] * 100).toFixed(4)) : 0) : Math.min(100, Math.max(0, parseFloat(item.discount_percent) || 0)));
    const lineDisc = lineGross.map((g, i) => lineFixed[i] ? parseFloat(lineFixed[i].toFixed(2)) : parseFloat((g * linePct[i] / 100).toFixed(2)));
    const lineTotals = lineGross.map((g, i) => parseFloat((g - lineDisc[i]).toFixed(2)));
    const { discount: disc, shares } = allocateTicketDiscount(lineTotals, discount_amount);
    const lineTaxes = items.map((item, i) => parseFloat(((lineTotals[i] - shares[i]) * (parseFloat(item.tax_rate) || 0) / 100).toFixed(2)));
    const subtotal = parseFloat(lineTotals.reduce((s, t) => s + t, 0).toFixed(2));
    const tax_amount = parseFloat(lineTaxes.reduce((s, t) => s + t, 0).toFixed(2));
    const total = parseFloat((subtotal - disc + tax_amount).toFixed(2));

    const txn = await db.transaction('write');
    let committed = false;
    try {
      const result = await txn.execute({
        sql: `INSERT INTO transactions (transaction_number,customer_id,employee_id,created_by,salesperson_id,branch_id,subtotal,tax_amount,discount_amount,total,payment_method,status,notes,amount_tendered,change_amount,promotion_code,promotion_name,discount_source,ticket_discount_percent,po_number) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?,?,?)`,
        args: [hold_number, customer_id || null, employee_id || 1, created_by || employee_id || 1, salespersonId, branch_id || null, subtotal, tax_amount, disc, total, 'hold', 'hold', notes || null, promotion_code || null, promotion_name || null, disc > 0 ? discountSource : null, disc > 0 ? ticketPct : null, String(req.body.po_number || '').trim() || null]
      });
      const txId = Number(result.lastInsertRowid);
      for (const [i, item] of items.entries()) {
        const lineTotal = lineTotals[i], lineTax = lineTaxes[i];
        const serial = item.serial_number ? String(item.serial_number).trim() : null;
        // A held line keeps its unit of measure (and its size at hold time).
        let sellUnit = null, unitsPer = 1, uomId = null;
        const requested = item.uom_id ?? item.sell_unit;
        if (requested != null && requested !== '' && item.product_id && !item.variation_id) {
          const { rows: [prod] } = await txn.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] });
          if (prod) ({ sell_unit: sellUnit, units_per: unitsPer, uom_id: uomId } = await resolveUnit(txn, prod, requested));
        }
        await txn.execute({
          sql: `INSERT INTO transaction_items (transaction_id,product_id,product_name,sku,quantity,unit_price,discount_amount,tax_amount,total,variation_id,variation_name,serial_number,sell_unit,units_per,uom_id,is_comment,is_delivery,discount_percent,discount_override_by,discount_fixed) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          args: [txId, item.product_id || null, serial ? serialNumberLabel(serial) : item.product_name, item.sku || '', item.is_comment && !item.product_id ? 1 : item.quantity, parseFloat(item.unit_price) || 0, lineDisc[i], lineTax, lineTotal, item.variation_id || null, item.variation_name || null, serial || null, sellUnit, unitsPer, uomId, item.is_comment && !item.product_id ? 1 : 0, item.is_delivery && !item.product_id ? 1 : 0, linePct[i], linePct[i] > 0 ? (item.discount_override_employee_id || null) : null, lineFixed[i] && linePct[i] > 0 ? lineFixed[i] : null]
        });
      }
      await txn.commit();
      committed = true;
      const { rows: [savedTx] } = await db.execute({ sql: `SELECT t.*, c.first_name || ' ' || c.last_name as customer_name FROM transactions t LEFT JOIN customers c ON t.customer_id = c.id WHERE t.id = ?`, args: [txId] });
      const { rows: savedItems } = await db.execute({ sql: 'SELECT * FROM transaction_items WHERE transaction_id = ?', args: [txId] });
      savedTx.items = savedItems;
      res.status(201).json(savedTx);
    } catch(e) {
      // Once committed, the hold is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await txn.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Cancel / delete a held order
router.delete('/:id/hold', requirePermission('pos_hold'), async (req, res) => {
  try {
    const { rows: [held] } = await db.execute({ sql: `SELECT id FROM transactions WHERE id = ? AND status = 'hold'`, args: [req.params.id] });
    if (!held) return res.status(404).json({ error: 'Held order not found' });
    // A hold created by converting a quotation points quotations.converted_to_tx
    // back at it — if the hold is cancelled instead of recalled and finalized,
    // revert the quote so it isn't left stranded pointing at a deleted transaction.
    await db.execute({ sql: `UPDATE quotations SET status = 'accepted', converted_to_tx = NULL WHERE converted_to_tx = ?`, args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM transaction_items WHERE transaction_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM transactions WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Listing held tickets (?status=hold) is POS Hold Recall and its badge, so
// Hold & Recall (pos_hold) is enough for that; any other listing needs the
// Transactions module.
const requireTransactionsList = (req, res, next) => req.query.status === 'hold'
  ? requireAnyPermission('transactions', 'pos_hold')(req, res, next)
  : requirePermission('transactions')(req, res, next);

router.get('/', requireTransactionsList, async (req, res) => {
  try {
    const { start, end, customer_id, customer_name, status, branch_id, payment_method, transaction_number, source, fulfillment_status, employee_id, credited_id, limit = 100 } = req.query;
    let sql = `SELECT t.*, c.first_name || ' ' || c.last_name as customer_name, e.first_name || ' ' || e.last_name as employee_name, b.name as branch_name,
      ${CREDITED_SQL} as credited_id, ce.first_name || ' ' || ce.last_name as credited_name,
      ra.agreement_number as rental_agreement_number, q.quote_number as source_quote_number,
      CASE WHEN ra.checkout_transaction_id = t.id THEN 'checkout' WHEN ra.settlement_transaction_id = t.id THEN 'settlement' END as rental_role,
      wo.wo_number as work_order_number,
      CASE WHEN wo.assessment_transaction_id = t.id THEN 'assessment' WHEN wo.deposit_transaction_id = t.id THEN 'deposit' WHEN wo.final_transaction_id = t.id THEN 'final' END as wo_role,
      (SELECT COUNT(*) FROM returns rt WHERE rt.original_transaction_id = t.id) as return_count
      FROM transactions t LEFT JOIN customers c ON t.customer_id = c.id LEFT JOIN employees e ON t.employee_id = e.id LEFT JOIN branches b ON t.branch_id = b.id
      LEFT JOIN employees ce ON ce.id = ${CREDITED_SQL}
      LEFT JOIN rental_agreements ra ON ra.checkout_transaction_id = t.id OR ra.settlement_transaction_id = t.id
      LEFT JOIN quotations q ON q.converted_to_tx = t.id
      LEFT JOIN work_orders wo ON wo.assessment_transaction_id = t.id OR wo.deposit_transaction_id = t.id OR wo.final_transaction_id = t.id
      WHERE 1=1`;
    const params = [];
    if (transaction_number) { sql += ' AND t.transaction_number LIKE ?'; params.push(`%${transaction_number}%`); }
    if (start) { sql += ' AND date(t.created_at) >= date(?)'; params.push(start); }
    if (end) { sql += ' AND date(t.created_at) <= date(?)'; params.push(end); }
    if (customer_id) { sql += ' AND t.customer_id = ?'; params.push(customer_id); }
    if (customer_name) { sql += " AND (c.first_name || ' ' || c.last_name) LIKE ?"; params.push(`%${customer_name}%`); }
    if (status) { sql += ' AND t.status = ?'; params.push(status); }
    if (branch_id) { sql += ' AND t.branch_id = ?'; params.push(branch_id); }
    if (payment_method) { sql += ' AND t.payment_method = ?'; params.push(payment_method); }
    if (fulfillment_status) { sql += ' AND t.fulfillment_status = ?'; params.push(fulfillment_status); }
    if (employee_id) { sql += ' AND t.employee_id = ?'; params.push(Number(employee_id)); }
    if (credited_id) { sql += ` AND ${CREDITED_SQL} = ?`; params.push(Number(credited_id)); }
    if (source === 'online') { sql += " AND t.source IN ('online','woocommerce')"; }
    else if (source) { sql += ' AND t.source = ?'; params.push(source); }
    // A salesperson-flagged employee only ever sees their own sales here,
    // regardless of what filters the client sent — see is_salesperson
    // migration note in database.js. That includes sales credited to them
    // that someone else rang up.
    if (req.employee?.is_salesperson) { sql += ` AND (t.employee_id = ? OR ${CREDITED_SQL} = ?)`; params.push(req.employee.id, req.employee.id); }
    sql += ' ORDER BY t.created_at DESC LIMIT ?';
    params.push(parseInt(limit));
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Returns list for the Transactions screen's "Returns" view — each opens its
// Exchange (resolution 'replacement') returns whose credit hasn't been spent
// yet — the credit is spent by the one non-voided sale carrying the return as
// source_return_id. Until then it waits in POS Hold Recall for any cashier,
// so a return processed by someone without POS access (or a browser that
// closed before the replacement was rung up) isn't lost. Must stay above
// GET /:id, like /returns below.
const EXCHANGE_SPENT_SQL = `EXISTS (SELECT 1 FROM transactions st WHERE st.source_return_id = r.id AND st.status != 'voided')`;
router.get('/pending-exchanges', requirePermission('pos'), async (req, res) => {
  try {
    const { customer_id } = req.query;
    let sql = `SELECT r.id, r.return_number, r.created_at, r.total, r.customer_id, r.branch_id, r.notes,
      t.transaction_number as original_transaction_number,
      c.first_name || ' ' || c.last_name as customer_name, e.first_name || ' ' || e.last_name as employee_name, b.name as branch_name,
      (SELECT GROUP_CONCAT(ri.product_name, ', ') FROM return_items ri WHERE ri.return_id = r.id) as item_names
      FROM returns r
      LEFT JOIN transactions t ON r.original_transaction_id = t.id
      LEFT JOIN customers c ON r.customer_id = c.id
      LEFT JOIN employees e ON r.employee_id = e.id
      LEFT JOIN branches b ON r.branch_id = b.id
      WHERE r.resolution = 'replacement' AND r.status != 'cancelled' AND NOT ${EXCHANGE_SPENT_SQL}`;
    const args = [];
    if (customer_id) { sql += ' AND r.customer_id = ?'; args.push(customer_id); }
    sql += ' ORDER BY r.created_at DESC LIMIT 100';
    const { rows } = await db.execute({ sql, args });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// The exchange credit a sale may use from source_return_id, or an error
// message: the return must be an uncancelled exchange whose credit no other
// sale has spent, for the same customer. Checked before the sale and again
// inside its write transaction so two tills can't spend it twice.
async function exchangeCreditError(conn, returnId, customerId) {
  const { rows: [ret] } = await conn.execute({
    sql: `SELECT r.id, r.return_number, r.resolution, r.status, r.customer_id, r.total, ${EXCHANGE_SPENT_SQL} as spent FROM returns r WHERE r.id = ?`,
    args: [returnId],
  });
  if (!ret) return { error: 'That return credit no longer exists' };
  if (ret.resolution !== 'replacement') return { error: `Return ${ret.return_number} wasn't processed as an exchange, so it has no credit to apply` };
  if (ret.status === 'cancelled') return { error: `Return ${ret.return_number} was cancelled` };
  if (ret.spent) return { error: `The credit from return ${ret.return_number} has already been used on another sale` };
  if (ret.customer_id && Number(ret.customer_id) !== Number(customerId)) return { error: `The credit from return ${ret.return_number} belongs to another customer — select that customer on the ticket` };
  return { ret };
}

// return receipt (GET /returns/:id) to reprint or email. Same date/branch/
// customer filters as the sales list, plus the return or original sale
// number; a salesperson only sees returns of sales that are theirs. Must
// stay above GET /:id, which would otherwise take "returns" as an id.
router.get('/returns', requirePermission('transactions'), async (req, res) => {
  try {
    const { start, end, branch_id, customer_name, number, resolution, limit = 200 } = req.query;
    let sql = `SELECT r.id, r.return_number, r.created_at, r.resolution, r.subtotal, r.tax_amount, r.total, r.notes,
      t.id as original_transaction_id, t.transaction_number as original_transaction_number,
      c.first_name || ' ' || c.last_name as customer_name, e.first_name || ' ' || e.last_name as employee_name, b.name as branch_name,
      oe.first_name || ' ' || oe.last_name as override_by_name,
      (SELECT COALESCE(SUM(ri.quantity), 0) FROM return_items ri WHERE ri.return_id = r.id) as item_count
      FROM returns r
      LEFT JOIN transactions t ON r.original_transaction_id = t.id
      LEFT JOIN customers c ON r.customer_id = c.id
      LEFT JOIN employees e ON r.employee_id = e.id
      LEFT JOIN employees oe ON r.override_by = oe.id
      LEFT JOIN branches b ON r.branch_id = b.id
      WHERE 1=1`;
    const args = [];
    if (start) { sql += ' AND date(r.created_at) >= date(?)'; args.push(start); }
    if (end) { sql += ' AND date(r.created_at) <= date(?)'; args.push(end); }
    if (branch_id) { sql += ' AND r.branch_id = ?'; args.push(branch_id); }
    if (resolution) { sql += ' AND r.resolution = ?'; args.push(resolution); }
    if (customer_name) { sql += " AND (c.first_name || ' ' || c.last_name) LIKE ?"; args.push(`%${customer_name}%`); }
    if (number) { sql += ' AND (r.return_number LIKE ? OR t.transaction_number LIKE ?)'; args.push(`%${number}%`, `%${number}%`); }
    if (req.employee?.is_salesperson) { sql += ` AND (t.employee_id = ? OR ${CREDITED_SQL} = ?)`; args.push(req.employee.id, req.employee.id); }
    sql += ' ORDER BY r.created_at DESC LIMIT ?';
    args.push(parseInt(limit) || 200);
    const { rows } = await db.execute({ sql, args });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Customer account payments received (POS Receive Payment) for the
// Transactions screen's "Customer Payments" view — money taken in, so
// write-offs and legacy credit notes (also account_payments rows) are left
// out. applied_to lists the invoices each payment went to (credit sales and
// legacy invoices); unapplied is what's still on account. Same date/branch/
// customer filters as the sales list; a salesperson only sees payments they
// took. Must stay above GET /:id.
router.get('/customer-payments', requirePermission('transactions'), async (req, res) => {
  try {
    const { start, end, branch_id, customer_name, number, payment_method, limit = 200 } = req.query;
    let sql = `SELECT p.id, p.payment_number, p.created_at, p.amount, p.payment_method, p.payment_mode, p.reference, p.notes, p.customer_id,
      ${UNAPPLIED_SQL.replace(/\bap\./g, 'p.')} AS unapplied,
      c.first_name || ' ' || c.last_name as customer_name, c.customer_number,
      e.first_name || ' ' || e.last_name as employee_name, b.name as branch_name,
      (SELECT GROUP_CONCAT(x.num, ', ') FROM (
        SELECT t.transaction_number AS num FROM payment_allocations pa JOIN transactions t ON t.id = pa.transaction_id WHERE pa.payment_id = p.id
        UNION ALL
        SELECT li.invoice_number FROM legacy_invoice_allocations lia JOIN ar_legacy_invoices li ON li.id = lia.legacy_invoice_id WHERE lia.payment_id = p.id
      ) x) AS applied_to
      FROM account_payments p
      LEFT JOIN customers c ON p.customer_id = c.id
      LEFT JOIN employees e ON p.employee_id = e.id
      LEFT JOIN branches b ON p.branch_id = b.id
      WHERE p.payment_method NOT IN ('writeoff', 'credit_note')`;
    const args = [];
    if (start) { sql += ' AND date(p.created_at) >= date(?)'; args.push(start); }
    if (end) { sql += ' AND date(p.created_at) <= date(?)'; args.push(end); }
    if (branch_id) { sql += ' AND p.branch_id = ?'; args.push(branch_id); }
    if (payment_method) { sql += ' AND p.payment_method = ?'; args.push(payment_method); }
    if (customer_name) { sql += " AND ((c.first_name || ' ' || c.last_name) LIKE ? OR c.customer_number LIKE ?)"; args.push(`%${customer_name}%`, `%${customer_name}%`); }
    if (number) { sql += ' AND (p.payment_number LIKE ? OR p.reference LIKE ?)'; args.push(`%${number}%`, `%${number}%`); }
    if (req.employee?.is_salesperson) { sql += ' AND p.employee_id = ?'; args.push(req.employee.id); }
    sql += ' ORDER BY p.created_at DESC LIMIT ?';
    args.push(parseInt(limit) || 200);
    const { rows } = await db.execute({ sql, args });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// requireAuth only — used broadly (POS hold-recall, receipt printing,
// returns flow, online orders), not just the Transactions detail view.
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows: [tx] } = await db.execute({ sql: `SELECT t.*, c.first_name || ' ' || c.last_name as customer_name, c.customer_number, c.email as customer_email, c.phone as customer_phone, c.address as customer_address, c.city as customer_city, c.state as customer_state, c.zip as customer_zip, e.first_name || ' ' || e.last_name as employee_name, cbe.first_name || ' ' || cbe.last_name as created_by_name, spe.first_name || ' ' || spe.last_name as salesperson_name, ${CREDITED_SQL} as credited_id, ce.first_name || ' ' || ce.last_name as credited_name, b.name as branch_name, b.address as branch_address, b.city as branch_city, b.state as branch_state, b.zip as branch_zip, b.phone as branch_phone, q.id as source_quote_id, q.quote_number as source_quote_number, qe.first_name || ' ' || qe.last_name as quote_created_by, r.return_number as source_return_number, sh.carrier as shipment_carrier, sh.tracking_number as shipment_tracking_number, sh.status as shipment_status, sh.ship_date as shipment_ship_date, sh.estimated_delivery as shipment_estimated_delivery,
      ve.first_name || ' ' || ve.last_name as voided_by_name,
      ra.id as rental_agreement_id, ra.agreement_number as rental_agreement_number, ra.status as rental_status, ra.quotation_id as rental_quotation_id,
      ra.checkout_datetime as rental_checkout_datetime, ra.due_date as rental_due_date, ra.returned_at as rental_returned_at,
      ra.deposit_total as rental_deposit_total, ra.deposit_refunded as rental_deposit_refunded,
      ra.duration_adjustment_total as rental_duration_adjustment_total, ra.damage_fee_total as rental_damage_fee_total,
      ra.customer_po_number as rental_po_number,
      CASE WHEN ra.checkout_transaction_id = t.id THEN 'checkout' WHEN ra.settlement_transaction_id = t.id THEN 'settlement' END as rental_role,
      wo.id as work_order_id, wo.wo_number as work_order_number, wo.status as work_order_status,
      CASE WHEN wo.assessment_transaction_id = t.id THEN 'assessment' WHEN wo.deposit_transaction_id = t.id THEN 'deposit' WHEN wo.final_transaction_id = t.id THEN 'final' END as wo_role
      FROM transactions t LEFT JOIN customers c ON t.customer_id = c.id LEFT JOIN employees e ON t.employee_id = e.id LEFT JOIN branches b ON t.branch_id = b.id LEFT JOIN quotations q ON q.converted_to_tx = t.id LEFT JOIN employees qe ON q.employee_id = qe.id LEFT JOIN returns r ON t.source_return_id = r.id LEFT JOIN shipments sh ON sh.transaction_id = t.id
      LEFT JOIN employees ve ON t.voided_by = ve.id
      LEFT JOIN employees cbe ON cbe.id = COALESCE(t.created_by, t.employee_id) LEFT JOIN employees spe ON spe.id = t.salesperson_id
      LEFT JOIN employees ce ON ce.id = ${CREDITED_SQL}
      LEFT JOIN rental_agreements ra ON ra.checkout_transaction_id = t.id OR ra.settlement_transaction_id = t.id
      LEFT JOIN work_orders wo ON wo.assessment_transaction_id = t.id OR wo.deposit_transaction_id = t.id OR wo.final_transaction_id = t.id
      WHERE t.id = ?`, args: [req.params.id] });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    const { rows: items } = await db.execute({ sql: `SELECT ti.*, oe.first_name || ' ' || oe.last_name AS discount_override_name FROM transaction_items ti LEFT JOIN employees oe ON oe.id = ti.discount_override_by WHERE ti.transaction_id = ? ORDER BY ti.id`, args: [req.params.id] });
    tx.items = items;
    const { rows: payments } = await db.execute({ sql: 'SELECT * FROM transaction_payments WHERE transaction_id = ? ORDER BY id', args: [req.params.id] });
    tx.payments = payments;
    const isSpRentalLine = await spRentalLineMatcher(req.params.id);
    for (const item of items) if (isSpRentalLine(item)) item.is_sp_rental = 1;
    // Each line's share of the ticket discount — the return screen takes it
    // off the refund the same way POST /:id/return does.
    for (const item of items) item.discount_share = returnedDiscountShare(tx, item, items, 1);
    // Returns made against this sale, for the detail window's "Returns on
    // this sale" list (each opens its return receipt).
    const { rows: returns } = await db.execute({ sql: 'SELECT id, return_number, created_at, resolution, total FROM returns WHERE original_transaction_id = ? ORDER BY created_at', args: [req.params.id] });
    tx.returns = returns;
    // Pause history is agreement-level, not tied to which transaction (checkout
    // vs settlement) this is — shown on either printed invoice for the same rental.
    if (tx.rental_agreement_id) {
      const { rows: pauses } = await db.execute({ sql: 'SELECT reason, notes, started_at, ended_at FROM rental_agreement_pauses WHERE agreement_id = ? ORDER BY id', args: [tx.rental_agreement_id] });
      tx.rental_pauses = pauses;
    }
    const { rows: spChanges } = await db.execute({ sql: `SELECT sc.*, o.first_name || ' ' || o.last_name AS old_name, n.first_name || ' ' || n.last_name AS new_name, cb.first_name || ' ' || cb.last_name AS changed_by_name
      FROM salesperson_changes sc LEFT JOIN employees o ON o.id = sc.old_salesperson_id LEFT JOIN employees n ON n.id = sc.new_salesperson_id LEFT JOIN employees cb ON cb.id = sc.changed_by
      WHERE sc.transaction_id = ? ORDER BY sc.changed_at, sc.id`, args: [req.params.id] });
    tx.salesperson_changes = spChanges;
    res.json(tx);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Change who one or more past sales are credited to (sales targets) — the
// Transactions "Change Salesperson" action and its bulk version. salesperson_id
// null clears the pick, so the sale goes back to whoever started it, else the
// cashier. Every sale changed is logged in salesperson_changes.
router.patch('/salesperson', requirePermission('sales_manager'), async (req, res) => {
  try {
    const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger))];
    if (!ids.length) return res.status(400).json({ error: 'Choose at least one sale' });
    if (ids.length > 500) return res.status(400).json({ error: 'Change at most 500 sales at a time' });
    let newId;
    try { newId = await resolveSalesperson(req.body.salesperson_id); } catch (e) { return res.status(400).json({ error: e.message }); }
    const reason = String(req.body.reason || '').trim().slice(0, 500) || null;
    const { rows } = await db.execute({ sql: `SELECT t.id, t.transaction_number, t.status, t.salesperson_id, ${CREDITED_SQL} AS credited_id, COALESCE(t.created_by, t.employee_id) AS fallback_id FROM transactions t WHERE t.id IN (${ids.map(() => '?').join(',')})`, args: ids });
    if (rows.length !== ids.length) return res.status(404).json({ error: 'Some of those sales were not found — reload and try again' });
    const notSales = rows.filter(r => r.status === 'hold' || r.status === 'voided');
    if (notSales.length) return res.status(400).json({ error: `Only completed sales can be credited — ${notSales.map(r => r.transaction_number).join(', ')} ${notSales.length === 1 ? 'is' : 'are'} held or voided` });
    const stmts = [];
    let changed = 0;
    const moved = [];
    for (const r of rows) {
      const after = newId || r.fallback_id;
      if ((r.salesperson_id ?? null) === newId) continue;
      stmts.push({ sql: 'UPDATE transactions SET salesperson_id = ? WHERE id = ?', args: [newId, r.id] });
      stmts.push({ sql: 'INSERT INTO salesperson_changes (transaction_id, old_salesperson_id, new_salesperson_id, changed_by, reason) VALUES (?,?,?,?,?)', args: [r.id, r.credited_id, after, req.employee?.id || null, reason] });
      if (Number(after) !== Number(r.credited_id)) moved.push({ ...r, after });
      changed++;
    }
    if (stmts.length) await db.batch(stmts, 'write');
    const commission = await moveSaleCommissions(moved);
    res.json({ success: true, changed, unchanged: rows.length - changed, ...commission });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requirePermission('pos'), async (req, res) => {
  try {
    const { customer_id, employee_id, created_by, drawer_session_id, items, discount_amount, promotion_code, promotion_name, payment_method, amount_tendered, notes, source_return_id, store_credit_applied, cash_back_applied, quote_id, tax_exempt, tax_exemption_number, approval_code, tenders } = req.body;
    let { branch_id } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items in transaction' });
    let salespersonId;

    // For API-authenticated (online) orders with no branch, use the ecommerce sync branch
    if (!branch_id && req.apiKey) {
      const { rows: [setting] } = await db.execute({ sql: "SELECT value FROM settings WHERE key='woo_sync_branch_id'", args: [] });
      if (setting?.value) branch_id = setting.value;
    }

    const transaction_number = await nextNumber(db, 'transactions', 'transaction_number', 'TXN-', 6);

    // Ticket creator for the receipt: whoever started a recalled hold (sent by
    // the POS), else the quote's original salesperson, else the cashier.
    let createdBy = created_by || null;
    // Customer P.O. # for the invoice — the cashier's, else the quote's.
    let poNumber = String(req.body.po_number || '').trim() || null;
    if ((!createdBy || !poNumber) && quote_id) {
      const { rows: [q] } = await db.execute({ sql: 'SELECT employee_id, original_employee_id, po_number FROM quotations WHERE id = ?', args: [quote_id] });
      if (!createdBy) createdBy = q?.original_employee_id || q?.employee_id || null;
      if (!poNumber) poNumber = q?.po_number || null;
    }
    createdBy = createdBy || employee_id || 1;
    try { salespersonId = await ticketSalesperson(createdBy, req.body.salesperson_id); } catch (e) { return res.status(400).json({ error: e.message }); }

    // Store-wide cap for a manual per-line discount (see the POS "Discount"
    // action on a cart line) — the same Maximum Discount (max_discount_pct)
    // setting that caps the whole-ticket discount; 0/unset means no limit.
    const { rows: [maxDiscSetting] } = await db.execute({ sql: "SELECT value FROM settings WHERE key = 'max_discount_pct'", args: [] });
    const maxLineDiscountPercent = parseFloat(maxDiscSetting?.value) || 0;

    const isTaxExempt = tax_exempt ? 1 : 0;
    const { rows: [taxRateSetting] } = await db.execute({ sql: "SELECT value FROM settings WHERE key = 'tax_rate'", args: [] });
    const storeTaxRate = parseFloat(taxRateSetting?.value) || 0;
    let subtotal = 0, tax_amount = 0;
    const processedItems = [];
    for (const item of items) {
      // Custom/temp line item — no catalog product backs it (e.g. a Special
      // Project's free-typed labour/equipment line, carried through from a
      // converted quotation's is_temp_item row — see processQuoteItems() in
      // routes/quotations.js, which trusts a temp item's price the same
      // way). No stock to deduct and no discount-eligibility to check;
      // price/tax are exactly what was already negotiated/approved, so
      // they're trusted from the client instead of re-derived from a
      // product row that doesn't exist.
      // "C" (comment) line — free text that prints on the receipt/invoice,
      // nothing else: no price, tax, stock or discount share.
      if (!item.product_id && item.is_comment) {
        const text = String(item.product_name || '').trim();
        if (!text) continue;
        processedItems.push({ product: null, variation: null, customName: text, isComment: 1, quantity: 1, unit_price: 0, lineTotal: 0, lineTax: 0, taxRate: 0, discount: 0, discountPercent: 0, discountOverrideBy: null });
        continue;
      }
      // Delivery line (POS Delivery button, or a quote's delivery line):
      // description + pre-tax price, always taxed at the store rate.
      if (!item.product_id && item.is_delivery) {
        const product_name = String(item.product_name || '').trim() || 'Delivery';
        const unit_price = parseFloat(item.unit_price);
        if (!(unit_price >= 0)) throw new Error(`Enter a price for the delivery line "${product_name}"`);
        const lineTotal = parseFloat(unit_price.toFixed(2));
        const lineTax = isTaxExempt ? 0 : parseFloat((lineTotal * storeTaxRate / 100).toFixed(2));
        subtotal += lineTotal;
        tax_amount += lineTax;
        processedItems.push({ product: null, variation: null, customName: product_name, isDelivery: 1, quantity: 1, unit_price: lineTotal, lineTotal, lineTax, taxRate: storeTaxRate, discount: 0, discountPercent: 0, discountOverrideBy: null });
        continue;
      }
      if (!item.product_id) {
        const product_name = (item.product_name || '').trim();
        if (!product_name) throw new Error('A custom line item needs a name');
        const quantity = parseInt(item.quantity) || 1;
        const unit_price = parseFloat(item.unit_price) || 0;
        const grossLineTotal = parseFloat((unit_price * quantity).toFixed(2));
        const lineTax = isTaxExempt ? 0 : parseFloat((grossLineTotal * (parseFloat(item.tax_rate) || 0) / 100).toFixed(2));
        subtotal += grossLineTotal;
        tax_amount += lineTax;
        processedItems.push({ product: null, variation: null, customName: product_name, quantity, unit_price, lineTotal: grossLineTotal, lineTax, taxRate: parseFloat(item.tax_rate) || 0, discount: 0, discountPercent: 0, discountOverrideBy: null });
        continue;
      }
      const { rows: [product] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] });
      if (!product) throw new Error(`Product ${item.product_id} not found`);
      // SN line: always its own qty-1 row carrying the serial, no stock.
      // Blank serial → dropped, not refused (serials are optional).
      if (isSerialNumberProduct(product)) {
        const serialNumber = serialNumberOf(item);
        if (!serialNumber) continue;
        const clash = await serialClashError(db, serialNumber);
        if (clash) throw new Error(clash);
        const unit_price = product.price || 0;
        const lineTax = isTaxExempt ? 0 : parseFloat((unit_price * product.tax_rate / 100).toFixed(2));
        subtotal += unit_price;
        tax_amount += lineTax;
        processedItems.push({ product, variation: null, serialNumber, quantity: 1, unit_price, lineTotal: unit_price, lineTax, taxRate: product.tax_rate || 0, discount: 0, discountPercent: 0, discountOverrideBy: null });
        continue;
      }
      // Unit of measure (lib/units.js): the unit's price, and quantity × its
      // size in stock units off stock. Never on a variation.
      const unit = await resolveUnit(db, product, item.variation_id ? null : (item.uom_id ?? item.sell_unit));
      let variation = null, unit_price = unit.price;
      const lineQty = parseQty(item.quantity, unit.allow_decimal);
      if (Number.isNaN(lineQty)) throw new Error(unit.allow_decimal ? `Enter a quantity above 0 for ${product.name}` : `${product.name} is sold in whole ${unit.sell_unit || 'unit'}s — the quantity can't be ${item.quantity}`);
      item.quantity = lineQty;
      if (item.variation_id) {
        const { rows: [v] } = await db.execute({ sql: 'SELECT * FROM product_variations WHERE id = ? AND product_id = ?', args: [item.variation_id, item.product_id] });
        if (!v) throw new Error(`Variation ${item.variation_id} not found`);
        variation = v;
        unit_price = v.price != null ? v.price : parseFloat((product.price + (v.price_modifier || 0)).toFixed(2));
      }
      const grossLineTotal = parseFloat((unit_price * item.quantity).toFixed(2));

      // Manual per-line discount — re-validated here (not just trusted from
      // the POS UI's own check) so a bypassed client can't apply one to an
      // ineligible item or skip the manager override past the store limit.
      // A "$" discount (discount_fixed, off the whole line) goes through the
      // same checks as its equivalent percentage.
      const discountFixed = Math.min(grossLineTotal, Math.max(0, parseFloat(item.discount_fixed) || 0)) || null;
      const discountPercent = discountFixed ? (grossLineTotal > 0 ? parseFloat((discountFixed / grossLineTotal * 100).toFixed(4)) : 0) : parseFloat(item.discount_percent) || 0;
      let discountAmount = 0, discountOverrideBy = null;
      if (discountPercent > 0) {
        if (discountPercent > 100) throw new Error(`Invalid discount percentage for ${product.name}`);
        const eligibility = await checkDiscountEligibility(product);
        if (!eligibility.eligible) {
          throw new Error(eligibility.reason === 'brand_excluded'
            ? `${product.name} (${product.brand}) is on the discount-exclusion list and can't be manually discounted`
            : `${product.name} is already on a promotion and can't also get a manual discount`);
        }
        if (maxLineDiscountPercent > 0 && discountPercent > maxLineDiscountPercent) {
          if (!item.discount_override_employee_id) {
            throw new Error(`A ${discountFixed ? `$${discountFixed.toFixed(2)} (${discountPercent.toFixed(2)}%)` : `${discountPercent}%`} discount on ${product.name} exceeds the store limit of ${maxLineDiscountPercent}% — manager override required`);
          }
          const { rows: [overrider] } = await db.execute({ sql: 'SELECT sg.permissions FROM employees e LEFT JOIN security_groups sg ON e.security_group_id = sg.id WHERE e.id = ? AND e.active = 1', args: [item.discount_override_employee_id] });
          let authorized = false;
          try { authorized = overrider && can(JSON.parse(overrider.permissions || '{}'), 'pos_discount_override'); } catch { authorized = false; }
          if (!authorized) throw new Error(`The employee authorizing the discount override on ${product.name} doesn't have override privileges`);
          discountOverrideBy = item.discount_override_employee_id;
        }
        discountAmount = discountFixed ? parseFloat(discountFixed.toFixed(2)) : parseFloat((grossLineTotal * discountPercent / 100).toFixed(2));
      }

      const lineTotal = parseFloat((grossLineTotal - discountAmount).toFixed(2));
      const lineTax = isTaxExempt ? 0 : parseFloat((lineTotal * product.tax_rate / 100).toFixed(2));
      subtotal += lineTotal;
      tax_amount += lineTax;
      processedItems.push({ product, variation, unit, quantity: item.quantity, unit_price, lineTotal, lineTax, taxRate: product.tax_rate || 0, discount: discountAmount, discountPercent, discountOverrideBy, discountFixed: discountPercent > 0 ? discountFixed : null });
    }

    if (!processedItems.some(p => !p.isComment)) return res.status(400).json({ error: 'No items in transaction' });
    subtotal = parseFloat(subtotal.toFixed(2));
    // The ticket discount comes off before tax (lib/ticketDiscount.js) —
    // each line is re-taxed on its net less its share. A return credit on an
    // exchange is money already paid, tax included, so it stays after tax.
    const discountPreTax = source_return_id ? 0 : 1;
    let disc = parseFloat(discount_amount || 0);
    if (discountPreTax) {
      const split = allocateTicketDiscount(processedItems.map(p => p.lineTotal), disc);
      disc = split.discount;
      tax_amount = 0;
      processedItems.forEach((p, i) => {
        p.ticketDiscount = split.shares[i];
        p.lineTax = isTaxExempt ? 0 : parseFloat(((p.lineTotal - p.ticketDiscount) * p.taxRate / 100).toFixed(2));
        tax_amount += p.lineTax;
      });
    }
    tax_amount = parseFloat(tax_amount.toFixed(2));
    // An exchange's return credit rides in as the (after-tax) discount —
    // only from a pending exchange return, and never more than it's worth.
    if (source_return_id) {
      const { error, ret } = await exchangeCreditError(db, source_return_id, customer_id);
      if (error) return res.status(400).json({ error });
      disc = Math.min(disc, parseFloat(ret.total));
    }
    const storeCredit = parseFloat(store_credit_applied || 0);

    // Server-side clamp against the customer's actual eligibility right now
    // — see computeAvailableCashBack() above.
    let cashBack = parseFloat(cash_back_applied || 0);
    let cashBackCard = null;
    if (cashBack > 0 && customer_id) {
      const { rows: [row] } = await db.execute({
        sql: `SELECT c.loyalty_points, c.cash_back_last_redeemed_at, cbct.points_threshold, cbct.reward_amount, cbct.min_redeem_amount, cbct.min_redeem_days, cbct.active
              FROM customers c LEFT JOIN cash_back_card_types cbct ON c.cash_back_card_type_id = cbct.id WHERE c.id = ?`,
        args: [customer_id],
      });
      cashBackCard = row;
      cashBack = Math.min(cashBack, computeAvailableCashBack(row));
    } else {
      cashBack = 0;
    }

    const total = parseFloat((subtotal - disc + tax_amount - storeCredit - cashBack).toFixed(2));

    // Split tender: an optional array of {method, amount, approval_code} legs
    // that together cover the total, instead of a single payment_method.
    // Charge Account is deliberately not allowed as a leg — it has its own
    // AR side effects (account_balance, credit checks) that assume the whole
    // transaction total, not a partial amount.
    let tenderLegs = null;
    if (tenders && tenders.length) {
      if (tenders.some(leg => leg.method === 'credit')) return res.status(400).json({ error: 'Charge Account cannot be combined with other payment methods in a split payment' });
      const legSum = parseFloat(tenders.reduce((sum, leg) => sum + parseFloat(leg.amount || 0), 0).toFixed(2));
      if (Math.abs(legSum - total) > 0.01) return res.status(400).json({ error: `Split tender amounts (${legSum.toFixed(2)}) don't match the total (${total.toFixed(2)})` });
      tenderLegs = tenders.map(leg => ({ payment_method: leg.method, amount: parseFloat(leg.amount || 0), approval_code: leg.approval_code || null }));
    }

    const method = tenderLegs ? (tenderLegs.length > 1 ? 'split' : tenderLegs[0].payment_method) : (payment_method || 'cash');
    const isCredit = method === 'credit';

    if (isCredit && customer_id) {
      const { rows: [cust] } = await db.execute({ sql: 'SELECT customer_type, account_blocked, block_override, block_override_reason, credit_limit, account_balance FROM customers WHERE id = ?', args: [customer_id] });
      if (!cust) return res.status(400).json({ error: 'Customer not found' });
      if (cust.customer_type !== 'credit') return res.status(400).json({ error: 'Customer does not have a credit account' });
      if (cust.account_blocked) return res.status(400).json({ error: blockedMessage(cust) });
      const limitError = creditLimitError(cust, total);
      if (limitError) return res.status(400).json({ error: limitError });
    }

    const tendered = tenderLegs ? total : parseFloat(amount_tendered || (isCredit ? 0 : total));
    const change = tenderLegs ? 0 : (isCredit ? 0 : parseFloat((tendered - total).toFixed(2)));
    const finalApprovalCode = tenderLegs ? (tenderLegs.length === 1 ? tenderLegs[0].approval_code : null) : (approval_code || null);

    const tx = await db.transaction('write');
    let committed = false;
    try {
      if (source_return_id) {
        const { error } = await exchangeCreditError(tx, source_return_id, customer_id);
        if (error) throw new Error(error);
      }
      const txSource = req.apiKey ? 'online' : 'pos';
      const txResult = await tx.execute({ sql: `INSERT INTO transactions (transaction_number,customer_id,employee_id,created_by,salesperson_id,branch_id,drawer_session_id,subtotal,tax_amount,discount_amount,promotion_code,promotion_name,total,payment_method,amount_tendered,change_amount,is_credit,notes,source_return_id,store_credit_applied,cash_back_applied,tax_exempt,tax_exemption_number,approval_code,source,discount_pre_tax,po_number) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [transaction_number, customer_id || null, employee_id || 1, createdBy, salespersonId, branch_id || null, drawer_session_id || null, subtotal, tax_amount, disc, promotion_code || null, promotion_name || null, total, method, tendered, change > 0 ? change : 0, isCredit ? 1 : 0, notes || null, source_return_id || null, storeCredit > 0 ? storeCredit : 0, cashBack > 0 ? cashBack : 0, isTaxExempt, tax_exemption_number || null, finalApprovalCode, txSource, discountPreTax, poNumber] });
      const txId = Number(txResult.lastInsertRowid);

      const paymentLegs = tenderLegs || [{ payment_method: method, amount: total, approval_code: finalApprovalCode }];
      for (const leg of paymentLegs) {
        await tx.execute({ sql: 'INSERT INTO transaction_payments (transaction_id, payment_method, amount, approval_code) VALUES (?,?,?,?)', args: [txId, leg.payment_method, leg.amount, leg.approval_code || null] });
      }

      for (const { product, variation, unit, customName, isComment, isDelivery, serialNumber, quantity: lineQty, unit_price, lineTotal, lineTax, ticketDiscount, discount, discountPercent, discountOverrideBy, discountFixed } of processedItems) {
        const itemName = customName || (serialNumber ? serialNumberLabel(serialNumber) : variation ? `${product.name} — ${variation.name}` : lineName(product.name, unit));
        const itemSku = customName ? '' : (variation ? variation.sku : product.sku);
        const unitsPer = unit?.units_per || 1;
        await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_id,product_name,sku,quantity,unit_price,discount_amount,tax_amount,total,variation_id,variation_name,discount_percent,discount_override_by,serial_number,sell_unit,units_per,uom_id,ticket_discount,is_comment,is_delivery,discount_fixed) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [txId, product ? product.id : null, itemName, itemSku, lineQty, unit_price, discount, lineTax, lineTotal, variation?.id||null, variation?.name||null, discountPercent || 0, discountOverrideBy || null, serialNumber || null, variation ? null : unit?.sell_unit || null, variation ? 1 : unitsPer, variation ? null : unit?.uom_id ?? null, ticketDiscount ?? null, isComment ? 1 : 0, isDelivery ? 1 : 0, discountFixed || null] });
        // A custom/temp line has no catalog product — nothing to deduct; an
        // SN line is a stockless placeholder for the serial.
        if (!product || serialNumber) continue;
        // Stock is in the stock unit: a line moves quantity × its unit's size.
        const quantity = stockUnits(lineQty, unitsPer);
        if (variation) {
          await tx.execute({ sql: 'UPDATE product_variations SET stock_qty = stock_qty - ? WHERE id = ?', args: [quantity, variation.id] });
        } else {
          await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?', args: [quantity, product.id] });
        }
        if (branch_id) {
          if (req.apiKey) {
            // Online order: only touch the selected branch's existing stock record — no INSERT
            // to avoid creating a record with a wrong initial value from global stock
            await tx.execute({ sql: 'UPDATE branch_inventory SET stock_qty = MAX(0, stock_qty - ?), updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND branch_id = ?', args: [quantity, product.id, branch_id] });
          } else {
            await tx.execute({ sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = MAX(0, stock_qty - ?), updated_at = CURRENT_TIMESTAMP`, args: [product.id, branch_id, Math.max(0, product.stock_qty - quantity), product.min_stock, quantity] });
          }
          await syncBinQty(tx, product.id, branch_id, -quantity);
        }
      }

      if (customer_id) {
        const loyaltyPts = Math.floor(total * 0.5);
        await tx.execute({ sql: 'UPDATE customers SET loyalty_points = loyalty_points + ?, total_spent = total_spent + ? WHERE id = ?', args: [loyaltyPts, total, customer_id] });
        if (isCredit) {
          await tx.execute({ sql: 'UPDATE customers SET account_balance = account_balance + ? WHERE id = ?', args: [total, customer_id] });
        }
        if (storeCredit > 0) {
          // account_balance is a receivable (positive = customer owes the
          // store); a credit note decrements it negative (store owes them —
          // see the return-resolution handling below). Applying that credit
          // here moves the balance back toward zero, clamped so it can't
          // cross into positive (the frontend already caps storeCredit at
          // the available |balance|, this is defense-in-depth only).
          await tx.execute({ sql: 'UPDATE customers SET account_balance = MIN(0, account_balance + ?) WHERE id = ?', args: [storeCredit, customer_id] });
        }
        if (cashBack > 0 && cashBackCard) {
          // Consume points proportionally to the dollar amount actually
          // applied (which may be less than a full reward chunk if the cart
          // total was smaller) — e.g. redeeming $3 of a "500 pts = $5" reward
          // deducts 300 points, leaving 200 still accruing toward the next one.
          const pointsToDeduct = Math.round((cashBack / cashBackCard.reward_amount) * cashBackCard.points_threshold);
          await tx.execute({ sql: 'UPDATE customers SET loyalty_points = MAX(0, loyalty_points - ?), cash_back_last_redeemed_at = CURRENT_TIMESTAMP WHERE id = ?', args: [pointsToDeduct, customer_id] });
        }
      }

      if (quote_id) {
        await tx.execute({ sql: `UPDATE quotations SET status = 'converted', converted_to_tx = ? WHERE id = ? AND status NOT IN ('converted','declined','cancelled')`, args: [txId, quote_id] });
        // A Special Project's held rental items are paid for by this sale —
        // they're now ready to issue through the Rentals screen, exactly
        // like a rental paid at its own checkout (see holdSpecialProjectRentals
        // in routes/quotations.js). No deposit on these.
        await tx.execute({ sql: `UPDATE rental_agreements SET status = 'awaiting_issue', checkout_transaction_id = ?, deposit_total = 0 WHERE quotation_id = ? AND status = 'pending'`, args: [txId, quote_id] });
      }

      await tx.commit();
      committed = true;

      const { rows: [savedTx] } = await db.execute({ sql: `SELECT t.*, c.first_name || ' ' || c.last_name as customer_name, c.customer_number, c.address as customer_address, c.city as customer_city, c.state as customer_state, c.zip as customer_zip, e.first_name || ' ' || e.last_name as employee_name, cbe.first_name || ' ' || cbe.last_name as created_by_name, spe.first_name || ' ' || spe.last_name as salesperson_name, b.name as branch_name, b.address as branch_address, b.city as branch_city, b.state as branch_state, b.zip as branch_zip, b.phone as branch_phone, q.id as source_quote_id, q.quote_number as source_quote_number FROM transactions t LEFT JOIN customers c ON t.customer_id = c.id LEFT JOIN employees e ON t.employee_id = e.id LEFT JOIN employees cbe ON cbe.id = COALESCE(t.created_by, t.employee_id) LEFT JOIN employees spe ON spe.id = t.salesperson_id LEFT JOIN branches b ON t.branch_id = b.id LEFT JOIN quotations q ON q.converted_to_tx = t.id WHERE t.id = ?`, args: [txId] });
      const { rows: txItems } = await db.execute({ sql: 'SELECT * FROM transaction_items WHERE transaction_id = ?', args: [txId] });
      savedTx.items = txItems;
      const { rows: txPayments } = await db.execute({ sql: 'SELECT * FROM transaction_payments WHERE transaction_id = ? ORDER BY id', args: [txId] });
      savedTx.payments = txPayments;
      // Commission goes to whoever the sale is credited to (CREDITED_SQL):
      // the ticket's salesperson, else whoever started it, else the cashier.
      // A sale completed from a quote was started by the quote's
      // original_employee_id, so a quote reassigned to another salesperson
      // for completion (see PATCH /quotations/:id/reassign) still pays the
      // salesperson who originally brought in the deal.
      const commissionEmployeeId = salespersonId || createdBy || savedTx.employee_id;
      // Auto-calculate commission (non-blocking, best-effort)
      try { await calcCommission(commissionEmployeeId, savedTx.total, 'transaction', txId, savedTx.transaction_number); } catch(e) {}
      // A credit sale can take the account over its limit — re-check so the
      // Block box (lib/creditBlock.js) reflects it straight away, as rental
      // credit checkouts already do. Required lazily: customers.js loads after.
      if (isCredit && customer_id) { try { await require('./customers').runCreditCheck(customer_id); } catch(e) {} }
      res.status(201).json(savedTx);
    } catch(e) {
      // Once committed, the sale is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get returns for a transaction
router.get('/:id/returns', requireAuth, async (req, res) => {
  try {
    const { rows: returns } = await db.execute({ sql: 'SELECT * FROM returns WHERE original_transaction_id = ?', args: [req.params.id] });
    for (const r of returns) {
      const { rows: items } = await db.execute({ sql: 'SELECT * FROM return_items WHERE return_id = ?', args: [r.id] });
      r.items = items;
    }
    res.json(returns);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Single return by its own id, fully joined — used to build/reprint/email the
// return receipt (routes/email.js's buildReturnReceiptHtml needs these joins).
router.get('/returns/:id', requireAuth, async (req, res) => {
  try {
    const { rows: [ret] } = await db.execute({ sql: `SELECT r.*, t.transaction_number as original_transaction_number,
      c.first_name || ' ' || c.last_name as customer_name, c.email as customer_email,
      e.first_name || ' ' || e.last_name as employee_name,
      oe.first_name || ' ' || oe.last_name as override_by_name,
      b.name as branch_name, b.address as branch_address, b.city as branch_city, b.state as branch_state, b.zip as branch_zip, b.phone as branch_phone
      FROM returns r
      LEFT JOIN transactions t ON r.original_transaction_id = t.id
      LEFT JOIN customers c ON r.customer_id = c.id
      LEFT JOIN employees e ON r.employee_id = e.id
      LEFT JOIN employees oe ON r.override_by = oe.id
      LEFT JOIN branches b ON r.branch_id = b.id
      WHERE r.id = ?`, args: [req.params.id] });
    if (!ret) return res.status(404).json({ error: 'Return not found' });
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM return_items WHERE return_id = ?', args: [req.params.id] });
    ret.items = items;
    res.json(ret);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Shared by the fulfillment route below and by routes/warehouse.js, which calls
// this when a shipment linked to an online order changes status (ship/deliver/cancel).
async function updateFulfillmentStatus(txId, fulfillment_status) {
  const valid = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
  if (!valid.includes(fulfillment_status)) {
    const e = new Error(`Invalid status. Must be one of: ${valid.join(', ')}`);
    e.status = 400;
    throw e;
  }
  await db.execute({ sql: 'UPDATE transactions SET fulfillment_status = ? WHERE id = ?', args: [fulfillment_status, txId] });
  const { rows: [tx] } = await db.execute({ sql: 'SELECT * FROM transactions WHERE id = ?', args: [txId] });
  if (!tx) {
    const e = new Error('Transaction not found');
    e.status = 404;
    throw e;
  }

  // Push status to WooCommerce if this order was imported from WC
  if (tx.source === 'woocommerce') {
    const wcStatusMap = { pending: 'pending', processing: 'processing', shipped: 'on-hold', delivered: 'completed', cancelled: 'cancelled' };
    try {
      const { rows: [map] } = await db.execute({ sql: "SELECT woo_id FROM woo_sync_map WHERE entity_type='order' AND local_id=?", args: [tx.id] });
      if (map?.woo_id) {
        const s = await getWcSettings();
        await wcRequest(s, 'PUT', `/orders/${map.woo_id}`, { status: wcStatusMap[fulfillment_status] });
      }
    } catch(e) { /* non-fatal — POS update already saved */ }
  }

  return tx;
}

// Update fulfillment status (online orders)
router.patch('/:id/fulfillment', requirePermission('transactions'), async (req, res) => {
  try {
    const tx = await updateFulfillmentStatus(req.params.id, req.body.fulfillment_status);
    res.json(tx);
  } catch(e) { res.status(e.status || 500).json({ error: e.message }); }
});

// A Special Project invoice paid at the POS can include rental lines — custom
// (no-product) lines named after the project's rental lines (see POST
// /quotations/:id/convert). They're checked back in from the Rentals screen,
// never returned here. Returns a predicate for this sale's items.
async function spRentalLineMatcher(txId) {
  const { rows } = await db.execute({ sql: `SELECT qi.product_name FROM quotation_items qi
    WHERE qi.is_rental_line = 1 AND qi.quote_id IN (SELECT quotation_id FROM rental_agreements WHERE checkout_transaction_id = ? AND quotation_id IS NOT NULL)`, args: [txId] });
  const names = rows.map(r => r.product_name);
  return txItem => !txItem.product_id && (txItem.sku === 'RENTAL' || names.some(n => String(txItem.product_name || '').startsWith(n)));
}

// Credit card refunds are only allowed this many days after the sale (the
// card processor won't reverse an older charge). Past that, a return paid
// even partly by credit card can still go out as a credit note or exchange.
const CARD_REFUND_WINDOW_DAYS = 90;

// The SQLite CURRENT_TIMESTAMP default is UTC without a zone marker.
function daysSinceSale(createdAt) {
  const t = Date.parse(String(createdAt).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(createdAt) ? '' : 'Z'));
  return (Date.now() - t) / 86400000;
}

async function paidByCreditCard(tx) {
  const { rows } = await db.execute({ sql: "SELECT 1 FROM transaction_payments WHERE transaction_id = ? AND payment_method = 'credit_card' LIMIT 1", args: [tx.id] });
  return rows.length > 0 || tx.payment_method === 'credit_card';
}

// Process a return
router.post('/:id/return', requirePermission('transactions_returns'), async (req, res) => {
  try {
    const { items, resolution, notes, employee_id } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items selected for return' });
    if (!['refund', 'replacement', 'credit_note'].includes(resolution)) return res.status(400).json({ error: 'Invalid resolution type' });
    // Every return needs a manager's override: the PIN of an active employee
    // whose group has returns_override (standalone key). Checked here, not
    // trusted from the till, and recorded on the return.
    let overrideBy = null;
    if (!req.apiKey) {
      // The reason goes with the manager's authorization (returns.notes —
      // printed as Reason on the return receipt).
      if (!String(notes || '').trim()) return res.status(400).json({ error: 'Enter the reason for the return', code: 'reason_required' });
      const pin = String(req.body.override_pin || '').trim();
      if (!pin) return res.status(403).json({ error: 'A manager must enter their PIN to authorize this return', code: 'override_required' });
      const { rows: candidates } = await db.execute({ sql: 'SELECT e.id, e.pin, sg.permissions FROM employees e LEFT JOIN security_groups sg ON e.security_group_id = sg.id WHERE e.active = 1 AND e.pin = ?', args: [pin] });
      const authorizer = candidates.find(c => { try { return JSON.parse(c.permissions || '{}').returns_override === true; } catch { return false; } });
      if (!authorizer) return res.status(403).json({ error: "That PIN isn't a manager who can authorize returns", code: 'override_invalid' });
      overrideBy = authorizer.id;
    }
    if (!req.apiKey) {
      if (resolution === 'refund' && !can(req.employee?.permissions, 'transactions_refund')) return res.status(403).json({ error: 'Missing permission: transactions_refund' });
      if (resolution === 'credit_note' && !can(req.employee?.permissions, 'transactions_credit_note')) return res.status(403).json({ error: 'Missing permission: transactions_credit_note' });
    }

    const { rows: [tx] } = await db.execute({ sql: 'SELECT * FROM transactions WHERE id = ?', args: [req.params.id] });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status !== 'completed') return res.status(400).json({ error: 'Only completed transactions can be returned' });
    if (resolution === 'credit_note' && !tx.customer_id) return res.status(400).json({ error: 'Credit note requires a customer on the original transaction' });
    // A charge-account sale was never paid — refunding it would hand over
    // money while the customer still owes the full amount. Its return goes
    // back on the account as a credit note instead.
    if (resolution === 'refund' && (tx.is_credit || tx.payment_method === 'credit')) {
      return res.status(400).json({ error: "This sale was charged to the customer's account, so it can't be refunded. Issue a credit note to take the return off their balance." });
    }
    if (resolution === 'refund' && daysSinceSale(tx.created_at) > CARD_REFUND_WINDOW_DAYS && await paidByCreditCard(tx)) {
      return res.status(400).json({ error: `This sale was paid by credit card more than ${CARD_REFUND_WINDOW_DAYS} days ago, so it can't be refunded. Issue a credit note or an exchange instead.` });
    }

    // Same reasoning as the void guard below: a rental's checkout/settlement
    // transaction never decremented stock, so "returning" it here would
    // incorrectly inflate stock — use the Rentals screen's Process Return
    // instead, which correctly handles duration/damage/deposit accounting.
    const { rows: [linkedAgreement] } = await db.execute({ sql: 'SELECT agreement_number, quotation_id FROM rental_agreements WHERE checkout_transaction_id = ? OR settlement_transaction_id = ?', args: [req.params.id, req.params.id] });
    // A Special Project invoice can carry rental lines alongside ordinary
    // ones — its other lines can still be returned here, just not the rental.
    if (linkedAgreement && !linkedAgreement.quotation_id) {
      return res.status(400).json({ error: `This transaction belongs to rental agreement ${linkedAgreement.agreement_number} — process the return from the Rentals screen instead.` });
    }
    const isSpRentalLine = await spRentalLineMatcher(req.params.id);

    // Same reasoning — an assessment fee/deposit/final-payment transaction
    // never decremented stock either, so it has nothing a return could
    // sensibly reverse the way a retail sale's line items can.
    const { rows: [linkedWorkOrder] } = await db.execute({ sql: 'SELECT wo_number FROM work_orders WHERE assessment_transaction_id = ? OR deposit_transaction_id = ? OR final_transaction_id = ?', args: [req.params.id, req.params.id, req.params.id] });
    if (linkedWorkOrder) {
      return res.status(400).json({ error: `This transaction belongs to work order ${linkedWorkOrder.wo_number} — it has no line items to return.` });
    }

    const { rows: txItems } = await db.execute({ sql: 'SELECT * FROM transaction_items WHERE transaction_id = ?', args: [req.params.id] });

    const { rows: alreadyReturned } = await db.execute({ sql: `SELECT ri.transaction_item_id, SUM(ri.quantity) as returned_qty FROM return_items ri JOIN returns r ON ri.return_id = r.id WHERE r.original_transaction_id = ? AND r.status != 'cancelled' GROUP BY ri.transaction_item_id`, args: [req.params.id] });
    const returnedMap = {};
    alreadyReturned.forEach(r => { returnedMap[r.transaction_item_id] = r.returned_qty; });

    let returnSubtotal = 0, returnTax = 0;
    const processedItems = [];

    for (const item of items) {
      const txItem = txItems.find(i => i.id === item.transaction_item_id);
      if (!txItem) return res.status(400).json({ error: `Item ${item.transaction_item_id} not found in transaction` });
      if (txItem.is_comment) return res.status(400).json({ error: 'A comment line has nothing to return' });
      if (isSpRentalLine(txItem)) return res.status(400).json({ error: `"${txItem.product_name}" is a rental — it's checked back in from the Rentals screen, not returned here.` });
      const alreadyRet = returnedMap[item.transaction_item_id] || 0;
      // Lines in a decimal unit (lib/units.js) can be part-returned, e.g. 1.5 of 2.5 yd.
      const maxQty = Math.round((txItem.quantity - alreadyRet) * 1000) / 1000;
      item.quantity = Math.round(Number(item.quantity) * 1000) / 1000;
      if (!(item.quantity > 0) || item.quantity > maxQty) return res.status(400).json({ error: `Invalid quantity for "${txItem.product_name}". Max returnable: ${maxQty}` });
      const proportion = item.quantity / txItem.quantity;
      // Refund what was paid for the line: its net less its share of the
      // ticket discount (lib/ticketDiscount.js), plus the tax charged on it.
      const lineTotal = parseFloat((txItem.total * proportion - returnedDiscountShare(tx, txItem, txItems, proportion)).toFixed(2));
      const lineTax = parseFloat((txItem.tax_amount * proportion).toFixed(2));
      returnSubtotal += lineTotal;
      returnTax += lineTax;
      processedItems.push({ txItem, quantity: item.quantity, lineTotal, lineTax });
    }

    returnSubtotal = parseFloat(returnSubtotal.toFixed(2));
    returnTax = parseFloat(returnTax.toFixed(2));
    const returnTotal = parseFloat((returnSubtotal + returnTax).toFixed(2));

    const return_number = await nextNumber(db, 'returns', 'return_number', 'RET-', 6);

    const retTx = await db.transaction('write');
    let committed = false;
    try {
      const retResult = await retTx.execute({ sql: `INSERT INTO returns (return_number,original_transaction_id,customer_id,employee_id,branch_id,resolution,subtotal,tax_amount,total,notes,override_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, args: [return_number, tx.id, tx.customer_id, employee_id || tx.employee_id, tx.branch_id, resolution, returnSubtotal, returnTax, returnTotal, notes || null, overrideBy] });
      const retId = Number(retResult.lastInsertRowid);

      for (const { txItem, quantity, lineTotal, lineTax } of processedItems) {
        await retTx.execute({ sql: `INSERT INTO return_items (return_id,transaction_item_id,product_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?,?,?)`, args: [retId, txItem.id, txItem.product_id, txItem.product_name, txItem.sku, quantity, txItem.unit_price, lineTax, lineTotal] });
        // Delivery and other lines with no product have no stock to put back.
        if (!txItem.product_id) continue;
        // Returned quantity is in the line's unit; stock is in singles.
        const restock = stockUnits(quantity, txItem.units_per);
        await retTx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [restock, txItem.product_id] });
        if (tx.branch_id) {
          await retTx.execute({ sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at) VALUES (?, ?, ?, (SELECT min_stock FROM products WHERE id = ?), CURRENT_TIMESTAMP) ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP`, args: [txItem.product_id, tx.branch_id, restock, txItem.product_id, restock] });
          await syncBinQty(retTx, txItem.product_id, tx.branch_id, restock);
        }
      }

      if (tx.customer_id) {
        const loyaltyPts = Math.floor(returnTotal * 0.5);
        await retTx.execute({ sql: 'UPDATE customers SET loyalty_points = MAX(0, loyalty_points - ?), total_spent = MAX(0, total_spent - ?) WHERE id = ?', args: [loyaltyPts, returnTotal, tx.customer_id] });
        if (resolution === 'credit_note') {
          // account_balance is a receivable (what the customer owes — see
          // the Accounts Receivable page). A credit note reduces that,
          // going negative if there's nothing owed, to represent store
          // credit the business now owes the customer — not increases it.
          await retTx.execute({ sql: 'UPDATE customers SET account_balance = account_balance - ? WHERE id = ?', args: [returnTotal, tx.customer_id] });
        }
      }

      await retTx.commit();
      committed = true;
      const { rows: [ret] } = await db.execute({ sql: 'SELECT * FROM returns WHERE id = ?', args: [retId] });
      const { rows: retItems } = await db.execute({ sql: 'SELECT * FROM return_items WHERE return_id = ?', args: [retId] });
      ret.items = retItems;
      res.status(201).json(ret);
    } catch(e) {
      // Once committed, the return is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await retTx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Void transaction
// requireAuth as an outer gate only — the actual authorization for a void is
// the existing inline PIN + void_transactions permission check just below,
// which is preserved exactly as-is (a second, elevated re-auth factor, not
// replaced by session auth).
router.patch('/:id/void', requireAuth, async (req, res) => {
  try {
    const { pin, reason } = req.body;
    if (!pin) return res.status(400).json({ error: 'Override PIN required' });

    const { rows: employees } = await db.execute({ sql: 'SELECT e.id, e.first_name, e.last_name, e.pin, sg.permissions FROM employees e LEFT JOIN security_groups sg ON e.security_group_id = sg.id WHERE e.active = 1', args: [] });
    const authorizer = employees.find(e => {
      if (e.pin !== String(pin)) return false;
      try { const p = JSON.parse(e.permissions || '{}'); return p.void_transactions === true; } catch { return false; }
    });
    if (!authorizer) return res.status(403).json({ error: 'Invalid PIN or insufficient privilege' });

    const { rows: [tx] } = await db.execute({ sql: 'SELECT * FROM transactions WHERE id = ?', args: [req.params.id] });
    if (!tx) return res.status(404).json({ error: 'Not found' });
    if (tx.status === 'voided') return res.status(400).json({ error: 'Already voided' });

    // Rental checkout/settlement transactions don't fit this endpoint's
    // assumptions: their transaction_items include synthetic lines with no
    // product_id (deposit, duration adjustment, damage fee — would crash the
    // branch_inventory restore below), and rental checkout never decremented
    // stock to begin with (see routes/rentals.js), so "restoring" it here
    // would inflate stock that was never actually removed. Cancelling a
    // rental agreement already correctly voids its checkout transaction and
    // reverses loyalty/credit without touching stock — use that instead.
    const { rows: [linkedAgreement] } = await db.execute({ sql: 'SELECT agreement_number FROM rental_agreements WHERE checkout_transaction_id = ? OR settlement_transaction_id = ?', args: [req.params.id, req.params.id] });
    if (linkedAgreement) {
      return res.status(400).json({ error: `This transaction belongs to rental agreement ${linkedAgreement.agreement_number} — cancel it from the Rentals screen instead (View agreement → Cancel Agreement), which correctly reverses the rental's own records.` });
    }

    const voidTxn = await db.transaction('write');
    try {
      await voidTxn.execute({ sql: "UPDATE transactions SET status='voided', voided_by=?, voided_at=CURRENT_TIMESTAMP, void_reason=? WHERE id=?", args: [authorizer.id, reason || null, req.params.id] });
      const { rows: items } = await voidTxn.execute({ sql: 'SELECT * FROM transaction_items WHERE transaction_id = ?', args: [req.params.id] });
      for (const item of items) {
        if (!item.product_id) continue; // delivery/comment lines carry no stock
        const restock = stockUnits(item.quantity, item.units_per); // in stock units
        await voidTxn.execute({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [restock, item.product_id] });
        if (tx.branch_id) {
          await voidTxn.execute({ sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at) VALUES (?, ?, ?, (SELECT min_stock FROM products WHERE id = ?), CURRENT_TIMESTAMP) ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP`, args: [item.product_id, tx.branch_id, restock, item.product_id, restock] });
          await syncBinQty(voidTxn, item.product_id, tx.branch_id, restock);
        }
      }
      if (tx.customer_id) {
        const loyaltyPts = Math.floor(tx.total * 0.5);
        await voidTxn.execute({ sql: 'UPDATE customers SET loyalty_points = loyalty_points - ?, total_spent = total_spent - ? WHERE id = ?', args: [loyaltyPts, tx.total, tx.customer_id] });
        if (tx.is_credit) {
          await voidTxn.execute({ sql: 'UPDATE customers SET account_balance = MAX(0, account_balance - ?) WHERE id = ?', args: [tx.total, tx.customer_id] });
        }
      }
      await voidTxn.commit();
    } catch(e) {
      await voidTxn.rollback();
      throw e;
    }

    try { await db.execute({ sql: "DELETE FROM commission_records WHERE source_type='transaction' AND source_id=? AND status!='paid'", args: [req.params.id] }); } catch(e) {}
    res.json({ success: true, voided_by: `${authorizer.first_name} ${authorizer.last_name}` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.updateFulfillmentStatus = updateFulfillmentStatus;
