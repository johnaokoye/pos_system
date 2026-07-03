const express = require('express');
const router = express.Router();
const { db } = require('../database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { cloudUpload, cloudDestroy } = require('../lib/cloudinary');

const localUploadDir = path.join(__dirname, '../uploads/po-attachments');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf','image/jpeg','image/png','image/gif','image/webp',
      'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain'];
    cb(null, allowed.includes(file.mimetype));
  },
});

router.get('/', async (req, res) => {
  try {
    const { status, supplier_id, branch_id, start, end, limit = 100 } = req.query;
    let sql = `SELECT po.*, s.name as supplier_name, b.name as branch_name, e.first_name || ' ' || e.last_name as employee_name FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id LEFT JOIN branches b ON po.branch_id = b.id LEFT JOIN employees e ON po.employee_id = e.id WHERE 1=1`;
    const params = [];
    if (status) { sql += ' AND po.status = ?'; params.push(status); }
    if (supplier_id) { sql += ' AND po.supplier_id = ?'; params.push(supplier_id); }
    if (branch_id) { sql += ' AND po.branch_id = ?'; params.push(branch_id); }
    if (start) { sql += ' AND date(po.created_at) >= ?'; params.push(start); }
    if (end) { sql += ' AND date(po.created_at) <= ?'; params.push(end); }
    sql += ' ORDER BY po.created_at DESC LIMIT ?';
    params.push(parseInt(limit));
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows: [po] } = await db.execute({ sql: `SELECT po.*, s.name as supplier_name, s.contact_name as supplier_contact, s.email as supplier_email, b.name as branch_name, e.first_name || ' ' || e.last_name as employee_name FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id LEFT JOIN branches b ON po.branch_id = b.id LEFT JOIN employees e ON po.employee_id = e.id WHERE po.id = ?`, args: [req.params.id] });
    if (!po) return res.status(404).json({ error: 'Not found' });
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM purchase_order_items WHERE po_id = ?', args: [req.params.id] });
    po.items = items;
    res.json(po);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { supplier_id, branch_id, employee_id, items, notes, expected_date } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items in PO' });

    const { rows: [count] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM purchase_orders', args: [] });
    const po_number = `PO-${String(Number(count.c) + 1).padStart(6, '0')}`;

    let subtotal = 0;
    const processedItems = [];
    for (const item of items) {
      const product = item.product_id ? (await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] })).rows[0] : null;
      const unit_cost = parseFloat(item.unit_cost || (product ? product.cost : 0));
      const qty = parseInt(item.quantity_ordered || item.quantity || 1);
      const total = parseFloat((unit_cost * qty).toFixed(2));
      subtotal += total;
      processedItems.push({ product_id: item.product_id || null, product_name: item.product_name || (product ? product.name : 'Unknown'), sku: item.sku || (product ? product.sku : ''), quantity_ordered: qty, unit_cost, total });
    }
    subtotal = parseFloat(subtotal.toFixed(2));

    const tx = await db.transaction('write');
    try {
      const result = await tx.execute({ sql: 'INSERT INTO purchase_orders (po_number,supplier_id,branch_id,employee_id,subtotal,total,notes,expected_date) VALUES (?,?,?,?,?,?,?,?)', args: [po_number, supplier_id||null, branch_id||null, employee_id||null, subtotal, subtotal, notes||null, expected_date||null] });
      const poId = Number(result.lastInsertRowid);
      for (const item of processedItems) {
        await tx.execute({ sql: 'INSERT INTO purchase_order_items (po_id,product_id,product_name,sku,quantity_ordered,unit_cost,total) VALUES (?,?,?,?,?,?,?)', args: [poId, item.product_id, item.product_name, item.sku, item.quantity_ordered, item.unit_cost, item.total] });
      }
      await tx.commit();

      const { rows: [po] } = await db.execute({ sql: `SELECT po.*, s.name as supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id WHERE po.id = ?`, args: [poId] });
      const { rows: poItems } = await db.execute({ sql: 'SELECT * FROM purchase_order_items WHERE po_id = ?', args: [poId] });
      po.items = poItems;
      res.status(201).json(po);
    } catch(e) {
      await tx.rollback();
      res.status(400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Update PO status (send, cancel)
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['draft', 'sent', 'approved', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const { rows: [po] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.status === 'received') return res.status(400).json({ error: 'Cannot change status of received PO' });
    await db.execute({ sql: 'UPDATE purchase_orders SET status = ? WHERE id = ?', args: [status, req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Receive PO - updates stock quantities
router.patch('/:id/receive', async (req, res) => {
  try {
    const { items } = req.body;
    const { rows: [po] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.status === 'cancelled') return res.status(400).json({ error: 'Cannot receive cancelled PO' });
    if (po.status === 'received') return res.status(400).json({ error: 'PO already fully received' });

    const tx = await db.transaction('write');
    try {
      for (const { item_id, quantity_received } of (items || [])) {
        const qty = parseInt(quantity_received);
        if (!qty || qty <= 0) continue;
        const { rows: [item] } = await tx.execute({ sql: 'SELECT * FROM purchase_order_items WHERE id = ?', args: [item_id] });
        if (!item) continue;
        const newReceived = (item.quantity_received || 0) + qty;
        await tx.execute({ sql: 'UPDATE purchase_order_items SET quantity_received = ? WHERE id = ?', args: [newReceived, item_id] });
        if (item.product_id) {
          await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [qty, item.product_id] });
          if (item.unit_cost && item.unit_cost > 0) {
            await tx.execute({ sql: 'UPDATE products SET cost = ? WHERE id = ?', args: [item.unit_cost, item.product_id] });
          }
          if (po.branch_id) {
            await tx.execute({ sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at) VALUES (?, ?, ?, (SELECT min_stock FROM products WHERE id = ?), CURRENT_TIMESTAMP) ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP`, args: [item.product_id, po.branch_id, qty, item.product_id, qty] });
          }
        }
      }

      const { rows: poItems } = await tx.execute({ sql: 'SELECT * FROM purchase_order_items WHERE po_id = ?', args: [req.params.id] });
      const allReceived = poItems.every(i => (i.quantity_received || 0) >= i.quantity_ordered);
      const anyReceived = poItems.some(i => (i.quantity_received || 0) > 0);
      const newStatus = allReceived ? 'received' : anyReceived ? 'partial' : po.status;
      await tx.execute({ sql: 'UPDATE purchase_orders SET status = ?, received_at = ? WHERE id = ?', args: [newStatus, allReceived ? new Date().toISOString() : po.received_at, req.params.id] });
      await tx.commit();
    } catch(e) {
      await tx.rollback();
      return res.status(400).json({ error: e.message });
    }

    const { rows: [updated] } = await db.execute({ sql: `SELECT po.*, s.name as supplier_name, b.name as branch_name FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id LEFT JOIN branches b ON po.branch_id = b.id WHERE po.id = ?`, args: [req.params.id] });
    const { rows: updatedItems } = await db.execute({ sql: 'SELECT * FROM purchase_order_items WHERE po_id = ?', args: [req.params.id] });
    updated.items = updatedItems;
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Process items received damaged - reverses stock added by /receive and logs a stock movement
router.patch('/:id/damage', async (req, res) => {
  try {
    const { items } = req.body;
    const { rows: [po] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    if (!po) return res.status(404).json({ error: 'Not found' });

    const tx = await db.transaction('write');
    try {
      for (const { item_id, quantity_damaged, reason } of (items || [])) {
        const qty = parseInt(quantity_damaged);
        if (!qty || qty <= 0) continue;
        const { rows: [item] } = await tx.execute({ sql: 'SELECT * FROM purchase_order_items WHERE id = ? AND po_id = ?', args: [item_id, req.params.id] });
        if (!item) continue;
        const alreadyDamaged = item.quantity_damaged || 0;
        const available = (item.quantity_received || 0) - alreadyDamaged;
        if (qty > available) return res.status(400).json({ error: `Cannot mark ${qty} damaged for ${item.product_name} - only ${available} available to process` });

        const newDamaged = alreadyDamaged + qty;
        const notes = reason ? (item.damage_notes ? `${item.damage_notes}\n${reason}` : reason) : item.damage_notes;
        await tx.execute({ sql: 'UPDATE purchase_order_items SET quantity_damaged = ?, damage_notes = ? WHERE id = ?', args: [newDamaged, notes || null, item_id] });

        if (item.product_id) {
          await tx.execute({ sql: 'UPDATE products SET stock_qty = MAX(0, stock_qty - ?) WHERE id = ?', args: [qty, item.product_id] });
          if (po.branch_id) {
            await tx.execute({ sql: 'UPDATE branch_inventory SET stock_qty = MAX(0, stock_qty - ?), updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND branch_id = ?', args: [qty, item.product_id, po.branch_id] });
          }
          await tx.execute({ sql: 'INSERT INTO stock_movements (product_id, branch_id, quantity_change, type, reference, reason) VALUES (?,?,?,?,?,?)', args: [item.product_id, po.branch_id || null, -qty, 'damaged', po.po_number, reason || 'Received damaged from supplier'] });
        }
      }
      await tx.commit();
    } catch(e) {
      await tx.rollback();
      return res.status(400).json({ error: e.message });
    }

    const { rows: [updated] } = await db.execute({ sql: `SELECT po.*, s.name as supplier_name, b.name as branch_name FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id LEFT JOIN branches b ON po.branch_id = b.id WHERE po.id = ?`, args: [req.params.id] });
    const { rows: updatedItems } = await db.execute({ sql: 'SELECT * FROM purchase_order_items WHERE po_id = ?', args: [req.params.id] });
    updated.items = updatedItems;
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Attachments ──────────────────────────────────────────────

router.get('/:id/attachments', async (req, res) => {
  try {
    const { rows: [po] } = await db.execute({ sql: 'SELECT id FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    if (!po) return res.status(404).json({ error: 'Not found' });
    const { rows } = await db.execute({ sql: 'SELECT * FROM po_attachments WHERE po_id = ? ORDER BY uploaded_at DESC', args: [req.params.id] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/attachments', upload.single('file'), async (req, res) => {
  try {
    const { rows: [po] } = await db.execute({ sql: 'SELECT id FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded or file type not allowed' });
    const { document_type = 'other' } = req.body;
    const allowed_types = ['purchase_request', 'supplier_quotation', 'other'];
    const docType = allowed_types.includes(document_type) ? document_type : 'other';

    const cloudResult = await cloudUpload(req.file.buffer, {
      folder: 'pos-system/po-attachments',
      public_id: `${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      resource_type: 'auto',
    });

    let storedName;
    if (cloudResult) {
      storedName = cloudResult.secure_url;
    } else {
      fs.mkdirSync(localUploadDir, { recursive: true });
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      storedName = `${unique}${path.extname(req.file.originalname)}`;
      fs.writeFileSync(path.join(localUploadDir, storedName), req.file.buffer);
    }

    const result = await db.execute({ sql: 'INSERT INTO po_attachments (po_id, document_type, original_name, stored_name, mime_type, file_size) VALUES (?,?,?,?,?,?)', args: [po.id, docType, req.file.originalname, storedName, req.file.mimetype, req.file.size] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM po_attachments WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/attachments/:aid/download', async (req, res) => {
  try {
    const { rows: [att] } = await db.execute({ sql: 'SELECT * FROM po_attachments WHERE id = ? AND po_id = ?', args: [req.params.aid, req.params.id] });
    if (!att) return res.status(404).json({ error: 'Not found' });
    if (att.stored_name.startsWith('https://')) {
      // Cloud file — redirect with fl_attachment to force browser download
      const downloadUrl = att.stored_name.replace('/upload/', '/upload/fl_attachment/');
      return res.redirect(downloadUrl);
    }
    const filePath = path.join(localUploadDir, att.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on server' });
    res.setHeader('Content-Disposition', `attachment; filename="${att.original_name}"`);
    res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
    res.sendFile(filePath);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/attachments/:aid', async (req, res) => {
  try {
    const { rows: [att] } = await db.execute({ sql: 'SELECT * FROM po_attachments WHERE id = ? AND po_id = ?', args: [req.params.aid, req.params.id] });
    if (!att) return res.status(404).json({ error: 'Not found' });
    if (att.stored_name.startsWith('https://')) {
      await cloudDestroy(att.stored_name, 'raw');
    } else {
      try { if (fs.existsSync(path.join(localUploadDir, att.stored_name))) fs.unlinkSync(path.join(localUploadDir, att.stored_name)); } catch(e) {}
    }
    await db.execute({ sql: 'DELETE FROM po_attachments WHERE id = ?', args: [att.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
