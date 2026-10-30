const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { runCreditCheck } = require('./customers');
const { requirePermission } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');
const { LEGACY_BALANCE_SQL, openArInvoices, buildAllocations, insertAllocations, paymentAllocations } = require('../lib/legacyInvoices');
const { UNAPPLIED_SQL, allArInvoices, currentAllocations, setPaymentAllocations } = require('../lib/customerPayments');
const { customerArDetail } = require('../lib/arDetail');

// Every endpoint in this file is specific to the Accounts Receivable
// screen (unlike e.g. employees.js, nothing here is used as a cross-feature
// lookup), so the module-level `accounts` permission gates all of it —
// matching how the section itself is gated in the frontend.
router.use(requirePermission('accounts'));

// AR summary - all credit-enabled customers with balances
router.get('/', async (req, res) => {
  try {
    const { rows: customers } = await db.execute({ sql: `SELECT c.id, c.customer_number, c.first_name, c.last_name, c.business_name, c.email, c.phone, c.credit_limit, c.account_balance, c.credit_enabled, COUNT(DISTINCT t.id) as credit_invoices, COALESCE(SUM(CASE WHEN t.status = 'completed' AND t.payment_method = 'credit' THEN t.total ELSE 0 END), 0) as total_invoiced, COALESCE((SELECT SUM(p.amount) FROM account_payments p WHERE p.customer_id = c.id), 0) as total_paid FROM customers c LEFT JOIN transactions t ON c.id = t.customer_id AND t.payment_method = 'credit' AND t.status = 'completed' WHERE c.credit_enabled = 1 AND c.active = 1 GROUP BY c.id ORDER BY c.account_balance DESC, c.last_name`, args: [] });
    res.json(customers);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// AR aging report
router.get('/aging', async (req, res) => {
  try {
    const { rows: aging } = await db.execute({ sql: `
      SELECT c.id, c.customer_number, c.first_name || ' ' || c.last_name as customer_name,
        c.business_name, c.email, c.phone, c.account_balance,
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
    // Payments received on account but not yet applied to invoices
    // (lib/customerPayments.js) — the buckets above still show those invoices
    // as owing, so the aging shows this credit alongside.
    const { rows: unapplied } = await db.execute({ sql: `SELECT ap.customer_id, SUM(${UNAPPLIED_SQL}) AS unapplied FROM account_payments ap
      WHERE ap.payment_method != 'writeoff' AND ${UNAPPLIED_SQL} > 0.005 GROUP BY ap.customer_id`, args: [] });
    for (const u of unapplied) { const a = byCustomer.get(u.customer_id); if (a) a.unapplied_credit = parseFloat(Number(u.unapplied).toFixed(2)); }
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
    // applied_to: the invoices each payment / credit note went against.
    const { rows: payments } = await db.execute({ sql: `SELECT ap.*, CASE WHEN ap.payment_method = 'writeoff' THEN 0 ELSE ${UNAPPLIED_SQL} END AS unapplied, e.first_name || ' ' || e.last_name as employee_name, b.name as branch_name,
      TRIM(COALESCE((SELECT GROUP_CONCAT(li.invoice_number, ', ') FROM legacy_invoice_allocations lia JOIN ar_legacy_invoices li ON li.id = lia.legacy_invoice_id WHERE lia.payment_id = ap.id), '') || ' ' ||
        COALESCE((SELECT GROUP_CONCAT(t.transaction_number, ', ') FROM payment_allocations pa JOIN transactions t ON t.id = pa.transaction_id WHERE pa.payment_id = ap.id), '')) AS applied_to
      FROM account_payments ap LEFT JOIN employees e ON ap.employee_id = e.id LEFT JOIN branches b ON ap.branch_id = b.id WHERE ap.customer_id = ? ORDER BY ap.created_at DESC`, args: [req.params.id] });
    const { rows: legacy_invoices } = await db.execute({ sql: `SELECT li.*, ${LEGACY_BALANCE_SQL} as balance_due FROM ar_legacy_invoices li WHERE li.customer_id = ? ORDER BY li.invoice_date DESC, li.id DESC`, args: [req.params.id] });
    res.json({ customer, invoices, payments, legacy_invoices });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Invoice-by-invoice detail (lib/arDetail.js): open invoices with due date,
// age, P.O. #, and the payments / credit notes / write-offs applied to each;
// ?all=1 includes paid invoices too.
router.get('/customer/:id/detail', async (req, res) => {
  try {
    const detail = await customerArDetail(db, req.params.id, { all: req.query.all === '1', today: /^\d{4}-\d{2}-\d{2}$/.test(req.query.as_of || '') ? req.query.as_of : undefined });
    if (!detail) return res.status(404).json({ error: 'Customer not found' });
    res.json(detail);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Enable/disable credit for a customer and set credit limit — Manage
// Credit Limits, same as switching a customer to Credit on their form.
router.patch('/customer/:id', requirePermission('customers_credit'), async (req, res) => {
  try {
    const { credit_enabled, credit_limit } = req.body;
    const updates = [];
    const params = [];
    // customer_type is what the POS checks for a credit sale, so it follows.
    if (credit_enabled !== undefined) { updates.push('credit_enabled = ?', 'customer_type = ?'); params.push(credit_enabled ? 1 : 0, credit_enabled ? 'credit' : 'cash'); }
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

// ── Receivables feeds & allocation (RetailPOS Books) ─────────────
// Books' receivables representatives allocate open payments to invoices and
// reallocate between invoices from Books; the POS stays the record. These
// never change a payment's amount or create one (lib/customerPayments.js).

// One customer's account as Books' allocation screen needs it: every invoice
// with what's owed, every payment with its allocations and unapplied amount,
// and recent allocation changes.
router.get('/customer/:id/receivables', async (req, res) => {
  try {
    const { rows: [customer] } = await db.execute({ sql: 'SELECT id, customer_number, first_name, last_name, account_balance, credit_limit, customer_type FROM customers WHERE id = ?', args: [req.params.id] });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    const invoices = await allArInvoices(db, customer.id);
    const byKey = new Map(invoices.map(i => [i.key, i]));
    const { rows: payRows } = await db.execute({ sql: `SELECT ap.*, CASE WHEN ap.payment_method = 'writeoff' THEN 0 ELSE ${UNAPPLIED_SQL} END AS unapplied, e.first_name || ' ' || e.last_name AS employee_name
      FROM account_payments ap LEFT JOIN employees e ON e.id = ap.employee_id WHERE ap.customer_id = ? ORDER BY ap.created_at, ap.id`, args: [customer.id] });
    const payments = [];
    for (const p of payRows) {
      const allocations = (await currentAllocations(db, p.id)).map(a => ({ ...a, invoice_number: byKey.get(a.legacy_invoice_id ? `L${a.legacy_invoice_id}` : `T${a.transaction_id}`)?.number || null }));
      payments.push({ id: p.id, payment_number: p.payment_number, created_at: p.created_at, amount: p.amount, payment_method: p.payment_method, payment_mode: p.payment_mode, reference: p.reference, employee_name: p.employee_name, unapplied: Math.max(0, parseFloat(Number(p.unapplied).toFixed(2))), allocations });
    }
    const { rows: changes } = await db.execute({ sql: 'SELECT c.*, ap.payment_number FROM payment_allocation_changes c JOIN account_payments ap ON ap.id = c.payment_id WHERE c.customer_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT 50', args: [customer.id] });
    res.json({ customer, invoices, payments, changes: changes.map(c => ({ ...c, before: JSON.parse(c.before_json), after: JSON.parse(c.after_json) })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Set which invoices a payment is applied to (allocate / reallocate).
// changed_by names the Books user when called with an API key.
router.put('/payments/:id/allocations', requirePermission('accounts_payments'), async (req, res) => {
  try {
    const changedBy = req.apiKey ? (String(req.body.changed_by || '').trim() || 'RetailPOS Books') : `${req.employee?.first_name || ''} ${req.employee?.last_name || ''}`.trim();
    res.json(await setPaymentAllocations(req.params.id, req.body.allocations, { changedBy, source: req.apiKey ? 'books' : 'pos' }));
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// New payments since a payment id (oldest first) — Books posts each one to
// its ledger once.
router.get('/payments-feed', async (req, res) => {
  try {
    const sinceId = parseInt(req.query.since_id) || 0;
    const limit = Math.min(1000, parseInt(req.query.limit) || 500);
    // return_id / return_number / return_tax mark a credit note made by a
    // return (lib/returnCreditNotes.js) — Books books those; a credit note
    // without return_id is a legacy one Books entered itself.
    const { rows } = await db.execute({ sql: `SELECT ap.id, ap.payment_number, ap.customer_id, ap.amount, ap.payment_method, ap.payment_mode, ap.reference, ap.notes, ap.created_at,
        ap.return_id, r.return_number, r.tax_amount AS return_tax
      FROM account_payments ap LEFT JOIN returns r ON r.id = ap.return_id WHERE ap.id > ? ORDER BY ap.id LIMIT ?`, args: [sinceId, limit] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Current paid / written-off totals for the given invoices (comma-separated
// transaction ids and legacy invoice ids) — Books mirrors each invoice's paid
// amount from these.
router.get('/allocation-totals', async (req, res) => {
  try {
    const ids = v => String(v || '').split(',').map(Number).filter(Boolean).slice(0, 500);
    const tx = ids(req.query.transactions), legacy = ids(req.query.legacy);
    const out = { transactions: {}, legacy: {} };
    if (tx.length) {
      const { rows } = await db.execute({ sql: `SELECT pa.transaction_id AS id, SUM(CASE WHEN ap.payment_method = 'writeoff' THEN 0 ELSE pa.amount END) AS paid, SUM(CASE WHEN ap.payment_method = 'writeoff' THEN pa.amount ELSE 0 END) AS written_off
        FROM payment_allocations pa JOIN account_payments ap ON ap.id = pa.payment_id WHERE pa.transaction_id IN (${tx.map(() => '?').join(',')}) GROUP BY pa.transaction_id`, args: tx });
      for (const r of rows) out.transactions[r.id] = { paid: Number(r.paid) || 0, written_off: Number(r.written_off) || 0 };
    }
    if (legacy.length) {
      const { rows } = await db.execute({ sql: `SELECT lia.legacy_invoice_id AS id, SUM(CASE WHEN ap.payment_method = 'writeoff' THEN 0 ELSE lia.amount END) AS paid, SUM(CASE WHEN ap.payment_method = 'writeoff' THEN lia.amount ELSE 0 END) AS written_off
        FROM legacy_invoice_allocations lia JOIN account_payments ap ON ap.id = lia.payment_id WHERE lia.legacy_invoice_id IN (${legacy.map(() => '?').join(',')}) GROUP BY lia.legacy_invoice_id`, args: legacy });
      for (const r of rows) out.legacy[r.id] = { paid: Number(r.paid) || 0, written_off: Number(r.written_off) || 0 };
    }
    res.json(out);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Customer payments are received by cashiers at the POS — POST
// /api/customer-payments (lib/customerPayments.js, permission
// pos_receive_payment) — so they're tied to a cash drawer. This endpoint used
// to post them from the Accounts screen and is kept only to say so.
router.post('/payments', (req, res) => {
  res.status(410).json({ error: 'Customer payments are received at the POS (Receive Payment) by cashiers.' });
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
    let sql = `SELECT p.*, e.first_name || ' ' || e.last_name as employee_name, (SELECT COALESCE(SUM(scu.amount), 0) FROM store_credit_uses scu WHERE scu.payment_id = p.id) AS store_credit_used
               FROM account_payments p LEFT JOIN employees e ON p.employee_id = e.id
               WHERE p.customer_id = ?`;
    const params = [req.params.customer_id];
    if (start) { sql += ' AND date(p.created_at) >= ?'; params.push(start); }
    if (end)   { sql += ' AND date(p.created_at) <= ?'; params.push(end); }
    sql += ' ORDER BY p.created_at ASC';
    const { rows: payments } = await db.execute({ sql, args: params });
    for (const p of payments) {
      p.allocations = await paymentAllocations(db, p.id);
      p.unapplied = p.payment_method === 'writeoff' ? 0 : Math.max(0, parseFloat((p.amount - p.allocations.reduce((s, a) => s + a.amount, 0) - (Number(p.store_credit_used) || 0)).toFixed(2)));
    }
    res.json({ customer, payments, period: { start: start || null, end: end || null } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// List payments
router.get('/payments', async (req, res) => {
  try {
    const { customer_id, start, end, limit = 200, sort = 'desc', sort_by = 'date', q } = req.query;
    let sql = `SELECT p.*, CASE WHEN p.payment_method = 'writeoff' THEN 0 ELSE ${UNAPPLIED_SQL.replace(/\bap\./g, 'p.')} END AS unapplied, c.first_name || ' ' || c.last_name as customer_name, c.customer_number, c.business_name, e.first_name || ' ' || e.last_name as employee_name, b.name as branch_name FROM account_payments p LEFT JOIN customers c ON p.customer_id = c.id LEFT JOIN employees e ON p.employee_id = e.id LEFT JOIN branches b ON p.branch_id = b.id WHERE 1=1`;
    const params = [];
    if (customer_id) { sql += ' AND p.customer_id = ?'; params.push(customer_id); }
    if (start) { sql += ' AND date(p.created_at) >= ?'; params.push(start); }
    if (end) { sql += ' AND date(p.created_at) <= ?'; params.push(end); }
    // Free-text search: payment #, reference, method, customer (name,
    // business, number) or the employee who took it.
    if (q && String(q).trim()) {
      const like = `%${String(q).trim()}%`;
      sql += ` AND (p.payment_number LIKE ? OR p.reference LIKE ? OR p.payment_method LIKE ?
        OR (c.first_name || ' ' || c.last_name) LIKE ? OR c.business_name LIKE ? OR c.customer_number LIKE ?
        OR (e.first_name || ' ' || e.last_name) LIKE ?)`;
      params.push(like, like, like, like, like, like, like);
    }
    const sortCol = { date: 'p.created_at', amount: 'p.amount', number: 'p.payment_number', method: 'p.payment_method',
      customer: "LOWER(c.first_name || ' ' || c.last_name)", employee: "LOWER(e.first_name || ' ' || e.last_name)" }[sort_by] || 'p.created_at';
    const dir = sort === 'asc' ? 'ASC' : 'DESC';
    sql += ` ORDER BY ${sortCol} ${dir}, p.created_at ${dir}, p.id ${dir} LIMIT ?`;
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

// Legacy credit notes: credit the customer was owed in the old system,
// entered in RetailPOS Books and pushed here. Each becomes an open credit on
// the account — an account_payments row with payment_method 'credit_note',
// payment_mode 'open' and no drawer session (no money changed hands, so it's
// never in a drawer count or the collections report). Like an unapplied
// payment it lowers the balance now, counts against the oldest invoices in
// the credit check, and is applied to invoices by the cashier or Books'
// receivables reps. If it's more than is owed the balance goes negative
// (the customer is in credit), as with returns.
async function creditNoteRow(id) {
  const { rows: [row] } = await db.execute({ sql: `SELECT ap.*, ${UNAPPLIED_SQL} AS unapplied FROM account_payments ap WHERE ap.id = ?`, args: [id] });
  return row;
}

router.post('/legacy-credit-notes', requirePermission('accounts_create'), async (req, res) => {
  try {
    const { customer_id, credit_note_number, date, memo } = req.body;
    const external_id = req.body.external_id != null && req.body.external_id !== '' ? String(req.body.external_id) : null;
    const amount = parseFloat(parseFloat(req.body.amount).toFixed(2));
    const number = String(credit_note_number || '').trim();
    if (!customer_id) return res.status(400).json({ error: 'customer_id is required' });
    if (!number) return res.status(400).json({ error: 'The old credit note number is required' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || isNaN(new Date(date))) return res.status(400).json({ error: 'date must be a date (YYYY-MM-DD)' });
    if (!(amount > 0)) return res.status(400).json({ error: 'amount must be more than 0' });

    if (external_id) {
      const { rows: [already] } = await db.execute({ sql: 'SELECT id FROM account_payments WHERE external_id = ?', args: [external_id] });
      if (already) return res.json({ ...(await creditNoteRow(already.id)), already_recorded: true });
    }

    const { rows: [customer] } = await db.execute({ sql: 'SELECT id, first_name, last_name, credit_enabled FROM customers WHERE id = ?', args: [customer_id] });
    if (!customer) return res.status(404).json({ error: `No POS customer with id ${customer_id}` });
    if (!customer.credit_enabled) return res.status(400).json({ error: `${customer.first_name} ${customer.last_name} isn't set up for credit in the POS — enable credit on their account (Accounts) first` });
    const reference = `Legacy CN ${number}`;
    const { rows: [dup] } = await db.execute({ sql: "SELECT id FROM account_payments WHERE customer_id = ? AND payment_method = 'credit_note' AND reference = ?", args: [customer_id, reference] });
    if (dup) return res.status(409).json({ error: `Legacy credit note ${number} is already on this customer's account` });
    // apply_to_external_id: the legacy invoice (Books' id for it) the credit
    // note is against — the old system's "apply to document". It's applied
    // to that invoice, up to what it still owes; the rest stays on account.
    let applyTo = null;
    const applyExt = req.body.apply_to_external_id != null && req.body.apply_to_external_id !== '' ? String(req.body.apply_to_external_id) : null;
    if (applyExt) {
      const { rows: [inv] } = await db.execute({ sql: `SELECT li.id, li.invoice_number, li.status, ${LEGACY_BALANCE_SQL} AS due FROM ar_legacy_invoices li WHERE li.external_id = ? AND li.customer_id = ?`, args: [applyExt, customer_id] });
      // Refused (not stored) so Books retries once the invoice has arrived.
      if (!inv) return res.status(400).json({ error: "The invoice this credit note applies to isn't on the customer's POS account yet" });
      if (inv.status === 'open' && inv.due > 0.005) applyTo = { legacy_invoice_id: inv.id, amount: parseFloat(Math.min(amount, inv.due).toFixed(2)) };
    }

    const payment_number = await nextNumber(db, 'account_payments', 'payment_number', 'CN-', 6);
    const tx = await db.transaction('write');
    let committed = false, id;
    try {
      const result = await tx.execute({
        sql: "INSERT INTO account_payments (payment_number, customer_id, amount, payment_method, payment_mode, reference, notes, external_id, created_at) VALUES (?,?,?,'credit_note',?,?,?,?,?)",
        args: [payment_number, customer_id, amount, applyTo && applyTo.amount >= amount ? 'invoices' : 'open', reference, memo || null, external_id, `${date} 12:00:00`],
      });
      id = Number(result.lastInsertRowid);
      if (applyTo) {
        await insertAllocations(tx, id, [applyTo]);
        await tx.execute({ sql: 'INSERT INTO payment_allocation_changes (payment_id, customer_id, before_json, after_json, changed_by, source) VALUES (?,?,?,?,?,?)',
          args: [id, customer_id, '[]', JSON.stringify([applyTo]), 'RetailPOS Books (credit note entry)', 'books'] });
      }
      await tx.execute({ sql: 'UPDATE customers SET account_balance = account_balance - ? WHERE id = ?', args: [amount, customer_id] });
      await tx.commit();
      committed = true;
    } catch(e) {
      if (!committed) await tx.rollback();
      throw e;
    }
    try { await runCreditCheck(customer_id); } catch(e) {}
    res.status(201).json(await creditNoteRow(id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Remove a legacy credit note entered by mistake — only while none of it has
// been applied to an invoice.
router.post('/legacy-credit-notes/:id/void', requirePermission('accounts_create'), async (req, res) => {
  try {
    const cn = await creditNoteRow(req.params.id);
    if (!cn || cn.payment_method !== 'credit_note') return res.status(404).json({ error: 'Legacy credit note not found' });
    // Its allocation history is kept, so one that was ever allocated stays —
    // except the invoice it was applied to when it was entered, which goes
    // with it (a credit note entered against the wrong invoice can be voided).
    const ENTRY = 'RetailPOS Books (credit note entry)';
    const { rows: [history] } = await db.execute({ sql: 'SELECT id FROM payment_allocation_changes WHERE payment_id = ? AND COALESCE(changed_by, \'\') != ? LIMIT 1', args: [cn.id, ENTRY] });
    if (history) return res.status(409).json({ error: `Credit note ${cn.payment_number} has been allocated before, so it can't be voided` });
    const { rows: [store] } = await db.execute({ sql: 'SELECT 1 FROM store_credit_uses WHERE payment_id = ? LIMIT 1', args: [cn.id] });
    if (store) return res.status(409).json({ error: `Credit note ${cn.payment_number} has been spent as store credit, so it can't be voided` });

    const tx = await db.transaction('write');
    let committed = false;
    try {
      await tx.execute({ sql: 'DELETE FROM legacy_invoice_allocations WHERE payment_id = ?', args: [cn.id] });
      await tx.execute({ sql: 'DELETE FROM payment_allocations WHERE payment_id = ?', args: [cn.id] });
      await tx.execute({ sql: 'DELETE FROM payment_allocation_changes WHERE payment_id = ?', args: [cn.id] });
      await tx.execute({ sql: 'DELETE FROM account_payments WHERE id = ?', args: [cn.id] });
      await tx.execute({ sql: 'UPDATE customers SET account_balance = account_balance + ? WHERE id = ?', args: [cn.amount, cn.customer_id] });
      await tx.commit();
      committed = true;
    } catch(e) {
      if (!committed) await tx.rollback();
      throw e;
    }
    try { await runCreditCheck(cn.customer_id); } catch(e) {}
    res.json({ ok: true, id: cn.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
