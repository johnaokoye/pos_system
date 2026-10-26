const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission, can } = require('../lib/permissions');
const { resolveApprovalSignature } = require('../lib/signatures');
const { nextNumber } = require('../lib/nextNumber');
const { localTaxRate, defaultTaxOption, priceLine, poTotals, resolvePoCurrency } = require('../lib/poLines');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { cloudUpload, cloudDestroy } = require('../lib/cloudinary');

// Self-contained feature, not used as a cross-section lookup elsewhere —
// module-level gate for all of it, matching the frontend's own section gate.
router.use(requirePermission('purchase_requests'));

const PR_SELECT = `
  SELECT pr.*,
    b.name as branch_name,
    e.first_name || ' ' || e.last_name as employee_name,
    a.first_name || ' ' || a.last_name as approver_name,
    s.name as supplier_name,
    s.is_local as supplier_is_local,
    s.email as supplier_email,
    po.po_number as converted_po_number,
    (SELECT COUNT(*) FROM pr_attachments pa WHERE pa.pr_id = pr.id) as attachment_count
  FROM purchase_requests pr
  LEFT JOIN branches b ON pr.branch_id = b.id
  LEFT JOIN employees e ON pr.employee_id = e.id
  LEFT JOIN employees a ON pr.approved_by = a.id
  LEFT JOIN suppliers s ON pr.supplier_id = s.id
  LEFT JOIN purchase_orders po ON pr.converted_to_po_id = po.id`;

// Department pick-list for the PR form. Declared before /:id so
// "departments" isn't taken for a PR id.
router.get('/departments', async (req, res) => {
  try {
    const { rows } = await db.execute('SELECT id, name FROM pr_departments ORDER BY name COLLATE NOCASE');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Adds a department, or returns the existing one if the name (any case) is
// already listed.
router.post('/departments', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
    if (!name) return res.status(400).json({ error: 'Department name is required' });
    if (name.length > 100) return res.status(400).json({ error: 'Department name is too long' });
    await db.execute({ sql: 'INSERT OR IGNORE INTO pr_departments (name, created_by) VALUES (?, ?)', args: [name, req.employee?.id || null] });
    const { rows } = await db.execute({ sql: 'SELECT id, name FROM pr_departments WHERE name = ?', args: [name] });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/', async (req, res) => {
  try {
    const { status, request_type, branch_id, employee_id, start, end, limit = 100 } = req.query;
    let sql = PR_SELECT + ' WHERE 1=1';
    const params = [];
    if (status) { sql += ' AND pr.status = ?'; params.push(status); }
    if (request_type) { sql += ' AND pr.request_type = ?'; params.push(request_type); }
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
    const { rows: [pr] } = await db.execute({ sql: PR_SELECT + ' WHERE pr.id = ?', args: [req.params.id] });
    if (!pr) return res.status(404).json({ error: 'Not found' });
    const { rows: items } = await db.execute({
      sql: 'SELECT pri.*, p.name as linked_product_name FROM purchase_request_items pri LEFT JOIN products p ON pri.product_id = p.id WHERE pri.pr_id = ?',
      args: [req.params.id]
    });
    pr.items = items;
    res.json(pr);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Shared by create and edit. Items may reference a catalog product
// (`product_id`) or just a free-typed `product_name` — either way a
// `product_url` can be attached for online-sourced items.
// `quotation_item_id` is carried through unchanged when a PR item that
// originated from a quote's "Q" item is re-saved — it's how a product
// created later at receiving time finds its way back to that quote.
// A supplier-priced request (fuel) authorizes a maximum quantity of an
// inventory item with no cost — the supplier's invoice sets the cost on the
// PO — so its lines must be catalog products, keep a $0 cost instead of
// falling back to the product's last cost, and may be part quantities.
const REQUEST_TYPES = ['sale_items', 'internal_use', 'supplier_priced'];

async function processPRItems(items, request_type) {
  const supplierPriced = request_type === 'supplier_priced';
  const processedItems = [];
  for (const item of items) {
    // A Service line (non-physical: a promotional video, design work…) is
    // never an inventory product — it's described in product_name + notes.
    const service = item.item_type === 'service';
    if (service && supplierPriced) throw new Error('Supplier-priced requests can only contain inventory items');
    if (service && !String(item.product_name || '').trim()) throw new Error('Describe each service line');
    const product = item.product_id && !service ? (await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] })).rows[0] : null;
    if (supplierPriced && !product) throw new Error('Supplier-priced requests need every item picked from inventory');
    const unit_cost = supplierPriced ? 0 : parseFloat(item.unit_cost || (product ? product.cost : 0)) || 0;
    const qty = supplierPriced ? Math.round((parseFloat(item.quantity) || 0) * 1000) / 1000 : parseInt(item.quantity || 1);
    if (supplierPriced && qty <= 0) throw new Error('Enter the maximum quantity for each item');
    const item_type = ['sale', 'internal', 'service'].includes(item.item_type) ? item.item_type : (request_type === 'internal_use' ? 'internal' : 'sale');
    processedItems.push({
      product_id: service ? null : (item.product_id || null),
      product_name: service ? String(item.product_name).trim() : (item.product_name || (product ? product.name : 'Unknown')),
      sku: service ? '' : (item.sku || (product ? product.sku : '')),
      quantity: qty,
      unit_cost,
      item_type,
      product_url: item.product_url || null,
      notes: item.notes || null,
      quotation_item_id: item.quotation_item_id || null,
      tax_exempt: item.tax_exempt ? 1 : 0,
      total: parseFloat((unit_cost * qty).toFixed(2))
    });
  }
  return processedItems;
}

router.post('/', async (req, res) => {
  try {
    const { branch_id, employee_id, department, notes, required_date, request_type = 'sale_items',
            supplier_id, currency, is_online_purchase, tax_rate, tax_amount, items } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items in purchase request' });
    if (!REQUEST_TYPES.includes(request_type)) return res.status(400).json({ error: 'Invalid request_type' });

    const pr_number = await nextNumber(db, 'purchase_requests', 'pr_number', 'PR-', 6);
    let processedItems;
    try { processedItems = await processPRItems(items, request_type); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const tx = await db.transaction('write');
    let committed = false;
    try {
      const result = await tx.execute({
        sql: 'INSERT INTO purchase_requests (pr_number, branch_id, employee_id, department, notes, required_date, request_type, supplier_id, currency, is_online_purchase, tax_rate, tax_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        args: [pr_number, branch_id||null, employee_id||null, department||null, notes||null, required_date||null,
               request_type, supplier_id||null, currency||null, is_online_purchase?1:0,
               parseFloat(tax_rate)||0, parseFloat(tax_amount)||0]
      });
      const prId = Number(result.lastInsertRowid);
      for (const item of processedItems) {
        await tx.execute({
          sql: 'INSERT INTO purchase_request_items (pr_id, product_id, product_name, sku, quantity, unit_cost, item_type, product_url, notes, total, quotation_item_id, tax_exempt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          args: [prId, item.product_id, item.product_name, item.sku, item.quantity, item.unit_cost, item.item_type, item.product_url, item.notes, item.total, item.quotation_item_id, item.tax_exempt]
        });
      }
      await tx.commit();
      committed = true;
      const { rows: [pr] } = await db.execute({ sql: PR_SELECT + ' WHERE pr.id = ?', args: [prId] });
      const { rows: prItems } = await db.execute({ sql: 'SELECT * FROM purchase_request_items WHERE pr_id = ?', args: [prId] });
      pr.items = prItems;
      res.status(201).json(pr);
    } catch(e) {
      // Once committed, the PR is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Edit a purchase request (details + items, including product URLs for
// online-sourced items) — only while it's still a draft. Once submitted,
// approval/rejection history and downstream PO conversion depend on the
// request being stable.
router.put('/:id', async (req, res) => {
  try {
    const { rows: [pr] } = await db.execute({ sql: 'SELECT * FROM purchase_requests WHERE id = ?', args: [req.params.id] });
    if (!pr) return res.status(404).json({ error: 'Not found' });
    if (pr.status !== 'draft') return res.status(400).json({ error: 'Only draft purchase requests can be edited' });

    const { branch_id, employee_id, department, notes, required_date, request_type = pr.request_type,
            supplier_id, currency, is_online_purchase, tax_rate, tax_amount, items } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items in purchase request' });
    if (!REQUEST_TYPES.includes(request_type)) return res.status(400).json({ error: 'Invalid request_type' });

    let processedItems;
    try { processedItems = await processPRItems(items, request_type); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const tx = await db.transaction('write');
    let committed = false;
    try {
      await tx.execute({
        sql: 'UPDATE purchase_requests SET branch_id=?, employee_id=?, department=?, notes=?, required_date=?, request_type=?, supplier_id=?, currency=?, is_online_purchase=?, tax_rate=?, tax_amount=? WHERE id=?',
        args: [branch_id||null, employee_id||pr.employee_id||null, department||null, notes||null, required_date||null,
               request_type, supplier_id||null, currency||null, is_online_purchase?1:0,
               parseFloat(tax_rate)||0, parseFloat(tax_amount)||0, pr.id]
      });
      await tx.execute({ sql: 'DELETE FROM purchase_request_items WHERE pr_id = ?', args: [pr.id] });
      for (const item of processedItems) {
        await tx.execute({
          sql: 'INSERT INTO purchase_request_items (pr_id, product_id, product_name, sku, quantity, unit_cost, item_type, product_url, notes, total, quotation_item_id, tax_exempt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          args: [pr.id, item.product_id, item.product_name, item.sku, item.quantity, item.unit_cost, item.item_type, item.product_url, item.notes, item.total, item.quotation_item_id, item.tax_exempt]
        });
      }
      await tx.commit();
      committed = true;
      const { rows: [updated] } = await db.execute({ sql: PR_SELECT + ' WHERE pr.id = ?', args: [pr.id] });
      const { rows: prItems } = await db.execute({ sql: 'SELECT * FROM purchase_request_items WHERE pr_id = ?', args: [pr.id] });
      updated.items = prItems;
      res.json(updated);
    } catch(e) {
      // Once committed, the edit is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id/status', async (req, res) => {
  try {
    const { status, rejection_reason, signature } = req.body;
    const valid = ['draft', 'submitted', 'approved', 'rejected'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    // Approving/rejecting is pr_approve's call — the router-level gate only
    // checks the Purchase Requests module.
    if ((status === 'approved' || status === 'rejected') && !req.apiKey && !can(req.employee?.permissions, 'pr_approve')) {
      return res.status(403).json({ error: 'Missing permission: pr_approve' });
    }
    const { rows: [pr] } = await db.execute({ sql: 'SELECT * FROM purchase_requests WHERE id = ?', args: [req.params.id] });
    if (!pr) return res.status(404).json({ error: 'Not found' });
    if (pr.status === 'converted') return res.status(400).json({ error: 'Cannot change status of a converted PR' });

    if (status === 'approved') {
      // Signed with the approver's saved signature (or a newly drawn one).
      const approverId = req.employee?.id || req.body.approved_by || null;
      let sigUrl;
      try { sigUrl = await resolveApprovalSignature(db, approverId, signature); }
      catch (e) { return res.status(e.status || 500).json({ error: e.message, code: e.code }); }
      await db.execute({
        sql: 'UPDATE purchase_requests SET status = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP, approval_signature = ? WHERE id = ?',
        args: [status, approverId, sigUrl, req.params.id]
      });
    } else if (status === 'rejected') {
      await db.execute({
        sql: 'UPDATE purchase_requests SET status = ?, rejection_reason = ? WHERE id = ?',
        args: [status, rejection_reason || null, req.params.id]
      });
    } else {
      await db.execute({ sql: 'UPDATE purchase_requests SET status = ? WHERE id = ?', args: [status, req.params.id] });
    }

    const { rows: [row] } = await db.execute({ sql: PR_SELECT + ' WHERE pr.id = ?', args: [req.params.id] });
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
    // Lines keep the PR's tax decision (it charges local tax when it's in the
    // local currency); an older PR with no currency falls back to the
    // vendor's default (GCT for a Local supplier); an online purchase or a
    // line marked tax exempt gets no tax. Editable on the draft PO.
    const { rows: [supplier] } = (supplier_id || pr.supplier_id) ? await db.execute({ sql: 'SELECT is_local FROM suppliers WHERE id = ?', args: [supplier_id || pr.supplier_id] }) : { rows: [] };
    const taxRate = await localTaxRate();
    const prTaxOption = pr.is_online_purchase ? 'none' : Number(pr.tax_rate) > 0 ? 'local' : (pr.currency ? 'none' : defaultTaxOption(supplier));
    const priced = prItems.map(item => ({ ...priceLine({ name: item.product_name, quantity: item.quantity, unit_cost: item.unit_cost, tax_option: item.tax_exempt ? 'none' : prTaxOption }, taxRate), total: item.total || 0 }));
    for (const line of priced) line.tax_amount = parseFloat((line.total * line.tax_rate / 100).toFixed(2));
    const totals = poTotals(priced);
    // Fuel-style request: the PO starts at the authorized quantities with no
    // cost; the supplier's invoice fills them in (see purchase-orders.js).
    const supplierPriced = pr.request_type === 'supplier_priced';
    // The PO is in the request's currency, at Settings' exchange rate (editable on the draft PO)
    const cur = await resolvePoCurrency(pr.currency, req.body.exchange_rate);

    const tx = await db.transaction('write');
    let committed = false;
    try {
      const po_number = await nextNumber(tx, 'purchase_orders', 'po_number', 'PO-', 6);
      const poResult = await tx.execute({
        sql: 'INSERT INTO purchase_orders (po_number, supplier_id, branch_id, employee_id, subtotal, tax_amount, total, notes, expected_date, supplier_priced, currency, exchange_rate) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        args: [po_number, supplier_id || null, pr.branch_id, pr.employee_id, totals.subtotal, totals.tax_amount, totals.total, poNotes || pr.notes, expected_date || pr.required_date || null, supplierPriced ? 1 : 0, cur.currency, cur.exchange_rate]
      });
      const poId = Number(poResult.lastInsertRowid);

      for (const [n, item] of prItems.entries()) {
        const line = priced[n];
        // Internal-use and service items are added to PO but without a product link (won't update stock on receive)
        const productId = item.item_type === 'internal' || item.item_type === 'service' ? null : item.product_id;
        await tx.execute({
          sql: 'INSERT INTO purchase_order_items (po_id, product_id, product_name, sku, quantity_ordered, unit_cost, total, quotation_item_id, work_order_item_id, discount_amount, tax_option, tax_rate, tax_amount, authorized_qty, item_type, notes, product_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          args: [poId, productId, item.product_name, item.sku, item.quantity, item.unit_cost, item.total, item.quotation_item_id, item.work_order_item_id, item.discount_amount || 0, line.tax_option, line.tax_rate, line.tax_amount, supplierPriced ? item.quantity : null, item.item_type === 'service' ? 'service' : null, item.notes || null, item.product_url || null]
        });
      }

      await tx.execute({ sql: 'UPDATE purchase_requests SET status = ?, converted_to_po_id = ? WHERE id = ?', args: ['converted', poId, pr.id] });
      await tx.commit();
      committed = true;

      const { rows: [po] } = await db.execute({ sql: `SELECT po.*, s.name as supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id WHERE po.id = ?`, args: [poId] });
      const { rows: poItemsResult } = await db.execute({ sql: 'SELECT * FROM purchase_order_items WHERE po_id = ?', args: [poId] });
      po.items = poItemsResult;
      res.status(201).json(po);
    } catch(e) {
      // Once committed, the PO is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Attachments ────────────────────────────────────────────────────────────
// Supporting documents on a request (supplier quotes, a brief/spec…). Mirrors
// the quotation attachment routes. Files are never served statically
// (server.js blocks /uploads/pr-attachments) — only through /download here.
// Anyone with the module can add one at any stage; removing is only allowed
// before approval, so what the approver signed off on stays on the record.
const localUploadDir = path.join(__dirname, '../uploads/pr-attachments');
const PR_DOC_TYPES = ['supplier_quotation', 'specification', 'other'];
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
const ATTACHMENT_SELECT = `SELECT pa.*, e.first_name || ' ' || e.last_name as uploaded_by_name FROM pr_attachments pa LEFT JOIN employees e ON pa.uploaded_by = e.id`;

router.get('/:id/attachments', async (req, res) => {
  try {
    const { rows: [pr] } = await db.execute({ sql: 'SELECT id FROM purchase_requests WHERE id = ?', args: [req.params.id] });
    if (!pr) return res.status(404).json({ error: 'Not found' });
    const { rows } = await db.execute({ sql: `${ATTACHMENT_SELECT} WHERE pa.pr_id = ? ORDER BY pa.uploaded_at DESC, pa.id DESC`, args: [pr.id] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/attachments', (req, res, next) => {
  // Surface multer's size-limit error as a 400 instead of Express's HTML 500.
  upload.single('file')(req, res, err => err ? res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 20 MB' : err.message }) : next());
}, async (req, res) => {
  try {
    const { rows: [pr] } = await db.execute({ sql: 'SELECT id FROM purchase_requests WHERE id = ?', args: [req.params.id] });
    if (!pr) return res.status(404).json({ error: 'Not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded or file type not allowed' });
    const docType = PR_DOC_TYPES.includes(req.body.document_type) ? req.body.document_type : 'other';

    const cloudResult = await cloudUpload(req.file.buffer, {
      folder: 'pos-system/pr-attachments',
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

    const result = await db.execute({ sql: 'INSERT INTO pr_attachments (pr_id, document_type, original_name, stored_name, mime_type, file_size, uploaded_by) VALUES (?,?,?,?,?,?,?)', args: [pr.id, docType, req.file.originalname, storedName, req.file.mimetype, req.file.size, (req.employee && req.employee.id) || null] });
    const { rows: [row] } = await db.execute({ sql: `${ATTACHMENT_SELECT} WHERE pa.id = ?`, args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/attachments/:aid/download', async (req, res) => {
  try {
    const { rows: [att] } = await db.execute({ sql: 'SELECT * FROM pr_attachments WHERE id = ? AND pr_id = ?', args: [req.params.aid, req.params.id] });
    if (!att) return res.status(404).json({ error: 'Not found' });
    if (att.stored_name.startsWith('https://')) {
      // Cloud file — redirect with fl_attachment to force browser download
      return res.redirect(att.stored_name.replace('/upload/', '/upload/fl_attachment/'));
    }
    const filePath = path.join(localUploadDir, att.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on server' });
    res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
    res.attachment(att.original_name);
    res.sendFile(filePath);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/attachments/:aid', async (req, res) => {
  try {
    const { rows: [att] } = await db.execute({ sql: 'SELECT pa.*, pr.status as pr_status FROM pr_attachments pa JOIN purchase_requests pr ON pa.pr_id = pr.id WHERE pa.id = ? AND pa.pr_id = ?', args: [req.params.aid, req.params.id] });
    if (!att) return res.status(404).json({ error: 'Not found' });
    if (!['draft', 'submitted', 'rejected'].includes(att.pr_status)) return res.status(400).json({ error: 'Documents on an approved request stay on the record and can\'t be removed' });
    if (att.stored_name.startsWith('https://')) {
      // resource_type 'auto' files PDFs/images under image/, Office docs under
      // raw/ — read it back from the URL rather than guessing from the mime.
      const resourceType = (att.stored_name.match(/\/(image|raw|video)\/upload\//) || [])[1] || 'raw';
      await cloudDestroy(att.stored_name, resourceType);
    } else {
      try { if (fs.existsSync(path.join(localUploadDir, att.stored_name))) fs.unlinkSync(path.join(localUploadDir, att.stored_name)); } catch(e) {}
    }
    await db.execute({ sql: 'DELETE FROM pr_attachments WHERE id = ?', args: [att.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
