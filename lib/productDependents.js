// Tables that hold a *real* business record referencing a product. If any of
// these have a row for a product, deleting that product would orphan or
// corrupt that record (a completed sale, a received PO, a logged stock
// adjustment, ...) — so callers that bulk-delete products (import Reverse,
// for now) must exclude anything found here rather than delete it, even
// though the DB's own FK constraints would eventually block most of these
// anyway. Checking up front lets the caller report *why* a product survived
// instead of the whole operation dying on a raw SQLITE_CONSTRAINT error.
//
// Deliberately excludes: branch_inventory and product_bin_assignments (pure
// current-state config, safe to delete alongside the product) and
// product_variations / product_variation_types (already ON DELETE CASCADE).
const DEPENDENT_TABLES = [
  'transaction_items', 'purchase_order_items', 'quotation_items',
  'branch_transfer_items', 'work_order_items', 'shipment_items',
  'rental_agreement_items', 'layaway_plan_items', 'cycle_count_items',
  'purchase_request_items', 'return_items', 'stock_movements',
];

// Returns a Map<productId, string[]> of reasons a product can't be deleted —
// empty entries mean the id is clean. Only ids present in the returned map
// have a reason; absent ids are safe.
async function findDependentProductIds(db, productIds) {
  const reasons = new Map();
  if (!productIds.length) return reasons;
  const add = (id, reason) => {
    if (!reasons.has(id)) reasons.set(id, []);
    reasons.get(id).push(reason);
  };
  const placeholders = productIds.map(() => '?').join(',');

  for (const table of DEPENDENT_TABLES) {
    const { rows } = await db.execute({
      sql: `SELECT DISTINCT product_id FROM ${table} WHERE product_id IN (${placeholders})`,
      args: productIds,
    });
    rows.forEach(r => add(r.product_id, table));
  }

  const { rows: accRows } = await db.execute({
    sql: `SELECT DISTINCT product_id as id, 'product_accessories' as reason FROM product_accessories WHERE product_id IN (${placeholders})
          UNION SELECT DISTINCT accessory_product_id as id, 'product_accessories' as reason FROM product_accessories WHERE accessory_product_id IN (${placeholders})`,
    args: [...productIds, ...productIds],
  });
  accRows.forEach(r => add(r.id, r.reason));

  const { rows: selfRefRows } = await db.execute({
    sql: `SELECT DISTINCT used_of_product_id as id, 'used_of_product_id' as reason FROM products WHERE used_of_product_id IN (${placeholders})
          UNION SELECT DISTINCT merged_into_product_id as id, 'merged_into_product_id' as reason FROM products WHERE merged_into_product_id IN (${placeholders})`,
    args: [...productIds, ...productIds],
  });
  selfRefRows.forEach(r => add(r.id, r.reason));

  return reasons;
}

module.exports = { findDependentProductIds, DEPENDENT_TABLES };
