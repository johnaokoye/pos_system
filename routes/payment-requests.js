const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db } = require('../database');
const { requirePermission, requireAnyPermission, can } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');
const { resolveApprovalSignature } = require('../lib/signatures');
const { cloudUpload, cloudDestroy } = require('../lib/cloudinary');
const { round2, PAID_SQL, createBill, applyPoAdvances } = require('../lib/payables');
const { resolvePoCurrency } = require('../lib/poLines');

// Vendor payment requests (mounted at /api/payables/payment-requests). A
// vendor is only ever paid from an approved request:
//   draft → submitted → approved | rejected → paid   (or cancelled)
// Raising/editing/submitting needs payables_requests, approving or
// rejecting needs payables_approve (and can't be your own request), and
// paying an approved one needs payables_payments. Approvers who don't hold
// `payables` still see requests so they can work the approval queue.

const TYPES = ['invoice', 'quick', 'advance'];
const PAYMENT_METHODS = ['cash', 'cheque', 'bank_transfer', 'card', 'other'];
// Requests whose amounts are spoken for — a bill or PO can't be requested
// past what's left once these are counted.
const ACTIVE = "('submitted', 'approved')";
const canView = requireAnyPermission('payables', 'payables_approve');

const REQ_SELECT = `SELECT r.*, s.name AS supplier_name, s.supplier_number, po.po_number,
  e.first_name || ' ' || e.last_name AS requested_by_name,
  ap.first_name || ' ' || ap.last_name AS approved_by_name,
  rj.first_name || ' ' || rj.last_name AS rejected_by_name,
  pd.first_name || ' ' || pd.last_name AS paid_by_name,
  cx.first_name || ' ' || cx.last_name AS cancelled_by_name,
  sc.first_name || ' ' || sc.last_name AS scheduled_by_name,
  p.payment_number, p.payment_date, p.method AS payment_method, p.reference AS payment_reference, p.status AS payment_status,
  (SELECT COUNT(*) FROM payment_request_attachments a WHERE a.request_id = r.id) AS attachment_count,
  (SELECT COALESCE(SUM(pp.amount), 0) FROM ap_payments pp WHERE pp.payment_request_id = r.id AND pp.status = 'posted') AS paid_total,
  (SELECT GROUP_CONCAT(COALESCE(b.bill_number, l.description), ', ') FROM payment_request_lines l
     LEFT JOIN ap_bills b ON b.id = l.bill_id WHERE l.request_id = r.id) AS summary
  FROM payment_requests r
  JOIN suppliers s ON s.id = r.supplier_id
  LEFT JOIN purchase_orders po ON po.id = r.po_id
  LEFT JOIN employees e ON e.id = r.requested_by
  LEFT JOIN employees ap ON ap.id = r.approved_by
  LEFT JOIN employees rj ON rj.id = r.rejected_by
  LEFT JOIN employees pd ON pd.id = r.paid_by
  LEFT JOIN employees cx ON cx.id = r.cancelled_by
  LEFT JOIN employees sc ON sc.id = r.scheduled_by
  LEFT JOIN ap_payments p ON p.id = r.payment_id`;

// A YYYY-MM-DD date from the body, or null; { error } when it isn't one.
function parseDay(v, label) {
  const raw = String(v || '').trim();
  if (!raw) return { value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) return { error: `The ${label} is not a valid date` };
  return { value: raw };
}
const NEED_REQUESTED_DATE = 'Enter the requested payment date — when the vendor needs to be paid';

async function loadRequest(id) {
  const { rows: [r] } = await db.execute({ sql: `${REQ_SELECT} WHERE r.id = ?`, args: [id] });
  if (!r) return null;
  const { rows: lines } = await db.execute({
    sql: `SELECT l.*, b.bill_number, b.vendor_invoice_number, b.bill_date, b.due_date, b.amount AS bill_amount,
            b.currency AS bill_currency, b.exchange_rate AS bill_rate, b.amount_fx AS bill_amount_fx,
            b.amount - ${PAID_SQL} AS bill_balance
          FROM payment_request_lines l LEFT JOIN ap_bills b ON b.id = l.bill_id
          WHERE l.request_id = ? ORDER BY l.id`,
    args: [r.id],
  });
  r.lines = lines.map(l => ({ ...l, bill_balance: l.bill_id ? round2(l.bill_balance) : null }));
  await attachPaid(db, r);
  return r;
}

// What's been paid on a request so far (its posted payments), per line and in
// all — base and, for a foreign-currency request, in its currency — and
// what's left: `remaining` / `remaining_fx`, and `paid_in_full`. Invoice and
// quick lines are paid through allocations to their bill (a quick line gets
// its bill on the first payment); an advance is paid as a whole. Also lists
// the payments (`payments`).
async function attachPaid(executor, r) {
  const { rows: payments } = await executor.execute({
    sql: `SELECT p.id, p.payment_number, p.payment_date, p.amount, p.amount_fx, p.currency, p.exchange_rate, p.method, p.reference, p.status,
            p.bank_account_name, p.bank_currency, e.first_name || ' ' || e.last_name AS created_by_name
          FROM ap_payments p LEFT JOIN employees e ON e.id = p.created_by
          WHERE p.payment_request_id = ? ORDER BY p.payment_date, p.id`,
    args: [r.id],
  });
  r.payments = payments;
  const posted = payments.filter(p => p.status === 'posted');
  const fx = !!r.currency;
  // A quick request paid before its lines were linked to the bills they made
  // is counted by its payments, like an advance.
  const byPayments = r.request_type === 'advance' || (r.request_type === 'quick' && r.lines.every(l => !l.bill_id));
  if (byPayments) {
    r.paid_amount = round2(posted.reduce((t, p) => t + Number(p.amount), 0));
    r.paid_amount_fx = fx ? round2(posted.reduce((t, p) => t + Number(p.amount_fx || 0), 0)) : null;
    const done = fx ? r.paid_amount_fx >= Number(r.amount_fx || 0) - 0.005 : r.paid_amount >= Number(r.amount) - 0.005;
    for (const l of r.lines) {
      l.paid = done ? round2(l.amount) : 0;
      l.paid_fx = fx ? (done ? round2(l.amount_fx) : 0) : null;
      l.remaining = done ? 0 : round2(l.amount);
      l.remaining_fx = fx ? (done ? 0 : round2(l.amount_fx)) : null;
    }
  } else {
    const ids = posted.map(p => p.id);
    const allocs = ids.length ? (await executor.execute({
      sql: `SELECT bill_id, COALESCE(SUM(amount), 0) AS amount, COALESCE(SUM(amount_fx), 0) AS amount_fx FROM ap_payment_allocations
            WHERE payment_id IN (${ids.map(() => '?').join(',')}) GROUP BY bill_id`,
      args: ids,
    })).rows : [];
    const byBill = new Map(allocs.map(a => [Number(a.bill_id), a]));
    for (const l of r.lines) {
      const a = l.bill_id ? byBill.get(Number(l.bill_id)) : null;
      l.paid = round2(a ? a.amount : 0);
      l.paid_fx = fx ? round2(a ? a.amount_fx : 0) : null;
      l.remaining = round2(Math.max(0, Number(l.amount) - l.paid));
      l.remaining_fx = fx ? round2(Math.max(0, Number(l.amount_fx || 0) - l.paid_fx)) : null;
    }
    r.paid_amount = round2(r.lines.reduce((t, l) => t + l.paid, 0));
    r.paid_amount_fx = fx ? round2(r.lines.reduce((t, l) => t + l.paid_fx, 0)) : null;
  }
  r.remaining = round2(Math.max(0, Number(r.amount) - r.paid_amount));
  r.remaining_fx = fx ? round2(Math.max(0, Number(r.amount_fx || 0) - r.paid_amount_fx)) : null;
  r.paid_in_full = fx ? r.remaining_fx <= 0.005 : r.remaining <= 0.005;
  return r;
}

// What's left to pay on a PO in base currency: its total less what's been
// paid toward it (advances, plus other payments applied to its bills) and
// advances already requested on other active requests.
async function poAdvanceRoom(executor, poId, excludeRequestId = 0) {
  const { rows: [po] } = await executor.execute({ sql: 'SELECT id, po_number, supplier_id, status, total, currency, exchange_rate FROM purchase_orders WHERE id = ?', args: [poId] });
  if (!po) return null;
  const rate = po.currency ? Number(po.exchange_rate) || 0 : 1;
  const { rows: [paid] } = await executor.execute({
    sql: `SELECT
            (SELECT COALESCE(SUM(p.amount), 0) FROM ap_payments p WHERE p.po_id = ? AND p.status = 'posted') +
            (SELECT COALESCE(SUM(a.amount), 0) FROM ap_payment_allocations a
               JOIN ap_payments p ON p.id = a.payment_id AND p.status = 'posted'
               JOIN ap_bills b ON b.id = a.bill_id
             WHERE b.po_id = ? AND (p.po_id IS NULL OR p.po_id != ?)) AS v`,
    args: [poId, poId, poId],
  });
  // A part-paid request only holds what's still unpaid on it — what it has
  // paid is already in `paid` above.
  const { rows: [pending] } = await executor.execute({
    sql: `SELECT COALESCE(SUM(r.amount - (SELECT COALESCE(SUM(p.amount), 0) FROM ap_payments p WHERE p.payment_request_id = r.id AND p.status = 'posted')), 0) AS v
          FROM payment_requests r WHERE r.po_id = ? AND r.request_type = 'advance' AND r.status IN ${ACTIVE} AND r.id != ?`,
    args: [poId, excludeRequestId],
  });
  const total = round2(Number(po.total) * rate);
  const available = round2(Math.max(0, total - round2(paid.v) - round2(pending.v)));
  return {
    ...po, missing_rate: !rate, total_base: total, paid: round2(paid.v), requested: round2(pending.v), available,
    available_fx: po.currency && rate ? round2(available / rate) : null,
  };
}

// Bills' balances less what other active requests already ask for on them.
async function billRoom(executor, billIds, excludeRequestId = 0) {
  if (!billIds.length) return new Map();
  const { rows } = await executor.execute({
    sql: `SELECT b.id, b.bill_number, b.supplier_id, b.status, b.currency, b.exchange_rate, b.amount - ${PAID_SQL} AS balance,
            (SELECT COALESCE(SUM(l.amount), 0) FROM payment_request_lines l JOIN payment_requests r ON r.id = l.request_id
             WHERE l.bill_id = b.id AND r.status IN ${ACTIVE} AND r.id != ?)
            -- a part-paid request only holds what's still unpaid on the bill
            - (SELECT COALESCE(SUM(a.amount), 0) FROM ap_payment_allocations a JOIN ap_payments p ON p.id = a.payment_id AND p.status = 'posted'
               JOIN payment_requests r ON r.id = p.payment_request_id
             WHERE a.bill_id = b.id AND r.status IN ${ACTIVE} AND r.id != ?)
            + (SELECT COALESCE(SUM(cl.amount), 0) FROM contra_lines cl JOIN contras k ON k.id = cl.contra_id
             WHERE cl.side = 'ap' AND cl.bill_id = b.id AND k.status IN ('submitted', 'approved')) AS requested
          FROM ap_bills b WHERE b.id IN (${billIds.map(() => '?').join(',')})`,
    args: [excludeRequestId, excludeRequestId, ...billIds],
  });
  return new Map(rows.map(b => [Number(b.id), { ...b, balance: round2(b.balance), requested: round2(b.requested) }]));
}

// Checks a request's contents against current balances. Returns
// { error } or the normalized { supplier_id, request_type, po_id, notes, lines, amount }.
async function validateRequest(body, requestId = 0) {
  const supplier_id = Number(body.supplier_id);
  const request_type = body.request_type;
  if (!supplier_id) return { error: 'Choose a vendor' };
  const { rows: [supplier] } = await db.execute({ sql: 'SELECT id FROM suppliers WHERE id = ?', args: [supplier_id] });
  if (!supplier) return { error: 'Vendor not found' };
  if (!TYPES.includes(request_type)) return { error: 'Choose the kind of payment' };
  const notes = String(body.notes || '').trim() || null;
  const rawDate = String(body.required_date || '').trim();
  if (rawDate && !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return { error: 'The requested payment date is not a valid date' };
  const required_date = rawDate || null;
  let lines = [];
  let po_id = null;
  // Paying in a foreign currency: lines carry amount_fx (in that currency)
  // and amount (base). A bill or PO in the same currency converts at its own
  // booked rate, so paying the foreign amount owed clears it exactly; anything
  // else converts at the payment rate.
  let pay;
  try { pay = await resolvePoCurrency(body.currency, body.exchange_rate); } catch (e) { return { error: e.message }; }
  const fx = !!pay.currency;
  if (fx && !(pay.exchange_rate > 0)) return { error: `Enter the ${pay.currency} exchange rate (JMD per ${pay.currency})` };
  const fxAmount = l => round2(fx ? (l.amount_fx ?? l.amount) : 0);
  const money = (v, code) => `${code ? `${code} ` : ''}${Number(v).toFixed(2)}`;

  if (request_type === 'invoice') {
    lines = (body.lines || []).map(l => ({ bill_id: Number(l.bill_id), amount: round2(l.amount), amount_fx: fx ? fxAmount(l) : null })).filter(l => l.bill_id);
    if (!lines.length) return { error: 'Select at least one invoice to pay' };
    if (new Set(lines.map(l => l.bill_id)).size !== lines.length) return { error: 'An invoice is listed more than once' };
    const room = await billRoom(db, lines.map(l => l.bill_id), requestId);
    for (const l of lines) {
      const b = room.get(l.bill_id);
      if (!b || Number(b.supplier_id) !== supplier_id) return { error: 'One of the invoices does not belong to this vendor' };
      if (b.status === 'void') return { error: `Bill ${b.bill_number} is void` };
      const left = round2(b.balance - b.requested);
      if (fx) {
        if (!(l.amount_fx > 0)) return { error: `Enter the amount to pay on bill ${b.bill_number}` };
        if (b.currency === pay.currency && Number(b.exchange_rate) > 0) {
          const rate = Number(b.exchange_rate);
          const leftFx = round2(Math.max(0, left) / rate);
          if (l.amount_fx - leftFx > 0.005) return { error: `${money(l.amount_fx, pay.currency)} is more than the ${money(leftFx, pay.currency)} left on bill ${b.bill_number}${b.requested > 0 ? ' (part of it is already on another request)' : ''}` };
          // Paying all that's left clears it exactly, whatever the rounding.
          l.amount = l.amount_fx >= leftFx - 0.005 ? left : round2(l.amount_fx * rate);
        } else {
          l.amount = round2(l.amount_fx * pay.exchange_rate);
        }
      }
      if (!(l.amount > 0)) return { error: `Enter the amount to pay on bill ${b.bill_number}` };
      if (l.amount > left + 0.005) {
        return { error: b.requested > 0
          ? `${l.amount.toFixed(2)} is more than the ${Math.max(0, left).toFixed(2)} left on bill ${b.bill_number} (${b.requested.toFixed(2)} is already on another request)`
          : `${l.amount.toFixed(2)} is more than the ${b.balance.toFixed(2)} still owed on bill ${b.bill_number}` };
      }
      l.description = null;
    }
  } else if (request_type === 'quick') {
    lines = (body.lines || []).map(l => {
      const amount_fx = fx ? fxAmount(l) : null;
      return { bill_id: null, description: String(l.description || '').trim(), amount: fx ? round2(amount_fx * pay.exchange_rate) : round2(l.amount), amount_fx };
    }).filter(l => l.description || l.amount);
    if (!lines.length) return { error: 'Add at least one payment line' };
    for (const l of lines) {
      if (!l.description) return { error: 'Every payment line needs a description' };
      if (!(l.amount > 0)) return { error: `Enter an amount for "${l.description}"` };
    }
  } else {
    po_id = Number(body.po_id) || null;
    if (!po_id) return { error: 'Choose the purchase order the advance is for' };
    const po = await poAdvanceRoom(db, po_id, requestId);
    if (!po) return { error: 'Purchase order not found' };
    if (Number(po.supplier_id) !== supplier_id) return { error: 'That purchase order belongs to a different vendor' };
    if (['draft', 'cancelled'].includes(po.status)) return { error: `An advance can't be requested on a ${po.status} purchase order` };
    if (po.missing_rate) return { error: `${po.po_number} has no exchange rate — set one on the PO first` };
    let amount = round2(body.amount ?? (body.lines || [])[0]?.amount);
    let amount_fx = null;
    if (fx) {
      amount_fx = round2(body.amount_fx ?? body.amount ?? (body.lines || [])[0]?.amount_fx ?? (body.lines || [])[0]?.amount);
      if (!(amount_fx > 0)) return { error: 'Enter the advance amount' };
      if (po.currency === pay.currency) {
        // A USD advance on a USD PO is booked at the PO's rate, like its bills.
        if (amount_fx - po.available_fx > 0.005) return { error: `${money(amount_fx, pay.currency)} is more than the ${money(po.available_fx, pay.currency)} left to pay on ${po.po_number}` };
        amount = amount_fx >= po.available_fx - 0.005 ? po.available : round2(amount_fx * Number(po.exchange_rate));
      } else amount = round2(amount_fx * pay.exchange_rate);
    }
    if (!(amount > 0)) return { error: 'Enter the advance amount' };
    if (amount > po.available + 0.005) return { error: `${amount.toFixed(2)} is more than the ${po.available.toFixed(2)} left to pay on ${po.po_number}` };
    const description = String(body.description ?? (body.lines || [])[0]?.description ?? '').trim() || `Advance payment on ${po.po_number}`;
    lines = [{ bill_id: null, description, amount, amount_fx }];
  }
  const amount = round2(lines.reduce((s, l) => s + l.amount, 0));
  const amount_fx = fx ? round2(lines.reduce((s, l) => s + (l.amount_fx || 0), 0)) : null;
  return { supplier_id, request_type, po_id, notes, required_date, lines, amount, currency: pay.currency, exchange_rate: fx ? pay.exchange_rate : null, amount_fx };
}

async function saveLines(executor, requestId, lines) {
  await executor.execute({ sql: 'DELETE FROM payment_request_lines WHERE request_id = ?', args: [requestId] });
  for (const l of lines) {
    await executor.execute({ sql: 'INSERT INTO payment_request_lines (request_id, bill_id, description, amount, amount_fx) VALUES (?,?,?,?,?)', args: [requestId, l.bill_id || null, l.description || null, l.amount, l.amount_fx ?? null] });
  }
}

// ── Lists & form data ──────────────────────────────────────
router.get('/', canView, async (req, res) => {
  try {
    const { status, supplier_id, q } = req.query;
    let sql = `${REQ_SELECT} WHERE 1=1`;
    const args = [];
    if (status === 'open') sql += " AND r.status IN ('draft', 'submitted', 'approved', 'rejected')";
    else if (status && status !== 'all') { sql += ' AND r.status = ?'; args.push(status); }
    if (supplier_id) { sql += ' AND r.supplier_id = ?'; args.push(supplier_id); }
    if (q) {
      sql += ` AND (r.request_number LIKE ? OR s.name LIKE ? OR po.po_number LIKE ? OR r.notes LIKE ?
        OR EXISTS (SELECT 1 FROM payment_request_lines l LEFT JOIN ap_bills b ON b.id = l.bill_id
                   WHERE l.request_id = r.id AND (l.description LIKE ? OR b.bill_number LIKE ? OR b.vendor_invoice_number LIKE ?)))`;
      const like = `%${q}%`; args.push(like, like, like, like, like, like, like);
    }
    sql += ' ORDER BY r.id DESC LIMIT 500';
    const { rows } = await db.execute({ sql, args });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// A vendor's open bills (with what other requests already ask for) and the
// POs an advance can go against — for the request form. `exclude` is the
// request being edited, so its own amounts don't count against it.
router.get('/options', requirePermission('payables_requests'), async (req, res) => {
  try {
    const supplierId = Number(req.query.supplier_id);
    const exclude = Number(req.query.exclude) || 0;
    if (!supplierId) return res.status(400).json({ error: 'supplier_id is required' });
    const { rows: billRows } = await db.execute({
      sql: `SELECT b.id FROM ap_bills b WHERE b.supplier_id = ? AND b.status != 'void' AND b.amount - ${PAID_SQL} > 0.004 ORDER BY b.due_date, b.id`,
      args: [supplierId],
    });
    const room = await billRoom(db, billRows.map(b => Number(b.id)), exclude);
    const { rows: billInfo } = billRows.length ? await db.execute({
      sql: `SELECT b.id, b.bill_number, b.vendor_invoice_number, b.bill_date, b.due_date, b.amount, b.description, po.po_number, b.currency, b.exchange_rate, b.amount_fx
            FROM ap_bills b LEFT JOIN purchase_orders po ON po.id = b.po_id WHERE b.id IN (${billRows.map(() => '?').join(',')})
            ORDER BY b.due_date, b.id`,
      args: billRows.map(b => b.id),
    }) : { rows: [] };
    const bills = billInfo.map(b => {
      const r = room.get(Number(b.id));
      return { ...b, balance: r.balance, requested: r.requested, available: round2(Math.max(0, r.balance - r.requested)) };
    });
    const { rows: poRows } = await db.execute({
      sql: "SELECT id FROM purchase_orders WHERE supplier_id = ? AND status NOT IN ('draft', 'cancelled') ORDER BY id DESC LIMIT 200",
      args: [supplierId],
    });
    const pos = [];
    for (const p of poRows) {
      const po = await poAdvanceRoom(db, p.id, exclude);
      pos.push({ id: po.id, po_number: po.po_number, status: po.status, currency: po.currency, exchange_rate: po.exchange_rate, total: round2(po.total), total_base: po.total_base, paid: po.paid, requested: po.requested, available: po.available, available_fx: po.available_fx, missing_rate: po.missing_rate });
    }
    res.json({ bills, pos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── From a purchase order (Purchasing) ─────────────────────
// Purchasing asks A/P for an advance payment on an approved PO — e.g. a
// supplier who wants a deposit before shipping, by a given date. It goes
// straight to the approval queue as a submitted advance request; A/P is
// notified through the inbox below. Needs purchasing_request_payment (or
// payables_requests). Only for an approved or part-received PO.
const canRequestFromPo = requireAnyPermission('purchasing_request_payment', 'payables_requests');

// Paying bank accounts for the Process Payment screen.
router.get('/bank-accounts', requirePermission('payables_payments'), async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: 'SELECT * FROM ap_bank_accounts WHERE active = 1 ORDER BY currency, name', args: [] });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/for-po/:poId', requireAnyPermission('purchasing', 'payables', 'payables_approve'), async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: `${REQ_SELECT} WHERE r.po_id = ? ORDER BY r.id DESC`, args: [req.params.poId] });
    const room = await poAdvanceRoom(db, req.params.poId);
    res.json({ requests: rows, room: room ? { total_base: room.total_base, paid: room.paid, requested: room.requested, available: room.available, missing_rate: room.missing_rate } : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/from-po/:poId', canRequestFromPo, async (req, res) => {
  try {
    const { rows: [po] } = await db.execute({ sql: 'SELECT id, po_number, supplier_id, status FROM purchase_orders WHERE id = ?', args: [req.params.poId] });
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (!['approved', 'partial'].includes(po.status)) {
      return res.status(400).json({ error: `A payment can only be requested on an approved purchase order (${po.po_number} is ${po.status})` });
    }
    const v = await validateRequest({
      supplier_id: po.supplier_id, request_type: 'advance', po_id: po.id,
      amount: req.body.amount, amount_fx: req.body.amount_fx, description: req.body.description, notes: req.body.notes, required_date: req.body.required_date,
      currency: req.body.currency, exchange_rate: req.body.exchange_rate,
    });
    if (v.error) return res.status(400).json({ error: v.error });
    if (!v.required_date) return res.status(400).json({ error: NEED_REQUESTED_DATE });
    const tx = await db.transaction('write');
    let committed = false;
    try {
      const request_number = await nextNumber(tx, 'payment_requests', 'request_number', 'PRQ-', 6);
      const result = await tx.execute({
        sql: `INSERT INTO payment_requests (request_number, supplier_id, request_type, po_id, amount, notes, required_date, status, requested_by, submitted_at, currency, exchange_rate, amount_fx)
              VALUES (?,?,?,?,?,?,?,'submitted',?,CURRENT_TIMESTAMP,?,?,?)`,
        args: [request_number, v.supplier_id, v.request_type, v.po_id, v.amount, v.notes, v.required_date, req.employee?.id || null, v.currency, v.exchange_rate, v.amount_fx],
      });
      const id = Number(result.lastInsertRowid);
      await saveLines(tx, id, v.lines);
      await tx.commit();
      committed = true;
      res.status(201).json(await loadRequest(id));
    } catch (e) {
      if (!committed) await tx.rollback().catch(() => {});
      throw e;
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── A/P notifications ──────────────────────────────────────
// What's waiting on the signed-in person, polled by the frontend every
// minute: requests to approve (payables_approve — not their own) and
// approved requests to pay (payables_payments). Soonest pay-by date first.
router.get('/inbox', canView, async (req, res) => {
  try {
    const perms = req.employee?.permissions;
    const me = req.employee?.id || 0;
    const parts = [];
    const args = [];
    if (can(perms, 'payables_approve')) { parts.push("(r.status = 'submitted' AND COALESCE(r.requested_by, 0) != ?)"); args.push(me); }
    if (can(perms, 'payables_payments')) parts.push("r.status = 'approved'");
    if (!parts.length) return res.json({ count: 0, requests: [] });
    const { rows } = await db.execute({
      sql: `${REQ_SELECT} WHERE (${parts.join(' OR ')}) ORDER BY CASE WHEN COALESCE(r.scheduled_date, r.required_date) IS NULL THEN 1 ELSE 0 END, COALESCE(r.scheduled_date, r.required_date), r.id LIMIT 100`,
      args,
    });
    res.json({ count: rows.length, requests: rows.map(r => ({ ...r, stage: r.status === 'submitted' ? 'approve' : 'pay' })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', canView, async (req, res) => {
  try {
    const r = await loadRequest(req.params.id);
    if (!r) return res.status(404).json({ error: 'Payment request not found' });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Create / edit / submit ─────────────────────────────────
// `submit: true` saves and submits for approval in one go.
router.post('/', requirePermission('payables_requests'), async (req, res) => {
  try {
    const v = await validateRequest(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const submit = !!req.body.submit;
    if (submit && !v.required_date) return res.status(400).json({ error: NEED_REQUESTED_DATE });
    const tx = await db.transaction('write');
    let committed = false;
    try {
      const request_number = await nextNumber(tx, 'payment_requests', 'request_number', 'PRQ-', 6);
      const result = await tx.execute({
        sql: `INSERT INTO payment_requests (request_number, supplier_id, request_type, po_id, amount, notes, required_date, status, requested_by, submitted_at, currency, exchange_rate, amount_fx)
              VALUES (?,?,?,?,?,?,?,?,?,${submit ? 'CURRENT_TIMESTAMP' : 'NULL'},?,?,?)`,
        args: [request_number, v.supplier_id, v.request_type, v.po_id, v.amount, v.notes, v.required_date, submit ? 'submitted' : 'draft', req.employee?.id || null, v.currency, v.exchange_rate, v.amount_fx],
      });
      const id = Number(result.lastInsertRowid);
      await saveLines(tx, id, v.lines);
      await tx.commit();
      committed = true;
      res.status(201).json(await loadRequest(id));
    } catch (e) {
      if (!committed) await tx.rollback().catch(() => {});
      throw e;
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Draft or rejected requests only; editing a rejected one puts it back to
// draft so it goes through approval again.
router.put('/:id', requirePermission('payables_requests'), async (req, res) => {
  try {
    const { rows: [cur] } = await db.execute({ sql: 'SELECT * FROM payment_requests WHERE id = ?', args: [req.params.id] });
    if (!cur) return res.status(404).json({ error: 'Payment request not found' });
    if (!['draft', 'rejected'].includes(cur.status)) return res.status(400).json({ error: `A ${cur.status} request can't be edited` });
    const v = await validateRequest(req.body, cur.id);
    if (v.error) return res.status(400).json({ error: v.error });
    const submit = !!req.body.submit;
    if (submit && !v.required_date) return res.status(400).json({ error: NEED_REQUESTED_DATE });
    const tx = await db.transaction('write');
    let committed = false;
    try {
      await tx.execute({
        sql: `UPDATE payment_requests SET supplier_id=?, request_type=?, po_id=?, amount=?, notes=?, required_date=?, status=?, currency=?, exchange_rate=?, amount_fx=?,
                submitted_at=${submit ? 'CURRENT_TIMESTAMP' : 'NULL'}, rejected_by=NULL, rejected_at=NULL, rejection_reason=NULL,
                scheduled_date=NULL, scheduled_by=NULL, scheduled_at=NULL
              WHERE id=?`,
        args: [v.supplier_id, v.request_type, v.po_id, v.amount, v.notes, v.required_date, submit ? 'submitted' : 'draft', v.currency, v.exchange_rate, v.amount_fx, cur.id],
      });
      await saveLines(tx, cur.id, v.lines);
      await tx.commit();
      committed = true;
      res.json(await loadRequest(cur.id));
    } catch (e) {
      if (!committed) await tx.rollback().catch(() => {});
      throw e;
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Re-checks the saved lines against current balances, the same way the
// form did — run on submit and approve since bills and POs move meanwhile.
async function recheck(r) {
  const v = await validateRequest({ ...r, lines: r.lines, amount: r.amount, description: r.lines[0]?.description }, r.id);
  return v.error || null;
}

router.post('/:id/submit', requirePermission('payables_requests'), async (req, res) => {
  try {
    const r = await loadRequest(req.params.id);
    if (!r) return res.status(404).json({ error: 'Payment request not found' });
    if (r.status !== 'draft') return res.status(400).json({ error: `Only a draft can be submitted (this one is ${r.status})` });
    const err = await recheck(r);
    if (err) return res.status(400).json({ error: err });
    if (!r.required_date) return res.status(400).json({ error: `${NEED_REQUESTED_DATE} — edit the request to add it` });
    await db.execute({ sql: "UPDATE payment_requests SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'draft'", args: [r.id] });
    res.json(await loadRequest(r.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pulls a submitted request back to draft (to change it before approval).
router.post('/:id/recall', requirePermission('payables_requests'), async (req, res) => {
  try {
    const result = await db.execute({ sql: "UPDATE payment_requests SET status = 'draft', submitted_at = NULL WHERE id = ? AND status = 'submitted'", args: [req.params.id] });
    if (!result.rowsAffected) return res.status(400).json({ error: 'Only a request awaiting approval can be recalled' });
    res.json(await loadRequest(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Approval ──────────────────────────────────────────────
router.post('/:id/approve', requirePermission('payables_approve'), async (req, res) => {
  try {
    const r = await loadRequest(req.params.id);
    if (!r) return res.status(404).json({ error: 'Payment request not found' });
    if (r.status !== 'submitted') return res.status(400).json({ error: `Only a request awaiting approval can be approved (this one is ${r.status})` });
    const approverId = req.employee?.id || null;
    if (approverId && Number(r.requested_by) === Number(approverId)) {
      return res.status(403).json({ error: 'You raised this request, so someone else has to approve it' });
    }
    const err = await recheck(r);
    if (err) return res.status(400).json({ error: `${err} — send it back for changes instead` });
    // The approver schedules the payment — may differ from the requested date.
    const sched = parseDay(req.body.scheduled_date, 'scheduled payment date');
    if (sched.error) return res.status(400).json({ error: sched.error });
    if (!sched.value) return res.status(400).json({ error: 'Enter the scheduled payment date — when this will be paid' });
    let sigUrl;
    try { sigUrl = await resolveApprovalSignature(db, approverId, req.body.signature); }
    catch (e) { return res.status(e.status || 500).json({ error: e.message, code: e.code }); }
    const result = await db.execute({
      sql: `UPDATE payment_requests SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP, approval_signature = ?,
              scheduled_date = ?, scheduled_by = ?, scheduled_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'submitted'`,
      args: [approverId, sigUrl, sched.value, approverId, r.id],
    });
    if (!result.rowsAffected) return res.status(409).json({ error: 'This request changed while you were approving it — reopen it and try again' });
    res.json(await loadRequest(r.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Moves an approved (not yet paid) request's scheduled payment date. The
// requested date is never changed here.
router.patch('/:id/schedule', requirePermission('payables_approve'), async (req, res) => {
  try {
    const sched = parseDay(req.body.scheduled_date, 'scheduled payment date');
    if (sched.error) return res.status(400).json({ error: sched.error });
    if (!sched.value) return res.status(400).json({ error: 'Enter the scheduled payment date' });
    const result = await db.execute({
      sql: "UPDATE payment_requests SET scheduled_date = ?, scheduled_by = ?, scheduled_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'approved'",
      args: [sched.value, req.employee?.id || null, req.params.id],
    });
    if (!result.rowsAffected) return res.status(400).json({ error: 'Only an approved request that hasn\'t been paid can be rescheduled' });
    res.json(await loadRequest(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/reject', requirePermission('payables_approve'), async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to reject a request' });
    const result = await db.execute({
      sql: "UPDATE payment_requests SET status = 'rejected', rejected_by = ?, rejected_at = CURRENT_TIMESTAMP, rejection_reason = ? WHERE id = ? AND status = 'submitted'",
      args: [req.employee?.id || null, reason, req.params.id],
    });
    if (!result.rowsAffected) return res.status(400).json({ error: 'Only a request awaiting approval can be rejected' });
    res.json(await loadRequest(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/cancel', requirePermission('payables_requests'), async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to cancel a request' });
    const result = await db.execute({
      sql: "UPDATE payment_requests SET status = 'cancelled', cancelled_by = ?, cancelled_at = CURRENT_TIMESTAMP, cancel_reason = ? WHERE id = ? AND status IN ('draft', 'submitted', 'approved', 'rejected')",
      args: [req.employee?.id || null, reason, req.params.id],
    });
    if (!result.rowsAffected) return res.status(400).json({ error: 'This request is already paid or cancelled' });
    res.json(await loadRequest(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Paying an approved request ─────────────────────────────
// Process Payment records an ap_payments row against a request: from a bank
// account (RetailPOS Books' list, ap_bank_accounts — not needed for cash),
// on the actual payment date, for all or part of what's left. Invoice and
// quick lines are paid through allocations to their bills (a quick request
// gets a bill per line on its first payment); an advance (COD / deposit on a
// PO) is left unapplied on the vendor's account, linked to the PO and the
// request, and applied to the PO's bills as they're entered — or by hand
// (POST /payables/payments/:id/apply). The request turns Paid once its full
// amount is paid; until then it stays Approved, part paid. posting_mode
// 'payment' tells Books to post the whole payment to that bank once (Dr A/P /
// Cr bank) — applying it to bills later posts nothing more.

const NEEDS_REFERENCE = ['cheque', 'bank_transfer'];

router.post('/:id/pay', requirePermission('payables_payments'), async (req, res) => {
  try {
    const { payment_date, method } = req.body;
    const reference = String(req.body.reference || '').trim() || null;
    const notes = String(req.body.notes || '').trim() || null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payment_date || '')) return res.status(400).json({ error: 'Enter the date the payment was made' });
    if (!PAYMENT_METHODS.includes(method)) return res.status(400).json({ error: 'Choose a payment method' });
    if (NEEDS_REFERENCE.includes(method) && !reference) return res.status(400).json({ error: method === 'cheque' ? 'Enter the cheque number' : 'Enter the bank transaction reference' });
    const r0 = await loadRequest(req.params.id);
    if (!r0) return res.status(404).json({ error: 'Payment request not found' });
    if (r0.status !== 'approved') return res.status(400).json({ error: r0.status === 'paid' ? 'This request has already been paid in full' : 'Only an approved request can be paid' });

    // Foreign-currency request: the rate on the day it's paid (defaults to the
    // request's). Lines against a bill/PO in the same currency are cleared at
    // their booked rate — the gap to this rate is the realised FX gain/loss
    // Books posts; everything else converts at this rate.
    const fx = !!r0.currency;
    const payRate = fx ? (parseFloat(req.body.exchange_rate) > 0 ? parseFloat(req.body.exchange_rate) : Number(r0.exchange_rate)) : null;
    if (fx && !(payRate > 0)) return res.status(400).json({ error: `Enter the ${r0.currency} exchange rate used for this payment` });

    // The bank account: any active one in the request's currency or the base
    // currency (a foreign amount can be paid from a base account at the rate).
    const base = String(await require('../lib/settings').getSetting('currency', 'USD')).toUpperCase();
    let bank = null;
    if (req.body.bank_account_id) {
      ({ rows: [bank] } = await db.execute({ sql: 'SELECT * FROM ap_bank_accounts WHERE id = ? AND active = 1', args: [req.body.bank_account_id] }));
      if (!bank) return res.status(400).json({ error: 'That bank account is no longer available — choose another' });
      const payCurrency = r0.currency || base;
      if (bank.currency !== payCurrency && bank.currency !== base) return res.status(400).json({ error: `${bank.name} is a ${bank.currency} account — choose a ${payCurrency}${payCurrency !== base ? ` or ${base}` : ''} account` });
    } else if (method !== 'cash') {
      return res.status(400).json({ error: 'Choose the bank account the payment was made from' });
    }

    // How much (in the request's currency) and, for invoice/quick, how it's
    // split over the lines: { line_id, amount }. Defaults to all that's left.
    const amountIn = req.body.amount == null || req.body.amount === '' ? null : round2(req.body.amount);
    const allocIn = Array.isArray(req.body.allocations) ? req.body.allocations : null;

    const tx = await db.transaction('write');
    let committed = false;
    try {
      // Read again inside the write transaction, so two people paying the
      // same request can't both pay what's left.
      const { rows: [cur] } = await tx.execute({ sql: 'SELECT status FROM payment_requests WHERE id = ?', args: [r0.id] });
      if (cur.status !== 'approved') throw Object.assign(new Error(cur.status === 'paid' ? 'This request has already been paid in full' : 'Only an approved request can be paid'), { status: 400 });
      const r = { ...r0, lines: r0.lines.map(l => ({ ...l })) };
      await attachPaid(tx, r);
      const left = fx ? r.remaining_fx : r.remaining;
      if (!(left > 0.005)) throw Object.assign(new Error('This request has already been paid in full'), { status: 400 });
      const amount = amountIn == null ? left : amountIn;
      if (!(amount > 0)) throw Object.assign(new Error('Enter the amount paid'), { status: 400 });
      if (amount - left > 0.005) throw Object.assign(new Error(`Only ${fx ? `${r.currency} ` : ''}${left.toFixed(2)} is left to pay on ${r.request_number}`), { status: 400 });

      // A quick request's bills are entered on its first payment, one per
      // line at the full line amount, so later payments clear them too.
      if (r.request_type === 'quick' && r.lines.some(l => !l.bill_id)) {
        for (const l of r.lines) {
          if (l.bill_id) continue;
          const lineBase = fx ? round2(Number(l.amount_fx) * payRate) : round2(l.amount);
          const billId = await createBill(tx, {
            supplier_id: r.supplier_id, bill_date: payment_date, due_date: payment_date, amount: lineBase, tax_amount: 0,
            description: l.description, source: 'payment_request', created_by: req.employee?.id,
            currency: fx ? r.currency : null, exchange_rate: fx ? payRate : null, amount_fx: fx ? l.amount_fx : null,
          });
          await tx.execute({ sql: 'UPDATE payment_request_lines SET bill_id = ? WHERE id = ?', args: [billId, l.id] });
          l.bill_id = billId;
        }
      }

      const allocations = [];
      let amountBase, amountFx = fx ? amount : null;
      if (r.request_type === 'advance') {
        // Same-currency PO advances keep the request's booked rate; all that's
        // left clears exactly.
        let poCurrency = null;
        if (fx) ({ rows: [{ currency: poCurrency } = {}] } = await tx.execute({ sql: 'SELECT currency FROM purchase_orders WHERE id = ?', args: [r.po_id] }));
        if (!fx) amountBase = amount;
        else if (Math.abs(amount - left) <= 0.005 && poCurrency === r.currency) amountBase = r.remaining;
        else amountBase = round2(amount * (poCurrency === r.currency && Number(r.amount_fx) > 0 ? Number(r.amount) / Number(r.amount_fx) : payRate));
      } else {
        // Split over the lines: as sent, or oldest line first up to what each has left.
        const open = r.lines.filter(l => (fx ? l.remaining_fx : l.remaining) > 0.005);
        let split;
        if (allocIn) {
          split = allocIn.map(a => ({ line: r.lines.find(l => Number(l.id) === Number(a.line_id)), amount: round2(a.amount) })).filter(a => a.amount > 0);
          if (split.some(a => !a.line)) throw Object.assign(new Error('An allocation is for a line that isn\'t on this request'), { status: 400 });
        } else {
          let rest = amount;
          split = [];
          for (const l of open) {
            const take = round2(Math.min(rest, fx ? l.remaining_fx : l.remaining));
            if (take > 0) { split.push({ line: l, amount: take }); rest = round2(rest - take); }
          }
        }
        const total = round2(split.reduce((t, a) => t + a.amount, 0));
        if (Math.abs(total - amount) > 0.005) throw Object.assign(new Error(`The allocations come to ${total.toFixed(2)} but the payment is ${amount.toFixed(2)} — they have to match`), { status: 400 });
        for (const a of split) {
          const l = a.line;
          const lineLeft = fx ? l.remaining_fx : l.remaining;
          if (a.amount - lineLeft > 0.005) throw Object.assign(new Error(`Only ${lineLeft.toFixed(2)} is left to pay on ${l.bill_number || l.description || 'a line'}`), { status: 400 });
          const { rows: [bill] } = await tx.execute({ sql: `SELECT b.*, ${PAID_SQL} AS paid FROM ap_bills b WHERE b.id = ?`, args: [l.bill_id] });
          if (!bill || bill.status === 'void') throw Object.assign(new Error(`Bill ${l.bill_number || l.bill_id} is void — cancel this request and raise a new one`), { status: 400 });
          // Base value: the bill's booked rate for a bill in the request's
          // currency (all that's left on the line clears it exactly), else
          // the payment rate.
          let baseAmt;
          if (!fx) baseAmt = a.amount;
          else if (bill.currency === r.currency && Number(bill.exchange_rate) > 0) {
            const billLeftBase = round2(bill.amount - bill.paid);
            baseAmt = Math.abs(a.amount - lineLeft) <= 0.005 && Math.abs(lineLeft - round2(billLeftBase / Number(bill.exchange_rate))) <= 0.01
              ? billLeftBase : round2(a.amount * Number(bill.exchange_rate));
          } else baseAmt = round2(a.amount * payRate);
          const balance = round2(bill.amount - bill.paid);
          if (baseAmt - balance > 0.005) throw Object.assign(new Error(`Only ${balance.toFixed(2)} is still owed on bill ${bill.bill_number} — cancel this request and raise a new one`), { status: 400 });
          allocations.push({ bill_id: bill.id, amount: baseAmt, amount_fx: fx ? a.amount : null });
        }
        amountBase = round2(allocations.reduce((t, a) => t + a.amount, 0));
      }

      const payment_number = await nextNumber(tx, 'ap_payments', 'payment_number', 'APP-', 6);
      const result = await tx.execute({
        sql: `INSERT INTO ap_payments (payment_number, supplier_id, payment_date, amount, method, reference, notes, po_id, payment_request_id, created_by, currency, exchange_rate, amount_fx,
                bank_account_id, books_bank_account_id, bank_account_name, bank_currency, posting_mode)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'payment')`,
        args: [payment_number, r.supplier_id, payment_date, amountBase, method, reference, notes || r.request_number, r.request_type === 'advance' ? r.po_id : null, r.id, req.employee?.id || null,
          fx ? r.currency : null, fx ? payRate : null, amountFx,
          bank ? bank.id : null, bank ? bank.books_id : null, bank ? bank.name : null, bank ? bank.currency : null],
      });
      const paymentId = Number(result.lastInsertRowid);
      for (const a of allocations) {
        await tx.execute({ sql: 'INSERT INTO ap_payment_allocations (payment_id, bill_id, amount, amount_fx) VALUES (?,?,?,?)', args: [paymentId, a.bill_id, a.amount, a.amount_fx ?? null] });
      }
      if (r.request_type === 'advance') await applyPoAdvances(tx, r.po_id);
      // Paid in full once nothing is left; payment_id points at the latest payment.
      const paidOff = amount >= left - 0.005;
      await tx.execute({
        sql: `UPDATE payment_requests SET payment_id = ?${paidOff ? ", status = 'paid', paid_by = ?, paid_at = CURRENT_TIMESTAMP" : ''} WHERE id = ?`,
        args: paidOff ? [paymentId, req.employee?.id || null, r.id] : [paymentId, r.id],
      });
      await tx.commit();
      committed = true;
      res.json({ ...(await loadRequest(r.id)), payment_number, new_payment_id: paymentId });
    } catch (e) {
      if (!committed) await tx.rollback().catch(() => {});
      res.status(e.status || 500).json({ error: e.message });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// A voided payment from a request puts what it paid back to pay: a request
// marked Paid goes back to Approved once its posted payments no longer cover
// it. Called by POST /payables/payments/:id/void.
async function reopenAfterVoid(executor, requestId) {
  const r = await loadRequest(requestId);
  if (!r || r.status !== 'paid' || r.paid_in_full) return;
  await executor.execute({ sql: "UPDATE payment_requests SET status = 'approved', paid_by = NULL, paid_at = NULL WHERE id = ? AND status = 'paid'", args: [requestId] });
}

// ── Supporting documents ───────────────────────────────────
// Same pattern as purchase request attachments: never served statically
// (server.js blocks /uploads/payment-request-attachments), only through
// /download. Removable until the request is approved, so what the approver
// signed off on stays on the record.
const localUploadDir = path.join(__dirname, '../uploads/payment-request-attachments');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain'];
    cb(null, allowed.includes(file.mimetype));
  },
});
const ATTACHMENT_SELECT = `SELECT a.*, e.first_name || ' ' || e.last_name AS uploaded_by_name FROM payment_request_attachments a LEFT JOIN employees e ON e.id = a.uploaded_by`;

router.get('/:id/attachments', canView, async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: `${ATTACHMENT_SELECT} WHERE a.request_id = ? ORDER BY a.uploaded_at, a.id`, args: [req.params.id] });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/attachments', canRequestFromPo, (req, res, next) => {
  upload.single('file')(req, res, err => err ? res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 20 MB' : err.message }) : next());
}, async (req, res) => {
  try {
    const { rows: [r] } = await db.execute({ sql: 'SELECT id, status, requested_by FROM payment_requests WHERE id = ?', args: [req.params.id] });
    if (!r) return res.status(404).json({ error: 'Payment request not found' });
    // Purchasing (no payables_requests) only adds documents to requests they raised from a PO.
    if (!req.apiKey && !can(req.employee?.permissions, 'payables_requests') && Number(r.requested_by) !== Number(req.employee?.id)) {
      return res.status(403).json({ error: 'You can only add documents to payment requests you raised' });
    }
    if (r.status === 'cancelled') return res.status(400).json({ error: 'This request is cancelled' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded or file type not allowed' });
    const cloudResult = await cloudUpload(req.file.buffer, {
      folder: 'pos-system/payment-request-attachments',
      public_id: `${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      resource_type: 'auto',
    });
    let storedName;
    if (cloudResult) {
      storedName = cloudResult.secure_url;
    } else {
      fs.mkdirSync(localUploadDir, { recursive: true });
      storedName = `${Date.now()}-${Math.round(Math.random() * 1e6)}${path.extname(req.file.originalname)}`;
      fs.writeFileSync(path.join(localUploadDir, storedName), req.file.buffer);
    }
    const result = await db.execute({
      sql: 'INSERT INTO payment_request_attachments (request_id, original_name, stored_name, mime_type, file_size, uploaded_by) VALUES (?,?,?,?,?,?)',
      args: [r.id, req.file.originalname, storedName, req.file.mimetype, req.file.size, req.employee?.id || null],
    });
    const { rows: [row] } = await db.execute({ sql: `${ATTACHMENT_SELECT} WHERE a.id = ?`, args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/attachments/:aid/download', canView, async (req, res) => {
  try {
    const { rows: [att] } = await db.execute({ sql: 'SELECT * FROM payment_request_attachments WHERE id = ? AND request_id = ?', args: [req.params.aid, req.params.id] });
    if (!att) return res.status(404).json({ error: 'Not found' });
    if (att.stored_name.startsWith('https://')) return res.redirect(att.stored_name.replace('/upload/', '/upload/fl_attachment/'));
    const filePath = path.join(localUploadDir, att.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on server' });
    res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
    res.attachment(att.original_name);
    res.sendFile(filePath);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/attachments/:aid', requirePermission('payables_requests'), async (req, res) => {
  try {
    const { rows: [att] } = await db.execute({
      sql: 'SELECT a.*, r.status AS request_status FROM payment_request_attachments a JOIN payment_requests r ON r.id = a.request_id WHERE a.id = ? AND a.request_id = ?',
      args: [req.params.aid, req.params.id],
    });
    if (!att) return res.status(404).json({ error: 'Not found' });
    if (!['draft', 'submitted', 'rejected'].includes(att.request_status)) return res.status(400).json({ error: 'Documents on an approved request stay on the record and can\'t be removed' });
    if (att.stored_name.startsWith('https://')) {
      const resourceType = (att.stored_name.match(/\/(image|raw|video)\/upload\//) || [])[1] || 'raw';
      await cloudDestroy(att.stored_name, resourceType);
    } else {
      try { if (fs.existsSync(path.join(localUploadDir, att.stored_name))) fs.unlinkSync(path.join(localUploadDir, att.stored_name)); } catch (e) {}
    }
    await db.execute({ sql: 'DELETE FROM payment_request_attachments WHERE id = ?', args: [att.id] });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.loadRequest = loadRequest;
module.exports.reopenAfterVoid = reopenAfterVoid;
