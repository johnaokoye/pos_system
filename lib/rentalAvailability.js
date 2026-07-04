// Single source of truth for "how many units of a rental product are
// currently checked out." Used by routes/products.js (catalog "available"
// display) and routes/rentals.js (the checkout guard) so both stay in sync.
async function getOutstandingQty(executor, productId) {
  const { rows: [row] } = await executor.execute({
    sql: `SELECT COALESCE(SUM(rai.quantity - rai.quantity_returned),0) as qty
          FROM rental_agreement_items rai
          JOIN rental_agreements ra ON rai.agreement_id = ra.id
          WHERE rai.product_id = ? AND ra.status = 'active'`,
    args: [productId],
  });
  return Number(row.qty) || 0;
}

module.exports = { getOutstandingQty };
