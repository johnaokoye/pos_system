// Customer account payments, received by cashiers at the POS (permission
// pos_receive_payment; routes/customer-payments.js). Two ways to post one:
//
//   'open'     — on account: reduces the balance now, applied to no invoice.
//                The unapplied amount stays on the payment until a cashier
//                applies it to invoices later (applyPayment).
//   'invoices' — applied straight to the invoices the cashier picks (credit
//                sales and/or legacy invoices, lib/legacyInvoices.js); the
//                applied amounts must add up to the payment.
//
// Each payment records the POS drawer session it went into, so the drawer's
// reconciliation counts it (routes/drawers.js). Write-offs stay with the
// accounts team (routes/accounts.js) and are never "open".
const { db } = require('../database');
const { nextNumber } = require('./nextNumber');
const { openArInvoices, insertAllocations } = require('./legacyInvoices');

const PAYMENT_METHODS = ['cash', 'credit_card', 'debit_card', 'check', 'direct_deposit'];
const money = v => Math.round((Number(v) || 0) * 100) / 100;

// Amount of a payment not yet applied to any invoice, as a SQL expression
// over alias `ap`.
const UNAPPLIED_SQL = `(ap.amount
  - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa WHERE pa.payment_id = ap.id), 0)
  - COALESCE((SELECT SUM(lia.amount) FROM legacy_invoice_allocations lia WHERE lia.payment_id = ap.id), 0)
  - COALESCE((SELECT SUM(scu.amount) FROM store_credit_uses scu WHERE scu.payment_id = ap.id), 0))`;

async function unappliedPayments(executor, customerId) {
  const { rows } = await executor.execute({
    sql: `SELECT ap.id, ap.payment_number, ap.amount, ap.payment_method, ap.created_at, ${UNAPPLIED_SQL} AS unapplied
          FROM account_payments ap WHERE ap.customer_id = ? AND ap.payment_method != 'writeoff' AND ${UNAPPLIED_SQL} > 0.005
          ORDER BY ap.created_at, ap.id`,
    args: [customerId],
  });
  return rows.map(r => ({ ...r, unapplied: money(r.unapplied) }));
}

// Everything the Receive Payment screen needs for one customer.
async function accountSummary(customerId) {
  const { rows: [customer] } = await db.execute({ sql: 'SELECT id, customer_number, first_name, last_name, customer_type, account_balance, credit_limit, account_blocked FROM customers WHERE id = ?', args: [customerId] });
  if (!customer) return null;
  const invoices = await openArInvoices(db, customerId);
  const open_payments = await unappliedPayments(db, customerId);
  return { customer, invoices, open_payments, unapplied_total: money(open_payments.reduce((s, p) => s + p.unapplied, 0)) };
}

// Checks cashier-chosen allocations ({ transaction_id | legacy_invoice_id,
// amount }) against the customer's open invoices; returns the cleaned list.
async function validateAllocations(customerId, allocations) {
  const open = await openArInvoices(db, customerId);
  const byKey = new Map(open.map(i => [i.kind === 'legacy' ? `L${i.legacy_invoice_id}` : `T${i.id}`, i]));
  const seen = new Set();
  const out = [];
  for (const a of Array.isArray(allocations) ? allocations : []) {
    const amount = money(a.amount);
    if (!(amount > 0)) continue;
    const key = a.legacy_invoice_id ? `L${parseInt(a.legacy_invoice_id)}` : `T${parseInt(a.transaction_id)}`;
    const inv = byKey.get(key);
    if (!inv) throw new Error('One of the selected invoices is no longer open on this account — refresh and try again');
    if (seen.has(key)) throw new Error(`Invoice ${inv.transaction_number} is selected twice`);
    seen.add(key);
    if (amount - inv.balance_due > 0.005) throw new Error(`Only ${money(inv.balance_due).toFixed(2)} is owed on invoice ${inv.transaction_number}`);
    out.push(inv.kind === 'legacy' ? { legacy_invoice_id: inv.legacy_invoice_id, amount } : { transaction_id: inv.id, amount });
  }
  return out;
}

// Every A/R invoice on the account — credit sales and legacy invoices, paid
// or not — with what's owed now. Used when reallocating, where an invoice a
// payment is moved away from may currently show nothing owing.
async function allArInvoices(executor, customerId) {
  const { rows: sales } = await executor.execute({
    sql: `SELECT t.id, t.transaction_number, t.total, t.created_at, t.total - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa WHERE pa.transaction_id = t.id), 0) AS balance_due
          FROM transactions t WHERE t.customer_id = ? AND t.payment_method = 'credit' AND t.status = 'completed'
            AND t.id NOT IN (SELECT checkout_transaction_id FROM rental_agreements WHERE status = 'returned' AND checkout_transaction_id IS NOT NULL)`,
    args: [customerId],
  });
  const { rows: legacy } = await executor.execute({
    sql: `SELECT li.id, li.invoice_number, li.amount, li.invoice_date, li.amount - COALESCE((SELECT SUM(lia.amount) FROM legacy_invoice_allocations lia WHERE lia.legacy_invoice_id = li.id), 0) AS balance_due
          FROM ar_legacy_invoices li WHERE li.customer_id = ? AND li.status = 'open'`,
    args: [customerId],
  });
  return [
    ...sales.map(s => ({ key: `T${s.id}`, kind: 'sale', id: s.id, transaction_id: s.id, number: s.transaction_number, date: s.created_at, total: s.total, balance_due: money(s.balance_due) })),
    ...legacy.map(l => ({ key: `L${l.id}`, kind: 'legacy', id: l.id, legacy_invoice_id: l.id, number: l.invoice_number, date: l.invoice_date, total: l.amount, balance_due: money(l.balance_due) })),
  ].sort((a, b) => new Date(a.date) - new Date(b.date));
}

const allocKey = a => (a.legacy_invoice_id ? `L${a.legacy_invoice_id}` : `T${a.transaction_id}`);

async function currentAllocations(executor, paymentId) {
  const { rows: s } = await executor.execute({ sql: 'SELECT transaction_id, amount FROM payment_allocations WHERE payment_id = ?', args: [paymentId] });
  const { rows: l } = await executor.execute({ sql: 'SELECT legacy_invoice_id, amount FROM legacy_invoice_allocations WHERE payment_id = ?', args: [paymentId] });
  // Merged per invoice (a payment applied to one invoice twice shows once).
  const byKey = new Map();
  for (const a of [...s.map(r => ({ transaction_id: r.transaction_id, amount: r.amount })), ...l.map(r => ({ legacy_invoice_id: r.legacy_invoice_id, amount: r.amount }))]) {
    const k = allocKey(a);
    byKey.set(k, { ...a, amount: money((byKey.get(k)?.amount || 0) + a.amount) });
  }
  return [...byKey.values()];
}

// Sets exactly which invoices a payment is applied to, and how much to each —
// allocating an open payment (adding invoices) and reallocating between
// invoices on the same account are both this. The receipt is untouched: same
// amount, no new payment; whatever isn't allocated stays open on account.
// Each invoice can take at most what it owes plus what this payment already
// had on it. Logged in payment_allocation_changes.
async function setPaymentAllocations(paymentId, allocations, { changedBy = null, source = 'pos' } = {}) {
  const { rows: [payment] } = await db.execute({ sql: 'SELECT * FROM account_payments WHERE id = ?', args: [paymentId] });
  if (!payment) throw new Error('Payment not found');
  if (payment.payment_method === 'writeoff') throw new Error('Write-offs are applied when they are made and can\'t be reallocated');
  const before = await currentAllocations(db, paymentId);
  const beforeBy = new Map(before.map(a => [allocKey(a), a.amount]));
  const invoices = new Map((await allArInvoices(db, payment.customer_id)).map(i => [i.key, i]));
  const after = [];
  const seen = new Set();
  for (const a of Array.isArray(allocations) ? allocations : []) {
    const amount = money(a.amount);
    if (!(amount > 0)) continue;
    const key = a.legacy_invoice_id ? `L${parseInt(a.legacy_invoice_id)}` : `T${parseInt(a.transaction_id)}`;
    const inv = invoices.get(key);
    if (!inv) throw new Error('One of the invoices isn\'t an invoice on this customer\'s account');
    if (seen.has(key)) throw new Error(`Invoice ${inv.number} is listed twice`);
    seen.add(key);
    const available = money(inv.balance_due + (beforeBy.get(key) || 0));
    if (amount - available > 0.005) throw new Error(`Invoice ${inv.number} can take at most ${available.toFixed(2)} from this payment`);
    after.push(inv.kind === 'legacy' ? { legacy_invoice_id: inv.legacy_invoice_id, amount } : { transaction_id: inv.transaction_id, amount });
  }
  // Store credit already spent from it at the till (store_credit_uses) isn't
  // available to put on invoices.
  const { rows: [used] } = await db.execute({ sql: 'SELECT COALESCE(SUM(amount), 0) AS v FROM store_credit_uses WHERE payment_id = ?', args: [paymentId] });
  const total = money(after.reduce((s, a) => s + a.amount, 0) + Number(used.v));
  if (total - payment.amount > 0.005) throw new Error(`The allocations (${total.toFixed(2)}) are more than payment ${payment.payment_number} (${money(payment.amount).toFixed(2)})`);

  const tx = await db.transaction('write');
  let committed = false;
  try {
    await tx.execute({ sql: 'DELETE FROM payment_allocations WHERE payment_id = ?', args: [paymentId] });
    await tx.execute({ sql: 'DELETE FROM legacy_invoice_allocations WHERE payment_id = ?', args: [paymentId] });
    await insertAllocations(tx, paymentId, after);
    await tx.execute({ sql: 'INSERT INTO payment_allocation_changes (payment_id, customer_id, before_json, after_json, changed_by, source) VALUES (?,?,?,?,?,?)',
      args: [paymentId, payment.customer_id, JSON.stringify(before), JSON.stringify(after), changedBy, source] });
    await tx.commit();
    committed = true;
  } catch (e) {
    // Never roll back after a commit — that throws and crashes the process.
    if (!committed) await tx.rollback();
    throw e;
  }
  await recheckCredit(payment.customer_id);
  await afterSaleAllocations(after);
  return paymentRow(paymentId);
}

// A credit-financed rental's commission is paid once its checkout invoice is
// fully paid — checked for the sale invoices a payment was just applied to.
async function afterSaleAllocations(allocations) {
  const { calcRentalCommission } = require('../routes/commissions');
  for (const alloc of allocations.filter(a => a.transaction_id)) {
    try {
      const { rows: [agreement] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE checkout_transaction_id = ?', args: [alloc.transaction_id] });
      if (!agreement) continue;
      const { rows: [checkoutTx] } = await db.execute({ sql: 'SELECT * FROM transactions WHERE id = ?', args: [alloc.transaction_id] });
      const { rows: [{ paid }] } = await db.execute({ sql: 'SELECT COALESCE(SUM(amount),0) AS paid FROM payment_allocations WHERE transaction_id = ?', args: [alloc.transaction_id] });
      if (checkoutTx && checkoutTx.total - paid <= 0.001) await calcRentalCommission(agreement, checkoutTx);
    } catch (e) {}
  }
}

async function recheckCredit(customerId) {
  try { await require('../routes/customers').runCreditCheck(customerId); } catch (e) {}
}

// Posts a payment. Throws a user-facing Error for anything invalid; returns
// the saved payment with its allocations.
async function receivePayment({ customer_id, amount, payment_method, payment_mode, allocations, drawer_session_id, branch_id, employee_id, reference, notes }) {
  const amt = money(amount);
  if (!(amt > 0)) throw new Error('Enter the amount received');
  if (!PAYMENT_METHODS.includes(payment_method)) throw new Error('Choose how the customer paid');
  if (!['open', 'invoices'].includes(payment_mode)) throw new Error('Choose an open payment or invoice payment');
  const { rows: [customer] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [customer_id] });
  if (!customer) throw new Error('Customer not found');
  if (!(customer.account_balance > 0.005)) throw new Error(`${customer.first_name} ${customer.last_name} doesn't owe anything on account`);
  if (amt - customer.account_balance > 0.005) throw new Error(`That's more than the ${money(customer.account_balance).toFixed(2)} owed on the account`);
  if (!drawer_session_id) throw new Error('Open a cash drawer before receiving a payment');
  const { rows: [session] } = await db.execute({ sql: "SELECT id, branch_id FROM drawer_sessions WHERE id = ? AND status = 'open'", args: [drawer_session_id] });
  if (!session) throw new Error('The cash drawer session is closed — open a drawer before receiving a payment');

  let allocs = [];
  if (payment_mode === 'invoices') {
    allocs = await validateAllocations(customer_id, allocations);
    if (!allocs.length) throw new Error('Select at least one invoice to apply the payment to');
    const total = money(allocs.reduce((s, a) => s + a.amount, 0));
    if (Math.abs(total - amt) > 0.005) throw new Error(`The amounts applied to invoices (${total.toFixed(2)}) must add up to the payment (${amt.toFixed(2)})`);
  }

  const payment_number = await nextNumber(db, 'account_payments', 'payment_number', 'PMT-', 6);
  const tx = await db.transaction('write');
  let committed = false, paymentId;
  try {
    const result = await tx.execute({
      sql: 'INSERT INTO account_payments (payment_number, customer_id, employee_id, branch_id, amount, payment_method, notes, drawer_session_id, payment_mode, reference) VALUES (?,?,?,?,?,?,?,?,?,?)',
      args: [payment_number, customer_id, employee_id || null, branch_id || session.branch_id || null, amt, payment_method, notes || null, drawer_session_id, payment_mode, reference || null],
    });
    paymentId = Number(result.lastInsertRowid);
    await insertAllocations(tx, paymentId, allocs);
    await tx.execute({ sql: 'UPDATE customers SET account_balance = account_balance - ? WHERE id = ?', args: [amt, customer_id] });
    await tx.commit();
    committed = true;
  } catch (e) {
    // Never roll back after a commit — that throws and crashes the process.
    if (!committed) await tx.rollback();
    throw e;
  }
  await recheckCredit(customer_id);
  await afterSaleAllocations(allocs);
  return paymentRow(paymentId);
}

// Applies (part of) an open payment's unapplied amount to invoices. No money
// moves — the balance already came down when the payment was received.
async function applyPayment(paymentId, allocations, changedBy = null) {
  const { rows: [payment] } = await db.execute({ sql: `SELECT ap.*, ${UNAPPLIED_SQL} AS unapplied FROM account_payments ap WHERE ap.id = ?`, args: [paymentId] });
  if (!payment) throw new Error('Payment not found');
  if (payment.payment_method === 'writeoff') throw new Error('Write-offs are applied when they are made');
  const allocs = await validateAllocations(payment.customer_id, allocations);
  if (!allocs.length) throw new Error('Select at least one invoice to apply the payment to');
  const total = money(allocs.reduce((s, a) => s + a.amount, 0));
  if (total - payment.unapplied > 0.005) throw new Error(`Only ${money(payment.unapplied).toFixed(2)} of payment ${payment.payment_number} is left to apply`);
  const before = await currentAllocations(db, paymentId);
  const tx = await db.transaction('write');
  let committed = false;
  try {
    await insertAllocations(tx, paymentId, allocs);
    await tx.execute({ sql: 'INSERT INTO payment_allocation_changes (payment_id, customer_id, before_json, after_json, changed_by, source) VALUES (?,?,?,?,?,?)',
      args: [paymentId, payment.customer_id, JSON.stringify(before), JSON.stringify([...before, ...allocs]), changedBy, 'pos'] });
    await tx.commit();
    committed = true;
  } catch (e) {
    if (!committed) await tx.rollback();
    throw e;
  }
  await recheckCredit(payment.customer_id);
  await afterSaleAllocations(allocs);
  return paymentRow(paymentId);
}

async function paymentRow(paymentId) {
  const { rows: [row] } = await db.execute({
    sql: `SELECT ap.*, ${UNAPPLIED_SQL} AS unapplied, c.first_name || ' ' || c.last_name AS customer_name, c.customer_number, c.account_balance AS balance_after
          FROM account_payments ap JOIN customers c ON c.id = ap.customer_id WHERE ap.id = ?`,
    args: [paymentId],
  });
  if (row) row.unapplied = money(row.unapplied);
  return row;
}

// Everything a payment receipt shows (screen, print and email): the payment,
// customer, branch, who took it, the invoices it was applied to (credit sales
// and legacy invoices) and the account balance as it stands now. Write-offs
// and legacy credit notes aren't payments received, so they have no receipt.
async function paymentReceipt(paymentId) {
  const { rows: [p] } = await db.execute({
    sql: `SELECT ap.*, ${UNAPPLIED_SQL} AS unapplied,
            c.first_name || ' ' || c.last_name AS customer_name, c.customer_number, c.email AS customer_email, c.phone AS customer_phone,
            c.address AS customer_address, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip, c.account_balance,
            e.first_name || ' ' || e.last_name AS employee_name,
            b.name AS branch_name, b.address AS branch_address, b.city AS branch_city, b.state AS branch_state, b.zip AS branch_zip, b.phone AS branch_phone
          FROM account_payments ap
          JOIN customers c ON c.id = ap.customer_id
          LEFT JOIN employees e ON e.id = ap.employee_id
          LEFT JOIN branches b ON b.id = ap.branch_id
          WHERE ap.id = ? AND ap.payment_method NOT IN ('writeoff', 'credit_note')`,
    args: [paymentId],
  });
  if (!p) return null;
  const { rows: applied } = await db.execute({
    sql: `SELECT t.transaction_number AS invoice_number, t.created_at AS invoice_date, SUM(pa.amount) AS amount
            FROM payment_allocations pa JOIN transactions t ON t.id = pa.transaction_id WHERE pa.payment_id = ? GROUP BY t.id
          UNION ALL
          SELECT li.invoice_number, li.invoice_date, SUM(lia.amount)
            FROM legacy_invoice_allocations lia JOIN ar_legacy_invoices li ON li.id = lia.legacy_invoice_id WHERE lia.payment_id = ? GROUP BY li.id
          ORDER BY invoice_date`,
    args: [paymentId, paymentId],
  });
  p.applied = applied.map(a => ({ ...a, amount: money(a.amount) }));
  p.unapplied = money(p.unapplied);
  p.account_balance = money(p.account_balance);
  return p;
}

// Total of a customer's received payments not yet applied to invoices.
async function unappliedTotal(executor, customerId) {
  const { rows: [r] } = await executor.execute({ sql: `SELECT COALESCE(SUM(CASE WHEN ${UNAPPLIED_SQL} > 0.005 THEN ${UNAPPLIED_SQL} ELSE 0 END), 0) AS t FROM account_payments ap WHERE ap.customer_id = ? AND ap.payment_method != 'writeoff'`, args: [customerId] });
  return money(r.t);
}

// Date of the customer's oldest invoice still owing once their unapplied
// (open) payments are counted against the oldest invoices first — so a
// customer who paid on account isn't treated as overdue just because the
// payment hasn't been matched to invoices yet. null when nothing's owing.
async function oldestOwingDate(executor, customerId) {
  let credit = await unappliedTotal(executor, customerId);
  for (const inv of await openArInvoices(executor, customerId)) {
    if (credit - inv.balance_due >= -0.005) { credit = money(credit - inv.balance_due); continue; }
    return inv.created_at;
  }
  return null;
}

module.exports = { PAYMENT_METHODS, UNAPPLIED_SQL, paymentReceipt, oldestOwingDate, allArInvoices, currentAllocations, setPaymentAllocations, accountSummary, receivePayment, applyPayment, unappliedPayments, unappliedTotal, paymentRow };
