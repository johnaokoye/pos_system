const { getOutstandingQty } = require('./rentalAvailability');
const { calculateRentalFee } = require('./rentalPricing');

// A rental item's "stock" is location-scoped once a branch is given — falls
// back to the global products.stock_qty when no branch is specified,
// matching how branch_inventory works everywhere else.
async function getBranchStock(executor, productId, branchId, globalStockQty) {
  if (!branchId) return globalStockQty;
  const { rows: [bi] } = await executor.execute({ sql: 'SELECT stock_qty FROM branch_inventory WHERE product_id = ? AND branch_id = ?', args: [productId, branchId] });
  return bi ? bi.stock_qty : 0;
}

function feeFor(product, qty, startDateTime, endDateTime) {
  const { fee } = calculateRentalFee({
    classification: product.rental_classification || 'tool',
    dailyRate: product.rental_rate,
    weeklyRate: product.rental_weekly_rate,
    monthlyRate: product.rental_monthly_rate,
    hourlyRate: product.rental_hourly_rate,
    startDateTime, endDateTime,
  });
  return parseFloat((fee * qty).toFixed(2));
}

async function checkAvailability(executor, product, qty, branchId, { asAccessory = false } = {}) {
  const branchStock = await getBranchStock(executor, product.id, branchId, product.stock_qty);
  const outstanding = await getOutstandingQty(executor, product.id, branchId);
  const available = branchStock - outstanding;
  if (qty > available) {
    throw new Error(asAccessory
      ? `Cannot include accessory "${product.name}" — only ${available} available at this location`
      : `Cannot check out ${qty} of "${product.name}" at this location — only ${available} available`);
  }
  return available;
}

// Validates raw picks ({product_id, quantity, condition_out, accessory_ids})
// against is_rental + branch-scoped availability, and expands mandatory +
// selected-optional accessories into a flat lines array: {product, quantity,
// isMandatory, parentIndex (index into this same array, or null), condition_out}.
// Throws a user-facing Error on any validation failure.
async function buildRentalLines(executor, { branch_id, items }) {
  const lines = [];
  for (const item of items) {
    const { rows: [product] } = await executor.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] });
    if (!product) throw new Error(`Product ${item.product_id} not found`);
    if (!product.is_rental) throw new Error(`"${product.name}" is not a rental item`);
    const qty = parseInt(item.quantity) || 1;
    await checkAvailability(executor, product, qty, branch_id);

    const parentIndex = lines.length;
    lines.push({ product, quantity: qty, isMandatory: false, parentIndex: null, condition_out: item.condition_out || null });

    const { rows: accessories } = await executor.execute({ sql: 'SELECT * FROM product_accessories WHERE product_id = ?', args: [item.product_id] });
    const selectedOptionalIds = (item.accessory_ids || []).map(Number);
    for (const acc of accessories) {
      const isMandatory = !!acc.is_mandatory;
      if (!isMandatory && !selectedOptionalIds.includes(acc.accessory_product_id)) continue;
      const { rows: [accProduct] } = await executor.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [acc.accessory_product_id] });
      if (!accProduct || !accProduct.is_rental) continue;
      await checkAvailability(executor, accProduct, qty, branch_id, { asAccessory: true });
      lines.push({ product: accProduct, quantity: qty, isMandatory, parentIndex, condition_out: null });
    }
  }
  return lines;
}

// Re-validates an already-expanded item list (quotation_items rows from a
// rental quote, fetched in insertion order so parents precede their
// accessory children) against CURRENT stock at convert time — stock may
// have shifted since the quote was drafted. Remaps
// quotation_items.parent_item_id (a row id) to a lines-array index, since
// insertPendingAgreement expects the same {product, quantity, isMandatory,
// parentIndex, condition_out} shape buildRentalLines produces. Every
// quotationItems entry produces exactly one lines entry (no filtering), so
// array indices line up 1:1.
async function revalidateQuoteLines(executor, { branch_id, quotationItems }) {
  const idToIndex = {};
  quotationItems.forEach((qi, i) => { idToIndex[qi.id] = i; });

  const lines = [];
  for (const qi of quotationItems) {
    if (!qi.product_id) throw new Error(`Rental quote item "${qi.product_name}" has no linked product`);
    const { rows: [product] } = await executor.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [qi.product_id] });
    if (!product) throw new Error(`Product "${qi.product_name}" no longer exists`);
    if (!product.is_rental) throw new Error(`"${product.name}" is no longer a rental item`);
    const parentIndex = qi.parent_item_id != null ? idToIndex[qi.parent_item_id] : null;
    await checkAvailability(executor, product, qi.quantity, branch_id, { asAccessory: parentIndex != null });
    lines.push({ product, quantity: qi.quantity, isMandatory: !!qi.is_mandatory, parentIndex, condition_out: qi.condition_out || null });
  }
  return lines;
}

// Inserts the rental_agreements row (status='pending') + rental_agreement_items,
// then a second pass wiring up parent_item_id (needs real row ids post-insert).
// Rates/classification/tax are snapshotted now; rental_fee/deposit_amount are
// computed at finalize time instead (PATCH .../checkout), since they depend
// on the actual checkout instant, which isn't known yet. Caller owns
// tx.commit()/rollback() — this does not create or close the transaction.
async function insertPendingAgreement(tx, { agreement_number, customer_id, employee_id, branch_id, due_date, notes, lines }) {
  const agResult = await tx.execute({ sql: `INSERT INTO rental_agreements (agreement_number,customer_id,employee_id,branch_id,status,due_date,deposit_total,notes) VALUES (?,?,?,?,?,?,?,?)`, args: [agreement_number, customer_id, employee_id || null, branch_id || null, 'pending', due_date, 0, notes || null] });
  const agreementId = Number(agResult.lastInsertRowid);

  for (const line of lines) {
    const p = line.product;
    await tx.execute({ sql: `INSERT INTO rental_agreement_items
      (agreement_id,parent_item_id,product_id,product_name,sku,quantity,rate_type,rate_amount,rental_classification,daily_rate,weekly_rate,monthly_rate,hourly_rate,tax_rate,is_mandatory,rental_fee,deposit_amount,replacement_value,condition_out)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [agreementId, null, p.id, p.name, p.sku, line.quantity, 'daily', p.rental_rate || 0, p.rental_classification || 'tool', p.rental_rate || 0, p.rental_weekly_rate || 0, p.rental_monthly_rate || 0, p.rental_hourly_rate || 0, p.tax_rate || 0, line.isMandatory ? 1 : 0, 0, 0, p.replacement_value || 0, line.condition_out] });
  }
  // parent_item_id needs the real row ids, which only exist after the
  // insert above — set them in a second pass rather than threading
  // lastInsertRowid through the accessory-grouping logic.
  const { rows: insertedItems } = await tx.execute({ sql: 'SELECT id FROM rental_agreement_items WHERE agreement_id = ? ORDER BY id', args: [agreementId] });
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].parentIndex != null) {
      await tx.execute({ sql: 'UPDATE rental_agreement_items SET parent_item_id = ? WHERE id = ?', args: [insertedItems[lines[i].parentIndex].id, insertedItems[i].id] });
    }
  }
  return agreementId;
}

module.exports = { getBranchStock, feeFor, buildRentalLines, revalidateQuoteLines, insertPendingAgreement };
