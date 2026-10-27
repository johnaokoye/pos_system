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
const { autoBills, createBill, dueDateFor, today, PAID_SQL, round2 } = require('../lib/payables');
const { resolveApprovalSignature } = require('../lib/signatures');
const { getSetting } = require('../lib/settings');
const { localTaxRate, defaultTaxOption, priceLine, poTotals, receivedValue, resolvePoCurrency, poRate, missingRate } = require('../lib/poLines');
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
  (SELECT first_name || ' ' || last_name FROM employees WHERE id = po.reinstated_by) as reinstated_by_name,
  (SELECT id FROM purchase_requests WHERE converted_to_po_id = po.id LIMIT 1) as source_pr_id,
  (SELECT pr_number FROM purchase_requests WHERE converted_to_po_id = po.id LIMIT 1) as source_pr_number,
  (SELECT COUNT(*) FROM pr_attachments pa JOIN purchase_requests spr ON pa.pr_id = spr.id WHERE spr.converted_to_po_id = po.id) as source_pr_attachments
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
    const unlogged = await unloggedReceived(db, po.id);
    for (const i of items) i.quantity_unlogged = unlogged[i.id] || 0;
    po.items = items;
    po.receipts = await poReceipts(po.id);
    res.json(po);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { supplier_id, branch_id, employee_id, items, notes, expected_date, vendor_order_number } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items in PO' });
    let cur;
    try { cur = await resolvePoCurrency(req.body.currency, req.body.exchange_rate); } catch(e) { return res.status(400).json({ error: e.message }); }

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
        processedItems.push({ product_id: item.product_id || null, product_name, sku: item.sku || (product ? product.sku : ''), ...priced, purchase_unit: unit.purchase_unit, units_per: unit.units_per, uom_id: unit.uom_id ?? null, product_url: String(item.product_url || '').trim() || null });
      }
    } catch(e) { return res.status(400).json({ error: e.message }); }
    const { subtotal, tax_amount, total } = poTotals(processedItems);
    const po_number = await nextNumber(db, 'purchase_orders', 'po_number', 'PO-', 6);

    const tx = await db.transaction('write');
    let committed = false;
    try {
      const result = await tx.execute({ sql: 'INSERT INTO purchase_orders (po_number,supplier_id,branch_id,employee_id,subtotal,tax_amount,total,notes,expected_date,vendor_order_number,currency,exchange_rate) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', args: [po_number, supplier_id||null, branch_id||null, employee_id||null, subtotal, tax_amount, total, notes||null, expected_date||null, vendor_order_number||null, cur.currency, cur.exchange_rate] });
      const poId = Number(result.lastInsertRowid);
      for (const item of processedItems) {
        await tx.execute({ sql: 'INSERT INTO purchase_order_items (po_id,product_id,product_name,sku,quantity_ordered,unit_cost,total,vendor_discount,vendor_discount_percent,tax_option,tax_rate,tax_amount,purchase_unit,units_per,uom_id,product_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', args: [poId, item.product_id, item.product_name, item.sku, item.quantity_ordered, item.unit_cost, item.total, item.vendor_discount, item.vendor_discount_percent, item.tax_option, item.tax_rate, item.tax_amount, item.purchase_unit || null, item.units_per || 1, item.uom_id ?? null, item.product_url] });
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
    if (po.reinstated_from_status) return res.status(400).json({ error: 'This PO was already received and is only waiting for its approval — approve or reject it' });
    if (status === 'sent' && missingRate(po)) return res.status(400).json({ error: `Enter the ${po.currency} exchange rate on the PO before sending it for approval` });
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
    // A PO sent back for approval after it was received goes back to its
    // received status — the goods are already in, nothing to receive again.
    await db.execute({
      sql: `UPDATE purchase_orders SET status = ?, reinstated_from_status = NULL, approved_by = ?, approved_at = CURRENT_TIMESTAMP, approval_signature = ?,
            rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL WHERE id = ?`,
      args: [po.reinstated_from_status || 'approved', approverId, sigUrl, req.params.id],
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

    // An already-received PO can't go back to an editable draft — it returns
    // to its received status, still unapproved, with the rejection on record.
    await db.execute({
      sql: `UPDATE purchase_orders SET status = ?, reinstated_from_status = NULL, rejected_by = ?, rejected_at = CURRENT_TIMESTAMP, rejection_reason = ? WHERE id = ?`,
      args: [po.reinstated_from_status || 'draft', employee_id || (req.employee && req.employee.id) || null, reason.trim(), req.params.id],
    });
    const { rows: [updated] } = await db.execute({ sql: PO_DETAIL_SELECT, args: [req.params.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// TEMPORARY — POs received before receiving required approval
// (2fcae57) show as never approved on their documents. This sends one back
// to awaiting approval so it can be signed off; stock, receipts and A/P are
// untouched, and approving (or rejecting) returns it to its received status.
// New POs can't be received unapproved, so this only ever applies to those.
router.patch('/:id/reinstate-for-approval', requirePermission('purchasing_approve'), async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Give a reason for sending it back for approval' });
    const { rows: [po] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (!['received', 'partial'].includes(po.status) || po.approved_at) return res.status(400).json({ error: 'Only a PO that was received without being approved can be sent back for approval' });
    await db.execute({
      sql: `UPDATE purchase_orders SET status = 'sent', reinstated_from_status = ?, reinstated_at = CURRENT_TIMESTAMP, reinstated_by = ?, reinstate_reason = ?,
            rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL WHERE id = ?`,
      args: [po.status, (req.employee && req.employee.id) || null, reason, po.id],
    });
    const { rows: [updated] } = await db.execute({ sql: PO_DETAIL_SELECT, args: [po.id] });
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
    // Older clients don't send a currency — keep the PO's own
    let cur;
    try { cur = 'currency' in req.body ? await resolvePoCurrency(req.body.currency, req.body.exchange_rate) : { currency: po.currency, exchange_rate: po.exchange_rate }; }
    catch(e) { return res.status(400).json({ error: e.message }); }

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
          await tx.execute({ sql: 'UPDATE purchase_order_items SET quantity_ordered = ?, unit_cost = ?, total = ?, vendor_discount = ?, vendor_discount_percent = ?, tax_option = ?, tax_rate = ?, tax_amount = ?, product_url = ? WHERE id = ?', args: [line.quantity_ordered, line.unit_cost, line.total, line.vendor_discount, line.vendor_discount_percent, line.tax_option, line.tax_rate, line.tax_amount, 'product_url' in item ? (String(item.product_url || '').trim() || null) : existing.product_url, existingId] });
          keepIds.add(existingId);
        } else {
          const unit = await resolvePurchaseUnit(tx, product, item.uom_id ?? item.purchase_unit);
          const result = await tx.execute({ sql: 'INSERT INTO purchase_order_items (po_id,product_id,product_name,sku,quantity_ordered,unit_cost,total,vendor_discount,vendor_discount_percent,tax_option,tax_rate,tax_amount,purchase_unit,units_per,uom_id,product_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', args: [req.params.id, product.id, lineName(product.name, unit), product.sku, line.quantity_ordered, line.unit_cost, line.total, line.vendor_discount, line.vendor_discount_percent, line.tax_option, line.tax_rate, line.tax_amount, unit.purchase_unit, unit.units_per, unit.uom_id ?? null, String(item.product_url || '').trim() || null] });
          keepIds.add(Number(result.lastInsertRowid));
        }
      }
      for (const existing of existingItems) {
        if (!keepIds.has(existing.id)) await tx.execute({ sql: 'DELETE FROM purchase_order_items WHERE id = ?', args: [existing.id] });
      }
      const { subtotal, tax_amount, total } = poTotals(priced);
      await tx.execute({
        sql: 'UPDATE purchase_orders SET supplier_id = ?, branch_id = ?, notes = ?, expected_date = ?, vendor_order_number = ?, subtotal = ?, tax_amount = ?, total = ?, currency = ?, exchange_rate = ? WHERE id = ?',
        args: [supplier_id || po.supplier_id, branch_id || null, notes ?? po.notes, expected_date || null, vendor_order_number || null, subtotal, tax_amount, total, cur.currency, cur.exchange_rate, req.params.id],
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
    // Receiving needs a signed-off PO. 'partial' stays receivable so a PO
    // part-received before this rule existed can still be finished.
    if (!['approved', 'partial'].includes(po.status)) {
      return res.status(400).json({ error: po.supplier_priced
        ? 'A fuel/supplier-priced PO is received only after it is approved with the invoiced cost'
        : `This PO is ${{ draft: 'still a draft', sent: 'awaiting approval' }[po.status] || po.status} — it must be approved before it can be received` });
    }
    if (missingRate(po)) return res.status(400).json({ error: `This PO is in ${po.currency} with no exchange rate — it's needed to cost the stock and the A/P bill` });
    // Stock cost and A/P are in base currency; the PO may not be
    const rate = poRate(po);

    const tx = await db.transaction('write');
    try {
      let receiptValue = 0, receiptTax = 0, receiptId = null;
      for (const { item_id, quantity_received } of (items || [])) {
        const qty = Math.round((Number(quantity_received) || 0) * 1000) / 1000; // part quantities for measured units
        if (!qty || qty <= 0) continue;
        const { rows: [item] } = await tx.execute({ sql: 'SELECT * FROM purchase_order_items WHERE id = ? AND po_id = ?', args: [item_id, req.params.id] });
        if (!item) continue;
        // Logged as one receipt so it can be reversed as a unit later.
        if (!receiptId) {
          const receipt_number = await nextNumber(tx, 'po_receipts', 'receipt_number', 'RCV-', 6);
          const r = await tx.execute({ sql: 'INSERT INTO po_receipts (receipt_number, po_id, branch_id, received_by) VALUES (?,?,?,?)', args: [receipt_number, po.id, po.branch_id || null, req.employee?.id || null] });
          receiptId = Number(r.lastInsertRowid);
        }
        const value = receivedValue(item, qty);
        receiptValue += value.goods;
        receiptTax += value.tax;
        // Stock is costed at what was actually paid per unit — after the vendor's discount, before tax.
        const netUnitCost = (item.quantity_ordered ? (Number(item.total) || 0) / item.quantity_ordered : (Number(item.unit_cost) || 0)) * rate;
        const newReceived = (item.quantity_received || 0) + qty;
        await tx.execute({ sql: 'UPDATE purchase_order_items SET quantity_received = ? WHERE id = ?', args: [newReceived, item_id] });
        let singles = 0, prevCost = null, newCost = null;
        if (item.product_id) {
          // A line in another unit (lib/units.js) receives quantity × its size
          // in stock units; stock and cost are per stock unit.
          const per = Number(item.units_per) || 1;
          singles = stockUnits(qty, per);
          const { rows: [prod] } = await tx.execute({ sql: 'SELECT cost FROM products WHERE id = ?', args: [item.product_id] });
          prevCost = prod ? prod.cost : null;
          await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [singles, item.product_id] });
          if (netUnitCost > 0) {
            newCost = parseFloat((netUnitCost / per).toFixed(4));
            await tx.execute({ sql: 'UPDATE products SET cost = ? WHERE id = ?', args: [newCost, item.product_id] });
          }
          if (po.branch_id) {
            await tx.execute({ sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at) VALUES (?, ?, ?, (SELECT min_stock FROM products WHERE id = ?), CURRENT_TIMESTAMP) ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP`, args: [item.product_id, po.branch_id, singles, item.product_id, singles] });
            await syncBinQty(tx, item.product_id, po.branch_id, singles);
          }
        }
        await tx.execute({ sql: 'INSERT INTO po_receipt_items (receipt_id, po_item_id, product_id, quantity, stock_units, prev_cost, new_cost) VALUES (?,?,?,?,?,?,?)', args: [receiptId, item.id, item.product_id || null, qty, singles, prevCost, newCost] });
      }
      if (!receiptId) throw new Error('Enter at least one quantity to receive');

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
        const billId = await createBill(tx, {
          supplier_id: po.supplier_id, po_id: po.id, branch_id: po.branch_id,
          bill_date: billDate, due_date: dueDateFor(supplier.payment_terms, billDate),
          amount: parseFloat(((receiptValue + tax) * rate).toFixed(2)),
          description: `Goods received on ${po.po_number}${po.currency ? ` (${po.currency} ${(receiptValue + tax).toFixed(2)} @ ${rate})` : ''}`,
          source: 'receipt', created_by: req.employee?.id,
        });
        await tx.execute({ sql: 'UPDATE po_receipts SET bill_id = ? WHERE id = ?', args: [billId, receiptId] });
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

// ── Reversing receipts ──────────────────────────────────────
// Takes received goods back off: stock out of the PO's branch, the line's
// received count down, and the PO/PR status back to partial/approved so it
// can be received again. Refused when the stock has since been sold or moved
// (on hand < what's coming off) or when it would leave fewer received than
// were already processed as damaged. lines: [{ item, qty, prevCost, newCost }].
async function reverseReceivedLines(tx, po, lines, reference, reason) {
  const need = {};
  for (const { item, qty } of lines) {
    const left = Math.round(((item.quantity_received || 0) - qty) * 1000) / 1000;
    if (left < 0) throw new Error(`Only ${item.quantity_received || 0} of "${item.product_name}" is received`);
    if (left < (item.quantity_damaged || 0)) throw new Error(`${item.quantity_damaged} of "${item.product_name}" were processed as damaged — that many must stay received`);
    if (item.product_id) need[item.product_id] = (need[item.product_id] || 0) + stockUnits(qty, item.units_per);
  }
  const short = [];
  for (const [productId, units] of Object.entries(need)) {
    const { rows: [s] } = po.branch_id
      ? await tx.execute({ sql: 'SELECT p.name, COALESCE(bi.stock_qty, 0) AS on_hand FROM products p LEFT JOIN branch_inventory bi ON bi.product_id = p.id AND bi.branch_id = ? WHERE p.id = ?', args: [po.branch_id, productId] })
      : await tx.execute({ sql: 'SELECT name, stock_qty AS on_hand FROM products WHERE id = ?', args: [productId] });
    if (s && Number(s.on_hand) < units) short.push(`${s.name} (on hand ${Number(s.on_hand)}, reversing ${units})`);
  }
  if (short.length) throw new Error(`Not enough stock on hand to reverse — it may have been sold or moved: ${short.join('; ')}`);

  for (const { item, qty, prevCost, newCost } of lines) {
    await tx.execute({ sql: 'UPDATE purchase_order_items SET quantity_received = ? WHERE id = ?', args: [Math.round(((item.quantity_received || 0) - qty) * 1000) / 1000, item.id] });
    if (!item.product_id) continue;
    const singles = stockUnits(qty, item.units_per);
    await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?', args: [singles, item.product_id] });
    // Put the cost back to what it was before this receipt — unless a later
    // receipt or an edit has changed it since.
    if (prevCost != null && newCost != null) {
      await tx.execute({ sql: 'UPDATE products SET cost = ? WHERE id = ? AND ABS(cost - ?) < 0.00005', args: [prevCost, item.product_id, newCost] });
    }
    if (po.branch_id) {
      await tx.execute({ sql: 'UPDATE branch_inventory SET stock_qty = stock_qty - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND branch_id = ?', args: [singles, item.product_id, po.branch_id] });
      await syncBinQty(tx, item.product_id, po.branch_id, -singles);
    }
    await tx.execute({ sql: 'INSERT INTO stock_movements (product_id, branch_id, quantity_change, type, reference, reason) VALUES (?,?,?,?,?,?)', args: [item.product_id, po.branch_id || null, -singles, 'receipt_reversed', reference, reason] });
  }

  const { rows: poItems } = await tx.execute({ sql: 'SELECT quantity_ordered, quantity_received FROM purchase_order_items WHERE po_id = ?', args: [po.id] });
  const allReceived = poItems.every(i => (i.quantity_received || 0) >= i.quantity_ordered);
  const anyReceived = poItems.some(i => (i.quantity_received || 0) > 0);
  const newStatus = allReceived ? 'received' : anyReceived ? 'partial' : 'approved';
  await tx.execute({ sql: 'UPDATE purchase_orders SET status = ?, received_at = ? WHERE id = ?', args: [newStatus, allReceived ? po.received_at : null, po.id] });
  if (!allReceived) {
    await tx.execute({ sql: `UPDATE purchase_requests SET status = 'converted' WHERE converted_to_po_id = ? AND status = 'received'`, args: [po.id] });
  }
}

async function loadReversiblePO(id) {
  const { rows: [po] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id = ?', args: [id] });
  if (!po) return { error: [404, 'Not found'] };
  if (!['received', 'partial'].includes(po.status)) return { error: [400, `Only a received or part-received PO can have a receipt reversed (this one is ${po.status})`] };
  return { po };
}

// Each logged receipt on a PO with its lines (GET /:id attaches these).
async function poReceipts(poId) {
  const { rows: receipts } = await db.execute({
    sql: `SELECT r.*, er.first_name || ' ' || er.last_name AS received_by_name, ev.first_name || ' ' || ev.last_name AS reversed_by_name,
            b.bill_number, b.status AS bill_status
          FROM po_receipts r
          LEFT JOIN employees er ON er.id = r.received_by
          LEFT JOIN employees ev ON ev.id = r.reversed_by
          LEFT JOIN ap_bills b ON b.id = r.bill_id
          WHERE r.po_id = ? ORDER BY r.id`,
    args: [poId],
  });
  if (!receipts.length) return [];
  const { rows: items } = await db.execute({
    sql: `SELECT ri.*, poi.product_name, poi.purchase_unit FROM po_receipt_items ri JOIN purchase_order_items poi ON poi.id = ri.po_item_id
          WHERE ri.receipt_id IN (SELECT id FROM po_receipts WHERE po_id = ?) ORDER BY ri.id`,
    args: [poId],
  });
  for (const r of receipts) r.items = items.filter(i => i.receipt_id === r.id);
  return receipts;
}

// Received quantity per line that no logged receipt accounts for — goods
// received before receipts were logged.
async function unloggedReceived(executor, poId) {
  const { rows } = await executor.execute({
    sql: `SELECT poi.id, COALESCE(poi.quantity_received, 0) - COALESCE((SELECT SUM(ri.quantity) FROM po_receipt_items ri JOIN po_receipts r ON r.id = ri.receipt_id
            WHERE ri.po_item_id = poi.id AND r.status = 'received'), 0) AS unlogged
          FROM purchase_order_items poi WHERE poi.po_id = ?`,
    args: [poId],
  });
  return Object.fromEntries(rows.map(r => [r.id, Math.max(0, Math.round(Number(r.unlogged) * 1000) / 1000)]));
}

// Reverse one logged receipt. Its A/P bill is voided with it; a bill with
// payments applied blocks the reversal until A/P voids those payments.
router.post('/:id/receipts/:rid/reverse', requirePermission('purchasing_receive'), async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Enter the reason for reversing this receipt' });
    const { po, error } = await loadReversiblePO(req.params.id);
    if (error) return res.status(error[0]).json({ error: error[1] });
    const { rows: [receipt] } = await db.execute({ sql: 'SELECT * FROM po_receipts WHERE id = ? AND po_id = ?', args: [req.params.rid, po.id] });
    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
    if (receipt.status !== 'received') return res.status(400).json({ error: `${receipt.receipt_number} has already been reversed` });

    const tx = await db.transaction('write');
    try {
      if (receipt.bill_id) {
        const { rows: [bill] } = await tx.execute({ sql: `SELECT b.id, b.bill_number, b.status, ${PAID_SQL} AS paid FROM ap_bills b WHERE b.id = ?`, args: [receipt.bill_id] });
        if (bill && bill.status !== 'void') {
          if (round2(bill.paid) > 0) throw new Error(`A/P bill ${bill.bill_number} for this receipt has payments applied — void or reallocate those payments in Accounts Payable first`);
          await tx.execute({ sql: "UPDATE ap_bills SET status = 'void', void_reason = ?, voided_by = ?, voided_at = CURRENT_TIMESTAMP WHERE id = ?", args: [`Receipt ${receipt.receipt_number} reversed: ${reason}`, req.employee?.id || null, bill.id] });
        }
      }
      const { rows: rItems } = await tx.execute({ sql: 'SELECT * FROM po_receipt_items WHERE receipt_id = ?', args: [receipt.id] });
      const lines = [];
      for (const ri of rItems) {
        const { rows: [item] } = await tx.execute({ sql: 'SELECT * FROM purchase_order_items WHERE id = ?', args: [ri.po_item_id] });
        if (item) lines.push({ item, qty: ri.quantity, prevCost: ri.product_id ? ri.prev_cost : null, newCost: ri.product_id ? ri.new_cost : null });
      }
      await reverseReceivedLines(tx, po, lines, receipt.receipt_number, reason);
      await tx.execute({ sql: "UPDATE po_receipts SET status = 'reversed', reversed_by = ?, reversed_at = CURRENT_TIMESTAMP, reverse_reason = ? WHERE id = ?", args: [req.employee?.id || null, reason, receipt.id] });
      await tx.commit();
    } catch(e) {
      await tx.rollback();
      return res.status(400).json({ error: e.message });
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Reverse goods received before receipts were logged, per line. Their A/P
// bill isn't tied to a receipt, so it's left for A/P to void by hand.
router.post('/:id/reverse-unlogged', requirePermission('purchasing_receive'), async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Enter the reason for reversing this receipt' });
    const { po, error } = await loadReversiblePO(req.params.id);
    if (error) return res.status(error[0]).json({ error: error[1] });

    const tx = await db.transaction('write');
    try {
      const unlogged = await unloggedReceived(tx, po.id);
      const lines = [];
      for (const { item_id, quantity } of (req.body.items || [])) {
        const qty = Math.round((Number(quantity) || 0) * 1000) / 1000;
        if (!(qty > 0)) continue;
        const { rows: [item] } = await tx.execute({ sql: 'SELECT * FROM purchase_order_items WHERE id = ? AND po_id = ?', args: [item_id, po.id] });
        if (!item) continue;
        if (qty > (unlogged[item.id] || 0)) throw new Error(`Only ${unlogged[item.id] || 0} of "${item.product_name}" was received before receipts were logged`);
        lines.push({ item, qty });
      }
      if (!lines.length) throw new Error('Enter at least one quantity to reverse');
      await reverseReceivedLines(tx, po, lines, po.po_number, reason);
      await tx.commit();
    } catch(e) {
      await tx.rollback();
      return res.status(400).json({ error: e.message });
    }
    res.json({ success: true });
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
