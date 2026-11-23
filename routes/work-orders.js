const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { CUSTOMER_SALESPERSON_SQL } = require('../lib/salesCredit');
const { requirePermission, requireAnyPermission, can } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');
const { processWorkOrderItems, processWorkOrderPartSourcing } = require('../lib/workOrders');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { cloudUpload, cloudDestroy } = require('../lib/cloudinary');
const { syncBinQty } = require('../lib/binSync');
const { branchStockQty } = require('../lib/branchStock');
const { takeFromLots, costOn } = require('../lib/stockLots');
const { storeToday, storeDay, storeOffsetModifier } = require('../lib/storeTime');
const { createBill, dueDateFor, PAID_SQL } = require('../lib/payables');
const { movementState, decorateMovements, loadMovements, checkAccessories, locationLabel } = require('../lib/woMovements');

// Statuses a WO can freely log a comment against via PATCH /:id/status without
// going through a dedicated money-moving endpoint (assessment-paid,
// deposit-paid, signoff each own their own transition below). 'in_progress',
// 'awaiting_signoff' and 'awaiting_parts' are phases a technician/supervisor
// moves between day to day; 'not_worth_fixing' is a terminal outcome reached
// once work has started (the pre-deposit equivalent is the /cancel endpoint).
const FREE_STATUS_TRANSITIONS = ['in_progress', 'awaiting_signoff', 'awaiting_parts', 'not_worth_fixing'];
// Statuses a WO can move between freely — anything outside this set (not
// started yet, or already a terminal outcome) can't take a free transition.
const ACTIVE_WORK_STATUSES = ['in_progress', 'awaiting_signoff', 'awaiting_parts'];

async function logStatus(executor, workOrderId, status, comment, employeeId) {
  await executor.execute({ sql: 'INSERT INTO work_order_status_log (work_order_id, status, comment, employee_id) VALUES (?,?,?,?)', args: [workOrderId, status, comment || null, employeeId || null] });
}

// ─── Follow-up calls ──────────────────────────────────────────────────────
// A work order needs a call (follow_up_due) when, on the store clock:
//  - it's complete (signed off) and the customer hasn't been told yet;
//  - the next follow-up date set on its latest call has come; or
//  - its pickup is overdue and nobody has called in the last 7 days (and no
//    later follow-up is booked).
// Closed jobs (picked up, cancelled, or handed back) never need one.
const CALL_OUTCOMES = {
  reached: 'Reached customer', will_collect: 'Customer will collect', voicemail: 'Left voicemail', no_answer: 'No answer',
  wrong_number: 'Wrong / disconnected number', declined: 'Customer declined', other: 'Other',
};
const CALL_METHODS = { phone: 'Phone', whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email', in_person: 'In person' };
// Outcomes that mean the customer actually got the message.
const CALL_REACHED = ['reached', 'will_collect', 'declined'];

function daysBetween(a, b) { return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000); }

function decorateFollowUp(wo, today = storeToday()) {
  const closed = ['picked_up', 'cancelled'].includes(wo.status) || !!wo.returned_to_customer_at;
  const lastDay = wo.last_call_at ? storeDay(wo.last_call_at) : null;
  let reason = null;
  if (!closed) {
    if (wo.status === 'complete') reason = 'ready_to_notify';
    else if (wo.next_follow_up && wo.next_follow_up <= today) reason = 'scheduled';
    else if (wo.pickup_due_date && wo.pickup_due_date < today && !(wo.next_follow_up && wo.next_follow_up > today)
      && (!lastDay || daysBetween(lastDay, today) >= 7)) reason = 'pickup_overdue';
  }
  wo.follow_up_due = !!reason;
  wo.follow_up_reason = reason;
  return wo;
}

const WO_LIST_SELECT = `SELECT wo.*, c.first_name || ' ' || c.last_name as customer_name, c.phone as customer_phone, c.email as customer_email,
  c.customer_number, c.address as customer_address, c.city as customer_city, c.state as customer_state, c.zip as customer_zip,
  e.first_name || ' ' || e.last_name as employee_name, b.name as branch_name, b.is_warehouse as branch_is_warehouse,
  cb.first_name || ' ' || cb.last_name as completed_by_name,
  (SELECT first_name || ' ' || last_name FROM employees WHERE id = wo.returned_to_customer_by) as returned_to_customer_by_name,
  (SELECT first_name || ' ' || last_name FROM employees WHERE id = wo.cashier_hold_by) as cashier_hold_by_name,
  julianday('now') - julianday(wo.pickup_due_date) as days_past_pickup_due,
  (SELECT COALESCE(SUM(total),0) FROM work_order_items WHERE work_order_id = wo.id) as parts_total,
  (SELECT COALESCE(SUM(total * tax_rate / 100.0),0) FROM work_order_items WHERE work_order_id = wo.id) as parts_tax_total,
  (SELECT COUNT(*) FROM work_order_calls WHERE work_order_id = wo.id) as call_count,
  (SELECT called_at FROM work_order_calls WHERE work_order_id = wo.id ORDER BY called_at DESC, id DESC LIMIT 1) as last_call_at,
  (SELECT outcome FROM work_order_calls WHERE work_order_id = wo.id ORDER BY called_at DESC, id DESC LIMIT 1) as last_call_outcome,
  (SELECT next_follow_up FROM work_order_calls WHERE work_order_id = wo.id ORDER BY called_at DESC, id DESC LIMIT 1) as next_follow_up
  FROM work_orders wo
  LEFT JOIN customers c ON wo.customer_id = c.id
  LEFT JOIN employees e ON wo.employee_id = e.id
  LEFT JOIN branches b ON wo.branch_id = b.id
  LEFT JOIN employees cb ON wo.completed_by = cb.id`;

// ─── Intake photos & accessories ─────────────────────────────────────────
// Local photos live in uploads/wo-photos (a PROTECTED_UPLOAD_DIRS folder —
// static, but only to a signed-in session); Cloudinary when configured.
const photoDir = path.join(__dirname, '../uploads/wo-photos');
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});
const PHOTO_SELECT = `SELECT p.*, CASE WHEN p.stored_name LIKE 'https://%' THEN p.stored_name ELSE '/uploads/wo-photos/' || p.stored_name END as url
  FROM work_order_photos p`;
// Accessories and photos are the record of what came in — added any time
// until the item's gone back, removed only while the WO is still at intake.
const INTAKE_LOCKED = ['picked_up', 'cancelled'];

// Saves an uploaded photo (Cloudinary when configured, else uploads/wo-photos) and returns its stored_name
async function storePhotoFile(woId, file) {
  const base = `wo${woId}-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const cloud = await cloudUpload(file.buffer, { folder: 'pos-system/wo-photos', public_id: base, resource_type: 'image' });
  if (cloud) return cloud.secure_url;
  fs.mkdirSync(photoDir, { recursive: true });
  const storedName = `${base}${(path.extname(file.originalname) || '.jpg').toLowerCase()}`;
  fs.writeFileSync(path.join(photoDir, storedName), file.buffer);
  return storedName;
}

async function loadIntakeRecord(woId) {
  const { rows: accessories } = await db.execute({ sql: `SELECT a.*, e.first_name || ' ' || e.last_name as returned_by_name FROM work_order_accessories a
    LEFT JOIN employees e ON a.returned_by = e.id WHERE a.work_order_id = ? ORDER BY a.line_no`, args: [woId] });
  const { rows: photos } = await db.execute({ sql: `${PHOTO_SELECT} WHERE p.work_order_id = ? AND p.movement_id IS NULL ORDER BY p.id`, args: [woId] });
  for (const a of accessories) a.photos = photos.filter(p => p.accessory_id === a.id);
  return { accessories, photos: photos.filter(p => !p.accessory_id) };
}

function cleanAccessory(a) {
  const name = String(a?.name || '').trim();
  const description = String(a?.description || '').trim();
  if (!name) return { error: 'Each accessory needs a name' };
  if (!description) return { error: `Describe the ${name} — its condition, colour, any marks` };
  return { name, description, serial_number: String(a.serial_number || '').trim() || null };
}

async function insertAccessory(executor, woId, a, employeeId) {
  const { rows: [{ n }] } = await executor.execute({ sql: 'SELECT COALESCE(MAX(line_no), 0) + 1 as n FROM work_order_accessories WHERE work_order_id = ?', args: [woId] });
  const r = await executor.execute({ sql: 'INSERT INTO work_order_accessories (work_order_id, line_no, name, serial_number, description, created_by) VALUES (?,?,?,?,?,?)',
    args: [woId, n, a.name, a.serial_number, a.description, employeeId || null] });
  return { id: Number(r.lastInsertRowid), line_no: n };
}

// Accessory checklist when the item goes back — at pickup or Return to
// Customer. Each accessory handed in is ticked as handed back; any that
// isn't needs a reason. Returns { error } or what recordAccessoryHandBack needs.
async function checkAccessoryHandBack(woId, returnedIds, note) {
  const { rows: accessories } = await db.execute({ sql: 'SELECT id, line_no, name FROM work_order_accessories WHERE work_order_id = ? ORDER BY line_no', args: [woId] });
  if (accessories.length && !Array.isArray(returnedIds)) return { error: 'Tick off the accessories being handed back (refresh the page if the checklist is missing)' };
  const ids = new Set((returnedIds || []).map(Number));
  const handedBack = accessories.filter(a => ids.has(a.id));
  const kept = accessories.filter(a => !ids.has(a.id));
  note = String(note || '').trim();
  if (kept.length && !note) return { error: `${kept.map(a => `A${a.line_no} ${a.name}`).join(', ')} not ticked as handed back — say why` };
  return { accessories, handedBack, kept, note: kept.length ? note : null };
}

async function recordAccessoryHandBack(executor, woId, status, check, employeeId) {
  for (const a of check.handedBack) await executor.execute({ sql: 'UPDATE work_order_accessories SET returned_at = CURRENT_TIMESTAMP, returned_by = ? WHERE id = ?', args: [employeeId || null, a.id] });
  await executor.execute({ sql: 'UPDATE work_orders SET accessories_pickup_note = ? WHERE id = ?', args: [check.note, woId] });
  if (!check.accessories.length) return;
  await logStatus(executor, woId, status, [
    check.handedBack.length ? `Accessories handed back: ${check.handedBack.map(a => `A${a.line_no} ${a.name}`).join(', ')}` : null,
    check.kept.length ? `Not handed back: ${check.kept.map(a => `A${a.line_no} ${a.name}`).join(', ')} — ${check.note}` : null,
  ].filter(Boolean).join('. '), employeeId);
}

// ─── External work (outside technicians / companies) ─────────────────────
// Internal cost: what the outside party did and what they charged us
// (labour hours × hourly rate + other charges + GCT). The customer is still
// billed from the estimate + parts. With a supplier on file, the cost goes
// to Accounts Payable as a bill (source 'work_order') kept in step with it.
const EXTERNAL_SELECT = `SELECT x.*, s.name as supplier_name,
    b.bill_number as ap_bill_number, b.status as ap_bill_status,
    CASE WHEN b.id IS NULL THEN 0 ELSE (SELECT COALESCE(SUM(a.amount), 0) FROM ap_payment_allocations a JOIN ap_payments p ON p.id = a.payment_id AND p.status = 'posted' WHERE a.bill_id = b.id) END as ap_bill_paid,
    (SELECT first_name || ' ' || last_name FROM employees WHERE id = x.created_by) as created_by_name,
    (SELECT first_name || ' ' || last_name FROM employees WHERE id = x.updated_by) as updated_by_name
  FROM work_order_external_work x LEFT JOIN suppliers s ON x.supplier_id = s.id LEFT JOIN ap_bills b ON b.id = x.ap_bill_id`;

async function loadExternalWork(woId) {
  const { rows } = await db.execute({ sql: `${EXTERNAL_SELECT} WHERE x.work_order_id = ? ORDER BY x.id`, args: [woId] });
  return rows;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
async function cleanExternalWork(b) {
  const str = v => { const t = String(v ?? '').trim(); return t || null; };
  const num = (v, label) => {
    if (v === '' || v == null) return { v: null };
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return { error: `${label} must be 0 or more` };
    return { v: n };
  };
  let supplierId = b.supplier_id ? parseInt(b.supplier_id, 10) : null;
  let company = str(b.company_name);
  let terms = null;
  if (supplierId) {
    const { rows: [sup] } = await db.execute({ sql: 'SELECT id, name, payment_terms FROM suppliers WHERE id = ?', args: [supplierId] });
    if (!sup) return { error: 'That supplier no longer exists' };
    company = company || sup.name;
    terms = sup.payment_terms;
  }
  const technician = str(b.technician_name);
  if (!company && !technician) return { error: 'Enter the outside company or the technician\'s name' };
  const description = str(b.description);
  if (!description) return { error: 'Describe the work they did' };
  const hours = num(b.labour_hours, 'Hours'), rate = num(b.hourly_rate, 'Hourly rate'), other = num(b.other_cost, 'Other charges'), gct = num(b.tax_amount, 'GCT');
  for (const f of [hours, rate, other, gct]) if (f.error) return { error: f.error };
  if ((hours.v != null) !== (rate.v != null)) return { error: 'Enter both the hours and the hourly rate (or neither)' };
  const labour = hours.v != null ? r2(hours.v * rate.v) : 0;
  // Older callers send just `cost` — it becomes the other charges.
  let otherCost = other.v;
  if (otherCost == null && hours.v == null && b.cost !== '' && b.cost != null) {
    const c = num(b.cost, 'Cost'); if (c.error) return { error: c.error }; otherCost = c.v;
  }
  if (hours.v == null && otherCost == null) return { error: 'Enter the labour hours and hourly rate, or the cost' };
  const tax = r2(gct.v || 0);
  const cost = r2(labour + (otherCost || 0) + tax);
  const sent = str(b.sent_date), back = str(b.returned_date);
  if (sent && !DAY_RE.test(sent)) return { error: 'Sent date is not a valid date' };
  if (back && !DAY_RE.test(back)) return { error: 'Returned date is not a valid date' };
  if (sent && back && back < sent) return { error: 'Returned date is before the sent date' };
  return { supplier_id: supplierId, payment_terms: terms, company_name: company, technician_name: technician, phone: str(b.phone), email: str(b.email),
    description, labour_hours: hours.v, hourly_rate: rate.v, other_cost: otherCost == null ? null : r2(otherCost), tax_amount: tax, cost,
    reference: str(b.reference), sent_date: sent, returned_date: back, notes: str(b.notes), create_bill: b.create_bill !== false && b.create_bill !== 0 && b.create_bill !== '0' };
}

function externalLabel(x) { return [x.company_name, x.technician_name].filter(Boolean).join(' — '); }

// The linked bill and whether money is already moving on it (paid, or on a
// payment request in the works) — then its vendor/amount are fixed here.
async function externalBillState(executor, billId) {
  if (!billId) return null;
  const { rows: [bill] } = await executor.execute({ sql: `SELECT b.*, ${PAID_SQL} as paid FROM ap_bills b WHERE b.id = ?`, args: [billId] });
  if (!bill || bill.status === 'void') return null;
  const { rows: [req] } = await executor.execute({ sql: `SELECT r.request_number FROM payment_request_lines l JOIN payment_requests r ON r.id = l.request_id
    WHERE l.bill_id = ? AND r.status IN ('submitted', 'approved') LIMIT 1`, args: [billId] });
  return { bill, locked: r2(bill.paid) > 0 ? `has ${r2(bill.paid).toFixed(2)} paid on it` : (req ? `is on payment request ${req.request_number}` : null) };
}

async function externalInvoiceClash(executor, supplierId, invoiceNo, billId) {
  if (!supplierId || !invoiceNo) return null;
  const { rows: [dupe] } = await executor.execute({
    sql: "SELECT bill_number FROM ap_bills WHERE supplier_id = ? AND LOWER(vendor_invoice_number) = LOWER(?) AND status != 'void' AND id != ?",
    args: [supplierId, invoiceNo, billId || 0] });
  return dupe ? `Their invoice ${invoiceNo} is already entered in A/P as bill ${dupe.bill_number}` : null;
}

function externalBillFields(wo, x) {
  const billDate = x.returned_date || storeToday();
  return {
    supplier_id: x.supplier_id, vendor_invoice_number: x.reference, branch_id: wo.branch_id, bill_date: billDate,
    due_date: dueDateFor(x.payment_terms, billDate), amount: x.cost, tax_amount: x.tax_amount,
    description: `${wo.wo_number} external work: ${x.description}`.slice(0, 500),
  };
}

const VOID_BILL_SQL = "UPDATE ap_bills SET status = 'void', void_reason = ?, voided_by = ?, voided_at = CURRENT_TIMESTAMP WHERE id = ?";

async function removePhotoFile(photo) {
  if (photo.stored_name.startsWith('https://')) await cloudDestroy(photo.stored_name, 'image');
  else { try { fs.unlinkSync(path.join(photoDir, photo.stored_name)); } catch(e) {} }
}

router.get('/', requirePermission('work_orders'), async (req, res) => {
  try {
    const { status, view, customer_id, branch_id, limit = 200 } = req.query;
    let sql = `${WO_LIST_SELECT} WHERE 1=1`;
    const params = [];
    let effectiveStatus = null;
    if (view === 'active') { sql += " AND wo.status NOT IN ('picked_up','cancelled','not_worth_fixing')"; }
    // Jobs needing a call — filtered after decorateFollowUp below.
    else if (view === 'follow_ups') { sql += " AND wo.status NOT IN ('picked_up','cancelled') AND wo.returned_to_customer_at IS NULL"; }
    // Items to send or receive along the store → Warehouse → service center trip — filtered after decorateMovements below.
    else if (view === 'movements') { sql += " AND wo.status != 'picked_up' AND wo.returned_to_customer_at IS NULL"; }
    // Assessment fee (status='intake'), deposit (status='pending_deposit'), or the
    // final balance (status='awaiting_pickup') due — surfaced in the POS Hold
    // Recall list so a cashier can pick it up and take payment there. A
    // finished job only goes there once someone places it on hold for the
    // cashier when the customer comes in to collect (cashier_hold_at).
    else if (view === 'awaiting_payment') { sql += " AND (wo.status IN ('intake','pending_deposit') OR (wo.status = 'awaiting_pickup' AND wo.cashier_hold_at IS NOT NULL))"; }
    else if (['awaiting_pickup', 'picked_up', 'cancelled', 'not_worth_fixing', 'assessed'].includes(view)) { sql += ' AND wo.status = ?'; params.push(view); effectiveStatus = view; }
    else if (status) { sql += ' AND wo.status = ?'; params.push(status); effectiveStatus = status; }
    if (customer_id) { sql += ' AND wo.customer_id = ?'; params.push(customer_id); }
    if (branch_id) { sql += ' AND wo.branch_id = ?'; params.push(branch_id); }
    // Every other view is "most recently touched first" for day-to-day triage,
    // but the assessment queue (status='assessed', paid and waiting for
    // someone to assess it) is a strict first-in-first-out line — whoever
    // assesses next works the oldest-opened item first, oldest at the top.
    sql += effectiveStatus === 'assessed' || view === 'follow_ups' || view === 'movements' ? ' ORDER BY wo.created_at ASC' : ' ORDER BY wo.created_at DESC';
    if (view !== 'follow_ups' && view !== 'movements') { sql += ' LIMIT ?'; params.push(parseInt(limit)); }
    const { rows } = await db.execute({ sql, args: params });
    const today = storeToday();
    rows.forEach(r => decorateFollowUp(r, today));
    await decorateMovements(db, rows);
    if (view === 'movements') {
      // `at`: where the next step happens — the sender's location for a send, the destination for a receive
      const at = req.query.at;
      return res.json(rows.filter(r => r.movement.next && (!at || (r.movement.next.kind === 'send' ? r.movement.next.from : r.movement.next.to) === at)));
    }
    res.json(view === 'follow_ups' ? rows.filter(r => r.follow_up_due) : rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// issued_qty: how much of this line's item has been issued from stock to the
// job (work_order_part_issues are per item, so it's the item's total).
const WO_ITEMS_SELECT = `SELECT woi.*, pr.pr_number as purchase_request_number, pr.status as purchase_request_status,
    COALESCE((SELECT SUM(pi.qty) FROM work_order_part_issues pi WHERE pi.work_order_id = woi.work_order_id AND pi.product_id = woi.product_id), 0) AS issued_qty
  FROM work_order_items woi LEFT JOIN purchase_requests pr ON woi.purchase_request_id = pr.id WHERE woi.work_order_id = ?`;

// Attaches each part's branch-sourcing breakdown (item.sources) — mirrors
// routes/quotations.js's attachQuoteItemSources exactly, scoped to
// work_order_item_sources/work_order_items.
async function attachWorkOrderItemSources(items) {
  if (!items.length) return items;
  const ids = items.map(i => i.id);
  const placeholders = ids.map(() => '?').join(',');
  const { rows: sources } = await db.execute({
    sql: `SELECT wis.*, b.name as branch_name, bt.transfer_number, bt.status as transfer_status,
            pr.id as purchase_request_id, pr.pr_number as purchase_request_number, pr.status as purchase_request_status
          FROM work_order_item_sources wis
          LEFT JOIN branches b ON wis.branch_id = b.id
          LEFT JOIN branch_transfers bt ON wis.transfer_id = bt.id
          LEFT JOIN purchase_request_items pri ON wis.purchase_request_item_id = pri.id
          LEFT JOIN purchase_requests pr ON pri.pr_id = pr.id
          WHERE wis.work_order_item_id IN (${placeholders})`,
    args: ids,
  });
  const byItem = {};
  for (const s of sources) { (byItem[s.work_order_item_id] = byItem[s.work_order_item_id] || []).push(s); }
  for (const item of items) { item.sources = byItem[item.id] || []; }
  return items;
}

// Registered before GET /:id so "active-tasks" isn't swallowed as an :id
// value — every task with a currently-open time entry, for the live
// supervisor popup. Polled client-side every ~15s while the popup is open.
router.get('/active-tasks', requirePermission('work_orders'), async (req, res) => {
  try {
    const { rows } = await db.execute({
      sql: `SELECT te.id as time_entry_id, te.started_at, te.technician_id,
              tech.first_name || ' ' || tech.last_name as technician_name,
              t.id as task_id, t.description as task_description, t.allotted_minutes,
              wo.id as work_order_id, wo.wo_number,
              (julianday('now') - julianday(te.started_at)) * 24 * 60 as elapsed_minutes
            FROM work_order_task_time_entries te
            JOIN work_order_tasks t ON te.task_id = t.id
            JOIN work_orders wo ON t.work_order_id = wo.id
            LEFT JOIN employees tech ON te.technician_id = tech.id
            WHERE te.ended_at IS NULL
            ORDER BY te.started_at`,
      args: [],
    });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Technician performance & incentive targets ───────────────────────────
// A task counts in a period by the store day it was completed; incomplete =
// still open (on a work order that's still live) and created by the period's
// end. On time = actual clocked time ≤ allotted (tasks with no allotted time
// are "no time set" and count in neither). Targets are per store month.
const TASK_ACTUAL_SQL = `(SELECT COALESCE(SUM((julianday(COALESCE(te.ended_at, CURRENT_TIMESTAMP)) - julianday(te.started_at)) * 24 * 60), 0) FROM work_order_task_time_entries te WHERE te.task_id = t.id)`;
const MONTH_RE = /^\d{4}-\d{2}$/;
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function monthOf(start, end) {
  // The month a start/end range covers exactly, else null (no target shown).
  if (!start || !end || start.slice(0, 7) !== end.slice(0, 7) || start.slice(8) !== '01') return null;
  const [y, m] = start.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Number(end.slice(8)) === last ? start.slice(0, 7) : null;
}

async function targetsFor(period) {
  const { rows } = await db.execute({ sql: `SELECT t.*, e.first_name || ' ' || e.last_name as employee_name FROM technician_incentive_targets t
    LEFT JOIN employees e ON e.id = t.employee_id WHERE t.period = ? ORDER BY t.employee_id IS NOT NULL, employee_name`, args: [period] });
  return rows;
}

function targetResult(target, stats) {
  if (!target) return null;
  const checks = [];
  if (target.target_completed != null) checks.push(stats.completed >= target.target_completed);
  if (target.target_on_time_pct != null) checks.push(stats.on_time_pct != null && stats.on_time_pct >= target.target_on_time_pct);
  return { ...target, is_default: target.employee_id == null, met: checks.length > 0 && checks.every(Boolean) };
}

router.get('/task-performance', requirePermission('work_orders'), async (req, res) => {
  try {
    const today = storeToday();
    const start = DAY_ONLY.test(req.query.start || '') ? req.query.start : today.slice(0, 8) + '01';
    const end = DAY_ONLY.test(req.query.end || '') ? req.query.end : today;
    if (end < start) return res.status(400).json({ error: 'The end date is before the start date' });
    const off = storeOffsetModifier();
    const techId = req.query.technician_id ? parseInt(req.query.technician_id, 10) : null;
    const branchId = req.query.branch_id ? parseInt(req.query.branch_id, 10) : null;
    const filters = [];
    const args = [start, end, end];
    if (techId) { filters.push('t.technician_id = ?'); args.push(techId); }
    if (branchId) { filters.push('wo.branch_id = ?'); args.push(branchId); }
    const { rows } = await db.execute({
      sql: `SELECT t.id, t.description, t.status, t.allotted_minutes, t.technician_id, t.created_at, t.completed_at,
              tech.first_name || ' ' || tech.last_name as technician_name,
              wo.id as work_order_id, wo.wo_number, wo.status as wo_status, wo.description as wo_description, b.name as branch_name,
              c.first_name || ' ' || c.last_name as customer_name,
              ${TASK_ACTUAL_SQL} as actual_minutes,
              (SELECT COUNT(*) FROM work_order_task_time_entries te WHERE te.task_id = t.id AND te.ended_at IS NULL) as running
            FROM work_order_tasks t
            JOIN work_orders wo ON wo.id = t.work_order_id
            LEFT JOIN employees tech ON tech.id = t.technician_id
            LEFT JOIN branches b ON b.id = wo.branch_id
            LEFT JOIN customers c ON c.id = wo.customer_id
            WHERE ((t.status = 'complete' AND date(t.completed_at, '${off}') BETWEEN ? AND ?)
               OR (t.status != 'complete' AND wo.status NOT IN ('cancelled', 'not_worth_fixing', 'picked_up') AND date(t.created_at, '${off}') <= ?))
              ${filters.length ? 'AND ' + filters.join(' AND ') : ''}
            ORDER BY t.status = 'complete', COALESCE(t.completed_at, t.created_at) DESC, t.id DESC`,
      args,
    });
    const tasks = rows.map(t => {
      const actual = Math.round((Number(t.actual_minutes) || 0) * 10) / 10;
      const allotted = Number(t.allotted_minutes) || 0;
      let timing = null;
      if (t.status === 'complete') timing = allotted > 0 ? (actual <= allotted ? 'on_time' : 'late') : 'no_allotment';
      else if (allotted > 0 && actual > allotted) timing = 'over';
      return { ...t, actual_minutes: actual, variance_minutes: allotted > 0 ? Math.round((actual - allotted) * 10) / 10 : null, timing, running: !!t.running };
    });

    const period = monthOf(start, end);
    const targets = period ? await targetsFor(period) : [];
    const defaultTarget = targets.find(t => t.employee_id == null) || null;
    const byTech = new Map();
    for (const t of tasks) {
      const key = t.technician_id || 0;
      if (!byTech.has(key)) byTech.set(key, { technician_id: t.technician_id, technician_name: t.technician_name || 'Unassigned', completed: 0, on_time: 0, late: 0, no_allotment: 0, incomplete: 0, minutes_worked: 0, minutes_allotted: 0 });
      const s = byTech.get(key);
      if (t.status === 'complete') {
        s.completed++;
        s[t.timing]++;
        s.minutes_worked += t.actual_minutes;
        s.minutes_allotted += Number(t.allotted_minutes) || 0;
      } else s.incomplete++;
    }
    // Technicians with a target of their own still show with nothing done.
    for (const tg of targets) if (tg.employee_id && !byTech.has(tg.employee_id) && !techId) {
      byTech.set(tg.employee_id, { technician_id: tg.employee_id, technician_name: tg.employee_name, completed: 0, on_time: 0, late: 0, no_allotment: 0, incomplete: 0, minutes_worked: 0, minutes_allotted: 0 });
    }
    const technicians = [...byTech.values()].map(s => {
      const timed = s.on_time + s.late;
      const stats = { ...s, minutes_worked: Math.round(s.minutes_worked), on_time_pct: timed ? Math.round(s.on_time / timed * 1000) / 10 : null };
      const target = s.technician_id ? (targets.find(t => t.employee_id === s.technician_id) || defaultTarget) : null;
      return { ...stats, target: targetResult(target, stats) };
    }).sort((a, b) => (a.technician_id ? 0 : 1) - (b.technician_id ? 0 : 1) || b.completed - a.completed || String(a.technician_name).localeCompare(String(b.technician_name)));
    const totals = technicians.reduce((t, s) => ({ completed: t.completed + s.completed, on_time: t.on_time + s.on_time, late: t.late + s.late, no_allotment: t.no_allotment + s.no_allotment, incomplete: t.incomplete + s.incomplete, minutes_worked: t.minutes_worked + s.minutes_worked }),
      { completed: 0, on_time: 0, late: 0, no_allotment: 0, incomplete: 0, minutes_worked: 0 });
    totals.on_time_pct = totals.on_time + totals.late ? Math.round(totals.on_time / (totals.on_time + totals.late) * 1000) / 10 : null;
    res.json({ start, end, period, tasks, technicians, totals, targets });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/incentive-targets', requirePermission('work_orders'), async (req, res) => {
  try {
    const period = MONTH_RE.test(req.query.period || '') ? req.query.period : storeToday().slice(0, 7);
    res.json({ period, targets: await targetsFor(period) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function cleanTarget(b) {
  const period = String(b.period || '').trim();
  if (!MONTH_RE.test(period)) return { error: 'Pick the month the target is for' };
  const opt = (v, label, max) => {
    if (v === '' || v == null) return { v: null };
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || (max != null && n > max)) return { error: `${label} must be between 0 and ${max ?? 'any amount'}` };
    return { v: n };
  };
  const done = opt(b.target_completed, 'Tasks completed', 100000), pct = opt(b.target_on_time_pct, 'On-time %', 100), reward = opt(b.reward_amount, 'Reward', null);
  for (const f of [done, pct, reward]) if (f.error) return { error: f.error };
  if (done.v == null && pct.v == null) return { error: 'Set a tasks-completed target, an on-time % target, or both' };
  return { period, employee_id: b.employee_id ? parseInt(b.employee_id, 10) : null, target_completed: done.v == null ? null : Math.round(done.v),
    target_on_time_pct: pct.v, reward_amount: reward.v == null ? null : Math.round(reward.v * 100) / 100, reward_note: String(b.reward_note || '').trim() || null };
}

router.post('/incentive-targets', requirePermission('wo_incentives'), async (req, res) => {
  try {
    const t = cleanTarget(req.body || {});
    if (t.error) return res.status(400).json({ error: t.error });
    if (t.employee_id) {
      const { rows: [emp] } = await db.execute({ sql: 'SELECT id FROM employees WHERE id = ?', args: [t.employee_id] });
      if (!emp) return res.status(400).json({ error: 'That technician no longer exists' });
    }
    const { rows: [dupe] } = await db.execute({ sql: 'SELECT id FROM technician_incentive_targets WHERE period = ? AND COALESCE(employee_id, 0) = ?', args: [t.period, t.employee_id || 0] });
    if (dupe) return res.status(400).json({ error: `There's already a ${t.employee_id ? "target for this technician" : 'default target'} for ${t.period} — edit that one` });
    const r = await db.execute({ sql: `INSERT INTO technician_incentive_targets (period, employee_id, target_completed, target_on_time_pct, reward_amount, reward_note, created_by) VALUES (?,?,?,?,?,?,?)`,
      args: [t.period, t.employee_id, t.target_completed, t.target_on_time_pct, t.reward_amount, t.reward_note, req.employee?.id || null] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM technician_incentive_targets WHERE id = ?', args: [Number(r.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/incentive-targets/:id', requirePermission('wo_incentives'), async (req, res) => {
  try {
    const { rows: [old] } = await db.execute({ sql: 'SELECT * FROM technician_incentive_targets WHERE id = ?', args: [req.params.id] });
    if (!old) return res.status(404).json({ error: 'Not found' });
    // The month and technician stay; only the figures change.
    const t = cleanTarget({ ...req.body, period: old.period, employee_id: old.employee_id });
    if (t.error) return res.status(400).json({ error: t.error });
    await db.execute({ sql: `UPDATE technician_incentive_targets SET target_completed = ?, target_on_time_pct = ?, reward_amount = ?, reward_note = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [t.target_completed, t.target_on_time_pct, t.reward_amount, t.reward_note, req.employee?.id || null, old.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM technician_incentive_targets WHERE id = ?', args: [old.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/incentive-targets/:id', requirePermission('wo_incentives'), async (req, res) => {
  try {
    const r = await db.execute({ sql: 'DELETE FROM technician_incentive_targets WHERE id = ?', args: [req.params.id] });
    if (!r.rowsAffected) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Skills catalog + scheduling (registered before GET /:id — see
// active-tasks' comment above for why single-segment routes need to come
// first) ─────────────────────────────────────────────────────────────────

router.get('/skills', requirePermission('work_orders'), async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: 'SELECT * FROM technician_skills WHERE active = 1 ORDER BY name', args: [] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/skills', requirePermission('work_orders'), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'A skill name is required' });
    const result = await db.execute({ sql: 'INSERT INTO technician_skills (name) VALUES (?)', args: [name.trim()] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM technician_skills WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.put('/skills/:id', requirePermission('work_orders'), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'A skill name is required' });
    await db.execute({ sql: 'UPDATE technician_skills SET name = ? WHERE id = ?', args: [name.trim(), req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM technician_skills WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// Deactivated rather than deleted — same reasoning as branches/employees:
// past employee_skills/work_order_task_skills rows referencing it should
// keep working, just hidden from future assignment.
router.delete('/skills/:id', requirePermission('work_orders'), async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE technician_skills SET active = 0 WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// Day-ahead schedule board — everything scheduled for a given date, plus
// (separately) every unscheduled in-progress task, so the frontend can show
// "needs scheduling" vs "already assigned to a day" side by side.
router.get('/schedule', requirePermission('work_orders'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'A date is required' });
    const { rows: scheduled } = await db.execute({
      sql: `SELECT ts.*, e.first_name || ' ' || e.last_name as employee_name,
              t.description as task_description, t.allotted_minutes, t.status as task_status,
              wo.wo_number, wo.id as work_order_id
            FROM technician_schedule ts
            LEFT JOIN employees e ON ts.employee_id = e.id
            LEFT JOIN work_order_tasks t ON ts.work_order_task_id = t.id
            LEFT JOIN work_orders wo ON t.work_order_id = wo.id
            WHERE ts.scheduled_date = ? ORDER BY ts.employee_id`,
      args: [date],
    });
    const { rows: unscheduled } = await db.execute({
      sql: `SELECT t.*, wo.wo_number, wo.id as work_order_id,
              (SELECT GROUP_CONCAT(ts2.name, ', ') FROM work_order_task_skills wts JOIN technician_skills ts2 ON wts.skill_id = ts2.id WHERE wts.task_id = t.id) as required_skills
            FROM work_order_tasks t JOIN work_orders wo ON t.work_order_id = wo.id
            WHERE t.status != 'complete' AND NOT EXISTS (SELECT 1 FROM technician_schedule ts WHERE ts.work_order_task_id = t.id AND ts.scheduled_date = ?)
            ORDER BY t.id`,
      args: [date],
    });
    res.json({ scheduled, unscheduled });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/schedule', requirePermission('work_orders'), async (req, res) => {
  try {
    const { employee_id, work_order_task_id, scheduled_date, notes } = req.body;
    if (!employee_id || !scheduled_date) return res.status(400).json({ error: 'A technician and date are required' });
    const result = await db.execute({ sql: 'INSERT INTO technician_schedule (employee_id, work_order_task_id, scheduled_date, notes) VALUES (?,?,?,?)', args: [employee_id, work_order_task_id || null, scheduled_date, notes || null] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM technician_schedule WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.delete('/schedule/:id', requirePermission('work_orders'), async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM technician_schedule WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.get('/:id', requirePermission('work_orders'), async (req, res) => {
  try {
    const { rows: [wo] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    const { rows: statusLog } = await db.execute({ sql: `SELECT wsl.*, e.first_name || ' ' || e.last_name as employee_name FROM work_order_status_log wsl LEFT JOIN employees e ON wsl.employee_id = e.id WHERE wsl.work_order_id = ? ORDER BY wsl.id`, args: [req.params.id] });
    wo.status_log = statusLog;
    const { rows: items } = await db.execute({ sql: WO_ITEMS_SELECT, args: [req.params.id] });
    wo.items = await attachWorkOrderItemSources(items);
    const { rows: tasks } = await db.execute({
      sql: `SELECT t.*, tech.first_name || ' ' || tech.last_name as technician_name,
              (SELECT id FROM work_order_task_time_entries WHERE task_id = t.id AND ended_at IS NULL LIMIT 1) as open_time_entry_id,
              (SELECT started_at FROM work_order_task_time_entries WHERE task_id = t.id AND ended_at IS NULL LIMIT 1) as open_time_entry_started_at,
              (SELECT COALESCE(SUM((julianday(ended_at) - julianday(started_at)) * 24 * 60), 0) FROM work_order_task_time_entries WHERE task_id = t.id AND ended_at IS NOT NULL) as actual_minutes,
              (SELECT GROUP_CONCAT(ts.name, ', ') FROM work_order_task_skills wts JOIN technician_skills ts ON wts.skill_id = ts.id WHERE wts.task_id = t.id) as required_skills
            FROM work_order_tasks t LEFT JOIN employees tech ON t.technician_id = tech.id
            WHERE t.work_order_id = ? ORDER BY t.id`,
      args: [req.params.id],
    });
    wo.tasks = tasks;
    Object.assign(wo, await loadIntakeRecord(wo.id));
    wo.external_work = await loadExternalWork(wo.id);
    wo.documents = await loadWoDocuments(wo.id);
    wo.calls = await loadWoCalls(wo.id);
    decorateFollowUp(wo);
    wo.movements = await loadMovements(db, wo.id);
    wo.movement = movementState(wo, wo.movements);
    wo.external_cost_total = Math.round(wo.external_work.reduce((t, x) => t + (Number(x.cost) || 0), 0) * 100) / 100;
    res.json(wo);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Replaces the WO's part lines wholesale (same delete+reinsert pattern
// PUT /quotations/:id uses) — computes per-line branch-stock coverage via
// checkAvailability the same way processQuoteItems' caller does, so this is
// left to the frontend to resolve (same split-UI flow as quotes) and passed
// in as `sources`. Only allowed pre-completion — parts can be added/adjusted
// any time the WO is in progress.
router.patch('/:id/parts', requirePermission('wo_assign_parts'), async (req, res) => {
  try {
    const { items } = req.body;
    const { rows: [wo] } = await db.execute({ sql: 'SELECT * FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (['complete', 'awaiting_pickup', 'picked_up', 'cancelled', 'not_worth_fixing'].includes(wo.status)) return res.status(400).json({ error: `Cannot edit parts on a ${wo.status} work order` });

    // Fallback tax rate for a "Q" item (not yet in the catalog, so it has no
    // product.tax_rate of its own) — see processWorkOrderItems.
    const { rows: [taxSetting] } = await db.execute({ sql: "SELECT value FROM settings WHERE key = 'tax_rate'", args: [] });
    const defaultTaxRate = parseFloat(taxSetting?.value) || 0;

    let processedItems;
    try {
      processedItems = await processWorkOrderItems(items || [], defaultTaxRate, wo.branch_id);
    } catch(e) { return res.status(400).json({ error: e.message }); }

    // Parts already issued from stock can't be taken off the list.
    const { rows: issuedRows } = await db.execute({ sql: 'SELECT pi.product_id, p.name, SUM(pi.qty) AS q FROM work_order_part_issues pi JOIN products p ON p.id = pi.product_id WHERE pi.work_order_id = ? GROUP BY pi.product_id', args: [req.params.id] });
    for (const iss of issuedRows) {
      const listed = processedItems.filter(i => Number(i.product_id) === Number(iss.product_id) && !i.is_customer_supplied).reduce((t, i) => t + Number(i.quantity || 0), 0);
      if (listed + 0.0005 < Number(iss.q)) return res.status(400).json({ error: `${iss.q} of ${iss.name} has already been issued from stock to this job, so the parts list needs at least that many` });
    }

    const tx = await db.transaction('write');
    let committed = false;
    try {
      // Existing sourcing/transfer/PR links are tied to the item rows being
      // replaced — deleting the items cascades work_order_item_sources, but
      // the already-created transfers/PR lines themselves are left alone
      // (same as quotations: re-editing doesn't undo a transfer already in
      // motion, it just stops tracking it against the old item row).
      await tx.execute({ sql: 'DELETE FROM work_order_items WHERE work_order_id = ?', args: [req.params.id] });
      for (const item of processedItems) {
        const { product_id, product_name, sku, quantity, unit_cost, unit_price, total, tax_rate, is_temp_item, is_customer_supplied, sources } = item;
        const itemResult = await tx.execute({ sql: 'INSERT INTO work_order_items (work_order_id,product_id,product_name,sku,quantity,unit_cost,unit_price,total,tax_rate,is_temp_item,is_customer_supplied) VALUES (?,?,?,?,?,?,?,?,?,?,?)', args: [req.params.id, product_id, product_name, sku, quantity, unit_cost, unit_price, total, tax_rate || 0, is_temp_item ? 1 : 0, is_customer_supplied ? 1 : 0] });
        const itemId = Number(itemResult.lastInsertRowid);
        if (sources) {
          for (const src of sources) {
            await tx.execute({ sql: 'INSERT INTO work_order_item_sources (work_order_item_id, branch_id, quantity) VALUES (?,?,?)', args: [itemId, src.branch_id, src.quantity] });
          }
        }
      }
      await tx.commit();
      committed = true;
      const { rows: [updated] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
      const { rows: newItems } = await db.execute({ sql: WO_ITEMS_SELECT, args: [req.params.id] });
      updated.items = await attachWorkOrderItemSources(newItems);
      res.json(updated);
    } catch(e) {
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Explicit trigger point (mirrors a quote's Accept) — turns whatever
// branch-split was recorded on PATCH /:id/parts into real inventory moves:
// a branch_transfers row per source branch, or a purchase_requests line for
// anything no branch could cover. Safe to call more than once — only
// still-unprocessed sources (transfer_id/purchase_request_item_id IS NULL)
// are picked up each time, so confirming again after adding more parts only
// processes the new ones.
router.post('/:id/confirm-parts', requirePermission('wo_assign_parts'), async (req, res) => {
  try {
    const { rows: [wo] } = await db.execute({ sql: 'SELECT * FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    const { rows: [itemCount] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM work_order_items WHERE work_order_id = ?', args: [req.params.id] });
    if (!Number(itemCount.c)) return res.status(400).json({ error: 'No parts to confirm' });

    await processWorkOrderPartSourcing(wo);
    const { rows: [updated] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
    const { rows: items } = await db.execute({ sql: WO_ITEMS_SELECT, args: [req.params.id] });
    updated.items = await attachWorkOrderItemSources(items);
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Issue from Stock: a part on the job taken out of the WO branch's stock —
// { product_id, quantity, issue_key, note }. No more than is on the parts
// list (less returned) and not yet issued, nor than the branch holds.
// Recorded once per issue_key. Takes the stock off (branch, overall, bins,
// stock movement 'wo_issue') and from the stock receipts, oldest first —
// supplier-owned only where the agreement allows work-order use, billable
// to that supplier from today at today's agreed cost (A4).
router.post('/:id/parts/issue', requirePermission('wo_assign_parts'), async (req, res) => {
  const tx = await db.transaction('write');
  let committed = false;
  try {
    const fail = (status, msg) => Object.assign(new Error(msg), { status });
    const { rows: [wo] } = await tx.execute({ sql: 'SELECT * FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) throw fail(404, 'Not found');
    if (['complete', 'awaiting_pickup', 'picked_up', 'cancelled', 'not_worth_fixing'].includes(wo.status)) throw fail(400, `Parts can't be issued on a ${wo.status.replace(/_/g, ' ')} work order`);
    if (!wo.branch_id) throw fail(400, 'This work order has no branch to issue stock from');
    const productId = Number(req.body.product_id);
    const qty = Math.round((Number(req.body.quantity) || 0) * 1000) / 1000;
    if (!(qty > 0)) throw fail(400, 'Enter how many are being issued');
    const key = String(req.body.issue_key || '').trim() || null;
    if (key) {
      const { rows: [dup] } = await tx.execute({ sql: 'SELECT id FROM work_order_part_issues WHERE work_order_id = ? AND issue_key = ?', args: [wo.id, key] });
      if (dup) { await tx.rollback(); committed = true; return res.json({ duplicate: true, items: (await db.execute({ sql: WO_ITEMS_SELECT, args: [wo.id] })).rows }); }
    }
    const { rows: [line] } = await tx.execute({
      sql: `SELECT p.name, p.cost, SUM(woi.quantity - COALESCE(woi.quantity_returned, 0)) AS listed,
              COALESCE((SELECT SUM(pi.qty) FROM work_order_part_issues pi WHERE pi.work_order_id = ? AND pi.product_id = ?), 0) AS issued
            FROM work_order_items woi JOIN products p ON p.id = woi.product_id
            WHERE woi.work_order_id = ? AND woi.product_id = ? AND COALESCE(woi.is_customer_supplied, 0) = 0`,
      args: [wo.id, productId, wo.id, productId],
    });
    if (!line || line.listed == null) throw fail(400, "That item isn't on this job's parts list");
    const left = Math.round((Number(line.listed) - Number(line.issued)) * 1000) / 1000;
    if (qty - left > 0.0005) throw fail(400, `Only ${Math.max(0, left)} more of ${line.name} can be issued to this job`);
    const onHand = await branchStockQty(tx, { id: productId, stock_qty: 0 }, wo.branch_id);
    if (qty - onHand > 0.0005) throw fail(400, `Only ${onHand} of ${line.name} is in stock at this branch`);

    const r = await tx.execute({ sql: 'INSERT INTO work_order_part_issues (work_order_id, product_id, branch_id, qty, issue_key, note, issued_by) VALUES (?,?,?,?,?,?,?)',
      args: [wo.id, productId, wo.branch_id, qty, key, String(req.body.note || '').trim() || null, req.employee?.id || null] });
    const issueId = Number(r.lastInsertRowid);
    await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?', args: [qty, productId] });
    await tx.execute({ sql: 'UPDATE branch_inventory SET stock_qty = stock_qty - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND branch_id = ?', args: [qty, productId, wo.branch_id] });
    await syncBinQty(tx, productId, wo.branch_id, -qty);
    await tx.execute({ sql: "INSERT INTO stock_movements (product_id, branch_id, quantity_change, type, reference, reason) VALUES (?,?,?,'wo_issue',?,?)", args: [productId, wo.branch_id, -qty, wo.wo_number, `Issued to work order ${wo.wo_number}`] });
    const parts = await takeFromLots(tx, { product_id: productId, branch_id: wo.branch_id, qty, kind: 'work_order', reference: wo.wo_number, employee_id: req.employee?.id || null, use: 'work_order' });
    const day = storeToday();
    for (const p of parts) {
      const cost = p.owner === 'consignment' ? ((await costOn(tx, p.agreement_id, productId, day))?.cost ?? p.unit_cost ?? null) : line.cost;
      await tx.execute({
        sql: 'INSERT INTO work_order_lot_allocations (issue_id, work_order_id, product_id, branch_id, lot_id, owner, supplier_id, agreement_id, qty, unit_cost, qualified_on) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        args: [issueId, wo.id, productId, wo.branch_id, p.lot_id, p.owner, p.supplier_id, p.agreement_id, p.qty, cost, day],
      });
    }
    await tx.commit();
    committed = true;
    res.json({ duplicate: false, issue_id: issueId, items: (await db.execute({ sql: WO_ITEMS_SELECT, args: [wo.id] })).rows });
  } catch (e) {
    if (!committed) await tx.rollback().catch(() => {});
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Returns some/all of a catalog part's remaining quantity to stock instead of
// installing it — e.g. pulled for the job but not needed, or removed from
// the customer's machine and still resalable. Restocked as a distinct
// "(Used)" sibling product at a discounted price (found by
// products.used_of_product_id, created on first use) rather than a
// variation of the original — see the used_of_product_id migration comment
// in database.js for why. Reduces this line's billable total (and so the
// WO's parts charge) by the returned quantity; `quantity` itself stays the
// original assigned amount so the audit trail (assigned vs. returned) is
// visible on the line.
router.post('/:id/parts/:itemId/return', requirePermission('wo_assign_parts'), async (req, res) => {
  try {
    const { rows: [wo] } = await db.execute({ sql: 'SELECT * FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (['complete', 'awaiting_pickup', 'picked_up', 'cancelled', 'not_worth_fixing'].includes(wo.status)) {
      return res.status(400).json({ error: `Cannot return parts on a ${wo.status} work order` });
    }
    const { rows: [item] } = await db.execute({ sql: 'SELECT * FROM work_order_items WHERE id = ? AND work_order_id = ?', args: [req.params.itemId, req.params.id] });
    if (!item) return res.status(404).json({ error: 'Part not found' });
    if (item.is_customer_supplied) return res.status(400).json({ error: "Customer-supplied items can't be returned to stock" });
    if (!item.product_id) return res.status(400).json({ error: "This item isn't a catalog product and can't be returned to stock" });

    const qty = parseInt(req.body.quantity);
    if (!qty || qty <= 0) return res.status(400).json({ error: 'A return quantity is required' });
    const remaining = item.quantity - (item.quantity_returned || 0);
    if (qty > remaining) return res.status(400).json({ error: `Only ${remaining} unit(s) remain on this line` });
    const usedPrice = parseFloat(req.body.used_price);
    if (isNaN(usedPrice) || usedPrice < 0) return res.status(400).json({ error: 'A used resale price is required' });
    const notes = (req.body.notes || '').trim() || null;

    const tx = await db.transaction('write');
    let committed = false;
    try {
      const newReturned = (item.quantity_returned || 0) + qty;
      const newRemaining = item.quantity - newReturned;
      const newTotal = parseFloat((item.unit_price * newRemaining).toFixed(2));
      await tx.execute({ sql: 'UPDATE work_order_items SET quantity_returned = ?, total = ? WHERE id = ?', args: [newReturned, newTotal, item.id] });

      const { rows: [product] } = await tx.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] });
      let { rows: [sibling] } = await tx.execute({ sql: 'SELECT * FROM products WHERE used_of_product_id = ?', args: [item.product_id] });
      if (!sibling) {
        let sku = `${product.sku}-USED`;
        let suffix = 2;
        while ((await tx.execute({ sql: 'SELECT id FROM products WHERE sku = ?', args: [sku] })).rows.length) {
          sku = `${product.sku}-USED-${suffix++}`;
        }
        const result = await tx.execute({
          sql: 'INSERT INTO products (sku,name,category_id,price,cost,tax_rate,stock_qty,min_stock,active,supplier_id,used_of_product_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          args: [sku, `${product.name} (Used)`, product.category_id || null, usedPrice, product.cost || 0, product.tax_rate ?? 8.5, 0, 0, 1, product.supplier_id || null, product.id],
        });
        const { rows: [created] } = await tx.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [Number(result.lastInsertRowid)] });
        sibling = created;
      } else {
        // Most recent asking price wins — a later batch's discount may
        // differ from the last one's.
        await tx.execute({ sql: 'UPDATE products SET price = ? WHERE id = ?', args: [usedPrice, sibling.id] });
      }

      await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [qty, sibling.id] });
      if (wo.branch_id) {
        await tx.execute({ sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at) VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP) ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP`, args: [sibling.id, wo.branch_id, qty, qty] });
      }
      await tx.execute({ sql: 'INSERT INTO stock_movements (product_id, branch_id, quantity_change, type, reference, reason) VALUES (?,?,?,?,?,?)', args: [sibling.id, wo.branch_id || null, qty, 'wo_return_used', wo.wo_number, notes || `Returned from ${item.product_name} on ${wo.wo_number}, restocked as used`] });
      await logStatus(tx, wo.id, wo.status, `Returned ${qty}x ${item.product_name} to stock as Used (${sibling.sku}) @ ${usedPrice.toFixed(2)} each`, req.body.employee_id);

      await tx.commit();
      committed = true;
    } catch(e) {
      if (!committed) await tx.rollback();
      return res.status(committed ? 500 : 400).json({ error: e.message });
    }

    const { rows: [updated] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
    const { rows: items } = await db.execute({ sql: WO_ITEMS_SELECT, args: [req.params.id] });
    updated.items = await attachWorkOrderItemSources(items);
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Intake ─────────────────────────────────────────────────────────────────

router.post('/', requirePermission('wo_intake'), async (req, res) => {
  try {
    const { customer_id, employee_id, branch_id, description, item_label, item_serial, assessment_fee_product_id } = req.body;
    if (!customer_id) return res.status(400).json({ error: 'A customer is required' });
    if (!description || !description.trim()) return res.status(400).json({ error: 'A description is required' });
    if (!assessment_fee_product_id) return res.status(400).json({ error: 'Select an assessment fee' });
    const accessories = [];
    for (const a of Array.isArray(req.body.accessories) ? req.body.accessories : []) {
      const clean = cleanAccessory(a);
      if (clean.error) return res.status(400).json({ error: clean.error });
      accessories.push(clean);
    }

    // Different machine types carry different flat assessment fees — staff
    // pick the right one from the Services catalog at intake, same as
    // picking a part. Snapshotted here (price + name) rather than joined
    // live later, so a subsequent price change or rename to the service
    // doesn't retroactively change what this work order shows/charges.
    const { rows: [feeProduct] } = await db.execute({ sql: 'SELECT id, name, price, tax_rate FROM products WHERE id = ? AND is_service = 1 AND active = 1', args: [assessment_fee_product_id] });
    if (!feeProduct) return res.status(400).json({ error: 'Selected assessment fee is not a valid active service' });
    const assessmentFee = parseFloat(feeProduct.price) || 0;
    const assessmentFeeTaxRate = parseFloat(feeProduct.tax_rate) || 0;

    const wo_number = await nextNumber(db, 'work_orders', 'wo_number', 'WO-', 6);
    const tx = await db.transaction('write');
    let committed = false;
    try {
      const result = await tx.execute({ sql: `INSERT INTO work_orders (wo_number, customer_id, employee_id, branch_id, description, item_label, item_serial, assessment_fee, assessment_fee_product_id, assessment_fee_name, assessment_fee_tax_rate, movement_tracked)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`, args: [wo_number, customer_id, employee_id || null, branch_id || null, description.trim(), item_label || null, String(item_serial || '').trim() || null, assessmentFee, feeProduct.id, feeProduct.name, assessmentFeeTaxRate] });
      const woId = Number(result.lastInsertRowid);
      for (const a of accessories) await insertAccessory(tx, woId, a, employee_id);
      await logStatus(tx, woId, 'intake', 'Work order opened', employee_id);
      await tx.commit();
      committed = true;
      const { rows: [wo] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [woId] });
      Object.assign(wo, await loadIntakeRecord(woId));
      res.status(201).json(wo);
    } catch(e) {
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Editable any time before completion — explicitly requested so an initial
// intake note can be corrected/expanded once the item's actually been looked
// at. Logs a status-log comment (no status change) so the edit is visible in
// the history the service rep sees, not just silently overwritten.
router.patch('/:id', requirePermission('work_orders'), async (req, res) => {
  try {
    const { description, item_label, item_serial, employee_id } = req.body;
    const { rows: [wo] } = await db.execute({ sql: 'SELECT * FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (['complete', 'awaiting_pickup', 'picked_up', 'cancelled', 'not_worth_fixing'].includes(wo.status)) return res.status(400).json({ error: `Cannot edit a ${wo.status} work order` });
    if (description != null && !description.trim()) return res.status(400).json({ error: 'Description cannot be empty' });

    const newDescription = description != null ? description.trim() : wo.description;
    await db.execute({ sql: 'UPDATE work_orders SET description = ?, item_label = ?, item_serial = ? WHERE id = ?', args: [newDescription, item_label != null ? item_label : wo.item_label, item_serial != null ? (String(item_serial).trim() || null) : wo.item_serial, req.params.id] });
    if (description != null && description.trim() !== wo.description) {
      await logStatus(db, req.params.id, wo.status, `Description updated: ${description.trim()}`, employee_id);
    }
    const { rows: [updated] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Customer P.O. # for the invoice — editable at any stage (often given at pickup).
router.patch('/:id/po-number', requirePermission('work_orders'), async (req, res) => {
  try {
    const { rows: [wo] } = await db.execute({ sql: 'SELECT id FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    await db.execute({ sql: 'UPDATE work_orders SET po_number = ? WHERE id = ?', args: [String(req.body.po_number || '').trim() || null, req.params.id] });
    const { rows: [updated] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/label', async (req, res) => {
  try {
    const { rows: [wo] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
    if (!wo) return res.status(404).send('Not found');
    wo.accessories = (await loadIntakeRecord(wo.id)).accessories;
    res.json(wo); // frontend renders the printable label itself, same as printRentalDeliveryNote
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/accessories', requireAnyPermission('work_orders', 'wo_intake'), async (req, res) => {
  try {
    const { rows: [wo] } = await db.execute({ sql: 'SELECT id, status, returned_to_customer_at FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (INTAKE_LOCKED.includes(wo.status) || wo.returned_to_customer_at) return res.status(400).json({ error: wo.returned_to_customer_at ? 'The item has been returned to the customer' : `This work order is ${wo.status.replace('_', ' ')}` });
    const clean = cleanAccessory(req.body);
    if (clean.error) return res.status(400).json({ error: clean.error });
    const employeeId = req.employee?.id;
    const { line_no } = await insertAccessory(db, wo.id, clean, employeeId);
    await logStatus(db, wo.id, wo.status, `Accessory A${line_no} added: ${clean.name}`, employeeId);
    res.status(201).json(await loadIntakeRecord(wo.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/accessories/:aid', requireAnyPermission('work_orders', 'wo_intake'), async (req, res) => {
  try {
    const { rows: [a] } = await db.execute({ sql: 'SELECT a.*, wo.status FROM work_order_accessories a JOIN work_orders wo ON a.work_order_id = wo.id WHERE a.id = ? AND a.work_order_id = ?', args: [req.params.aid, req.params.id] });
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.status !== 'intake') return res.status(400).json({ error: 'Accessories stay on the record once the assessment fee is paid' });
    const { rows: photos } = await db.execute({ sql: 'SELECT * FROM work_order_photos WHERE accessory_id = ?', args: [a.id] });
    for (const p of photos) await removePhotoFile(p);
    await db.execute({ sql: 'DELETE FROM work_order_photos WHERE accessory_id = ?', args: [a.id] });
    await db.execute({ sql: 'DELETE FROM work_order_accessories WHERE id = ?', args: [a.id] });
    await logStatus(db, a.work_order_id, a.status, `Accessory A${a.line_no} removed: ${a.name}`, req.employee?.id);
    res.json(await loadIntakeRecord(a.work_order_id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// One photo per request; accessory_id ties it to an accessory, else it's of the item
router.post('/:id/photos', requireAnyPermission('work_orders', 'wo_intake'), (req, res, next) => {
  photoUpload.single('photo')(req, res, err => err ? res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Photo is larger than 15 MB' : err.message }) : next());
}, async (req, res) => {
  try {
    const { rows: [wo] } = await db.execute({ sql: 'SELECT id, status, returned_to_customer_at FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (INTAKE_LOCKED.includes(wo.status) || wo.returned_to_customer_at) return res.status(400).json({ error: wo.returned_to_customer_at ? 'The item has been returned to the customer' : `This work order is ${wo.status.replace('_', ' ')}` });
    if (!req.file) return res.status(400).json({ error: 'No photo uploaded, or the file is not an image' });
    let accessoryId = null;
    if (req.body.accessory_id) {
      const { rows: [a] } = await db.execute({ sql: 'SELECT id FROM work_order_accessories WHERE id = ? AND work_order_id = ?', args: [req.body.accessory_id, wo.id] });
      if (!a) return res.status(400).json({ error: 'That accessory is not on this work order' });
      accessoryId = a.id;
    }
    const storedName = await storePhotoFile(wo.id, req.file);
    await db.execute({ sql: 'INSERT INTO work_order_photos (work_order_id, accessory_id, stored_name, original_name, mime_type, file_size, uploaded_by) VALUES (?,?,?,?,?,?,?)',
      args: [wo.id, accessoryId, storedName, req.file.originalname, req.file.mimetype, req.file.size, req.employee?.id || null] });
    res.status(201).json(await loadIntakeRecord(wo.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/photos/:pid', requireAnyPermission('work_orders', 'wo_intake'), async (req, res) => {
  try {
    const { rows: [p] } = await db.execute({ sql: 'SELECT p.*, wo.status FROM work_order_photos p JOIN work_orders wo ON p.work_order_id = wo.id WHERE p.id = ? AND p.work_order_id = ?', args: [req.params.pid, req.params.id] });
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (p.movement_id) return res.status(400).json({ error: 'Checkpoint photos stay on the record' });
    if (p.status !== 'intake') return res.status(400).json({ error: 'Photos stay on the record once the assessment fee is paid' });
    await removePhotoFile(p);
    await db.execute({ sql: 'DELETE FROM work_order_photos WHERE id = ?', args: [p.id] });
    res.json(await loadIntakeRecord(p.work_order_id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Item movements: store → Warehouse → service center and back ─────────
// lib/woMovements.js works out the next step; these record it. A receive is
// a checkpoint: at least one photo of the item and every accessory marked
// OK / damaged / missing (a note for the last two), with optional photos each.

async function loadWoForMovement(id) {
  const { rows: [wo] } = await db.execute({ sql: `SELECT wo.*, b.name as branch_name, b.is_warehouse as branch_is_warehouse FROM work_orders wo LEFT JOIN branches b ON wo.branch_id = b.id WHERE wo.id = ?`, args: [id] });
  if (!wo) return null;
  const { rows: moves } = await db.execute({ sql: 'SELECT * FROM work_order_movements WHERE work_order_id = ? ORDER BY id', args: [id] });
  wo.state = movementState(wo, moves);
  return wo;
}

async function assessmentWaitsForServiceCenter(wo) {
  if (!Number(wo.movement_tracked)) return false;
  const full = await loadWoForMovement(wo.id);
  return full.state.assessment_blocked;
}

// Pickup (owner's rule, 2026-11-23): the item has to be received back where it
// was taken in before it's placed on the cashier's hold, paid for and collected,
// or handed back unrepaired.
async function itemNotBackError(woId) {
  const wo = await loadWoForMovement(woId);
  if (!wo || wo.state.at_home) return null;
  const home = locationLabel(wo.state.home, wo);
  const where = wo.state.in_transit ? `on its way to the ${locationLabel(wo.state.in_transit.to, wo)}` : `at the ${locationLabel(wo.state.location, wo)}`;
  return `The item is ${where}, not back at ${home} yet — it has to be received there before the customer can collect it`;
}

async function movementResponse(woId) {
  const { rows: [wo] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [woId] });
  wo.movements = await loadMovements(db, woId);
  wo.movement = movementState(wo, wo.movements);
  return wo;
}

router.post('/:id/movements/send', requirePermission('wo_movements'), async (req, res) => {
  try {
    const wo = await loadWoForMovement(req.params.id);
    if (!wo) return res.status(404).json({ error: 'Not found' });
    const next = wo.state.next;
    if (!next || next.kind !== 'send') return res.status(400).json({ error: next ? `The item is on its way to the ${locationLabel(next.to, wo)} — receive it there first` : 'There is nothing to send on this work order' });
    if (req.body.to && req.body.to !== next.to) return res.status(400).json({ error: `The item goes to the ${locationLabel(next.to, wo)} next` });
    const carriedBy = String(req.body.carried_by || '').trim();
    if (!carriedBy) return res.status(400).json({ error: 'Who is taking it? Enter the driver or person carrying the item' });
    const notes = String(req.body.notes || '').trim() || null;
    const who = req.employee?.id || null;
    await db.execute({ sql: 'INSERT INTO work_order_movements (work_order_id, kind, from_location, to_location, carried_by, notes, employee_id) VALUES (?,?,?,?,?,?,?)',
      args: [wo.id, 'send', next.from, next.to, carriedBy, notes, who] });
    await logStatus(db, wo.id, wo.status, `Item sent from ${locationLabel(next.from, wo)} to ${locationLabel(next.to, wo)} — carried by ${carriedBy}${notes ? ` (${notes})` : ''}`, who);
    res.status(201).json(await movementResponse(wo.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// multipart: `item_photos` (one or more), `acc_photo_<accessory id>` (optional),
// `accessories` = JSON [{accessory_id, condition, note}], `notes`
router.post('/:id/movements/receive', requirePermission('wo_movements'), (req, res, next) => {
  photoUpload.any()(req, res, err => err ? res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'A photo is larger than 15 MB' : err.message }) : next());
}, async (req, res) => {
  try {
    const wo = await loadWoForMovement(req.params.id);
    if (!wo) return res.status(404).json({ error: 'Not found' });
    const next = wo.state.next;
    if (!next || next.kind !== 'receive') return res.status(400).json({ error: 'The item is not on its way anywhere — it has to be sent first' });
    if (req.body.at && req.body.at !== next.to) return res.status(400).json({ error: `The item is on its way to the ${locationLabel(next.to, wo)}` });
    const files = req.files || [];
    const itemPhotos = files.filter(f => f.fieldname === 'item_photos');
    if (!itemPhotos.length) return res.status(400).json({ error: 'Take at least one photo of the item as it arrived' });
    const { rows: accessories } = await db.execute({ sql: 'SELECT id, line_no, name FROM work_order_accessories WHERE work_order_id = ? ORDER BY line_no', args: [wo.id] });
    let given;
    try { given = typeof req.body.accessories === 'string' ? JSON.parse(req.body.accessories || '[]') : (req.body.accessories || []); }
    catch(e) { return res.status(400).json({ error: 'The accessory checklist could not be read' }); }
    const checked = checkAccessories(accessories, given);
    if (checked.error) return res.status(400).json({ error: checked.error });
    const accPhotos = files.filter(f => /^acc_photo_\d+$/.test(f.fieldname)).map(f => ({ file: f, accessory_id: Number(f.fieldname.slice(10)) }));
    if (accPhotos.some(p => !accessories.some(a => a.id === p.accessory_id))) return res.status(400).json({ error: 'A photo is for an accessory that is not on this work order' });

    const stored = [];
    for (const f of itemPhotos) stored.push({ name: await storePhotoFile(wo.id, f), file: f, accessory_id: null });
    for (const p of accPhotos) stored.push({ name: await storePhotoFile(wo.id, p.file), file: p.file, accessory_id: p.accessory_id });

    const who = req.employee?.id || null;
    const notes = String(req.body.notes || '').trim() || null;
    const tx = await db.transaction('write');
    let committed = false;
    try {
      const r = await tx.execute({ sql: 'INSERT INTO work_order_movements (work_order_id, kind, from_location, to_location, send_id, notes, employee_id) VALUES (?,?,?,?,?,?,?)',
        args: [wo.id, 'receive', next.from, next.to, wo.state.in_transit.send_id, notes, who] });
      const movementId = Number(r.lastInsertRowid);
      for (const c of checked.checks) {
        await tx.execute({ sql: 'INSERT INTO work_order_movement_accessories (movement_id, accessory_id, condition, note) VALUES (?,?,?,?)', args: [movementId, c.accessory_id, c.condition, c.note] });
      }
      for (const p of stored) {
        await tx.execute({ sql: 'INSERT INTO work_order_photos (work_order_id, accessory_id, movement_id, stored_name, original_name, mime_type, file_size, uploaded_by) VALUES (?,?,?,?,?,?,?,?)',
          args: [wo.id, p.accessory_id, movementId, p.name, p.file.originalname, p.file.mimetype, p.file.size, who] });
      }
      const problems = checked.checks.filter(c => c.condition !== 'ok').map(c => `A${c.line_no} ${c.name} ${c.condition}: ${c.note}`);
      await logStatus(tx, wo.id, wo.status, `Item received at ${locationLabel(next.to, wo)} — ${itemPhotos.length} photo(s)${checked.checks.length ? `, ${checked.checks.length - problems.length}/${checked.checks.length} accessories OK` : ''}${problems.length ? `; ${problems.join('; ')}` : ''}${notes ? ` (${notes})` : ''}`, who);
      await tx.commit();
      committed = true;
    } finally {
      if (!committed) {
        await tx.rollback().catch(() => {});
        for (const p of stored) await removePhotoFile({ stored_name: p.name });
      }
    }
    res.status(201).json(await movementResponse(wo.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Assessment fee (charged at intake, before the item is assessed) ──────

// No pre-existing "hold" transaction row — mirrors how rental checkout works
// (rental_agreements.status IS the held state; the transaction is created
// fresh right here, at finalize time), not the quote-convert pattern (which
// creates a literal status='hold' transactions row up front). A WO's
// "held" state is just its own status='intake', which is what the POS Hold
// Recall list below queries against.
router.patch('/:id/assessment-paid', requireAnyPermission('wo_assess', 'pos'), async (req, res) => {
  try {
    const { payment_method, amount_tendered, employee_id, drawer_session_id, branch_id } = req.body;
    const { rows: [wo] } = await db.execute({ sql: 'SELECT * FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (wo.status !== 'intake') return res.status(400).json({ error: `This work order is ${wo.status}, not awaiting the assessment fee` });

    const method = payment_method || 'cash';
    const subtotal = wo.assessment_fee;
    const taxAmt = parseFloat((subtotal * (parseFloat(wo.assessment_fee_tax_rate) || 0) / 100).toFixed(2));
    const total = parseFloat((subtotal + taxAmt).toFixed(2));
    const tendered = parseFloat(amount_tendered || total);
    const changeAmt = Math.max(0, parseFloat((tendered - total).toFixed(2)));
    const transaction_number = await nextNumber(db, 'transactions', 'transaction_number', 'TXN-', 6);

    const tx = await db.transaction('write');
    let committed = false;
    try {
      const txResult = await tx.execute({ sql: `INSERT INTO transactions (transaction_number,customer_id,employee_id,salesperson_id,branch_id,drawer_session_id,subtotal,tax_amount,total,payment_method,amount_tendered,change_amount,notes,source) VALUES (?,?,?,${CUSTOMER_SALESPERSON_SQL},?,?,?,?,?,?,?,?,?,?)`, args: [transaction_number, wo.customer_id, employee_id || null, wo.customer_id, branch_id || wo.branch_id || null, drawer_session_id || null, subtotal, taxAmt, total, method, tendered, changeAmt, `Work order assessment fee ${wo.wo_number}`, 'pos'] });
      const txId = Number(txResult.lastInsertRowid);
      await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?)`, args: [txId, wo.assessment_fee_name || 'Assessment Fee', 'WO-ASSESS', 1, subtotal, taxAmt, subtotal] });
      await tx.execute({ sql: `UPDATE work_orders SET assessment_transaction_id = ?, status = 'assessed' WHERE id = ?`, args: [txId, req.params.id] });
      await logStatus(tx, req.params.id, 'assessed', `Assessment fee paid (${method})`, employee_id);
      await tx.commit();
      committed = true;
      const { rows: [updated] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
      res.json(updated);
    } catch(e) {
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Estimate + deposit ─────────────────────────────────────────────────────

// Express same-day service is a discretionary call — how busy the queue is,
// how hard the job looks — so it's restricted to whoever holds wo_signoff
// (the same "supervisor" permission /:id/signoff below is gated on), not
// every wo_assess holder doing routine assessments. The 25% is folded
// straight into the stored labor/consumables amounts so every other balance
// calculation in the app (final payment, POS Hold Recall, the schedule
// modal) keeps working unmodified — is_express is kept only as the
// audit/display flag that a surcharge was applied.
const EXPRESS_SURCHARGE = 1.25;

router.patch('/:id/estimate', requirePermission('wo_assess'), async (req, res) => {
  try {
    const { estimate_labor, estimate_consumables, estimate_notes, deposit_amount, is_express, employee_id } = req.body;
    const { rows: [wo] } = await db.execute({ sql: 'SELECT * FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (wo.status !== 'assessed') return res.status(400).json({ error: `This work order is ${wo.status}, not awaiting an estimate` });
    if (await assessmentWaitsForServiceCenter(wo)) return res.status(400).json({ error: 'The item has not been received at the Service Center yet — it is assessed once the Service Center checkpoint is done' });
    // Deposit is optional (recent process change) — a $0/blank deposit skips
    // the pending_deposit stop entirely and goes straight to in_progress,
    // the same way a $0 final balance below skips creating a payment
    // transaction rather than forcing a pointless $0 charge through the register.
    const deposit = parseFloat(deposit_amount) || 0;

    const expressRequested = !!is_express;
    if (expressRequested && !req.apiKey && !can(req.employee && req.employee.permissions, 'wo_signoff')) {
      return res.status(403).json({ error: 'Express same-day service is a supervisor call — missing permission: wo_signoff' });
    }
    const surcharge = expressRequested ? EXPRESS_SURCHARGE : 1;
    const laborAmt = parseFloat(((parseFloat(estimate_labor) || 0) * surcharge).toFixed(2));
    const consumablesAmt = parseFloat(((parseFloat(estimate_consumables) || 0) * surcharge).toFixed(2));
    const newStatus = deposit > 0 ? 'pending_deposit' : 'in_progress';

    // Labor/consumables are free-typed dollar amounts with no catalog
    // product behind them to carry their own tax rate — the company's
    // current default is snapshotted here instead (same reasoning as
    // assessment_fee_tax_rate), so a later change to the default doesn't
    // retroactively change an estimate already quoted.
    const { rows: [taxSetting] } = await db.execute({ sql: "SELECT value FROM settings WHERE key = 'tax_rate'", args: [] });
    const estimateTaxRate = parseFloat(taxSetting?.value) || 0;

    await db.execute({ sql: `UPDATE work_orders SET estimate_labor = ?, estimate_consumables = ?, estimate_notes = ?, deposit_amount = ?, is_express = ?, estimate_tax_rate = ?, status = ? WHERE id = ?`,
      args: [laborAmt, consumablesAmt, estimate_notes || null, deposit, expressRequested ? 1 : 0, estimateTaxRate, newStatus, req.params.id] });
    await logStatus(db, req.params.id, newStatus, `Estimate entered — labor ${laborAmt}, consumables ${consumablesAmt}${expressRequested ? ' (express same-day, +25% applied)' : ''}${deposit > 0 ? `, deposit due ${deposit}` : ', no deposit required — work can begin'}`, employee_id);
    const { rows: [updated] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id/deposit-paid', requireAnyPermission('wo_assess', 'pos'), async (req, res) => {
  try {
    const { payment_method, amount_tendered, employee_id, drawer_session_id, branch_id } = req.body;
    const { rows: [wo] } = await db.execute({ sql: 'SELECT * FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (wo.status !== 'pending_deposit') return res.status(400).json({ error: `This work order is ${wo.status}, not awaiting the deposit` });

    const method = payment_method || 'cash';
    const total = wo.deposit_amount;
    const tendered = parseFloat(amount_tendered || total);
    const changeAmt = Math.max(0, parseFloat((tendered - total).toFixed(2)));
    const transaction_number = await nextNumber(db, 'transactions', 'transaction_number', 'TXN-', 6);

    const tx = await db.transaction('write');
    let committed = false;
    try {
      const txResult = await tx.execute({ sql: `INSERT INTO transactions (transaction_number,customer_id,employee_id,salesperson_id,branch_id,drawer_session_id,subtotal,tax_amount,total,payment_method,amount_tendered,change_amount,notes,source) VALUES (?,?,?,${CUSTOMER_SALESPERSON_SQL},?,?,?,?,?,?,?,?,?,?)`, args: [transaction_number, wo.customer_id, employee_id || null, wo.customer_id, branch_id || wo.branch_id || null, drawer_session_id || null, total, 0, total, method, tendered, changeAmt, `Work order deposit ${wo.wo_number}`, 'pos'] });
      const txId = Number(txResult.lastInsertRowid);
      await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?)`, args: [txId, 'Deposit', 'WO-DEPOSIT', 1, total, 0, total] });
      await tx.execute({ sql: `UPDATE work_orders SET deposit_transaction_id = ?, status = 'in_progress' WHERE id = ?`, args: [txId, req.params.id] });
      await logStatus(tx, req.params.id, 'in_progress', `Deposit paid (${method})`, employee_id);
      await tx.commit();
      committed = true;
      const { rows: [updated] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
      res.json(updated);
    } catch(e) {
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Free status/comment updates + cancel ──────────────────────────────────

router.patch('/:id/status', requirePermission('work_orders'), async (req, res) => {
  try {
    const { status, comment, employee_id } = req.body;
    const { rows: [wo] } = await db.execute({ sql: 'SELECT * FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (!comment || !comment.trim()) return res.status(400).json({ error: 'A comment is required' });
    let newStatus = wo.status;
    if (status && status !== wo.status) {
      if (!FREE_STATUS_TRANSITIONS.includes(status)) return res.status(400).json({ error: `Cannot set status to ${status} directly — use the dedicated action for that step` });
      if (!ACTIVE_WORK_STATUSES.includes(wo.status)) return res.status(400).json({ error: `This work order is ${wo.status}, not in progress` });
      newStatus = status;
      // Not Worth Fixing ends the job — the customer's 30-day pickup window starts now
      await db.execute({ sql: `UPDATE work_orders SET status = ?${newStatus === 'not_worth_fixing' ? ", pickup_due_date = date('now','+30 days')" : ''} WHERE id = ?`, args: [newStatus, req.params.id] });
    }
    await logStatus(db, req.params.id, newStatus, comment.trim(), employee_id);
    const { rows: [updated] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id/cancel', requirePermission('work_orders'), async (req, res) => {
  try {
    const { reason, employee_id } = req.body;
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'A cancellation reason is required' });
    const { rows: [wo] } = await db.execute({ sql: 'SELECT * FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (['in_progress', 'awaiting_signoff', 'complete', 'awaiting_pickup', 'picked_up', 'cancelled'].includes(wo.status)) {
      return res.status(400).json({ error: `Cannot cancel a work order that's already ${wo.status} — the deposit has been collected and work has started` });
    }
    await db.execute({ sql: `UPDATE work_orders SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = ? WHERE id = ?`, args: [reason.trim(), req.params.id] });
    await logStatus(db, req.params.id, 'cancelled', reason.trim(), employee_id);
    const { rows: [updated] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Tasks & time tracking ──────────────────────────────────────────────────

async function syncTaskSkills(taskId, skillIds) {
  if (!Array.isArray(skillIds)) return;
  await db.execute({ sql: 'DELETE FROM work_order_task_skills WHERE task_id = ?', args: [taskId] });
  for (const skillId of skillIds) {
    await db.execute({ sql: 'INSERT OR IGNORE INTO work_order_task_skills (task_id, skill_id) VALUES (?,?)', args: [taskId, skillId] });
  }
}

async function loadWoCalls(woId) {
  const { rows } = await db.execute({ sql: `SELECT c.*, e.first_name || ' ' || e.last_name as employee_name FROM work_order_calls c
    LEFT JOIN employees e ON e.id = c.employee_id WHERE c.work_order_id = ? ORDER BY c.called_at DESC, c.id DESC`, args: [woId] });
  return rows;
}


// Log a follow-up call. On a complete job, reaching the customer is the
// ready-for-pickup notification: the job moves to awaiting_pickup with
// notification_method = the call's method, same as Notify Customer did.
router.post('/:id/calls', requirePermission('work_orders'), async (req, res) => {
  try {
    const b = req.body || {};
    const { rows: [wo] } = await db.execute({ sql: 'SELECT * FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (['picked_up', 'cancelled'].includes(wo.status) && !b.allow_closed) return res.status(400).json({ error: `This work order is ${wo.status.replace(/_/g, ' ')} — no follow-up needed` });
    const outcome = String(b.outcome || '');
    if (!CALL_OUTCOMES[outcome]) return res.status(400).json({ error: 'Pick the outcome of the call' });
    const method = CALL_METHODS[b.method] ? b.method : 'phone';
    const notes = String(b.notes || '').trim() || null;
    if (outcome === 'other' && !notes) return res.status(400).json({ error: 'Add a note saying what happened' });
    const today = storeToday();
    const day = v => { const t = String(v || '').trim(); if (!t) return null; if (!DAY_ONLY.test(t)) throw Object.assign(new Error('Dates must be YYYY-MM-DD'), { status: 400 }); return t; };
    let promised, next;
    try { promised = day(b.promised_date); next = day(b.next_follow_up); } catch (e) { return res.status(400).json({ error: e.message }); }
    if (outcome === 'will_collect' && !promised) return res.status(400).json({ error: 'When did the customer say they will collect?' });
    if (promised && promised < today) return res.status(400).json({ error: "The promised pickup date can't be in the past" });
    if (next && next < today) return res.status(400).json({ error: "The next follow-up date can't be in the past" });
    // A promise to collect books the next call for the day after, unless one was set.
    if (!next && promised) { const d = new Date(`${promised}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); next = d.toISOString().slice(0, 10); }
    const who = req.employee?.id || b.employee_id || null;
    const notify = wo.status === 'complete' && CALL_REACHED.includes(outcome);
    const tx = await db.transaction('write');
    let committed = false, id;
    try {
      const r = await tx.execute({ sql: `INSERT INTO work_order_calls (work_order_id, employee_id, method, contact, outcome, promised_date, next_follow_up, notes, counted_as_notification) VALUES (?,?,?,?,?,?,?,?,?)`,
        args: [wo.id, who, method, String(b.contact || '').trim() || null, outcome, promised, next, notes, notify ? 1 : 0] });
      id = Number(r.lastInsertRowid);
      const summary = `${CALL_METHODS[method]} follow-up: ${CALL_OUTCOMES[outcome]}${promised ? ` — will collect ${promised}` : ''}${next ? `; next follow-up ${next}` : ''}${notes ? `. ${notes}` : ''}`;
      if (notify) {
        await tx.execute({ sql: `UPDATE work_orders SET status = 'awaiting_pickup', notification_method = ?, notified_at = CURRENT_TIMESTAMP, notified_by = ? WHERE id = ?`, args: [method, who, wo.id] });
        await logStatus(tx, wo.id, 'awaiting_pickup', `Customer notified — ${summary}`, who);
      } else {
        await logStatus(tx, wo.id, wo.status, summary, who);
      }
      await tx.commit();
      committed = true;
    } catch (e) {
      if (!committed) await tx.rollback();
      throw e;
    }
    const { rows: [call] } = await db.execute({ sql: `SELECT c.*, e.first_name || ' ' || e.last_name as employee_name FROM work_order_calls c LEFT JOIN employees e ON e.id = c.employee_id WHERE c.id = ?`, args: [id] });
    res.status(201).json({ call, notified: notify });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ─── Documents (signed contract etc.) ─────────────────────────────────────
// Same pattern as quote attachments: download only through the route below.
// Anyone on work orders (or intake) can attach; removing a signed contract
// needs supervisor sign-off (wo_signoff) since it's the customer's agreement.
const woDocDir = path.join(__dirname, '../uploads/wo-attachments');
const WO_DOC_TYPES = { signed_contract: 'Signed contract', other: 'Other' };
const woDocUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(file.mimetype)),
});
const WO_DOC_SELECT = `SELECT a.*, e.first_name || ' ' || e.last_name as uploaded_by_name FROM work_order_attachments a LEFT JOIN employees e ON e.id = a.uploaded_by`;

async function loadWoDocuments(woId) {
  const { rows } = await db.execute({ sql: `${WO_DOC_SELECT} WHERE a.work_order_id = ? ORDER BY a.uploaded_at DESC, a.id DESC`, args: [woId] });
  return rows;
}

router.get('/:id/attachments', requireAnyPermission('work_orders', 'wo_intake'), async (req, res) => {
  try { res.json(await loadWoDocuments(req.params.id)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/attachments', requireAnyPermission('work_orders', 'wo_intake'), (req, res, next) => {
  woDocUpload.single('file')(req, res, err => err ? res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 20 MB' : err.message }) : next());
}, async (req, res) => {
  try {
    const { rows: [wo] } = await db.execute({ sql: 'SELECT id, status FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded, or that file type isn\'t allowed (PDF, image or Word document)' });
    const docType = WO_DOC_TYPES[req.body.document_type] ? req.body.document_type : 'other';
    const cloud = await cloudUpload(req.file.buffer, { folder: 'pos-system/wo-attachments', public_id: `${Date.now()}-${Math.round(Math.random() * 1e6)}`, resource_type: 'auto' });
    let storedName;
    if (cloud) storedName = cloud.secure_url;
    else {
      fs.mkdirSync(woDocDir, { recursive: true });
      storedName = `${Date.now()}-${Math.round(Math.random() * 1e6)}${path.extname(req.file.originalname)}`;
      fs.writeFileSync(path.join(woDocDir, storedName), req.file.buffer);
    }
    const who = req.employee?.id || null;
    const r = await db.execute({ sql: 'INSERT INTO work_order_attachments (work_order_id, document_type, original_name, stored_name, mime_type, file_size, notes, uploaded_by) VALUES (?,?,?,?,?,?,?,?)',
      args: [wo.id, docType, req.file.originalname, storedName, req.file.mimetype, req.file.size, String(req.body.notes || '').trim() || null, who] });
    await logStatus(db, wo.id, wo.status, `${WO_DOC_TYPES[docType]} attached: ${req.file.originalname}`, who);
    const { rows: [row] } = await db.execute({ sql: `${WO_DOC_SELECT} WHERE a.id = ?`, args: [Number(r.lastInsertRowid)] });
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/attachments/:aid/download', requireAnyPermission('work_orders', 'wo_intake'), async (req, res) => {
  try {
    const { rows: [att] } = await db.execute({ sql: 'SELECT * FROM work_order_attachments WHERE id = ? AND work_order_id = ?', args: [req.params.aid, req.params.id] });
    if (!att) return res.status(404).json({ error: 'Not found' });
    if (att.stored_name.startsWith('https://')) return res.redirect(att.stored_name.replace('/upload/', '/upload/fl_attachment/'));
    const filePath = path.join(woDocDir, att.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on server' });
    res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
    // Open PDFs/images in the browser; anything else downloads.
    if (/^(application\/pdf|image\/)/.test(att.mime_type || '')) res.setHeader('Content-Disposition', `inline; filename="${att.original_name.replace(/"/g, '')}"`);
    else res.attachment(att.original_name);
    res.sendFile(filePath);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/attachments/:aid', requireAnyPermission('work_orders', 'wo_intake'), async (req, res) => {
  try {
    const { rows: [att] } = await db.execute({ sql: 'SELECT * FROM work_order_attachments WHERE id = ? AND work_order_id = ?', args: [req.params.aid, req.params.id] });
    if (!att) return res.status(404).json({ error: 'Not found' });
    if (att.document_type === 'signed_contract' && !req.apiKey && !can(req.employee && req.employee.permissions, 'wo_signoff'))
      return res.status(403).json({ error: 'Only a supervisor (Supervisor Sign-Off) can remove a signed contract' });
    if (att.stored_name.startsWith('https://')) {
      const resourceType = (att.stored_name.match(/\/(image|raw|video)\/upload\//) || [])[1] || 'raw';
      await cloudDestroy(att.stored_name, resourceType);
    } else { try { fs.unlinkSync(path.join(woDocDir, att.stored_name)); } catch (e) {} }
    await db.execute({ sql: 'DELETE FROM work_order_attachments WHERE id = ?', args: [att.id] });
    const { rows: [wo] } = await db.execute({ sql: 'SELECT status FROM work_orders WHERE id = ?', args: [att.work_order_id] });
    await logStatus(db, att.work_order_id, wo.status, `${WO_DOC_TYPES[att.document_type] || 'Document'} removed: ${att.original_name}`, req.employee?.id || null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/external-work', requireAnyPermission('wo_technician', 'wo_assess'), async (req, res) => {
  try {
    const { rows: [wo] } = await db.execute({ sql: 'SELECT id, wo_number, branch_id, status FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    const x = await cleanExternalWork(req.body || {});
    if (x.error) return res.status(400).json({ error: x.error });
    const wantBill = x.supplier_id && x.create_bill && x.cost > 0;
    if (wantBill) { const clash = await externalInvoiceClash(db, x.supplier_id, x.reference); if (clash) return res.status(400).json({ error: clash }); }
    const who = req.employee?.id || null;
    const tx = await db.transaction('write');
    let committed = false, id;
    try {
      const billId = wantBill ? await createBill(tx, { ...externalBillFields(wo, x), source: 'work_order', created_by: who }) : null;
      const r = await tx.execute({ sql: `INSERT INTO work_order_external_work (work_order_id, supplier_id, company_name, technician_name, phone, email, description, labour_hours, hourly_rate, other_cost, tax_amount, cost, reference, sent_date, returned_date, notes, ap_bill_id, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [wo.id, x.supplier_id, x.company_name, x.technician_name, x.phone, x.email, x.description, x.labour_hours, x.hourly_rate, x.other_cost, x.tax_amount, x.cost, x.reference, x.sent_date, x.returned_date, x.notes, billId, who] });
      id = Number(r.lastInsertRowid);
      const { rows: [b] } = billId ? await tx.execute({ sql: 'SELECT bill_number FROM ap_bills WHERE id = ?', args: [billId] }) : { rows: [] };
      await logStatus(tx, wo.id, wo.status, `External work added: ${externalLabel(x)} — ${x.description} (cost ${x.cost.toFixed(2)})${b ? `, A/P bill ${b.bill_number}` : ''}`, who);
      await tx.commit();
      committed = true;
    } catch (e) {
      if (!committed) await tx.rollback();
      throw e;
    }
    const { rows: [row] } = await db.execute({ sql: `${EXTERNAL_SELECT} WHERE x.id = ?`, args: [id] });
    res.status(201).json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id/external-work/:xid', requireAnyPermission('wo_technician', 'wo_assess'), async (req, res) => {
  try {
    const { rows: [old] } = await db.execute({ sql: 'SELECT * FROM work_order_external_work WHERE id = ? AND work_order_id = ?', args: [req.params.xid, req.params.id] });
    if (!old) return res.status(404).json({ error: 'Not found' });
    const { rows: [wo] } = await db.execute({ sql: 'SELECT id, wo_number, branch_id, status FROM work_orders WHERE id = ?', args: [old.work_order_id] });
    const x = await cleanExternalWork(req.body || {});
    if (x.error) return res.status(400).json({ error: x.error });
    const state = await externalBillState(db, old.ap_bill_id);
    const wantBill = x.supplier_id && x.create_bill && x.cost > 0;
    if (state?.locked) {
      const b = state.bill;
      if (!wantBill || Number(x.supplier_id) !== Number(b.supplier_id) || r2(x.cost) !== r2(b.amount) || r2(x.tax_amount) !== r2(b.tax_amount)
        || (x.reference || '') !== (b.vendor_invoice_number || ''))
        return res.status(400).json({ error: `A/P bill ${b.bill_number} ${state.locked} — its supplier, cost, GCT and invoice # can't change here now. Ask Accounts Payable.` });
    }
    if (wantBill) { const clash = await externalInvoiceClash(db, x.supplier_id, x.reference, state?.bill.id); if (clash) return res.status(400).json({ error: clash }); }
    const who = req.employee?.id || null;
    const tx = await db.transaction('write');
    let committed = false;
    try {
      let billId = state ? state.bill.id : null, billNote = '';
      if (state && !wantBill) {
        await tx.execute({ sql: VOID_BILL_SQL, args: [`${wo.wo_number} external work no longer billed`, who, billId] });
        billNote = `, A/P bill ${state.bill.bill_number} voided`; billId = null;
      } else if (state && !state.locked) {
        const f = externalBillFields(wo, x);
        // The bill keeps its own dates once entered unless the return date moved.
        const keepDates = (old.returned_date || null) === (x.returned_date || null);
        await tx.execute({ sql: 'UPDATE ap_bills SET supplier_id = ?, vendor_invoice_number = ?, amount = ?, tax_amount = ?, description = ?, bill_date = ?, due_date = ? WHERE id = ?',
          args: [f.supplier_id, f.vendor_invoice_number, f.amount, f.tax_amount, f.description, keepDates ? state.bill.bill_date : f.bill_date, keepDates ? state.bill.due_date : f.due_date, billId] });
        if (r2(state.bill.amount) !== r2(x.cost) || Number(state.bill.supplier_id) !== Number(x.supplier_id)) billNote = `, A/P bill ${state.bill.bill_number} updated`;
      } else if (!state && wantBill) {
        billId = await createBill(tx, { ...externalBillFields(wo, x), source: 'work_order', created_by: who });
        const { rows: [b] } = await tx.execute({ sql: 'SELECT bill_number FROM ap_bills WHERE id = ?', args: [billId] });
        billNote = `, A/P bill ${b.bill_number} raised`;
      }
      await tx.execute({ sql: `UPDATE work_order_external_work SET supplier_id = ?, company_name = ?, technician_name = ?, phone = ?, email = ?, description = ?, labour_hours = ?, hourly_rate = ?, other_cost = ?, tax_amount = ?, cost = ?, reference = ?, sent_date = ?, returned_date = ?, notes = ?, ap_bill_id = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        args: [x.supplier_id, x.company_name, x.technician_name, x.phone, x.email, x.description, x.labour_hours, x.hourly_rate, x.other_cost, x.tax_amount, x.cost, x.reference, x.sent_date, x.returned_date, x.notes, billId, who, old.id] });
      if (r2(old.cost) !== x.cost || billNote)
        await logStatus(tx, wo.id, wo.status, `External work ${r2(old.cost) !== x.cost ? `cost changed: ${externalLabel(x)} — ${Number(old.cost).toFixed(2)} → ${x.cost.toFixed(2)}` : `updated: ${externalLabel(x)}`}${billNote}`, who);
      await tx.commit();
      committed = true;
    } catch (e) {
      if (!committed) await tx.rollback();
      throw e;
    }
    const { rows: [row] } = await db.execute({ sql: `${EXTERNAL_SELECT} WHERE x.id = ?`, args: [old.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/external-work/:xid', requireAnyPermission('wo_technician', 'wo_assess'), async (req, res) => {
  try {
    const { rows: [old] } = await db.execute({ sql: 'SELECT * FROM work_order_external_work WHERE id = ? AND work_order_id = ?', args: [req.params.xid, req.params.id] });
    if (!old) return res.status(404).json({ error: 'Not found' });
    const { rows: [wo] } = await db.execute({ sql: 'SELECT id, wo_number, status FROM work_orders WHERE id = ?', args: [old.work_order_id] });
    const state = await externalBillState(db, old.ap_bill_id);
    if (state?.locked) return res.status(400).json({ error: `A/P bill ${state.bill.bill_number} ${state.locked} — it can't be removed here now. Ask Accounts Payable.` });
    const who = req.employee?.id || null;
    const tx = await db.transaction('write');
    let committed = false;
    try {
      if (state) await tx.execute({ sql: VOID_BILL_SQL, args: [`${wo.wo_number} external work removed`, who, state.bill.id] });
      await tx.execute({ sql: 'DELETE FROM work_order_external_work WHERE id = ?', args: [old.id] });
      await logStatus(tx, wo.id, wo.status, `External work removed: ${externalLabel(old)} — ${old.description} (cost ${Number(old.cost).toFixed(2)})${state ? `, A/P bill ${state.bill.bill_number} voided` : ''}`, who);
      await tx.commit();
      committed = true;
    } catch (e) {
      if (!committed) await tx.rollback();
      throw e;
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/tasks', requirePermission('wo_technician'), async (req, res) => {
  try {
    const { description, allotted_minutes, technician_id, skill_ids } = req.body;
    if (!description || !description.trim()) return res.status(400).json({ error: 'A task description is required' });
    const { rows: [wo] } = await db.execute({ sql: 'SELECT id, status FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (!['in_progress', 'awaiting_signoff', 'awaiting_parts'].includes(wo.status)) return res.status(400).json({ error: `Cannot add tasks to a ${wo.status} work order` });
    const result = await db.execute({ sql: 'INSERT INTO work_order_tasks (work_order_id, description, allotted_minutes, technician_id) VALUES (?,?,?,?)', args: [req.params.id, description.trim(), parseInt(allotted_minutes) || 0, technician_id || null] });
    const taskId = Number(result.lastInsertRowid);
    await syncTaskSkills(taskId, skill_ids);
    const { rows: [task] } = await db.execute({ sql: 'SELECT * FROM work_order_tasks WHERE id = ?', args: [taskId] });
    res.status(201).json(task);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/tasks/:id', requirePermission('wo_technician'), async (req, res) => {
  try {
    const { description, allotted_minutes, technician_id, status, skill_ids } = req.body;
    const { rows: [task] } = await db.execute({ sql: 'SELECT * FROM work_order_tasks WHERE id = ?', args: [req.params.id] });
    if (!task) return res.status(404).json({ error: 'Not found' });
    if (status && !['pending', 'in_progress', 'complete'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    if (status === 'complete') {
      const { rows: [openEntry] } = await db.execute({ sql: 'SELECT id FROM work_order_task_time_entries WHERE task_id = ? AND ended_at IS NULL', args: [req.params.id] });
      if (openEntry) return res.status(400).json({ error: 'Clock out of this task before marking it complete' });
    }
    const newStatus = status || task.status;
    // completed_at: stamped when it becomes complete, cleared if reopened.
    const completing = newStatus === 'complete' && task.status !== 'complete';
    const reopening = newStatus !== 'complete' && task.status === 'complete';
    await db.execute({ sql: `UPDATE work_order_tasks SET description = ?, allotted_minutes = ?, technician_id = ?, status = ?
        ${completing ? ', completed_at = CURRENT_TIMESTAMP, completed_by = ?' : reopening ? ', completed_at = NULL, completed_by = NULL' : ''} WHERE id = ?`, args: [
      description != null ? description.trim() : task.description,
      allotted_minutes != null ? parseInt(allotted_minutes) || 0 : task.allotted_minutes,
      technician_id !== undefined ? (technician_id || null) : task.technician_id,
      newStatus,
      ...(completing ? [req.employee?.id || null] : []),
      req.params.id,
    ] });
    await syncTaskSkills(req.params.id, skill_ids);
    const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM work_order_tasks WHERE id = ?', args: [req.params.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// A technician can only have one open time entry at once, across every task
// on every work order — clocking into a second task without clocking out of
// the first would silently double-count their time.
router.post('/tasks/:id/clock-in', requirePermission('wo_technician'), async (req, res) => {
  try {
    const { technician_id } = req.body;
    if (!technician_id) return res.status(400).json({ error: 'A technician is required' });
    const { rows: [task] } = await db.execute({ sql: 'SELECT * FROM work_order_tasks WHERE id = ?', args: [req.params.id] });
    if (!task) return res.status(404).json({ error: 'Not found' });
    if (task.status === 'complete') return res.status(400).json({ error: 'This task is already marked complete — reopen it before clocking in again' });
    const { rows: [existingOpenOnTask] } = await db.execute({ sql: 'SELECT id FROM work_order_task_time_entries WHERE task_id = ? AND ended_at IS NULL', args: [req.params.id] });
    if (existingOpenOnTask) return res.status(400).json({ error: 'This task already has an active timer' });
    const { rows: [techBusy] } = await db.execute({ sql: 'SELECT te.id, t.description, wo.wo_number FROM work_order_task_time_entries te JOIN work_order_tasks t ON te.task_id = t.id JOIN work_orders wo ON t.work_order_id = wo.id WHERE te.technician_id = ? AND te.ended_at IS NULL', args: [technician_id] });
    if (techBusy) return res.status(400).json({ error: `This technician is already clocked into "${techBusy.description}" on ${techBusy.wo_number} — clock out of that first` });

    await db.execute({ sql: 'INSERT INTO work_order_task_time_entries (task_id, technician_id) VALUES (?,?)', args: [req.params.id, technician_id] });
    if (task.status === 'pending') await db.execute({ sql: `UPDATE work_order_tasks SET status = 'in_progress', technician_id = COALESCE(technician_id, ?) WHERE id = ?`, args: [technician_id, req.params.id] });
    const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM work_order_tasks WHERE id = ?', args: [req.params.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/tasks/:id/clock-out', requirePermission('wo_technician'), async (req, res) => {
  try {
    const { rows: [openEntry] } = await db.execute({ sql: 'SELECT * FROM work_order_task_time_entries WHERE task_id = ? AND ended_at IS NULL', args: [req.params.id] });
    if (!openEntry) return res.status(400).json({ error: 'No active timer on this task' });
    await db.execute({ sql: 'UPDATE work_order_task_time_entries SET ended_at = CURRENT_TIMESTAMP WHERE id = ?', args: [openEntry.id] });
    const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM work_order_tasks WHERE id = ?', args: [req.params.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Completion sign-off, customer notification, pickup ────────────────────

// Supervisor-only — requires every task be marked complete first (an open
// timer would already block that task's own completion, so this is really
// just re-checking nothing was left pending).
router.patch('/:id/signoff', requirePermission('wo_signoff'), async (req, res) => {
  try {
    const { employee_id, comment } = req.body;
    const { rows: [wo] } = await db.execute({ sql: 'SELECT * FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (!['in_progress', 'awaiting_signoff'].includes(wo.status)) return res.status(400).json({ error: `This work order is ${wo.status}, not awaiting sign-off` });
    const { rows: tasks } = await db.execute({ sql: 'SELECT id, status FROM work_order_tasks WHERE work_order_id = ?', args: [req.params.id] });
    if (!tasks.length) return res.status(400).json({ error: 'This work order has no tasks yet' });
    const incomplete = tasks.filter(t => t.status !== 'complete');
    if (incomplete.length) return res.status(400).json({ error: `${incomplete.length} task(s) are not yet marked complete` });

    await db.execute({ sql: `UPDATE work_orders SET status = 'complete', completed_at = CURRENT_TIMESTAMP, completed_by = ?, pickup_due_date = date('now','+30 days') WHERE id = ?`, args: [employee_id || null, req.params.id] });
    await logStatus(db, req.params.id, 'complete', comment || 'Signed off by supervisor', employee_id);
    const { rows: [updated] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Records how the customer was told it's ready — email sending itself
// happens via a separate POST /email/send-work-order-ready/:id call from
// the frontend (same split every other "email this document" action in
// this app uses), this just logs which method was used and moves the WO
// into the awaiting-pickup queue.
router.patch('/:id/notify', requirePermission('work_orders'), async (req, res) => {
  try {
    const { notification_method, employee_id } = req.body;
    if (!['email', 'phone'].includes(notification_method)) return res.status(400).json({ error: 'A notification method (email or phone) is required' });
    const { rows: [wo] } = await db.execute({ sql: 'SELECT * FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (wo.status !== 'complete') return res.status(400).json({ error: `This work order is ${wo.status}, not yet complete` });

    await db.execute({ sql: `UPDATE work_orders SET status = 'awaiting_pickup', notification_method = ?, notified_at = CURRENT_TIMESTAMP, notified_by = ? WHERE id = ?`, args: [notification_method, employee_id || null, req.params.id] });
    await logStatus(db, req.params.id, 'awaiting_pickup', `Customer notified by ${notification_method}`, employee_id);
    const { rows: [updated] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Signed-off work isn't put on the cashier's Hold Recall automatically: when
// the customer comes in to collect, staff place it on hold for the cashier
// (owner's rule, 2026-11-23). A complete job not yet notified moves to
// awaiting_pickup at the same time — the customer is at the counter. Taken
// off again if they leave without paying.
router.patch('/:id/cashier-hold', requireAnyPermission('work_orders', 'pos'), async (req, res) => {
  try {
    const who = req.employee?.id || req.body.employee_id || null;
    const { rows: [wo] } = await db.execute({ sql: 'SELECT * FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (!['complete', 'awaiting_pickup'].includes(wo.status)) return res.status(400).json({ error: `This work order is ${wo.status.replace(/_/g, ' ')} — only a signed-off job is placed on hold for collection` });
    if (wo.cashier_hold_at) return res.status(400).json({ error: 'This work order is already on hold for the cashier' });
    const notBack = await itemNotBackError(wo.id);
    if (notBack) return res.status(400).json({ error: notBack });
    const tx = await db.transaction('write');
    let committed = false;
    try {
      if (wo.status === 'complete') {
        await tx.execute({ sql: `UPDATE work_orders SET status = 'awaiting_pickup', notification_method = COALESCE(notification_method, 'in_person'), notified_at = COALESCE(notified_at, CURRENT_TIMESTAMP), notified_by = COALESCE(notified_by, ?) WHERE id = ?`, args: [who, wo.id] });
      }
      await tx.execute({ sql: 'UPDATE work_orders SET cashier_hold_at = CURRENT_TIMESTAMP, cashier_hold_by = ? WHERE id = ?', args: [who, wo.id] });
      await logStatus(tx, wo.id, 'awaiting_pickup', 'Customer came in to collect — placed on hold for the cashier', who);
      await tx.commit();
      committed = true;
    } finally {
      if (!committed) await tx.rollback().catch(() => {});
    }
    const { rows: [updated] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [wo.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/cashier-hold', requireAnyPermission('work_orders', 'pos'), async (req, res) => {
  try {
    const who = req.employee?.id || null;
    const { rows: [wo] } = await db.execute({ sql: 'SELECT * FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (wo.status !== 'awaiting_pickup' || !wo.cashier_hold_at) return res.status(400).json({ error: 'This work order is not on hold for the cashier' });
    await db.execute({ sql: 'UPDATE work_orders SET cashier_hold_at = NULL, cashier_hold_by = NULL WHERE id = ?', args: [wo.id] });
    await logStatus(db, wo.id, 'awaiting_pickup', 'Taken off the cashier\'s hold — not collected', who);
    const { rows: [updated] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [wo.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Hard-gates pickup on the final balance — labor + consumables + parts, less
// the deposit already paid — the same cash-handling pattern as the
// assessment fee and deposit above (requireAnyPermission wo_assess/pos,
// frontend button only shown to 'pos'). If the deposit already covers the
// final cost the balance is 0 and no transaction/payment method is needed,
// but the WO still only advances to picked_up through this single endpoint —
// there's no separate no-payment "mark picked up" path anymore.
router.patch('/:id/final-payment', requireAnyPermission('wo_assess', 'pos'), async (req, res) => {
  try {
    const { payment_method, amount_tendered, employee_id, drawer_session_id, branch_id, accessories_returned, accessories_note } = req.body;
    const { rows: [wo] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (wo.status !== 'awaiting_pickup') return res.status(400).json({ error: `This work order is ${wo.status}, not awaiting pickup` });
    if (!wo.cashier_hold_at) return res.status(400).json({ error: 'Place this work order on hold for the cashier first — that\'s done when the customer comes in to collect' });
    const notBack = await itemNotBackError(wo.id);
    if (notBack) return res.status(400).json({ error: notBack });

    const handBack = await checkAccessoryHandBack(wo.id, accessories_returned, accessories_note);
    if (handBack.error) return res.status(400).json({ error: handBack.error });

    const estimateTotal = (parseFloat(wo.estimate_labor) || 0) + (parseFloat(wo.estimate_consumables) || 0);
    const estimateTax = parseFloat((estimateTotal * (parseFloat(wo.estimate_tax_rate) || 0) / 100).toFixed(2));
    const partsTotal = parseFloat(wo.parts_total) || 0;
    const partsTax = parseFloat(wo.parts_tax_total) || 0;
    const taxTotal = parseFloat((estimateTax + partsTax).toFixed(2));
    // Deposit is a flat prepayment credit, not itself a taxable line — it's
    // netted off the pre-tax subtotal here, then tax is added back on top of
    // that net figure, so the tax actually owed on the full estimate+parts
    // amount is never partially "un-taxed" just because a deposit was
    // collected earlier (see PATCH .../estimate for how it's entered).
    const subtotal = parseFloat((estimateTotal + partsTotal - (parseFloat(wo.deposit_amount) || 0)).toFixed(2));
    const balance = Math.max(0, parseFloat((subtotal + taxTotal).toFixed(2)));

    const tx = await db.transaction('write');
    let committed = false;
    try {
      let txId = null;
      if (balance > 0) {
        const method = payment_method || 'cash';
        const tendered = parseFloat(amount_tendered || balance);
        const changeAmt = Math.max(0, parseFloat((tendered - balance).toFixed(2)));
        const transaction_number = await nextNumber(db, 'transactions', 'transaction_number', 'TXN-', 6);
        const txResult = await tx.execute({ sql: `INSERT INTO transactions (transaction_number,customer_id,employee_id,salesperson_id,branch_id,drawer_session_id,subtotal,tax_amount,total,payment_method,amount_tendered,change_amount,notes,source) VALUES (?,?,?,${CUSTOMER_SALESPERSON_SQL},?,?,?,?,?,?,?,?,?,?)`, args: [transaction_number, wo.customer_id, employee_id || null, wo.customer_id, branch_id || wo.branch_id || null, drawer_session_id || null, subtotal, taxTotal, balance, method, tendered, changeAmt, `Work order final payment ${wo.wo_number}`, 'pos'] });
        txId = Number(txResult.lastInsertRowid);
        await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?)`, args: [txId, 'Work Order Balance', 'WO-FINAL', 1, subtotal, taxTotal, subtotal] });
      }
      await tx.execute({ sql: `UPDATE work_orders SET final_transaction_id = ?, status = 'picked_up', picked_up_at = CURRENT_TIMESTAMP WHERE id = ?`, args: [txId, req.params.id] });
      await logStatus(tx, req.params.id, 'picked_up', balance > 0 ? `Final payment collected (${payment_method || 'cash'}) — ${balance}` : 'Item picked up — no balance due', employee_id);
      await recordAccessoryHandBack(tx, wo.id, 'picked_up', handBack, employee_id);
      await tx.commit();
      committed = true;
    } catch(e) {
      if (!committed) await tx.rollback();
      return res.status(committed ? 500 : 400).json({ error: e.message });
    }
    const { rows: [updated] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Hands the item (and accessories) back on a WO that ends without a pickup
// sale — Not Worth Fixing, or Cancelled before work started. Status keeps
// the outcome; returned_to_customer_at records that the item has gone.
router.patch('/:id/return-to-customer', requirePermission('work_orders'), async (req, res) => {
  try {
    const { accessories_returned, accessories_note, comment } = req.body;
    const employeeId = req.employee?.id;
    const { rows: [wo] } = await db.execute({ sql: 'SELECT * FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (!['not_worth_fixing', 'cancelled'].includes(wo.status)) return res.status(400).json({ error: 'Only a Not Worth Fixing or Cancelled work order is returned this way — a repaired item goes back through the cashier\'s final payment' });
    if (wo.returned_to_customer_at) return res.status(400).json({ error: 'This item has already been returned to the customer' });
    const notBack = await itemNotBackError(wo.id);
    if (notBack) return res.status(400).json({ error: notBack });
    const handBack = await checkAccessoryHandBack(wo.id, accessories_returned, accessories_note);
    if (handBack.error) return res.status(400).json({ error: handBack.error });

    const tx = await db.transaction('write');
    try {
      await tx.execute({ sql: 'UPDATE work_orders SET returned_to_customer_at = CURRENT_TIMESTAMP, returned_to_customer_by = ? WHERE id = ?', args: [employeeId || null, wo.id] });
      await logStatus(tx, wo.id, wo.status, `Item returned to customer${String(comment || '').trim() ? ` — ${String(comment).trim()}` : ''}`, employeeId);
      await recordAccessoryHandBack(tx, wo.id, wo.status, handBack, employeeId);
      await tx.commit();
    } catch(e) { try { await tx.rollback(); } catch(_) {} throw e; }
    const { rows: [updated] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [wo.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
