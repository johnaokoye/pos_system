const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { calcCommission } = require('./commissions');
const { getWcSettings, wcRequest } = require('./woocommerce');
const { syncBinQty } = require('../lib/binSync');
const { requireAuth, requirePermission, can } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');
const { checkDiscountEligibility } = require('./promotions');

// Mirrors availableCashBack() in public/index.html — the frontend uses this
// same formula to decide whether to show the Cash Back bar; this copy is the
// server-side clamp applied below so a stale/tampered client value can never
// apply more than the customer is actually entitled to.
function computeAvailableCashBack(row) {
  if (!row || !row.active || !row.points_threshold || !row.reward_amount) return 0;
  const accrued = Math.floor((row.loyalty_points || 0) / row.points_threshold) * row.reward_amount;
  if (accrued <= 0) return 0;
  if (row.min_redeem_amount > 0 && accrued < row.min_redeem_amount) return 0;
  if (row.min_redeem_days > 0 && row.cash_back_last_redeemed_at) {
    const daysSince = (Date.now() - new Date(row.cash_back_last_redeemed_at).getTime()) / 86400000;
    if (daysSince < row.min_redeem_days) return 0;
  }
  return accrued;
}

// Put order on hold (no stock updates, no payment processing)
router.post('/hold', requirePermission('pos_hold'), async (req, res) => {
  try {
    const { customer_id, employee_id, branch_id, items, discount_amount, notes } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items in cart' });

    const hold_number = 'HOLD-' + Date.now();
    let subtotal = 0, tax_amount = 0;
    for (const item of items) {
      const lineTotal = parseFloat((parseFloat(item.unit_price) * item.quantity).toFixed(2));
      const lineTax = parseFloat((lineTotal * (parseFloat(item.tax_rate) || 0) / 100).toFixed(2));
      subtotal += lineTotal;
      tax_amount += lineTax;
    }
    subtotal = parseFloat(subtotal.toFixed(2));
    tax_amount = parseFloat(tax_amount.toFixed(2));
    const disc = parseFloat(discount_amount || 0);
    const total = parseFloat((subtotal + tax_amount - disc).toFixed(2));

    const txn = await db.transaction('write');
    let committed = false;
    try {
      const result = await txn.execute({
        sql: `INSERT INTO transactions (transaction_number,customer_id,employee_id,branch_id,subtotal,tax_amount,discount_amount,total,payment_method,status,notes,amount_tendered,change_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0)`,
        args: [hold_number, customer_id || null, employee_id || 1, branch_id || null, subtotal, tax_amount, disc, total, 'hold', 'hold', notes || null]
      });
      const txId = Number(result.lastInsertRowid);
      for (const item of items) {
        const lineTotal = parseFloat((parseFloat(item.unit_price) * item.quantity).toFixed(2));
        const lineTax = parseFloat((lineTotal * (parseFloat(item.tax_rate) || 0) / 100).toFixed(2));
        await txn.execute({
          sql: `INSERT INTO transaction_items (transaction_id,product_id,product_name,sku,quantity,unit_price,discount_amount,tax_amount,total,variation_id,variation_name) VALUES (?,?,?,?,?,?,0,?,?,?,?)`,
          args: [txId, item.product_id, item.product_name, item.sku || '', item.quantity, parseFloat(item.unit_price), lineTax, lineTotal, item.variation_id || null, item.variation_name || null]
        });
      }
      await txn.commit();
      committed = true;
      const { rows: [savedTx] } = await db.execute({ sql: `SELECT t.*, c.first_name || ' ' || c.last_name as customer_name FROM transactions t LEFT JOIN customers c ON t.customer_id = c.id WHERE t.id = ?`, args: [txId] });
      const { rows: savedItems } = await db.execute({ sql: 'SELECT * FROM transaction_items WHERE transaction_id = ?', args: [txId] });
      savedTx.items = savedItems;
      res.status(201).json(savedTx);
    } catch(e) {
      // Once committed, the hold is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await txn.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Cancel / delete a held order
router.delete('/:id/hold', requirePermission('pos_hold'), async (req, res) => {
  try {
    const { rows: [held] } = await db.execute({ sql: `SELECT id FROM transactions WHERE id = ? AND status = 'hold'`, args: [req.params.id] });
    if (!held) return res.status(404).json({ error: 'Held order not found' });
    // A hold created by converting a quotation points quotations.converted_to_tx
    // back at it — if the hold is cancelled instead of recalled and finalized,
    // revert the quote so it isn't left stranded pointing at a deleted transaction.
    await db.execute({ sql: `UPDATE quotations SET status = 'accepted', converted_to_tx = NULL WHERE converted_to_tx = ?`, args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM transaction_items WHERE transaction_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM transactions WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/', requirePermission('transactions'), async (req, res) => {
  try {
    const { start, end, customer_id, customer_name, status, branch_id, payment_method, transaction_number, source, fulfillment_status, limit = 100 } = req.query;
    let sql = `SELECT t.*, c.first_name || ' ' || c.last_name as customer_name, e.first_name || ' ' || e.last_name as employee_name, b.name as branch_name,
      ra.agreement_number as rental_agreement_number, q.quote_number as source_quote_number,
      CASE WHEN ra.checkout_transaction_id = t.id THEN 'checkout' WHEN ra.settlement_transaction_id = t.id THEN 'settlement' END as rental_role
      FROM transactions t LEFT JOIN customers c ON t.customer_id = c.id LEFT JOIN employees e ON t.employee_id = e.id LEFT JOIN branches b ON t.branch_id = b.id
      LEFT JOIN rental_agreements ra ON ra.checkout_transaction_id = t.id OR ra.settlement_transaction_id = t.id
      LEFT JOIN quotations q ON q.converted_to_tx = t.id
      WHERE 1=1`;
    const params = [];
    if (transaction_number) { sql += ' AND t.transaction_number LIKE ?'; params.push(`%${transaction_number}%`); }
    if (start) { sql += ' AND date(t.created_at) >= date(?)'; params.push(start); }
    if (end) { sql += ' AND date(t.created_at) <= date(?)'; params.push(end); }
    if (customer_id) { sql += ' AND t.customer_id = ?'; params.push(customer_id); }
    if (customer_name) { sql += " AND (c.first_name || ' ' || c.last_name) LIKE ?"; params.push(`%${customer_name}%`); }
    if (status) { sql += ' AND t.status = ?'; params.push(status); }
    if (branch_id) { sql += ' AND t.branch_id = ?'; params.push(branch_id); }
    if (payment_method) { sql += ' AND t.payment_method = ?'; params.push(payment_method); }
    if (fulfillment_status) { sql += ' AND t.fulfillment_status = ?'; params.push(fulfillment_status); }
    if (source === 'online') { sql += " AND t.source IN ('online','woocommerce')"; }
    else if (source) { sql += ' AND t.source = ?'; params.push(source); }
    // A salesperson-flagged employee only ever sees their own sales here,
    // regardless of what filters the client sent — see is_salesperson
    // migration note in database.js.
    if (req.employee?.is_salesperson) { sql += ' AND t.employee_id = ?'; params.push(req.employee.id); }
    sql += ' ORDER BY t.created_at DESC LIMIT ?';
    params.push(parseInt(limit));
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// requireAuth only — used broadly (POS hold-recall, receipt printing,
// returns flow, online orders), not just the Transactions detail view.
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows: [tx] } = await db.execute({ sql: `SELECT t.*, c.first_name || ' ' || c.last_name as customer_name, c.customer_number, c.email as customer_email, c.phone as customer_phone, c.address as customer_address, c.city as customer_city, c.state as customer_state, c.zip as customer_zip, e.first_name || ' ' || e.last_name as employee_name, b.name as branch_name, b.address as branch_address, b.city as branch_city, b.state as branch_state, b.zip as branch_zip, b.phone as branch_phone, q.id as source_quote_id, q.quote_number as source_quote_number, qe.first_name || ' ' || qe.last_name as quote_created_by, r.return_number as source_return_number, sh.carrier as shipment_carrier, sh.tracking_number as shipment_tracking_number, sh.status as shipment_status, sh.ship_date as shipment_ship_date, sh.estimated_delivery as shipment_estimated_delivery,
      ve.first_name || ' ' || ve.last_name as voided_by_name,
      ra.id as rental_agreement_id, ra.agreement_number as rental_agreement_number, ra.status as rental_status,
      ra.checkout_datetime as rental_checkout_datetime, ra.due_date as rental_due_date, ra.returned_at as rental_returned_at,
      ra.deposit_total as rental_deposit_total, ra.deposit_refunded as rental_deposit_refunded,
      ra.duration_adjustment_total as rental_duration_adjustment_total, ra.damage_fee_total as rental_damage_fee_total,
      ra.customer_po_number as rental_po_number,
      CASE WHEN ra.checkout_transaction_id = t.id THEN 'checkout' WHEN ra.settlement_transaction_id = t.id THEN 'settlement' END as rental_role
      FROM transactions t LEFT JOIN customers c ON t.customer_id = c.id LEFT JOIN employees e ON t.employee_id = e.id LEFT JOIN branches b ON t.branch_id = b.id LEFT JOIN quotations q ON q.converted_to_tx = t.id LEFT JOIN employees qe ON q.employee_id = qe.id LEFT JOIN returns r ON t.source_return_id = r.id LEFT JOIN shipments sh ON sh.transaction_id = t.id
      LEFT JOIN employees ve ON t.voided_by = ve.id
      LEFT JOIN rental_agreements ra ON ra.checkout_transaction_id = t.id OR ra.settlement_transaction_id = t.id
      WHERE t.id = ?`, args: [req.params.id] });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM transaction_items WHERE transaction_id = ?', args: [req.params.id] });
    tx.items = items;
    const { rows: payments } = await db.execute({ sql: 'SELECT * FROM transaction_payments WHERE transaction_id = ? ORDER BY id', args: [req.params.id] });
    tx.payments = payments;
    // Pause history is agreement-level, not tied to which transaction (checkout
    // vs settlement) this is — shown on either printed invoice for the same rental.
    if (tx.rental_agreement_id) {
      const { rows: pauses } = await db.execute({ sql: 'SELECT reason, notes, started_at, ended_at FROM rental_agreement_pauses WHERE agreement_id = ? ORDER BY id', args: [tx.rental_agreement_id] });
      tx.rental_pauses = pauses;
    }
    res.json(tx);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requirePermission('pos'), async (req, res) => {
  try {
    const { customer_id, employee_id, drawer_session_id, items, discount_amount, promotion_code, promotion_name, payment_method, amount_tendered, notes, source_return_id, store_credit_applied, cash_back_applied, quote_id, tax_exempt, tax_exemption_number, approval_code, tenders } = req.body;
    let { branch_id } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items in transaction' });

    // For API-authenticated (online) orders with no branch, use the ecommerce sync branch
    if (!branch_id && req.apiKey) {
      const { rows: [setting] } = await db.execute({ sql: "SELECT value FROM settings WHERE key='woo_sync_branch_id'", args: [] });
      if (setting?.value) branch_id = setting.value;
    }

    const transaction_number = await nextNumber(db, 'transactions', 'transaction_number', 'TXN-', 6);

    // Store-wide cap for a manual per-line discount (see the POS "Discount"
    // action on a cart line) — 0/unset means no limit is configured, same
    // convention as the existing whole-ticket max_discount_pct setting.
    const { rows: [maxDiscSetting] } = await db.execute({ sql: "SELECT value FROM settings WHERE key = 'pos_max_line_discount_percent'", args: [] });
    const maxLineDiscountPercent = parseFloat(maxDiscSetting?.value) || 0;

    const isTaxExempt = tax_exempt ? 1 : 0;
    let subtotal = 0, tax_amount = 0;
    const processedItems = [];
    for (const item of items) {
      const { rows: [product] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] });
      if (!product) throw new Error(`Product ${item.product_id} not found`);
      let variation = null, unit_price = product.price;
      if (item.variation_id) {
        const { rows: [v] } = await db.execute({ sql: 'SELECT * FROM product_variations WHERE id = ? AND product_id = ?', args: [item.variation_id, item.product_id] });
        if (!v) throw new Error(`Variation ${item.variation_id} not found`);
        variation = v;
        unit_price = v.price != null ? v.price : parseFloat((product.price + (v.price_modifier || 0)).toFixed(2));
      }
      const grossLineTotal = parseFloat((unit_price * item.quantity).toFixed(2));

      // Manual per-line discount — re-validated here (not just trusted from
      // the POS UI's own check) so a bypassed client can't apply one to an
      // ineligible item or skip the manager override past the store limit.
      const discountPercent = parseFloat(item.discount_percent) || 0;
      let discountAmount = 0, discountOverrideBy = null;
      if (discountPercent > 0) {
        if (discountPercent > 100) throw new Error(`Invalid discount percentage for ${product.name}`);
        const eligibility = await checkDiscountEligibility(product);
        if (!eligibility.eligible) {
          throw new Error(eligibility.reason === 'brand_excluded'
            ? `${product.name} (${product.brand}) is on the discount-exclusion list and can't be manually discounted`
            : `${product.name} is already on a promotion and can't also get a manual discount`);
        }
        if (maxLineDiscountPercent > 0 && discountPercent > maxLineDiscountPercent) {
          if (!item.discount_override_employee_id) {
            throw new Error(`A ${discountPercent}% discount on ${product.name} exceeds the store limit of ${maxLineDiscountPercent}% — manager override required`);
          }
          const { rows: [overrider] } = await db.execute({ sql: 'SELECT sg.permissions FROM employees e LEFT JOIN security_groups sg ON e.security_group_id = sg.id WHERE e.id = ? AND e.active = 1', args: [item.discount_override_employee_id] });
          let authorized = false;
          try { authorized = overrider && can(JSON.parse(overrider.permissions || '{}'), 'pos_discount_override'); } catch { authorized = false; }
          if (!authorized) throw new Error(`The employee authorizing the discount override on ${product.name} doesn't have override privileges`);
          discountOverrideBy = item.discount_override_employee_id;
        }
        discountAmount = parseFloat((grossLineTotal * discountPercent / 100).toFixed(2));
      }

      const lineTotal = parseFloat((grossLineTotal - discountAmount).toFixed(2));
      const lineTax = isTaxExempt ? 0 : parseFloat((lineTotal * product.tax_rate / 100).toFixed(2));
      subtotal += lineTotal;
      tax_amount += lineTax;
      processedItems.push({ product, variation, quantity: item.quantity, unit_price, lineTotal, lineTax, discount: discountAmount, discountPercent, discountOverrideBy });
    }

    subtotal = parseFloat(subtotal.toFixed(2));
    tax_amount = parseFloat(tax_amount.toFixed(2));
    const disc = parseFloat(discount_amount || 0);
    const storeCredit = parseFloat(store_credit_applied || 0);

    // Server-side clamp against the customer's actual eligibility right now
    // — see computeAvailableCashBack() above.
    let cashBack = parseFloat(cash_back_applied || 0);
    let cashBackCard = null;
    if (cashBack > 0 && customer_id) {
      const { rows: [row] } = await db.execute({
        sql: `SELECT c.loyalty_points, c.cash_back_last_redeemed_at, cbct.points_threshold, cbct.reward_amount, cbct.min_redeem_amount, cbct.min_redeem_days, cbct.active
              FROM customers c LEFT JOIN cash_back_card_types cbct ON c.cash_back_card_type_id = cbct.id WHERE c.id = ?`,
        args: [customer_id],
      });
      cashBackCard = row;
      cashBack = Math.min(cashBack, computeAvailableCashBack(row));
    } else {
      cashBack = 0;
    }

    const total = parseFloat((subtotal + tax_amount - disc - storeCredit - cashBack).toFixed(2));

    // Split tender: an optional array of {method, amount, approval_code} legs
    // that together cover the total, instead of a single payment_method.
    // Charge Account is deliberately not allowed as a leg — it has its own
    // AR side effects (account_balance, credit checks) that assume the whole
    // transaction total, not a partial amount.
    let tenderLegs = null;
    if (tenders && tenders.length) {
      if (tenders.some(leg => leg.method === 'credit')) return res.status(400).json({ error: 'Charge Account cannot be combined with other payment methods in a split payment' });
      const legSum = parseFloat(tenders.reduce((sum, leg) => sum + parseFloat(leg.amount || 0), 0).toFixed(2));
      if (Math.abs(legSum - total) > 0.01) return res.status(400).json({ error: `Split tender amounts (${legSum.toFixed(2)}) don't match the total (${total.toFixed(2)})` });
      tenderLegs = tenders.map(leg => ({ payment_method: leg.method, amount: parseFloat(leg.amount || 0), approval_code: leg.approval_code || null }));
    }

    const method = tenderLegs ? (tenderLegs.length > 1 ? 'split' : tenderLegs[0].payment_method) : (payment_method || 'cash');
    const isCredit = method === 'credit';

    if (isCredit && customer_id) {
      const { rows: [cust] } = await db.execute({ sql: 'SELECT customer_type, account_blocked FROM customers WHERE id = ?', args: [customer_id] });
      if (!cust) return res.status(400).json({ error: 'Customer not found' });
      if (cust.customer_type !== 'credit') return res.status(400).json({ error: 'Customer does not have a credit account' });
      if (cust.account_blocked) return res.status(400).json({ error: 'Customer account is blocked due to overdue payment. Please settle the outstanding balance first.' });
    }

    const tendered = tenderLegs ? total : parseFloat(amount_tendered || (isCredit ? 0 : total));
    const change = tenderLegs ? 0 : (isCredit ? 0 : parseFloat((tendered - total).toFixed(2)));
    const finalApprovalCode = tenderLegs ? (tenderLegs.length === 1 ? tenderLegs[0].approval_code : null) : (approval_code || null);

    const tx = await db.transaction('write');
    let committed = false;
    try {
      const txSource = req.apiKey ? 'online' : 'pos';
      const txResult = await tx.execute({ sql: `INSERT INTO transactions (transaction_number,customer_id,employee_id,branch_id,drawer_session_id,subtotal,tax_amount,discount_amount,promotion_code,promotion_name,total,payment_method,amount_tendered,change_amount,is_credit,notes,source_return_id,store_credit_applied,cash_back_applied,tax_exempt,tax_exemption_number,approval_code,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [transaction_number, customer_id || null, employee_id || 1, branch_id || null, drawer_session_id || null, subtotal, tax_amount, disc, promotion_code || null, promotion_name || null, total, method, tendered, change > 0 ? change : 0, isCredit ? 1 : 0, notes || null, source_return_id || null, storeCredit > 0 ? storeCredit : 0, cashBack > 0 ? cashBack : 0, isTaxExempt, tax_exemption_number || null, finalApprovalCode, txSource] });
      const txId = Number(txResult.lastInsertRowid);

      const paymentLegs = tenderLegs || [{ payment_method: method, amount: total, approval_code: finalApprovalCode }];
      for (const leg of paymentLegs) {
        await tx.execute({ sql: 'INSERT INTO transaction_payments (transaction_id, payment_method, amount, approval_code) VALUES (?,?,?,?)', args: [txId, leg.payment_method, leg.amount, leg.approval_code || null] });
      }

      for (const { product, variation, quantity, unit_price, lineTotal, lineTax, discount, discountPercent, discountOverrideBy } of processedItems) {
        const itemName = variation ? `${product.name} — ${variation.name}` : product.name;
        const itemSku = variation ? variation.sku : product.sku;
        await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_id,product_name,sku,quantity,unit_price,discount_amount,tax_amount,total,variation_id,variation_name,discount_percent,discount_override_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [txId, product.id, itemName, itemSku, quantity, unit_price, discount, lineTax, lineTotal, variation?.id||null, variation?.name||null, discountPercent || 0, discountOverrideBy || null] });
        if (variation) {
          await tx.execute({ sql: 'UPDATE product_variations SET stock_qty = stock_qty - ? WHERE id = ?', args: [quantity, variation.id] });
        } else {
          await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?', args: [quantity, product.id] });
        }
        if (branch_id) {
          if (req.apiKey) {
            // Online order: only touch the selected branch's existing stock record — no INSERT
            // to avoid creating a record with a wrong initial value from global stock
            await tx.execute({ sql: 'UPDATE branch_inventory SET stock_qty = MAX(0, stock_qty - ?), updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND branch_id = ?', args: [quantity, product.id, branch_id] });
          } else {
            await tx.execute({ sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = MAX(0, stock_qty - ?), updated_at = CURRENT_TIMESTAMP`, args: [product.id, branch_id, Math.max(0, product.stock_qty - quantity), product.min_stock, quantity] });
          }
          await syncBinQty(tx, product.id, branch_id, -quantity);
        }
      }

      if (customer_id) {
        const loyaltyPts = Math.floor(total * 0.5);
        await tx.execute({ sql: 'UPDATE customers SET loyalty_points = loyalty_points + ?, total_spent = total_spent + ? WHERE id = ?', args: [loyaltyPts, total, customer_id] });
        if (isCredit) {
          await tx.execute({ sql: 'UPDATE customers SET account_balance = account_balance + ? WHERE id = ?', args: [total, customer_id] });
        }
        if (storeCredit > 0) {
          // account_balance is a receivable (positive = customer owes the
          // store); a credit note decrements it negative (store owes them —
          // see the return-resolution handling below). Applying that credit
          // here moves the balance back toward zero, clamped so it can't
          // cross into positive (the frontend already caps storeCredit at
          // the available |balance|, this is defense-in-depth only).
          await tx.execute({ sql: 'UPDATE customers SET account_balance = MIN(0, account_balance + ?) WHERE id = ?', args: [storeCredit, customer_id] });
        }
        if (cashBack > 0 && cashBackCard) {
          // Consume points proportionally to the dollar amount actually
          // applied (which may be less than a full reward chunk if the cart
          // total was smaller) — e.g. redeeming $3 of a "500 pts = $5" reward
          // deducts 300 points, leaving 200 still accruing toward the next one.
          const pointsToDeduct = Math.round((cashBack / cashBackCard.reward_amount) * cashBackCard.points_threshold);
          await tx.execute({ sql: 'UPDATE customers SET loyalty_points = MAX(0, loyalty_points - ?), cash_back_last_redeemed_at = CURRENT_TIMESTAMP WHERE id = ?', args: [pointsToDeduct, customer_id] });
        }
      }

      if (quote_id) {
        await tx.execute({ sql: `UPDATE quotations SET status = 'converted', converted_to_tx = ? WHERE id = ? AND status NOT IN ('converted','declined','cancelled')`, args: [txId, quote_id] });
      }

      await tx.commit();
      committed = true;

      const { rows: [savedTx] } = await db.execute({ sql: `SELECT t.*, c.first_name || ' ' || c.last_name as customer_name, b.name as branch_name, b.address as branch_address, b.city as branch_city, b.state as branch_state, b.zip as branch_zip, b.phone as branch_phone FROM transactions t LEFT JOIN customers c ON t.customer_id = c.id LEFT JOIN branches b ON t.branch_id = b.id WHERE t.id = ?`, args: [txId] });
      const { rows: txItems } = await db.execute({ sql: 'SELECT * FROM transaction_items WHERE transaction_id = ?', args: [txId] });
      savedTx.items = txItems;
      const { rows: txPayments } = await db.execute({ sql: 'SELECT * FROM transaction_payments WHERE transaction_id = ? ORDER BY id', args: [txId] });
      savedTx.payments = txPayments;
      // Commission normally credits whoever rang up the sale — but a sale
      // completed from a quote credits the quote's original_employee_id
      // instead, so a quote reassigned to another salesperson for completion
      // (see PATCH /quotations/:id/reassign) still pays the salesperson who
      // originally brought in the deal, not whoever finished the paperwork.
      let commissionEmployeeId = savedTx.employee_id;
      if (quote_id) {
        try {
          const { rows: [q] } = await db.execute({ sql: 'SELECT employee_id, original_employee_id FROM quotations WHERE id = ?', args: [quote_id] });
          if (q) commissionEmployeeId = q.original_employee_id || q.employee_id || commissionEmployeeId;
        } catch(e) {}
      }
      // Auto-calculate commission (non-blocking, best-effort)
      try { await calcCommission(commissionEmployeeId, savedTx.total, 'transaction', txId, savedTx.transaction_number); } catch(e) {}
      res.status(201).json(savedTx);
    } catch(e) {
      // Once committed, the sale is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get returns for a transaction
router.get('/:id/returns', requireAuth, async (req, res) => {
  try {
    const { rows: returns } = await db.execute({ sql: 'SELECT * FROM returns WHERE original_transaction_id = ?', args: [req.params.id] });
    for (const r of returns) {
      const { rows: items } = await db.execute({ sql: 'SELECT * FROM return_items WHERE return_id = ?', args: [r.id] });
      r.items = items;
    }
    res.json(returns);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Single return by its own id, fully joined — used to build/reprint/email the
// return receipt (routes/email.js's buildReturnReceiptHtml needs these joins).
router.get('/returns/:id', requireAuth, async (req, res) => {
  try {
    const { rows: [ret] } = await db.execute({ sql: `SELECT r.*, t.transaction_number as original_transaction_number,
      c.first_name || ' ' || c.last_name as customer_name, c.email as customer_email,
      e.first_name || ' ' || e.last_name as employee_name,
      b.name as branch_name, b.address as branch_address, b.city as branch_city, b.state as branch_state, b.zip as branch_zip, b.phone as branch_phone
      FROM returns r
      LEFT JOIN transactions t ON r.original_transaction_id = t.id
      LEFT JOIN customers c ON r.customer_id = c.id
      LEFT JOIN employees e ON r.employee_id = e.id
      LEFT JOIN branches b ON r.branch_id = b.id
      WHERE r.id = ?`, args: [req.params.id] });
    if (!ret) return res.status(404).json({ error: 'Return not found' });
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM return_items WHERE return_id = ?', args: [req.params.id] });
    ret.items = items;
    res.json(ret);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Shared by the fulfillment route below and by routes/warehouse.js, which calls
// this when a shipment linked to an online order changes status (ship/deliver/cancel).
async function updateFulfillmentStatus(txId, fulfillment_status) {
  const valid = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
  if (!valid.includes(fulfillment_status)) {
    const e = new Error(`Invalid status. Must be one of: ${valid.join(', ')}`);
    e.status = 400;
    throw e;
  }
  await db.execute({ sql: 'UPDATE transactions SET fulfillment_status = ? WHERE id = ?', args: [fulfillment_status, txId] });
  const { rows: [tx] } = await db.execute({ sql: 'SELECT * FROM transactions WHERE id = ?', args: [txId] });
  if (!tx) {
    const e = new Error('Transaction not found');
    e.status = 404;
    throw e;
  }

  // Push status to WooCommerce if this order was imported from WC
  if (tx.source === 'woocommerce') {
    const wcStatusMap = { pending: 'pending', processing: 'processing', shipped: 'on-hold', delivered: 'completed', cancelled: 'cancelled' };
    try {
      const { rows: [map] } = await db.execute({ sql: "SELECT woo_id FROM woo_sync_map WHERE entity_type='order' AND local_id=?", args: [tx.id] });
      if (map?.woo_id) {
        const s = await getWcSettings();
        await wcRequest(s, 'PUT', `/orders/${map.woo_id}`, { status: wcStatusMap[fulfillment_status] });
      }
    } catch(e) { /* non-fatal — POS update already saved */ }
  }

  return tx;
}

// Update fulfillment status (online orders)
router.patch('/:id/fulfillment', requirePermission('transactions'), async (req, res) => {
  try {
    const tx = await updateFulfillmentStatus(req.params.id, req.body.fulfillment_status);
    res.json(tx);
  } catch(e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Process a return
router.post('/:id/return', requirePermission('transactions_returns'), async (req, res) => {
  try {
    const { items, resolution, notes, employee_id } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items selected for return' });
    if (!['refund', 'replacement', 'credit_note'].includes(resolution)) return res.status(400).json({ error: 'Invalid resolution type' });

    const { rows: [tx] } = await db.execute({ sql: 'SELECT * FROM transactions WHERE id = ?', args: [req.params.id] });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status !== 'completed') return res.status(400).json({ error: 'Only completed transactions can be returned' });
    if (resolution === 'credit_note' && !tx.customer_id) return res.status(400).json({ error: 'Credit note requires a customer on the original transaction' });

    // Same reasoning as the void guard below: a rental's checkout/settlement
    // transaction never decremented stock, so "returning" it here would
    // incorrectly inflate stock — use the Rentals screen's Process Return
    // instead, which correctly handles duration/damage/deposit accounting.
    const { rows: [linkedAgreement] } = await db.execute({ sql: 'SELECT agreement_number FROM rental_agreements WHERE checkout_transaction_id = ? OR settlement_transaction_id = ?', args: [req.params.id, req.params.id] });
    if (linkedAgreement) {
      return res.status(400).json({ error: `This transaction belongs to rental agreement ${linkedAgreement.agreement_number} — process the return from the Rentals screen instead.` });
    }

    const { rows: txItems } = await db.execute({ sql: 'SELECT * FROM transaction_items WHERE transaction_id = ?', args: [req.params.id] });

    const { rows: alreadyReturned } = await db.execute({ sql: `SELECT ri.transaction_item_id, SUM(ri.quantity) as returned_qty FROM return_items ri JOIN returns r ON ri.return_id = r.id WHERE r.original_transaction_id = ? AND r.status != 'cancelled' GROUP BY ri.transaction_item_id`, args: [req.params.id] });
    const returnedMap = {};
    alreadyReturned.forEach(r => { returnedMap[r.transaction_item_id] = r.returned_qty; });

    let returnSubtotal = 0, returnTax = 0;
    const processedItems = [];

    for (const item of items) {
      const txItem = txItems.find(i => i.id === item.transaction_item_id);
      if (!txItem) return res.status(400).json({ error: `Item ${item.transaction_item_id} not found in transaction` });
      const alreadyRet = returnedMap[item.transaction_item_id] || 0;
      const maxQty = txItem.quantity - alreadyRet;
      if (item.quantity <= 0 || item.quantity > maxQty) return res.status(400).json({ error: `Invalid quantity for "${txItem.product_name}". Max returnable: ${maxQty}` });
      const proportion = item.quantity / txItem.quantity;
      const lineTotal = parseFloat((txItem.total * proportion).toFixed(2));
      const lineTax = parseFloat((txItem.tax_amount * proportion).toFixed(2));
      returnSubtotal += lineTotal;
      returnTax += lineTax;
      processedItems.push({ txItem, quantity: item.quantity, lineTotal, lineTax });
    }

    returnSubtotal = parseFloat(returnSubtotal.toFixed(2));
    returnTax = parseFloat(returnTax.toFixed(2));
    const returnTotal = parseFloat((returnSubtotal + returnTax).toFixed(2));

    const return_number = await nextNumber(db, 'returns', 'return_number', 'RET-', 6);

    const retTx = await db.transaction('write');
    let committed = false;
    try {
      const retResult = await retTx.execute({ sql: `INSERT INTO returns (return_number,original_transaction_id,customer_id,employee_id,branch_id,resolution,subtotal,tax_amount,total,notes) VALUES (?,?,?,?,?,?,?,?,?,?)`, args: [return_number, tx.id, tx.customer_id, employee_id || tx.employee_id, tx.branch_id, resolution, returnSubtotal, returnTax, returnTotal, notes || null] });
      const retId = Number(retResult.lastInsertRowid);

      for (const { txItem, quantity, lineTotal, lineTax } of processedItems) {
        await retTx.execute({ sql: `INSERT INTO return_items (return_id,transaction_item_id,product_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?,?,?)`, args: [retId, txItem.id, txItem.product_id, txItem.product_name, txItem.sku, quantity, txItem.unit_price, lineTax, lineTotal] });
        await retTx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [quantity, txItem.product_id] });
        if (tx.branch_id) {
          await retTx.execute({ sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at) VALUES (?, ?, ?, (SELECT min_stock FROM products WHERE id = ?), CURRENT_TIMESTAMP) ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP`, args: [txItem.product_id, tx.branch_id, quantity, txItem.product_id, quantity] });
          await syncBinQty(retTx, txItem.product_id, tx.branch_id, quantity);
        }
      }

      if (tx.customer_id) {
        const loyaltyPts = Math.floor(returnTotal * 0.5);
        await retTx.execute({ sql: 'UPDATE customers SET loyalty_points = MAX(0, loyalty_points - ?), total_spent = MAX(0, total_spent - ?) WHERE id = ?', args: [loyaltyPts, returnTotal, tx.customer_id] });
        if (resolution === 'credit_note') {
          // account_balance is a receivable (what the customer owes — see
          // the Accounts Receivable page). A credit note reduces that,
          // going negative if there's nothing owed, to represent store
          // credit the business now owes the customer — not increases it.
          await retTx.execute({ sql: 'UPDATE customers SET account_balance = account_balance - ? WHERE id = ?', args: [returnTotal, tx.customer_id] });
        }
      }

      await retTx.commit();
      committed = true;
      const { rows: [ret] } = await db.execute({ sql: 'SELECT * FROM returns WHERE id = ?', args: [retId] });
      const { rows: retItems } = await db.execute({ sql: 'SELECT * FROM return_items WHERE return_id = ?', args: [retId] });
      ret.items = retItems;
      res.status(201).json(ret);
    } catch(e) {
      // Once committed, the return is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await retTx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Void transaction
// requireAuth as an outer gate only — the actual authorization for a void is
// the existing inline PIN + void_transactions permission check just below,
// which is preserved exactly as-is (a second, elevated re-auth factor, not
// replaced by session auth).
router.patch('/:id/void', requireAuth, async (req, res) => {
  try {
    const { pin, reason } = req.body;
    if (!pin) return res.status(400).json({ error: 'Override PIN required' });

    const { rows: employees } = await db.execute({ sql: 'SELECT e.id, e.first_name, e.last_name, e.pin, sg.permissions FROM employees e LEFT JOIN security_groups sg ON e.security_group_id = sg.id WHERE e.active = 1', args: [] });
    const authorizer = employees.find(e => {
      if (e.pin !== String(pin)) return false;
      try { const p = JSON.parse(e.permissions || '{}'); return p.void_transactions === true; } catch { return false; }
    });
    if (!authorizer) return res.status(403).json({ error: 'Invalid PIN or insufficient privilege' });

    const { rows: [tx] } = await db.execute({ sql: 'SELECT * FROM transactions WHERE id = ?', args: [req.params.id] });
    if (!tx) return res.status(404).json({ error: 'Not found' });
    if (tx.status === 'voided') return res.status(400).json({ error: 'Already voided' });

    // Rental checkout/settlement transactions don't fit this endpoint's
    // assumptions: their transaction_items include synthetic lines with no
    // product_id (deposit, duration adjustment, damage fee — would crash the
    // branch_inventory restore below), and rental checkout never decremented
    // stock to begin with (see routes/rentals.js), so "restoring" it here
    // would inflate stock that was never actually removed. Cancelling a
    // rental agreement already correctly voids its checkout transaction and
    // reverses loyalty/credit without touching stock — use that instead.
    const { rows: [linkedAgreement] } = await db.execute({ sql: 'SELECT agreement_number FROM rental_agreements WHERE checkout_transaction_id = ? OR settlement_transaction_id = ?', args: [req.params.id, req.params.id] });
    if (linkedAgreement) {
      return res.status(400).json({ error: `This transaction belongs to rental agreement ${linkedAgreement.agreement_number} — cancel it from the Rentals screen instead (View agreement → Cancel Agreement), which correctly reverses the rental's own records.` });
    }

    const voidTxn = await db.transaction('write');
    try {
      await voidTxn.execute({ sql: "UPDATE transactions SET status='voided', voided_by=?, voided_at=CURRENT_TIMESTAMP, void_reason=? WHERE id=?", args: [authorizer.id, reason || null, req.params.id] });
      const { rows: items } = await voidTxn.execute({ sql: 'SELECT * FROM transaction_items WHERE transaction_id = ?', args: [req.params.id] });
      for (const item of items) {
        await voidTxn.execute({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [item.quantity, item.product_id] });
        if (tx.branch_id) {
          await voidTxn.execute({ sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at) VALUES (?, ?, ?, (SELECT min_stock FROM products WHERE id = ?), CURRENT_TIMESTAMP) ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP`, args: [item.product_id, tx.branch_id, item.quantity, item.product_id, item.quantity] });
          await syncBinQty(voidTxn, item.product_id, tx.branch_id, item.quantity);
        }
      }
      if (tx.customer_id) {
        const loyaltyPts = Math.floor(tx.total * 0.5);
        await voidTxn.execute({ sql: 'UPDATE customers SET loyalty_points = loyalty_points - ?, total_spent = total_spent - ? WHERE id = ?', args: [loyaltyPts, tx.total, tx.customer_id] });
        if (tx.is_credit) {
          await voidTxn.execute({ sql: 'UPDATE customers SET account_balance = MAX(0, account_balance - ?) WHERE id = ?', args: [tx.total, tx.customer_id] });
        }
      }
      await voidTxn.commit();
    } catch(e) {
      await voidTxn.rollback();
      throw e;
    }

    try { await db.execute({ sql: "DELETE FROM commission_records WHERE source_type='transaction' AND source_id=? AND status!='paid'", args: [req.params.id] }); } catch(e) {}
    res.json({ success: true, voided_by: `${authorizer.first_name} ${authorizer.last_name}` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.updateFulfillmentStatus = updateFulfillmentStatus;
