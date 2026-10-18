const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { runCreditCheck } = require('./customers');
const { requirePermission } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');
const { calcRentalCommission } = require('./commissions');
const { LEGACY_BALANCE_SQL, openArInvoices, buildAllocations, insertAllocations, paymentAllocations } = require('../lib/legacyInvoices');

// Every endpoint in this file is specific to the Accounts Receivable
// screen (unlike e.g. employees.js, nothing here is used as a cross-feature
// lookup), so the module-level `accounts` permission gates all of it —
// matching how the section itself is gated in the frontend.
router.use(requirePermission('accounts'));

// AR summary - all credit-enabled customers with balances
router.get('/', async (req, res) => {
  try {
    const { rows: customers } = await db.execute({ sql: `SELECT c.id, c.customer_number, c.first_name, c.last_name, c.email, c.phone, c.credit_limit, c.account_balance, c.credit_enabled, COUNT(DISTINCT t.id) as credit_invoices, COALESCE(SUM(CASE WHEN t.status = 'completed' AND t.payment_method = 'credit' THEN t.total ELSE 0 END), 0) as total_invoiced, COALESCE((SELECT SUM(p.amount) FROM account_payments p WHERE p.customer_id = c.id), 0) as total_paid FROM customers c LEFT JOIN transactions t ON c.id = t.customer_id AND t.payment_method = 'credit' AND t.status = 'completed' WHERE c.credit_enabled = 1 AND c.active = 1 GROUP BY c.id ORDER BY c.account_balance DESC, c.last_name`, args: [] });
    res.json(customers);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// AR aging report
router.get('/aging', async (req, res) => {
  try {
    const { rows: aging } = await db.execute({ sql: `
      SELECT c.id, c.customer_number, c.first_name || ' ' || c.last_name as customer_name,
        c.email, c.phone, c.account_balance,
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(t.created_at) AS INTEGER) <= 30
          THEN MAX(0, t.total - COALESCE(alloc.total_allocated, 0)) ELSE 0 END), 0) as current_30,
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(t.created_at) AS INTEGER) BETWEEN 31 AND 60
          THEN MAX(0, t.total - COALESCE(alloc.total_allocated, 0)) ELSE 0 END), 0) as days_31_60,
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(t.created_at) AS INTEGER) BETWEEN 61 AND 90
          THEN MAX(0, t.total - COALESCE(alloc.total_allocated, 0)) ELSE 0 END), 0) as days_61_90,
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(t.created_at) AS INTEGER) > 90
          THEN MAX(0, t.total - COALESCE(alloc.total_allocated, 0)) ELSE 0 END), 0) as over_90
      FROM customers c
      LEFT JOIN transactions t ON c.id = t.customer_id AND t.payment_method = 'credit' AND t.status = 'completed'
        AND t.id NOT IN (SELECT checkout_transaction_id FROM rental_agreements WHERE status = 'returned' AND checkout_transaction_id IS NOT NULL)
      LEFT JOIN (SELECT transaction_id, SUM(amount) as total_allocated FROM payment_allocations GROUP BY transaction_id) alloc
        ON t.id = alloc.transaction_id
      WHERE c.credit_enabled = 1 AND c.active = 1
      GROUP BY c.id
      ORDER BY c.account_balance DESC`, args: [] });
    // Legacy invoices (lib/legacyInvoices.js) age from their old-system
    // invoice date, into the same buckets.
    const { rows: legacy } = await db.execute({ sql: `
      SELECT li.customer_id,
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(li.invoice_date) AS INTEGER) <= 30 THEN ${LEGACY_BALANCE_SQL} ELSE 0 END), 0) as current_30,
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(li.invoice_date) AS INTEGER) BETWEEN 31 AND 60 THEN ${LEGACY_BALANCE_SQL} ELSE 0 END), 0) as days_31_60,
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(li.invoice_date) AS INTEGER) BETWEEN 61 AND 90 THEN ${LEGACY_BALANCE_SQL} ELSE 0 END), 0) as days_61_90,
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(li.invoice_date) AS INTEGER) > 90 THEN ${LEGACY_BALANCE_SQL} ELSE 0 END), 0) as over_90
      FROM ar_legacy_invoices li WHERE li.status = 'open' AND ${LEGACY_BALANCE_SQL} > 0.001
      GROUP BY li.customer_id`, args: [] });
    const byCustomer = new Map(aging.map(a => [a.id, a]));
    for (const l of legacy) {
      const a = byCustomer.get(l.customer_id);
      if (!a) continue;
      for (const k of ['current_30', 'days_31_60', 'days_61_90', 'over_90']) a[k] = parseFloat(((a[k] || 0) + (l[k] || 0)).toFixed(2));
    }
    res.json(aging);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// AR summary stats
router.get('/stats', async (req, res) => {
  try {
    const { rows: [stats] } = await db.execute({ sql: `SELECT COUNT(DISTINCT c.id) as credit_customers, COALESCE(SUM(c.account_balance), 0) as total_outstanding, COALESCE(SUM(CASE WHEN c.account_balance > c.credit_limit AND c.credit_limit > 0 THEN 1 ELSE 0 END), 0) as over_limit_count, COALESCE((SELECT SUM(amount) FROM account_payments WHERE date(created_at) = date('now')), 0) as payments_today FROM customers c WHERE c.credit_enabled = 1 AND c.active = 1`, args: [] });
    res.json(stats);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Customer account detail
router.get('/customer/:id', async (req, res) => {
  try {
    const { rows: [customer] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [req.params.id] });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    const { rows: invoices } = await db.execute({ sql: `SELECT t.id, t.transaction_number, t.total, t.status, t.created_at, e.first_name || ' ' || e.last_name as employee_name, b.name as branch_name FROM transactions t LEFT JOIN employees e ON t.employee_id = e.id LEFT JOIN branches b ON t.branch_id = b.id WHERE t.customer_id = ? AND t.payment_method = 'credit' ORDER BY t.created_at DESC`, args: [req.params.id] });
    const { rows: payments } = await db.execute({ sql: `SELECT p.*, e.first_name || ' ' || e.last_name as employee_name, b.name as branch_name FROM account_payments p LEFT JOIN employees e ON p.employee_id = e.id LEFT JOIN branches b ON p.branch_id = b.id WHERE p.customer_id = ? ORDER BY p.created_at DESC`, args: [req.params.id] });
    const { rows: legacy_invoices } = await db.execute({ sql: `SELECT li.*, ${LEGACY_BALANCE_SQL} as balance_due FROM ar_legacy_invoices li WHERE li.customer_id = ? ORDER BY li.invoice_date DESC, li.id DESC`, args: [req.params.id] });
    res.json({ customer, invoices, payments, legacy_invoices });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Enable/disable credit for a customer and set credit limit
router.patch('/customer/:id', async (req, res) => {
  try {
    const { credit_enabled, credit_limit } = req.body;
    const updates = [];
    const params = [];
    if (credit_enabled !== undefined) { updates.push('credit_enabled = ?'); params.push(credit_enabled ? 1 : 0); }
    if (credit_limit !== undefined) { updates.push('credit_limit = ?'); params.push(parseFloat(credit_limit)); }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    params.push(req.params.id);
    await db.execute({ sql: `UPDATE customers SET ${updates.join(', ')} WHERE id = ?`, args: params });
    const { rows: [row] } = await db.execute({ sql: 'SELECT id, customer_number, first_name, last_name, credit_limit, account_balance, credit_enabled FROM customers WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// Outstanding invoices for a customer (with per-invoice balance_due) —
// credit sales and legacy invoices together, oldest first.
router.get('/invoices/:customer_id', async (req, res) => {
  try {
    res.json(await openArInvoices(db, req.params.customer_id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Allocations for a specific payment
router.get('/payments/:id/allocations', async (req, res) => {
  try {
    res.json(await paymentAllocations(db, req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Record a payment from a customer
router.post('/payments', async (req, res) => {
  try {
    const { customer_id, employee_id, branch_id, amount, payment_method, notes, allocations } = req.body;
    if (!customer_id || !amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'customer_id and positive amount required' });

    const { rows: [customer] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [customer_id] });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const payment_number = await nextNumber(db, 'account_payments', 'payment_number', 'PMT-', 6);
    const amt = parseFloat(parseFloat(amount).toFixed(2));

    // Use the allocations given, or spread oldest-first across open credit
    // sales and legacy invoices (lib/legacyInvoices.js).
    let finalAllocations;
    try { finalAllocations = await buildAllocations(db, customer_id, amt, allocations); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const payTx = await db.transaction('write');
    let committed = false;
    try {
      const result = await payTx.execute({ sql: 'INSERT INTO account_payments (payment_number,customer_id,employee_id,branch_id,amount,payment_method,notes) VALUES (?,?,?,?,?,?,?)', args: [payment_number, customer_id, employee_id||null, branch_id||null, amt, payment_method||'cash', notes||null] });
      const payId = Number(result.lastInsertRowid);
      await insertAllocations(payTx, payId, finalAllocations);
      await payTx.execute({ sql: 'UPDATE customers SET account_balance = MAX(0, account_balance - ?) WHERE id = ?', args: [amt, customer_id] });
      await payTx.commit();
      committed = true;

      const { rows: [payRow] } = await db.execute({ sql: `SELECT p.*, c.first_name || ' ' || c.last_name as customer_name FROM account_payments p LEFT JOIN customers c ON p.customer_id = c.id WHERE p.id = ?`, args: [payId] });
      try { await runCreditCheck(customer_id); } catch(e) {}
      // A credit-financed rental's commission is deliberately gated on the
      // customer actually paying, not on booking — see calcRentalCommission.
      // Only fires once this (or an earlier) payment brings the specific
      // checkout invoice to fully paid; works whether or not the rental has
      // been returned yet, since an explicit allocation like this one isn't
      // subject to the "exclude returned rentals" filter that only applies
      // to the auto-FIFO candidate query above.
      try {
        for (const alloc of finalAllocations.filter(a => a.transaction_id)) {
          const { rows: [rentalAgreement] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE checkout_transaction_id = ?', args: [alloc.transaction_id] });
          if (!rentalAgreement) continue;
          const { rows: [checkoutTx] } = await db.execute({ sql: 'SELECT * FROM transactions WHERE id = ?', args: [alloc.transaction_id] });
          if (!checkoutTx) continue;
          const { rows: [{ paid }] } = await db.execute({ sql: 'SELECT COALESCE(SUM(amount),0) as paid FROM payment_allocations WHERE transaction_id = ?', args: [alloc.transaction_id] });
          if (checkoutTx.total - paid > 0.001) continue;
          await calcRentalCommission(rentalAgreement, checkoutTx);
        }
      } catch(e) {}
      res.status(201).json(payRow);
    } catch(e) {
      // Once committed, the payment is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await payTx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Write off (forgive) part or all of a customer's outstanding balance —
// same shape as POST /payments above (same account_payments/
// payment_allocations tables, same FIFO-oldest-first default allocation,
// same balance decrement + runCreditCheck re-evaluation), just tagged
// payment_method='writeoff' instead of a real tender, gated by the
// stricter accounts_writeoff permission on top of the router-level
// `accounts` gate, and requiring a reason. Deliberately skips the
// rental-commission trigger POST /payments has — forgiven debt was never
// actually collected, so it shouldn't pay out a salesperson's commission.
router.post('/writeoff', requirePermission('accounts_writeoff'), async (req, res) => {
  try {
    const { customer_id, employee_id, branch_id, amount, reason, allocations } = req.body;
    if (!customer_id || !amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'customer_id and positive amount required' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required to write off a balance' });

    const { rows: [customer] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [customer_id] });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const payment_number = await nextNumber(db, 'account_payments', 'payment_number', 'WO-', 6);
    const amt = parseFloat(parseFloat(amount).toFixed(2));

    let finalAllocations;
    try { finalAllocations = await buildAllocations(db, customer_id, amt, allocations); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const woTx = await db.transaction('write');
    let committed = false;
    try {
      const result = await woTx.execute({ sql: 'INSERT INTO account_payments (payment_number,customer_id,employee_id,branch_id,amount,payment_method,notes) VALUES (?,?,?,?,?,?,?)', args: [payment_number, customer_id, employee_id||null, branch_id||null, amt, 'writeoff', reason.trim()] });
      const woId = Number(result.lastInsertRowid);
      await insertAllocations(woTx, woId, finalAllocations);
      await woTx.execute({ sql: 'UPDATE customers SET account_balance = MAX(0, account_balance - ?) WHERE id = ?', args: [amt, customer_id] });
      await woTx.commit();
      committed = true;

      const { rows: [woRow] } = await db.execute({ sql: `SELECT p.*, c.first_name || ' ' || c.last_name as customer_name FROM account_payments p LEFT JOIN customers c ON p.customer_id = c.id WHERE p.id = ?`, args: [woId] });
      try { await runCreditCheck(customer_id); } catch(e) {}
      res.status(201).json(woRow);
    } catch(e) {
      // Once committed, the write-off is saved — rolling back a closed
      // transaction throws and would crash the process (unhandled
      // rejection), so only roll back if the commit itself never happened.
      if (!committed) await woTx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Payment statement data for a customer (payments + per-payment allocations)
router.get('/statement/:customer_id', async (req, res) => {
  try {
    const { start, end } = req.query;
    const { rows: [customer] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [req.params.customer_id] });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    let sql = `SELECT p.*, e.first_name || ' ' || e.last_name as employee_name
               FROM account_payments p LEFT JOIN employees e ON p.employee_id = e.id
               WHERE p.customer_id = ?`;
    const params = [req.params.customer_id];
    if (start) { sql += ' AND date(p.created_at) >= ?'; params.push(start); }
    if (end)   { sql += ' AND date(p.created_at) <= ?'; params.push(end); }
    sql += ' ORDER BY p.created_at ASC';
    const { rows: payments } = await db.execute({ sql, args: params });
    for (const p of payments) p.allocations = await paymentAllocations(db, p.id);
    res.json({ customer, payments, period: { start: start || null, end: end || null } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// List payments
router.get('/payments', async (req, res) => {
  try {
    const { customer_id, start, end, limit = 200, sort = 'desc' } = req.query;
    let sql = `SELECT p.*, c.first_name || ' ' || c.last_name as customer_name, c.customer_number, e.first_name || ' ' || e.last_name as employee_name, b.name as branch_name FROM account_payments p LEFT JOIN customers c ON p.customer_id = c.id LEFT JOIN employees e ON p.employee_id = e.id LEFT JOIN branches b ON p.branch_id = b.id WHERE 1=1`;
    const params = [];
    if (customer_id) { sql += ' AND p.customer_id = ?'; params.push(customer_id); }
    if (start) { sql += ' AND date(p.created_at) >= ?'; params.push(start); }
    if (end) { sql += ' AND date(p.created_at) <= ?'; params.push(end); }
    sql += ` ORDER BY p.created_at ${sort === 'asc' ? 'ASC' : 'DESC'} LIMIT ?`;
    params.push(parseInt(limit));
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Legacy invoices ─────────────────────────────────────────────
// Invoices carried over from the old system, entered by the accounts team in
// RetailPOS Books and pushed here with an API key (scope accounts:write).
// Each adds to the customer's account_balance and is then worked like any
// credit invoice (lib/legacyInvoices.js). external_id is Books' invoice id:
// pushing the same one again returns the invoice already recorded.

router.get('/legacy-invoices', async (req, res) => {
  try {
    const { customer_id, external_id } = req.query;
    let sql = `SELECT li.*, ${LEGACY_BALANCE_SQL} as balance_due FROM ar_legacy_invoices li WHERE 1=1`;
    const args = [];
    if (customer_id) { sql += ' AND li.customer_id = ?'; args.push(customer_id); }
    if (external_id) { sql += ' AND li.external_id = ?'; args.push(String(external_id)); }
    sql += ' ORDER BY li.invoice_date, li.id';
    const { rows } = await db.execute({ sql, args });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function legacyInvoiceRow(id) {
  const { rows: [row] } = await db.execute({ sql: `SELECT li.*, ${LEGACY_BALANCE_SQL} as balance_due FROM ar_legacy_invoices li WHERE li.id = ?`, args: [id] });
  return row;
}

router.post('/legacy-invoices', requirePermission('accounts_create'), async (req, res) => {
  try {
    const { customer_id, invoice_number, invoice_date, due_date, memo } = req.body;
    const external_id = req.body.external_id != null && req.body.external_id !== '' ? String(req.body.external_id) : null;
    const amount = parseFloat(parseFloat(req.body.amount).toFixed(2));
    const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !isNaN(new Date(d));
    if (!customer_id) return res.status(400).json({ error: 'customer_id is required' });
    if (!String(invoice_number || '').trim()) return res.status(400).json({ error: 'The old invoice number is required' });
    if (!isDate(invoice_date)) return res.status(400).json({ error: 'invoice_date must be a date (YYYY-MM-DD)' });
    if (due_date && !isDate(due_date)) return res.status(400).json({ error: 'due_date must be a date (YYYY-MM-DD)' });
    if (!(amount > 0)) return res.status(400).json({ error: 'amount must be more than 0' });

    if (external_id) {
      const { rows: [already] } = await db.execute({ sql: 'SELECT id FROM ar_legacy_invoices WHERE external_id = ?', args: [external_id] });
      if (already) return res.json({ ...(await legacyInvoiceRow(already.id)), already_recorded: true });
    }

    const { rows: [customer] } = await db.execute({ sql: 'SELECT id, first_name, last_name, credit_enabled, active FROM customers WHERE id = ?', args: [customer_id] });
    if (!customer) return res.status(404).json({ error: `No POS customer with id ${customer_id}` });
    if (!customer.credit_enabled) return res.status(400).json({ error: `${customer.first_name} ${customer.last_name} isn't set up for credit in the POS — enable credit on their account (Accounts) first` });
    const number = String(invoice_number).trim();
    const { rows: [dup] } = await db.execute({ sql: "SELECT id FROM ar_legacy_invoices WHERE customer_id = ? AND invoice_number = ? AND status = 'open'", args: [customer_id, number] });
    if (dup) return res.status(409).json({ error: `Legacy invoice ${number} is already on this customer's account` });

    const tx = await db.transaction('write');
    let committed = false, id;
    try {
      const result = await tx.execute({
        sql: 'INSERT INTO ar_legacy_invoices (customer_id, invoice_number, invoice_date, due_date, amount, memo, external_id) VALUES (?,?,?,?,?,?,?)',
        args: [customer_id, number, invoice_date, due_date || null, amount, memo || null, external_id],
      });
      id = Number(result.lastInsertRowid);
      await tx.execute({ sql: 'UPDATE customers SET account_balance = account_balance + ? WHERE id = ?', args: [amount, customer_id] });
      await tx.commit();
      committed = true;
    } catch(e) {
      if (!committed) await tx.rollback();
      throw e;
    }
    try { await runCreditCheck(customer_id); } catch(e) {}
    res.status(201).json(await legacyInvoiceRow(id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Void a legacy invoice entered by mistake — only while nothing has been
// paid or written off against it, since those payments would otherwise be
// left pointing at an invoice that no longer counts.
router.post('/legacy-invoices/:id/void', requirePermission('accounts_create'), async (req, res) => {
  try {
    const inv = await legacyInvoiceRow(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Legacy invoice not found' });
    if (inv.status === 'void') return res.json(inv);
    if (inv.amount - inv.balance_due > 0.001) return res.status(409).json({ error: `${(inv.amount - inv.balance_due).toFixed(2)} has already been paid or written off against legacy invoice ${inv.invoice_number}, so it can't be voided` });

    const tx = await db.transaction('write');
    let committed = false;
    try {
      await tx.execute({ sql: "UPDATE ar_legacy_invoices SET status = 'void', voided_at = CURRENT_TIMESTAMP WHERE id = ?", args: [inv.id] });
      await tx.execute({ sql: 'UPDATE customers SET account_balance = MAX(0, account_balance - ?) WHERE id = ?', args: [inv.amount, inv.customer_id] });
      await tx.commit();
      committed = true;
    } catch(e) {
      if (!committed) await tx.rollback();
      throw e;
    }
    try { await runCreditCheck(inv.customer_id); } catch(e) {}
    res.json(await legacyInvoiceRow(inv.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
