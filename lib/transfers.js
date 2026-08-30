const { syncBinQty } = require('./binSync');
const { getOutstandingQty } = require('./rentalAvailability');

// Validates source stock, deducts branch_inventory + products.stock_qty, syncs bin
// quantities, and inserts branch_transfers + branch_transfer_items. Assumes an
// already-open write tx — caller commits/rolls back. Returns the new transfer id.
// quote_id links the transfer back to the quotation that auto-created it (null for
// manual transfers created directly from the Transfers UI).
async function createTransfer(tx, { transfer_number, from_branch_id, to_branch_id, employee_id, items, notes, quote_id }) {
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
    const availableQty = srcQty - outstanding;
    if (availableQty < qty) throw new Error(`Insufficient available stock for ${product.name} at source branch (available: ${availableQty}${outstanding > 0 ? `, ${outstanding} currently out on rental` : ''})`);

    if (srcInv) {
      await tx.execute({ sql: 'UPDATE branch_inventory SET stock_qty = stock_qty - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND branch_id = ?', args: [qty, item.product_id, from_branch_id] });
    } else {
      await tx.execute({ sql: 'INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)', args: [item.product_id, from_branch_id, srcQty - qty, product.min_stock] });
    }
    await syncBinQty(tx, item.product_id, from_branch_id, -qty);
    await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?', args: [qty, item.product_id] });
  }

  const result = await tx.execute({ sql: 'INSERT INTO branch_transfers (transfer_number, from_branch_id, to_branch_id, employee_id, notes, quote_id) VALUES (?, ?, ?, ?, ?, ?)', args: [transfer_number, from_branch_id, to_branch_id, employee_id || null, notes || null, quote_id || null] });
  const transferId = Number(result.lastInsertRowid);

  for (const item of items) {
    const { rows: [product] } = await tx.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] });
    await tx.execute({ sql: 'INSERT INTO branch_transfer_items (transfer_id, product_id, product_name, sku, quantity_requested) VALUES (?, ?, ?, ?, ?)', args: [transferId, item.product_id, product.name, product.sku, parseInt(item.quantity)] });
  }

  return transferId;
}

module.exports = { createTransfer };
