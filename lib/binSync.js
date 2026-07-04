// Keeps product_bin_assignments.quantity in step with branch_inventory.stock_qty.
// Bin assignments have no other source of truth, so every place that adjusts
// branch_inventory for a product+branch must also call this with the same delta.
async function syncBinQty(executor, product_id, branch_id, delta) {
  if (!branch_id || !delta) return;
  const { rows } = await executor.execute({
    sql: 'SELECT id FROM product_bin_assignments WHERE product_id = ? AND branch_id = ? ORDER BY is_primary DESC, id ASC LIMIT 1',
    args: [product_id, branch_id],
  });
  if (!rows.length) return;
  await executor.execute({
    sql: 'UPDATE product_bin_assignments SET quantity = MAX(0, quantity + ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    args: [delta, rows[0].id],
  });
}

module.exports = { syncBinQty };
