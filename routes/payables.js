const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');
const { round2, today, dueDateFor, PAID_SQL, UNAPPLIED_SQL, createBill, applyPoAdvances, poBilling } = require('../lib/payables');
const { resolvePoCurrency } = require('../lib/poLines');

// A bill entered in a foreign currency: { currency, exchange_rate, amount_fx }
// with the base amount worked out (amount_fx × rate). Base bills return nulls.
async function billCurrency(body, current = {}) {
  if (body.currency === undefined) return { currency: current.currency || null, exchange_rate: current.exchange_rate || null, amount_fx: current.amount_fx ?? null };
  const pay = await resolvePoCurrency(body.currency, body.exchange_rate);
  if (!pay.currency) return { currency: null, exchange_rate: null, amount_fx: null };
  if (!(pay.exchange_rate > 0)) throw Object.assign(new Error(`Enter the ${pay.currency} exchange rate`), { status: 400 });
  const amount_fx = round2(body.amount_fx);
  if (!(amount_fx > 0)) throw Object.assign(new Error(`Enter the bill amount in ${pay.currency}`), { status: 400 });
  return { currency: pay.currency, exchange_rate: pay.exchange_rate, amount_fx, amount: round2(amount_fx * pay.exchange_rate) };
}

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
  // A foreign-currency bill's balance in its own currency (base ÷ booked rate).
  b.balance_fx = b.currency && Number(b.exchange_rate) > 0 ? round2(b.balance / Number(b.exchange_rate)) : null;
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
      sql: `SELECT a.amount AS applied, a.amount_fx AS applied_fx, p.id, p.payment_number, p.payment_date, p.method, p.reference, p.status,
              p.currency, p.exchange_rate, p.amount_fx, p.posting_mode, p.books_bank_account_id
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
    let cur;
    try { cur = await billCurrency(req.body); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    if (cur.currency) { req.body.amount = cur.amount; if (req.body.tax_fx != null) req.body.tax_amount = round2(Number(req.body.tax_fx) * cur.exchange_rate); }
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
      currency: cur.currency, exchange_rate: cur.exchange_rate, amount_fx: cur.amount_fx,
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
    // A consignment settlement bill is the matched invoice: its amounts,
    // vendor and invoice # stay as matched (void it and accept it again).
    if (bill.consignment_settlement_id) {
      const b = req.body;
      const changed = (b.amount !== undefined && round2(b.amount) !== round2(bill.amount))
        || (b.tax_amount !== undefined && round2(b.tax_amount) !== round2(bill.tax_amount))
        || (b.supplier_id !== undefined && Number(b.supplier_id) !== Number(bill.supplier_id))
        || (b.vendor_invoice_number !== undefined && String(b.vendor_invoice_number || '').trim() !== String(bill.vendor_invoice_number || ''))
        || (b.currency !== undefined && (b.currency || null) !== (bill.currency || null));
      if (changed)
        return res.status(400).json({ error: 'This bill is a matched consignment settlement — its vendor, invoice # and amounts can only change by voiding it and matching the invoice again' });
    }
    const body = { ...req.body, supplier_id: req.body.supplier_id || bill.supplier_id };
    let cur;
    try { cur = await billCurrency(body, bill); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    if (cur.currency && body.currency !== undefined) { body.amount = cur.amount; if (body.tax_fx != null) body.tax_amount = round2(Number(body.tax_fx) * cur.exchange_rate); }
    if (bill.paid > 0 && (cur.currency || null) !== (bill.currency || null)) return res.status(400).json({ error: 'The currency cannot be changed once payments are applied' });
    if (bill.paid > 0 && Number(body.supplier_id) !== Number(bill.supplier_id)) return res.status(400).json({ error: 'The vendor cannot be changed once payments are applied' });
    const err = await validateBill(body, bill.id);
    if (err) return res.status(400).json({ error: err });
    const amount = round2(body.amount);
    if (amount < round2(bill.paid)) return res.status(400).json({ error: `Amount cannot be less than the ${round2(bill.paid).toFixed(2)} already paid` });
    // A caller that doesn't send the GCT keeps what the bill has.
    const tax = body.tax_amount === undefined ? round2(bill.tax_amount) : round2(body.tax_amount);
    if (tax > amount) return res.status(400).json({ error: 'GCT cannot be more than the bill amount' });
    await db.execute({
      sql: 'UPDATE ap_bills SET supplier_id=?, vendor_invoice_number=?, po_id=?, branch_id=?, bill_date=?, due_date=?, amount=?, tax_amount=?, description=?, currency=?, exchange_rate=?, amount_fx=? WHERE id=?',
      args: [body.supplier_id, String(body.vendor_invoice_number || '').trim() || null, body.po_id || null, body.branch_id || null,
        body.bill_date, body.due_date || bill.due_date, amount, tax, body.description || null,
        cur.currency, cur.exchange_rate, cur.currency ? (body.currency !== undefined ? cur.amount_fx : round2(amount / cur.exchange_rate)) : null, bill.id],
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
    // A consignment settlement's bill: its invoice goes back to matched.
    if (bill.consignment_settlement_id) await require('../lib/consignmentSettlement').afterBillVoid(db, bill, req.employee?.id);
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
    if (payment.method === 'contra') return res.status(400).json({ error: `This is the supplier side of contra ${payment.reference || ''} — a contra offset can't be voided on one side only` });
    await db.execute({
      sql: "UPDATE ap_payments SET status = 'void', void_reason = ?, voided_by = ?, voided_at = CURRENT_TIMESTAMP WHERE id = ?",
      args: [reason, req.employee?.id || null, payment.id],
    });
    // Its request has that much to pay again (Paid → Approved if it no longer covers it).
    if (payment.payment_request_id) await require('./payment-requests').reopenAfterVoid(db, payment.payment_request_id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Payment detail, applying, proof of payment ────────────
// One payment with what it was applied to, what's left on the vendor's
// account (unapplied), proof of payment, payment advices sent and — while
// some is unapplied — the vendor's open bills it could go on.
router.get('/payments/:id', requirePermission('payables'), async (req, res) => {
  try {
    const p = await loadPayment(req.params.id);
    if (!p) return res.status(404).json({ error: 'Payment not found' });
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function loadPayment(id) {
  const { rows: [p] } = await db.execute({
    sql: `SELECT p.*, s.name AS supplier_name, s.supplier_number, s.email AS supplier_email, s.contact_name AS supplier_contact, s.address AS supplier_address, s.city AS supplier_city, s.state AS supplier_state, s.zip AS supplier_zip,
            po.po_number, r.request_number, r.request_type, e.first_name || ' ' || e.last_name AS created_by_name, ${UNAPPLIED_SQL} AS unapplied
          FROM ap_payments p JOIN suppliers s ON s.id = p.supplier_id
          LEFT JOIN purchase_orders po ON po.id = p.po_id LEFT JOIN payment_requests r ON r.id = p.payment_request_id
          LEFT JOIN employees e ON e.id = p.created_by WHERE p.id = ?`,
    args: [id],
  });
  if (!p) return null;
  p.unapplied = round2(p.unapplied);
  // Its share in its own currency (a foreign payment), at the rate it was booked at.
  p.unapplied_fx = p.currency && Number(p.amount) > 0 && Number(p.amount_fx) > 0 ? round2(p.unapplied * Number(p.amount_fx) / Number(p.amount)) : null;
  const [{ rows: allocations }, { rows: attachments }, { rows: advices }] = await Promise.all([
    db.execute({
      sql: `SELECT a.id, a.amount, a.amount_fx, b.id AS bill_id, b.bill_number, b.vendor_invoice_number, b.bill_date, b.po_id, bpo.po_number AS bill_po_number
            FROM ap_payment_allocations a JOIN ap_bills b ON b.id = a.bill_id LEFT JOIN purchase_orders bpo ON bpo.id = b.po_id WHERE a.payment_id = ? ORDER BY a.id`,
      args: [p.id],
    }),
    db.execute({ sql: `SELECT a.id, a.original_name, a.size, a.uploaded_at, e.first_name || ' ' || e.last_name AS uploaded_by_name FROM ap_payment_attachments a LEFT JOIN employees e ON e.id = a.uploaded_by WHERE a.payment_id = ? ORDER BY a.id`, args: [p.id] }),
    db.execute({ sql: `SELECT d.id, d.sent_to, d.cc, d.subject, d.sent_at, d.stored_name IS NOT NULL AS has_copy, e.first_name || ' ' || e.last_name AS sent_by_name FROM payment_advice_sends d LEFT JOIN employees e ON e.id = d.sent_by WHERE d.payment_id = ? ORDER BY d.id DESC`, args: [p.id] }),
  ]);
  p.allocations = allocations;
  p.attachments = attachments;
  p.advices = advices;
  p.open_bills = [];
  if (p.status === 'posted' && p.unapplied > 0.005) {
    const { rows } = await db.execute({
      sql: `${billSelect} WHERE b.supplier_id = ? AND b.status != 'void' AND b.amount - ${PAID_SQL} > 0.005 ORDER BY b.due_date, b.id`,
      args: [p.supplier_id],
    });
    p.open_bills = rows.map(b => decorateBill(b, today()));
  }
  return p;
}

// Apply what's unapplied on a payment (an advance / COD payment, or the rest
// of one) to the vendor's bills: { allocations: [{ bill_id, amount }] } in base
// currency. Only the Payables records change — the money left the bank when
// the payment was posted, so RetailPOS Books posts nothing for this.
router.post('/payments/:id/apply', requirePermission('payables_payments'), async (req, res) => {
  const list = Array.isArray(req.body.allocations) ? req.body.allocations.map(a => ({ bill_id: Number(a.bill_id), amount: round2(a.amount) })).filter(a => a.amount > 0) : [];
  if (!list.length) return res.status(400).json({ error: 'Enter an amount to apply to at least one bill' });
  const tx = await db.transaction('write');
  let committed = false;
  try {
    const { rows: [p] } = await tx.execute({ sql: `SELECT p.*, ${UNAPPLIED_SQL} AS unapplied FROM ap_payments p WHERE p.id = ?`, args: [req.params.id] });
    if (!p) throw Object.assign(new Error('Payment not found'), { status: 404 });
    if (p.status !== 'posted') throw Object.assign(new Error('This payment is void'), { status: 400 });
    if (p.method === 'contra') throw Object.assign(new Error('A contra offset is applied from the contra itself'), { status: 400 });
    const total = round2(list.reduce((t, a) => t + a.amount, 0));
    if (total - round2(p.unapplied) > 0.005) throw Object.assign(new Error(`Only ${round2(p.unapplied).toFixed(2)} is left on ${p.payment_number} to apply`), { status: 400 });
    const fxPerBase = p.currency && Number(p.amount) > 0 && Number(p.amount_fx) > 0 ? Number(p.amount_fx) / Number(p.amount) : 0;
    for (const a of list) {
      const { rows: [b] } = await tx.execute({ sql: `SELECT b.*, ${PAID_SQL} AS paid FROM ap_bills b WHERE b.id = ?`, args: [a.bill_id] });
      if (!b || Number(b.supplier_id) !== Number(p.supplier_id)) throw Object.assign(new Error('That bill isn\'t one of this vendor\'s'), { status: 400 });
      if (b.status === 'void') throw Object.assign(new Error(`Bill ${b.bill_number} is void`), { status: 400 });
      const balance = round2(b.amount - b.paid);
      if (a.amount - balance > 0.005) throw Object.assign(new Error(`Only ${balance.toFixed(2)} is owed on bill ${b.bill_number}`), { status: 400 });
      await tx.execute({ sql: 'INSERT INTO ap_payment_allocations (payment_id, bill_id, amount, amount_fx) VALUES (?,?,?,?)', args: [p.id, b.id, a.amount, fxPerBase ? round2(a.amount * fxPerBase) : null] });
    }
    await tx.commit();
    committed = true;
    res.json(await loadPayment(p.id));
  } catch (e) {
    if (!committed) await tx.rollback().catch(() => {});
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Proof of payment (bank confirmation, cheque copy) — download-only.
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { cloudUpload } = require('../lib/cloudinary');
const proofDir = path.join(__dirname, '../uploads/ap-payment-attachments');
const proofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype)),
});
router.post('/payments/:id/attachments', requirePermission('payables_payments'), (req, res, next) => {
  proofUpload.array('files', 10)(req, res, err => err ? res.status(400).json({ error: err.message }) : next());
}, async (req, res) => {
  try {
    const { rows: [p] } = await db.execute({ sql: 'SELECT id FROM ap_payments WHERE id = ?', args: [req.params.id] });
    if (!p) return res.status(404).json({ error: 'Payment not found' });
    if (!req.files?.length) return res.status(400).json({ error: 'Attach a PDF or image of the proof of payment' });
    for (const f of req.files) {
      let stored;
      const up = await cloudUpload(f.buffer, { folder: 'ap-payment-attachments', resource_type: 'auto' }).catch(() => null);
      if (up?.secure_url) stored = up.secure_url;
      else {
        fs.mkdirSync(proofDir, { recursive: true });
        stored = `payment-${p.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${path.extname(f.originalname).toLowerCase()}`;
        fs.writeFileSync(path.join(proofDir, stored), f.buffer);
      }
      await db.execute({ sql: 'INSERT INTO ap_payment_attachments (payment_id, original_name, stored_name, mime_type, size, uploaded_by) VALUES (?,?,?,?,?,?)', args: [p.id, f.originalname, stored, f.mimetype, f.size, req.employee?.id || null] });
    }
    res.json((await loadPayment(p.id)).attachments);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/payments/:id/attachments/:aid/download', requirePermission('payables'), async (req, res) => {
  try {
    const { rows: [a] } = await db.execute({ sql: 'SELECT * FROM ap_payment_attachments WHERE id = ? AND payment_id = ?', args: [req.params.aid, req.params.id] });
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.stored_name.startsWith('https://')) return res.redirect(a.stored_name);
    const file = path.join(proofDir, path.basename(a.stored_name));
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'The file is missing' });
    res.download(file, a.original_name);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/payments/:id/attachments/:aid', requirePermission('payables_payments'), async (req, res) => {
  try {
    const { rows: [a] } = await db.execute({ sql: 'SELECT * FROM ap_payment_attachments WHERE id = ? AND payment_id = ?', args: [req.params.aid, req.params.id] });
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!a.stored_name.startsWith('https://')) { try { fs.unlinkSync(path.join(proofDir, path.basename(a.stored_name))); } catch (e) {} }
    await db.execute({ sql: 'DELETE FROM ap_payment_attachments WHERE id = ?', args: [a.id] });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The copy of a payment advice as it was emailed (routes/email.js keeps it).
router.get('/payments/:id/advices/:sid/download', requirePermission('payables'), async (req, res) => {
  try {
    const { rows: [d] } = await db.execute({ sql: 'SELECT d.*, p.payment_number FROM payment_advice_sends d JOIN ap_payments p ON p.id = d.payment_id WHERE d.id = ? AND d.payment_id = ?', args: [req.params.sid, req.params.id] });
    if (!d || !d.stored_name) return res.status(404).json({ error: 'No copy was kept of that advice' });
    const file = path.join(__dirname, '../uploads/payment-advices', path.basename(d.stored_name));
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'The file is missing' });
    res.download(file, `payment-advice-${d.payment_number}.pdf`);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── RetailPOS Books ───────────────────────────────────────
// Books' bank accounts, sent on every sync (API key payables:write): upserted
// by books_id; any not in the list is marked inactive (kept, since payments
// name it).
router.put('/bank-accounts', async (req, res) => {
  if (!req.apiKey) return res.status(403).json({ error: 'Bank accounts come from RetailPOS Books' });
  try {
    const list = Array.isArray(req.body) ? req.body : Array.isArray(req.body?.accounts) ? req.body.accounts : null;
    if (!list) return res.status(400).json({ error: 'Send the list of bank accounts' });
    const seen = [];
    for (const b of list) {
      const id = Number(b.id ?? b.books_id);
      const currency = String(b.currency || '').trim().toUpperCase();
      if (!(id > 0) || !String(b.name || '').trim() || !/^[A-Z]{3}$/.test(currency)) continue;
      seen.push(id);
      await db.execute({
        sql: `INSERT INTO ap_bank_accounts (books_id, name, bank_name, last4, currency, gl_code, active, synced_at) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
              ON CONFLICT(books_id) DO UPDATE SET name = excluded.name, bank_name = excluded.bank_name, last4 = excluded.last4, currency = excluded.currency,
                gl_code = excluded.gl_code, active = excluded.active, synced_at = CURRENT_TIMESTAMP`,
        args: [id, String(b.name).trim(), b.bank_name || null, b.last4 || null, currency, b.gl_code || null, b.active === false || b.active === 0 ? 0 : 1],
      });
    }
    await db.execute({ sql: `UPDATE ap_bank_accounts SET active = 0 WHERE books_id NOT IN (${seen.length ? seen.map(() => '?').join(',') : '0'})`, args: seen });
    res.json({ received: seen.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Supplier credit notes ─────────────────────────────────
// What a vendor credits us: reduces one or more of their bills now, or stays
// on their account (unapplied) to apply later with Apply. Stored as an
// ap_payments row (method / posting_mode 'credit_note', VCN-) so it counts
// toward bill balances, aging and statements like a payment; RetailPOS Books
// posts it from the payments feed. { supplier_id, reference (their credit
// note #), credit_date, amount (incl. GCT), tax_amount, credit_account
// 'purchases' | 'consignment', consignment_settlement_id, notes,
// allocations: [{ bill_id, amount }] }
router.post('/credit-notes', requirePermission('payables_bills'), async (req, res) => {
  const b = req.body || {};
  const amount = round2(b.amount);
  const tax = round2(b.tax_amount);
  const reference = String(b.reference || '').trim();
  if (!b.supplier_id) return res.status(400).json({ error: 'Choose the vendor' });
  if (!reference) return res.status(400).json({ error: "Enter the vendor's credit note number" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.credit_date || '')) return res.status(400).json({ error: 'Enter the credit note date' });
  if (!(amount > 0)) return res.status(400).json({ error: 'Amount must be greater than zero' });
  if (tax < 0 || tax > amount) return res.status(400).json({ error: 'GCT must be between 0 and the amount' });
  const creditAccount = b.credit_account === 'consignment' ? 'consignment' : 'purchases';
  if (!String(b.notes || '').trim()) return res.status(400).json({ error: 'Give the reason for the credit' });
  const allocations = (Array.isArray(b.allocations) ? b.allocations : []).map(a => ({ bill_id: Number(a.bill_id), amount: round2(a.amount) })).filter(a => a.bill_id && a.amount > 0);
  if (round2(allocations.reduce((t, a) => t + a.amount, 0)) > amount) return res.status(400).json({ error: "You can't apply more than the credit note" });
  const tx = await db.transaction('write');
  let committed = false;
  try {
    const { rows: [supplier] } = await tx.execute({ sql: 'SELECT id FROM suppliers WHERE id = ?', args: [b.supplier_id] });
    if (!supplier) throw Object.assign(new Error('Vendor not found'), { status: 400 });
    const { rows: [dupe] } = await tx.execute({
      sql: "SELECT payment_number FROM ap_payments WHERE supplier_id = ? AND method = 'credit_note' AND status != 'void' AND LOWER(TRIM(reference)) = LOWER(?)",
      args: [b.supplier_id, reference],
    });
    if (dupe) throw Object.assign(new Error(`Credit note ${reference} from this vendor is already entered as ${dupe.payment_number}`), { status: 400 });
    let settlementId = null;
    if (b.consignment_settlement_id) {
      const { rows: [cs] } = await tx.execute({ sql: 'SELECT id, supplier_id FROM consignment_settlements WHERE id = ?', args: [b.consignment_settlement_id] });
      if (!cs || Number(cs.supplier_id) !== Number(b.supplier_id)) throw Object.assign(new Error("That settlement isn't this vendor's"), { status: 400 });
      settlementId = cs.id;
    }
    for (const a of allocations) {
      const { rows: [bill] } = await tx.execute({ sql: `SELECT b.id, b.bill_number, b.supplier_id, b.status, b.amount - ${PAID_SQL} AS balance FROM ap_bills b WHERE b.id = ?`, args: [a.bill_id] });
      if (!bill || Number(bill.supplier_id) !== Number(b.supplier_id) || bill.status === 'void') throw Object.assign(new Error("A bill to apply it to isn't this vendor's open bill"), { status: 400 });
      if (a.amount > round2(bill.balance)) throw Object.assign(new Error(`Only ${round2(bill.balance).toFixed(2)} is owing on ${bill.bill_number}`), { status: 400 });
    }
    const number = await require('../lib/nextNumber').nextNumber(tx, 'ap_payments', 'payment_number', 'VCN-', 6);
    const ins = await tx.execute({
      sql: `INSERT INTO ap_payments (payment_number, supplier_id, payment_date, amount, method, reference, notes, status, created_by, posting_mode, tax_amount, credit_account, consignment_settlement_id)
            VALUES (?,?,?,?, 'credit_note', ?,?, 'posted', ?, 'credit_note', ?,?,?)`,
      args: [number, b.supplier_id, b.credit_date, amount, reference, String(b.notes).trim(), req.employee?.id || null, tax, creditAccount, settlementId],
    });
    const id = Number(ins.lastInsertRowid);
    for (const a of allocations) await tx.execute({ sql: 'INSERT INTO ap_payment_allocations (payment_id, bill_id, amount) VALUES (?,?,?)', args: [id, a.bill_id, a.amount] });
    if (settlementId) {
      await tx.execute({ sql: 'INSERT INTO consignment_settlement_log (settlement_id, action, details, employee_id) VALUES (?,?,?,?)', args: [settlementId, 'credit_note', JSON.stringify({ number, reference, amount }), req.employee?.id || null] });
    }
    await tx.commit();
    committed = true;
    res.status(201).json(await loadPayment(id));
  } catch (e) {
    if (!committed) await tx.rollback().catch(() => {});
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Payments Books posts as a whole (posting_mode 'payment'): Dr A/P / Cr the
// bank account they were paid from, once, keyed appay:<id>; voided ones are
// reversed. Applying them to bills is recorded without a journal. Supplier
// credit notes (posting_mode 'credit_note') come the same way: Dr A/P / Cr
// input GCT (tax_amount) / Cr the purchases account, or the Accrued
// Consignment Obligation when credit_account is 'consignment'.
router.get('/payments-feed', requirePermission('payables'), async (req, res) => {
  try {
    const { rows } = await db.execute({
      sql: `SELECT p.id, p.payment_number, p.supplier_id, s.name AS supplier_name, s.supplier_number, p.payment_date, p.amount, p.currency, p.exchange_rate, p.amount_fx,
              p.method, p.reference, p.status, p.books_bank_account_id, p.bank_account_name, p.bank_currency, po.po_number, r.request_number, ${UNAPPLIED_SQL} AS unapplied,
              p.posting_mode, p.tax_amount, p.credit_account, p.notes, cs.settlement_number
            FROM ap_payments p JOIN suppliers s ON s.id = p.supplier_id LEFT JOIN purchase_orders po ON po.id = p.po_id LEFT JOIN payment_requests r ON r.id = p.payment_request_id
            LEFT JOIN consignment_settlements cs ON cs.id = p.consignment_settlement_id
            WHERE p.posting_mode IN ('payment', 'credit_note') ORDER BY p.id`,
      args: [],
    });
    res.json(rows.map(r => ({ ...r, unapplied: round2(r.unapplied) })));
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
    // Paid but not yet applied to a bill (advances / COD payments awaiting
    // the invoice): already in the running balance, shown so it can be applied.
    const { rows: [un] } = await db.execute({ sql: `SELECT COALESCE(SUM(${UNAPPLIED_SQL}), 0) AS v FROM ap_payments p WHERE p.supplier_id = ? AND p.status = 'posted' AND p.method != 'contra'`, args: [supplier.id] });
    res.json({ supplier, lines, balance: running, available_to_apply: round2(un.v) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.loadPayment = loadPayment;
