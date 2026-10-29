// A return settled by credit note (routes/transactions.js) lowers the
// customer's account_balance. This records that credit as a document on the
// account — an account_payments row with payment_method 'credit_note' and
// return_id set, like a legacy credit note — applied to the invoice the goods
// came from (up to what it still owes) so the customer can see which invoice
// it went against. Anything left over stays open on the account, to be applied
// to other invoices like an unapplied payment. It never touches the balance
// itself (the return already did) and, having no drawer session, is never in
// a drawer count or the collections report.

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

async function recordReturnCreditNote(executor, { returnId, returnNumber, transaction, customerId, employeeId, branchId, amount, number, createdAt }) {
  const total = round2(amount);
  if (!(total > 0) || !customerId) return null;
  let applied = 0;
  if (transaction && (transaction.is_credit || transaction.payment_method === 'credit')) {
    const { rows: [inv] } = await executor.execute({
      sql: `SELECT t.total - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa WHERE pa.transaction_id = t.id), 0) AS due
            FROM transactions t WHERE t.id = ? AND t.customer_id = ? AND t.payment_method = 'credit' AND t.status = 'completed'`,
      args: [transaction.id, customerId],
    });
    if (inv) applied = round2(Math.min(total, Math.max(0, Number(inv.due) || 0)));
  }
  const result = await executor.execute({
    sql: `INSERT INTO account_payments (payment_number, customer_id, employee_id, branch_id, amount, payment_method, payment_mode, reference, notes, return_id, created_at)
          VALUES (?,?,?,?,?,'credit_note',?,?,?,?,COALESCE(?, CURRENT_TIMESTAMP))`,
    args: [number, customerId, employeeId || null, branchId || null, total, applied >= total ? 'invoices' : 'open',
      returnNumber, `Credit note for return ${returnNumber}${transaction ? ` of ${transaction.transaction_number}` : ''}`, returnId, createdAt || null],
  });
  const paymentId = Number(result.lastInsertRowid);
  if (applied > 0) {
    await executor.execute({ sql: 'INSERT INTO payment_allocations (payment_id, transaction_id, amount) VALUES (?,?,?)', args: [paymentId, transaction.id, applied] });
  }
  return paymentId;
}

// Store credit spent on a sale (transactions.store_credit_applied) comes out
// of the customer's open credits — credit notes and unapplied payments,
// oldest first — recorded in store_credit_uses so a spent credit note can't
// also be put on an invoice. Takes what's there if the open credits come to
// less (older store credit that was never a document).
async function useStoreCredit(executor, { customerId, transactionId, amount }) {
  let left = round2(amount);
  if (!(left > 0) || !customerId) return;
  const { rows } = await executor.execute({
    sql: `SELECT ap.id, ap.amount
            - COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id = ap.id), 0)
            - COALESCE((SELECT SUM(amount) FROM legacy_invoice_allocations WHERE payment_id = ap.id), 0)
            - COALESCE((SELECT SUM(amount) FROM store_credit_uses WHERE payment_id = ap.id), 0) AS open
          FROM account_payments ap WHERE ap.customer_id = ? AND ap.payment_method != 'writeoff'
          ORDER BY CASE WHEN ap.payment_method = 'credit_note' THEN 0 ELSE 1 END, ap.created_at, ap.id`,
    args: [customerId],
  });
  for (const r of rows) {
    if (left <= 0.005) break;
    const take = round2(Math.min(left, Number(r.open) || 0));
    if (take <= 0.005) continue;
    await executor.execute({ sql: 'INSERT INTO store_credit_uses (payment_id, transaction_id, amount) VALUES (?,?,?)', args: [r.id, transactionId, take] });
    left = round2(left - take);
  }
}

module.exports = { recordReturnCreditNote, useStoreCredit };
