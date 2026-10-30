const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');
const { round2, today, dueDateFor, PAID_SQL, UNAPPLIED_SQL, createBill, applyPoAdvances, poBilling } = require('../lib/payables');

// Accounts payable: bills (what vendors invoice us), payments against them,
// and aging. Viewing needs `payables`; entering/editing bills needs
// payables_bills and voiding either payables_void. Payments are only made
// from approved payment requests (routes/payment-requests.js).

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
  b.tax_amount = round2(b.tax_amount);
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
  const tax = round2(body.tax_amount);
  if (tax < 0) return 'GCT cannot be negative';
  if (tax > amount) return 'GCT cannot be more than the bill amount';
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
    // A caller that doesn't send the GCT keeps what the bill has.
    const tax = body.tax_amount === undefined ? round2(bill.tax_amount) : round2(body.tax_amount);
    if (tax > amount) return res.status(400).json({ error: 'GCT cannot be more than the bill amount' });
    await db.execute({
      sql: 'UPDATE ap_bills SET supplier_id=?, vendor_invoice_number=?, po_id=?, branch_id=?, bill_date=?, due_date=?, amount=?, tax_amount=?, description=? WHERE id=?',
      args: [body.supplier_id, String(body.vendor_invoice_number || '').trim() || null, body.po_id || null, body.branch_id || null,
        body.bill_date, body.due_date || bill.due_date, amount, tax, body.description || null, bill.id],
    });
    if (body.po_id) await applyPoAdvances(db, body.po_id);
    const { rows: [updated] } = await db.execute({ sql: `${billSelect} WHERE b.id = ?`, args: [bill.id] });
    res.json(decorateBill(updated, today()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Voiding a bill with payments applied would strand that money, so those
// payments have to be voided first — except a PO advance's share, which
// just goes back to being unapplied on the advance.
router.post('/bills/:id/void', requirePermission('payables_void'), async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to void a bill' });
    const { rows: [bill] } = await db.execute({ sql: `${billSelect} WHERE b.id = ?`, args: [req.params.id] });
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    if (bill.status === 'void') return res.status(400).json({ error: 'This bill is already void' });
    const { rows: [nonAdvance] } = await db.execute({
      sql: `SELECT COALESCE(SUM(a.amount), 0) AS v FROM ap_payment_allocations a JOIN ap_payments p ON p.id = a.payment_id AND p.status = 'posted'
            WHERE a.bill_id = ? AND p.po_id IS NULL`,
      args: [bill.id],
    });
    if (round2(nonAdvance.v) > 0) return res.status(400).json({ error: 'This bill has payments applied — void those payments first' });
    await db.batch([
      { sql: 'DELETE FROM ap_payment_allocations WHERE bill_id = ? AND payment_id IN (SELECT id FROM ap_payments WHERE po_id IS NOT NULL)', args: [bill.id] },
      { sql: "UPDATE ap_bills SET status = 'void', void_reason = ?, voided_by = ?, voided_at = CURRENT_TIMESTAMP WHERE id = ?", args: [reason, req.employee?.id || null, bill.id] },
    ], 'write');
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
      (SELECT GROUP_CONCAT(b.bill_number, ', ') FROM ap_payment_allocations a JOIN ap_bills b ON b.id = a.bill_id WHERE a.payment_id = p.id) AS bill_numbers,
      po.po_number, r.request_number, ${UNAPPLIED_SQL} AS unapplied
      FROM ap_payments p JOIN suppliers s ON s.id = p.supplier_id LEFT JOIN employees e ON e.id = p.created_by
      LEFT JOIN purchase_orders po ON po.id = p.po_id LEFT JOIN payment_requests r ON r.id = p.payment_request_id WHERE 1=1`;
    const args = [];
    if (supplier_id) { sql += ' AND p.supplier_id = ?'; args.push(supplier_id); }
    sql += ' ORDER BY p.payment_date DESC, p.id DESC LIMIT 500';
    const { rows } = await db.execute({ sql, args });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Vendors are paid only from an approved payment request
// (POST /payables/payment-requests/:id/pay), so direct payments are gone.
router.post('/payments', requirePermission('payables_payments'), (req, res) => {
  res.status(410).json({ error: 'Vendor payments are made from an approved payment request (Payables > Payment Request)' });
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
    // Advances paid on POs that no bill has absorbed yet — already paid out,
    // so not in the totals above.
    const { rows: [adv] } = await db.execute({ sql: `SELECT COALESCE(SUM(${UNAPPLIED_SQL}), 0) AS v FROM ap_payments p WHERE p.po_id IS NOT NULL AND p.status = 'posted'`, args: [] });
    res.json({ as_of: asOf, vendors, totals, advances_unapplied: round2(adv.v) });
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
