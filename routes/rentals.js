const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { getOutstandingQty } = require('../lib/rentalAvailability');
const { calculateRentalFee } = require('../lib/rentalPricing');
const { requirePermission } = require('../lib/permissions');

// ─── Agreements list/detail ───────────────────────────────────────────────

router.get('/agreements', requirePermission('rentals'), async (req, res) => {
  try {
    const { customer_id, branch_id, view } = req.query;
    let sql = `SELECT ra.*, c.first_name || ' ' || c.last_name as customer_name,
      b.name as branch_name, e.first_name || ' ' || e.last_name as employee_name,
      (SELECT COUNT(*) FROM rental_agreement_items WHERE agreement_id = ra.id AND parent_item_id IS NULL) as item_count,
      CASE WHEN ra.status = 'active' AND ra.due_date < date('now') THEN 'overdue' ELSE ra.status END as display_status
      FROM rental_agreements ra
      LEFT JOIN customers c ON ra.customer_id = c.id
      LEFT JOIN branches b ON ra.branch_id = b.id
      LEFT JOIN employees e ON ra.employee_id = e.id
      WHERE 1=1`;
    const params = [];
    if (customer_id) { sql += ' AND ra.customer_id = ?'; params.push(customer_id); }
    if (branch_id) { sql += ' AND ra.branch_id = ?'; params.push(branch_id); }
    if (view === 'overdue') { sql += " AND ra.status = 'active' AND ra.due_date < date('now')"; }
    else if (view === 'active') { sql += " AND ra.status = 'active'"; }
    else if (view === 'returned' || view === 'cancelled') { sql += ' AND ra.status = ?'; params.push(view); }
    sql += ' ORDER BY ra.created_at DESC LIMIT 200';
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/agreements/:id', requirePermission('rentals'), async (req, res) => {
  try {
    const { rows: [agreement] } = await db.execute({ sql: `SELECT ra.*, c.first_name || ' ' || c.last_name as customer_name,
      c.phone as customer_phone, c.email as customer_email,
      b.name as branch_name, e.first_name || ' ' || e.last_name as employee_name,
      co.transaction_number as checkout_transaction_number,
      se.transaction_number as settlement_transaction_number,
      CASE WHEN ra.status = 'active' AND ra.due_date < date('now') THEN 'overdue' ELSE ra.status END as display_status
      FROM rental_agreements ra
      LEFT JOIN customers c ON ra.customer_id = c.id
      LEFT JOIN branches b ON ra.branch_id = b.id
      LEFT JOIN employees e ON ra.employee_id = e.id
      LEFT JOIN transactions co ON ra.checkout_transaction_id = co.id
      LEFT JOIN transactions se ON ra.settlement_transaction_id = se.id
      WHERE ra.id = ?`, args: [req.params.id] });
    if (!agreement) return res.status(404).json({ error: 'Not found' });
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [req.params.id] });
    agreement.items = items;
    res.json(agreement);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Availability ───────────────────────────────────────────────────────────

// A rental item's "stock" is location-scoped once a branch is given — falls
// back to the global products.stock_qty when no branch is specified (e.g. the
// catalog-wide view), matching how branch_inventory works everywhere else.
async function getBranchStock(executor, productId, branchId, globalStockQty) {
  if (!branchId) return globalStockQty;
  const { rows: [bi] } = await executor.execute({ sql: 'SELECT stock_qty FROM branch_inventory WHERE product_id = ? AND branch_id = ?', args: [productId, branchId] });
  return bi ? bi.stock_qty : 0;
}

router.get('/availability', requirePermission('rentals'), async (req, res) => {
  try {
    const { product_id, branch_id } = req.query;
    if (!product_id) return res.status(400).json({ error: 'product_id is required' });
    const { rows: [product] } = await db.execute({ sql: 'SELECT id, name, stock_qty FROM products WHERE id = ?', args: [product_id] });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const stockQty = await getBranchStock(db, product_id, branch_id, product.stock_qty);
    const outstanding = await getOutstandingQty(db, product_id, branch_id || null);
    res.json({ product_id: product.id, stock_qty: stockQty, outstanding_qty: outstanding, available_qty: Math.max(0, stockQty - outstanding) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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

// ─── Checkout ───────────────────────────────────────────────────────────────

router.post('/agreements', requirePermission('rentals_checkout'), async (req, res) => {
  try {
    const { customer_id, employee_id, branch_id, drawer_session_id, due_date, items, payment_method, amount_tendered, notes } = req.body;
    if (!customer_id) return res.status(400).json({ error: 'A customer is required for rental checkout' });
    if (!branch_id) return res.status(400).json({ error: 'A branch/location is required for rental checkout' });
    if (!due_date) return res.status(400).json({ error: 'Due date is required' });
    if (!items || !items.length) return res.status(400).json({ error: 'At least one rental item is required' });

    const checkoutDateTime = new Date();
    // Due back by the same time-of-day as checkout, on the chosen due date —
    // needed so hour-level proration has a real instant to measure against,
    // not just a bare calendar date.
    const dueDateTime = new Date(`${due_date}T${checkoutDateTime.toISOString().slice(11, 19)}.000Z`);

    const lines = []; // flat list of { product, quantity, isMandatory, parentIndex (or null) }
    for (const item of items) {
      const { rows: [product] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] });
      if (!product) return res.status(400).json({ error: `Product ${item.product_id} not found` });
      if (!product.is_rental) return res.status(400).json({ error: `"${product.name}" is not a rental item` });
      const qty = parseInt(item.quantity) || 1;
      const branchStock = await getBranchStock(db, product.id, branch_id, product.stock_qty);
      const outstanding = await getOutstandingQty(db, product.id, branch_id);
      const available = branchStock - outstanding;
      if (qty > available) return res.status(400).json({ error: `Cannot check out ${qty} of "${product.name}" at this location — only ${available} available` });

      const parentIndex = lines.length;
      lines.push({ product, quantity: qty, isMandatory: false, parentIndex: null, condition_out: item.condition_out || null });

      const { rows: accessories } = await db.execute({ sql: 'SELECT * FROM product_accessories WHERE product_id = ?', args: [item.product_id] });
      const selectedOptionalIds = (item.accessory_ids || []).map(Number);
      for (const acc of accessories) {
        const isMandatory = !!acc.is_mandatory;
        if (!isMandatory && !selectedOptionalIds.includes(acc.accessory_product_id)) continue;
        const { rows: [accProduct] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [acc.accessory_product_id] });
        if (!accProduct || !accProduct.is_rental) continue;
        const accBranchStock = await getBranchStock(db, accProduct.id, branch_id, accProduct.stock_qty);
        const accOutstanding = await getOutstandingQty(db, accProduct.id, branch_id);
        const accAvailable = accBranchStock - accOutstanding;
        if (qty > accAvailable) return res.status(400).json({ error: `Cannot include accessory "${accProduct.name}" — only ${accAvailable} available at this location` });
        lines.push({ product: accProduct, quantity: qty, isMandatory, parentIndex, condition_out: null });
      }
    }

    let rentalSubtotal = 0, taxAmount = 0, depositTotal = 0;
    for (const line of lines) {
      line.rentalFee = line.isMandatory ? 0 : feeFor(line.product, line.quantity, checkoutDateTime, dueDateTime);
      line.depositAmount = line.rentalFee; // deposit == fee (double-charge model)
      line.lineTax = parseFloat((line.rentalFee * (line.product.tax_rate || 0) / 100).toFixed(2));
      rentalSubtotal += line.rentalFee;
      taxAmount += line.lineTax;
      depositTotal += line.depositAmount;
    }
    rentalSubtotal = parseFloat(rentalSubtotal.toFixed(2));
    taxAmount = parseFloat(taxAmount.toFixed(2));
    depositTotal = parseFloat(depositTotal.toFixed(2));
    const total = parseFloat((rentalSubtotal + taxAmount + depositTotal).toFixed(2));
    const method = payment_method || 'cash';
    const tendered = parseFloat(amount_tendered || total);

    const { rows: [agCount] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM rental_agreements', args: [] });
    const agreement_number = `RA-${String(Number(agCount.c) + 1).padStart(6, '0')}`;
    const { rows: [txCount] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM transactions', args: [] });
    const transaction_number = `TXN-${String(Number(txCount.c) + 1).padStart(6, '0')}`;
    const today = checkoutDateTime.toISOString().slice(0, 10);

    const tx = await db.transaction('write');
    try {
      const agResult = await tx.execute({ sql: `INSERT INTO rental_agreements (agreement_number,customer_id,employee_id,branch_id,status,checkout_date,checkout_datetime,due_date,deposit_total,notes) VALUES (?,?,?,?,?,?,?,?,?,?)`, args: [agreement_number, customer_id, employee_id || null, branch_id || null, 'active', today, checkoutDateTime.toISOString(), due_date, depositTotal, notes || null] });
      const agreementId = Number(agResult.lastInsertRowid);

      // Rental checkout never touches products.stock_qty/branch_inventory — the
      // physical fleet count stays constant; availability is computed live from
      // rental_agreement_items instead (see lib/rentalAvailability.js).
      const txResult = await tx.execute({ sql: `INSERT INTO transactions (transaction_number,customer_id,employee_id,branch_id,drawer_session_id,subtotal,tax_amount,total,payment_method,amount_tendered,change_amount,notes,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [transaction_number, customer_id, employee_id || null, branch_id || null, drawer_session_id || null, rentalSubtotal + depositTotal, taxAmount, total, method, tendered, Math.max(0, parseFloat((tendered - total).toFixed(2))), `Rental checkout ${agreement_number}`, 'pos'] });
      const checkoutTxId = Number(txResult.lastInsertRowid);

      const insertedIds = [];
      for (const line of lines) {
        const p = line.product;
        const result = await tx.execute({ sql: `INSERT INTO rental_agreement_items
          (agreement_id,parent_item_id,product_id,product_name,sku,quantity,rate_type,rate_amount,rental_classification,daily_rate,weekly_rate,monthly_rate,hourly_rate,tax_rate,is_mandatory,rental_fee,deposit_amount,replacement_value,condition_out)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          args: [agreementId, line.parentIndex != null ? insertedIds[line.parentIndex] : null, p.id, p.name, p.sku, line.quantity, 'daily', p.rental_rate || 0, p.rental_classification || 'tool', p.rental_rate || 0, p.rental_weekly_rate || 0, p.rental_monthly_rate || 0, p.rental_hourly_rate || 0, p.tax_rate || 0, line.isMandatory ? 1 : 0, line.rentalFee, line.depositAmount, p.replacement_value || 0, line.condition_out] });
        insertedIds.push(Number(result.lastInsertRowid));
        const itemLabel = line.parentIndex != null ? `${p.name}${line.isMandatory ? ' (included)' : ' (accessory)'}` : p.name;
        await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?,?)`, args: [checkoutTxId, p.id, itemLabel, p.sku, line.quantity, line.isMandatory ? 0 : (line.rentalFee / line.quantity), line.lineTax, line.rentalFee] });
      }
      if (depositTotal > 0) {
        await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?,?)`, args: [checkoutTxId, null, 'Refundable Deposit', 'DEPOSIT', 1, depositTotal, 0, depositTotal] });
      }

      // Loyalty accrues on the rental-fee portion only, not the deposit — same
      // shape as the regular POS checkout's customer loyalty update.
      const loyaltyPts = Math.floor(rentalSubtotal * 0.5);
      await tx.execute({ sql: 'UPDATE customers SET loyalty_points = loyalty_points + ?, total_spent = total_spent + ? WHERE id = ?', args: [loyaltyPts, rentalSubtotal, customer_id] });

      await tx.execute({ sql: 'UPDATE rental_agreements SET checkout_transaction_id = ? WHERE id = ?', args: [checkoutTxId, agreementId] });
      await tx.commit();

      const { rows: [agreement] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [agreementId] });
      const { rows: agItems } = await db.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [agreementId] });
      agreement.items = agItems;
      res.status(201).json(agreement);
    } catch(e) {
      await tx.rollback();
      res.status(400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Cancel ─────────────────────────────────────────────────────────────────

router.patch('/agreements/:id/cancel', requirePermission('rentals_returns'), async (req, res) => {
  try {
    const { rows: [agreement] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [req.params.id] });
    if (!agreement) return res.status(404).json({ error: 'Not found' });
    if (agreement.status !== 'active') return res.status(400).json({ error: `Cannot cancel a ${agreement.status} agreement` });
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [req.params.id] });
    if (items.some(i => i.quantity_returned > 0)) return res.status(400).json({ error: 'Cannot cancel an agreement that already has items returned — process a return instead' });

    const tx = await db.transaction('write');
    try {
      if (agreement.checkout_transaction_id) {
        const { rows: [checkoutTx] } = await tx.execute({ sql: 'SELECT * FROM transactions WHERE id = ?', args: [agreement.checkout_transaction_id] });
        if (checkoutTx && checkoutTx.status !== 'voided') {
          await tx.execute({ sql: "UPDATE transactions SET status='voided', voided_at=CURRENT_TIMESTAMP WHERE id=?", args: [agreement.checkout_transaction_id] });
          if (checkoutTx.customer_id) {
            // Loyalty was only ever accrued on the rental-fee portion of the
            // checkout, not the deposit (see POST /agreements) — reverse that
            // same amount, not the full subtotal, or this double-deducts the deposit.
            const rentalFeePortion = (checkoutTx.subtotal || 0) - (agreement.deposit_total || 0);
            const loyaltyPts = Math.floor(rentalFeePortion * 0.5);
            await tx.execute({ sql: 'UPDATE customers SET loyalty_points = MAX(0, loyalty_points - ?), total_spent = MAX(0, total_spent - ?) WHERE id = ?', args: [loyaltyPts, rentalFeePortion, checkoutTx.customer_id] });
          }
        }
      }
      await tx.execute({ sql: "UPDATE rental_agreements SET status = 'cancelled' WHERE id = ?", args: [req.params.id] });
      await tx.commit();
    } catch(e) {
      await tx.rollback();
      return res.status(400).json({ error: e.message });
    }
    const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [req.params.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Return ─────────────────────────────────────────────────────────────────

router.patch('/agreements/:id/return', requirePermission('rentals_returns'), async (req, res) => {
  try {
    const { items, duration_adjustment_override, payment_method, drawer_session_id } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'At least one item is required' });

    const { rows: [agreement] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [req.params.id] });
    if (!agreement) return res.status(404).json({ error: 'Not found' });
    if (agreement.status !== 'active') return res.status(400).json({ error: `Cannot return items on a ${agreement.status} agreement` });

    const { rows: existingItems } = await db.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [req.params.id] });
    const outstandingIds = existingItems.filter(i => i.quantity_returned < i.quantity).map(i => i.id);
    const coveredIds = items.map(i => i.item_id);
    const missing = outstandingIds.filter(id => !coveredIds.includes(id));
    if (missing.length) return res.status(400).json({ error: 'Every outstanding item on this agreement must be included in the return' });

    const now = new Date();
    const checkoutDateTime = agreement.checkout_datetime || `${agreement.checkout_date}T00:00:00.000Z`;

    const tx = await db.transaction('write');
    try {
      let durationAdjustmentTotal = 0, damageFeeTotal = 0, taxAdjustmentTotal = 0;
      const settlementLines = [];
      for (const input of items) {
        const item = existingItems.find(i => i.id === input.item_id);
        if (!item) throw new Error(`Item ${input.item_id} not found on this agreement`);
        const qty = parseInt(input.quantity_returned) || 0;
        const available = item.quantity - item.quantity_returned;
        if (qty <= 0 || qty > available) throw new Error(`Cannot return ${qty} of "${item.product_name}" — only ${available} outstanding`);

        const newReturned = item.quantity_returned + qty;
        const damageFee = parseFloat(input.damage_fee || 0);
        const notes = input.damage_notes ? (item.damage_notes ? `${item.damage_notes}\n${input.damage_notes}` : input.damage_notes) : item.damage_notes;
        const nowFullyReturned = newReturned >= item.quantity;

        // Recompute the real fee for the units returned right now, using the
        // item's own snapshotted classification/rates over the ACTUAL elapsed
        // time (checkout -> this moment) — this replaces the old flat late fee.
        let actualFeePerUnit = 0;
        if (!item.is_mandatory) {
          actualFeePerUnit = feeFor({
            rental_classification: item.rental_classification,
            rental_rate: item.daily_rate,
            rental_weekly_rate: item.weekly_rate,
            rental_monthly_rate: item.monthly_rate,
            rental_hourly_rate: item.hourly_rate,
          }, 1, checkoutDateTime, now);
        }
        const thisReturnActualFee = parseFloat((actualFeePerUnit * qty).toFixed(2));
        const originalEstimatePerUnit = item.quantity ? item.rental_fee / item.quantity : 0;
        const thisReturnEstimate = parseFloat((originalEstimatePerUnit * qty).toFixed(2));
        const delta = parseFloat((thisReturnActualFee - thisReturnEstimate).toFixed(2));
        durationAdjustmentTotal += delta;
        // The tax originally charged at checkout was based on the estimated
        // fee — as the fee true-ups to the actual amount used, the tax owed
        // on that same delta must true-up with it, or an early return leaves
        // the customer paying tax on fee they never actually incurred (and a
        // late return would undercharge tax on the extra time).
        taxAdjustmentTotal += parseFloat((delta * (item.tax_rate || 0) / 100).toFixed(2));

        await tx.execute({ sql: `UPDATE rental_agreement_items SET quantity_returned = ?, condition_in = ?, damage_notes = ?, damage_fee = damage_fee + ?, final_rental_fee = final_rental_fee + ?, returned_at = ? WHERE id = ?`, args: [newReturned, input.condition_in || item.condition_in, notes || null, damageFee, thisReturnActualFee, nowFullyReturned ? now.toISOString() : item.returned_at, item.id] });

        damageFeeTotal += damageFee;
        if (damageFee > 0) settlementLines.push({ product_id: item.product_id, product_name: `Damage Fee — ${item.product_name}`, sku: item.sku, total: damageFee });
      }
      if (duration_adjustment_override != null) {
        // An override replaces the auto-computed duration adjustment, but the
        // tax truing-up (computed per item above) still applies to the real
        // elapsed time and is not affected by a manual override.
        durationAdjustmentTotal = parseFloat(duration_adjustment_override) || 0;
      }
      durationAdjustmentTotal = parseFloat(durationAdjustmentTotal.toFixed(2));
      damageFeeTotal = parseFloat(damageFeeTotal.toFixed(2));
      taxAdjustmentTotal = parseFloat(taxAdjustmentTotal.toFixed(2));

      const { rows: refreshedItems } = await tx.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [req.params.id] });
      const allReturned = refreshedItems.every(i => i.quantity_returned >= i.quantity);
      const newStatus = allReturned ? 'returned' : 'active';

      // settlement total is intentionally signed: positive = customer owes more
      // (actual rental time + damage exceed the deposit), negative = net refund
      // due back to the customer (e.g. returned early). This is the one place
      // in the schema a negative `total` is expected — drawer reconciliation
      // just SUMs by payment_method, so this nets out correctly with no
      // changes needed there. tax_amount carries the tax truing-up separately
      // from the pre-tax subtotal, same as every other transaction in the app.
      const settlementSubtotal = parseFloat((damageFeeTotal + durationAdjustmentTotal - agreement.deposit_total).toFixed(2));
      const settlementAmount = parseFloat((settlementSubtotal + taxAdjustmentTotal).toFixed(2));
      const depositRefunded = Math.max(0, agreement.deposit_total - (damageFeeTotal + durationAdjustmentTotal + taxAdjustmentTotal));

      const { rows: [txCount] } = await tx.execute({ sql: 'SELECT COUNT(*) as c FROM transactions', args: [] });
      const transaction_number = `TXN-${String(Number(txCount.c) + 1).padStart(6, '0')}`;
      const method = settlementAmount >= 0 ? (payment_method || 'cash') : 'refund';
      const settleResult = await tx.execute({ sql: `INSERT INTO transactions (transaction_number,customer_id,employee_id,branch_id,drawer_session_id,subtotal,tax_amount,total,payment_method,amount_tendered,change_amount,notes,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [transaction_number, agreement.customer_id, agreement.employee_id, agreement.branch_id, drawer_session_id || null, settlementSubtotal, taxAdjustmentTotal, settlementAmount, method, 0, 0, `Rental settlement ${agreement.agreement_number}`, 'pos'] });
      const settlementTxId = Number(settleResult.lastInsertRowid);

      if (durationAdjustmentTotal !== 0) {
        const label = durationAdjustmentTotal > 0 ? 'Additional Rental Time' : 'Rental Fee Credit (returned early)';
        await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?)`, args: [settlementTxId, label, 'DURATION-ADJ', 1, durationAdjustmentTotal, taxAdjustmentTotal, durationAdjustmentTotal] });
      }
      for (const line of settlementLines) {
        await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?,?)`, args: [settlementTxId, line.product_id, line.product_name, line.sku, 1, line.total, 0, line.total] });
      }
      if (agreement.deposit_total > 0) {
        await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?)`, args: [settlementTxId, depositRefunded > 0 ? 'Deposit Refunded' : 'Deposit Applied', 'DEPOSIT', 1, -agreement.deposit_total, 0, -agreement.deposit_total] });
      }

      await tx.execute({ sql: `UPDATE rental_agreements SET settlement_transaction_id = ?, deposit_refunded = ?, duration_adjustment_total = duration_adjustment_total + ?, tax_adjustment_total = tax_adjustment_total + ?, damage_fee_total = damage_fee_total + ?, status = ?, returned_at = ? WHERE id = ?`, args: [settlementTxId, depositRefunded, durationAdjustmentTotal, taxAdjustmentTotal, damageFeeTotal, newStatus, allReturned ? now.toISOString() : agreement.returned_at, req.params.id] });
      await tx.commit();
    } catch(e) {
      await tx.rollback();
      return res.status(400).json({ error: e.message });
    }

    const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [req.params.id] });
    const { rows: updatedItems } = await db.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [req.params.id] });
    updated.items = updatedItems;
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
