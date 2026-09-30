const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');
const { round2, today, dueDateFor, PAID_SQL, createBill, poBilling } = require('../lib/payables');

// Accounts payable: bills (what vendors invoice us), payments against them,
// and aging. Viewing needs `payables`; entering/editing bills needs
// payables_bills, recording payments payables_payments, and voiding either
// payables_void.

const PAYMENT_METHODS = ['cash', 'cheque', 'bank_transfer', 'card', 'other'];

// Bill columns plus the derived paid/balance/display status. `as_of` (the
// viewer's local date) decides overdue, so it matches what the user's
// calendar says rather than the server's time zone.
const billSelect = `SELECT b.*, s.name AS supplier_name, s.supplier_number, po.po_number, br.name AS branch_name,
  e.first_name || ' ' || e.last_name AS created_by_name,
  ${PAID_SQL} AS paid
  FROM ap_bills b
  JOIN suppliers s ON s.id = b.supplier_id
  LEFT JOIN purchase_orders po ON po.id = b.po_id
  LEFT JOIN branches br ON br.id = b.branch_id
  LEFT JOIN employees e ON e.id = b.created_by`;

function decorateBill(b, asOf) {
  b.paid = round2(b.paid);
  b.balance = b.status === 'void' ? 0 : round2(b.amount - b.paid);
  b.display_status = b.status === 'void' ? 'void'
    : b.balance <= 0 ? 'paid'
    : b.due_date < asOf ? 'overdue'
    : b.paid > 0 ? 'partial' : 'open';
  return b;
}

const asOfDate = req => /^\d{4}-\d{2}-\d{2}$/.test(req.query.as_of || '') ? req.query.as_of : today();

// ── Bills ─────────────────────────────────────────────────
router.get('/bills', requirePermission('payables'), async (req, res) => {
  try {
    const { supplier_id, status, search } = req.query;
    const asOf = asOfDate(req);
    let sql = `${billSelect} WHERE 1=1`;
    const args = [];
    if (supplier_id) { sql += ' AND b.supplier_id = ?'; args.push(supplier_id); }
    if (search) {
      sql += ' AND (b.bill_number LIKE ? OR b.vendor_invoice_number LIKE ? OR s.name LIKE ? OR po.po_number LIKE ?)';
      const q = `%${search}%`; args.push(q, q, q, q);
    }
    sql += ' ORDER BY b.due_date, b.id';
    const { rows } = await db.execute({ sql, args });
    let bills = rows.map(b => decorateBill(b, asOf));
    // Status filters apply to the derived status, so they run after decorating.
    if (status === 'unpaid') bills = bills.filter(b => b.balance > 0);
    else if (status && status !== 'all') bills = bills.filter(b => b.display_status === status);
    res.json(bills);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/bills/:id', requirePermission('payables'), async (req, res) => {
  try {
    const { rows: [bill] } = await db.execute({ sql: `${billSelect} WHERE b.id = ?`, args: [req.params.id] });
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    decorateBill(bill, asOfDate(req));
    const { rows: payments } = await db.execute({
      sql: `SELECT a.amount AS applied, p.id, p.payment_number, p.payment_date, p.method, p.reference, p.status
            FROM ap_payment_allocations a JOIN ap_payments p ON p.id = a.payment_id
            WHERE a.bill_id = ? ORDER BY p.payment_date, p.id`,
      args: [req.params.id],
    });
    bill.payments = payments;
    res.json(bill);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Shared validation for create/edit. Returns an error string or null.
async function validateBill(body, billId) {
  const amount = round2(body.amount);
  if (!body.supplier_id) return 'Vendor is required';
  if (!(amount > 0)) return 'Amount must be greater than zero';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.bill_date || '')) return 'Bill date is required';
  if (body.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(body.due_date)) return 'Due date is invalid';
  const invoiceNo = String(body.vendor_invoice_number || '').trim();
  if (invoiceNo) {
    // The same vendor invoice entered twice is the classic way to pay a bill
    // twice, so it's refused outright.
    const { rows: [dupe] } = await db.execute({
      sql: "SELECT bill_number FROM ap_bills WHERE supplier_id = ? AND LOWER(vendor_invoice_number) = LOWER(?) AND status != 'void' AND id != ?",
      args: [body.supplier_id, invoiceNo, billId || 0],
    });
    if (dupe) return `Vendor invoice ${invoiceNo} is already entered as bill ${dupe.bill_number}`;
  }
  if (body.po_id) {
    const { rows: [po] } = await db.execute({ sql: 'SELECT supplier_id FROM purchase_orders WHERE id = ?', args: [body.po_id] });
    if (!po) return 'Purchase order not found';
    if (Number(po.supplier_id) !== Number(body.supplier_id)) return 'That purchase order belongs to a different vendor';
  }
  return null;
}

router.post('/bills', requirePermission('payables_bills'), async (req, res) => {
  try {
    const err = await validateBill(req.body);
    if (err) return res.status(400).json({ error: err });
    const { rows: [supplier] } = await db.execute({ sql: 'SELECT payment_terms FROM suppliers WHERE id = ?', args: [req.body.supplier_id] });
    if (!supplier) return res.status(400).json({ error: 'Vendor not found' });
    const id = await createBill(db, {
      ...req.body,
      vendor_invoice_number: String(req.body.vendor_invoice_number || '').trim(),
      due_date: req.body.due_date || dueDateFor(supplier.payment_terms, req.body.bill_date),
      source: req.body.po_id ? 'po' : 'manual',
      created_by: req.employee?.id,
    });
    const { rows: [bill] } = await db.execute({ sql: `${billSelect} WHERE b.id = ?`, args: [id] });
    res.status(201).json(decorateBill(bill, today()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/bills/:id', requirePermission('payables_bills'), async (req, res) => {
  try {
    const { rows: [bill] } = await db.execute({ sql: `${billSelect} WHERE b.id = ?`, args: [req.params.id] });
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    if (bill.status === 'void') return res.status(400).json({ error: 'A void bill cannot be edited' });
    const body = { ...req.body, supplier_id: req.body.supplier_id || bill.supplier_id };
    if (bill.paid > 0 && Number(body.supplier_id) !== Number(bill.supplier_id)) return res.status(400).json({ error: 'The vendor cannot be changed once payments are applied' });
    const err = await validateBill(body, bill.id);
    if (err) return res.status(400).json({ error: err });
    const amount = round2(body.amount);
    if (amount < round2(bill.paid)) return res.status(400).json({ error: `Amount cannot be less than the ${round2(bill.paid).toFixed(2)} already paid` });
    await db.execute({
      sql: 'UPDATE ap_bills SET supplier_id=?, vendor_invoice_number=?, po_id=?, branch_id=?, bill_date=?, due_date=?, amount=?, description=? WHERE id=?',
      args: [body.supplier_id, String(body.vendor_invoice_number || '').trim() || null, body.po_id || null, body.branch_id || null,
        body.bill_date, body.due_date || bill.due_date, amount, body.description || null, bill.id],
    });
    const { rows: [updated] } = await db.execute({ sql: `${billSelect} WHERE b.id = ?`, args: [bill.id] });
    res.json(decorateBill(updated, today()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Voiding a bill with payments applied would strand that money, so those
// payments have to be voided first.
router.post('/bills/:id/void', requirePermission('payables_void'), async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to void a bill' });
    const { rows: [bill] } = await db.execute({ sql: `${billSelect} WHERE b.id = ?`, args: [req.params.id] });
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    if (bill.status === 'void') return res.status(400).json({ error: 'This bill is already void' });
    if (round2(bill.paid) > 0) return res.status(400).json({ error: 'This bill has payments applied — void those payments first' });
    await db.execute({
      sql: "UPDATE ap_bills SET status = 'void', void_reason = ?, voided_by = ?, voided_at = CURRENT_TIMESTAMP WHERE id = ?",
      args: [reason, req.employee?.id || null, bill.id],
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Received vs. billed for one PO, plus its bills — for the PO detail view.
router.get('/po/:poId', requirePermission('payables'), async (req, res) => {
  try {
    const billing = await poBilling(db, req.params.poId);
    if (!billing) return res.status(404).json({ error: 'Purchase order not found' });
    const { rows } = await db.execute({ sql: `${billSelect} WHERE b.po_id = ? ORDER BY b.id`, args: [req.params.poId] });
    res.json({ ...billing, bills: rows.map(b => decorateBill(b, asOfDate(req))) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Payments ──────────────────────────────────────────────
router.get('/payments', requirePermission('payables'), async (req, res) => {
  try {
    const { supplier_id } = req.query;
    let sql = `SELECT p.*, s.name AS supplier_name, e.first_name || ' ' || e.last_name AS created_by_name,
      (SELECT GROUP_CONCAT(b.bill_number, ', ') FROM ap_payment_allocations a JOIN ap_bills b ON b.id = a.bill_id WHERE a.payment_id = p.id) AS bill_numbers
      FROM ap_payments p JOIN suppliers s ON s.id = p.supplier_id LEFT JOIN employees e ON e.id = p.created_by WHERE 1=1`;
    const args = [];
    if (supplier_id) { sql += ' AND p.supplier_id = ?'; args.push(supplier_id); }
    sql += ' ORDER BY p.payment_date DESC, p.id DESC LIMIT 500';
    const { rows } = await db.execute({ sql, args });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Records a payment and applies it to the given bills. Every allocation must
// be for an open bill of the same vendor and no more than its balance, and
// the allocations must add up to the payment amount exactly — there is no
// unapplied vendor credit.
router.post('/payments', requirePermission('payables_payments'), async (req, res) => {
  try {
    const { supplier_id, payment_date, method, reference, notes } = req.body;
    const amount = round2(req.body.amount);
    const allocations = (req.body.allocations || []).map(a => ({ bill_id: Number(a.bill_id), amount: round2(a.amount) })).filter(a => a.amount > 0);
    if (!supplier_id) return res.status(400).json({ error: 'Vendor is required' });
    if (!(amount > 0)) return res.status(400).json({ error: 'Amount must be greater than zero' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payment_date || '')) return res.status(400).json({ error: 'Payment date is required' });
    if (!PAYMENT_METHODS.includes(method)) return res.status(400).json({ error: 'Choose a payment method' });
    if (!allocations.length) return res.status(400).json({ error: 'Apply the payment to at least one bill' });
    const allocated = round2(allocations.reduce((s, a) => s + a.amount, 0));
    if (allocated !== amount) return res.status(400).json({ error: `Amounts applied to bills (${allocated.toFixed(2)}) must equal the payment amount (${amount.toFixed(2)})` });
    if (new Set(allocations.map(a => a.bill_id)).size !== allocations.length) return res.status(400).json({ error: 'A bill is listed more than once' });

    const tx = await db.transaction('write');
    let committed = false;
    try {
      // Balances are checked inside the write transaction so two people
      // paying the same bill at once can't both succeed.
      for (const a of allocations) {
        const { rows: [bill] } = await tx.execute({ sql: `SELECT b.*, ${PAID_SQL} AS paid FROM ap_bills b WHERE b.id = ?`, args: [a.bill_id] });
        if (!bill || Number(bill.supplier_id) !== Number(supplier_id)) throw new Error('One of the bills does not belong to this vendor');
        if (bill.status === 'void') throw new Error(`Bill ${bill.bill_number} is void`);
        const balance = round2(bill.amount - bill.paid);
        if (a.amount > balance) throw new Error(`${a.amount.toFixed(2)} is more than the ${balance.toFixed(2)} still owed on bill ${bill.bill_number}`);
      }
      const payment_number = await nextNumber(tx, 'ap_payments', 'payment_number', 'APP-', 6);
      const result = await tx.execute({
        sql: 'INSERT INTO ap_payments (payment_number, supplier_id, payment_date, amount, method, reference, notes, created_by) VALUES (?,?,?,?,?,?,?,?)',
        args: [payment_number, supplier_id, payment_date, amount, method, reference || null, notes || null, req.employee?.id || null],
      });
      const paymentId = Number(result.lastInsertRowid);
      for (const a of allocations) {
        await tx.execute({ sql: 'INSERT INTO ap_payment_allocations (payment_id, bill_id, amount) VALUES (?,?,?)', args: [paymentId, a.bill_id, a.amount] });
      }
      await tx.commit();
      committed = true;
      res.status(201).json({ id: paymentId, payment_number });
    } catch (e) {
      if (!committed) await tx.rollback().catch(() => {});
      res.status(400).json({ error: e.message });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/payments/:id/void', requirePermission('payables_void'), async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to void a payment' });
    const { rows: [payment] } = await db.execute({ sql: 'SELECT * FROM ap_payments WHERE id = ?', args: [req.params.id] });
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    if (payment.status === 'void') return res.status(400).json({ error: 'This payment is already void' });
    await db.execute({
      sql: "UPDATE ap_payments SET status = 'void', void_reason = ?, voided_by = ?, voided_at = CURRENT_TIMESTAMP WHERE id = ?",
      args: [reason, req.employee?.id || null, payment.id],
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Aging & statements ────────────────────────────────────
// Unpaid balance per vendor, bucketed by days past due as of `as_of`.
router.get('/aging', requirePermission('payables'), async (req, res) => {
  try {
    const asOf = asOfDate(req);
    const { rows } = await db.execute({
      sql: `SELECT b.supplier_id, s.name AS supplier_name, s.supplier_number, b.due_date,
              b.amount - ${PAID_SQL} AS balance
            FROM ap_bills b JOIN suppliers s ON s.id = b.supplier_id
            WHERE b.status != 'void'`,
      args: [],
    });
    const byVendor = new Map();
    const totals = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0 };
    const asOfMs = new Date(`${asOf}T00:00:00`).getTime();
    for (const r of rows) {
      const bal = round2(r.balance);
      if (bal <= 0) continue;
      const daysLate = Math.round((asOfMs - new Date(`${r.due_date}T00:00:00`).getTime()) / 86400000);
      const bucket = daysLate <= 0 ? 'current' : daysLate <= 30 ? 'd1_30' : daysLate <= 60 ? 'd31_60' : daysLate <= 90 ? 'd61_90' : 'd90_plus';
      if (!byVendor.has(r.supplier_id)) byVendor.set(r.supplier_id, { supplier_id: r.supplier_id, supplier_name: r.supplier_name, supplier_number: r.supplier_number, current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0, bills: 0 });
      const v = byVendor.get(r.supplier_id);
      v[bucket] = round2(v[bucket] + bal); v.total = round2(v.total + bal); v.bills++;
      totals[bucket] = round2(totals[bucket] + bal); totals.total = round2(totals.total + bal);
    }
    const vendors = [...byVendor.values()].sort((a, b) => b.total - a.total);
    res.json({ as_of: asOf, vendors, totals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Every bill and payment for one vendor in date order with a running
// balance (void ones listed but not counted).
router.get('/vendors/:id/statement', requirePermission('payables'), async (req, res) => {
  try {
    const { rows: [supplier] } = await db.execute({ sql: 'SELECT id, name, supplier_number, payment_terms FROM suppliers WHERE id = ?', args: [req.params.id] });
    if (!supplier) return res.status(404).json({ error: 'Vendor not found' });
    const { rows: bills } = await db.execute({ sql: 'SELECT b.*, po.po_number FROM ap_bills b LEFT JOIN purchase_orders po ON po.id = b.po_id WHERE b.supplier_id = ?', args: [supplier.id] });
    const { rows: payments } = await db.execute({ sql: 'SELECT * FROM ap_payments WHERE supplier_id = ?', args: [supplier.id] });
    const lines = [
      ...bills.map(b => ({ type: 'bill', id: b.id, date: b.bill_date, number: b.bill_number, reference: [b.vendor_invoice_number && `Inv ${b.vendor_invoice_number}`, b.po_number].filter(Boolean).join(' · '), charge: round2(b.amount), payment: 0, void: b.status === 'void', created_at: b.created_at })),
      ...payments.map(p => ({ type: 'payment', id: p.id, date: p.payment_date, number: p.payment_number, reference: [p.method.replace('_', ' '), p.reference].filter(Boolean).join(' · '), charge: 0, payment: round2(p.amount), void: p.status === 'void', created_at: p.created_at })),
    ].sort((a, b) => a.date.localeCompare(b.date) || String(a.created_at).localeCompare(String(b.created_at)));
    let running = 0;
    for (const l of lines) {
      if (!l.void) running = round2(running + l.charge - l.payment);
      l.balance = running;
    }
    res.json({ supplier, lines, balance: running });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
