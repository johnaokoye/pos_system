// An item's stock at one branch, for checks that decide whether stock can
// leave it (transfers, layaways). No branch_inventory row there = none there,
// which is what every branch screen shows. Only an item with no branch rows at
// all (a single-branch setup) reads its overall products.stock_qty — reading
// that for a branch merely missing a row let stock it never had leave it, and
// a record for it be made up out of the company-wide figure.
async function branchStockQty(executor, product, branchId) {
  const { rows: [bi] } = await executor.execute({ sql: 'SELECT stock_qty FROM branch_inventory WHERE product_id = ? AND branch_id = ?', args: [product.id, branchId] });
  if (bi) return Number(bi.stock_qty) || 0;
  const { rows: [anyRow] } = await executor.execute({ sql: 'SELECT 1 FROM branch_inventory WHERE product_id = ? LIMIT 1', args: [product.id] });
  return anyRow ? 0 : Number(product.stock_qty) || 0;
}

// Nothing is sold straight from a warehouse branch (branches.is_warehouse —
// the owner's rule): a store sells warehouse stock with Get from here
// (lib/saleTransfers.js), which raises a transfer to the selling store. Returns
// the refusal message for a till sale / hold / layaway at a warehouse, else null.
async function warehouseSaleError(executor, branchId) {
  if (!branchId) return null;
  const { rows: [b] } = await executor.execute({ sql: 'SELECT name, is_warehouse FROM branches WHERE id = ?', args: [branchId] });
  return b && Number(b.is_warehouse) ? `${b.name} is a warehouse — items can't be sold there directly. Sell from a store and use "Get from here" to have them sent over.` : null;
}

module.exports = { branchStockQty, warehouseSaleError };
