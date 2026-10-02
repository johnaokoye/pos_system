// Single source of truth for "how many units of a rental product are
// currently checked out." Used by routes/products.js (catalog "available"
// display) and routes/rentals.js (the checkout guard) so both stay in sync.
// When branchId is given, only counts agreements checked out from that
// branch — availability is location-scoped, matching branch_inventory.
async function getOutstandingQty(executor, productId, branchId) {
  // 'pending' agreements (held for a cashier to finalize payment on — see
  // routes/rentals.js) reserve stock too, same as 'active' ones, so the item
  // can't be double-booked by someone else while it's awaiting checkout.
  // 'awaiting_issue' (paid but not yet issued/dispatched) reserves it too —
  // it's out the door in every sense except the physical handover.
  let sql = `SELECT COALESCE(SUM(rai.quantity - rai.quantity_returned),0) as qty
        FROM rental_agreement_items rai
        JOIN rental_agreements ra ON rai.agreement_id = ra.id
        WHERE rai.product_id = ? AND ra.status IN ('active', 'pending', 'awaiting_issue')`;
  const args = [productId];
  if (branchId) { sql += ' AND ra.branch_id = ?'; args.push(branchId); }
  const { rows: [row] } = await executor.execute({ sql, args });
  return Number(row.qty) || 0;
}

// Units held out of service (see rental_out_of_service in database.js —
// e.g. a faulty unit swapped out by a rental replacement). They're still in
// stock_qty but can't be rented or transferred until returned to service, so
// every availability check subtracts this alongside getOutstandingQty.
async function getOutOfServiceQty(executor, productId, branchId) {
  let sql = 'SELECT COALESCE(SUM(quantity),0) as qty FROM rental_out_of_service WHERE product_id = ? AND returned_to_service_at IS NULL';
  const args = [productId];
  if (branchId) { sql += ' AND branch_id = ?'; args.push(branchId); }
  const { rows: [row] } = await executor.execute({ sql, args });
  return Number(row.qty) || 0;
}

module.exports = { getOutstandingQty, getOutOfServiceQty };
