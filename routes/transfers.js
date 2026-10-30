const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { createTransfer, deductTransferStock, addTransferStock } = require('../lib/transfers');
const { requirePermission, requireAnyPermission, requireAuth } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');

router.use(requireAuth);

// GET all transfers
router.get('/', requirePermission('transfers'), async (req, res) => {
  try {
    const { status, from_branch_id, to_branch_id, limit = 100 } = req.query;
    let sql = `SELECT t.*, fb.name as from_branch_name, tb.name as to_branch_name, e.first_name || ' ' || e.last_name as employee_name,
      COALESCE(dr.first_name || ' ' || dr.last_name, t.driver_name) as driver_display_name,
      (SELECT GROUP_CONCAT(product_name || ' x' || quantity_requested, ', ') FROM branch_transfer_items WHERE transfer_id = t.id) as item_summary
      FROM branch_transfers t LEFT JOIN branches fb ON t.from_branch_id = fb.id LEFT JOIN branches tb ON t.to_branch_id = tb.id LEFT JOIN employees e ON t.employee_id = e.id
      LEFT JOIN employees dr ON dr.id = t.driver_id WHERE 1=1`;
    const params = [];
    if (status) { sql += ' AND t.status = ?'; params.push(status); }
    if (from_branch_id) { sql += ' AND t.from_branch_id = ?'; params.push(from_branch_id); }
    if (to_branch_id) { sql += ' AND t.to_branch_id = ?'; params.push(to_branch_id); }
    sql += ' ORDER BY t.created_at DESC LIMIT ?';
    params.push(parseInt(limit));
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET inbox — transfer requests waiting to be sent from one of the
// caller's branches (employee_branches + default branch; every branch if
// they have none), newest first, leaving out the caller's own. Polled by the app to notify the inventory
// team (App._pollTransferInbox). Registered before GET /:id.
router.get('/inbox', requirePermission('transfers_approve'), async (req, res) => {
  try {
    const empId = req.employee?.id;
    const { rows: mine } = empId ? await db.execute({ sql: `SELECT branch_id FROM employee_branches WHERE employee_id = ?
      UNION SELECT default_branch_id FROM employees WHERE id = ? AND default_branch_id IS NOT NULL`, args: [empId, empId] }) : { rows: [] };
    const branchIds = mine.map(r => r.branch_id).filter(Boolean);
    const scope = branchIds.length ? ` AND t.from_branch_id IN (${branchIds.map(() => '?').join(',')})` : '';
    const { rows } = await db.execute({ sql: `SELECT t.id, t.transfer_number, t.created_at, t.notes, t.from_branch_id, t.to_branch_id,
        fb.name AS from_branch_name, tb.name AS to_branch_name, e.first_name || ' ' || e.last_name AS employee_name,
        (SELECT COUNT(*) FROM branch_transfer_items WHERE transfer_id = t.id) AS item_count,
        (SELECT COALESCE(SUM(quantity_requested), 0) FROM branch_transfer_items WHERE transfer_id = t.id) AS unit_count
      FROM branch_transfers t LEFT JOIN branches fb ON fb.id = t.from_branch_id LEFT JOIN branches tb ON tb.id = t.to_branch_id
      LEFT JOIN employees e ON e.id = t.employee_id
      WHERE t.status = 'requested'${scope} AND COALESCE(t.employee_id, 0) != ? ORDER BY t.id DESC LIMIT 50`, args: [...branchIds, empId || 0] });
    res.json({ count: rows.length, requests: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Active employees for the "Picked up by" / "Delivered by" pickers — names
// only (the employee list itself needs the Employees module). Drivers first.
// Registered before GET /:id.
router.get('/people', requireAnyPermission('transfers_pickup', 'transfers_dropoff'), async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: `SELECT id, first_name || ' ' || last_name AS name, is_driver FROM employees
      WHERE active = 1 ORDER BY is_driver DESC, first_name, last_name`, args: [] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Who carried the stock: an active employee (id) or an outside courier
// (typed name). Returns { id, name } or { error }.
async function resolveCarrier(executor, id, name, label) {
  const typed = String(name || '').trim();
  if (id) {
    const { rows: [emp] } = await executor.execute({ sql: 'SELECT id FROM employees WHERE id = ? AND active = 1', args: [id] });
    if (!emp) return { error: `Choose who ${label} from the list` };
    return { id: emp.id, name: null };
  }
  if (typed) return { id: null, name: typed.slice(0, 120) };
  return { error: `Enter who ${label}` };
}

// GET single transfer with items
router.get('/:id', requirePermission('transfers'), async (req, res) => {
  try {
    const { rows: [transfer] } = await db.execute({ sql: `SELECT t.*, fb.name as from_branch_name, tb.name as to_branch_name, e.first_name || ' ' || e.last_name as employee_name,
      se.first_name || ' ' || se.last_name as sent_by_name,
      COALESCE(dr.first_name || ' ' || dr.last_name, t.driver_name) as driver_display_name,
      dp.first_name || ' ' || dp.last_name as dispatched_by_name
      FROM branch_transfers t LEFT JOIN branches fb ON t.from_branch_id = fb.id LEFT JOIN branches tb ON t.to_branch_id = tb.id LEFT JOIN employees e ON t.employee_id = e.id LEFT JOIN employees se ON t.sent_by = se.id
      LEFT JOIN employees dr ON dr.id = t.driver_id LEFT JOIN employees dp ON dp.id = t.dispatched_by WHERE t.id = ?`, args: [req.params.id] });
    if (!transfer) return res.status(404).json({ error: 'Not found' });
    // Each delivery received: who brought it, who received it, what was in it.
    const { rows: receipts } = await db.execute({ sql: `SELECT r.*, rb.first_name || ' ' || rb.last_name AS received_by_name,
        COALESCE(dl.first_name || ' ' || dl.last_name, r.delivered_by_name) AS delivered_by_display,
        (SELECT json_group_array(json_object('product_name', ti.product_name, 'quantity', ri.quantity)) FROM branch_transfer_receipt_items ri
           JOIN branch_transfer_items ti ON ti.id = ri.transfer_item_id WHERE ri.receipt_id = r.id) AS lines
      FROM branch_transfer_receipts r LEFT JOIN employees rb ON rb.id = r.received_by LEFT JOIN employees dl ON dl.id = r.delivered_by_id
      WHERE r.transfer_id = ? ORDER BY r.received_at, r.id`, args: [req.params.id] });
    for (const r of receipts) r.lines = JSON.parse(r.lines || '[]');
    transfer.receipts = receipts;
    // Each line also carries what the sending branch holds (source_stock)
    // and where it's shelved there (bins, primary first) — for Review & Send
    // and the printed pick list.
    const { rows: items } = await db.execute({ sql: `SELECT ti.*, bi.stock_qty AS source_stock,
        (SELECT json_group_array(json_object('bin_code', x.bin_code, 'zone_name', x.zone_name, 'quantity', x.quantity, 'is_primary', x.is_primary)) FROM (
          SELECT sb.bin_code, z.name AS zone_name, a.quantity, a.is_primary FROM product_bin_assignments a
          JOIN storage_bins sb ON sb.id = a.bin_id LEFT JOIN warehouse_zones z ON z.id = sb.zone_id
          WHERE a.product_id = ti.product_id AND a.branch_id = ? ORDER BY a.is_primary DESC, sb.bin_code) x) AS bins
      FROM branch_transfer_items ti
      LEFT JOIN branch_inventory bi ON bi.product_id = ti.product_id AND bi.branch_id = ?
      WHERE ti.transfer_id = ? ORDER BY ti.id`, args: [transfer.from_branch_id, transfer.from_branch_id, req.params.id] });
    for (const i of items) i.bins = JSON.parse(i.bins || '[]');
    transfer.items = items;
    res.json(transfer);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST create a transfer request — a branch asks another branch for stock.
// Nothing moves yet: the inventory team sets the quantities actually sent
// and sends it (PATCH /:id/send), then the branch receives it as usual.
// (Transfers auto-created by quotations / work orders skip the request step
// — lib/transfers.js createTransfer without `request`.)
router.post('/', requirePermission('transfers_create'), async (req, res) => {
  try {
    const { from_branch_id, to_branch_id, employee_id, items, notes } = req.body;
    if (!from_branch_id || !to_branch_id) return res.status(400).json({ error: 'Both from and to branches are required' });
    if (parseInt(from_branch_id) === parseInt(to_branch_id)) return res.status(400).json({ error: 'From and to branches must be different' });
    if (!items || !items.length) return res.status(400).json({ error: 'No items in transfer' });

    const transfer_number = await nextNumber(db, 'branch_transfers', 'transfer_number', 'TRF-', 6);

    const tx = await db.transaction('write');
    let transferId;
    try {
      transferId = await createTransfer(tx, { transfer_number, from_branch_id, to_branch_id, employee_id: employee_id || req.employee?.id, items, notes, quote_id: null, request: true });
      await tx.commit();
    } catch(e) {
      await tx.rollback();
      return res.status(400).json({ error: e.message });
    }

    const { rows: [transfer] } = await db.execute({ sql: `SELECT t.*, fb.name as from_branch_name, tb.name as to_branch_name FROM branch_transfers t LEFT JOIN branches fb ON t.from_branch_id = fb.id LEFT JOIN branches tb ON t.to_branch_id = tb.id WHERE t.id = ?`, args: [transferId] });
    const { rows: transferItems } = await db.execute({ sql: 'SELECT * FROM branch_transfer_items WHERE transfer_id = ?', args: [transferId] });
    transfer.items = transferItems;
    res.status(201).json(transfer);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST quick — moves stock between two branches in one step, for branches
// that share a building (e.g. a store beside the warehouse): no request,
// pickup or receiving. Stock leaves the source (same availability checks as
// sending) and lands at the destination at once; the transfer is recorded
// as received, flagged is_quick.
router.post('/quick', requirePermission('transfers_quick'), async (req, res) => {
  try {
    const { from_branch_id, to_branch_id, items, notes } = req.body;
    if (!from_branch_id || !to_branch_id) return res.status(400).json({ error: 'Both from and to branches are required' });
    if (parseInt(from_branch_id) === parseInt(to_branch_id)) return res.status(400).json({ error: 'From and to branches must be different' });
    if (!items || !items.length) return res.status(400).json({ error: 'No items in transfer' });
    const employeeId = req.employee?.id || null;

    const transfer_number = await nextNumber(db, 'branch_transfers', 'transfer_number', 'TRF-', 6);
    const tx = await db.transaction('write');
    let transferId;
    try {
      transferId = await createTransfer(tx, { transfer_number, from_branch_id, to_branch_id, employee_id: employeeId, items, notes, quote_id: null });
      const { rows: lines } = await tx.execute({ sql: 'SELECT * FROM branch_transfer_items WHERE transfer_id = ?', args: [transferId] });
      for (const line of lines) {
        await addTransferStock(tx, to_branch_id, line.product_id, line.quantity_requested);
        await tx.execute({ sql: 'UPDATE branch_transfer_items SET quantity_received = quantity_requested WHERE id = ?', args: [line.id] });
      }
      // Co-located branches: the person doing it carries and receives it.
      const now = new Date().toISOString();
      await tx.execute({ sql: "UPDATE branch_transfers SET status = 'received', received_at = ?, is_quick = 1, driver_id = ?, dispatched_by = ?, dispatched_at = ? WHERE id = ?", args: [now, employeeId, employeeId, now, transferId] });
      const receipt = await tx.execute({ sql: "INSERT INTO branch_transfer_receipts (transfer_id, received_by, received_at, delivered_by_id, notes) VALUES (?,?,?,?,'Quick transfer')", args: [transferId, employeeId, now, employeeId] });
      for (const line of lines) {
        await tx.execute({ sql: 'INSERT INTO branch_transfer_receipt_items (receipt_id, transfer_item_id, quantity) VALUES (?,?,?)', args: [Number(receipt.lastInsertRowid), line.id, line.quantity_requested] });
      }
      await tx.commit();
    } catch(e) {
      await tx.rollback();
      return res.status(400).json({ error: e.message });
    }

    const { rows: [transfer] } = await db.execute({ sql: `SELECT t.*, fb.name as from_branch_name, tb.name as to_branch_name FROM branch_transfers t LEFT JOIN branches fb ON t.from_branch_id = fb.id LEFT JOIN branches tb ON t.to_branch_id = tb.id WHERE t.id = ?`, args: [transferId] });
    transfer.items = (await db.execute({ sql: 'SELECT * FROM branch_transfer_items WHERE transfer_id = ?', args: [transferId] })).rows;
    res.status(201).json(transfer);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH send — the inventory team sends a requested transfer with the
// quantities they're actually sending (items: [{ item_id, quantity }]; a
// line left out keeps its asked quantity, 0 drops it). Stock leaves the
// source branch now; the transfer is then 'pending' (ready for pickup /
// receiving). quantity_requested becomes the sent quantity — receive and
// cancel work from it — and quantity_asked keeps the original ask.
router.patch('/:id/send', requirePermission('transfers_approve'), async (req, res) => {
  try {
    const { rows: [transfer] } = await db.execute({ sql: 'SELECT * FROM branch_transfers WHERE id = ?', args: [req.params.id] });
    if (!transfer) return res.status(404).json({ error: 'Not found' });
    if (transfer.status !== 'requested') return res.status(400).json({ error: 'Only a transfer request can be sent' });
    const sentById = new Map((req.body.items || []).map(i => [Number(i.item_id), i.quantity]));

    const tx = await db.transaction('write');
    try {
      const { rows: lines } = await tx.execute({ sql: 'SELECT * FROM branch_transfer_items WHERE transfer_id = ?', args: [req.params.id] });
      const toSend = [];
      for (const line of lines) {
        const raw = sentById.has(line.id) ? sentById.get(line.id) : line.quantity_requested;
        const qty = Number(raw);
        if (!Number.isInteger(qty) || qty < 0) throw new Error(`Enter a whole quantity of 0 or more for ${line.product_name}`);
        await tx.execute({ sql: 'UPDATE branch_transfer_items SET quantity_requested = ?, quantity_asked = COALESCE(quantity_asked, ?) WHERE id = ?', args: [qty, line.quantity_requested, line.id] });
        if (qty > 0 && line.product_id) toSend.push({ product_id: line.product_id, quantity: qty });
      }
      if (!lines.some(l => Number(sentById.has(l.id) ? sentById.get(l.id) : l.quantity_requested) > 0)) throw new Error('Nothing to send — enter a quantity for at least one item, or cancel the request');
      await deductTransferStock(tx, transfer.from_branch_id, toSend);
      await tx.execute({ sql: "UPDATE branch_transfers SET status = 'pending', sent_by = ?, sent_at = ? WHERE id = ?", args: [req.employee?.id || null, new Date().toISOString(), req.params.id] });
      await tx.commit();
    } catch(e) {
      await tx.rollback();
      return res.status(400).json({ error: e.message });
    }

    const { rows: [updated] } = await db.execute({ sql: `SELECT t.*, fb.name as from_branch_name, tb.name as to_branch_name FROM branch_transfers t LEFT JOIN branches fb ON t.from_branch_id = fb.id LEFT JOIN branches tb ON t.to_branch_id = tb.id WHERE t.id = ?`, args: [req.params.id] });
    const { rows: updatedItems } = await db.execute({ sql: 'SELECT * FROM branch_transfer_items WHERE transfer_id = ?', args: [req.params.id] });
    updated.items = updatedItems;
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH dispatch — mark as in_transit (a.k.a. "picked up" from the source branch)
router.patch('/:id/dispatch', requirePermission('transfers_pickup'), async (req, res) => {
  try {
    const { rows: [transfer] } = await db.execute({ sql: 'SELECT * FROM branch_transfers WHERE id = ?', args: [req.params.id] });
    if (!transfer) return res.status(404).json({ error: 'Not found' });
    if (transfer.status !== 'pending') return res.status(400).json({ error: 'Only pending transfers can be dispatched' });
    const driver = await resolveCarrier(db, req.body.driver_id, req.body.driver_name, 'is taking it');
    if (driver.error) return res.status(400).json({ error: driver.error });
    await db.execute({
      sql: "UPDATE branch_transfers SET status = 'in_transit', driver_id = ?, driver_name = ?, dispatched_by = ?, dispatched_at = ? WHERE id = ? AND status = 'pending'",
      args: [driver.id, driver.name, req.employee?.id || null, new Date().toISOString(), req.params.id],
    });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM branch_transfers WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH receive — receive items at destination, add to destination branch_inventory
// (a.k.a. "dropped off" at the destination branch)
router.patch('/:id/receive', requirePermission('transfers_dropoff'), async (req, res) => {
  try {
    const { items } = req.body;
    const { rows: [transfer] } = await db.execute({ sql: 'SELECT * FROM branch_transfers WHERE id = ?', args: [req.params.id] });
    if (!transfer) return res.status(404).json({ error: 'Not found' });
    if (transfer.status === 'cancelled') return res.status(400).json({ error: 'Cannot receive cancelled transfer' });
    if (transfer.status === 'requested') return res.status(400).json({ error: 'This transfer has not been sent yet' });
    if (transfer.status === 'received') return res.status(400).json({ error: 'Transfer already fully received' });
    // Who brought it is required; who received it is whoever is signed in.
    const deliverer = await resolveCarrier(db, req.body.delivered_by_id, req.body.delivered_by_name, 'delivered the items');
    if (deliverer.error) return res.status(400).json({ error: deliverer.error });

    const tx = await db.transaction('write');
    try {
      const receipt = await tx.execute({
        sql: 'INSERT INTO branch_transfer_receipts (transfer_id, received_by, received_at, delivered_by_id, delivered_by_name, notes) VALUES (?,?,?,?,?,?)',
        args: [transfer.id, req.employee?.id || null, new Date().toISOString(), deliverer.id, deliverer.name, String(req.body.notes || '').trim() || null],
      });
      const receiptId = Number(receipt.lastInsertRowid);
      let receivedAny = false;
      for (const { item_id, quantity_received } of (items || [])) {
        const qty = parseInt(quantity_received);
        if (!qty || qty <= 0) continue;
        const { rows: [item] } = await tx.execute({ sql: 'SELECT * FROM branch_transfer_items WHERE id = ?', args: [item_id] });
        if (!item) continue;
        const pending = item.quantity_requested - (item.quantity_received || 0);
        const actual = Math.min(qty, pending);
        if (actual <= 0) continue;

        await tx.execute({ sql: 'UPDATE branch_transfer_items SET quantity_received = quantity_received + ? WHERE id = ?', args: [actual, item_id] });
        await tx.execute({ sql: 'INSERT INTO branch_transfer_receipt_items (receipt_id, transfer_item_id, quantity) VALUES (?,?,?)', args: [receiptId, item.id, actual] });
        receivedAny = true;

        if (item.product_id) {
          await addTransferStock(tx, transfer.to_branch_id, item.product_id, actual);
        }
      }

      if (!receivedAny) throw new Error('Enter a quantity received for at least one item');
      const { rows: transferItems } = await tx.execute({ sql: 'SELECT * FROM branch_transfer_items WHERE transfer_id = ?', args: [req.params.id] });
      const allReceived = transferItems.every(i => (i.quantity_received || 0) >= i.quantity_requested);
      const anyReceived = transferItems.some(i => (i.quantity_received || 0) > 0);
      const newStatus = allReceived ? 'received' : anyReceived ? 'in_transit' : transfer.status;
      await tx.execute({ sql: 'UPDATE branch_transfers SET status = ?, received_at = ? WHERE id = ?', args: [newStatus, allReceived ? new Date().toISOString() : transfer.received_at, req.params.id] });
      await tx.commit();
    } catch(e) {
      await tx.rollback();
      return res.status(400).json({ error: e.message });
    }

    const { rows: [updated] } = await db.execute({ sql: `SELECT t.*, fb.name as from_branch_name, tb.name as to_branch_name FROM branch_transfers t LEFT JOIN branches fb ON t.from_branch_id = fb.id LEFT JOIN branches tb ON t.to_branch_id = tb.id WHERE t.id = ?`, args: [req.params.id] });
    const { rows: updatedItems } = await db.execute({ sql: 'SELECT * FROM branch_transfer_items WHERE transfer_id = ?', args: [req.params.id] });
    updated.items = updatedItems;
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH cancel — restore unreceived qty back to source branch
router.patch('/:id/cancel', requirePermission('transfers'), async (req, res) => {
  try {
    const { rows: [transfer] } = await db.execute({ sql: 'SELECT * FROM branch_transfers WHERE id = ?', args: [req.params.id] });
    if (!transfer) return res.status(404).json({ error: 'Not found' });
    if (transfer.status === 'received') return res.status(400).json({ error: 'Cannot cancel a fully received transfer' });
    if (transfer.status === 'cancelled') return res.status(400).json({ error: 'Transfer already cancelled' });

    // A request that was never sent took no stock — nothing to put back.
    if (transfer.status === 'requested') {
      await db.execute({ sql: "UPDATE branch_transfers SET status = 'cancelled' WHERE id = ?", args: [req.params.id] });
      const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM branch_transfers WHERE id = ?', args: [req.params.id] });
      return res.json(row);
    }

    const tx = await db.transaction('write');
    try {
      const { rows: items } = await tx.execute({ sql: 'SELECT * FROM branch_transfer_items WHERE transfer_id = ?', args: [req.params.id] });
      for (const item of items) {
        if (!item.product_id) continue;
        const unreceived = item.quantity_requested - (item.quantity_received || 0);
        if (unreceived <= 0) continue;
        await addTransferStock(tx, transfer.from_branch_id, item.product_id, unreceived);
      }
      await tx.execute({ sql: 'UPDATE branch_transfers SET status = ? WHERE id = ?', args: ['cancelled', req.params.id] });
      await tx.commit();
    } catch(e) {
      await tx.rollback();
      return res.status(400).json({ error: e.message });
    }

    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM branch_transfers WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
