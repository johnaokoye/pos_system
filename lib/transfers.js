const { syncBinQty } = require('./binSync');
const { getOutstandingQty, getOutOfServiceQty } = require('./rentalAvailability');

// Validates source stock and deducts branch_inventory + products.stock_qty
// (syncing bin quantities) for each { product_id, quantity }. Assumes an
// already-open write tx. Used when a transfer is created ready to go
// (createTransfer) and when a transfer request is sent (PATCH /:id/send).
async function deductTransferStock(tx, from_branch_id, items) {
  for (const item of items) {
    const { rows: [product] } = await tx.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] });
    if (!product) throw new Error(`Product ${item.product_id} not found`);
    const qty = parseInt(item.quantity);
    if (!qty || qty <= 0) throw new Error(`Invalid quantity for ${product.name}`);

    const { rows: [srcInv] } = await tx.execute({ sql: 'SELECT * FROM branch_inventory WHERE product_id = ? AND branch_id = ?', args: [item.product_id, from_branch_id] });
    const srcQty = srcInv ? srcInv.stock_qty : product.stock_qty;
    // A rental item's stock_qty is the total owned count — checkout/return never
    // touch it (see lib/rentalAvailability.js), so units out on (or held for) a
    // rental from this branch have to be subtracted here or a transfer could
    // carry away stock a customer still physically has. No-op for non-rental
    // products (no rental_agreement_items ever reference them).
    const outstanding = await getOutstandingQty(tx, item.product_id, from_branch_id);
    const outOfService = await getOutOfServiceQty(tx, item.product_id, from_branch_id);
    const availableQty = srcQty - outstanding - outOfService;
    if (availableQty < qty) throw new Error(`Insufficient available stock for ${product.name} at source branch (available: ${availableQty}${outstanding > 0 ? `, ${outstanding} currently out on rental` : ''}${outOfService > 0 ? `, ${outOfService} out of service` : ''})`);

    if (srcInv) {
      await tx.execute({ sql: 'UPDATE branch_inventory SET stock_qty = stock_qty - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND branch_id = ?', args: [qty, item.product_id, from_branch_id] });
    } else {
      await tx.execute({ sql: 'INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)', args: [item.product_id, from_branch_id, srcQty - qty, product.min_stock] });
    }
    await syncBinQty(tx, item.product_id, from_branch_id, -qty);
    await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?', args: [qty, item.product_id] });
  }
}

// Adds stock to a branch (branch_inventory, bins, products.stock_qty) — a
// transfer arriving, or a cancelled one going back to its source.
async function addTransferStock(tx, branch_id, product_id, qty) {
  await tx.execute({ sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at) VALUES (?, ?, ?, (SELECT min_stock FROM products WHERE id = ?), CURRENT_TIMESTAMP) ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP`, args: [product_id, branch_id, qty, product_id, qty] });
  await syncBinQty(tx, product_id, branch_id, qty);
  await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [qty, product_id] });
}

// Inserts branch_transfers + branch_transfer_items. With `request: true` the
// transfer starts as a request (status 'requested') and no stock moves until
// the inventory team sends it; otherwise stock is deducted now and it starts
// 'pending' (ready for pickup). Assumes an already-open write tx — caller
// commits/rolls back. Returns the new transfer id.
// quote_id links the transfer back to the quotation that auto-created it (null for
// manual transfers created directly from the Transfers UI).
async function createTransfer(tx, { transfer_number, from_branch_id, to_branch_id, employee_id, items, notes, quote_id, request = false }) {
  if (request) {
    for (const item of items) {
      const qty = parseInt(item.quantity);
      if (!qty || qty <= 0) throw new Error('Every item needs a quantity of at least 1');
    }
  } else {
    await deductTransferStock(tx, from_branch_id, items);
  }

  // A transfer created ready to go counts as sent by its creator, now.
  const result = await tx.execute({ sql: 'INSERT INTO branch_transfers (transfer_number, from_branch_id, to_branch_id, employee_id, notes, quote_id, status, sent_by, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [transfer_number, from_branch_id, to_branch_id, employee_id || null, notes || null, quote_id || null, request ? 'requested' : 'pending', request ? null : (employee_id || null), request ? null : new Date().toISOString()] });
  const transferId = Number(result.lastInsertRowid);

  for (const item of items) {
    const { rows: [product] } = await tx.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] });
    if (!product) throw new Error(`Product ${item.product_id} not found`);
    const qty = parseInt(item.quantity);
    await tx.execute({ sql: 'INSERT INTO branch_transfer_items (transfer_id, product_id, product_name, sku, quantity_requested, quantity_asked) VALUES (?, ?, ?, ?, ?, ?)', args: [transferId, item.product_id, product.name, product.sku, qty, qty] });
  }

  return transferId;
}

module.exports = { createTransfer, deductTransferStock, addTransferStock };
