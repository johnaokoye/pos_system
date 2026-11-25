// The layaway behind a transaction, for its receipt/invoice: a layaway
// deposit, installment or cancellation refund is posted as one money line
// ("Layaway Deposit — 2 item(s)"), so the printout adds the plan's items and
// where the plan stood after this payment.
const { db } = require('../database');

async function layawayForTransaction(txId) {
  const { rows: [pay] } = await db.execute({ sql: 'SELECT id, plan_id, is_deposit FROM layaway_payments WHERE transaction_id = ? ORDER BY id LIMIT 1', args: [txId] });
  let planId = pay?.plan_id;
  let kind = pay ? (pay.is_deposit ? 'deposit' : 'payment') : null;
  if (!planId) {
    // A cancellation refund isn't a layaway_payments row: its note names the plan.
    const { rows: [t] } = await db.execute({ sql: 'SELECT notes FROM transactions WHERE id = ?', args: [txId] });
    const m = String(t?.notes || '').match(/^Layaway cancellation refund (\S+)$/);
    if (!m) return null;
    const { rows: [p] } = await db.execute({ sql: 'SELECT id FROM layaway_plans WHERE plan_number = ?', args: [m[1]] });
    if (!p) return null;
    planId = p.id;
    kind = 'refund';
  }
  const { rows: [plan] } = await db.execute({ sql: 'SELECT id, plan_number, status, total, amount_paid, completion_transaction_id, refunded_amount, forfeited_amount FROM layaway_plans WHERE id = ?', args: [planId] });
  if (!plan) return null;
  const { rows: items } = await db.execute({ sql: 'SELECT sku, product_name, quantity, unit_price, line_total FROM layaway_plan_items WHERE plan_id = ? ORDER BY id', args: [planId] });
  // Paid as of this payment, not today — a reprint of the deposit shows the balance then.
  const paid = pay
    ? (await db.execute({ sql: 'SELECT COALESCE(SUM(amount), 0) AS paid FROM layaway_payments WHERE plan_id = ? AND id <= ?', args: [planId, pay.id] })).rows[0].paid
    : plan.amount_paid;
  const total = Number(plan.total) || 0;
  return {
    plan_id: plan.id,
    plan_number: plan.plan_number,
    kind,
    total,
    paid_to_date: Number(paid) || 0,
    balance: kind === 'refund' ? 0 : Math.max(0, Math.round((total - paid) * 100) / 100),
    completed: plan.completion_transaction_id === Number(txId),
    refunded_amount: plan.refunded_amount,
    forfeited_amount: plan.forfeited_amount,
    items,
  };
}

module.exports = { layawayForTransaction };
