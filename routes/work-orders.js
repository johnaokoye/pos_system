const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission, requireAnyPermission } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');
const { processWorkOrderItems, processWorkOrderPartSourcing } = require('../lib/workOrders');

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

const WO_LIST_SELECT = `SELECT wo.*, c.first_name || ' ' || c.last_name as customer_name, c.phone as customer_phone, c.email as customer_email,
  e.first_name || ' ' || e.last_name as employee_name, b.name as branch_name,
  cb.first_name || ' ' || cb.last_name as completed_by_name,
  julianday('now') - julianday(wo.pickup_due_date) as days_past_pickup_due,
  (SELECT COALESCE(SUM(total),0) FROM work_order_items WHERE work_order_id = wo.id) as parts_total
  FROM work_orders wo
  LEFT JOIN customers c ON wo.customer_id = c.id
  LEFT JOIN employees e ON wo.employee_id = e.id
  LEFT JOIN branches b ON wo.branch_id = b.id
  LEFT JOIN employees cb ON wo.completed_by = cb.id`;

router.get('/', requirePermission('work_orders'), async (req, res) => {
  try {
    const { status, view, customer_id, branch_id, limit = 200 } = req.query;
    let sql = `${WO_LIST_SELECT} WHERE 1=1`;
    const params = [];
    if (view === 'active') { sql += " AND wo.status NOT IN ('picked_up','cancelled','not_worth_fixing')"; }
    // Assessment fee (status='intake'), deposit (status='pending_deposit'), or the
    // final balance (status='awaiting_pickup') due — surfaced in the POS Hold
    // Recall list so a cashier can pick it up and take payment there.
    else if (view === 'awaiting_payment') { sql += " AND wo.status IN ('intake','pending_deposit','awaiting_pickup')"; }
    else if (view === 'awaiting_pickup' || view === 'picked_up' || view === 'cancelled' || view === 'not_worth_fixing') { sql += ' AND wo.status = ?'; params.push(view); }
    else if (status) { sql += ' AND wo.status = ?'; params.push(status); }
    if (customer_id) { sql += ' AND wo.customer_id = ?'; params.push(customer_id); }
    if (branch_id) { sql += ' AND wo.branch_id = ?'; params.push(branch_id); }
    sql += ' ORDER BY wo.created_at DESC LIMIT ?';
    params.push(parseInt(limit));
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const WO_ITEMS_SELECT = `SELECT woi.*, pr.pr_number as purchase_request_number, pr.status as purchase_request_status
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

    let processedItems;
    try {
      processedItems = await processWorkOrderItems(items || []);
    } catch(e) { return res.status(400).json({ error: e.message }); }

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
        const { product_id, product_name, sku, quantity, unit_cost, unit_price, total, is_temp_item, is_customer_supplied, sources } = item;
        const itemResult = await tx.execute({ sql: 'INSERT INTO work_order_items (work_order_id,product_id,product_name,sku,quantity,unit_cost,unit_price,total,is_temp_item,is_customer_supplied) VALUES (?,?,?,?,?,?,?,?,?,?)', args: [req.params.id, product_id, product_name, sku, quantity, unit_cost, unit_price, total, is_temp_item ? 1 : 0, is_customer_supplied ? 1 : 0] });
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

// ─── Intake ─────────────────────────────────────────────────────────────────

router.post('/', requirePermission('wo_intake'), async (req, res) => {
  try {
    const { customer_id, employee_id, branch_id, description, item_label } = req.body;
    if (!customer_id) return res.status(400).json({ error: 'A customer is required' });
    if (!description || !description.trim()) return res.status(400).json({ error: 'A description is required' });

    const { rows: [feeSetting] } = await db.execute({ sql: "SELECT value FROM settings WHERE key = 'wo_assessment_fee'", args: [] });
    const assessmentFee = parseFloat(feeSetting?.value) || 0;

    const wo_number = await nextNumber(db, 'work_orders', 'wo_number', 'WO-', 6);
    const tx = await db.transaction('write');
    let committed = false;
    try {
      const result = await tx.execute({ sql: `INSERT INTO work_orders (wo_number, customer_id, employee_id, branch_id, description, item_label, assessment_fee, pickup_due_date)
        VALUES (?,?,?,?,?,?,?, date('now','+30 days'))`, args: [wo_number, customer_id, employee_id || null, branch_id || null, description.trim(), item_label || null, assessmentFee] });
      const woId = Number(result.lastInsertRowid);
      await logStatus(tx, woId, 'intake', 'Work order opened', employee_id);
      await tx.commit();
      committed = true;
      const { rows: [wo] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [woId] });
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
    const { description, item_label, employee_id } = req.body;
    const { rows: [wo] } = await db.execute({ sql: 'SELECT * FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (['complete', 'awaiting_pickup', 'picked_up', 'cancelled', 'not_worth_fixing'].includes(wo.status)) return res.status(400).json({ error: `Cannot edit a ${wo.status} work order` });
    if (description != null && !description.trim()) return res.status(400).json({ error: 'Description cannot be empty' });

    const newDescription = description != null ? description.trim() : wo.description;
    await db.execute({ sql: 'UPDATE work_orders SET description = ?, item_label = ? WHERE id = ?', args: [newDescription, item_label != null ? item_label : wo.item_label, req.params.id] });
    if (description != null && description.trim() !== wo.description) {
      await logStatus(db, req.params.id, wo.status, `Description updated: ${description.trim()}`, employee_id);
    }
    const { rows: [updated] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/label', async (req, res) => {
  try {
    const { rows: [wo] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
    if (!wo) return res.status(404).send('Not found');
    res.json(wo); // frontend renders the printable label itself, same as printRentalDeliveryNote
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
    const total = wo.assessment_fee;
    const tendered = parseFloat(amount_tendered || total);
    const changeAmt = Math.max(0, parseFloat((tendered - total).toFixed(2)));
    const transaction_number = await nextNumber(db, 'transactions', 'transaction_number', 'TXN-', 6);

    const tx = await db.transaction('write');
    let committed = false;
    try {
      const txResult = await tx.execute({ sql: `INSERT INTO transactions (transaction_number,customer_id,employee_id,branch_id,drawer_session_id,subtotal,tax_amount,total,payment_method,amount_tendered,change_amount,notes,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [transaction_number, wo.customer_id, employee_id || null, branch_id || wo.branch_id || null, drawer_session_id || null, total, 0, total, method, tendered, changeAmt, `Work order assessment fee ${wo.wo_number}`, 'pos'] });
      const txId = Number(txResult.lastInsertRowid);
      await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?)`, args: [txId, 'Assessment Fee', 'WO-ASSESS', 1, total, 0, total] });
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

router.patch('/:id/estimate', requirePermission('wo_assess'), async (req, res) => {
  try {
    const { estimate_labor, estimate_consumables, estimate_notes, deposit_amount, employee_id } = req.body;
    const { rows: [wo] } = await db.execute({ sql: 'SELECT * FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (wo.status !== 'assessed') return res.status(400).json({ error: `This work order is ${wo.status}, not awaiting an estimate` });
    const deposit = parseFloat(deposit_amount) || 0;
    if (deposit <= 0) return res.status(400).json({ error: 'A deposit amount is required' });

    await db.execute({ sql: `UPDATE work_orders SET estimate_labor = ?, estimate_consumables = ?, estimate_notes = ?, deposit_amount = ?, status = 'pending_deposit' WHERE id = ?`,
      args: [parseFloat(estimate_labor) || 0, parseFloat(estimate_consumables) || 0, estimate_notes || null, deposit, req.params.id] });
    await logStatus(db, req.params.id, 'pending_deposit', `Estimate entered — labor ${estimate_labor||0}, consumables ${estimate_consumables||0}, deposit due ${deposit}`, employee_id);
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
      const txResult = await tx.execute({ sql: `INSERT INTO transactions (transaction_number,customer_id,employee_id,branch_id,drawer_session_id,subtotal,tax_amount,total,payment_method,amount_tendered,change_amount,notes,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [transaction_number, wo.customer_id, employee_id || null, branch_id || wo.branch_id || null, drawer_session_id || null, total, 0, total, method, tendered, changeAmt, `Work order deposit ${wo.wo_number}`, 'pos'] });
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
      await db.execute({ sql: 'UPDATE work_orders SET status = ? WHERE id = ?', args: [newStatus, req.params.id] });
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
    await db.execute({ sql: 'UPDATE work_order_tasks SET description = ?, allotted_minutes = ?, technician_id = ?, status = ? WHERE id = ?', args: [
      description != null ? description.trim() : task.description,
      allotted_minutes != null ? parseInt(allotted_minutes) || 0 : task.allotted_minutes,
      technician_id !== undefined ? (technician_id || null) : task.technician_id,
      status || task.status,
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

    await db.execute({ sql: `UPDATE work_orders SET status = 'complete', completed_at = CURRENT_TIMESTAMP, completed_by = ? WHERE id = ?`, args: [employee_id || null, req.params.id] });
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

// Hard-gates pickup on the final balance — labor + consumables + parts, less
// the deposit already paid — the same cash-handling pattern as the
// assessment fee and deposit above (requireAnyPermission wo_assess/pos,
// frontend button only shown to 'pos'). If the deposit already covers the
// final cost the balance is 0 and no transaction/payment method is needed,
// but the WO still only advances to picked_up through this single endpoint —
// there's no separate no-payment "mark picked up" path anymore.
router.patch('/:id/final-payment', requireAnyPermission('wo_assess', 'pos'), async (req, res) => {
  try {
    const { payment_method, amount_tendered, employee_id, drawer_session_id, branch_id } = req.body;
    const { rows: [wo] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (wo.status !== 'awaiting_pickup') return res.status(400).json({ error: `This work order is ${wo.status}, not awaiting pickup` });

    const estimateTotal = (parseFloat(wo.estimate_labor) || 0) + (parseFloat(wo.estimate_consumables) || 0);
    const balance = Math.max(0, parseFloat((estimateTotal + (parseFloat(wo.parts_total) || 0) - (parseFloat(wo.deposit_amount) || 0)).toFixed(2)));

    const tx = await db.transaction('write');
    let committed = false;
    try {
      let txId = null;
      if (balance > 0) {
        const method = payment_method || 'cash';
        const tendered = parseFloat(amount_tendered || balance);
        const changeAmt = Math.max(0, parseFloat((tendered - balance).toFixed(2)));
        const transaction_number = await nextNumber(db, 'transactions', 'transaction_number', 'TXN-', 6);
        const txResult = await tx.execute({ sql: `INSERT INTO transactions (transaction_number,customer_id,employee_id,branch_id,drawer_session_id,subtotal,tax_amount,total,payment_method,amount_tendered,change_amount,notes,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [transaction_number, wo.customer_id, employee_id || null, branch_id || wo.branch_id || null, drawer_session_id || null, balance, 0, balance, method, tendered, changeAmt, `Work order final payment ${wo.wo_number}`, 'pos'] });
        txId = Number(txResult.lastInsertRowid);
        await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?)`, args: [txId, 'Work Order Balance', 'WO-FINAL', 1, balance, 0, balance] });
      }
      await tx.execute({ sql: `UPDATE work_orders SET final_transaction_id = ?, status = 'picked_up', picked_up_at = CURRENT_TIMESTAMP WHERE id = ?`, args: [txId, req.params.id] });
      await logStatus(tx, req.params.id, 'picked_up', balance > 0 ? `Final payment collected (${payment_method || 'cash'}) — ${balance}` : 'Item picked up — no balance due', employee_id);
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

module.exports = router;
