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

module.exports = { recordReturnCreditNote };
