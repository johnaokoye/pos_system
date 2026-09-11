const { db } = require('../database');
const { createTransfer } = require('./transfers');
const { nextNumber } = require('./nextNumber');

// Three kinds of line: a real catalog product (branch-sourced, same as
// before); a "Q" item — not in the catalog yet, just a description + price —
// which mirrors routes/quotations.js's processQuoteItems is_temp_item
// handling and flows through the same PR/PO pipeline (see
// flagWorkOrderItemsForPurchasing below); and a customer-supplied item, which
// is tracked on the WO for the technician's reference but is never sourced,
// never sent to Purchasing, and never charged (unit_cost/unit_price stay 0).
async function processWorkOrderItems(items, defaultTaxRate = 0) {
  const processedItems = [];
  for (const item of items) {
    if (item.is_customer_supplied) {
      const description = item.description || item.product_name;
      if (!description || !String(description).trim()) throw new Error('A description is required for a customer-supplied part');
      const qty = parseInt(item.quantity || 1);
      processedItems.push({
        product_id: null, product_name: String(description).trim(), sku: null,
        quantity: qty, unit_cost: 0, unit_price: 0, total: 0, tax_rate: 0,
        is_temp_item: 0, is_customer_supplied: 1, sources: null,
      });
      continue;
    }

    let product = null;
    if (item.product_id) {
      const { rows: [p] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] });
      if (!p) throw new Error(`Product ${item.product_id} not found`);
      product = p;
    } else if (!item.description || !String(item.description).trim()) {
      throw new Error('Every work order part must reference a catalog product, a description (for a non-stocked item), or be marked customer-supplied');
    }
    const qty = parseInt(item.quantity || 1);
    const unit_price = parseFloat(item.unit_price ?? (product ? product.price : 0)) || 0;
    // A "Q" item has no real cost yet — bring the entered price forward as the
    // starting estimate, same as processQuoteItems does; Purchasing can
    // adjust it once it's actually sourced.
    const unit_cost = product ? (parseFloat(product.cost) || 0) : unit_price;
    const total = parseFloat((unit_price * qty).toFixed(2));
    // A real catalog product carries its own tax_rate; a "Q" item (not yet in
    // the catalog) has none to draw from, so it falls back to the company's
    // default rate instead — same reasoning as labor/consumables on the
    // estimate (see PATCH /:id/estimate).
    const tax_rate = product ? (parseFloat(product.tax_rate) || 0) : (parseFloat(defaultTaxRate) || 0);
    let sources = null;
    if (product && Array.isArray(item.sources) && item.sources.length) {
      const sourcesSum = item.sources.reduce((s, src) => s + (parseInt(src.quantity) || 0), 0);
      if (sourcesSum !== qty) throw new Error(`Branch sourcing for ${product.name} (${sourcesSum}) doesn't match quantity (${qty})`);
      sources = item.sources.map(src => ({ branch_id: src.branch_id || null, quantity: parseInt(src.quantity) || 0 })).filter(src => src.quantity > 0);
    }
    processedItems.push({
      product_id: product ? product.id : null,
      product_name: product ? product.name : String(item.description).trim(),
      sku: product ? product.sku : null,
      quantity: qty, unit_cost, unit_price, total, tax_rate,
      is_temp_item: product ? 0 : 1, is_customer_supplied: 0, sources,
    });
  }
  return processedItems;
}

// One PR per work order, shared by every part shortfall — mirrors
// routes/quotations.js's ensureQuotePR exactly, scoped to work_order_items
// instead of quotation_items.
async function ensureWorkOrderPR(workOrder) {
  const { rows: [existingLink] } = await db.execute({ sql: 'SELECT purchase_request_id FROM work_order_items WHERE work_order_id = ? AND purchase_request_id IS NOT NULL LIMIT 1', args: [workOrder.id] });
  if (existingLink) return existingLink.purchase_request_id;
  const { rows: [existingSourceLink] } = await db.execute({
    sql: `SELECT pri.pr_id FROM work_order_item_sources wis
          JOIN work_order_items woi ON wis.work_order_item_id = woi.id
          JOIN purchase_request_items pri ON wis.purchase_request_item_id = pri.id
          WHERE woi.work_order_id = ? LIMIT 1`,
    args: [workOrder.id],
  });
  if (existingSourceLink) return existingSourceLink.pr_id;

  const pr_number = await nextNumber(db, 'purchase_requests', 'pr_number', 'PR-', 6);
  const result = await db.execute({
    sql: 'INSERT INTO purchase_requests (pr_number, branch_id, employee_id, notes, request_type) VALUES (?,?,?,?,?)',
    args: [pr_number, workOrder.branch_id || null, workOrder.employee_id || null, `Parts for work order ${workOrder.wo_number}`, 'sale'],
  });
  return Number(result.lastInsertRowid);
}

// Auto-creates a real branch transfer for each distinct non-home branch a
// WO's parts were sourced from — line-for-line the same approach as
// routes/quotations.js's processQuoteTransfers, just keyed off
// work_order_item_sources/work_order_id instead of the quotation equivalents.
// If a source branch's stock has changed since parts were assigned and the
// transfer can no longer be created, that group falls back to the PR bucket
// (branch_id = NULL) so flagWorkOrderItemsForPurchasing sweeps it up instead —
// confirming parts never hard-fails because of stale data.
async function processWorkOrderPartTransfers(workOrder) {
  try {
    if (!workOrder.branch_id) return;
    const { rows: pending } = await db.execute({
      sql: `SELECT wis.id as source_id, wis.branch_id, wis.quantity, woi.product_id
            FROM work_order_item_sources wis JOIN work_order_items woi ON wis.work_order_item_id = woi.id
            WHERE woi.work_order_id = ? AND wis.branch_id IS NOT NULL AND wis.branch_id != ? AND wis.transfer_id IS NULL`,
      args: [workOrder.id, workOrder.branch_id],
    });
    if (!pending.length) return;

    const byBranch = {};
    for (const row of pending) { (byBranch[row.branch_id] = byBranch[row.branch_id] || []).push(row); }

    for (const [branchId, rows] of Object.entries(byBranch)) {
      const tx = await db.transaction('write');
      let committed = false;
      try {
        const transfer_number = await nextNumber(tx, 'branch_transfers', 'transfer_number', 'TRF-', 6);
        const items = rows.map(r => ({ product_id: r.product_id, quantity: r.quantity }));
        const transferId = await createTransfer(tx, {
          transfer_number, from_branch_id: Number(branchId), to_branch_id: workOrder.branch_id,
          employee_id: workOrder.employee_id, items, notes: `Auto-created from work order ${workOrder.wo_number}`,
          quote_id: null,
        });
        await tx.execute({ sql: 'UPDATE branch_transfers SET work_order_id = ? WHERE id = ?', args: [workOrder.id, transferId] });
        for (const r of rows) {
          await tx.execute({ sql: 'UPDATE work_order_item_sources SET transfer_id = ? WHERE id = ?', args: [transferId, r.source_id] });
        }
        await tx.commit();
        committed = true;
      } catch(e) {
        if (committed) throw e;
        await tx.rollback();
        for (const r of rows) {
          await db.execute({ sql: 'UPDATE work_order_item_sources SET branch_id = NULL WHERE id = ?', args: [r.source_id] });
        }
      }
    }
  } catch(e) { /* non-fatal: confirming parts itself already succeeded */ }
}

// Flags every not-yet-flagged part into the WO's shared Purchase Request —
// mirrors routes/quotations.js's flagItemsForPurchasing exactly. Two sources
// feed the same PR: "Q" items (is_temp_item — not in the catalog at all) and
// real-product shortfalls with no branch coverage
// (work_order_item_sources.branch_id IS NULL). Customer-supplied items are
// never swept up here — they're never purchased.
async function flagWorkOrderItemsForPurchasing(workOrder) {
  try {
    const { rows: unflaggedQItems } = await db.execute({ sql: 'SELECT * FROM work_order_items WHERE work_order_id = ? AND is_temp_item = 1 AND purchase_request_id IS NULL', args: [workOrder.id] });
    const { rows: shortfalls } = await db.execute({
      sql: `SELECT wis.id as source_id, woi.id as item_id, woi.product_id, woi.product_name, woi.unit_cost, wis.quantity
            FROM work_order_item_sources wis JOIN work_order_items woi ON wis.work_order_item_id = woi.id
            WHERE woi.work_order_id = ? AND wis.branch_id IS NULL AND wis.purchase_request_item_id IS NULL`,
      args: [workOrder.id],
    });
    if (!unflaggedQItems.length && !shortfalls.length) return;

    const prId = await ensureWorkOrderPR(workOrder);

    for (const item of unflaggedQItems) {
      const total = parseFloat((item.unit_cost * item.quantity).toFixed(2));
      await db.execute({
        sql: 'INSERT INTO purchase_request_items (pr_id, product_name, quantity, unit_cost, item_type, notes, total, work_order_item_id) VALUES (?,?,?,?,?,?,?,?)',
        args: [prId, item.product_name, item.quantity, item.unit_cost, 'sale', `Non-stocked item needed for work order ${workOrder.wo_number}`, total, item.id],
      });
      await db.execute({ sql: 'UPDATE work_order_items SET purchase_request_id = ? WHERE id = ?', args: [prId, item.id] });
    }

    for (const s of shortfalls) {
      const total = parseFloat((s.unit_cost * s.quantity).toFixed(2));
      const result = await db.execute({
        sql: 'INSERT INTO purchase_request_items (pr_id, product_id, product_name, quantity, unit_cost, item_type, notes, total, work_order_item_id) VALUES (?,?,?,?,?,?,?,?,?)',
        args: [prId, s.product_id, s.product_name, s.quantity, s.unit_cost, 'sale', `No branch had enough stock — needed for work order ${workOrder.wo_number}`, total, s.item_id],
      });
      await db.execute({ sql: 'UPDATE work_order_item_sources SET purchase_request_item_id = ? WHERE id = ?', args: [Number(result.lastInsertRowid), s.source_id] });
      await db.execute({ sql: 'UPDATE work_order_items SET purchase_request_id = ? WHERE id = ?', args: [prId, s.item_id] });
    }
  } catch(e) { /* non-fatal: confirming parts itself already succeeded */ }
}

async function processWorkOrderPartSourcing(workOrder) {
  await processWorkOrderPartTransfers(workOrder);
  await flagWorkOrderItemsForPurchasing(workOrder);
}

module.exports = { processWorkOrderItems, processWorkOrderPartSourcing };
