const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { getOutstandingQty } = require('../lib/rentalAvailability');
const { getBranchStock, feeFor, buildRentalLines, insertPendingAgreement } = require('../lib/rentals');
const { requirePermission, requireAnyPermission } = require('../lib/permissions');
const { runCreditCheck } = require('./customers');
const { nextNumber } = require('../lib/nextNumber');

// ─── Agreements list/detail ───────────────────────────────────────────────

router.get('/agreements', requirePermission('rentals'), async (req, res) => {
  try {
    const { customer_id, branch_id, view } = req.query;
    let sql = `SELECT ra.*, c.first_name || ' ' || c.last_name as customer_name,
      b.name as branch_name, e.first_name || ' ' || e.last_name as employee_name,
      q.quote_number as source_quote_number,
      co.payment_method as checkout_payment_method,
      se.total as settlement_total,
      (SELECT COUNT(*) FROM rental_agreement_items WHERE agreement_id = ra.id AND parent_item_id IS NULL) as item_count,
      CASE WHEN ra.status = 'active' AND ra.due_date < date('now') THEN 'overdue' ELSE ra.status END as display_status
      FROM rental_agreements ra
      LEFT JOIN customers c ON ra.customer_id = c.id
      LEFT JOIN branches b ON ra.branch_id = b.id
      LEFT JOIN employees e ON ra.employee_id = e.id
      LEFT JOIN quotations q ON q.converted_to_agreement_id = ra.id
      LEFT JOIN transactions co ON ra.checkout_transaction_id = co.id
      LEFT JOIN transactions se ON ra.settlement_transaction_id = se.id
      WHERE 1=1`;
    const params = [];
    if (customer_id) { sql += ' AND ra.customer_id = ?'; params.push(customer_id); }
    if (branch_id) { sql += ' AND ra.branch_id = ?'; params.push(branch_id); }
    if (view === 'overdue') { sql += " AND ra.status = 'active' AND ra.due_date < date('now')"; }
    else if (view === 'active') { sql += " AND ra.status = 'active'"; }
    else if (view === 'returned' || view === 'cancelled' || view === 'pending' || view === 'awaiting_issue') { sql += ' AND ra.status = ?'; params.push(view); }
    sql += ' ORDER BY ra.created_at DESC LIMIT 200';
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/agreements/:id', requirePermission('rentals'), async (req, res) => {
  try {
    const { rows: [agreement] } = await db.execute({ sql: `SELECT ra.*, c.first_name || ' ' || c.last_name as customer_name,
      c.phone as customer_phone, c.email as customer_email,
      c.address as customer_address, c.city as customer_city, c.state as customer_state, c.zip as customer_zip,
      b.name as branch_name, b.address as branch_address, b.city as branch_city, b.state as branch_state, b.zip as branch_zip, b.phone as branch_phone,
      e.first_name || ' ' || e.last_name as employee_name,
      co.transaction_number as checkout_transaction_number, co.payment_method as checkout_payment_method,
      se.transaction_number as settlement_transaction_number,
      q.id as source_quote_id, q.quote_number as source_quote_number, qe.first_name || ' ' || qe.last_name as quote_created_by,
      dd.first_name || ' ' || dd.last_name as delivery_driver_name,
      pd.first_name || ' ' || pd.last_name as pickup_driver_name,
      op.first_name || ' ' || op.last_name as operator_name,
      CASE WHEN ra.status = 'active' AND ra.due_date < date('now') THEN 'overdue' ELSE ra.status END as display_status
      FROM rental_agreements ra
      LEFT JOIN customers c ON ra.customer_id = c.id
      LEFT JOIN branches b ON ra.branch_id = b.id
      LEFT JOIN employees e ON ra.employee_id = e.id
      LEFT JOIN transactions co ON ra.checkout_transaction_id = co.id
      LEFT JOIN transactions se ON ra.settlement_transaction_id = se.id
      LEFT JOIN quotations q ON q.converted_to_agreement_id = ra.id
      LEFT JOIN employees qe ON q.employee_id = qe.id
      LEFT JOIN employees dd ON ra.delivery_driver_id = dd.id
      LEFT JOIN employees pd ON ra.pickup_driver_id = pd.id
      LEFT JOIN employees op ON ra.operator_id = op.id
      WHERE ra.id = ?`, args: [req.params.id] });
    if (!agreement) return res.status(404).json({ error: 'Not found' });
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [req.params.id] });
    agreement.items = items;
    res.json(agreement);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Availability ───────────────────────────────────────────────────────────

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

// ─── Hold (configure a rental, no payment yet) ─────────────────────────────

// Rental checkout is a two-step flow: this endpoint only sets aside items for
// a customer (status='pending') — no transaction, no charge, no loyalty/credit
// effects yet. A cashier later recalls it (it shows up alongside regular POS
// held orders — see GET /transactions?status=hold on the frontend, merged
// with GET /agreements?view=pending) and finalizes payment via
// PATCH /agreements/:id/checkout below, which is where money actually moves.
router.post('/agreements', requirePermission('rentals_checkout'), async (req, res) => {
  try {
    const {
      customer_id, employee_id, branch_id, due_date, items, notes,
      delivery_required, delivery_cost, delivery_address, pickup_required, pickup_cost,
      operator_required, operator_fee,
    } = req.body;
    if (!customer_id) return res.status(400).json({ error: 'A customer is required for rental checkout' });
    if (!branch_id) return res.status(400).json({ error: 'A branch/location is required for rental checkout' });
    if (!due_date) return res.status(400).json({ error: 'Due date is required' });
    if (!items || !items.length) return res.status(400).json({ error: 'At least one rental item is required' });

    let lines;
    try {
      lines = await buildRentalLines(db, { branch_id, items });
    } catch(e) { return res.status(400).json({ error: e.message }); }

    const agreement_number = await nextNumber(db, 'rental_agreements', 'agreement_number', 'RA-', 6);

    const tx = await db.transaction('write');
    let committed = false;
    try {
      // checkout_date/checkout_datetime are left at their column defaults
      // (today/now) here — meaningless until finalized, and overwritten with
      // the real values at that point (see PATCH .../checkout below). Delivery/
      // pickup/operator requirement + cost are decided now (up front, so the
      // cashier charges for them at checkout) — only WHO does the delivery/
      // operating (driver_id/operator_id) is deferred, to issue/return time.
      const agreementId = await insertPendingAgreement(tx, {
        agreement_number, customer_id, employee_id, branch_id, due_date, notes, lines,
        delivery_required: delivery_required ? 1 : 0, delivery_cost: delivery_required ? parseFloat(delivery_cost || 0) : 0,
        delivery_address: delivery_required ? (delivery_address || null) : null,
        pickup_required: pickup_required ? 1 : 0, pickup_cost: pickup_required ? parseFloat(pickup_cost || 0) : 0,
        operator_required: operator_required ? 1 : 0, operator_fee: operator_required ? parseFloat(operator_fee || 0) : 0,
      });

      await tx.commit();
      committed = true;
      const { rows: [agreement] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [agreementId] });
      const { rows: agItems } = await db.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [agreementId] });
      agreement.items = agItems;
      res.status(201).json(agreement);
    } catch(e) {
      // Once committed, the agreement is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Finalize checkout (collect payment on a held rental) ─────────────────

// Reachable by whoever is at the register, not just whoever configured the
// hold — a cashier with only `pos` (no `rentals_checkout`) can still finalize
// one, matching how it's surfaced in the POS's Recall list alongside regular
// held orders.
router.patch('/agreements/:id/checkout', requireAnyPermission('rentals_checkout', 'pos'), async (req, res) => {
  try {
    const { payment_method, amount_tendered, drawer_session_id, employee_id } = req.body;
    const { rows: [agreement] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [req.params.id] });
    if (!agreement) return res.status(404).json({ error: 'Not found' });
    if (agreement.status !== 'pending') return res.status(400).json({ error: `This agreement is ${agreement.status}, not awaiting checkout` });

    const { rows: existingItems } = await db.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [req.params.id] });
    if (!existingItems.length) return res.status(400).json({ error: 'This agreement has no items' });

    const method = payment_method || 'cash';
    const isCredit = method === 'credit';
    let creditCustomer = null;
    if (isCredit) {
      const { rows: [cust] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [agreement.customer_id] });
      if (!cust) return res.status(400).json({ error: 'Customer not found' });
      if (cust.customer_type !== 'credit') return res.status(400).json({ error: 'Customer does not have a credit account' });
      if (cust.account_blocked) return res.status(400).json({ error: 'Customer account is blocked due to overdue payment. Please settle the outstanding balance first.' });
      creditCustomer = cust;
    }

    // The rental clock starts NOW — when the customer actually takes the item
    // and payment is collected — not when the hold was originally configured.
    const checkoutDateTime = new Date();
    const dueDateTime = new Date(`${agreement.due_date}T${checkoutDateTime.toISOString().slice(11, 19)}.000Z`);

    let rentalSubtotal = 0, taxAmount = 0, depositTotal = 0;
    for (const item of existingItems) {
      item.rentalFee = item.is_mandatory ? 0 : feeFor({
        rental_classification: item.rental_classification,
        rental_rate: item.daily_rate,
        rental_weekly_rate: item.weekly_rate,
        rental_monthly_rate: item.monthly_rate,
        rental_hourly_rate: item.hourly_rate,
      }, item.quantity, checkoutDateTime, dueDateTime);
      item.depositAmount = item.rentalFee; // deposit == fee (double-charge model)
      item.lineTax = parseFloat((item.rentalFee * (item.tax_rate || 0) / 100).toFixed(2));
      rentalSubtotal += item.rentalFee;
      taxAmount += item.lineTax;
      depositTotal += item.depositAmount;
    }
    rentalSubtotal = parseFloat(rentalSubtotal.toFixed(2));
    taxAmount = parseFloat(taxAmount.toFixed(2));
    depositTotal = parseFloat(depositTotal.toFixed(2));

    // Delivery/pickup/operator requirement + cost were decided up front when
    // the rental was created (not here) — charged now, alongside the rental
    // fee and deposit, rather than trued up later at issue/return.
    const deliveryCost = agreement.delivery_required ? parseFloat(agreement.delivery_cost || 0) : 0;
    const pickupCost = agreement.pickup_required ? parseFloat(agreement.pickup_cost || 0) : 0;
    const operatorFee = agreement.operator_required ? parseFloat(agreement.operator_fee || 0) : 0;
    const serviceFeesTotal = parseFloat((deliveryCost + pickupCost + operatorFee).toFixed(2));

    const total = parseFloat((rentalSubtotal + taxAmount + depositTotal + serviceFeesTotal).toFixed(2));

    if (isCredit && creditCustomer.credit_limit > 0 && parseFloat((creditCustomer.account_balance + total).toFixed(2)) > creditCustomer.credit_limit) {
      const available = Math.max(0, parseFloat((creditCustomer.credit_limit - creditCustomer.account_balance).toFixed(2)));
      return res.status(400).json({ error: `This rental (${total.toFixed(2)}) would exceed the customer's credit limit. Available credit: ${available.toFixed(2)}` });
    }

    const tendered = isCredit ? 0 : parseFloat(amount_tendered || total);
    const changeAmt = isCredit ? 0 : Math.max(0, parseFloat((tendered - total).toFixed(2)));

    const transaction_number = await nextNumber(db, 'transactions', 'transaction_number', 'TXN-', 6);
    const finalizeEmployeeId = employee_id || agreement.employee_id;

    const tx = await db.transaction('write');
    let committed = false;
    try {
      const txResult = await tx.execute({ sql: `INSERT INTO transactions (transaction_number,customer_id,employee_id,branch_id,drawer_session_id,subtotal,tax_amount,total,payment_method,amount_tendered,change_amount,notes,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [transaction_number, agreement.customer_id, finalizeEmployeeId || null, agreement.branch_id, drawer_session_id || null, rentalSubtotal + depositTotal + serviceFeesTotal, taxAmount, total, method, tendered, changeAmt, `Rental checkout ${agreement.agreement_number}`, 'pos'] });
      const checkoutTxId = Number(txResult.lastInsertRowid);

      for (const item of existingItems) {
        await tx.execute({ sql: 'UPDATE rental_agreement_items SET rental_fee = ?, deposit_amount = ? WHERE id = ?', args: [item.rentalFee, item.depositAmount, item.id] });
        const itemLabel = item.parent_item_id != null ? `${item.product_name}${item.is_mandatory ? ' (included)' : ' (accessory)'}` : item.product_name;
        await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?,?)`, args: [checkoutTxId, item.product_id, itemLabel, item.sku, item.quantity, item.is_mandatory ? 0 : (item.rentalFee / item.quantity), item.lineTax, item.rentalFee] });
      }
      if (depositTotal > 0) {
        await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?,?)`, args: [checkoutTxId, null, 'Refundable Deposit', 'DEPOSIT', 1, depositTotal, 0, depositTotal] });
      }
      if (deliveryCost > 0) {
        await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?)`, args: [checkoutTxId, 'Delivery Fee', 'DELIVERY', 1, deliveryCost, 0, deliveryCost] });
      }
      if (pickupCost > 0) {
        await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?)`, args: [checkoutTxId, 'Pickup Fee', 'PICKUP', 1, pickupCost, 0, pickupCost] });
      }
      if (operatorFee > 0) {
        await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?)`, args: [checkoutTxId, 'Operator Fee', 'OPERATOR', 1, operatorFee, 0, operatorFee] });
      }

      const loyaltyPts = Math.floor(rentalSubtotal * 0.5);
      await tx.execute({ sql: 'UPDATE customers SET loyalty_points = loyalty_points + ?, total_spent = total_spent + ? WHERE id = ?', args: [loyaltyPts, rentalSubtotal, agreement.customer_id] });

      if (isCredit) {
        await tx.execute({ sql: 'UPDATE customers SET account_balance = account_balance + ? WHERE id = ?', args: [total, agreement.customer_id] });
      }

      // checkout_date/checkout_datetime are NOT written here anymore — the
      // rental clock only starts once the item is actually issued/dispatched
      // (PATCH .../issue), which writes those same two columns for real.
      await tx.execute({ sql: `UPDATE rental_agreements SET checkout_transaction_id = ?, deposit_total = ?, status = 'awaiting_issue', employee_id = ? WHERE id = ?`, args: [checkoutTxId, depositTotal, finalizeEmployeeId || null, req.params.id] });
      await tx.commit();
      committed = true;
      if (isCredit) { try { await runCreditCheck(agreement.customer_id); } catch(e) {} }

      const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [req.params.id] });
      const { rows: agItems } = await db.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [req.params.id] });
      updated.items = agItems;
      res.json(updated);
    } catch(e) {
      // Once committed, the checkout is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Issue / dispatch (hand the item to the customer, or send it out) ──────

// This is what actually starts the rental clock — checkout only collects
// payment. Between the two, a paid agreement sits in 'awaiting_issue' as
// something waiting to be collected/delivered (e.g. stock held off-site).
router.patch('/agreements/:id/issue', requirePermission('rentals_issue'), async (req, res) => {
  try {
    // Whether delivery/an operator is needed, and what it costs, was already
    // decided (and charged for) when the rental was created — this step only
    // assigns WHO does it, for whichever of those the agreement already flags
    // as required.
    const { employee_id, delivery_driver_id, operator_id } = req.body;
    const { rows: [agreement] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [req.params.id] });
    if (!agreement) return res.status(404).json({ error: 'Not found' });
    if (agreement.status !== 'awaiting_issue') return res.status(400).json({ error: `This agreement is ${agreement.status}, not awaiting issue` });

    const issuedAt = new Date();
    const today = issuedAt.toISOString().slice(0, 10);

    await db.execute({
      sql: `UPDATE rental_agreements SET
        status = 'active',
        checkout_date = ?, checkout_datetime = ?,
        issued_at = ?, issued_by = ?,
        delivery_driver_id = ?, operator_id = ?
        WHERE id = ?`,
      args: [
        today, issuedAt.toISOString(),
        issuedAt.toISOString(), employee_id || agreement.employee_id || null,
        agreement.delivery_required ? (delivery_driver_id || null) : null,
        agreement.operator_required ? (operator_id || null) : null,
        req.params.id,
      ],
    });

    const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [req.params.id] });
    const { rows: agItems } = await db.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [req.params.id] });
    updated.items = agItems;
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Cancel ─────────────────────────────────────────────────────────────────

router.patch('/agreements/:id/cancel', requirePermission('rentals_returns'), async (req, res) => {
  try {
    const { reason, employee_id } = req.body;
    const { rows: [agreement] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [req.params.id] });
    if (!agreement) return res.status(404).json({ error: 'Not found' });
    // 'pending' (held, not yet paid) agreements have no checkout_transaction_id
    // yet, so the void/loyalty-reversal/credit-reversal block below naturally
    // no-ops for them — this guard just needs to allow that status through too.
    // 'awaiting_issue' (paid but not yet issued) is treated like 'active' —
    // it has a real checkout_transaction_id to void.
    if (agreement.status !== 'active' && agreement.status !== 'pending' && agreement.status !== 'awaiting_issue') return res.status(400).json({ error: `Cannot cancel a ${agreement.status} agreement` });
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [req.params.id] });
    if (items.some(i => i.quantity_returned > 0)) return res.status(400).json({ error: 'Cannot cancel an agreement that already has items returned — process a return instead' });

    let reversedCreditCustomerId = null;
    const tx = await db.transaction('write');
    try {
      if (agreement.checkout_transaction_id) {
        const { rows: [checkoutTx] } = await tx.execute({ sql: 'SELECT * FROM transactions WHERE id = ?', args: [agreement.checkout_transaction_id] });
        if (checkoutTx && checkoutTx.status !== 'voided') {
          await tx.execute({ sql: "UPDATE transactions SET status='voided', voided_by=?, voided_at=CURRENT_TIMESTAMP, void_reason=? WHERE id=?", args: [employee_id || null, reason || null, agreement.checkout_transaction_id] });
          if (checkoutTx.customer_id) {
            // Loyalty was only ever accrued on the rental-fee portion of the
            // checkout, not the deposit (see POST /agreements) — reverse that
            // same amount, not the full subtotal, or this double-deducts the deposit.
            const rentalFeePortion = (checkoutTx.subtotal || 0) - (agreement.deposit_total || 0);
            const loyaltyPts = Math.floor(rentalFeePortion * 0.5);
            await tx.execute({ sql: 'UPDATE customers SET loyalty_points = MAX(0, loyalty_points - ?), total_spent = MAX(0, total_spent - ?) WHERE id = ?', args: [loyaltyPts, rentalFeePortion, checkoutTx.customer_id] });
            // The checkout billed the full total to the customer's account —
            // voiding it must take that same amount back off, or the receivable
            // for a cancelled rental would stay on the books forever.
            if (checkoutTx.payment_method === 'credit') {
              await tx.execute({ sql: 'UPDATE customers SET account_balance = MAX(0, account_balance - ?) WHERE id = ?', args: [checkoutTx.total, checkoutTx.customer_id] });
              reversedCreditCustomerId = checkoutTx.customer_id;
            }
          }
        }
      }
      // A pending agreement created by converting a rental quote points
      // quotations.converted_to_agreement_id back at it — if it's cancelled
      // before ever being finalized, revert the quote to 'accepted' so it
      // isn't left stranded in 'converted' with no way to re-convert it
      // (mirrors DELETE /transactions/:id/hold's revert for a cancelled
      // retail hold sourced from a quote).
      await tx.execute({ sql: `UPDATE quotations SET status = 'accepted', converted_to_agreement_id = NULL WHERE converted_to_agreement_id = ?`, args: [req.params.id] });
      await tx.execute({ sql: "UPDATE rental_agreements SET status = 'cancelled', cancellation_reason = ?, cancelled_by = ?, cancelled_at = CURRENT_TIMESTAMP WHERE id = ?", args: [reason || null, employee_id || null, req.params.id] });
      await tx.commit();
      if (reversedCreditCustomerId) { try { await runCreditCheck(reversedCreditCustomerId); } catch(e) {} }
    } catch(e) {
      await tx.rollback();
      return res.status(400).json({ error: e.message });
    }
    // Fully joined shape (same as GET /agreements/:id) so the frontend can
    // build a cancellation receipt straight from this response, no second call.
    const { rows: [updated] } = await db.execute({ sql: `SELECT ra.*, c.first_name || ' ' || c.last_name as customer_name,
      c.phone as customer_phone, c.email as customer_email,
      b.name as branch_name, e.first_name || ' ' || e.last_name as employee_name,
      ce.first_name || ' ' || ce.last_name as cancelled_by_name,
      co.transaction_number as checkout_transaction_number, co.payment_method as checkout_payment_method, co.total as checkout_total
      FROM rental_agreements ra
      LEFT JOIN customers c ON ra.customer_id = c.id
      LEFT JOIN branches b ON ra.branch_id = b.id
      LEFT JOIN employees e ON ra.employee_id = e.id
      LEFT JOIN employees ce ON ra.cancelled_by = ce.id
      LEFT JOIN transactions co ON ra.checkout_transaction_id = co.id
      WHERE ra.id = ?`, args: [req.params.id] });
    const { rows: updatedItems } = await db.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [req.params.id] });
    updated.items = updatedItems;
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Return ─────────────────────────────────────────────────────────────────

router.patch('/agreements/:id/return', requirePermission('rentals_returns'), async (req, res) => {
  try {
    const { items, duration_adjustment_override, payment_method, drawer_session_id, pickup_driver_id, returned_at } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'At least one item is required' });

    const { rows: [agreement] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [req.params.id] });
    if (!agreement) return res.status(404).json({ error: 'Not found' });
    if (agreement.status !== 'active') return res.status(400).json({ error: `Cannot return items on a ${agreement.status} agreement` });

    const { rows: existingItems } = await db.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [req.params.id] });
    const outstandingIds = existingItems.filter(i => i.quantity_returned < i.quantity).map(i => i.id);
    const coveredIds = items.map(i => i.item_id);
    const missing = outstandingIds.filter(id => !coveredIds.includes(id));
    if (missing.length) return res.status(400).json({ error: 'Every outstanding item on this agreement must be included in the return' });

    const checkoutDateTime = agreement.checkout_datetime || `${agreement.checkout_date}T00:00:00.000Z`;
    // Defaults to the moment this request is processed, but staff can back-date
    // it to when the customer actually dropped the item off (e.g. it sat at the
    // counter for an hour before anyone rang it up) — the fee is time-sensitive,
    // so an unadjusted gap here would overcharge for time nobody actually used.
    let now = new Date();
    if (returned_at) {
      const parsed = new Date(returned_at);
      if (isNaN(parsed.getTime())) return res.status(400).json({ error: 'Invalid return date/time' });
      // A few minutes of tolerance absorbs clock skew between the browser and
      // server, plus the datetime-local input's minute-level (no seconds) precision
      // — without it, submitting the untouched "now" default could spuriously fail.
      if (parsed.getTime() > Date.now() + 5 * 60000) return res.status(400).json({ error: 'Return date/time cannot be in the future' });
      if (parsed < new Date(checkoutDateTime)) return res.status(400).json({ error: 'Return date/time cannot be before checkout' });
      now = parsed;
    }

    // A rental checked out on credit must also settle on credit — the deposit was
    // never collected in cash to begin with, it just increased account_balance, so
    // the settlement (whichever way it nets out) has to adjust that same balance
    // rather than being collected/refunded at the counter. This is why the return
    // modal has no payment-method picker: it's derived from how checkout was billed,
    // not chosen fresh each time.
    let checkoutIsCredit = false;
    if (agreement.checkout_transaction_id) {
      const { rows: [coTx] } = await db.execute({ sql: 'SELECT payment_method FROM transactions WHERE id = ?', args: [agreement.checkout_transaction_id] });
      checkoutIsCredit = !!coTx && coTx.payment_method === 'credit';
    }

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

      // Delivery/pickup/operator requirement + cost were already decided (and
      // charged for) when the rental was created — pickup_driver_id here just
      // records who actually did the pickup, no fee to fold into settlement.
      const pickupDriverId = agreement.pickup_required ? (pickup_driver_id || agreement.pickup_driver_id || null) : null;

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

      const transaction_number = await nextNumber(tx, 'transactions', 'transaction_number', 'TXN-', 6);
      const method = checkoutIsCredit ? 'credit' : (settlementAmount >= 0 ? (payment_method || 'cash') : 'refund');
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

      // settlementAmount is already signed the right way for this: positive
      // increases what's owed, negative nets the deposit back out — a plain
      // `+=` handles both charge and refund-style settlements in one line, with
      // no separate "collect" vs "refund" branch needed for a credit account.
      if (checkoutIsCredit) {
        await tx.execute({ sql: 'UPDATE customers SET account_balance = MAX(0, account_balance + ?) WHERE id = ?', args: [settlementAmount, agreement.customer_id] });
      }

      await tx.execute({ sql: `UPDATE rental_agreements SET settlement_transaction_id = ?, deposit_refunded = ?, duration_adjustment_total = duration_adjustment_total + ?, tax_adjustment_total = tax_adjustment_total + ?, damage_fee_total = damage_fee_total + ?, pickup_driver_id = ?, status = ?, returned_at = ? WHERE id = ?`, args: [settlementTxId, depositRefunded, durationAdjustmentTotal, taxAdjustmentTotal, damageFeeTotal, pickupDriverId, newStatus, allReturned ? now.toISOString() : agreement.returned_at, req.params.id] });
      await tx.commit();
      if (checkoutIsCredit) { try { await runCreditCheck(agreement.customer_id); } catch(e) {} }
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

// ─── Credit notes (Deposits & Credit Notes tab) ────────────────────────────

// A return can leave a refund due (deposit exceeded actual fee + damage —
// see the settlement math above) when the checkout wasn't billed to a
// credit account. For a credit account, that refund already lands as an
// account_balance reduction automatically (the `checkoutIsCredit` branch
// above). For everyone else, the settlement transaction is recorded as a
// 'refund' for the register to pay out in cash/card — this endpoint lets
// staff instead issue that amount as store credit on the customer's
// account, retroactively, without touching the settlement transaction
// record itself (it stays as the audit trail of what was computed at
// return time). Unlike a purchase (which increases account_balance, a
// receivable), a credit note DECREASES it — allowed to go negative to
// represent credit the store now owes the customer.
router.post('/agreements/:id/credit-note', requirePermission('rentals_returns'), async (req, res) => {
  try {
    const { amount, employee_id } = req.body;
    const { rows: [agreement] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [req.params.id] });
    if (!agreement) return res.status(404).json({ error: 'Not found' });
    if (agreement.status !== 'returned') return res.status(400).json({ error: 'Credit notes can only be issued on a returned agreement' });
    if (!agreement.customer_id) return res.status(400).json({ error: 'This agreement has no customer to credit' });
    if (agreement.credit_note_amount > 0) return res.status(400).json({ error: `A credit note for ${agreement.credit_note_amount} has already been issued on this agreement` });

    const { rows: [settlementTx] } = agreement.settlement_transaction_id
      ? await db.execute({ sql: 'SELECT * FROM transactions WHERE id = ?', args: [agreement.settlement_transaction_id] })
      : { rows: [null] };
    if (!settlementTx || settlementTx.total >= 0) return res.status(400).json({ error: 'No refund is due on this agreement' });

    const { rows: [checkoutTx] } = agreement.checkout_transaction_id
      ? await db.execute({ sql: 'SELECT payment_method FROM transactions WHERE id = ?', args: [agreement.checkout_transaction_id] })
      : { rows: [null] };
    if (checkoutTx && checkoutTx.payment_method === 'credit') return res.status(400).json({ error: 'This rental was billed to a credit account — the refund already applied to account_balance automatically at return' });

    const refundDue = parseFloat((-settlementTx.total).toFixed(2));
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Amount must be greater than 0' });
    if (amt > refundDue + 0.01) return res.status(400).json({ error: `Amount cannot exceed the refund due (${refundDue})` });

    const tx = await db.transaction('write');
    let committed = false;
    try {
      await tx.execute({ sql: 'UPDATE customers SET account_balance = account_balance - ? WHERE id = ?', args: [amt, agreement.customer_id] });
      await tx.execute({ sql: 'UPDATE rental_agreements SET credit_note_amount = ?, credit_note_issued_at = CURRENT_TIMESTAMP, credit_note_issued_by = ? WHERE id = ?', args: [amt, employee_id || null, agreement.id] });
      await tx.commit();
      committed = true;
      const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [agreement.id] });
      res.json(updated);
    } catch(e) {
      // Once committed, the credit note is saved — rolling back a closed
      // transaction throws and would crash the process (unhandled
      // rejection), so only roll back if the commit itself never happened.
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
