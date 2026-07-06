// Single source of truth for "how many units of a rental product are
// currently checked out." Used by routes/products.js (catalog "available"
// display) and routes/rentals.js (the checkout guard) so both stay in sync.
// When branchId is given, only counts agreements checked out from that
// branch — availability is location-scoped, matching branch_inventory.
async function getOutstandingQty(executor, productId, branchId) {
  let sql = `SELECT COALESCE(SUM(rai.quantity - rai.quantity_returned),0) as qty
        FROM rental_agreement_items rai
        JOIN rental_agreements ra ON rai.agreement_id = ra.id
        WHERE rai.product_id = ? AND ra.status = 'active'`;
  const args = [productId];
  if (branchId) { sql += ' AND ra.branch_id = ?'; args.push(branchId); }
  const { rows: [row] } = await executor.execute({ sql, args });
  return Number(row.qty) || 0;
}

module.exports = { getOutstandingQty };
