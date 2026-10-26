const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { resolvePurchaseUnit, lineName, stockUnits } = require('../lib/units');
const { syncBinQty } = require('../lib/binSync');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { cloudUpload, cloudDestroy } = require('../lib/cloudinary');
const { requirePermission } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');
const { autoBills, createBill, dueDateFor, today } = require('../lib/payables');
const { resolveApprovalSignature } = require('../lib/signatures');
const { getSetting } = require('../lib/settings');
const { localTaxRate, defaultTaxOption, priceLine, poTotals, receivedValue } = require('../lib/poLines');
const { allocateTicketDiscount } = require('../lib/ticketDiscount');

// Items joined with the quotation/work order they trace back to (a PR's "Q"
// line converted into this PO) — lets the PO detail view click straight
// through to the document that drove the purchase, alongside the PR itself
// (see the source_pr_* subqueries below).
const PO_ITEMS_SELECT = `SELECT poi.*, q.quote_number, q.id as quotation_id, wo.wo_number, wo.id as work_order_id
  FROM purchase_order_items poi
  LEFT JOIN quotation_items qi ON poi.quotation_item_id = qi.id
  LEFT JOIN quotations q ON qi.quote_id = q.id
  LEFT JOIN work_order_items woi ON poi.work_order_item_id = woi.id
  LEFT JOIN work_orders wo ON woi.work_order_id = wo.id
  WHERE poi.po_id = ?`;

const PO_DETAIL_SELECT = `SELECT po.*, s.name as supplier_name, s.contact_name as supplier_contact, s.email as supplier_email,
  b.name as branch_name, e.first_name || ' ' || e.last_name as employee_name,
  ea.first_name || ' ' || ea.last_name as approved_by_name,
  er.first_name || ' ' || er.last_name as rejected_by_name,
  (SELECT id FROM purchase_requests WHERE converted_to_po_id = po.id LIMIT 1) as source_pr_id,
  (SELECT pr_number FROM purchase_requests WHERE converted_to_po_id = po.id LIMIT 1) as source_pr_number
  FROM purchase_orders po
  LEFT JOIN suppliers s ON po.supplier_id = s.id
  LEFT JOIN branches b ON po.branch_id = b.id
  LEFT JOIN employees e ON po.employee_id = e.id
  LEFT JOIN employees ea ON po.approved_by = ea.id
  LEFT JOIN employees er ON po.rejected_by = er.id
  WHERE po.id = ?`;

router.use(requirePermission('purchasing'));

// A PO converted from a supplier-priced request (fuel) goes for approval only
// once the supplier's invoice is in: every line costed and the invoice
// attached. Quantities over the authorized maximum are only warned about
// (in the UI), not blocked.
async function supplierPricedProblems(poId) {
  const problems = [];
  const { rows: [{ uncosted }] } = await db.execute({ sql: 'SELECT COUNT(*) as uncosted FROM purchase_order_items WHERE po_id = ? AND (unit_cost IS NULL OR unit_cost <= 0)', args: [poId] });
  if (Number(uncosted)) problems.push('enter the invoiced cost on every line');
  const { rows: [{ invoices }] } = await db.execute({ sql: "SELECT COUNT(*) as invoices FROM po_attachments WHERE po_id = ? AND document_type = 'supplier_invoice'", args: [poId] });
  if (!Number(invoices)) problems.push("attach the supplier's invoice (document type Supplier Invoice)");
  return problems;
}
const supplierPricedError = (problems, action) => `Before this fuel/supplier-priced PO can be ${action}: ${problems.join(' and ')}`;

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
    const { rows: [po] } = await db.execute({ sql: PO_DETAIL_SELECT, args: [req.params.id] });
    if (!po) return res.status(404).json({ error: 'Not found' });
    const { rows: items } = await db.execute({ sql: PO_ITEMS_SELECT, args: [req.params.id] });
    po.items = items;
    res.json(po);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { supplier_id, branch_id, employee_id, items, notes, expected_date, vendor_order_number } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items in PO' });

    const { rows: [supplier] } = supplier_id ? await db.execute({ sql: 'SELECT is_local FROM suppliers WHERE id = ?', args: [supplier_id] }) : { rows: [] };
    const taxRate = await localTaxRate();
    const processedItems = [];
    try {
      for (const item of items) {
        const product = item.product_id ? (await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] })).rows[0] : null;
        // Ordered in a unit of measure (lib/units.js): quantity and cost are per that unit.
        const unit = await resolvePurchaseUnit(db, product, item.uom_id ?? item.purchase_unit);
        const product_name = item.product_name || (product ? lineName(product.name, unit) : 'Unknown');
        const priced = priceLine({
          name: product_name, quantity: item.quantity_ordered || item.quantity || 1,
          unit_cost: item.unit_cost || (product ? (product.cost || 0) * unit.units_per : 0),
          vendor_discount: item.vendor_discount, vendor_discount_percent: item.vendor_discount_percent, tax_option: item.tax_option || defaultTaxOption(supplier),
        }, taxRate);
        processedItems.push({ product_id: item.product_id || null, product_name, sku: item.sku || (product ? product.sku : ''), ...priced, purchase_unit: unit.purchase_unit, units_per: unit.units_per, uom_id: unit.uom_id ?? null });
      }
    } catch(e) { return res.status(400).json({ error: e.message }); }
    const { subtotal, tax_amount, total } = poTotals(processedItems);
    const po_number = await nextNumber(db, 'purchase_orders', 'po_number', 'PO-', 6);

    const tx = await db.transaction('write');
    let committed = false;
    try {
      const result = await tx.execute({ sql: 'INSERT INTO purchase_orders (po_number,supplier_id,branch_id,employee_id,subtotal,tax_amount,total,notes,expected_date,vendor_order_number) VALUES (?,?,?,?,?,?,?,?,?,?)', args: [po_number, supplier_id||null, branch_id||null, employee_id||null, subtotal, tax_amount, total, notes||null, expected_date||null, vendor_order_number||null] });
      const poId = Number(result.lastInsertRowid);
      for (const item of processedItems) {
        await tx.execute({ sql: 'INSERT INTO purchase_order_items (po_id,product_id,product_name,sku,quantity_ordered,unit_cost,total,vendor_discount,vendor_discount_percent,tax_option,tax_rate,tax_amount,purchase_unit,units_per,uom_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', args: [poId, item.product_id, item.product_name, item.sku, item.quantity_ordered, item.unit_cost, item.total, item.vendor_discount, item.vendor_discount_percent, item.tax_option, item.tax_rate, item.tax_amount, item.purchase_unit || null, item.units_per || 1, item.uom_id ?? null] });
      }
      await tx.commit();
      committed = true;

      const { rows: [po] } = await db.execute({ sql: `SELECT po.*, s.name as supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id WHERE po.id = ?`, args: [poId] });
      const { rows: poItems } = await db.execute({ sql: 'SELECT * FROM purchase_order_items WHERE po_id = ?', args: [poId] });
      po.items = poItems;
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

// Update PO status (send, cancel) — approving and rejecting now go through
// their own dedicated endpoints below (a captured signature or a required
// reason isn't a fit for this generic transition).
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['sent', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const { rows: [po] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.status === 'received') return res.status(400).json({ error: 'Cannot change status of received PO' });
    if (status === 'sent' && po.supplier_priced) {
      const problems = await supplierPricedProblems(po.id);
      if (problems.length) return res.status(400).json({ error: supplierPricedError(problems, 'sent for approval') });
    }
    if (status === 'sent') {
      // Re-sending after a rejection is the "resubmitted" step — clear the
      // old rejection so its banner doesn't linger on the PO the requester
      // just fixed and sent back for another look.
      await db.execute({ sql: 'UPDATE purchase_orders SET status = ?, rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL WHERE id = ?', args: [status, req.params.id] });
    } else {
      await db.execute({ sql: 'UPDATE purchase_orders SET status = ? WHERE id = ?', args: [status, req.params.id] });
    }
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Approve a submitted PO — requires purchasing_approve (on top of the
// router-level `purchasing` gate above) and the approver's signature (their
// saved one, or `signature` newly drawn — lib/signatures.js), so approval
// always carries who signed off. Only a 'sent' (formally submitted) PO can be
// approved; a draft has to be sent first.
router.patch('/:id/approve', requirePermission('purchasing_approve'), async (req, res) => {
  try {
    const { signature } = req.body;
    const approverId = (req.employee && req.employee.id) || req.body.employee_id || null;
    const { rows: [po] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.status !== 'sent') return res.status(400).json({ error: `This PO is ${po.status}, not awaiting approval` });
    if (po.supplier_priced) {
      const problems = await supplierPricedProblems(po.id);
      if (problems.length) return res.status(400).json({ error: supplierPricedError(problems, 'approved') });
    }

    let sigUrl;
    try { sigUrl = await resolveApprovalSignature(db, approverId, signature); }
    catch (e) { return res.status(e.status || 500).json({ error: e.message, code: e.code }); }
    await db.execute({
      sql: `UPDATE purchase_orders SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP, approval_signature = ?,
            rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL WHERE id = ?`,
      args: [approverId, sigUrl, req.params.id],
    });
    const { rows: [updated] } = await db.execute({ sql: PO_DETAIL_SELECT, args: [req.params.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Reject a submitted PO back to draft with a required reason — the same
// permission as approving, since it's the other half of the same decision.
router.patch('/:id/reject', requirePermission('purchasing_approve'), async (req, res) => {
  try {
    const { reason, employee_id } = req.body;
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'A rejection reason is required' });
    const { rows: [po] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.status !== 'sent') return res.status(400).json({ error: `This PO is ${po.status}, not awaiting approval` });

    await db.execute({
      sql: `UPDATE purchase_orders SET status = 'draft', rejected_by = ?, rejected_at = CURRENT_TIMESTAMP, rejection_reason = ? WHERE id = ?`,
      args: [employee_id || (req.employee && req.employee.id) || null, reason.trim(), req.params.id],
    });
    const { rows: [updated] } = await db.execute({ sql: PO_DETAIL_SELECT, args: [req.params.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Edit a draft PO's items/details — only reachable pre-submission (or after
// a rejection sends it back here). Existing lines are updated in place by
// id (preserving any quotation_item_id/work_order_item_id link back to the
// quote/work order that requested them); lines with no id are new catalog
// additions; anything not resent is removed.
router.put('/:id', async (req, res) => {
  try {
    const { rows: [po] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.status !== 'draft') return res.status(400).json({ error: 'Only a draft PO can be edited' });

    const { supplier_id, branch_id, notes, expected_date, vendor_order_number, items } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'A PO needs at least one item' });

    const { rows: existingItems } = await db.execute({ sql: 'SELECT * FROM purchase_order_items WHERE po_id = ?', args: [req.params.id] });
    const existingById = new Map(existingItems.map(i => [i.id, i]));
    const { rows: [supplier] } = await db.execute({ sql: 'SELECT is_local FROM suppliers WHERE id = ?', args: [supplier_id || po.supplier_id] });
    const taxRate = await localTaxRate();

    const tx = await db.transaction('write');
    let committed = false;
    try {
      const keepIds = new Set();
      const priced = [];
      for (const item of items) {
        const existingId = item.id ? parseInt(item.id) : null;
        const existing = existingId ? existingById.get(existingId) : null;
        let product = null;
        if (!existing) {
          if (!item.product_id) throw new Error('New items must reference a catalog product');
          ({ rows: [product] } = await tx.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] }));
          if (!product) throw new Error('Product not found');
        }
        // A line saved before tax options existed (or sent without one) keeps
        // its own option; brand-new lines default to the vendor's.
        const line = priceLine({
          name: existing ? existing.product_name : product.name, quantity: item.quantity_ordered, unit_cost: item.unit_cost,
          vendor_discount: item.vendor_discount, vendor_discount_percent: item.vendor_discount_percent, tax_option: item.tax_option || (existing ? existing.tax_option : defaultTaxOption(supplier)),
        }, taxRate);
        priced.push(line);
        if (existing) {
          await tx.execute({ sql: 'UPDATE purchase_order_items SET quantity_ordered = ?, unit_cost = ?, total = ?, vendor_discount = ?, vendor_discount_percent = ?, tax_option = ?, tax_rate = ?, tax_amount = ? WHERE id = ?', args: [line.quantity_ordered, line.unit_cost, line.total, line.vendor_discount, line.vendor_discount_percent, line.tax_option, line.tax_rate, line.tax_amount, existingId] });
          keepIds.add(existingId);
        } else {
          const unit = await resolvePurchaseUnit(tx, product, item.uom_id ?? item.purchase_unit);
          const result = await tx.execute({ sql: 'INSERT INTO purchase_order_items (po_id,product_id,product_name,sku,quantity_ordered,unit_cost,total,vendor_discount,vendor_discount_percent,tax_option,tax_rate,tax_amount,purchase_unit,units_per,uom_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', args: [req.params.id, product.id, lineName(product.name, unit), product.sku, line.quantity_ordered, line.unit_cost, line.total, line.vendor_discount, line.vendor_discount_percent, line.tax_option, line.tax_rate, line.tax_amount, unit.purchase_unit, unit.units_per, unit.uom_id ?? null] });
          keepIds.add(Number(result.lastInsertRowid));
        }
      }
      for (const existing of existingItems) {
        if (!keepIds.has(existing.id)) await tx.execute({ sql: 'DELETE FROM purchase_order_items WHERE id = ?', args: [existing.id] });
      }
      const { subtotal, tax_amount, total } = poTotals(priced);
      await tx.execute({
        sql: 'UPDATE purchase_orders SET supplier_id = ?, branch_id = ?, notes = ?, expected_date = ?, vendor_order_number = ?, subtotal = ?, tax_amount = ?, total = ? WHERE id = ?',
        args: [supplier_id || po.supplier_id, branch_id || null, notes ?? po.notes, expected_date || null, vendor_order_number || null, subtotal, tax_amount, total, req.params.id],
      });
      await tx.commit();
      committed = true;
    } catch(e) {
      if (!committed) await tx.rollback();
      return res.status(committed ? 500 : 400).json({ error: e.message });
    }

    const { rows: [updated] } = await db.execute({ sql: PO_DETAIL_SELECT, args: [req.params.id] });
    const { rows: updatedItems } = await db.execute({ sql: PO_ITEMS_SELECT, args: [req.params.id] });
    updated.items = updatedItems;
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Freight forwarding tracking — the vendor's own order/quote number (e.g. an
// Amazon order #) plus the freight forwarder's receipt/forwarding status for
// POs that ship through a forwarder before reaching a branch. Orthogonal to
// the PO's own status/receiving workflow above.
router.patch('/:id/freight', async (req, res) => {
  try {
    const { rows: [po] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    if (!po) return res.status(404).json({ error: 'Not found' });

    const { vendor_order_number, freight_status, freight_tracking_number, freight_notes } = req.body;
    if (freight_status !== undefined && !['pending', 'received_by_forwarder', 'forwarded'].includes(freight_status)) {
      return res.status(400).json({ error: 'Invalid freight status' });
    }

    const fields = [];
    const args = [];
    if (vendor_order_number !== undefined) { fields.push('vendor_order_number = ?'); args.push(vendor_order_number || null); }
    if (freight_tracking_number !== undefined) { fields.push('freight_tracking_number = ?'); args.push(freight_tracking_number || null); }
    if (freight_notes !== undefined) { fields.push('freight_notes = ?'); args.push(freight_notes || null); }
    if (freight_status !== undefined) {
      fields.push('freight_status = ?'); args.push(freight_status);
      if (freight_status === 'received_by_forwarder' && !po.freight_forwarder_received_at) {
        fields.push('freight_forwarder_received_at = ?'); args.push(new Date().toISOString());
      }
      if (freight_status === 'forwarded' && !po.freight_forwarded_at) {
        fields.push('freight_forwarded_at = ?'); args.push(new Date().toISOString());
      }
    }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    args.push(req.params.id);
    await db.execute({ sql: `UPDATE purchase_orders SET ${fields.join(', ')} WHERE id = ?`, args });

    const { rows: [updated] } = await db.execute({ sql: `SELECT po.*, s.name as supplier_name, b.name as branch_name FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id LEFT JOIN branches b ON po.branch_id = b.id WHERE po.id = ?`, args: [req.params.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Receive PO - updates stock quantities
router.patch('/:id/receive', requirePermission('purchasing_receive'), async (req, res) => {
  try {
    const { items } = req.body;
    const { rows: [po] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.status === 'cancelled') return res.status(400).json({ error: 'Cannot receive cancelled PO' });
    if (po.status === 'received') return res.status(400).json({ error: 'PO already fully received' });
    if (po.supplier_priced && !['approved', 'partial'].includes(po.status)) return res.status(400).json({ error: 'A fuel/supplier-priced PO is received only after it is approved with the invoiced cost' });

    const tx = await db.transaction('write');
    try {
      let receiptValue = 0, receiptTax = 0;
      for (const { item_id, quantity_received } of (items || [])) {
        const qty = Math.round((Number(quantity_received) || 0) * 1000) / 1000; // part quantities for measured units
        if (!qty || qty <= 0) continue;
        const { rows: [item] } = await tx.execute({ sql: 'SELECT * FROM purchase_order_items WHERE id = ?', args: [item_id] });
        if (!item) continue;
        const value = receivedValue(item, qty);
        receiptValue += value.goods;
        receiptTax += value.tax;
        // Stock is costed at what was actually paid per unit — after the vendor's discount, before tax.
        const netUnitCost = item.quantity_ordered ? (Number(item.total) || 0) / item.quantity_ordered : (Number(item.unit_cost) || 0);
        const newReceived = (item.quantity_received || 0) + qty;
        await tx.execute({ sql: 'UPDATE purchase_order_items SET quantity_received = ? WHERE id = ?', args: [newReceived, item_id] });
        if (item.product_id) {
          // A line in another unit (lib/units.js) receives quantity × its size
          // in stock units; stock and cost are per stock unit.
          const per = Number(item.units_per) || 1;
          const singles = stockUnits(qty, per);
          await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [singles, item.product_id] });
          if (netUnitCost > 0) {
            await tx.execute({ sql: 'UPDATE products SET cost = ? WHERE id = ?', args: [parseFloat((netUnitCost / per).toFixed(4)), item.product_id] });
          }
          if (po.branch_id) {
            await tx.execute({ sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at) VALUES (?, ?, ?, (SELECT min_stock FROM products WHERE id = ?), CURRENT_TIMESTAMP) ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP`, args: [item.product_id, po.branch_id, singles, item.product_id, singles] });
            await syncBinQty(tx, item.product_id, po.branch_id, singles);
          }
        }
      }

      const { rows: poItems } = await tx.execute({ sql: 'SELECT * FROM purchase_order_items WHERE po_id = ?', args: [req.params.id] });
      const allReceived = poItems.every(i => (i.quantity_received || 0) >= i.quantity_ordered);
      const anyReceived = poItems.some(i => (i.quantity_received || 0) > 0);
      const newStatus = allReceived ? 'received' : anyReceived ? 'partial' : po.status;
      await tx.execute({ sql: 'UPDATE purchase_orders SET status = ?, received_at = ? WHERE id = ?', args: [newStatus, allReceived ? new Date().toISOString() : po.received_at, req.params.id] });
      // A PR that was converted to this PO is otherwise stuck at status='converted'
      // forever — nothing else advances it, which left dependents (e.g. a work
      // order's part-sourcing badge) reading a stale "pending" even once the
      // goods actually landed. Mirror the PO's fully-received state back onto it.
      if (allReceived) {
        await tx.execute({ sql: `UPDATE purchase_requests SET status = 'received' WHERE converted_to_po_id = ? AND status != 'received'`, args: [req.params.id] });
      }
      // Each receipt becomes an A/P bill for what was just received (after
      // vendor discounts, plus each line's tax in proportion), due per the vendor's terms — unless the
      // vendor has Sync with A/P off or is set to "Not vouchered", in which
      // case the bill is entered by hand from the PO later.
      const { rows: [supplier] } = po.supplier_id
        ? await tx.execute({ sql: 'SELECT payment_terms, sync_ap, voucher_default FROM suppliers WHERE id = ?', args: [po.supplier_id] })
        : { rows: [] };
      if (receiptValue > 0 && autoBills(supplier)) {
        const tax = receiptTax;
        const billDate = today();
        await createBill(tx, {
          supplier_id: po.supplier_id, po_id: po.id, branch_id: po.branch_id,
          bill_date: billDate, due_date: dueDateFor(supplier.payment_terms, billDate),
          amount: receiptValue + tax, description: `Goods received on ${po.po_number}`,
          source: 'receipt', created_by: req.employee?.id,
        });
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

// Link a received PO line item to a product — either an existing one or a
// brand-new one created on the spot. PO items with no product_id (typically
// a "Q" custom item quoted/requested before it existed in the catalog) get
// skipped entirely by /receive's stock update, so this is how their received
// quantity actually lands in inventory. If the item traces back to a
// quotation's or work order's "Q" line (quotation_item_id /
// work_order_item_id), that quote/WO item is flipped over to the new
// product too, closing the loop back to where it started.
router.post('/:id/items/:itemId/link-product', async (req, res) => {
  try {
    const { rows: [po] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    if (!po) return res.status(404).json({ error: 'PO not found' });
    const { rows: [item] } = await db.execute({ sql: 'SELECT * FROM purchase_order_items WHERE id = ? AND po_id = ?', args: [req.params.itemId, req.params.id] });
    if (!item) return res.status(404).json({ error: 'PO item not found' });
    if (item.product_id) return res.status(400).json({ error: 'Item is already linked to a product' });
    if (item.item_type === 'service') return res.status(400).json({ error: 'A service line is not an inventory item' });

    const { product_id, sku, name, category_id, price, cost, tax_rate } = req.body;
    const defaultTaxRate = tax_rate ?? (parseFloat(await getSetting('tax_rate', 8.5)) || 8.5);

    const tx = await db.transaction('write');
    let committed = false;
    try {
      let productId;
      if (product_id) {
        const { rows: [existing] } = await tx.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [product_id] });
        if (!existing) throw new Error('Product not found');
        productId = existing.id;
      } else {
        if (!sku || !name) throw new Error('SKU and name are required to create a new product');
        const qty = item.quantity_received || 0;
        // Items that trace back to a quotation's or work order's "Q" line
        // were purchased to fulfill that one job — tag the new product
        // non-inventory so it stays out of the normal Inventory list until
        // someone explicitly orders more for general stock (see PATCH
        // /:id/promote-to-inventory).
        const nonInventory = (item.quotation_item_id || item.work_order_item_id) ? 1 : 0;
        const result = await tx.execute({
          sql: 'INSERT INTO products (sku,barcode,name,category_id,price,cost,tax_rate,stock_qty,min_stock,active,supplier_id,is_non_inventory) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          args: [sku, null, name, category_id||null, parseFloat(price)||0, parseFloat(cost)||item.unit_cost||0, defaultTaxRate, qty, 5, 1, po.supplier_id||null, nonInventory]
        });
        productId = Number(result.lastInsertRowid);
      }

      const { rows: [linkedProduct] } = await tx.execute({ sql: 'SELECT sku FROM products WHERE id = ?', args: [productId] });
      await tx.execute({ sql: 'UPDATE purchase_order_items SET product_id = ?, sku = ? WHERE id = ?', args: [productId, linkedProduct.sku, item.id] });

      const qty = item.quantity_received || 0;
      if (qty > 0) {
        // New products already start with stock_qty = qty; existing ones need it added.
        if (product_id) await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [qty, productId] });
        if (po.branch_id) {
          await tx.execute({ sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at) VALUES (?, ?, ?, (SELECT min_stock FROM products WHERE id = ?), CURRENT_TIMESTAMP) ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP`, args: [productId, po.branch_id, qty, productId, qty] });
          await syncBinQty(tx, productId, po.branch_id, qty);
        }
      }

      let quotationUpdated = false;
      if (item.quotation_item_id) {
        const { rows: [qItem] } = await tx.execute({ sql: 'SELECT * FROM quotation_items WHERE id = ?', args: [item.quotation_item_id] });
        if (qItem) {
          const { rows: [product] } = await tx.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [productId] });
          await tx.execute({ sql: 'UPDATE quotation_items SET product_id=?, sku=?, is_temp_item=0 WHERE id=?', args: [productId, product.sku, qItem.id] });

          const { rows: [quote] } = await tx.execute({ sql: 'SELECT * FROM quotations WHERE id = ?', args: [qItem.quote_id] });
          // Once a quote is converted to an invoice its financials are frozen —
          // still re-point the item at the real product above, just don't reprice it.
          if (quote && quote.status !== 'converted') {
            // Taxed on the line less its share of the quote's Discount, which
            // comes off before tax (lib/ticketDiscount.js).
            const { rows: quoteLines } = await tx.execute({ sql: 'SELECT id, total FROM quotation_items WHERE quote_id = ? ORDER BY id', args: [quote.id] });
            const { shares } = allocateTicketDiscount(quoteLines.map(l => l.total), quote.discount_amount);
            const lineShare = shares[quoteLines.findIndex(l => l.id === qItem.id)] || 0;
            const newLineTax = parseFloat(((qItem.total - lineShare) * product.tax_rate / 100).toFixed(2));
            const taxDelta = parseFloat((newLineTax - qItem.tax_amount).toFixed(2));
            await tx.execute({ sql: 'UPDATE quotation_items SET tax_amount = ? WHERE id = ?', args: [newLineTax, qItem.id] });
            const newTaxTotal = parseFloat((quote.tax_amount + taxDelta).toFixed(2));
            const newTotal = parseFloat((quote.subtotal - quote.discount_amount + newTaxTotal).toFixed(2));
            await tx.execute({ sql: 'UPDATE quotations SET tax_amount=?, total=? WHERE id=?', args: [newTaxTotal, newTotal, quote.id] });
          }
          quotationUpdated = true;
        }
      }

      // Same close-the-loop as above, scoped to a work order's "Q" line — no
      // tax/total to recompute since work_order_items carries neither.
      let workOrderUpdated = false;
      if (item.work_order_item_id) {
        const { rows: [woItem] } = await tx.execute({ sql: 'SELECT * FROM work_order_items WHERE id = ?', args: [item.work_order_item_id] });
        if (woItem) {
          const { rows: [product] } = await tx.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [productId] });
          await tx.execute({ sql: 'UPDATE work_order_items SET product_id=?, sku=?, is_temp_item=0 WHERE id=?', args: [productId, product.sku, woItem.id] });
          workOrderUpdated = true;
        }
      }

      await tx.commit();
      committed = true;
      const { rows: [updatedItem] } = await db.execute({ sql: 'SELECT * FROM purchase_order_items WHERE id = ?', args: [item.id] });
      res.json({ item: updatedItem, quotation_updated: quotationUpdated, work_order_updated: workOrderUpdated });
    } catch(e) {
      // Once committed, the link is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Process items received damaged - reverses stock added by /receive and logs a stock movement
router.patch('/:id/damage', requirePermission('purchasing_receive'), async (req, res) => {
  try {
    const { items } = req.body;
    const { rows: [po] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    if (!po) return res.status(404).json({ error: 'Not found' });

    const tx = await db.transaction('write');
    try {
      for (const { item_id, quantity_damaged, reason } of (items || [])) {
        const qty = Math.round((Number(quantity_damaged) || 0) * 1000) / 1000;
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
          const singles = stockUnits(qty, item.units_per); // comes off in stock units
          await tx.execute({ sql: 'UPDATE products SET stock_qty = MAX(0, stock_qty - ?) WHERE id = ?', args: [singles, item.product_id] });
          if (po.branch_id) {
            await tx.execute({ sql: 'UPDATE branch_inventory SET stock_qty = MAX(0, stock_qty - ?), updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND branch_id = ?', args: [singles, item.product_id, po.branch_id] });
            await syncBinQty(tx, item.product_id, po.branch_id, -singles);
          }
          await tx.execute({ sql: 'INSERT INTO stock_movements (product_id, branch_id, quantity_change, type, reference, reason) VALUES (?,?,?,?,?,?)', args: [item.product_id, po.branch_id || null, -singles, 'damaged', po.po_number, reason || 'Received damaged from supplier'] });
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
    const allowed_types = ['purchase_request', 'supplier_quotation', 'supplier_invoice', 'other'];
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
    // The invoice an approved fuel/supplier-priced PO was approved against stays on it
    const { rows: [po] } = await db.execute({ sql: 'SELECT status, supplier_priced FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    if (po && po.supplier_priced && att.document_type === 'supplier_invoice' && !['draft', 'cancelled'].includes(po.status)) {
      return res.status(400).json({ error: 'The supplier invoice can only be removed while the PO is a draft' });
    }
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
