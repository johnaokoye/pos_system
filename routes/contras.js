// Contra / barter offsets — for a business that is both our customer and our
// supplier (e.g. WINDALCO rents equipment from us and sells us fuel): what we
// owe them on their bills (A/P) is set off against what they owe us on our
// invoices (A/R), with no cash or bank movement.
//
//   draft ──submit──▶ submitted ──approve──▶ approved ──post──▶ posted
//     ▲                  │ reject / recall          │
//     └──── edit ◀───────┘ (rejected / draft)        └ cancel (any stage before posting)
//
// Raise/edit/submit/cancel: payables_contra. Approve/reject: standalone
// payables_approve, never on a contra you raised (signature via
// resolveApprovalSignature). Post: payables_payments. Every step is logged in
// contra_audit.
//
// Posting, in one transaction: a 'contra' account_payments row (no drawer,
// reference = contra #) allocated to the A/R invoices and taken off the
// customer's account_balance; a 'contra' ap_payments row allocated to the
// bills; balances before/after snapshotted on each line. Whatever isn't
// offset stays outstanding on both sides. RetailPOS Books then posts one
// journal entry per contra — Dr A/P, Cr A/R — from GET /postings-feed
// (API key payables:read) and acknowledges it (POST /postings-ack,
// payables:write); its own A/R receipt and A/P bill-payment syncs record the
// 'contra' rows with no journal of their own, so nothing is booked twice.
const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission, requireAnyPermission } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');
const { openArInvoices, insertAllocations } = require('../lib/legacyInvoices');
const { afterSaleAllocations, recheckCredit } = require('../lib/customerPayments');
const { resolveApprovalSignature } = require('../lib/signatures');
const { storeToday } = require('../lib/storeTime');

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const ACTIVE = "('submitted', 'approved')";
const canView = requireAnyPermission('payables', 'payables_approve', 'payables_contra');

class UserError extends Error {}
const fail = (res, status, error) => res.status(status).json({ error });
const sendError = (res, e) => (e instanceof UserError ? fail(res, 400, e.message) : fail(res, 500, e.message));

async function audit(executor, contraId, action, employee, details) {
  await executor.execute({
    sql: 'INSERT INTO contra_audit (contra_id, action, employee_id, details) VALUES (?,?,?,?)',
    args: [contraId, action, employee?.id || null, details ? JSON.stringify(details) : null],
  });
}

// ── Linked businesses ─────────────────────────────────────────────────────

router.get('/links', canView, async (req, res) => {
  try {
    const { rows } = await db.execute(`SELECT s.id AS supplier_id, s.name AS supplier_name, s.supplier_number,
        c.id AS customer_id, c.customer_number, TRIM(COALESCE(c.business_name, '') || CASE WHEN c.business_name IS NOT NULL AND c.business_name != '' THEN '' ELSE c.first_name || ' ' || c.last_name END) AS customer_name,
        c.account_balance
      FROM suppliers s JOIN customers c ON c.id = s.contra_customer_id ORDER BY s.name`);
    res.json(rows.map(r => ({ ...r, account_balance: round2(r.account_balance) })));
  } catch (e) { sendError(res, e); }
});

// { supplier_id, customer_id } links them; customer_id null unlinks. A
// customer can be linked to one supplier only. Refused while a contra
// between them is still open.
router.put('/links', requirePermission('payables_contra'), async (req, res) => {
  try {
    const supplierId = Number(req.body.supplier_id) || 0;
    const customerId = req.body.customer_id ? Number(req.body.customer_id) : null;
    const { rows: [s] } = await db.execute({ sql: 'SELECT id, name, contra_customer_id FROM suppliers WHERE id = ?', args: [supplierId] });
    if (!s) return fail(res, 404, 'Supplier not found');
    if (s.contra_customer_id && Number(s.contra_customer_id) !== customerId) {
      const { rows: [open] } = await db.execute({ sql: `SELECT contra_number FROM contras WHERE supplier_id = ? AND status IN ('draft', 'submitted', 'approved', 'rejected') LIMIT 1`, args: [s.id] });
      if (open) return fail(res, 400, `${open.contra_number} between these accounts isn't finished — post or cancel it first`);
    }
    if (customerId) {
      const { rows: [c] } = await db.execute({ sql: 'SELECT id FROM customers WHERE id = ?', args: [customerId] });
      if (!c) return fail(res, 404, 'Customer not found');
      const { rows: [other] } = await db.execute({ sql: 'SELECT name FROM suppliers WHERE contra_customer_id = ? AND id != ?', args: [customerId, s.id] });
      if (other) return fail(res, 400, `That customer is already linked to ${other.name}`);
    }
    await db.execute({ sql: 'UPDATE suppliers SET contra_customer_id = ? WHERE id = ?', args: [customerId, s.id] });
    res.json({ success: true });
  } catch (e) { sendError(res, e); }
});

// ── What's open between them ──────────────────────────────────────────────

// Each open invoice (A/R) and bill (A/P) with what's left to offset: the
// balance less what other unposted contras (and, for bills, active payment
// requests) already have on it.
async function openItems(supplierId, excludeContraId = 0) {
  const { rows: [s] } = await db.execute({ sql: 'SELECT id, name, supplier_number, contra_customer_id FROM suppliers WHERE id = ?', args: [supplierId] });
  if (!s) throw new UserError('Supplier not found');
  if (!s.contra_customer_id) throw new UserError(`${s.name} isn't linked to a customer account yet — link them first`);
  const { rows: [c] } = await db.execute({ sql: 'SELECT id, customer_number, first_name, last_name, business_name, account_balance FROM customers WHERE id = ?', args: [s.contra_customer_id] });
  if (!c) throw new UserError('The linked customer no longer exists');

  const reserved = async (col, side) => {
    const { rows } = await db.execute({
      sql: `SELECT l.${col} AS id, SUM(l.amount) AS amt FROM contra_lines l JOIN contras k ON k.id = l.contra_id
            WHERE l.side = ? AND l.${col} IS NOT NULL AND k.status IN ${ACTIVE} AND k.id != ? GROUP BY l.${col}`,
      args: [side, excludeContraId],
    });
    return new Map(rows.map(r => [Number(r.id), round2(r.amt)]));
  };
  const [resSale, resLegacy, resBill] = await Promise.all([reserved('transaction_id', 'ar'), reserved('legacy_invoice_id', 'ar'), reserved('bill_id', 'ap')]);

  const invoices = (await openArInvoices(db, c.id)).map(i => {
    const legacy = i.kind === 'legacy';
    const held = (legacy ? resLegacy.get(Number(i.legacy_invoice_id)) : resSale.get(Number(i.id))) || 0;
    return {
      key: legacy ? `L${i.legacy_invoice_id}` : `T${i.id}`, kind: i.kind, transaction_id: legacy ? null : i.id, legacy_invoice_id: legacy ? i.legacy_invoice_id : null,
      number: i.transaction_number, date: i.created_at, total: round2(i.total), balance: round2(i.balance_due), reserved: held,
      room: round2(Math.max(0, i.balance_due - held)),
    };
  });

  const { rows: bills } = await db.execute({
    sql: `SELECT b.id, b.bill_number, b.vendor_invoice_number, b.bill_date, b.due_date, b.amount,
            b.amount - (SELECT COALESCE(SUM(a.amount), 0) FROM ap_payment_allocations a JOIN ap_payments p ON p.id = a.payment_id AND p.status = 'posted' WHERE a.bill_id = b.id) AS balance,
            (SELECT COALESCE(SUM(rl.amount), 0) FROM payment_request_lines rl JOIN payment_requests r ON r.id = rl.request_id
              WHERE rl.bill_id = b.id AND r.status IN ('submitted', 'approved')) AS requested
          FROM ap_bills b WHERE b.supplier_id = ? AND b.status = 'open' ORDER BY b.bill_date, b.id`,
    args: [s.id],
  });
  const apBills = bills.map(b => {
    const held = round2((resBill.get(Number(b.id)) || 0) + Number(b.requested || 0));
    return {
      key: `B${b.id}`, bill_id: b.id, number: b.bill_number, vendor_invoice_number: b.vendor_invoice_number, date: b.bill_date, due_date: b.due_date,
      total: round2(b.amount), balance: round2(b.balance), reserved: held, room: round2(Math.max(0, b.balance - held)),
    };
  }).filter(b => b.balance > 0.005);

  return {
    supplier: { id: s.id, name: s.name, supplier_number: s.supplier_number },
    customer: { id: c.id, customer_number: c.customer_number, name: (c.business_name || `${c.first_name || ''} ${c.last_name || ''}`).trim(), account_balance: round2(c.account_balance) },
    invoices: invoices.filter(i => i.balance > 0.005),
    bills: apBills,
  };
}

router.get('/open-items/:supplierId', canView, async (req, res) => {
  try { res.json(await openItems(Number(req.params.supplierId), Number(req.query.exclude) || 0)); }
  catch (e) { sendError(res, e); }
});

// Checks a contra's lines against what's open now. Returns the cleaned
// { supplier_id, customer_id, ar: [...], ap: [...], amount }.
async function validate(body, contraId = 0) {
  const supplierId = Number(body.supplier_id) || 0;
  const items = await openItems(supplierId, contraId);
  const invByKey = new Map(items.invoices.map(i => [i.key, i]));
  const billByKey = new Map(items.bills.map(b => [b.key, b]));
  const ar = [], ap = [];
  const seen = new Set();
  for (const l of Array.isArray(body.lines) ? body.lines : []) {
    const amount = round2(l.amount);
    if (!(amount > 0)) continue;
    const key = l.bill_id ? `B${Number(l.bill_id)}` : l.legacy_invoice_id ? `L${Number(l.legacy_invoice_id)}` : `T${Number(l.transaction_id)}`;
    if (seen.has(key)) throw new UserError('The same invoice or bill is listed twice');
    seen.add(key);
    const doc = key[0] === 'B' ? billByKey.get(key) : invByKey.get(key);
    if (!doc) throw new UserError('One of the selected invoices or bills is no longer open between these accounts — refresh and try again');
    if (amount - doc.room > 0.005) {
      throw new UserError(doc.reserved > 0.005
        ? `${doc.number} has only ${doc.room.toFixed(2)} left to offset (${doc.reserved.toFixed(2)} of its ${doc.balance.toFixed(2)} balance is on another contra${key[0] === 'B' ? ' or payment request' : ''})`
        : `Only ${doc.balance.toFixed(2)} is outstanding on ${doc.number}`);
    }
    if (key[0] === 'B') ap.push({ side: 'ap', bill_id: doc.bill_id, amount });
    else ar.push({ side: 'ar', transaction_id: doc.transaction_id, legacy_invoice_id: doc.legacy_invoice_id, amount });
  }
  if (!ar.length) throw new UserError('Choose at least one of our invoices to the customer to offset');
  if (!ap.length) throw new UserError('Choose at least one of the supplier\'s bills to offset');
  const arTotal = round2(ar.reduce((s, l) => s + l.amount, 0));
  const apTotal = round2(ap.reduce((s, l) => s + l.amount, 0));
  if (Math.abs(arTotal - apTotal) > 0.005) {
    throw new UserError(`The two sides must be equal: ${arTotal.toFixed(2)} on our invoices vs ${apTotal.toFixed(2)} on their bills`);
  }
  const date = String(body.contra_date || '').trim() || storeToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UserError('The contra date is not a valid date');
  return { supplier_id: items.supplier.id, customer_id: items.customer.id, ar, ap, amount: arTotal, contra_date: date, notes: String(body.notes || '').trim() || null };
}

// ── Reading ────────────────────────────────────────────────────────────────

const CONTRA_SELECT = `SELECT k.*, s.name AS supplier_name, s.supplier_number,
    c.customer_number, TRIM(COALESCE(NULLIF(c.business_name, ''), c.first_name || ' ' || c.last_name)) AS customer_name,
    ce.first_name || ' ' || ce.last_name AS created_by_name,
    se.first_name || ' ' || se.last_name AS submitted_by_name,
    ae.first_name || ' ' || ae.last_name AS approved_by_name,
    re.first_name || ' ' || re.last_name AS rejected_by_name,
    pe.first_name || ' ' || pe.last_name AS posted_by_name,
    xe.first_name || ' ' || xe.last_name AS cancelled_by_name,
    arp.payment_number AS ar_payment_number, app.payment_number AS ap_payment_number
  FROM contras k JOIN suppliers s ON s.id = k.supplier_id JOIN customers c ON c.id = k.customer_id
  LEFT JOIN employees ce ON ce.id = k.created_by LEFT JOIN employees se ON se.id = k.submitted_by
  LEFT JOIN employees ae ON ae.id = k.approved_by LEFT JOIN employees re ON re.id = k.rejected_by
  LEFT JOIN employees pe ON pe.id = k.posted_by LEFT JOIN employees xe ON xe.id = k.cancelled_by
  LEFT JOIN account_payments arp ON arp.id = k.ar_payment_id LEFT JOIN ap_payments app ON app.id = k.ap_payment_id`;

async function loadContra(id) {
  const { rows: [k] } = await db.execute({ sql: `${CONTRA_SELECT} WHERE k.id = ?`, args: [id] });
  if (!k) return null;
  const { rows: lines } = await db.execute({
    sql: `SELECT l.*,
            CASE WHEN l.bill_id IS NOT NULL THEN b.bill_number WHEN l.legacy_invoice_id IS NOT NULL THEN li.invoice_number ELSE t.transaction_number END AS number,
            CASE WHEN l.bill_id IS NOT NULL THEN b.bill_date WHEN l.legacy_invoice_id IS NOT NULL THEN li.invoice_date ELSE t.created_at END AS doc_date,
            CASE WHEN l.bill_id IS NOT NULL THEN b.amount WHEN l.legacy_invoice_id IS NOT NULL THEN li.amount ELSE t.total END AS doc_total,
            b.vendor_invoice_number, CASE WHEN l.legacy_invoice_id IS NOT NULL THEN 1 ELSE 0 END AS is_legacy
          FROM contra_lines l LEFT JOIN ap_bills b ON b.id = l.bill_id LEFT JOIN ar_legacy_invoices li ON li.id = l.legacy_invoice_id
          LEFT JOIN transactions t ON t.id = l.transaction_id WHERE l.contra_id = ? ORDER BY l.side, l.id`,
    args: [id],
  });
  // Before posting, show each line's current balance (what's left is what
  // the offset would leave); once posted, the snapshot.
  if (k.status !== 'posted') {
    try {
      const items = await openItems(k.supplier_id, k.id);
      const bal = new Map([...items.invoices, ...items.bills].map(d => [d.key, d.balance]));
      for (const l of lines) {
        const key = l.bill_id ? `B${l.bill_id}` : l.legacy_invoice_id ? `L${l.legacy_invoice_id}` : `T${l.transaction_id}`;
        l.balance_before = bal.has(key) ? bal.get(key) : 0;
        l.balance_after = round2(l.balance_before - l.amount);
      }
    } catch (e) { /* link removed — leave balances blank */ }
  }
  k.lines = lines.map(l => ({ ...l, amount: round2(l.amount), doc_total: round2(l.doc_total) }));
  k.ar_lines = k.lines.filter(l => l.side === 'ar');
  k.ap_lines = k.lines.filter(l => l.side === 'ap');
  const { rows: trail } = await db.execute({
    sql: `SELECT a.*, e.first_name || ' ' || e.last_name AS employee_name FROM contra_audit a LEFT JOIN employees e ON e.id = a.employee_id WHERE a.contra_id = ? ORDER BY a.id`,
    args: [id],
  });
  k.audit = trail;
  return k;
}

router.get('/', canView, async (req, res) => {
  try {
    const where = [], args = [];
    const status = String(req.query.status || '');
    if (status === 'open') where.push("k.status IN ('draft', 'submitted', 'approved', 'rejected')");
    else if (status) { where.push('k.status = ?'); args.push(status); }
    if (req.query.supplier_id) { where.push('k.supplier_id = ?'); args.push(Number(req.query.supplier_id)); }
    const q = String(req.query.q || '').trim();
    if (q) { where.push('(k.contra_number LIKE ? OR s.name LIKE ? OR c.first_name || \' \' || c.last_name LIKE ? OR c.business_name LIKE ? OR k.notes LIKE ?)'); args.push(...Array(5).fill(`%${q}%`)); }
    const { rows } = await db.execute({ sql: `${CONTRA_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY k.id DESC LIMIT 300`, args });
    res.json(rows);
  } catch (e) { sendError(res, e); }
});

// ── RetailPOS Books: GL queue (declared before /:id) ───────────────────────

router.get('/postings-feed', canView, async (req, res) => {
  try {
    const { rows } = await db.execute(`${CONTRA_SELECT} WHERE k.status = 'posted' AND k.gl_status = 'pending' ORDER BY k.id LIMIT 500`);
    res.json(rows.map(k => ({
      id: k.id, external_id: `contra:${k.id}`, contra_number: k.contra_number, date: k.contra_date || String(k.posted_at).slice(0, 10),
      amount: round2(k.amount), supplier_id: k.supplier_id, supplier_name: k.supplier_name, customer_id: k.customer_id, customer_name: k.customer_name,
      ar_payment_number: k.ar_payment_number, ap_payment_number: k.ap_payment_number, notes: k.notes,
    })));
  } catch (e) { sendError(res, e); }
});

router.post('/postings-ack', canView, async (req, res) => {
  try {
    const { rows: [k] } = await db.execute({ sql: 'SELECT * FROM contras WHERE id = ?', args: [Number(req.body.id) || 0] });
    if (!k || !k.gl_status) return fail(res, 404, 'Contra posting not found');
    const who = req.apiKey ? null : req.employee;
    if (req.body.status === 'posted') {
      const ref = String(req.body.external_ref || '').trim();
      if (!ref) return fail(res, 400, 'external_ref is required');
      if (k.gl_status === 'posted') {
        if (k.gl_ref && k.gl_ref !== ref) return res.status(409).json({ error: `Already posted as ${k.gl_ref} — duplicate entry ${ref} refused`, external_ref: k.gl_ref });
        return res.json({ success: true, already: true });
      }
      await db.execute({ sql: "UPDATE contras SET gl_status = 'posted', gl_ref = ?, gl_error = NULL, gl_posted_at = CURRENT_TIMESTAMP WHERE id = ?", args: [ref, k.id] });
      await audit(db, k.id, 'gl_posted', who, { by: req.apiKey ? 'RetailPOS Books' : undefined, journal: ref });
      return res.json({ success: true });
    }
    if (req.body.status === 'failed') {
      if (k.gl_status === 'posted') return fail(res, 409, 'Already posted');
      const error = String(req.body.error || 'Posting failed').slice(0, 1000);
      await db.execute({ sql: "UPDATE contras SET gl_status = 'failed', gl_error = ? WHERE id = ?", args: [error, k.id] });
      await audit(db, k.id, 'gl_failed', who, { by: req.apiKey ? 'RetailPOS Books' : undefined, error });
      return res.json({ success: true });
    }
    fail(res, 400, "status must be 'posted' or 'failed'");
  } catch (e) { sendError(res, e); }
});

router.get('/:id', canView, async (req, res) => {
  try {
    const k = await loadContra(req.params.id);
    if (!k) return fail(res, 404, 'Contra not found');
    res.json(k);
  } catch (e) { sendError(res, e); }
});

// ── Raising and editing ────────────────────────────────────────────────────

async function writeLines(tx, contraId, v) {
  await tx.execute({ sql: 'DELETE FROM contra_lines WHERE contra_id = ?', args: [contraId] });
  for (const l of [...v.ar, ...v.ap]) {
    await tx.execute({
      sql: 'INSERT INTO contra_lines (contra_id, side, transaction_id, legacy_invoice_id, bill_id, amount) VALUES (?,?,?,?,?,?)',
      args: [contraId, l.side, l.transaction_id || null, l.legacy_invoice_id || null, l.bill_id || null, l.amount],
    });
  }
}

async function inTransaction(fn) {
  const tx = await db.transaction('write');
  let committed = false;
  try {
    const out = await fn(tx);
    await tx.commit();
    committed = true;
    return out;
  } catch (e) {
    // Never roll back after a commit — that throws and crashes the process.
    if (!committed) await tx.rollback();
    throw e;
  }
}

router.post('/', requirePermission('payables_contra'), async (req, res) => {
  try {
    const v = await validate(req.body);
    const submit = !!req.body.submit;
    const id = await inTransaction(async tx => {
      const number = await nextNumber(tx, 'contras', 'contra_number', 'CTR-', 6);
      const r = await tx.execute({
        sql: `INSERT INTO contras (contra_number, supplier_id, customer_id, amount, contra_date, notes, status, created_by, submitted_by, submitted_at)
              VALUES (?,?,?,?,?,?,?,?,?,${submit ? 'CURRENT_TIMESTAMP' : 'NULL'})`,
        args: [number, v.supplier_id, v.customer_id, v.amount, v.contra_date, v.notes, submit ? 'submitted' : 'draft', req.employee?.id || null, submit ? req.employee?.id || null : null],
      });
      const cid = Number(r.lastInsertRowid);
      await writeLines(tx, cid, v);
      await audit(tx, cid, 'created', req.employee, { amount: v.amount });
      if (submit) await audit(tx, cid, 'submitted', req.employee);
      return cid;
    });
    res.status(201).json(await loadContra(id));
  } catch (e) { sendError(res, e); }
});

router.put('/:id', requirePermission('payables_contra'), async (req, res) => {
  try {
    const { rows: [cur] } = await db.execute({ sql: 'SELECT * FROM contras WHERE id = ?', args: [req.params.id] });
    if (!cur) return fail(res, 404, 'Contra not found');
    if (!['draft', 'rejected'].includes(cur.status)) return fail(res, 400, `Only a draft or rejected contra can be changed (this one is ${cur.status})`);
    const v = await validate({ ...req.body, supplier_id: cur.supplier_id }, cur.id);
    const submit = !!req.body.submit;
    await inTransaction(async tx => {
      await tx.execute({
        sql: `UPDATE contras SET amount = ?, contra_date = ?, notes = ?, status = ?, customer_id = ?,
                submitted_by = ?, submitted_at = ${submit ? 'CURRENT_TIMESTAMP' : 'NULL'}, rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL WHERE id = ?`,
        args: [v.amount, v.contra_date, v.notes, submit ? 'submitted' : 'draft', v.customer_id, submit ? req.employee?.id || null : null, cur.id],
      });
      await writeLines(tx, cur.id, v);
      await audit(tx, cur.id, 'edited', req.employee, { amount: v.amount });
      if (submit) await audit(tx, cur.id, 'submitted', req.employee);
    });
    res.json(await loadContra(cur.id));
  } catch (e) { sendError(res, e); }
});

// Re-checks the saved lines against what's open now.
async function recheck(k) {
  return validate({
    supplier_id: k.supplier_id, contra_date: k.contra_date, notes: k.notes,
    lines: k.lines.map(l => ({ transaction_id: l.transaction_id, legacy_invoice_id: l.legacy_invoice_id, bill_id: l.bill_id, amount: l.amount })),
  }, k.id);
}

router.post('/:id/submit', requirePermission('payables_contra'), async (req, res) => {
  try {
    const k = await loadContra(req.params.id);
    if (!k) return fail(res, 404, 'Contra not found');
    if (k.status !== 'draft') return fail(res, 400, `Only a draft can be submitted (this one is ${k.status})`);
    await recheck(k);
    await db.execute({ sql: "UPDATE contras SET status = 'submitted', submitted_by = ?, submitted_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'draft'", args: [req.employee?.id || null, k.id] });
    await audit(db, k.id, 'submitted', req.employee);
    res.json(await loadContra(k.id));
  } catch (e) { sendError(res, e); }
});

router.post('/:id/recall', requirePermission('payables_contra'), async (req, res) => {
  try {
    const r = await db.execute({ sql: "UPDATE contras SET status = 'draft', submitted_by = NULL, submitted_at = NULL WHERE id = ? AND status = 'submitted'", args: [req.params.id] });
    if (!r.rowsAffected) return fail(res, 400, 'Only a contra awaiting approval can be recalled');
    await audit(db, Number(req.params.id), 'recalled', req.employee);
    res.json(await loadContra(req.params.id));
  } catch (e) { sendError(res, e); }
});

// ── Approval ───────────────────────────────────────────────────────────────

router.post('/:id/approve', requirePermission('payables_approve'), async (req, res) => {
  try {
    const k = await loadContra(req.params.id);
    if (!k) return fail(res, 404, 'Contra not found');
    if (k.status !== 'submitted') return fail(res, 400, `Only a contra awaiting approval can be approved (this one is ${k.status})`);
    const me = req.employee?.id || null;
    if (me && (Number(k.created_by) === Number(me) || Number(k.submitted_by) === Number(me))) return fail(res, 403, 'You raised this contra, so someone else has to approve it');
    try { await recheck(k); } catch (e) { if (e instanceof UserError) return fail(res, 400, `${e.message} — reject it so it can be corrected`); throw e; }
    let sig;
    try { sig = await resolveApprovalSignature(db, me, req.body.signature); }
    catch (e) { return res.status(e.status || 500).json({ error: e.message, code: e.code }); }
    const r = await db.execute({
      sql: "UPDATE contras SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP, approval_signature = ? WHERE id = ? AND status = 'submitted'",
      args: [me, sig, k.id],
    });
    if (!r.rowsAffected) return fail(res, 409, 'This contra changed while you were approving it — reopen it and try again');
    await audit(db, k.id, 'approved', req.employee);
    res.json(await loadContra(k.id));
  } catch (e) { sendError(res, e); }
});

router.post('/:id/reject', requirePermission('payables_approve'), async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return fail(res, 400, 'A reason is required to reject a contra');
    // An approved contra not yet posted can also be sent back.
    const r = await db.execute({
      sql: "UPDATE contras SET status = 'rejected', rejected_by = ?, rejected_at = CURRENT_TIMESTAMP, rejection_reason = ?, approved_by = NULL, approved_at = NULL, approval_signature = NULL WHERE id = ? AND status IN ('submitted', 'approved')",
      args: [req.employee?.id || null, reason, req.params.id],
    });
    if (!r.rowsAffected) return fail(res, 400, 'Only a contra awaiting approval or posting can be rejected');
    await audit(db, Number(req.params.id), 'rejected', req.employee, { reason });
    res.json(await loadContra(req.params.id));
  } catch (e) { sendError(res, e); }
});

router.post('/:id/cancel', requirePermission('payables_contra'), async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return fail(res, 400, 'A reason is required to cancel a contra');
    const r = await db.execute({
      sql: "UPDATE contras SET status = 'cancelled', cancelled_by = ?, cancelled_at = CURRENT_TIMESTAMP, cancel_reason = ? WHERE id = ? AND status IN ('draft', 'submitted', 'approved', 'rejected')",
      args: [req.employee?.id || null, reason, req.params.id],
    });
    if (!r.rowsAffected) return fail(res, 400, 'A posted or already-cancelled contra can\'t be cancelled');
    await audit(db, Number(req.params.id), 'cancelled', req.employee, { reason });
    res.json(await loadContra(req.params.id));
  } catch (e) { sendError(res, e); }
});

// ── Posting ────────────────────────────────────────────────────────────────

router.post('/:id/post', requirePermission('payables_payments'), async (req, res) => {
  try {
    const k = await loadContra(req.params.id);
    if (!k) return fail(res, 404, 'Contra not found');
    if (k.status !== 'approved') return fail(res, 400, `Only an approved contra can be posted (this one is ${k.status})`);
    const v = await recheck(k).catch(e => { if (e instanceof UserError) throw new UserError(`${e.message} — the balances changed since approval; reject it so it can be corrected`); throw e; });
    const items = await openItems(k.supplier_id, k.id);
    const bal = new Map([...items.invoices, ...items.bills].map(d => [d.key, d.balance]));
    const keyOf = l => (l.bill_id ? `B${l.bill_id}` : l.legacy_invoice_id ? `L${l.legacy_invoice_id}` : `T${l.transaction_id}`);
    const arAllocs = v.ar.map(l => (l.legacy_invoice_id ? { legacy_invoice_id: l.legacy_invoice_id, amount: l.amount } : { transaction_id: l.transaction_id, amount: l.amount }));
    const memo = `Contra ${k.contra_number} — offset against ${k.supplier_name} bills`;

    await inTransaction(async tx => {
      const { rows: [now] } = await tx.execute({ sql: 'SELECT account_balance FROM customers WHERE id = ?', args: [k.customer_id] });
      if (v.amount - Number(now?.account_balance || 0) > 0.005) throw new UserError(`The customer's account balance (${round2(now?.account_balance).toFixed(2)}) is less than the contra amount`);
      // A/R: a non-cash receipt applied to our invoices.
      const ar = await tx.execute({
        sql: `INSERT INTO account_payments (payment_number, customer_id, employee_id, amount, payment_method, payment_mode, reference, notes, contra_id)
              VALUES (?,?,?,?,'contra','invoices',?,?,?)`,
        args: [k.contra_number, k.customer_id, req.employee?.id || null, v.amount, k.contra_number, memo, k.id],
      });
      const arId = Number(ar.lastInsertRowid);
      await insertAllocations(tx, arId, arAllocs);
      await tx.execute({ sql: 'UPDATE customers SET account_balance = account_balance - ? WHERE id = ?', args: [v.amount, k.customer_id] });
      // A/P: a non-cash payment applied to their bills.
      const apNumber = await nextNumber(tx, 'ap_payments', 'payment_number', 'APP-', 6);
      const ap = await tx.execute({
        sql: `INSERT INTO ap_payments (payment_number, supplier_id, payment_date, amount, method, reference, notes, created_by, contra_id)
              VALUES (?,?,?,?,'contra',?,?,?,?)`,
        args: [apNumber, k.supplier_id, v.contra_date, v.amount, k.contra_number, `Contra ${k.contra_number} — offset against ${k.customer_name} invoices`, req.employee?.id || null, k.id],
      });
      const apId = Number(ap.lastInsertRowid);
      for (const l of v.ap) await tx.execute({ sql: 'INSERT INTO ap_payment_allocations (payment_id, bill_id, amount) VALUES (?,?,?)', args: [apId, l.bill_id, l.amount] });
      // Snapshot each line's balance before and after.
      for (const l of k.lines) {
        const before = bal.get(keyOf(l)) ?? 0;
        await tx.execute({ sql: 'UPDATE contra_lines SET balance_before = ?, balance_after = ? WHERE id = ?', args: [before, round2(before - l.amount), l.id] });
      }
      const r = await tx.execute({
        sql: "UPDATE contras SET status = 'posted', posted_by = ?, posted_at = CURRENT_TIMESTAMP, ar_payment_id = ?, ap_payment_id = ?, gl_status = 'pending' WHERE id = ? AND status = 'approved'",
        args: [req.employee?.id || null, arId, apId, k.id],
      });
      if (!r.rowsAffected) throw new UserError('This contra changed while you were posting it — reopen it and try again');
      await audit(tx, k.id, 'posted', req.employee, { amount: v.amount, ar_payment: k.contra_number, ap_payment: apNumber });
    });
    await recheckCredit(k.customer_id);
    await afterSaleAllocations(arAllocs);
    res.json(await loadContra(k.id));
  } catch (e) { sendError(res, e); }
});

// Finance puts a failed GL posting back in the queue.
router.post('/:id/gl-retry', requirePermission('payables_payments'), async (req, res) => {
  try {
    const r = await db.execute({ sql: "UPDATE contras SET gl_status = 'pending', gl_error = NULL WHERE id = ? AND gl_status = 'failed'", args: [req.params.id] });
    if (!r.rowsAffected) return fail(res, 400, 'Only a failed posting can be retried');
    await audit(db, Number(req.params.id), 'gl_retry', req.employee);
    res.json({ success: true });
  } catch (e) { sendError(res, e); }
});

module.exports = router;
module.exports.loadContra = loadContra;
