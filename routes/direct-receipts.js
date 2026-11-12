// Receiving goods with no purchase order (Purchasing → Receive Without PO).
// By the owner's choice (2026-11-03) there is no approval step: the stock goes
// on hand at once, each line's entered unit cost (net, before tax) becomes
// products.cost, and an A/P bill is raised on the same rule as PO receipts
// (vendor has Sync with A/P on and isn't "Not vouchered"). A supplier is
// required. A receipt is reversed as a unit, like a PO receipt.
const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');
const { resolvePurchaseUnit, lineName, parseQty, stockUnits } = require('../lib/units');
const { syncBinQty } = require('../lib/binSync');
const { addOwnedLot } = require('../lib/stockLots');
const { autoBills, createBill, dueDateFor, today, PAID_SQL, round2 } = require('../lib/payables');
const { localTaxRate, defaultTaxOption, priceLine, poTotals } = require('../lib/poLines');

router.use(requirePermission('purchasing_receive_direct'));

const LIST_SELECT = `SELECT r.*, s.name AS supplier_name, b.name AS branch_name,
    er.first_name || ' ' || er.last_name AS received_by_name, ev.first_name || ' ' || ev.last_name AS reversed_by_name,
    ab.bill_number, ab.status AS bill_status,
    (SELECT COUNT(*) FROM direct_receipt_items i WHERE i.receipt_id = r.id) AS item_count
  FROM direct_receipts r
  LEFT JOIN suppliers s ON s.id = r.supplier_id
  LEFT JOIN branches b ON b.id = r.branch_id
  LEFT JOIN employees er ON er.id = r.received_by
  LEFT JOIN employees ev ON ev.id = r.reversed_by
  LEFT JOIN ap_bills ab ON ab.id = r.bill_id`;

async function loadReceipt(id) {
  const { rows: [r] } = await db.execute({ sql: `${LIST_SELECT} WHERE r.id = ?`, args: [id] });
  if (!r) return null;
  const { rows: items } = await db.execute({ sql: 'SELECT * FROM direct_receipt_items WHERE receipt_id = ? ORDER BY id', args: [id] });
  r.items = items;
  return r;
}

// GET /direct-receipts?q=&supplier_id=&branch_id=&status=&start=&end=
router.get('/', async (req, res) => {
  try {
    const { q, supplier_id, branch_id, status, start, end } = req.query;
    const where = [], args = [];
    if (supplier_id) { where.push('r.supplier_id = ?'); args.push(supplier_id); }
    if (branch_id) { where.push('r.branch_id = ?'); args.push(branch_id); }
    if (status) { where.push('r.status = ?'); args.push(status); }
    // received_at is UTC; the dates are store days, close enough for a filter.
    if (start) { where.push('date(r.received_at) >= ?'); args.push(start); }
    if (end) { where.push('date(r.received_at) <= ?'); args.push(end); }
    if (q) {
      const like = `%${String(q).trim()}%`;
      where.push(`(r.receipt_number LIKE ? OR r.vendor_invoice_number LIKE ? OR r.notes LIKE ? OR s.name LIKE ?
        OR EXISTS (SELECT 1 FROM direct_receipt_items i WHERE i.receipt_id = r.id AND (i.product_name LIKE ? OR i.sku LIKE ?)))`);
      args.push(like, like, like, like, like, like);
    }
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const { rows } = await db.execute({ sql: `${LIST_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY r.id DESC LIMIT ${limit}`, args });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const r = await loadReceipt(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found' });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /direct-receipts — { supplier_id, branch_id, vendor_invoice_number,
// notes, items: [{ product_id, uom_id, quantity, unit_cost, tax_option }],
// allow_duplicate_invoice? }. Receives straight away.
router.post('/', async (req, res) => {
  try {
    const { supplier_id, branch_id, notes } = req.body;
    const vendorInvoice = String(req.body.vendor_invoice_number || '').trim() || null;
    if (!supplier_id) return res.status(400).json({ error: 'Choose the supplier the goods came from' });
    const { rows: [supplier] } = await db.execute({ sql: 'SELECT id, name, is_local, payment_terms, sync_ap, voucher_default FROM suppliers WHERE id = ?', args: [supplier_id] });
    if (!supplier) return res.status(400).json({ error: 'Supplier not found' });
    const { rows: [{ n: branchCount }] } = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM branches', args: [] });
    if (Number(branchCount) && !branch_id) return res.status(400).json({ error: 'Choose the branch the goods are going into' });
    if (branch_id) {
      const { rows: [b] } = await db.execute({ sql: 'SELECT id FROM branches WHERE id = ?', args: [branch_id] });
      if (!b) return res.status(400).json({ error: 'Branch not found' });
    }
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'Add at least one item' });

    // The same supplier invoice entered twice would double the stock and the bill.
    if (vendorInvoice && !req.body.allow_duplicate_invoice) {
      const { rows: [dup] } = await db.execute({ sql: `SELECT receipt_number AS ref FROM direct_receipts WHERE supplier_id = ? AND LOWER(vendor_invoice_number) = LOWER(?) AND status = 'received'
          UNION ALL SELECT bill_number FROM ap_bills WHERE supplier_id = ? AND LOWER(vendor_invoice_number) = LOWER(?) AND status != 'void' LIMIT 1`,
        args: [supplier.id, vendorInvoice, supplier.id, vendorInvoice] });
      if (dup) return res.status(409).json({ error: `${supplier.name} invoice ${vendorInvoice} is already on ${dup.ref}. Receiving it again would double the stock and the bill.`, duplicate_of: dup.ref });
    }

    const taxRate = await localTaxRate();
    const lines = [];
    for (const it of items) {
      const { rows: [p] } = await db.execute({ sql: `SELECT p.*, (SELECT COUNT(*) FROM product_variations v WHERE v.product_id = p.id AND v.active = 1) AS has_variations
          FROM products p WHERE p.id = ?`, args: [it.product_id] });
      if (!p) return res.status(400).json({ error: 'An item on the receipt was not found — pick it again' });
      if (p.is_service || p.is_rental) return res.status(400).json({ error: `${p.name} isn't a stocked item, so it can't be received` });
      if (Number(p.has_variations) > 0) return res.status(400).json({ error: `${p.name} has variations — receive it on a purchase order` });
      let unit;
      try { unit = await resolvePurchaseUnit(db, p, it.uom_id ?? null); } catch (e) { return res.status(400).json({ error: e.message }); }
      const qty = parseQty(it.quantity, unit.allow_decimal);
      if (!(qty > 0)) return res.status(400).json({ error: `Enter a quantity for ${p.name}${unit.allow_decimal ? '' : ' (whole units)'}` });
      const cost = Number(it.unit_cost);
      if (!(cost >= 0) || it.unit_cost === '' || it.unit_cost == null) return res.status(400).json({ error: `Enter the unit cost for ${p.name}` });
      let priced;
      try {
        priced = priceLine({ name: p.name, quantity: qty, unit_cost: cost, tax_option: it.tax_option || defaultTaxOption(supplier) }, taxRate);
      } catch (e) { return res.status(400).json({ error: e.message }); }
      lines.push({ p, unit, qty, priced, singles: stockUnits(qty, unit.units_per) });
    }
    const totals = poTotals(lines.map(l => l.priced));

    const tx = await db.transaction('write');
    let committed = false, receiptId;
    try {
      const receipt_number = await nextNumber(tx, 'direct_receipts', 'receipt_number', 'DRC-', 6);
      const r = await tx.execute({ sql: `INSERT INTO direct_receipts (receipt_number, supplier_id, branch_id, vendor_invoice_number, notes, subtotal, tax_amount, total, received_by)
          VALUES (?,?,?,?,?,?,?,?,?)`,
        args: [receipt_number, supplier.id, branch_id || null, vendorInvoice, String(notes || '').trim() || null, totals.subtotal, totals.tax_amount, totals.total, req.employee?.id || null] });
      receiptId = Number(r.lastInsertRowid);
      for (const { p, unit, qty, priced, singles } of lines) {
        const { rows: [cur] } = await tx.execute({ sql: 'SELECT cost FROM products WHERE id = ?', args: [p.id] });
        const prevCost = cur ? cur.cost : null;
        // Costed like a PO receipt: what was paid per stock unit, before tax.
        const netUnit = qty ? priced.total / qty : 0;
        const newCost = netUnit > 0 ? parseFloat((netUnit / (Number(unit.units_per) || 1)).toFixed(4)) : null;
        await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [singles, p.id] });
        if (newCost != null) await tx.execute({ sql: 'UPDATE products SET cost = ? WHERE id = ?', args: [newCost, p.id] });
        if (branch_id) {
          await tx.execute({ sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at) VALUES (?, ?, ?, (SELECT min_stock FROM products WHERE id = ?), CURRENT_TIMESTAMP)
              ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP`,
            args: [p.id, branch_id, singles, p.id, singles] });
          await syncBinQty(tx, p.id, branch_id, singles);
          // A dated owned receipt for oldest-first selling (lib/stockLots.js), once tracking has started.
          await addOwnedLot(tx, { product_id: p.id, branch_id, source_type: 'direct_receipt', source_id: receiptId, source_number: receipt_number, qty: singles, unit_cost: newCost, employee_id: req.employee?.id || null });
        }
        await tx.execute({ sql: `INSERT INTO direct_receipt_items (receipt_id, product_id, product_name, sku, uom_id, purchase_unit, units_per, quantity, stock_units, unit_cost, tax_option, tax_rate, tax_amount, total, prev_cost, new_cost)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          args: [receiptId, p.id, lineName(p.name, unit), p.sku || null, unit.uom_id, unit.purchase_unit, Number(unit.units_per) || 1, qty, singles, priced.unit_cost, priced.tax_option, priced.tax_rate, priced.tax_amount, priced.total, prevCost, newCost] });
        await tx.execute({ sql: 'INSERT INTO stock_movements (product_id, branch_id, quantity_change, type, reference, reason) VALUES (?,?,?,?,?,?)',
          args: [p.id, branch_id || null, singles, 'received', receipt_number, `Received from ${supplier.name} without a PO${vendorInvoice ? ` (invoice ${vendorInvoice})` : ''}`] });
      }
      if (totals.total > 0 && autoBills(supplier)) {
        const billDate = today();
        const billId = await createBill(tx, {
          supplier_id: supplier.id, vendor_invoice_number: vendorInvoice, branch_id: branch_id || null,
          bill_date: billDate, due_date: dueDateFor(supplier.payment_terms, billDate),
          amount: totals.total, tax_amount: totals.tax_amount,
          description: `Goods received without a PO on ${receipt_number}`,
          source: 'direct_receipt', created_by: req.employee?.id,
        });
        await tx.execute({ sql: 'UPDATE direct_receipts SET bill_id = ? WHERE id = ?', args: [billId, receiptId] });
      }
      await tx.commit();
      committed = true;
    } catch (e) {
      if (!committed) await tx.rollback();
      return res.status(400).json({ error: e.message });
    }
    res.status(201).json(await loadReceipt(receiptId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /direct-receipts/:id/reverse — { reason }. Takes the stock back off,
// puts the cost back if nothing has changed it since, and voids the A/P bill
// (refused while the bill has payments, or when the stock has since gone).
router.post('/:id/reverse', async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Enter the reason for reversing this receipt' });
    const tx = await db.transaction('write');
    let committed = false;
    try {
      const { rows: [r] } = await tx.execute({ sql: 'SELECT * FROM direct_receipts WHERE id = ?', args: [req.params.id] });
      if (!r) throw Object.assign(new Error('Not found'), { status: 404 });
      if (r.status !== 'received') throw new Error(`${r.receipt_number} has already been reversed`);
      const { rows: items } = await tx.execute({ sql: 'SELECT * FROM direct_receipt_items WHERE receipt_id = ?', args: [r.id] });

      const need = {};
      for (const i of items) need[i.product_id] = (need[i.product_id] || 0) + Number(i.stock_units);
      const short = [];
      for (const [productId, units] of Object.entries(need)) {
        const { rows: [s] } = r.branch_id
          ? await tx.execute({ sql: 'SELECT p.name, COALESCE(bi.stock_qty, 0) AS on_hand FROM products p LEFT JOIN branch_inventory bi ON bi.product_id = p.id AND bi.branch_id = ? WHERE p.id = ?', args: [r.branch_id, productId] })
          : await tx.execute({ sql: 'SELECT name, stock_qty AS on_hand FROM products WHERE id = ?', args: [productId] });
        if (s && Number(s.on_hand) < units) short.push(`${s.name} (on hand ${Number(s.on_hand)}, reversing ${units})`);
      }
      if (short.length) throw new Error(`Not enough stock on hand to reverse — it may have been sold or moved: ${short.join('; ')}`);

      if (r.bill_id) {
        const { rows: [bill] } = await tx.execute({ sql: `SELECT b.id, b.bill_number, b.status, ${PAID_SQL} AS paid FROM ap_bills b WHERE b.id = ?`, args: [r.bill_id] });
        if (bill && bill.status !== 'void') {
          if (round2(bill.paid) > 0) throw new Error(`A/P bill ${bill.bill_number} for this receipt has payments applied — void or reallocate those payments in Accounts Payable first`);
          await tx.execute({ sql: "UPDATE ap_bills SET status = 'void', void_reason = ?, voided_by = ?, voided_at = CURRENT_TIMESTAMP WHERE id = ?", args: [`Receipt ${r.receipt_number} reversed: ${reason}`, req.employee?.id || null, bill.id] });
        }
      }
      for (const i of items) {
        const units = Number(i.stock_units);
        await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?', args: [units, i.product_id] });
        if (i.prev_cost != null && i.new_cost != null) {
          await tx.execute({ sql: 'UPDATE products SET cost = ? WHERE id = ? AND ABS(cost - ?) < 0.00005', args: [i.prev_cost, i.product_id, i.new_cost] });
        }
        if (r.branch_id) {
          await tx.execute({ sql: 'UPDATE branch_inventory SET stock_qty = stock_qty - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND branch_id = ?', args: [units, i.product_id, r.branch_id] });
          await syncBinQty(tx, i.product_id, r.branch_id, -units);
        }
        await tx.execute({ sql: 'INSERT INTO stock_movements (product_id, branch_id, quantity_change, type, reference, reason) VALUES (?,?,?,?,?,?)',
          args: [i.product_id, r.branch_id || null, -units, 'receipt_reversed', r.receipt_number, `Receipt reversed: ${reason}`] });
      }
      await tx.execute({ sql: "UPDATE direct_receipts SET status = 'reversed', reversed_by = ?, reversed_at = CURRENT_TIMESTAMP, reverse_reason = ? WHERE id = ?", args: [req.employee?.id || null, reason, r.id] });
      await tx.commit();
      committed = true;
    } catch (e) {
      if (!committed) await tx.rollback();
      return res.status(e.status || 400).json({ error: e.message });
    }
    res.json(await loadReceipt(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
