const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { syncBinQty } = require('../lib/binSync');
const { requirePermission } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');

async function getSetting(key, fallback) {
  const { rows: [row] } = await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [key] });
  return row?.value ?? fallback;
}

function addInterval(dateStr, frequency) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (frequency === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (frequency === 'biweekly') d.setUTCDate(d.getUTCDate() + 14);
  else d.setUTCMonth(d.getUTCMonth() + 1); // monthly (default)
  return d.toISOString().slice(0, 10);
}

const detailJoin = `SELECT lp.*, c.first_name || ' ' || c.last_name as customer_name, c.phone as customer_phone, c.email as customer_email,
  e.first_name || ' ' || e.last_name as employee_name, ce.first_name || ' ' || ce.last_name as cancelled_by_name,
  b.name as branch_name,
  CASE WHEN lp.status = 'active' AND lp.next_due_date IS NOT NULL AND lp.next_due_date < date('now') THEN 1 ELSE 0 END as is_overdue
  FROM layaway_plans lp
  LEFT JOIN customers c ON lp.customer_id = c.id
  LEFT JOIN employees e ON lp.employee_id = e.id
  LEFT JOIN employees ce ON lp.cancelled_by = ce.id
  LEFT JOIN branches b ON lp.branch_id = b.id`;

async function attachItemsAndPayments(plan) {
  const { rows: items } = await db.execute({ sql: 'SELECT * FROM layaway_plan_items WHERE plan_id = ?', args: [plan.id] });
  plan.items = items;
  const { rows: payments } = await db.execute({ sql: 'SELECT lpay.*, e.first_name || \' \' || e.last_name as employee_name FROM layaway_payments lpay LEFT JOIN employees e ON lpay.employee_id = e.id WHERE lpay.plan_id = ? ORDER BY lpay.created_at ASC', args: [plan.id] });
  plan.payments = payments;
  return plan;
}

// ─── List / detail ──────────────────────────────────────────────────────────

router.get('/plans', requirePermission('layaway'), async (req, res) => {
  try {
    const { view } = req.query;
    let sql = detailJoin + ' WHERE 1=1';
    if (view === 'active') sql += " AND lp.status = 'active' AND (lp.next_due_date IS NULL OR lp.next_due_date >= date('now'))";
    else if (view === 'overdue') sql += " AND lp.status = 'active' AND lp.next_due_date IS NOT NULL AND lp.next_due_date < date('now')";
    else if (view === 'completed') sql += " AND lp.status = 'completed'";
    else if (view === 'cancelled') sql += " AND lp.status = 'cancelled'";
    sql += ' ORDER BY lp.created_at DESC';
    const { rows } = await db.execute({ sql, args: [] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/plans/:id', requirePermission('layaway'), async (req, res) => {
  try {
    const { rows: [plan] } = await db.execute({ sql: detailJoin + ' WHERE lp.id = ?', args: [req.params.id] });
    if (!plan) return res.status(404).json({ error: 'Not found' });
    await attachItemsAndPayments(plan);
    res.json(plan);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Create plan + take deposit ─────────────────────────────────────────────

router.post('/plans', requirePermission('layaway_create'), async (req, res) => {
  try {
    const { customer_id, branch_id, employee_id, items, payment_method, amount_tendered, drawer_session_id, payment_frequency, notes } = req.body;
    if (!customer_id) return res.status(400).json({ error: 'A customer is required' });
    if (!branch_id) return res.status(400).json({ error: 'A branch/location is required' });
    if (!items || !items.length) return res.status(400).json({ error: 'At least one item is required' });
    const frequency = ['weekly', 'biweekly', 'monthly'].includes(payment_frequency) ? payment_frequency : 'monthly';

    const lines = [];
    let subtotal = 0, taxAmount = 0;
    for (const item of items) {
      const qty = parseInt(item.quantity) || 0;
      if (qty <= 0) return res.status(400).json({ error: 'Item quantity must be positive' });
      const { rows: [product] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] });
      if (!product) return res.status(400).json({ error: `Product ${item.product_id} not found` });
      if (!product.is_layaway_eligible) return res.status(400).json({ error: `${product.name} is not eligible for layaway` });
      const { rows: [bi] } = await db.execute({ sql: 'SELECT stock_qty FROM branch_inventory WHERE product_id = ? AND branch_id = ?', args: [product.id, branch_id] });
      const availableQty = bi ? bi.stock_qty : product.stock_qty;
      if (availableQty < qty) return res.status(400).json({ error: `Not enough stock for ${product.name} — ${availableQty} available` });
      const lineTotal = parseFloat((product.price * qty).toFixed(2));
      const lineTax = parseFloat((lineTotal * (product.tax_rate || 0) / 100).toFixed(2));
      subtotal += lineTotal;
      taxAmount += lineTax;
      lines.push({ product, quantity: qty, unit_price: product.price, tax_rate: product.tax_rate || 0, lineTotal });
    }
    subtotal = parseFloat(subtotal.toFixed(2));
    taxAmount = parseFloat(taxAmount.toFixed(2));
    const total = parseFloat((subtotal + taxAmount).toFixed(2));

    const depositPercent = parseFloat(await getSetting('layaway_deposit_percent', 20)) || 0;
    const depositRequired = parseFloat((total * depositPercent / 100).toFixed(2));
    const tendered = parseFloat(amount_tendered || depositRequired);
    if (tendered < depositRequired) return res.status(400).json({ error: `A minimum deposit of ${depositRequired.toFixed(2)} (${depositPercent}%) is required` });

    const plan_number = await nextNumber(db, 'layaway_plans', 'plan_number', 'LAY-', 6);
    const transaction_number = await nextNumber(db, 'transactions', 'transaction_number', 'TXN-', 6);
    const payment_number = await nextNumber(db, 'layaway_payments', 'payment_number', 'LWP-', 6);
    const today = new Date().toISOString().slice(0, 10);
    const nextDue = addInterval(today, frequency);

    const tx = await db.transaction('write');
    let committed = false;
    try {
      const txResult = await tx.execute({ sql: `INSERT INTO transactions (transaction_number,customer_id,employee_id,branch_id,drawer_session_id,subtotal,tax_amount,total,payment_method,amount_tendered,change_amount,notes,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [transaction_number, customer_id, employee_id || null, branch_id, drawer_session_id || null, tendered, 0, tendered, payment_method || 'cash', tendered, 0, `Layaway deposit ${plan_number}`, 'pos'] });
      const depositTxId = Number(txResult.lastInsertRowid);
      await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?,?)`, args: [depositTxId, null, `Layaway Deposit — ${lines.length} item(s)`, 'LAYAWAY-DEPOSIT', 1, tendered, 0, tendered] });

      const planResult = await tx.execute({ sql: `INSERT INTO layaway_plans (plan_number,customer_id,employee_id,branch_id,status,subtotal,tax_amount,total,deposit_required,deposit_percent,amount_paid,payment_frequency,next_due_date,deposit_transaction_id,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [plan_number, customer_id, employee_id || null, branch_id, 'active', subtotal, taxAmount, total, depositRequired, depositPercent, tendered, frequency, nextDue, depositTxId, notes || null] });
      const planId = Number(planResult.lastInsertRowid);

      for (const line of lines) {
        await tx.execute({ sql: `INSERT INTO layaway_plan_items (plan_id,product_id,product_name,sku,quantity,unit_price,tax_rate,line_total) VALUES (?,?,?,?,?,?,?,?)`, args: [planId, line.product.id, line.product.name, line.product.sku, line.quantity, line.unit_price, line.tax_rate, line.lineTotal] });

        await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?', args: [line.quantity, line.product.id] });
        await tx.execute({ sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = MAX(0, stock_qty - ?), updated_at = CURRENT_TIMESTAMP`, args: [line.product.id, branch_id, Math.max(0, line.product.stock_qty - line.quantity), line.product.min_stock, line.quantity] });
        await syncBinQty(tx, line.product.id, branch_id, -line.quantity);
      }

      await tx.execute({ sql: `INSERT INTO layaway_payments (plan_id,payment_number,employee_id,branch_id,amount,payment_method,transaction_id,is_deposit) VALUES (?,?,?,?,?,?,?,1)`, args: [planId, payment_number, employee_id || null, branch_id, tendered, payment_method || 'cash', depositTxId] });

      await tx.commit();
      committed = true;

      const { rows: [plan] } = await db.execute({ sql: detailJoin + ' WHERE lp.id = ?', args: [planId] });
      await attachItemsAndPayments(plan);
      res.status(201).json(plan);
    } catch(e) {
      // Once committed, the plan is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Record an installment payment ─────────────────────────────────────────

router.patch('/plans/:id/payments', requirePermission('layaway_payments'), async (req, res) => {
  try {
    const { amount, payment_method, drawer_session_id, employee_id, notes } = req.body;
    const { rows: [plan] } = await db.execute({ sql: 'SELECT * FROM layaway_plans WHERE id = ?', args: [req.params.id] });
    if (!plan) return res.status(404).json({ error: 'Not found' });
    if (plan.status !== 'active') return res.status(400).json({ error: `This plan is ${plan.status}, not active` });

    const amt = parseFloat(parseFloat(amount).toFixed(2));
    if (!amt || amt <= 0) return res.status(400).json({ error: 'A positive amount is required' });
    const remaining = parseFloat((plan.total - plan.amount_paid).toFixed(2));
    if (amt > remaining + 0.001) return res.status(400).json({ error: `Amount exceeds remaining balance of ${remaining.toFixed(2)}` });

    const transaction_number = await nextNumber(db, 'transactions', 'transaction_number', 'TXN-', 6);
    const payment_number = await nextNumber(db, 'layaway_payments', 'payment_number', 'LWP-', 6);
    const newAmountPaid = parseFloat((plan.amount_paid + amt).toFixed(2));
    const willComplete = newAmountPaid >= plan.total - 0.001;
    const today = new Date().toISOString().slice(0, 10);

    const tx = await db.transaction('write');
    let committed = false;
    try {
      const txResult = await tx.execute({ sql: `INSERT INTO transactions (transaction_number,customer_id,employee_id,branch_id,drawer_session_id,subtotal,tax_amount,total,payment_method,amount_tendered,change_amount,notes,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [transaction_number, plan.customer_id, employee_id || null, plan.branch_id, drawer_session_id || null, amt, 0, amt, payment_method || 'cash', amt, 0, `Layaway payment ${plan.plan_number}`, 'pos'] });
      const payTxId = Number(txResult.lastInsertRowid);
      await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?,?)`, args: [payTxId, null, `Layaway Payment — ${plan.plan_number}`, 'LAYAWAY-PAYMENT', 1, amt, 0, amt] });

      await tx.execute({ sql: `INSERT INTO layaway_payments (plan_id,payment_number,employee_id,branch_id,amount,payment_method,transaction_id,is_deposit,notes) VALUES (?,?,?,?,?,?,?,0,?)`, args: [plan.id, payment_number, employee_id || null, plan.branch_id, amt, payment_method || 'cash', payTxId, notes || null] });

      if (willComplete) {
        const loyaltyPts = Math.floor(plan.total * 0.5);
        await tx.execute({ sql: 'UPDATE customers SET loyalty_points = loyalty_points + ?, total_spent = total_spent + ? WHERE id = ?', args: [loyaltyPts, plan.total, plan.customer_id] });
        await tx.execute({ sql: `UPDATE layaway_plans SET amount_paid = ?, status = 'completed', completed_at = CURRENT_TIMESTAMP, completion_transaction_id = ?, next_due_date = NULL WHERE id = ?`, args: [newAmountPaid, payTxId, plan.id] });
      } else {
        const nextDue = addInterval(today, plan.payment_frequency);
        await tx.execute({ sql: `UPDATE layaway_plans SET amount_paid = ?, next_due_date = ? WHERE id = ?`, args: [newAmountPaid, nextDue, plan.id] });
      }

      await tx.commit();
      committed = true;

      const { rows: [updated] } = await db.execute({ sql: detailJoin + ' WHERE lp.id = ?', args: [plan.id] });
      await attachItemsAndPayments(updated);
      res.json(updated);
    } catch(e) {
      // Once committed, the payment is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Cancel ─────────────────────────────────────────────────────────────────

router.patch('/plans/:id/cancel', requirePermission('layaway_cancel'), async (req, res) => {
  try {
    const { reason, employee_id } = req.body;
    const { rows: [plan] } = await db.execute({ sql: 'SELECT * FROM layaway_plans WHERE id = ?', args: [req.params.id] });
    if (!plan) return res.status(404).json({ error: 'Not found' });
    if (plan.status !== 'active') return res.status(400).json({ error: `Cannot cancel a ${plan.status} plan` });

    const { rows: items } = await db.execute({ sql: 'SELECT * FROM layaway_plan_items WHERE plan_id = ?', args: [req.params.id] });

    const feeType = await getSetting('layaway_cancellation_fee_type', 'percent');
    const feeValue = parseFloat(await getSetting('layaway_cancellation_fee_value', 0)) || 0;
    const rawFee = feeType === 'fixed' ? feeValue : parseFloat((plan.amount_paid * feeValue / 100).toFixed(2));
    const forfeited = Math.min(plan.amount_paid, Math.max(0, rawFee));
    const refunded = parseFloat((plan.amount_paid - forfeited).toFixed(2));
    const refundTxNumber = refunded > 0 ? await nextNumber(db, 'transactions', 'transaction_number', 'TXN-', 6) : null;

    const tx = await db.transaction('write');
    let committed = false;
    try {
      for (const item of items) {
        await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [item.quantity, item.product_id] });
        if (plan.branch_id) {
          await tx.execute({ sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at) VALUES (?, ?, ?, (SELECT min_stock FROM products WHERE id = ?), CURRENT_TIMESTAMP) ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP`, args: [item.product_id, plan.branch_id, item.quantity, item.product_id, item.quantity] });
          await syncBinQty(tx, item.product_id, plan.branch_id, item.quantity);
        }
      }

      if (refunded > 0) {
        const refundResult = await tx.execute({ sql: `INSERT INTO transactions (transaction_number,customer_id,employee_id,branch_id,subtotal,tax_amount,total,payment_method,amount_tendered,change_amount,notes,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, args: [refundTxNumber, plan.customer_id, employee_id || null, plan.branch_id, -refunded, 0, -refunded, 'refund', 0, 0, `Layaway cancellation refund ${plan.plan_number}`, 'pos'] });
        const refundTxId = Number(refundResult.lastInsertRowid);
        await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?,?)`, args: [refundTxId, null, `Layaway Refund — ${plan.plan_number}`, 'LAYAWAY-REFUND', 1, -refunded, 0, -refunded] });
      }

      await tx.execute({ sql: `UPDATE layaway_plans SET status = 'cancelled', cancellation_reason = ?, cancelled_by = ?, cancelled_at = CURRENT_TIMESTAMP, forfeited_amount = ?, refunded_amount = ? WHERE id = ?`, args: [reason || null, employee_id || null, forfeited, refunded, plan.id] });

      await tx.commit();
      committed = true;

      const { rows: [updated] } = await db.execute({ sql: detailJoin + ' WHERE lp.id = ?', args: [plan.id] });
      await attachItemsAndPayments(updated);
      res.json(updated);
    } catch(e) {
      // Once committed, the cancellation is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
