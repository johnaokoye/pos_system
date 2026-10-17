const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { db } = require('../database');
const { syncBinQty } = require('../lib/binSync');
const { updateFulfillmentStatus } = require('./transactions');
const { requireAuth, requirePermission, requireAnyPermission } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');

// ─── ZONES ────────────────────────────────────────────────────────────────────

router.get('/zones', requireAuth, async (req, res) => {
  try {
    const { branch_id } = req.query;
    let sql = `SELECT z.*, b.name as branch_name,
      (SELECT COUNT(*) FROM storage_bins WHERE zone_id = z.id) as bin_count
      FROM warehouse_zones z LEFT JOIN branches b ON z.branch_id = b.id WHERE 1=1`;
    const params = [];
    if (branch_id) { sql += ' AND z.branch_id = ?'; params.push(branch_id); }
    sql += ' ORDER BY b.name, z.name';
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/zones', requirePermission('warehouse'), async (req, res) => {
  try {
    const { branch_id, name, code, description } = req.body;
    if (!branch_id || !name) return res.status(400).json({ error: 'branch_id and name required' });
    const result = await db.execute({ sql: 'INSERT INTO warehouse_zones (branch_id, name, code, description) VALUES (?,?,?,?)', args: [branch_id, name, code || null, description || null] });
    const { rows: [row] } = await db.execute({ sql: `SELECT z.*, b.name as branch_name FROM warehouse_zones z LEFT JOIN branches b ON z.branch_id = b.id WHERE z.id = ?`, args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.put('/zones/:id', requirePermission('warehouse'), async (req, res) => {
  try {
    const { name, code, description } = req.body;
    await db.execute({ sql: 'UPDATE warehouse_zones SET name=?, code=?, description=? WHERE id=?', args: [name, code || null, description || null, req.params.id] });
    const { rows: [row] } = await db.execute({ sql: `SELECT z.*, b.name as branch_name FROM warehouse_zones z LEFT JOIN branches b ON z.branch_id = b.id WHERE z.id = ?`, args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.delete('/zones/:id', requirePermission('warehouse'), async (req, res) => {
  try {
    const { rows: [binCount] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM storage_bins WHERE zone_id = ?', args: [req.params.id] });
    if (Number(binCount.c) > 0) return res.status(400).json({ error: 'Zone has bins — remove bins first' });
    await db.execute({ sql: 'DELETE FROM warehouse_zones WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── BINS ─────────────────────────────────────────────────────────────────────

// requireAuth only — also used by the Cycle Counts "New Session" modal's
// scope picker (showCycleCountModal), not just Warehouse management.
router.get('/bins', requireAuth, async (req, res) => {
  try {
    const { zone_id, branch_id } = req.query;
    let sql = `SELECT sb.*, z.name as zone_name, z.code as zone_code, br.name as branch_name,
      (SELECT COUNT(*) FROM product_bin_assignments WHERE bin_id = sb.id) as assignment_count
      FROM storage_bins sb
      LEFT JOIN warehouse_zones z ON sb.zone_id = z.id
      LEFT JOIN branches br ON sb.branch_id = br.id
      WHERE 1=1`;
    const params = [];
    if (zone_id) { sql += ' AND sb.zone_id = ?'; params.push(zone_id); }
    if (branch_id) { sql += ' AND (sb.branch_id = ? OR z.branch_id = ?)'; params.push(branch_id, branch_id); }
    sql += ' ORDER BY sb.bin_code';
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/bins', requirePermission('warehouse'), async (req, res) => {
  try {
    const { zone_id, branch_id, bin_code, description, capacity } = req.body;
    if (!bin_code) return res.status(400).json({ error: 'bin_code required' });
    const result = await db.execute({ sql: 'INSERT INTO storage_bins (zone_id, branch_id, bin_code, description, capacity) VALUES (?,?,?,?,?)', args: [zone_id || null, branch_id || null, bin_code, description || null, capacity || null] });
    const { rows: [row] } = await db.execute({ sql: `SELECT sb.*, z.name as zone_name, br.name as branch_name FROM storage_bins sb LEFT JOIN warehouse_zones z ON sb.zone_id = z.id LEFT JOIN branches br ON sb.branch_id = br.id WHERE sb.id = ?`, args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.put('/bins/:id', requirePermission('warehouse'), async (req, res) => {
  try {
    const { bin_code, description, capacity, active, zone_id, branch_id } = req.body;
    await db.execute({ sql: 'UPDATE storage_bins SET bin_code=?, description=?, capacity=?, active=?, zone_id=?, branch_id=? WHERE id=?', args: [bin_code, description || null, capacity || null, active ?? 1, zone_id || null, branch_id || null, req.params.id] });
    const { rows: [row] } = await db.execute({ sql: `SELECT sb.*, z.name as zone_name, br.name as branch_name FROM storage_bins sb LEFT JOIN warehouse_zones z ON sb.zone_id = z.id LEFT JOIN branches br ON sb.branch_id = br.id WHERE sb.id = ?`, args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.delete('/bins/:id', requirePermission('warehouse'), async (req, res) => {
  try {
    const { rows: [asnCount] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM product_bin_assignments WHERE bin_id = ?', args: [req.params.id] });
    if (Number(asnCount.c) > 0) return res.status(400).json({ error: 'Bin has product assignments — remove assignments first' });
    await db.execute({ sql: 'DELETE FROM storage_bins WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── PRODUCT BIN ASSIGNMENTS ──────────────────────────────────────────────────

router.get('/assignments', requireAuth, async (req, res) => {
  try {
    const { bin_id, product_id, branch_id } = req.query;
    let sql = `SELECT a.*, p.name as product_name, p.sku, p.stock_qty as total_stock,
      sb.bin_code, z.name as zone_name, br.name as branch_name, c.name as category_name
      FROM product_bin_assignments a
      LEFT JOIN products p ON a.product_id = p.id
      LEFT JOIN storage_bins sb ON a.bin_id = sb.id
      LEFT JOIN warehouse_zones z ON sb.zone_id = z.id
      LEFT JOIN branches br ON a.branch_id = br.id
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE 1=1`;
    const params = [];
    if (bin_id)     { sql += ' AND a.bin_id = ?';     params.push(bin_id); }
    if (product_id) { sql += ' AND a.product_id = ?'; params.push(product_id); }
    if (branch_id)  { sql += ' AND a.branch_id = ?';  params.push(branch_id); }
    sql += ' ORDER BY sb.bin_code, p.name';
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/assignments', requirePermission('warehouse'), async (req, res) => {
  try {
    const { product_id, bin_id, branch_id, quantity, is_primary } = req.body;
    if (!product_id || !bin_id) return res.status(400).json({ error: 'product_id and bin_id required' });
    const result = await db.execute({ sql: 'INSERT INTO product_bin_assignments (product_id, bin_id, branch_id, quantity, is_primary) VALUES (?,?,?,?,?)', args: [product_id, bin_id, branch_id || null, quantity || 0, is_primary ? 1 : 0] });
    const { rows: [row] } = await db.execute({ sql: `SELECT a.*, p.name as product_name, p.sku, sb.bin_code FROM product_bin_assignments a LEFT JOIN products p ON a.product_id = p.id LEFT JOIN storage_bins sb ON a.bin_id = sb.id WHERE a.id = ?`, args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.put('/assignments/:id', requirePermission('warehouse'), async (req, res) => {
  try {
    const { quantity, is_primary } = req.body;
    await db.execute({ sql: 'UPDATE product_bin_assignments SET quantity=?, is_primary=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', args: [quantity || 0, is_primary ? 1 : 0, req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM product_bin_assignments WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/assignments/:id', requirePermission('warehouse'), async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM product_bin_assignments WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── SHIPMENTS ────────────────────────────────────────────────────────────────

// Shipments are reachable from both the Shipping screen and the Online
// Orders dashboard (processOrderForShipping) — either permission suffices.
router.get('/shipments', requireAnyPermission('shipping', 'transactions'), async (req, res) => {
  try {
    const { status, branch_id } = req.query;
    let sql = `SELECT s.*, b.name as from_branch_name,
      c.first_name || ' ' || c.last_name as customer_name,
      (SELECT COUNT(*) FROM shipment_items WHERE shipment_id = s.id) as item_count
      FROM shipments s
      LEFT JOIN branches b ON s.from_branch_id = b.id
      LEFT JOIN customers c ON s.customer_id = c.id
      WHERE 1=1`;
    const params = [];
    if (status)    { sql += ' AND s.status = ?';          params.push(status); }
    if (branch_id) { sql += ' AND s.from_branch_id = ?'; params.push(branch_id); }
    sql += ' ORDER BY s.created_at DESC LIMIT 200';
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/shipments', requireAnyPermission('shipping', 'transactions'), async (req, res) => {
  try {
    const { from_branch_id, customer_id, carrier, tracking_number, ship_date, estimated_delivery, notes, items } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'At least one item required' });

    const shipment_number = await nextNumber(db, 'shipments', 'shipment_number', 'SHP-', 6);

    const tx = await db.transaction('write');
    let committed = false;
    try {
      const result = await tx.execute({ sql: 'INSERT INTO shipments (shipment_number,from_branch_id,customer_id,carrier,tracking_number,ship_date,estimated_delivery,notes) VALUES (?,?,?,?,?,?,?,?)', args: [shipment_number, from_branch_id || null, customer_id || null, carrier || null, tracking_number || null, ship_date || null, estimated_delivery || null, notes || null] });
      const shipId = Number(result.lastInsertRowid);
      for (const item of items) {
        const { rows: [prod] } = await tx.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] });
        if (!prod) throw new Error(`Product ${item.product_id} not found`);
        await tx.execute({ sql: 'INSERT INTO shipment_items (shipment_id,product_id,product_name,sku,quantity,bin_id) VALUES (?,?,?,?,?,?)', args: [shipId, prod.id, prod.name, prod.sku, parseInt(item.quantity) || 1, item.bin_id || null] });
      }
      await tx.commit();
      committed = true;
      const { rows: [shipRow] } = await db.execute({ sql: 'SELECT * FROM shipments WHERE id = ?', args: [shipId] });
      res.status(201).json(shipRow);
    } catch(e) {
      // Once committed, the shipment is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create a draft shipment from an online order (transaction), pulling items,
// customer, and branch straight from the order so staff don't re-enter them.
router.post('/shipments/from-order/:txId', requireAnyPermission('shipping', 'transactions'), async (req, res) => {
  try {
    const { rows: [existing] } = await db.execute({ sql: 'SELECT * FROM shipments WHERE transaction_id = ?', args: [req.params.txId] });
    if (existing) return res.status(400).json({ error: `Shipment ${existing.shipment_number} already exists for this order` });

    const { rows: [txn] } = await db.execute({ sql: 'SELECT * FROM transactions WHERE id = ?', args: [req.params.txId] });
    if (!txn) return res.status(404).json({ error: 'Order not found' });
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM transaction_items WHERE transaction_id = ?', args: [req.params.txId] });
    if (!items.length) return res.status(400).json({ error: 'Order has no items' });

    const { carrier, tracking_number, ship_date, estimated_delivery } = req.body;
    const shipment_number = await nextNumber(db, 'shipments', 'shipment_number', 'SHP-', 6);

    const tx = await db.transaction('write');
    let committed = false;
    try {
      const result = await tx.execute({ sql: 'INSERT INTO shipments (shipment_number,from_branch_id,customer_id,transaction_id,carrier,tracking_number,ship_date,estimated_delivery,notes) VALUES (?,?,?,?,?,?,?,?,?)', args: [shipment_number, txn.branch_id || null, txn.customer_id || null, txn.id, carrier || null, tracking_number || null, ship_date || null, estimated_delivery || null, `Order ${txn.transaction_number}`] });
      const shipId = Number(result.lastInsertRowid);
      for (const item of items) {
        if (!item.product_id) continue;
        await tx.execute({ sql: 'INSERT INTO shipment_items (shipment_id,product_id,product_name,sku,quantity) VALUES (?,?,?,?,?)', args: [shipId, item.product_id, item.product_name, item.sku, item.quantity] });
      }
      await tx.commit();
      committed = true;
      const { rows: [shipRow] } = await db.execute({ sql: 'SELECT * FROM shipments WHERE id = ?', args: [shipId] });
      res.status(201).json(shipRow);
    } catch(e) {
      // Once committed, the shipment is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/shipments/:id', requireAnyPermission('shipping', 'transactions'), async (req, res) => {
  try {
    const { rows: [s] } = await db.execute({ sql: `
      SELECT s.*,
        b.name as from_branch_name, b.address as from_branch_address,
        b.city as from_branch_city, b.state as from_branch_state,
        b.zip as from_branch_zip, b.phone as from_branch_phone,
        c.first_name || ' ' || c.last_name as customer_name,
        c.address as customer_address, c.city as customer_city,
        c.state as customer_state, c.zip as customer_zip,
        c.phone as customer_phone, c.email as customer_email,
        t.transaction_number as order_number
      FROM shipments s
      LEFT JOIN branches b ON s.from_branch_id = b.id
      LEFT JOIN customers c ON s.customer_id = c.id
      LEFT JOIN transactions t ON s.transaction_id = t.id
      WHERE s.id = ?`, args: [req.params.id] });
    if (!s) return res.status(404).json({ error: 'Not found' });
    const { rows: items } = await db.execute({ sql: 'SELECT si.*, sb.bin_code FROM shipment_items si LEFT JOIN storage_bins sb ON si.bin_id = sb.id WHERE si.shipment_id = ?', args: [req.params.id] });
    s.items = items;
    res.json(s);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/shipments/:id/ship', requireAnyPermission('shipping', 'transactions'), async (req, res) => {
  try {
    const { rows: [s] } = await db.execute({ sql: 'SELECT * FROM shipments WHERE id = ?', args: [req.params.id] });
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (s.status !== 'draft') return res.status(400).json({ error: 'Only draft shipments can be shipped' });

    const { tracking_number, ship_date } = req.body;
    const tx = await db.transaction('write');
    try {
      const { rows: items } = await tx.execute({ sql: 'SELECT * FROM shipment_items WHERE shipment_id = ?', args: [req.params.id] });
      for (const item of items) {
        await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?', args: [item.quantity, item.product_id] });
        if (s.from_branch_id) {
          await tx.execute({ sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at)
            VALUES (?, ?, ?, (SELECT min_stock FROM products WHERE id=?), CURRENT_TIMESTAMP)
            ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = stock_qty - ?, updated_at = CURRENT_TIMESTAMP`, args: [item.product_id, s.from_branch_id, -item.quantity, item.product_id, item.quantity] });
          await syncBinQty(tx, item.product_id, s.from_branch_id, -item.quantity);
        }
      }
      await tx.execute({ sql: 'UPDATE shipments SET status=?, tracking_number=COALESCE(?,tracking_number), ship_date=COALESCE(?,ship_date), shipped_at=CURRENT_TIMESTAMP WHERE id=?', args: ['shipped', tracking_number || null, ship_date || null, req.params.id] });
      await tx.commit();
    } catch(e) {
      await tx.rollback();
      return res.status(400).json({ error: e.message });
    }
    const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM shipments WHERE id = ?', args: [req.params.id] });
    if (updated.transaction_id) {
      try { await updateFulfillmentStatus(updated.transaction_id, 'shipped'); } catch(e) { /* non-fatal — shipment already updated */ }
    }
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/shipments/:id/deliver', requireAnyPermission('shipping', 'transactions'), async (req, res) => {
  try {
    const { rows: [s] } = await db.execute({ sql: 'SELECT * FROM shipments WHERE id = ?', args: [req.params.id] });
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (s.status !== 'shipped') return res.status(400).json({ error: 'Only shipped shipments can be marked delivered' });
    await db.execute({ sql: 'UPDATE shipments SET status=?, delivered_at=CURRENT_TIMESTAMP WHERE id=?', args: ['delivered', req.params.id] });
    const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM shipments WHERE id = ?', args: [req.params.id] });
    if (updated.transaction_id) {
      try { await updateFulfillmentStatus(updated.transaction_id, 'delivered'); } catch(e) { /* non-fatal */ }
    }
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/shipments/:id/cancel', requireAnyPermission('shipping', 'transactions'), async (req, res) => {
  try {
    const { rows: [s] } = await db.execute({ sql: 'SELECT * FROM shipments WHERE id = ?', args: [req.params.id] });
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (s.status === 'delivered') return res.status(400).json({ error: 'Cannot cancel a delivered shipment' });
    if (s.status === 'cancelled') return res.status(400).json({ error: 'Already cancelled' });

    const tx = await db.transaction('write');
    try {
      if (s.status === 'shipped') {
        const { rows: items } = await tx.execute({ sql: 'SELECT * FROM shipment_items WHERE shipment_id = ?', args: [req.params.id] });
        for (const item of items) {
          await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [item.quantity, item.product_id] });
          if (s.from_branch_id) {
            await tx.execute({ sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at)
              VALUES (?, ?, ?, (SELECT min_stock FROM products WHERE id=?), CURRENT_TIMESTAMP)
              ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP`, args: [item.product_id, s.from_branch_id, item.quantity, item.product_id, item.quantity] });
            await syncBinQty(tx, item.product_id, s.from_branch_id, item.quantity);
          }
        }
      }
      await tx.execute({ sql: 'UPDATE shipments SET status=? WHERE id=?', args: ['cancelled', req.params.id] });
      await tx.commit();
    } catch(e) {
      await tx.rollback();
      return res.status(400).json({ error: e.message });
    }
    const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM shipments WHERE id = ?', args: [req.params.id] });
    if (updated.transaction_id) {
      try { await updateFulfillmentStatus(updated.transaction_id, 'cancelled'); } catch(e) { /* non-fatal */ }
    }
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── CYCLE COUNTS ─────────────────────────────────────────────────────────────

router.get('/cycle-counts', requirePermission('cycle-counts'), async (req, res) => {
  try {
    const { branch_id, status } = req.query;
    let sql = `SELECT cc.*, b.name as branch_name, e.first_name || ' ' || e.last_name as employee_name,
      (SELECT COUNT(*) FROM cycle_count_items WHERE session_id = cc.id) as item_count,
      (SELECT COUNT(*) FROM cycle_count_items WHERE session_id = cc.id AND counted_qty IS NOT NULL) as counted_count,
      (SELECT COUNT(*) FROM cycle_count_items WHERE session_id = cc.id AND variance != 0 AND counted_qty IS NOT NULL) as variance_count
      FROM cycle_count_sessions cc
      LEFT JOIN branches b ON cc.branch_id = b.id
      LEFT JOIN employees e ON cc.employee_id = e.id
      WHERE 1=1`;
    const params = [];
    if (branch_id) { sql += ' AND cc.branch_id = ?'; params.push(branch_id); }
    if (status)    { sql += ' AND cc.status = ?';    params.push(status); }
    sql += ' ORDER BY cc.created_at DESC LIMIT 100';
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/cycle-counts', requirePermission('cycle-counts'), async (req, res) => {
  try {
    const { branch_id, employee_id, scope_type = 'all', scope_id, notes } = req.body;

    const session_number = await nextNumber(db, 'cycle_count_sessions', 'session_number', 'CC-', 6);

    const tx = await db.transaction('write');
    let committed = false;
    try {
      const result = await tx.execute({ sql: 'INSERT INTO cycle_count_sessions (session_number,branch_id,employee_id,scope_type,scope_id,notes) VALUES (?,?,?,?,?,?)', args: [session_number, branch_id || null, employee_id || null, scope_type, scope_id || null, notes || null] });
      const sessionId = Number(result.lastInsertRowid);

      // Built with set-based INSERT … SELECTs rather than a loop over
      // products: a full-branch count is thousands of products, and a few
      // queries per product inside one transaction against remote Turso took
      // minutes, leaving the Create button looking frozen.
      let prodFilter = 'p.active = 1';
      const prodArgs = [];
      if (scope_type === 'category' && scope_id) {
        prodFilter += ' AND p.category_id = ?';
        prodArgs.push(scope_id);
      }

      if (scope_type === 'bin' && scope_id) {
        await tx.execute({ sql: `INSERT INTO cycle_count_items (session_id,product_id,product_name,sku,bin_id,bin_code,expected_qty)
          SELECT ?, p.id, p.name, p.sku, ?, (SELECT bin_code FROM storage_bins WHERE id = ?),
            COALESCE((SELECT a.quantity FROM product_bin_assignments a WHERE a.product_id = p.id AND a.bin_id = ? ORDER BY a.id LIMIT 1), 0)
          FROM products p
          WHERE ${prodFilter} AND p.id IN (SELECT product_id FROM product_bin_assignments WHERE bin_id = ?)
          ORDER BY p.name`, args: [sessionId, parseInt(scope_id), scope_id, scope_id, ...prodArgs, scope_id] });
      } else {
        const asnBranch = branch_id ? ' AND a.branch_id = ?' : '';
        const asnArgs = branch_id ? [branch_id] : [];
        // One line per bin a product is assigned to…
        await tx.execute({ sql: `INSERT INTO cycle_count_items (session_id,product_id,product_name,sku,bin_id,bin_code,expected_qty)
          SELECT ?, p.id, p.name, p.sku, a.bin_id, sb.bin_code, a.quantity
          FROM products p
          JOIN product_bin_assignments a ON a.product_id = p.id${asnBranch}
          LEFT JOIN storage_bins sb ON a.bin_id = sb.id
          WHERE ${prodFilter}
          ORDER BY p.name, a.id`, args: [sessionId, ...asnArgs, ...prodArgs] });
        // …and one unbinned line for every other product. Match the Inventory
        // page's per-branch figure exactly: when a branch is selected, a
        // product with no branch_inventory row reads as 0 there
        // (COALESCE(bi.stock_qty, 0) in routes/products.js), not the global total.
        const expected = branch_id
          ? 'COALESCE((SELECT bi.stock_qty FROM branch_inventory bi WHERE bi.product_id = p.id AND bi.branch_id = ?), 0)'
          : 'p.stock_qty';
        await tx.execute({ sql: `INSERT INTO cycle_count_items (session_id,product_id,product_name,sku,bin_id,bin_code,expected_qty)
          SELECT ?, p.id, p.name, p.sku, NULL, NULL, ${expected}
          FROM products p
          WHERE ${prodFilter} AND NOT EXISTS (SELECT 1 FROM product_bin_assignments a WHERE a.product_id = p.id${asnBranch})
          ORDER BY p.name`, args: [sessionId, ...(branch_id ? [branch_id] : []), ...prodArgs, ...asnArgs] });
      }

      await tx.commit();
      committed = true;
      const { rows: [session] } = await db.execute({ sql: 'SELECT * FROM cycle_count_sessions WHERE id = ?', args: [sessionId] });
      res.status(201).json(session);
    } catch(e) {
      // Once committed, the session is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/cycle-counts/:id', requirePermission('cycle-counts'), async (req, res) => {
  try {
    const { rows: [session] } = await db.execute({ sql: `SELECT cc.*, b.name as branch_name, e.first_name || ' ' || e.last_name as employee_name FROM cycle_count_sessions cc LEFT JOIN branches b ON cc.branch_id = b.id LEFT JOIN employees e ON cc.employee_id = e.id WHERE cc.id = ?`, args: [req.params.id] });
    if (!session) return res.status(404).json({ error: 'Not found' });
    const { rows: items } = await db.execute({ sql: `SELECT ci.*, c.name as category_name FROM cycle_count_items ci LEFT JOIN products p ON ci.product_id = p.id LEFT JOIN categories c ON p.category_id = c.id WHERE ci.session_id = ? ORDER BY ci.bin_code, ci.product_name`, args: [req.params.id] });
    session.items = items;
    const { rows: uploads } = await db.execute({ sql: `SELECT u.*, e.first_name || ' ' || e.last_name AS employee_name FROM cycle_count_uploads u LEFT JOIN employees e ON u.employee_id = e.id WHERE u.session_id = ? ORDER BY u.id`, args: [req.params.id] });
    session.uploads = uploads;
    res.json(session);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Export as CSV
router.get('/cycle-counts/:id/export', requirePermission('cycle-counts'), async (req, res) => {
  try {
    const { rows: [session] } = await db.execute({ sql: 'SELECT * FROM cycle_count_sessions WHERE id = ?', args: [req.params.id] });
    if (!session) return res.status(404).json({ error: 'Not found' });
    const { rows: items } = await db.execute({ sql: `SELECT ci.*, c.name as category_name FROM cycle_count_items ci LEFT JOIN products p ON ci.product_id = p.id LEFT JOIN categories c ON p.category_id = c.id WHERE ci.session_id = ? ORDER BY ci.bin_code, ci.product_name`, args: [req.params.id] });

    const csvRows = [['Item ID', 'SKU', 'Product Name', 'Category', 'Bin Code', 'Expected Qty', 'Counted Qty']];
    items.forEach(i => csvRows.push([i.id, i.sku, i.product_name, i.category_name || '', i.bin_code || '', i.expected_qty, i.counted_qty !== null ? i.counted_qty : '']));

    const csv = csvRows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    // Served as octet-stream, not text/csv: on Windows with Excel installed,
    // text/csv is registered to .xls and the browser saves "…csv.xls", which
    // scanner apps won't import. octet-stream keeps the filename as given.
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${session.session_number}-cycle-count.csv"`);
    res.send(csv);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Count imports ──────────────────────────────────────────────
// Every import — a scanner file, or Save Counts on screen — is stored as an
// upload with one line per item, and counted_qty is replayed from the
// session's active uploads (see cycle_count_uploads in database.js). So
// several scanners can each upload in 'add' mode and their counts sum, and any
// one upload can be undone without disturbing the rest.

const CHUNK = 400;
const chunks = arr => Array.from({ length: Math.ceil(arr.length / CHUNK) }, (_, i) => arr.slice(i * CHUNK, (i + 1) * CHUNK));

function parseCountQty(v) {
  const s = v == null ? '' : String(v).trim().replace(/,/g, '');
  if (s === '') return { blank: true };
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? { qty: n } : { error: true };
}

// Matches import rows to the session's lines by Item ID, falling back to SKU
// or barcode (either column, since scanners often put the barcode under
// "SKU"), narrowed by Bin Code when a SKU is counted in more than one bin.
// Rows matching the same line are summed, so a one-row-per-scan file works.
function matchCountRows(items, rows) {
  const byId = new Map(), bySku = new Map(), byBarcode = new Map();
  const index = (map, key, it) => {
    if (key == null || String(key).trim() === '') return;
    const k = String(key).trim().toLowerCase();
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  };
  for (const it of items) {
    byId.set(Number(it.id), it);
    index(bySku, it.sku, it);
    index(byBarcode, it.barcode, it);
  }
  const totals = new Map();
  const unmatched = [];
  let skipped = 0, matchedRows = 0;
  rows.forEach((r, i) => {
    const line = r.line || i + 2;
    const sku = String(r.sku ?? '').trim();
    const barcode = String(r.barcode ?? '').trim();
    const bin = String(r.bin_code ?? '').trim().toLowerCase();
    const rawId = String(r.item_id ?? '').trim();
    const ref = sku || barcode || (rawId ? `Item ID ${rawId}` : '(no SKU)');
    const q = parseCountQty(r.counted_qty);
    if (q.blank) { skipped++; return; }
    if (q.error) { unmatched.push({ line, ref, reason: `Counted Qty "${r.counted_qty}" isn't a whole number of 0 or more` }); return; }

    let item = null, reason = null;
    if (rawId) {
      const it = byId.get(Number(rawId));
      if (it && sku && it.sku && it.sku.toLowerCase() !== sku.toLowerCase()
          && String(it.barcode || '').toLowerCase() !== sku.toLowerCase()) {
        reason = `Item ID ${rawId} is ${it.sku} in this session, not ${sku} — was the sheet exported from a different count?`;
      } else if (it) item = it;
      else if (!sku && !barcode) reason = `Item ID ${rawId} isn't in this session — was the sheet exported from a different count?`;
    }
    if (!item && !reason) {
      const keys = [sku, barcode].filter(Boolean).map(k => k.toLowerCase());
      let cands = [];
      for (const k of keys) { cands = bySku.get(k) || byBarcode.get(k) || []; if (cands.length) break; }
      if (!keys.length) reason = 'No Item ID, SKU or barcode';
      else if (!cands.length) reason = `${ref} isn't in this count session`;
      else {
        if (cands.length > 1 && bin) {
          const inBin = cands.filter(c => String(c.bin_code || '').toLowerCase() === bin);
          if (!inBin.length) reason = `${ref} isn't counted in bin ${r.bin_code} in this session`;
          cands = inBin;
        }
        if (!reason && cands.length > 1) reason = `${ref} is counted in ${cands.length} bins in this session — add a Bin Code to say which`;
        if (!reason) item = cands[0];
      }
    }
    if (!item) { unmatched.push({ line, ref, reason }); return; }
    totals.set(Number(item.id), (totals.get(Number(item.id)) || 0) + q.qty);
    matchedRows++;
  });
  return { totals, unmatched, skipped, matchedRows };
}

// Recomputes counted_qty/variance for the given lines from the session's
// active uploads, in upload order: 'replace' sets the count, 'add' adds to it.
// A line no active upload touches goes back to uncounted.
async function replayCounts(tx, sessionId, itemIds) {
  const ids = [...new Set(itemIds.map(Number))];
  const counts = new Map(ids.map(id => [id, null]));
  for (const part of chunks(ids)) {
    const { rows } = await tx.execute({ sql: `SELECT l.item_id, l.qty, u.mode FROM cycle_count_upload_lines l JOIN cycle_count_uploads u ON u.id = l.upload_id
      WHERE u.session_id = ? AND u.undone_at IS NULL AND l.item_id IN (${part.map(() => '?').join(',')}) ORDER BY u.id, l.id`, args: [sessionId, ...part] });
    for (const r of rows) {
      const id = Number(r.item_id), cur = counts.get(id);
      counts.set(id, r.mode === 'add' ? (cur || 0) + Number(r.qty) : Number(r.qty));
    }
  }
  for (const part of chunks(ids)) {
    await tx.batch(part.map(id => {
      const c = counts.get(id);
      return { sql: 'UPDATE cycle_count_items SET counted_qty = ?, variance = CASE WHEN ? IS NULL THEN 0 ELSE ? - expected_qty END WHERE id = ? AND session_id = ?', args: [c, c, c, id, sessionId] };
    }));
  }
}

async function insertUpload(tx, { sessionId, deviceLabel, fileName, mode, contentHash, lines, employeeId }) {
  const totalQty = lines.reduce((s, [, q]) => s + q, 0);
  const r = await tx.execute({ sql: 'INSERT INTO cycle_count_uploads (session_id, device_label, file_name, mode, content_hash, line_count, total_qty, employee_id) VALUES (?,?,?,?,?,?,?,?)',
    args: [sessionId, deviceLabel, fileName, mode, contentHash, lines.length, totalQty, employeeId] });
  const uploadId = Number(r.lastInsertRowid);
  for (const part of chunks(lines)) {
    await tx.batch(part.map(([itemId, qty]) => ({ sql: 'INSERT INTO cycle_count_upload_lines (upload_id, item_id, qty) VALUES (?,?,?)', args: [uploadId, itemId, qty] })));
  }
  return uploadId;
}

// Import counted quantities. Body: { rows: [{ item_id?, sku?, barcode?,
// bin_code?, counted_qty, line? }], mode: 'add'|'replace', device_label,
// file_name, dry_run?, allow_duplicate? }. The older { items: [{ item_id,
// counted_qty }] } shape is still accepted. dry_run returns the match summary
// without saving, which the import screen shows before the user confirms.
router.post('/cycle-counts/:id/import', requirePermission('cycle-counts'), async (req, res) => {
  try {
    const sessionId = Number(req.params.id);
    const { rows: [session] } = await db.execute({ sql: 'SELECT * FROM cycle_count_sessions WHERE id = ?', args: [sessionId] });
    if (!session) return res.status(404).json({ error: 'Not found' });
    if (session.status === 'committed') return res.status(400).json({ error: 'Session already committed' });

    const rows = req.body.rows || req.body.items;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No items provided' });
    const mode = req.body.mode === 'add' ? 'add' : 'replace';
    const deviceLabel = String(req.body.device_label || '').trim().slice(0, 100) || null;
    const fileName = String(req.body.file_name || '').trim().slice(0, 255) || null;

    const { rows: items } = await db.execute({ sql: 'SELECT ci.id, ci.sku, ci.bin_code, p.barcode FROM cycle_count_items ci LEFT JOIN products p ON p.id = ci.product_id WHERE ci.session_id = ?', args: [sessionId] });
    const { totals, unmatched, skipped, matchedRows } = matchCountRows(items, rows);
    const lines = [...totals].sort((a, b) => a[0] - b[0]);
    const contentHash = crypto.createHash('sha256').update(lines.map(([id, q]) => `${id}:${q}`).join(',')).digest('hex');
    let duplicateOf = null;
    if (lines.length) {
      const { rows: [dup] } = await db.execute({ sql: 'SELECT id, device_label, file_name, created_at FROM cycle_count_uploads WHERE session_id = ? AND content_hash = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1', args: [sessionId, contentHash] });
      duplicateOf = dup || null;
    }
    const summary = { mode, matched_rows: matchedRows, matched_items: lines.length, total_qty: lines.reduce((s, [, q]) => s + q, 0), skipped_blank: skipped, unmatched, duplicate_of: duplicateOf };
    if (req.body.dry_run) return res.json(summary);
    if (!lines.length) return res.status(400).json({ ...summary, error: unmatched.length ? `None of the rows matched this count session (${unmatched.length} unmatched)` : 'No counts entered' });
    // Adding the same file twice would double every count in it.
    if (mode === 'add' && duplicateOf && !req.body.allow_duplicate) {
      return res.status(409).json({ ...summary, error: `These counts are identical to upload #${duplicateOf.id}${duplicateOf.device_label ? ` (${duplicateOf.device_label})` : ''} — adding them again would double them` });
    }

    const tx = await db.transaction('write');
    let committed = false, uploadId;
    try {
      const { rows: [cur] } = await tx.execute({ sql: 'SELECT status FROM cycle_count_sessions WHERE id = ?', args: [sessionId] });
      if (cur.status === 'committed') throw new Error('Session already committed');
      // Counts entered before uploads were tracked have no lines to replay
      // from, so keep them as a baseline upload rather than lose them.
      const { rows: [{ n }] } = await tx.execute({ sql: 'SELECT COUNT(*) AS n FROM cycle_count_uploads WHERE session_id = ?', args: [sessionId] });
      if (!Number(n)) {
        const { rows: prior } = await tx.execute({ sql: 'SELECT id, counted_qty FROM cycle_count_items WHERE session_id = ? AND counted_qty IS NOT NULL', args: [sessionId] });
        if (prior.length) {
          await insertUpload(tx, { sessionId, deviceLabel: 'Counts entered earlier', fileName: null, mode: 'replace', contentHash: null,
            lines: prior.map(p => [Number(p.id), Number(p.counted_qty)]), employeeId: null });
        }
      }
      uploadId = await insertUpload(tx, { sessionId, deviceLabel, fileName, mode, contentHash, lines, employeeId: req.employee?.id || null });
      await replayCounts(tx, sessionId, lines.map(([id]) => id));
      await tx.execute({ sql: "UPDATE cycle_count_sessions SET status = 'review' WHERE id = ? AND status != 'committed'", args: [sessionId] });
      await tx.commit();
      committed = true;
    } catch(e) {
      if (!committed) await tx.rollback();
      return res.status(committed ? 500 : 400).json({ error: e.message });
    }

    const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM cycle_count_sessions WHERE id = ?', args: [sessionId] });
    const { rows: updatedItems } = await db.execute({ sql: 'SELECT * FROM cycle_count_items WHERE session_id = ? ORDER BY bin_code, product_name', args: [sessionId] });
    updated.items = updatedItems;
    res.json({ ...updated, ...summary, upload_id: uploadId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Undo one upload: its lines stop counting and the items it touched are
// replayed from whatever uploads remain.
router.post('/cycle-counts/:id/uploads/:uploadId/undo', requirePermission('cycle-counts'), async (req, res) => {
  try {
    const sessionId = Number(req.params.id), uploadId = Number(req.params.uploadId);
    const tx = await db.transaction('write');
    let committed = false;
    try {
      const { rows: [session] } = await tx.execute({ sql: 'SELECT status FROM cycle_count_sessions WHERE id = ?', args: [sessionId] });
      if (!session) throw new Error('Not found');
      if (session.status === 'committed') throw new Error('Session already committed');
      const r = await tx.execute({ sql: 'UPDATE cycle_count_uploads SET undone_at = CURRENT_TIMESTAMP, undone_by = ? WHERE id = ? AND session_id = ? AND undone_at IS NULL', args: [req.employee?.id || null, uploadId, sessionId] });
      if (!r.rowsAffected) throw new Error('Upload not found or already undone');
      const { rows: lines } = await tx.execute({ sql: 'SELECT item_id FROM cycle_count_upload_lines WHERE upload_id = ?', args: [uploadId] });
      await replayCounts(tx, sessionId, lines.map(l => l.item_id));
      await tx.commit();
      committed = true;
    } catch(e) {
      if (!committed) await tx.rollback();
      return res.status(committed ? 500 : 400).json({ error: e.message });
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Commit adjustments to inventory. { zero_uncounted: true } first records
// every line nobody counted as 0 — for a full count, where anything not
// scanned wasn't found.
router.patch('/cycle-counts/:id/commit', requirePermission('cycle-counts'), async (req, res) => {
  try {
    const { rows: [session] } = await db.execute({ sql: 'SELECT * FROM cycle_count_sessions WHERE id = ?', args: [req.params.id] });
    if (!session) return res.status(404).json({ error: 'Not found' });
    if (session.status === 'committed') return res.status(400).json({ error: 'Already committed' });

    const tx = await db.transaction('write');
    let committed = false;
    try {
      // Claim the session inside the transaction so two people pressing
      // Commit at once can't apply the variances twice.
      const claim = await tx.execute({ sql: "UPDATE cycle_count_sessions SET status = 'committed', committed_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'committed'", args: [session.id] });
      if (!claim.rowsAffected) throw new Error('Already committed');
      if (req.body?.zero_uncounted) {
        await tx.execute({ sql: 'UPDATE cycle_count_items SET counted_qty = 0, variance = -expected_qty WHERE session_id = ? AND counted_qty IS NULL', args: [session.id] });
      }
      const { rows: varItems } = await tx.execute({ sql: 'SELECT * FROM cycle_count_items WHERE session_id = ? AND counted_qty IS NOT NULL AND variance != 0', args: [session.id] });
      const stmts = [];
      for (const item of varItems) {
        if (!item.product_id) continue;
        stmts.push({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [item.variance, item.product_id] });
        if (item.bin_id) {
          stmts.push({ sql: 'UPDATE product_bin_assignments SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND bin_id = ?', args: [item.counted_qty, item.product_id, item.bin_id] });
        }
        if (session.branch_id) {
          stmts.push({ sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at)
            VALUES (?, ?, ?, (SELECT min_stock FROM products WHERE id=?), CURRENT_TIMESTAMP)
            ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP`, args: [item.product_id, session.branch_id, item.variance, item.product_id, item.variance] });
        }
        stmts.push({ sql: 'INSERT INTO stock_movements (product_id, branch_id, quantity_change, type, reference, reason) VALUES (?,?,?,?,?,?)', args: [item.product_id, session.branch_id || null, item.variance, 'adjustment', session.session_number, `Cycle count variance (expected ${item.expected_qty}, counted ${item.counted_qty})`] });
      }
      // Batched: an initial count can put a variance on every line, and one
      // round trip per statement is slow against a remote database.
      for (const part of chunks(stmts)) await tx.batch(part);
      await tx.commit();
      committed = true;
    } catch(e) {
      if (!committed) await tx.rollback();
      return res.status(committed ? 500 : 400).json({ error: e.message });
    }

    const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM cycle_count_sessions WHERE id = ?', args: [req.params.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
