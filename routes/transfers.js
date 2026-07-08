const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { syncBinQty } = require('../lib/binSync');
const { requirePermission } = require('../lib/permissions');

router.use(requirePermission('transfers'));

// GET all transfers
router.get('/', async (req, res) => {
  try {
    const { status, from_branch_id, to_branch_id, limit = 100 } = req.query;
    let sql = `SELECT t.*, fb.name as from_branch_name, tb.name as to_branch_name, e.first_name || ' ' || e.last_name as employee_name FROM branch_transfers t LEFT JOIN branches fb ON t.from_branch_id = fb.id LEFT JOIN branches tb ON t.to_branch_id = tb.id LEFT JOIN employees e ON t.employee_id = e.id WHERE 1=1`;
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

// GET single transfer with items
router.get('/:id', async (req, res) => {
  try {
    const { rows: [transfer] } = await db.execute({ sql: `SELECT t.*, fb.name as from_branch_name, tb.name as to_branch_name, e.first_name || ' ' || e.last_name as employee_name FROM branch_transfers t LEFT JOIN branches fb ON t.from_branch_id = fb.id LEFT JOIN branches tb ON t.to_branch_id = tb.id LEFT JOIN employees e ON t.employee_id = e.id WHERE t.id = ?`, args: [req.params.id] });
    if (!transfer) return res.status(404).json({ error: 'Not found' });
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM branch_transfer_items WHERE transfer_id = ?', args: [req.params.id] });
    transfer.items = items;
    res.json(transfer);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST create transfer — deducts qty from source branch immediately
router.post('/', async (req, res) => {
  try {
    const { from_branch_id, to_branch_id, employee_id, items, notes } = req.body;
    if (!from_branch_id || !to_branch_id) return res.status(400).json({ error: 'Both from and to branches are required' });
    if (parseInt(from_branch_id) === parseInt(to_branch_id)) return res.status(400).json({ error: 'From and to branches must be different' });
    if (!items || !items.length) return res.status(400).json({ error: 'No items in transfer' });

    const { rows: [count] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM branch_transfers', args: [] });
    const transfer_number = `TRF-${String(Number(count.c) + 1).padStart(6, '0')}`;

    const tx = await db.transaction('write');
    try {
      for (const item of items) {
        const { rows: [product] } = await tx.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] });
        if (!product) throw new Error(`Product ${item.product_id} not found`);
        const qty = parseInt(item.quantity);
        if (!qty || qty <= 0) throw new Error(`Invalid quantity for ${product.name}`);

        const { rows: [srcInv] } = await tx.execute({ sql: 'SELECT * FROM branch_inventory WHERE product_id = ? AND branch_id = ?', args: [item.product_id, from_branch_id] });
        const srcQty = srcInv ? srcInv.stock_qty : product.stock_qty;
        if (srcQty < qty) throw new Error(`Insufficient stock for ${product.name} at source branch (available: ${srcQty})`);

        if (srcInv) {
          await tx.execute({ sql: 'UPDATE branch_inventory SET stock_qty = stock_qty - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND branch_id = ?', args: [qty, item.product_id, from_branch_id] });
        } else {
          await tx.execute({ sql: 'INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)', args: [item.product_id, from_branch_id, srcQty - qty, product.min_stock] });
        }
        await syncBinQty(tx, item.product_id, from_branch_id, -qty);
        await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?', args: [qty, item.product_id] });
      }

      const result = await tx.execute({ sql: 'INSERT INTO branch_transfers (transfer_number, from_branch_id, to_branch_id, employee_id, notes) VALUES (?, ?, ?, ?, ?)', args: [transfer_number, from_branch_id, to_branch_id, employee_id || null, notes || null] });
      const transferId = Number(result.lastInsertRowid);

      for (const item of items) {
        const { rows: [product] } = await tx.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] });
        await tx.execute({ sql: 'INSERT INTO branch_transfer_items (transfer_id, product_id, product_name, sku, quantity_requested) VALUES (?, ?, ?, ?, ?)', args: [transferId, item.product_id, product.name, product.sku, parseInt(item.quantity)] });
      }

      await tx.commit();

      const { rows: [transfer] } = await db.execute({ sql: `SELECT t.*, fb.name as from_branch_name, tb.name as to_branch_name FROM branch_transfers t LEFT JOIN branches fb ON t.from_branch_id = fb.id LEFT JOIN branches tb ON t.to_branch_id = tb.id WHERE t.id = ?`, args: [transferId] });
      const { rows: transferItems } = await db.execute({ sql: 'SELECT * FROM branch_transfer_items WHERE transfer_id = ?', args: [transferId] });
      transfer.items = transferItems;
      res.status(201).json(transfer);
    } catch(e) {
      await tx.rollback();
      res.status(400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH dispatch — mark as in_transit
router.patch('/:id/dispatch', async (req, res) => {
  try {
    const { rows: [transfer] } = await db.execute({ sql: 'SELECT * FROM branch_transfers WHERE id = ?', args: [req.params.id] });
    if (!transfer) return res.status(404).json({ error: 'Not found' });
    if (transfer.status !== 'pending') return res.status(400).json({ error: 'Only pending transfers can be dispatched' });
    await db.execute({ sql: 'UPDATE branch_transfers SET status = ? WHERE id = ?', args: ['in_transit', req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM branch_transfers WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH receive — receive items at destination, add to destination branch_inventory
router.patch('/:id/receive', async (req, res) => {
  try {
    const { items } = req.body;
    const { rows: [transfer] } = await db.execute({ sql: 'SELECT * FROM branch_transfers WHERE id = ?', args: [req.params.id] });
    if (!transfer) return res.status(404).json({ error: 'Not found' });
    if (transfer.status === 'cancelled') return res.status(400).json({ error: 'Cannot receive cancelled transfer' });
    if (transfer.status === 'received') return res.status(400).json({ error: 'Transfer already fully received' });

    const tx = await db.transaction('write');
    try {
      for (const { item_id, quantity_received } of (items || [])) {
        const qty = parseInt(quantity_received);
        if (!qty || qty <= 0) continue;
        const { rows: [item] } = await tx.execute({ sql: 'SELECT * FROM branch_transfer_items WHERE id = ?', args: [item_id] });
        if (!item) continue;
        const pending = item.quantity_requested - (item.quantity_received || 0);
        const actual = Math.min(qty, pending);
        if (actual <= 0) continue;

        await tx.execute({ sql: 'UPDATE branch_transfer_items SET quantity_received = quantity_received + ? WHERE id = ?', args: [actual, item_id] });

        if (item.product_id) {
          await tx.execute({ sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at) VALUES (?, ?, ?, (SELECT min_stock FROM products WHERE id = ?), CURRENT_TIMESTAMP) ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP`, args: [item.product_id, transfer.to_branch_id, actual, item.product_id, actual] });
          await syncBinQty(tx, item.product_id, transfer.to_branch_id, actual);
          await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [actual, item.product_id] });
        }
      }

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
router.patch('/:id/cancel', async (req, res) => {
  try {
    const { rows: [transfer] } = await db.execute({ sql: 'SELECT * FROM branch_transfers WHERE id = ?', args: [req.params.id] });
    if (!transfer) return res.status(404).json({ error: 'Not found' });
    if (transfer.status === 'received') return res.status(400).json({ error: 'Cannot cancel a fully received transfer' });
    if (transfer.status === 'cancelled') return res.status(400).json({ error: 'Transfer already cancelled' });

    const tx = await db.transaction('write');
    try {
      const { rows: items } = await tx.execute({ sql: 'SELECT * FROM branch_transfer_items WHERE transfer_id = ?', args: [req.params.id] });
      for (const item of items) {
        if (!item.product_id) continue;
        const unreceived = item.quantity_requested - (item.quantity_received || 0);
        if (unreceived <= 0) continue;
        await tx.execute({ sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at) VALUES (?, ?, ?, (SELECT min_stock FROM products WHERE id = ?), CURRENT_TIMESTAMP) ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP`, args: [item.product_id, transfer.from_branch_id, unreceived, item.product_id, unreceived] });
        await syncBinQty(tx, item.product_id, transfer.from_branch_id, unreceived);
        await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [unreceived, item.product_id] });
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
