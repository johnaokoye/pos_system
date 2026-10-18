// A/R invoices carried over from the old system (ar_legacy_invoices — see
// database.js), pushed in by RetailPOS Books. They sit alongside credit-sale
// invoices (transactions with payment_method = 'credit') everywhere A/R is
// worked: open-invoice lists, oldest-first payment allocation, aging, the
// overdue auto-block and statements. These helpers are the one place that
// knows how to combine the two.

// Amount still owed on a legacy invoice, as a SQL expression over alias `li`.
const LEGACY_BALANCE_SQL = `(li.amount - COALESCE((SELECT SUM(lia.amount) FROM legacy_invoice_allocations lia WHERE lia.legacy_invoice_id = li.id), 0))`;

// Date of a customer's oldest legacy invoice still owing, as a scalar
// subquery against `customerIdExpr` (e.g. 'c.id' or '?').
const oldestOpenLegacySql = customerIdExpr => `(SELECT MIN(li.invoice_date) FROM ar_legacy_invoices li
  WHERE li.customer_id = ${customerIdExpr} AND li.status = 'open' AND ${LEGACY_BALANCE_SQL} > 0.001)`;

// Date of a customer's oldest credit sale still owing (not fully covered by
// payment_allocations), as a scalar subquery against `customerIdExpr`. A
// returned rental's checkout invoice is settled by its settlement
// transaction instead, so it's left out (same as openArInvoices).
const oldestUnpaidSaleSql = customerIdExpr => `(SELECT MIN(t.created_at) FROM transactions t
  WHERE t.customer_id = ${customerIdExpr} AND t.payment_method = 'credit' AND t.status = 'completed'
    AND t.id NOT IN (SELECT checkout_transaction_id FROM rental_agreements WHERE status = 'returned' AND checkout_transaction_id IS NOT NULL)
    AND t.total - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa WHERE pa.transaction_id = t.id), 0) > 0.001)`;

// Earlier of two date strings, ignoring blanks (SQLite's MIN(a, b) is NULL
// if either side is).
function earliestDate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return new Date(a) <= new Date(b) ? a : b;
}

// Every invoice a customer still owes on, oldest first — credit sales and
// legacy invoices in one list. Credit sales keep the shape GET
// /accounts/invoices has always returned (id = transaction id); legacy rows
// add kind: 'legacy' and legacy_invoice_id, with their invoice number and
// date in transaction_number/created_at so existing screens can show them.
async function openArInvoices(executor, customerId) {
  const { rows: sales } = await executor.execute({
    sql: `SELECT t.id, t.transaction_number, t.total, t.created_at,
            COALESCE(SUM(pa.amount), 0) as paid_amount,
            t.total - COALESCE(SUM(pa.amount), 0) as balance_due
          FROM transactions t
          LEFT JOIN payment_allocations pa ON t.id = pa.transaction_id
          WHERE t.customer_id = ? AND t.payment_method = 'credit' AND t.status = 'completed'
            -- A returned rental's checkout invoice is already reconciled by its
            -- settlement transaction (routes/rentals.js return handler) — without
            -- this it would double-count here since that reconciliation isn't
            -- expressed as a payment_allocations row.
            AND t.id NOT IN (SELECT checkout_transaction_id FROM rental_agreements WHERE status = 'returned' AND checkout_transaction_id IS NOT NULL)
          GROUP BY t.id
          HAVING t.total - COALESCE(SUM(pa.amount), 0) > 0.001`,
    args: [customerId],
  });
  const { rows: legacy } = await executor.execute({
    sql: `SELECT li.id, li.invoice_number, li.invoice_date, li.due_date, li.amount, li.memo,
            li.amount - ${LEGACY_BALANCE_SQL} as paid_amount, ${LEGACY_BALANCE_SQL} as balance_due
          FROM ar_legacy_invoices li
          WHERE li.customer_id = ? AND li.status = 'open' AND ${LEGACY_BALANCE_SQL} > 0.001`,
    args: [customerId],
  });
  const all = [
    ...sales.map(s => ({ ...s, kind: 'sale' })),
    ...legacy.map(l => ({
      id: l.id, kind: 'legacy', legacy_invoice_id: l.id,
      transaction_number: l.invoice_number, created_at: l.invoice_date, due_date: l.due_date, memo: l.memo,
      total: l.amount, paid_amount: l.paid_amount, balance_due: l.balance_due,
    })),
  ];
  return all.sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || (a.kind === 'legacy' ? -1 : 1));
}

// Turns a payment/write-off request's allocations — each either
// { transaction_id, amount } or { legacy_invoice_id, amount } — or, when none
// are given, an oldest-first spread of `amount` across openArInvoices, into
// the rows to insert. Legacy allocations must be the customer's own open
// invoices and can't exceed what's owed on them.
async function buildAllocations(executor, customerId, amount, allocations) {
  const money = v => parseFloat(parseFloat(v).toFixed(2));
  if (Array.isArray(allocations) && allocations.length > 0) {
    const out = allocations.filter(a => parseFloat(a.amount) > 0).map(a => a.legacy_invoice_id
      ? { legacy_invoice_id: parseInt(a.legacy_invoice_id), amount: money(a.amount) }
      : { transaction_id: parseInt(a.transaction_id), amount: money(a.amount) });
    const legacyIds = out.filter(a => a.legacy_invoice_id).map(a => a.legacy_invoice_id);
    if (legacyIds.length) {
      const open = new Map((await openArInvoices(executor, customerId)).filter(i => i.kind === 'legacy').map(i => [i.legacy_invoice_id, i]));
      for (const a of out.filter(x => x.legacy_invoice_id)) {
        const inv = open.get(a.legacy_invoice_id);
        if (!inv) throw new Error(`Legacy invoice ${a.legacy_invoice_id} isn't an open invoice on this account`);
        if (a.amount - inv.balance_due > 0.005) throw new Error(`Only ${inv.balance_due.toFixed(2)} is owed on legacy invoice ${inv.transaction_number}`);
      }
    }
    return out;
  }
  const out = [];
  let remaining = money(amount);
  for (const inv of await openArInvoices(executor, customerId)) {
    if (remaining <= 0.001) break;
    const apply = money(Math.min(remaining, inv.balance_due));
    out.push(inv.kind === 'legacy' ? { legacy_invoice_id: inv.legacy_invoice_id, amount: apply } : { transaction_id: inv.id, amount: apply });
    remaining = money(remaining - apply);
  }
  return out;
}

async function insertAllocations(executor, paymentId, allocations) {
  for (const a of allocations) {
    if (a.legacy_invoice_id) {
      await executor.execute({ sql: 'INSERT INTO legacy_invoice_allocations (payment_id, legacy_invoice_id, amount) VALUES (?,?,?)', args: [paymentId, a.legacy_invoice_id, a.amount] });
    } else {
      await executor.execute({ sql: 'INSERT INTO payment_allocations (payment_id, transaction_id, amount) VALUES (?,?,?)', args: [paymentId, a.transaction_id, a.amount] });
    }
  }
}

// What one payment was applied to — both kinds, oldest invoice first, in the
// row shape statements and the payment history already render
// (transaction_number / invoice_total / invoice_date / amount). Legacy rows
// have transaction_id null and legacy_invoice_id set.
async function paymentAllocations(executor, paymentId) {
  const { rows: sales } = await executor.execute({
    sql: `SELECT pa.*, t.transaction_number, t.total as invoice_total, t.created_at as invoice_date
          FROM payment_allocations pa LEFT JOIN transactions t ON pa.transaction_id = t.id
          WHERE pa.payment_id = ?`,
    args: [paymentId],
  });
  const { rows: legacy } = await executor.execute({
    sql: `SELECT lia.id, lia.payment_id, NULL as transaction_id, lia.legacy_invoice_id, lia.amount, lia.created_at,
            li.invoice_number as transaction_number, li.amount as invoice_total, li.invoice_date
          FROM legacy_invoice_allocations lia JOIN ar_legacy_invoices li ON li.id = lia.legacy_invoice_id
          WHERE lia.payment_id = ?`,
    args: [paymentId],
  });
  return [...sales, ...legacy].sort((a, b) => new Date(a.invoice_date) - new Date(b.invoice_date));
}

module.exports = { LEGACY_BALANCE_SQL, oldestOpenLegacySql, oldestUnpaidSaleSql, earliestDate, openArInvoices, buildAllocations, insertAllocations, paymentAllocations };
