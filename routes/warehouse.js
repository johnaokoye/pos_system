const express = require('express');
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

      let prodSql = `SELECT p.id, p.name, p.sku, p.stock_qty FROM products p WHERE p.active = 1`;
      const prodParams = [];
      if (scope_type === 'category' && scope_id) {
        prodSql += ' AND p.category_id = ?';
        prodParams.push(scope_id);
      } else if (scope_type === 'bin' && scope_id) {
        prodSql += ' AND p.id IN (SELECT product_id FROM product_bin_assignments WHERE bin_id = ?)';
        prodParams.push(scope_id);
      }
      prodSql += ' ORDER BY p.name';
      const { rows: products } = await tx.execute({ sql: prodSql, args: prodParams });

      if (scope_type === 'bin' && scope_id) {
        const { rows: [bin] } = await tx.execute({ sql: 'SELECT * FROM storage_bins WHERE id = ?', args: [scope_id] });
        for (const p of products) {
          const { rows: [asn] } = await tx.execute({ sql: 'SELECT * FROM product_bin_assignments WHERE product_id = ? AND bin_id = ?', args: [p.id, scope_id] });
          await tx.execute({ sql: 'INSERT INTO cycle_count_items (session_id,product_id,product_name,sku,bin_id,bin_code,expected_qty) VALUES (?,?,?,?,?,?,?)', args: [sessionId, p.id, p.name, p.sku, parseInt(scope_id), bin ? bin.bin_code : null, asn ? asn.quantity : 0] });
        }
      } else {
        for (const p of products) {
          const asnSql = branch_id
            ? `SELECT a.*, sb.bin_code FROM product_bin_assignments a LEFT JOIN storage_bins sb ON a.bin_id = sb.id WHERE a.product_id = ? AND a.branch_id = ?`
            : `SELECT a.*, sb.bin_code FROM product_bin_assignments a LEFT JOIN storage_bins sb ON a.bin_id = sb.id WHERE a.product_id = ?`;
          const asnArgs = branch_id ? [p.id, branch_id] : [p.id];
          const { rows: asnQuery } = await tx.execute({ sql: asnSql, args: asnArgs });

          if (asnQuery.length > 0) {
            for (const a of asnQuery) {
              await tx.execute({ sql: 'INSERT INTO cycle_count_items (session_id,product_id,product_name,sku,bin_id,bin_code,expected_qty) VALUES (?,?,?,?,?,?,?)', args: [sessionId, p.id, p.name, p.sku, a.bin_id, a.bin_code, a.quantity] });
            }
          } else {
            // Match the Inventory page's per-branch figure exactly: when a branch is
            // selected, a product with no branch_inventory row reads as 0 there
            // (COALESCE(bi.stock_qty, 0) in routes/products.js), not the global total.
            let stockQty = p.stock_qty;
            if (branch_id) {
              const { rows: [inv] } = await tx.execute({ sql: 'SELECT stock_qty FROM branch_inventory WHERE product_id = ? AND branch_id = ?', args: [p.id, branch_id] });
              stockQty = inv ? inv.stock_qty : 0;
            }
            await tx.execute({ sql: 'INSERT INTO cycle_count_items (session_id,product_id,product_name,sku,bin_id,bin_code,expected_qty) VALUES (?,?,?,?,?,?,?)', args: [sessionId, p.id, p.name, p.sku, null, null, stockQty] });
          }
        }
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
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${session.session_number}-cycle-count.csv"`);
    res.send(csv);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Import counted quantities (JSON array of {item_id, counted_qty})
router.post('/cycle-counts/:id/import', requirePermission('cycle-counts'), async (req, res) => {
  try {
    const { rows: [session] } = await db.execute({ sql: 'SELECT * FROM cycle_count_sessions WHERE id = ?', args: [req.params.id] });
    if (!session) return res.status(404).json({ error: 'Not found' });
    if (session.status === 'committed') return res.status(400).json({ error: 'Session already committed' });

    const { items } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'No items provided' });

    const tx = await db.transaction('write');
    try {
      for (const { item_id, counted_qty } of items) {
        if (item_id == null || counted_qty === undefined || counted_qty === null || counted_qty === '') continue;
        const cq = parseInt(counted_qty);
        if (isNaN(cq) || cq < 0) continue;
        await tx.execute({ sql: 'UPDATE cycle_count_items SET counted_qty = ?, variance = ? - expected_qty WHERE id = ? AND session_id = ?', args: [cq, cq, item_id, req.params.id] });
      }
      await tx.execute({ sql: "UPDATE cycle_count_sessions SET status = 'review' WHERE id = ? AND status != 'committed'", args: [req.params.id] });
      await tx.commit();
    } catch(e) {
      await tx.rollback();
      return res.status(400).json({ error: e.message });
    }

    const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM cycle_count_sessions WHERE id = ?', args: [req.params.id] });
    const { rows: updatedItems } = await db.execute({ sql: 'SELECT * FROM cycle_count_items WHERE session_id = ? ORDER BY bin_code, product_name', args: [req.params.id] });
    updated.items = updatedItems;
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Commit adjustments to inventory
router.patch('/cycle-counts/:id/commit', requirePermission('cycle-counts'), async (req, res) => {
  try {
    const { rows: [session] } = await db.execute({ sql: 'SELECT * FROM cycle_count_sessions WHERE id = ?', args: [req.params.id] });
    if (!session) return res.status(404).json({ error: 'Not found' });
    if (session.status === 'committed') return res.status(400).json({ error: 'Already committed' });

    const { rows: varItems } = await db.execute({ sql: 'SELECT * FROM cycle_count_items WHERE session_id = ? AND counted_qty IS NOT NULL AND variance != 0', args: [req.params.id] });

    const tx = await db.transaction('write');
    try {
      for (const item of varItems) {
        if (!item.product_id) continue;
        await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [item.variance, item.product_id] });
        if (item.bin_id) {
          await tx.execute({ sql: 'UPDATE product_bin_assignments SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND bin_id = ?', args: [item.counted_qty, item.product_id, item.bin_id] });
        }
        if (session.branch_id) {
          await tx.execute({ sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at)
            VALUES (?, ?, ?, (SELECT min_stock FROM products WHERE id=?), CURRENT_TIMESTAMP)
            ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP`, args: [item.product_id, session.branch_id, item.variance, item.product_id, item.variance] });
        }
        await tx.execute({ sql: 'INSERT INTO stock_movements (product_id, branch_id, quantity_change, type, reference, reason) VALUES (?,?,?,?,?,?)', args: [item.product_id, session.branch_id || null, item.variance, 'adjustment', session.session_number, `Cycle count variance (expected ${item.expected_qty}, counted ${item.counted_qty})`] });
      }
      await tx.execute({ sql: 'UPDATE cycle_count_sessions SET status = ?, committed_at = CURRENT_TIMESTAMP WHERE id = ?', args: ['committed', session.id] });
      await tx.commit();
    } catch(e) {
      await tx.rollback();
      return res.status(400).json({ error: e.message });
    }

    const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM cycle_count_sessions WHERE id = ?', args: [req.params.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
