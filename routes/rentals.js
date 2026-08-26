const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { getOutstandingQty } = require('../lib/rentalAvailability');
const { getBranchStock, feeFor, buildRentalLines, insertPendingAgreement, assertRentalCustomerEligible, dueDateTime } = require('../lib/rentals');
const { requirePermission, requireAnyPermission, can } = require('../lib/permissions');
const { runCreditCheck } = require('./customers');
const { nextNumber } = require('../lib/nextNumber');
const { calcRentalCommission } = require('./commissions');
const { logActivity } = require('./crm');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { cloudUpload } = require('../lib/cloudinary');

const localPoAttachmentDir = path.join(__dirname, '../uploads/rental-po-attachments');

const uploadPoAttachment = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf','image/jpeg','image/png','image/gif','image/webp'];
    cb(null, allowed.includes(file.mimetype));
  },
});

// A canvas signature pad already gives us a base64 PNG client-side, so this
// skips multer/multipart entirely — same cloudUpload-or-local-disk fallback
// routes/customers.js's ID-scan upload uses, just fed a decoded Buffer
// instead of req.file.buffer. Shared by three call sites (customer's
// signature at issue, the guard's at issue, the guard's at return) so the
// decode/upload logic exists in exactly one place.
async function uploadSignature(dataUrl, filenamePrefix) {
  const match = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) return null;
  const buffer = Buffer.from(match[2], 'base64');
  const cloudResult = await cloudUpload(buffer, {
    folder: 'pos-system/rental-signatures',
    public_id: `${filenamePrefix}-${Date.now()}`,
    overwrite: true,
    resource_type: 'image',
  });
  if (cloudResult) return cloudResult.secure_url;
  const dir = path.join(__dirname, '../uploads/rental-signatures');
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${filenamePrefix}-${Date.now()}.${match[1]}`;
  fs.writeFileSync(path.join(dir, filename), buffer);
  return `/uploads/rental-signatures/${filename}`;
}

// ─── Agreements list/detail ───────────────────────────────────────────────

router.get('/agreements', requirePermission('rentals'), async (req, res) => {
  try {
    const { customer_id, branch_id, view } = req.query;
    let sql = `SELECT ra.*, c.first_name || ' ' || c.last_name as customer_name,
      c.address as customer_address, c.city as customer_city, c.state as customer_state, c.zip as customer_zip,
      b.name as branch_name, b.address as branch_address, b.city as branch_city, b.state as branch_state, b.zip as branch_zip,
      e.first_name || ' ' || e.last_name as employee_name,
      q.quote_number as source_quote_number,
      co.payment_method as checkout_payment_method,
      se.total as settlement_total,
      dd.first_name || ' ' || dd.last_name as delivery_driver_name,
      pd.first_name || ' ' || pd.last_name as pickup_driver_name,
      op.first_name || ' ' || op.last_name as operator_name,
      ise.first_name || ' ' || ise.last_name as issue_security_employee_name,
      rse.first_name || ' ' || rse.last_name as return_security_employee_name,
      rde.first_name || ' ' || rde.last_name as return_driver_employee_name,
      (SELECT COUNT(*) FROM rental_agreement_items WHERE agreement_id = ra.id AND parent_item_id IS NULL) as item_count,
      (SELECT GROUP_CONCAT(product_name || ' x' || quantity, ', ') FROM rental_agreement_items WHERE agreement_id = ra.id AND parent_item_id IS NULL) as item_summary,
      (SELECT started_at FROM rental_agreement_pauses WHERE agreement_id = ra.id AND ended_at IS NULL LIMIT 1) as current_pause_started_at,
      CASE WHEN ra.status = 'active' AND ra.is_paused = 1 THEN 'paused' WHEN ra.status = 'active' AND ra.due_date < date('now') THEN 'overdue' ELSE ra.status END as display_status,
      (ra.damage_fee_total + ra.duration_adjustment_total - ra.deposit_total + ra.tax_adjustment_total) as balance_due
      FROM rental_agreements ra
      LEFT JOIN customers c ON ra.customer_id = c.id
      LEFT JOIN branches b ON ra.branch_id = b.id
      LEFT JOIN employees e ON ra.employee_id = e.id
      LEFT JOIN quotations q ON q.converted_to_agreement_id = ra.id
      LEFT JOIN transactions co ON ra.checkout_transaction_id = co.id
      LEFT JOIN transactions se ON ra.settlement_transaction_id = se.id
      LEFT JOIN employees dd ON ra.delivery_driver_id = dd.id
      LEFT JOIN employees pd ON ra.pickup_driver_id = pd.id
      LEFT JOIN employees op ON ra.operator_id = op.id
      LEFT JOIN employees ise ON ra.issue_security_employee_id = ise.id
      LEFT JOIN employees rse ON ra.return_security_employee_id = rse.id
      LEFT JOIN employees rde ON ra.return_driver_employee_id = rde.id
      WHERE 1=1`;
    const params = [];
    if (customer_id) { sql += ' AND ra.customer_id = ?'; params.push(customer_id); }
    if (branch_id) { sql += ' AND ra.branch_id = ?'; params.push(branch_id); }
    if (view === 'overdue') { sql += " AND ra.status = 'active' AND ra.due_date < date('now')"; }
    else if (view === 'active') { sql += " AND ra.status = 'active'"; }
    // Physically returned (item's back in stock) but the balance owed on a
    // non-credit checkout hasn't been collected yet — see needsCashierHold
    // in the /return handler. settlement_transaction_id stays NULL until a
    // cashier collects it via /collect-balance, same pending-until-paid shape
    // Work Orders use for 'awaiting_pickup'.
    else if (view === 'awaiting_payment') { sql += ' AND ra.status = ? AND ra.settlement_transaction_id IS NULL AND (ra.damage_fee_total + ra.duration_adjustment_total - ra.deposit_total + ra.tax_adjustment_total) > 0'; params.push('returned'); }
    else if (view === 'returned' || view === 'cancelled' || view === 'pending' || view === 'awaiting_issue') { sql += ' AND ra.status = ?'; params.push(view); }
    sql += ' ORDER BY ra.created_at DESC LIMIT 200';
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Dispatch's "about to miss a pickup" queue — every active, pickup-required,
// not-yet-paused agreement whose due date/time (see lib/rentals.js's
// dueDateTime — the due_date column combined with the checkout time-of-day)
// falls within the next 24 hours, bucketed into due_24h / due_8h / overdue
// so the UI can highlight the urgent ones. This is a live view, not a stored
// notification — nothing here is persisted, it's recomputed on every load.
// An 'overdue' entry should only be momentarily visible: server.js's
// missed-pickup check auto-pauses it shortly after, which drops it out of
// this list (is_paused=1) and into the pause-history/contact workflow below.
router.get('/agreements/pickup-reminders', requirePermission('rentals'), async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: `SELECT ra.*, c.first_name || ' ' || c.last_name as customer_name,
      c.phone as customer_phone, c.email as customer_email,
      b.name as branch_name,
      (SELECT GROUP_CONCAT(product_name || ' x' || quantity, ', ') FROM rental_agreement_items WHERE agreement_id = ra.id AND parent_item_id IS NULL) as item_summary
      FROM rental_agreements ra
      LEFT JOIN customers c ON ra.customer_id = c.id
      LEFT JOIN branches b ON ra.branch_id = b.id
      WHERE ra.status = 'active' AND ra.pickup_required = 1 AND ra.is_paused = 0`, args: [] });
    const now = Date.now();
    const HOUR = 3600000;
    const reminders = rows.map(a => {
      const due = dueDateTime(a);
      if (!due) return null;
      const msUntilDue = due.getTime() - now;
      let bucket;
      if (msUntilDue <= 0) bucket = 'overdue';
      else if (msUntilDue <= 8 * HOUR) bucket = 'due_8h';
      else if (msUntilDue <= 24 * HOUR) bucket = 'due_24h';
      else return null;
      return { ...a, due_datetime: due.toISOString(), hours_remaining: parseFloat((msUntilDue / HOUR).toFixed(1)), bucket };
    }).filter(Boolean).sort((x, y) => new Date(x.due_datetime) - new Date(y.due_datetime));
    res.json(reminders);
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
      ise.first_name || ' ' || ise.last_name as issue_security_employee_name,
      rse.first_name || ' ' || rse.last_name as return_security_employee_name,
      rde.first_name || ' ' || rde.last_name as return_driver_employee_name,
      CASE WHEN ra.status = 'active' AND ra.is_paused = 1 THEN 'paused' WHEN ra.status = 'active' AND ra.due_date < date('now') THEN 'overdue' ELSE ra.status END as display_status,
      (ra.damage_fee_total + ra.duration_adjustment_total - ra.deposit_total + ra.tax_adjustment_total) as balance_due
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
      LEFT JOIN employees ise ON ra.issue_security_employee_id = ise.id
      LEFT JOIN employees rse ON ra.return_security_employee_id = rse.id
      LEFT JOIN employees rde ON ra.return_driver_employee_id = rde.id
      WHERE ra.id = ?`, args: [req.params.id] });
    if (!agreement) return res.status(404).json({ error: 'Not found' });
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [req.params.id] });
    agreement.items = items;
    // A 'pending' agreement (held, not yet paid) hasn't been charged yet —
    // the real rental_fee/deposit_amount on each item are still 0 (see
    // insertPendingAgreement) because they're only computed for real at
    // PATCH .../checkout, based on the actual checkout instant. Mirror that
    // same math here (checkout instant = now) purely for display, so the
    // Process Payment modal can show an estimated total — this is NOT
    // persisted and will be recomputed for real when checkout completes.
    if (agreement.status === 'pending' && items.length) {
      const estCheckoutDateTime = new Date();
      const estDueDateTime = new Date(`${agreement.due_date}T${estCheckoutDateTime.toISOString().slice(11, 19)}.000Z`);
      let estRentalSubtotal = 0, estTax = 0, estDepositTotal = 0;
      for (const item of items) {
        const estFee = item.is_mandatory ? 0 : feeFor({
          rental_classification: item.rental_classification,
          rental_rate: item.daily_rate,
          rental_weekly_rate: item.weekly_rate,
          rental_monthly_rate: item.monthly_rate,
          rental_hourly_rate: item.hourly_rate,
        }, item.quantity, estCheckoutDateTime, estDueDateTime);
        item.estimated_rental_fee = estFee;
        item.estimated_deposit_amount = estFee;
        estRentalSubtotal += estFee;
        estTax += parseFloat((estFee * (item.tax_rate || 0) / 100).toFixed(2));
        estDepositTotal += estFee;
      }
      const deliveryCost = agreement.delivery_required ? parseFloat(agreement.delivery_cost || 0) : 0;
      const pickupCost = agreement.pickup_required ? parseFloat(agreement.pickup_cost || 0) : 0;
      const operatorFee = agreement.operator_required ? parseFloat(agreement.operator_fee || 0) : 0;
      agreement.estimated_rental_subtotal = parseFloat(estRentalSubtotal.toFixed(2));
      agreement.estimated_tax = parseFloat(estTax.toFixed(2));
      agreement.estimated_deposit_total = parseFloat(estDepositTotal.toFixed(2));
      agreement.estimated_total = parseFloat((estRentalSubtotal + estTax + estDepositTotal + deliveryCost + pickupCost + operatorFee).toFixed(2));
    }
    const { rows: pauses } = await db.execute({ sql: `SELECT rp.*, pb.first_name || ' ' || pb.last_name as paused_by_name, ab.first_name || ' ' || ab.last_name as authorized_by_name, rb.first_name || ' ' || rb.last_name as resumed_by_name, cb.first_name || ' ' || cb.last_name as confirmed_by_name
      FROM rental_agreement_pauses rp
      LEFT JOIN employees pb ON rp.paused_by = pb.id
      LEFT JOIN employees ab ON rp.authorized_by = ab.id
      LEFT JOIN employees rb ON rp.resumed_by = rb.id
      LEFT JOIN employees cb ON rp.confirmed_by = cb.id
      WHERE rp.agreement_id = ? ORDER BY rp.id`, args: [req.params.id] });
    agreement.pauses = pauses;
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
      operator_required, operator_fee, customer_pickup,
    } = req.body;
    if (!customer_id) return res.status(400).json({ error: 'A customer is required for rental checkout' });
    if (!branch_id) return res.status(400).json({ error: 'A branch/location is required for rental checkout' });
    if (!due_date) return res.status(400).json({ error: 'Due date is required' });
    if (!items || !items.length) return res.status(400).json({ error: 'At least one rental item is required' });

    // Only gates the creation of NEW agreements — existing ones are untouched.
    try {
      const { rows: [customer] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [customer_id] });
      assertRentalCustomerEligible(customer);
    } catch(e) { return res.status(400).json({ error: e.message }); }

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
        customer_pickup: customer_pickup ? 1 : 0,
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
    const { payment_method, amount_tendered, drawer_session_id, employee_id, customer_po_number } = req.body;
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
      // A credit rental charges straight to the customer's account with no
      // cash/card in hand — the PO is what ties that charge back to the
      // customer's own paperwork, so it's required before the charge posts.
      if (!customer_po_number || !customer_po_number.trim()) return res.status(400).json({ error: 'A customer PO number is required for credit account rentals' });
      if (!agreement.customer_po_attachment_path) return res.status(400).json({ error: 'The customer PO document must be attached before completing this checkout' });
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
      await tx.execute({ sql: `UPDATE rental_agreements SET checkout_transaction_id = ?, deposit_total = ?, status = 'awaiting_issue', employee_id = ?, customer_po_number = ? WHERE id = ?`, args: [checkoutTxId, depositTotal, finalizeEmployeeId || null, isCredit ? customer_po_number.trim() : null, req.params.id] });
      await tx.commit();
      committed = true;
      if (isCredit) { try { await runCreditCheck(agreement.customer_id); } catch(e) {} }
      try {
        await logActivity({
          customerId: agreement.customer_id, employeeId: finalizeEmployeeId,
          type: 'rental', subject: `Rental ${agreement.agreement_number} checked out — due ${agreement.due_date}`,
          completed: true,
        });
      } catch(e) {}

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

// ─── Customer PO attachment (required before finalizing a credit rental) ──

// Uploadable while the agreement is still 'pending' (it already has a real
// id from the hold step) — decoupled from checkout finalize so the file
// picker can upload immediately rather than being bundled into the JSON
// checkout payload. Same cloudUpload-or-local-disk-fallback pattern as
// routes/purchase-orders.js's PO attachments, but a single slot on the
// agreement itself (not a join table) — a rental only ever has one customer PO.
router.post('/agreements/:id/po-attachment', requireAnyPermission('rentals_checkout', 'pos'), uploadPoAttachment.single('file'), async (req, res) => {
  try {
    const { rows: [agreement] } = await db.execute({ sql: 'SELECT id FROM rental_agreements WHERE id = ?', args: [req.params.id] });
    if (!agreement) return res.status(404).json({ error: 'Not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded or file type not allowed' });

    const cloudResult = await cloudUpload(req.file.buffer, {
      folder: 'pos-system/rental-po-attachments',
      public_id: `rental-${req.params.id}-po-${Date.now()}`,
      resource_type: 'auto',
    });

    let storedName;
    if (cloudResult) {
      storedName = cloudResult.secure_url;
    } else {
      fs.mkdirSync(localPoAttachmentDir, { recursive: true });
      storedName = `rental-${req.params.id}-po-${Date.now()}${path.extname(req.file.originalname)}`;
      fs.writeFileSync(path.join(localPoAttachmentDir, storedName), req.file.buffer);
    }

    await db.execute({ sql: 'UPDATE rental_agreements SET customer_po_attachment_path = ?, customer_po_attachment_name = ? WHERE id = ?', args: [storedName, req.file.originalname, req.params.id] });
    res.status(201).json({ customer_po_attachment_path: storedName, customer_po_attachment_name: req.file.originalname });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/agreements/:id/po-attachment/download', async (req, res) => {
  try {
    const { rows: [agreement] } = await db.execute({ sql: 'SELECT customer_po_attachment_path, customer_po_attachment_name FROM rental_agreements WHERE id = ?', args: [req.params.id] });
    if (!agreement || !agreement.customer_po_attachment_path) return res.status(404).json({ error: 'Not found' });
    if (agreement.customer_po_attachment_path.startsWith('https://')) {
      const downloadUrl = agreement.customer_po_attachment_path.replace('/upload/', '/upload/fl_attachment/');
      return res.redirect(downloadUrl);
    }
    const filePath = path.join(localPoAttachmentDir, agreement.customer_po_attachment_path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on server' });
    res.setHeader('Content-Disposition', `attachment; filename="${agreement.customer_po_attachment_name || 'purchase-order'}"`);
    res.sendFile(filePath);
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
    const { employee_id, delivery_driver_id, operator_id, issued_at, security_employee_id, customer_signature, security_signature } = req.body;
    const { rows: [agreement] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [req.params.id] });
    if (!agreement) return res.status(404).json({ error: 'Not found' });
    if (agreement.status !== 'awaiting_issue') return res.status(400).json({ error: `This agreement is ${agreement.status}, not awaiting issue` });

    // Chain-of-custody checkpoints — required, not optional, so an item
    // can't leave the premises without a security guard verifying (and
    // signing for) it and the customer signing for it. See database.js's
    // migration comment for why these live as their own columns rather
    // than reusing employee_id.
    if (!security_employee_id) return res.status(400).json({ error: 'Select the security employee who verified this item leaving' });
    if (!security_signature) return res.status(400).json({ error: "The security employee's signature is required to issue this rental" });
    if (!customer_signature) return res.status(400).json({ error: 'Customer signature is required to issue this rental' });

    // Defaults to the moment this request is processed, but staff can back-date
    // it to when the item actually went out (e.g. it sat ready at the counter
    // for a while first) — same pattern as the return endpoint's returned_at,
    // since this is what the rental clock and all fee calculations run from.
    let issuedAt = new Date();
    if (issued_at) {
      const parsed = new Date(issued_at);
      if (isNaN(parsed.getTime())) return res.status(400).json({ error: 'Invalid start date/time' });
      if (parsed.getTime() > Date.now() + 5 * 60000) return res.status(400).json({ error: 'Start date/time cannot be in the future' });
      issuedAt = parsed;
    }
    const today = issuedAt.toISOString().slice(0, 10);

    const customerSigPath = await uploadSignature(customer_signature, `rental-${req.params.id}-issue-customer`);
    if (!customerSigPath) return res.status(400).json({ error: 'Invalid customer signature image' });
    const guardSigPath = await uploadSignature(security_signature, `rental-${req.params.id}-issue-guard`);
    if (!guardSigPath) return res.status(400).json({ error: 'Invalid security signature image' });

    await db.execute({
      sql: `UPDATE rental_agreements SET
        status = 'active',
        checkout_date = ?, checkout_datetime = ?,
        issued_at = ?, issued_by = ?,
        delivery_driver_id = ?, operator_id = ?,
        issue_security_employee_id = ?, issue_security_confirmed_at = ?, issue_customer_signature = ?, issue_security_signature = ?
        WHERE id = ?`,
      args: [
        today, issuedAt.toISOString(),
        issuedAt.toISOString(), employee_id || agreement.employee_id || null,
        agreement.delivery_required ? (delivery_driver_id || null) : null,
        agreement.operator_required ? (operator_id || null) : null,
        security_employee_id, issuedAt.toISOString(), customerSigPath, guardSigPath,
        req.params.id,
      ],
    });

    const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [req.params.id] });
    const { rows: agItems } = await db.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [req.params.id] });
    updated.items = agItems;
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Pause / Resume (Maintenance, replacement, or other downtime) ─────────

// Same PIN-authorization lookup POST /employees/validate-pin uses (matches
// the frontend's "Void Line" override UX) — duplicated narrowly here rather
// than calling that route, since routes in this app call each other via
// exported functions, not internal HTTP, and no shared helper exists yet.
async function validateOverridePin(pin, permission) {
  const { rows: employees } = await db.execute({ sql: 'SELECT e.id, e.first_name, e.last_name, e.pin, sg.permissions FROM employees e LEFT JOIN security_groups sg ON e.security_group_id = sg.id WHERE e.active = 1', args: [] });
  // Uses the same bidirectional can() the rest of the app's permission checks
  // use (see lib/permissions.js) — a group with just the parent `rentals`
  // flag set (e.g. the seeded Administrator group, which predates this
  // sub-key) still authorizes, rather than requiring every group to be
  // re-saved before the override works at all.
  return employees.find(e => {
    if (e.pin !== String(pin)) return false;
    try { return can(JSON.parse(e.permissions || '{}'), permission); } catch { return false; }
  }) || null;
}

// Pausing is the exceptional, billing-affecting action — it requires a
// manager PIN on the spot (checked against rentals_pause), same UX pattern
// as voiding a cart line. The button to open this is visible to anyone who
// can see the agreement; the PIN is what actually gates it, not a separate
// permission on visibility.
router.post('/agreements/:id/pause', requirePermission('rentals'), async (req, res) => {
  try {
    const { reason, notes, override_pin, employee_id } = req.body;
    if (!['maintenance', 'replacement', 'other'].includes(reason)) return res.status(400).json({ error: 'A valid reason (maintenance, replacement, or other) is required' });
    if (!notes || !notes.trim()) return res.status(400).json({ error: 'Notes are required to pause a rental' });
    if (!override_pin) return res.status(400).json({ error: 'Manager override PIN is required' });

    const { rows: [agreement] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [req.params.id] });
    if (!agreement) return res.status(404).json({ error: 'Not found' });
    if (agreement.status !== 'active') return res.status(400).json({ error: `Cannot pause a ${agreement.status} agreement — only active (issued) rentals can be paused` });
    if (agreement.is_paused) return res.status(400).json({ error: 'This rental is already paused' });

    const authorizer = await validateOverridePin(override_pin, 'rentals_pause');
    if (!authorizer) return res.status(403).json({ error: 'Invalid PIN or insufficient privilege' });

    const tx = await db.transaction('write');
    let committed = false;
    try {
      await tx.execute({ sql: 'INSERT INTO rental_agreement_pauses (agreement_id, reason, notes, paused_by, authorized_by) VALUES (?,?,?,?,?)', args: [req.params.id, reason, notes.trim(), employee_id || null, authorizer.id] });
      await tx.execute({ sql: 'UPDATE rental_agreements SET is_paused = 1 WHERE id = ?', args: [req.params.id] });
      await tx.commit();
      committed = true;
      try {
        await logActivity({
          customerId: agreement.customer_id, employeeId: employee_id,
          type: 'rental', subject: `Rental ${agreement.agreement_number} paused — ${reason}`,
          description: notes.trim(), completed: true,
        });
      } catch(e) {}
      const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [req.params.id] });
      res.json(updated);
    } catch(e) {
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Resuming just closes out the downtime and pushes the due date out by
// however long it lasted — not the exceptional action pausing was, so no
// PIN here. Rounds the extension UP to a whole day, in the customer's favor.
router.patch('/agreements/:id/resume', requirePermission('rentals'), async (req, res) => {
  try {
    const { employee_id } = req.body;
    const { rows: [agreement] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [req.params.id] });
    if (!agreement) return res.status(404).json({ error: 'Not found' });
    if (!agreement.is_paused) return res.status(400).json({ error: 'This rental is not currently paused' });

    const { rows: [openPause] } = await db.execute({ sql: 'SELECT * FROM rental_agreement_pauses WHERE agreement_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1', args: [req.params.id] });
    if (!openPause) return res.status(400).json({ error: 'No open pause found on this agreement' });

    const now = new Date();
    const pausedMs = Math.max(0, now - new Date(openPause.started_at));
    const pausedDays = Math.ceil(pausedMs / 86400000);
    const dueDateBefore = agreement.due_date;
    const dueDateAfter = new Date(new Date(`${dueDateBefore}T00:00:00.000Z`).getTime() + pausedDays * 86400000).toISOString().slice(0, 10);

    const tx = await db.transaction('write');
    let committed = false;
    try {
      await tx.execute({ sql: 'UPDATE rental_agreement_pauses SET ended_at = ?, resumed_by = ?, due_date_before = ?, due_date_after = ? WHERE id = ?', args: [now.toISOString(), employee_id || null, dueDateBefore, dueDateAfter, openPause.id] });
      await tx.execute({ sql: 'UPDATE rental_agreements SET is_paused = 0, due_date = ? WHERE id = ?', args: [dueDateAfter, req.params.id] });
      await tx.commit();
      committed = true;
      try {
        await logActivity({
          customerId: agreement.customer_id, employeeId: employee_id,
          type: 'rental', subject: `Rental ${agreement.agreement_number} resumed — due date extended to ${dueDateAfter}`,
          description: `Paused ${pausedDays} day${pausedDays === 1 ? '' : 's'} for ${openPause.reason}`, completed: true,
        });
      } catch(e) {}
      const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [req.params.id] });
      res.json(updated);
    } catch(e) {
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Missed pickup: contact + customer decision ─────────────────────────────
// Both routes below operate on the currently-open pause row with
// reason='missed_pickup' — created by checkMissedPickups() (exported at the
// bottom of this file, called on a timer from server.js) when a
// pickup-required agreement's due date/time passes with the item still out.

async function findOpenMissedPickupPause(agreementId) {
  const { rows: [pause] } = await db.execute({ sql: "SELECT * FROM rental_agreement_pauses WHERE agreement_id = ? AND ended_at IS NULL AND reason = 'missed_pickup' ORDER BY id DESC LIMIT 1", args: [agreementId] });
  return pause;
}

// Logs an outreach attempt (call or email) against the open missed-pickup
// pause — actually sending the email itself is routes/email.js's job
// (POST /email/send-missed-pickup-contact/:id); this just records that it
// happened, same split as the rest of the app's email-vs-state separation.
router.patch('/agreements/:id/missed-pickup-contact', requirePermission('rentals'), async (req, res) => {
  try {
    const { contact_method, notes, employee_id } = req.body;
    if (!['email', 'phone'].includes(contact_method)) return res.status(400).json({ error: 'contact_method must be "email" or "phone"' });
    const pause = await findOpenMissedPickupPause(req.params.id);
    if (!pause) return res.status(400).json({ error: 'No open missed-pickup pause found on this agreement' });
    const stamp = `[${new Date().toLocaleString()}${employee_id ? ` — emp #${employee_id}` : ''}, ${contact_method}] ${(notes || '').trim() || '(no notes)'}`;
    const combinedNotes = pause.contact_notes ? `${pause.contact_notes}\n${stamp}` : stamp;
    await db.execute({ sql: 'UPDATE rental_agreement_pauses SET contact_method = ?, contact_notes = ? WHERE id = ?', args: [contact_method, combinedNotes, pause.id] });
    const { rows: [agreement] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [req.params.id] });
    try {
      await logActivity({
        customerId: agreement.customer_id, employeeId: employee_id,
        type: 'rental', subject: `Rental ${agreement.agreement_number} — missed-pickup contact attempt (${contact_method})`,
        description: notes || null, completed: true,
      });
    } catch(e) {}
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Records what the customer decided once staff reached them — 'continue'
// (resumes with a new due date staff picked while on the call/email, not the
// usual paused-days auto-extension) or 'stop' (resumes with no extension,
// just unblocking Process Return — see database.js's migration comment: no
// automatic financial changes happen unattended, a human still has to
// actually process the return once the item comes back). Either way this is
// staff attesting to the customer's decision, not the customer's own
// verifiable action — there's no reply-parsing or click-to-confirm link
// infrastructure in this app.
router.patch('/agreements/:id/missed-pickup-confirm', requirePermission('rentals'), async (req, res) => {
  try {
    const { decision, new_due_date, notes, employee_id } = req.body;
    if (!['continue', 'stop'].includes(decision)) return res.status(400).json({ error: 'decision must be "continue" or "stop"' });
    const pause = await findOpenMissedPickupPause(req.params.id);
    if (!pause) return res.status(400).json({ error: 'No open missed-pickup pause found on this agreement' });
    const { rows: [agreement] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [req.params.id] });
    if (!agreement) return res.status(404).json({ error: 'Not found' });

    let newDueDate = agreement.due_date;
    if (decision === 'continue') {
      if (!new_due_date) return res.status(400).json({ error: 'A new pickup date is required to continue the rental' });
      if (new_due_date < new Date().toISOString().slice(0, 10)) return res.status(400).json({ error: 'The new pickup date cannot be in the past' });
      newDueDate = new_due_date;
    }

    const now = new Date().toISOString();
    const stamp = notes && notes.trim() ? `[${new Date().toLocaleString()}] Customer confirmed: ${decision}${decision === 'continue' ? ` (new pickup date ${newDueDate})` : ''} — ${notes.trim()}` : `[${new Date().toLocaleString()}] Customer confirmed: ${decision}${decision === 'continue' ? ` (new pickup date ${newDueDate})` : ''}`;
    const combinedNotes = pause.contact_notes ? `${pause.contact_notes}\n${stamp}` : stamp;

    const tx = await db.transaction('write');
    let committed = false;
    try {
      await tx.execute({
        sql: 'UPDATE rental_agreement_pauses SET ended_at = ?, resumed_by = ?, due_date_before = ?, due_date_after = ?, customer_confirmation = ?, confirmed_by = ?, confirmed_at = ?, contact_notes = ? WHERE id = ?',
        args: [now, employee_id || null, agreement.due_date, newDueDate, decision, employee_id || null, now, combinedNotes, pause.id],
      });
      await tx.execute({ sql: 'UPDATE rental_agreements SET is_paused = 0, due_date = ? WHERE id = ?', args: [newDueDate, req.params.id] });
      await tx.commit();
      committed = true;
      try {
        await logActivity({
          customerId: agreement.customer_id, employeeId: employee_id,
          type: 'rental', subject: `Rental ${agreement.agreement_number} — customer confirmed ${decision === 'continue' ? `continuation, new pickup date ${newDueDate}` : 'stop'}`,
          description: notes || null, completed: true,
        });
      } catch(e) {}
      const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [req.params.id] });
      res.json(updated);
    } catch(e) {
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
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
        // A credit customer paying off the invoice early (before return) can
        // fire calcRentalCommission's Trigger B in routes/accounts.js — if
        // this rental is then cancelled, that commission shouldn't stand,
        // same reasoning as routes/transactions.js's void-cleanup.
        await tx.execute({ sql: "DELETE FROM commission_records WHERE source_type='rental' AND source_id=? AND status != 'paid'", args: [agreement.checkout_transaction_id] });
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
      try {
        await logActivity({
          customerId: agreement.customer_id, employeeId: employee_id || agreement.employee_id,
          type: 'rental', subject: `Rental ${agreement.agreement_number} cancelled`,
          completed: true,
        });
      } catch(e) {}
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
    const { items, duration_adjustment_override, payment_method, drawer_session_id, pickup_driver_id, returned_at, return_security_employee_id, return_driver_employee_id, security_signature, driver_signature } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'At least one item is required' });

    const { rows: [agreement] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [req.params.id] });
    if (!agreement) return res.status(404).json({ error: 'Not found' });
    if (agreement.status !== 'active') return res.status(400).json({ error: `Cannot return items on a ${agreement.status} agreement` });
    if (agreement.is_paused) return res.status(400).json({ error: 'This rental is currently paused — resume it before processing a return' });

    // The security guard's sign-in is a chain-of-custody check applied to
    // every return, regardless of pickup. The driver select/signature, on
    // the other hand, only makes sense when a driver was actually involved
    // — i.e. the rental paid for pickup service — so it's skipped entirely
    // otherwise (see database.js's migration comment).
    if (!return_security_employee_id) return res.status(400).json({ error: 'Select the security employee signing this item back in' });
    if (!security_signature) return res.status(400).json({ error: "The security employee's signature is required to complete this return" });
    if (agreement.pickup_required) {
      if (!return_driver_employee_id) return res.status(400).json({ error: 'Select the driver confirming pickup' });
      if (!driver_signature) return res.status(400).json({ error: "The driver's signature is required to complete this pickup return" });
    }

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

    // Uploaded before the write transaction opens — this can be a real
    // network call (Cloudinary), so it shouldn't hold a DB transaction open.
    const guardSigPath = await uploadSignature(security_signature, `rental-${req.params.id}-return-guard`);
    if (!guardSigPath) return res.status(400).json({ error: 'Invalid security signature image' });
    let driverSigPath = null;
    if (agreement.pickup_required) {
      driverSigPath = await uploadSignature(driver_signature, `rental-${req.params.id}-return-driver`);
      if (!driverSigPath) return res.status(400).json({ error: 'Invalid driver signature image' });
    }

    // Time the item spent paused (maintenance/replacement/other) shouldn't be
    // billed — the customer didn't have functional use of it. Only closed
    // pause windows count (an open one would have blocked this return above).
    // Subtracted from the fee-calculation window only; the real `now` is
    // still used everywhere else (return timestamp, damage fee, etc.).
    const { rows: closedPauses } = await db.execute({ sql: 'SELECT started_at, ended_at FROM rental_agreement_pauses WHERE agreement_id = ? AND ended_at IS NOT NULL', args: [req.params.id] });
    const totalPausedMs = closedPauses.reduce((sum, p) => sum + Math.max(0, new Date(p.ended_at) - new Date(p.started_at)), 0);
    const effectiveNow = new Date(Math.max(new Date(checkoutDateTime).getTime(), now.getTime() - totalPausedMs));

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
        // time (checkout -> this moment, minus any paused time) — this
        // replaces the old flat late fee.
        let actualFeePerUnit = 0;
        if (!item.is_mandatory) {
          actualFeePerUnit = feeFor({
            rental_classification: item.rental_classification,
            rental_rate: item.daily_rate,
            rental_weekly_rate: item.weekly_rate,
            rental_monthly_rate: item.monthly_rate,
            rental_hourly_rate: item.hourly_rate,
          }, 1, checkoutDateTime, effectiveNow);
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
      // Same driver as pickupDriverId in practice (the return modal now
      // collects one driver, used for both) — kept as its own column since
      // it's the chain-of-custody confirmation, distinct in meaning from the
      // dispatch-board assignment pickupDriverId represents.
      const returnDriverId = agreement.pickup_required ? (return_driver_employee_id || null) : null;
      const returnDriverConfirmedAt = agreement.pickup_required ? now.toISOString() : null;

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

      // The item itself comes back into stock the moment security signs it
      // in, regardless of money owed — but a cash/card balance owed on a
      // non-credit rental hasn't actually been collected yet at the point
      // security is processing the physical return (they're not a cashier
      // and typically have no open drawer). Rather than silently recording
      // it as paid, this leaves the settlement transaction uncreated here —
      // the agreement sits fully "returned" with settlement_transaction_id
      // still NULL, which is exactly what /agreements/:id/collect-balance's
      // awaiting-payment query below looks for — and hands it to a cashier
      // via POS Hold Recall, same pattern as Work Orders' awaiting_pickup.
      // A refund-due or credit-financed settlement still finalizes here:
      // there's no cash to collect from the customer in either case.
      const needsCashierHold = !checkoutIsCredit && settlementAmount > 0;
      let settlementTxId = null;

      if (!needsCashierHold) {
        const transaction_number = await nextNumber(tx, 'transactions', 'transaction_number', 'TXN-', 6);
        const method = checkoutIsCredit ? 'credit' : (settlementAmount >= 0 ? (payment_method || 'cash') : 'refund');
        const settleResult = await tx.execute({ sql: `INSERT INTO transactions (transaction_number,customer_id,employee_id,branch_id,drawer_session_id,subtotal,tax_amount,total,payment_method,amount_tendered,change_amount,notes,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [transaction_number, agreement.customer_id, agreement.employee_id, agreement.branch_id, drawer_session_id || null, settlementSubtotal, taxAdjustmentTotal, settlementAmount, method, 0, 0, `Rental settlement ${agreement.agreement_number}`, 'pos'] });
        settlementTxId = Number(settleResult.lastInsertRowid);

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
      }

      await tx.execute({ sql: `UPDATE rental_agreements SET settlement_transaction_id = ?, deposit_refunded = ?, duration_adjustment_total = duration_adjustment_total + ?, tax_adjustment_total = tax_adjustment_total + ?, damage_fee_total = damage_fee_total + ?, pickup_driver_id = ?, status = ?, returned_at = ?, return_security_employee_id = ?, return_security_confirmed_at = ?, return_security_signature = ?, return_driver_employee_id = ?, return_driver_confirmed_at = ?, return_driver_signature = ? WHERE id = ?`, args: [settlementTxId, depositRefunded, durationAdjustmentTotal, taxAdjustmentTotal, damageFeeTotal, pickupDriverId, newStatus, allReturned ? now.toISOString() : agreement.returned_at, return_security_employee_id, now.toISOString(), guardSigPath, returnDriverId, returnDriverConfirmedAt, driverSigPath, req.params.id] });
      await tx.commit();
      if (checkoutIsCredit) { try { await runCreditCheck(agreement.customer_id); } catch(e) {} }
    } catch(e) {
      await tx.rollback();
      return res.status(400).json({ error: e.message });
    }

    const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [req.params.id] });
    const { rows: updatedItems } = await db.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [req.params.id] });
    updated.items = updatedItems;

    // Only fires once the agreement is fully closed (every item returned) —
    // a partial return correctly leaves this alone. Credit-financed rentals
    // are deliberately excluded here: their commission trigger is the
    // customer actually paying off the invoice (routes/accounts.js), not
    // the return itself — see calcRentalCommission's callers for why.
    if (updated.status === 'returned') {
      try {
        await logActivity({
          customerId: updated.customer_id, employeeId: updated.employee_id,
          type: 'rental', subject: `Rental ${updated.agreement_number} returned`,
          completed: true,
        });
      } catch(e) {}
      if (!checkoutIsCredit && updated.checkout_transaction_id) {
        try {
          const { rows: [checkoutTx] } = await db.execute({ sql: 'SELECT * FROM transactions WHERE id = ?', args: [updated.checkout_transaction_id] });
          if (checkoutTx) await calcRentalCommission(updated, checkoutTx);
        } catch(e) {}
      }
    }

    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// A rental returned with a balance owed (see needsCashierHold above) lands
// here with settlement_transaction_id still NULL — the item is already back
// in stock, only the money hasn't been collected. This is the cashier-facing
// counterpart, reachable from POS Hold Recall same as a Work Order's
// final-payment: the settlement transaction is created fresh at the moment
// payment is actually taken, using the cashier's own drawer session rather
// than whatever (if anything) security had open at sign-in.
router.patch('/agreements/:id/collect-balance', requireAnyPermission('pos', 'rentals'), async (req, res) => {
  try {
    const { payment_method, amount_tendered, employee_id, drawer_session_id, branch_id } = req.body;
    const { rows: [agreement] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [req.params.id] });
    if (!agreement) return res.status(404).json({ error: 'Not found' });
    if (agreement.status !== 'returned') return res.status(400).json({ error: `This rental is ${agreement.status}, not awaiting balance payment` });
    if (agreement.settlement_transaction_id) return res.status(400).json({ error: 'This rental has already been settled' });

    const balance = parseFloat((agreement.damage_fee_total + agreement.duration_adjustment_total - agreement.deposit_total + agreement.tax_adjustment_total).toFixed(2));
    if (balance <= 0) return res.status(400).json({ error: 'No balance is due on this rental' });

    let settlementTxId;
    const tx = await db.transaction('write');
    try {
      const method = payment_method || 'cash';
      const tendered = parseFloat(amount_tendered || balance);
      const changeAmt = Math.max(0, parseFloat((tendered - balance).toFixed(2)));
      const transaction_number = await nextNumber(tx, 'transactions', 'transaction_number', 'TXN-', 6);
      const settleResult = await tx.execute({ sql: `INSERT INTO transactions (transaction_number,customer_id,employee_id,branch_id,drawer_session_id,subtotal,tax_amount,total,payment_method,amount_tendered,change_amount,notes,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [transaction_number, agreement.customer_id, employee_id || agreement.employee_id, branch_id || agreement.branch_id, drawer_session_id || null, parseFloat((balance - agreement.tax_adjustment_total).toFixed(2)), agreement.tax_adjustment_total, balance, method, tendered, changeAmt, `Rental settlement ${agreement.agreement_number}`, 'pos'] });
      settlementTxId = Number(settleResult.lastInsertRowid);

      if (agreement.duration_adjustment_total !== 0) {
        const label = agreement.duration_adjustment_total > 0 ? 'Additional Rental Time' : 'Rental Fee Credit (returned early)';
        await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?)`, args: [settlementTxId, label, 'DURATION-ADJ', 1, agreement.duration_adjustment_total, agreement.tax_adjustment_total, agreement.duration_adjustment_total] });
      }
      const { rows: damagedItems } = await tx.execute({ sql: 'SELECT product_id, product_name, sku, damage_fee FROM rental_agreement_items WHERE agreement_id = ? AND damage_fee > 0', args: [req.params.id] });
      for (const item of damagedItems) {
        await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?,?)`, args: [settlementTxId, item.product_id, `Damage Fee — ${item.product_name}`, item.sku, 1, item.damage_fee, 0, item.damage_fee] });
      }
      if (agreement.deposit_total > 0) {
        await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?)`, args: [settlementTxId, 'Deposit Applied', 'DEPOSIT', 1, -agreement.deposit_total, 0, -agreement.deposit_total] });
      }

      await tx.execute({ sql: 'UPDATE rental_agreements SET settlement_transaction_id = ? WHERE id = ?', args: [settlementTxId, req.params.id] });
      await tx.commit();
    } catch(e) {
      await tx.rollback();
      return res.status(400).json({ error: e.message });
    }

    const { rows: [settled] } = await db.execute({ sql: 'SELECT * FROM transactions WHERE id = ?', args: [settlementTxId] });
    res.json(settled);
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

// Called on a timer from server.js. Finds every active, pickup-required,
// not-already-paused agreement whose due date/time has passed and pauses it
// — reason='missed_pickup', paused_by/authorized_by NULL since this is a
// system action with no human present to enter the usual manager PIN
// (contrast with the human-driven POST /agreements/:id/pause above, which
// requires one). Naturally idempotent: once is_paused flips to 1 the
// WHERE clause excludes it from the next run, so no separate "already
// notified" flag is needed.
async function checkMissedPickups() {
  const { rows: candidates } = await db.execute({ sql: "SELECT * FROM rental_agreements WHERE status = 'active' AND pickup_required = 1 AND is_paused = 0", args: [] });
  for (const agreement of candidates) {
    const due = dueDateTime(agreement);
    if (!due || due.getTime() >= Date.now()) continue;
    try {
      const tx = await db.transaction('write');
      try {
        await tx.execute({
          sql: 'INSERT INTO rental_agreement_pauses (agreement_id, reason, notes, paused_by, authorized_by) VALUES (?,?,?,NULL,NULL)',
          args: [agreement.id, 'missed_pickup', 'Automatically paused — the scheduled pickup was not completed by the due date/time.'],
        });
        await tx.execute({ sql: 'UPDATE rental_agreements SET is_paused = 1 WHERE id = ?', args: [agreement.id] });
        await tx.commit();
      } catch(e) { await tx.rollback(); throw e; }
      try {
        await logActivity({
          customerId: agreement.customer_id, employeeId: agreement.employee_id,
          type: 'rental', subject: `Rental ${agreement.agreement_number} auto-paused — pickup not completed by due date`,
          description: 'Contact the customer to arrange pickup logistics, then record their decision (continue or stop) on the agreement.',
          completed: false,
        });
      } catch(e) {}
    } catch(e) {}
  }
}

module.exports = router;
module.exports.checkMissedPickups = checkMissedPickups;
