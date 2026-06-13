const express = require('express');
const router = express.Router();
const { db } = require('../database');

router.get('/', async (req, res) => {
  try {
    const { status, branch_id, employee_id, start, end, limit = 100 } = req.query;
    let sql = `SELECT pr.*, b.name as branch_name, e.first_name || ' ' || e.last_name as employee_name, po.po_number as converted_po_number FROM purchase_requests pr LEFT JOIN branches b ON pr.branch_id = b.id LEFT JOIN employees e ON pr.employee_id = e.id LEFT JOIN purchase_orders po ON pr.converted_to_po_id = po.id WHERE 1=1`;
    const params = [];
    if (status) { sql += ' AND pr.status = ?'; params.push(status); }
    if (branch_id) { sql += ' AND pr.branch_id = ?'; params.push(branch_id); }
    if (employee_id) { sql += ' AND pr.employee_id = ?'; params.push(employee_id); }
    if (start) { sql += ' AND date(pr.created_at) >= ?'; params.push(start); }
    if (end) { sql += ' AND date(pr.created_at) <= ?'; params.push(end); }
    sql += ' ORDER BY pr.created_at DESC LIMIT ?';
    params.push(parseInt(limit));
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows: [pr] } = await db.execute({ sql: `SELECT pr.*, b.name as branch_name, e.first_name || ' ' || e.last_name as employee_name, po.po_number as converted_po_number FROM purchase_requests pr LEFT JOIN branches b ON pr.branch_id = b.id LEFT JOIN employees e ON pr.employee_id = e.id LEFT JOIN purchase_orders po ON pr.converted_to_po_id = po.id WHERE pr.id = ?`, args: [req.params.id] });
    if (!pr) return res.status(404).json({ error: 'Not found' });
    const { rows: items } = await db.execute({ sql: 'SELECT pri.*, p.name as linked_product_name FROM purchase_request_items pri LEFT JOIN products p ON pri.product_id = p.id WHERE pri.pr_id = ?', args: [req.params.id] });
    pr.items = items;
    res.json(pr);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { branch_id, employee_id, department, notes, required_date, items } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items in purchase request' });

    const { rows: [count] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM purchase_requests', args: [] });
    const pr_number = `PR-${String(Number(count.c) + 1).padStart(6, '0')}`;

    const processedItems = [];
    for (const item of items) {
      const product = item.product_id ? (await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] })).rows[0] : null;
      const unit_cost = parseFloat(item.unit_cost || (product ? product.cost : 0)) || 0;
      const qty = parseInt(item.quantity || 1);
      processedItems.push({ product_id: item.product_id || null, product_name: item.product_name || (product ? product.name : 'Unknown'), sku: item.sku || (product ? product.sku : ''), quantity: qty, unit_cost, notes: item.notes || null, total: parseFloat((unit_cost * qty).toFixed(2)) });
    }

    const tx = await db.transaction('write');
    try {
      const result = await tx.execute({ sql: 'INSERT INTO purchase_requests (pr_number, branch_id, employee_id, department, notes, required_date) VALUES (?,?,?,?,?,?)', args: [pr_number, branch_id || null, employee_id || null, department || null, notes || null, required_date || null] });
      const prId = Number(result.lastInsertRowid);
      for (const item of processedItems) {
        await tx.execute({ sql: 'INSERT INTO purchase_request_items (pr_id, product_id, product_name, sku, quantity, unit_cost, notes, total) VALUES (?,?,?,?,?,?,?,?)', args: [prId, item.product_id, item.product_name, item.sku, item.quantity, item.unit_cost, item.notes, item.total] });
      }
      await tx.commit();
      const { rows: [pr] } = await db.execute({ sql: 'SELECT * FROM purchase_requests WHERE id = ?', args: [prId] });
      const { rows: prItems } = await db.execute({ sql: 'SELECT * FROM purchase_request_items WHERE pr_id = ?', args: [prId] });
      pr.items = prItems;
      res.status(201).json(pr);
    } catch(e) {
      await tx.rollback();
      res.status(400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['draft', 'submitted', 'approved', 'rejected'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const { rows: [pr] } = await db.execute({ sql: 'SELECT * FROM purchase_requests WHERE id = ?', args: [req.params.id] });
    if (!pr) return res.status(404).json({ error: 'Not found' });
    if (pr.status === 'converted') return res.status(400).json({ error: 'Cannot change status of a converted PR' });
    await db.execute({ sql: 'UPDATE purchase_requests SET status = ? WHERE id = ?', args: [status, req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM purchase_requests WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Convert approved PR to a Purchase Order
router.post('/:id/convert', async (req, res) => {
  try {
    const { supplier_id, expected_date, notes: poNotes } = req.body;
    const { rows: [pr] } = await db.execute({ sql: 'SELECT * FROM purchase_requests WHERE id = ?', args: [req.params.id] });
    if (!pr) return res.status(404).json({ error: 'Not found' });
    if (pr.status === 'converted') return res.status(400).json({ error: 'PR already converted to a PO' });
    if (pr.status !== 'approved') return res.status(400).json({ error: 'Only approved PRs can be converted to a PO' });

    const { rows: prItems } = await db.execute({ sql: 'SELECT * FROM purchase_request_items WHERE pr_id = ?', args: [pr.id] });
    if (!prItems.length) return res.status(400).json({ error: 'PR has no items' });

    const tx = await db.transaction('write');
    try {
      const { rows: [count] } = await tx.execute({ sql: 'SELECT COUNT(*) as c FROM purchase_orders', args: [] });
      const po_number = `PO-${String(Number(count.c) + 1).padStart(6, '0')}`;
      let subtotal = 0;
      prItems.forEach(item => { subtotal += item.total || 0; });
      subtotal = parseFloat(subtotal.toFixed(2));

      const poResult = await tx.execute({ sql: 'INSERT INTO purchase_orders (po_number, supplier_id, branch_id, employee_id, subtotal, total, notes, expected_date) VALUES (?,?,?,?,?,?,?,?)', args: [po_number, supplier_id || null, pr.branch_id, pr.employee_id, subtotal, subtotal, poNotes || pr.notes, expected_date || pr.required_date || null] });
      const poId = Number(poResult.lastInsertRowid);

      for (const item of prItems) {
        await tx.execute({ sql: 'INSERT INTO purchase_order_items (po_id, product_id, product_name, sku, quantity_ordered, unit_cost, total) VALUES (?,?,?,?,?,?,?)', args: [poId, item.product_id, item.product_name, item.sku, item.quantity, item.unit_cost, item.total] });
      }

      await tx.execute({ sql: 'UPDATE purchase_requests SET status = ?, converted_to_po_id = ? WHERE id = ?', args: ['converted', poId, pr.id] });
      await tx.commit();

      const { rows: [po] } = await db.execute({ sql: `SELECT po.*, s.name as supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id WHERE po.id = ?`, args: [poId] });
      const { rows: poItemsResult } = await db.execute({ sql: 'SELECT * FROM purchase_order_items WHERE po_id = ?', args: [poId] });
      po.items = poItemsResult;
      res.status(201).json(po);
    } catch(e) {
      await tx.rollback();
      res.status(400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
