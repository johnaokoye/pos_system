const { db } = require('../database');

// Tables where a straight UPDATE product_id can never collide with an
// existing row on the target (no UNIQUE constraint on product_id there) —
// safe to repoint in one statement each.
const SIMPLE_REPOINT_TABLES = [
  'transaction_items', 'purchase_order_items', 'quotation_items', 'stock_movements',
  'branch_transfer_items', 'work_order_items', 'shipment_items', 'rental_agreement_items',
  'cycle_count_items', 'purchase_request_items', 'return_items', 'layaway_plan_items',
];

// Consolidates a "duplicate" product (source) into the surviving product
// (target): combines stock (global + per-branch), repoints every table that
// references the source by product_id onto the target, and retires the
// source (deactivated, tagged merged_into_product_id) rather than deleting
// it — so anything that still names it (an old receipt, a stale report)
// keeps resolving to a real row. Runs in one write transaction; throws
// (and leaves nothing changed) if either product is ineligible.
async function mergeProducts(sourceId, targetId) {
  const { rows: [source] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [sourceId] });
  const { rows: [target] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [targetId] });
  if (!source) throw new Error('Product to merge not found');
  if (!target) throw new Error('Target product not found');
  if (source.id === target.id) throw new Error('Cannot merge a product into itself');
  if (source.merged_into_product_id) throw new Error(`${source.name} has already been merged into another product`);
  if (target.merged_into_product_id) throw new Error(`${target.name} has already been merged into another product — merge into its surviving record instead`);
  if (source.is_rental || target.is_rental) throw new Error('Rental items cannot be merged — see the Rental Items screen instead');
  const { rows: [variants] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM product_variations WHERE product_id IN (?,?) AND active = 1', args: [sourceId, targetId] });
  if (Number(variants.c) > 0) throw new Error('A product with active variations cannot be merged');

  const tx = await db.transaction('write');
  try {
    // Combine global + per-branch stock onto the target.
    await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [source.stock_qty || 0, targetId] });
    const { rows: sourceBI } = await tx.execute({ sql: 'SELECT * FROM branch_inventory WHERE product_id = ?', args: [sourceId] });
    for (const bi of sourceBI) {
      await tx.execute({
        sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP`,
        args: [targetId, bi.branch_id, bi.stock_qty, bi.min_stock, bi.stock_qty],
      });
    }
    await tx.execute({ sql: 'DELETE FROM branch_inventory WHERE product_id = ?', args: [sourceId] });

    for (const table of SIMPLE_REPOINT_TABLES) {
      await tx.execute({ sql: `UPDATE ${table} SET product_id = ? WHERE product_id = ?`, args: [targetId, sourceId] });
    }

    // Bin assignments carry a UNIQUE(product_id, bin_id) — if the target is
    // already assigned to the same bin, fold the source's quantity into that
    // row instead of repointing (which would collide).
    const { rows: sourceBins } = await tx.execute({ sql: 'SELECT * FROM product_bin_assignments WHERE product_id = ?', args: [sourceId] });
    for (const b of sourceBins) {
      const { rows: [existing] } = await tx.execute({ sql: 'SELECT * FROM product_bin_assignments WHERE product_id = ? AND bin_id = ?', args: [targetId, b.bin_id] });
      if (existing) {
        await tx.execute({ sql: 'UPDATE product_bin_assignments SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', args: [b.quantity, existing.id] });
        await tx.execute({ sql: 'DELETE FROM product_bin_assignments WHERE id = ?', args: [b.id] });
      } else {
        await tx.execute({ sql: 'UPDATE product_bin_assignments SET product_id = ? WHERE id = ?', args: [targetId, b.id] });
      }
    }

    // Accessory links (product_accessories) — UNIQUE(product_id,
    // accessory_product_id) in both directions the source could appear in;
    // drop the source's row instead of repointing wherever the target
    // already has the equivalent link.
    for (const [col, otherCol] of [['product_id', 'accessory_product_id'], ['accessory_product_id', 'product_id']]) {
      const { rows } = await tx.execute({ sql: `SELECT * FROM product_accessories WHERE ${col} = ?`, args: [sourceId] });
      for (const row of rows) {
        const { rows: [existing] } = await tx.execute({ sql: `SELECT id FROM product_accessories WHERE ${col} = ? AND ${otherCol} = ?`, args: [targetId, row[otherCol]] });
        if (existing) await tx.execute({ sql: 'DELETE FROM product_accessories WHERE id = ?', args: [row.id] });
        else await tx.execute({ sql: `UPDATE product_accessories SET ${col} = ? WHERE id = ?`, args: [targetId, row.id] });
      }
    }

    // Promotion product assignments — UNIQUE(promotion_id, item_type, item_id).
    const { rows: promoRows } = await tx.execute({ sql: `SELECT * FROM promotion_items WHERE item_type = 'product' AND item_id = ?`, args: [sourceId] });
    for (const row of promoRows) {
      const { rows: [existing] } = await tx.execute({ sql: `SELECT id FROM promotion_items WHERE promotion_id = ? AND item_type = 'product' AND item_id = ?`, args: [row.promotion_id, targetId] });
      if (existing) await tx.execute({ sql: 'DELETE FROM promotion_items WHERE id = ?', args: [row.id] });
      else await tx.execute({ sql: 'UPDATE promotion_items SET item_id = ? WHERE id = ?', args: [targetId, row.id] });
    }

    // WooCommerce sync map — UNIQUE(entity_type, local_id); if the target is
    // already mapped to a remote product, the source's mapping is just stale.
    const { rows: [wooExisting] } = await tx.execute({ sql: `SELECT id FROM woo_sync_map WHERE entity_type = 'product' AND local_id = ?`, args: [targetId] });
    if (wooExisting) {
      await tx.execute({ sql: `DELETE FROM woo_sync_map WHERE entity_type = 'product' AND local_id = ?`, args: [sourceId] });
    } else {
      await tx.execute({ sql: `UPDATE woo_sync_map SET local_id = ? WHERE entity_type = 'product' AND local_id = ?`, args: [targetId, sourceId] });
    }

    // A "(Used)" sibling of the source (see routes/work-orders.js's part
    // returns) now belongs to the target instead.
    await tx.execute({ sql: 'UPDATE products SET used_of_product_id = ? WHERE used_of_product_id = ?', args: [targetId, sourceId] });

    if (source.stock_qty) {
      await tx.execute({
        sql: 'INSERT INTO stock_movements (product_id, quantity_change, type, reference, reason) VALUES (?,?,?,?,?)',
        args: [targetId, source.stock_qty, 'merge', source.sku, `Merged in from ${source.sku} (${source.name})`],
      });
    }

    await tx.execute({
      sql: 'UPDATE products SET stock_qty = 0, active = 0, merged_into_product_id = ?, merged_at = CURRENT_TIMESTAMP WHERE id = ?',
      args: [targetId, sourceId],
    });

    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }

  const { rows: [updatedTarget] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [targetId] });
  return updatedTarget;
}

module.exports = { mergeProducts };
