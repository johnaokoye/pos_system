const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { getOutstandingQty } = require('../lib/rentalAvailability');

// ─── Agreements list/detail ───────────────────────────────────────────────

router.get('/agreements', async (req, res) => {
  try {
    const { customer_id, branch_id, view } = req.query;
    let sql = `SELECT ra.*, c.first_name || ' ' || c.last_name as customer_name,
      b.name as branch_name, e.first_name || ' ' || e.last_name as employee_name,
      (SELECT COUNT(*) FROM rental_agreement_items WHERE agreement_id = ra.id) as item_count,
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

router.get('/agreements/:id', async (req, res) => {
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

router.get('/availability', async (req, res) => {
  try {
    const { product_id } = req.query;
    if (!product_id) return res.status(400).json({ error: 'product_id is required' });
    const { rows: [product] } = await db.execute({ sql: 'SELECT id, name, stock_qty FROM products WHERE id = ?', args: [product_id] });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const outstanding = await getOutstandingQty(db, product_id);
    res.json({ product_id: product.id, stock_qty: product.stock_qty, outstanding_qty: outstanding, available_qty: Math.max(0, product.stock_qty - outstanding) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Checkout ───────────────────────────────────────────────────────────────

router.post('/agreements', async (req, res) => {
  try {
    const { customer_id, employee_id, branch_id, drawer_session_id, due_date, items, payment_method, amount_tendered, notes } = req.body;
    if (!customer_id) return res.status(400).json({ error: 'A customer is required for rental checkout' });
    if (!due_date) return res.status(400).json({ error: 'Due date is required' });
    if (!items || !items.length) return res.status(400).json({ error: 'At least one rental item is required' });

    const today = new Date().toISOString().slice(0, 10);
    const durationMs = new Date(due_date + 'T00:00:00') - new Date(today + 'T00:00:00');
    const duration = Math.max(1, Math.round(durationMs / 86400000));

    const processedItems = [];
    let rentalSubtotal = 0, taxAmount = 0, depositTotal = 0;
    for (const item of items) {
      const { rows: [product] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] });
      if (!product) return res.status(400).json({ error: `Product ${item.product_id} not found` });
      if (!product.is_rental) return res.status(400).json({ error: `"${product.name}" is not a rental item` });
      const qty = parseInt(item.quantity) || 1;
      const outstanding = await getOutstandingQty(db, product.id);
      const available = product.stock_qty - outstanding;
      if (qty > available) return res.status(400).json({ error: `Cannot check out ${qty} of "${product.name}" — only ${available} available` });

      const rateAmount = product.rental_rate || 0;
      const rentalFee = parseFloat((rateAmount * duration * qty).toFixed(2));
      const depositAmount = parseFloat(((product.rental_deposit || 0) * qty).toFixed(2));
      const lineTax = parseFloat((rentalFee * (product.tax_rate || 0) / 100).toFixed(2));
      rentalSubtotal += rentalFee;
      taxAmount += lineTax;
      depositTotal += depositAmount;
      processedItems.push({ product, quantity: qty, rateAmount, rentalFee, depositAmount, lineTax, condition_out: item.condition_out || null });
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

    const tx = await db.transaction('write');
    try {
      const agResult = await tx.execute({ sql: `INSERT INTO rental_agreements (agreement_number,customer_id,employee_id,branch_id,status,checkout_date,due_date,deposit_total,notes) VALUES (?,?,?,?,?,?,?,?,?)`, args: [agreement_number, customer_id, employee_id || null, branch_id || null, 'active', today, due_date, depositTotal, notes || null] });
      const agreementId = Number(agResult.lastInsertRowid);

      // Rental checkout never touches products.stock_qty/branch_inventory — the
      // physical fleet count stays constant; availability is computed live from
      // rental_agreement_items instead (see lib/rentalAvailability.js).
      const txResult = await tx.execute({ sql: `INSERT INTO transactions (transaction_number,customer_id,employee_id,branch_id,drawer_session_id,subtotal,tax_amount,total,payment_method,amount_tendered,change_amount,notes,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [transaction_number, customer_id, employee_id || null, branch_id || null, drawer_session_id || null, rentalSubtotal + depositTotal, taxAmount, total, method, tendered, Math.max(0, parseFloat((tendered - total).toFixed(2))), `Rental checkout ${agreement_number}`, 'pos'] });
      const checkoutTxId = Number(txResult.lastInsertRowid);

      for (const pi of processedItems) {
        await tx.execute({ sql: `INSERT INTO rental_agreement_items (agreement_id,product_id,product_name,sku,quantity,rate_type,rate_amount,rental_fee,deposit_amount,replacement_value,late_fee_rate,condition_out) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, args: [agreementId, pi.product.id, pi.product.name, pi.product.sku, pi.quantity, pi.product.rental_rate_type || 'daily', pi.rateAmount, pi.rentalFee, pi.depositAmount, pi.product.replacement_value || 0, pi.product.rental_late_fee_rate || 0, pi.condition_out] });
        await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?,?)`, args: [checkoutTxId, pi.product.id, pi.product.name, pi.product.sku, pi.quantity, pi.rateAmount, pi.lineTax, pi.rentalFee] });
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

router.patch('/agreements/:id/cancel', async (req, res) => {
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
            const loyaltyPts = Math.floor((checkoutTx.subtotal || 0) * 0.5);
            await tx.execute({ sql: 'UPDATE customers SET loyalty_points = MAX(0, loyalty_points - ?), total_spent = MAX(0, total_spent - ?) WHERE id = ?', args: [loyaltyPts, checkoutTx.subtotal || 0, checkoutTx.customer_id] });
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

router.patch('/agreements/:id/return', async (req, res) => {
  try {
    const { items, late_fee_override, payment_method } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'At least one item is required' });

    const { rows: [agreement] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [req.params.id] });
    if (!agreement) return res.status(404).json({ error: 'Not found' });
    if (agreement.status !== 'active') return res.status(400).json({ error: `Cannot return items on a ${agreement.status} agreement` });

    const { rows: existingItems } = await db.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [req.params.id] });
    const outstandingIds = existingItems.filter(i => i.quantity_returned < i.quantity).map(i => i.id);
    const coveredIds = items.map(i => i.item_id);
    const missing = outstandingIds.filter(id => !coveredIds.includes(id));
    if (missing.length) return res.status(400).json({ error: 'Every outstanding item on this agreement must be included in the return' });

    const today = new Date().toISOString().slice(0, 10);
    const daysLate = Math.max(0, Math.round((new Date(today + 'T00:00:00') - new Date(agreement.due_date + 'T00:00:00')) / 86400000));

    const tx = await db.transaction('write');
    try {
      let lateFeeTotal = 0, damageFeeTotal = 0;
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

        await tx.execute({ sql: `UPDATE rental_agreement_items SET quantity_returned = ?, condition_in = ?, damage_notes = ?, damage_fee = damage_fee + ?, returned_at = ? WHERE id = ?`, args: [newReturned, input.condition_in || item.condition_in, notes || null, damageFee, nowFullyReturned ? new Date().toISOString() : item.returned_at, item.id] });

        const itemLateFee = late_fee_override != null ? 0 : parseFloat((daysLate * (item.late_fee_rate || 0) * qty).toFixed(2));
        lateFeeTotal += itemLateFee;
        damageFeeTotal += damageFee;
        if (damageFee > 0) settlementLines.push({ product_id: item.product_id, product_name: `Damage Fee — ${item.product_name}`, sku: item.sku, total: damageFee });
      }
      if (late_fee_override != null) lateFeeTotal = parseFloat(late_fee_override) || 0;
      lateFeeTotal = parseFloat(lateFeeTotal.toFixed(2));
      damageFeeTotal = parseFloat(damageFeeTotal.toFixed(2));

      const { rows: refreshedItems } = await tx.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [req.params.id] });
      const allReturned = refreshedItems.every(i => i.quantity_returned >= i.quantity);
      const newStatus = allReturned ? 'returned' : 'active';

      // settlement_amount is intentionally signed: positive = customer owes more
      // (late/damage fees exceed deposit), negative = net refund due back to the
      // customer. This is the one place in the schema a negative `total` is
      // expected — drawer reconciliation just SUMs by payment_method, so this
      // nets out correctly with no changes needed there.
      const settlementAmount = parseFloat((damageFeeTotal + lateFeeTotal - agreement.deposit_total).toFixed(2));
      const depositRefunded = Math.max(0, agreement.deposit_total - (damageFeeTotal + lateFeeTotal));

      const { rows: [txCount] } = await tx.execute({ sql: 'SELECT COUNT(*) as c FROM transactions', args: [] });
      const transaction_number = `TXN-${String(Number(txCount.c) + 1).padStart(6, '0')}`;
      const method = settlementAmount >= 0 ? (payment_method || 'cash') : 'refund';
      const settleResult = await tx.execute({ sql: `INSERT INTO transactions (transaction_number,customer_id,employee_id,branch_id,subtotal,tax_amount,total,payment_method,amount_tendered,change_amount,notes,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, args: [transaction_number, agreement.customer_id, agreement.employee_id, agreement.branch_id, settlementAmount, 0, settlementAmount, method, 0, 0, `Rental settlement ${agreement.agreement_number}`, 'pos'] });
      const settlementTxId = Number(settleResult.lastInsertRowid);

      if (lateFeeTotal > 0) {
        await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?)`, args: [settlementTxId, `Late Fee — ${daysLate} day${daysLate!==1?'s':''} overdue`, 'LATE-FEE', 1, lateFeeTotal, 0, lateFeeTotal] });
      }
      for (const line of settlementLines) {
        await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?,?)`, args: [settlementTxId, line.product_id, line.product_name, line.sku, 1, line.total, 0, line.total] });
      }
      if (agreement.deposit_total > 0) {
        await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?)`, args: [settlementTxId, depositRefunded > 0 ? 'Deposit Refunded' : 'Deposit Applied', 'DEPOSIT', 1, -agreement.deposit_total, 0, -agreement.deposit_total] });
      }

      await tx.execute({ sql: `UPDATE rental_agreements SET settlement_transaction_id = ?, deposit_refunded = ?, late_fee_total = ?, damage_fee_total = ?, status = ?, returned_at = ? WHERE id = ?`, args: [settlementTxId, depositRefunded, lateFeeTotal, damageFeeTotal, newStatus, allReturned ? new Date().toISOString() : agreement.returned_at, req.params.id] });
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
