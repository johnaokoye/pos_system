// One customer's receivables invoice by invoice — the "Customer Aging Detail"
// the accounts team works from. Each invoice (credit sale or legacy invoice)
// carries its due date, age, P.O. # / reference, and every payment, credit
// note and write-off applied to it, with what's still owing. Credits not yet
// applied to any invoice are listed separately. Used by the account view
// (GET /accounts/customer/:id/detail) and its print/email (routes/email.js).

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const dayMs = 86400000;
// Whole days from a date (YYYY-MM-DD or a timestamp) to today, by calendar date.
const daysSince = (d, today) => Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`)) / dayMs);
const addDays = (d, n) => new Date(Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);

// P = payment, C = credit note, W = write-off
const docType = method => (method === 'writeoff' ? 'W' : method === 'credit_note' ? 'C' : 'P');

async function customerArDetail(executor, customerId, { all = false, today = new Date().toLocaleDateString('en-CA') } = {}) {
  const { rows: [customer] } = await executor.execute({
    sql: `SELECT id, customer_number, first_name, last_name, business_name, address, city, state, zip, phone, email,
            credit_enabled, credit_limit, credit_terms_days, account_balance FROM customers WHERE id = ?`,
    args: [customerId],
  });
  if (!customer) return null;
  const terms = Number(customer.credit_terms_days) || 30;

  const { rows: sales } = await executor.execute({
    sql: `SELECT t.id, t.transaction_number, t.total, t.created_at, t.po_number FROM transactions t
          WHERE t.customer_id = ? AND t.payment_method = 'credit' AND t.status = 'completed'
            AND t.id NOT IN (SELECT checkout_transaction_id FROM rental_agreements WHERE status = 'returned' AND checkout_transaction_id IS NOT NULL)`,
    args: [customerId],
  });
  const { rows: legacy } = await executor.execute({
    sql: "SELECT id, invoice_number, invoice_date, due_date, amount, memo FROM ar_legacy_invoices WHERE customer_id = ? AND status = 'open'",
    args: [customerId],
  });
  // Everything applied to this customer's invoices, whoever's payment it was.
  const { rows: applied } = await executor.execute({
    sql: `SELECT 'T' || pa.transaction_id AS inv, pa.amount, ap.id AS payment_id, ap.payment_number, ap.payment_method, ap.reference, ap.created_at
            FROM payment_allocations pa JOIN account_payments ap ON ap.id = pa.payment_id
            WHERE pa.transaction_id IN (SELECT id FROM transactions WHERE customer_id = ?)
          UNION ALL
          SELECT 'L' || lia.legacy_invoice_id, lia.amount, ap.id, ap.payment_number, ap.payment_method, ap.reference, ap.created_at
            FROM legacy_invoice_allocations lia JOIN account_payments ap ON ap.id = lia.payment_id
            WHERE lia.legacy_invoice_id IN (SELECT id FROM ar_legacy_invoices WHERE customer_id = ?)
          UNION ALL
          SELECT 'S' || scu.transaction_id, scu.amount, ap.id, ap.payment_number, ap.payment_method, ap.reference, ap.created_at
            FROM store_credit_uses scu JOIN account_payments ap ON ap.id = scu.payment_id
            WHERE ap.customer_id = ?
          ORDER BY 7, 3`,
    args: [customerId, customerId, customerId],
  });
  const byInvoice = new Map();
  for (const a of applied) {
    if (!byInvoice.has(a.inv)) byInvoice.set(a.inv, []);
    byInvoice.get(a.inv).push({ type: docType(a.payment_method), payment_id: a.payment_id, number: a.payment_number, method: a.payment_method,
      reference: a.reference || null, date: a.created_at, amount: round2(a.amount) });
  }

  const invoices = [
    ...sales.map(t => ({ key: `T${t.id}`, kind: 'sale', id: t.id, number: t.transaction_number, date: String(t.created_at).slice(0, 10),
      due_date: addDays(t.created_at, terms), reference: t.po_number || null, amount: round2(t.total) })),
    ...legacy.map(l => ({ key: `L${l.id}`, kind: 'legacy', id: l.id, number: l.invoice_number, date: String(l.invoice_date).slice(0, 10),
      due_date: l.due_date ? String(l.due_date).slice(0, 10) : addDays(l.invoice_date, terms), reference: l.memo || null, amount: round2(l.amount) })),
    // A sale where the customer spent credit (store_credit_uses) — shown with
    // the credit notes / payments it came from; nothing is owed on it.
    ...(all ? (await executor.execute({
      sql: `SELECT t.id, t.transaction_number, t.created_at, t.po_number, SUM(scu.amount) AS used FROM store_credit_uses scu
            JOIN transactions t ON t.id = scu.transaction_id JOIN account_payments ap ON ap.id = scu.payment_id
            WHERE ap.customer_id = ? GROUP BY t.id`,
      args: [customerId],
    })).rows.map(t => ({ key: `S${t.id}`, kind: 'store_credit', id: t.id, number: t.transaction_number, date: String(t.created_at).slice(0, 10),
      due_date: String(t.created_at).slice(0, 10), reference: t.po_number || 'Store credit used', amount: round2(t.used) })) : []),
  ].map(inv => {
    const lines = byInvoice.get(inv.key) || [];
    const sum = t => round2(lines.filter(l => l.type === t).reduce((s, l) => s + l.amount, 0));
    const paid = sum('P'), credited = sum('C'), written_off = sum('W');
    return { ...inv, applied: lines, paid, credited, written_off, balance_due: round2(inv.amount - paid - credited - written_off),
      age_days: daysSince(inv.date, today), days_past_due: Math.max(0, daysSince(inv.due_date, today)) };
  }).filter(inv => all || inv.balance_due > 0.005)
    .sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));

  // Payments and credit notes with something not yet applied to an invoice.
  const { rows: credits } = await executor.execute({
    sql: `SELECT ap.id, ap.payment_number, ap.payment_method, ap.reference, ap.created_at, ap.amount,
            ap.amount - COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id = ap.id), 0)
              - COALESCE((SELECT SUM(amount) FROM legacy_invoice_allocations WHERE payment_id = ap.id), 0)
              - COALESCE((SELECT SUM(amount) FROM store_credit_uses WHERE payment_id = ap.id), 0) AS unapplied
          FROM account_payments ap WHERE ap.customer_id = ? AND ap.payment_method != 'writeoff' ORDER BY ap.created_at, ap.id`,
    args: [customerId],
  });
  const unapplied = credits.filter(c => c.unapplied > 0.005).map(c => ({ type: docType(c.payment_method), payment_id: c.id, number: c.payment_number,
    method: c.payment_method, reference: c.reference || null, date: c.created_at, amount: round2(c.amount), unapplied: round2(c.unapplied),
    age_days: daysSince(c.created_at, today) }));

  // Aged by invoice date, like the AR Aging Report.
  const open = invoices.filter(i => i.balance_due > 0.005);
  const bucket = (lo, hi) => round2(open.filter(i => i.age_days >= lo && i.age_days <= hi).reduce((s, i) => s + i.balance_due, 0));
  const aging = { current: bucket(-Infinity, 30), d31_60: bucket(31, 60), d61_90: bucket(61, 90), over_90: bucket(91, Infinity) };
  const open_invoices = round2(open.reduce((s, i) => s + i.balance_due, 0));
  const unapplied_total = round2(unapplied.reduce((s, c) => s + c.unapplied, 0));

  const { rows: [last] } = await executor.execute({
    sql: "SELECT payment_number, amount, created_at FROM account_payments WHERE customer_id = ? AND payment_method NOT IN ('writeoff', 'credit_note') ORDER BY created_at DESC, id DESC LIMIT 1",
    args: [customerId],
  });

  return {
    as_of: today,
    customer: { ...customer, terms_days: terms },
    last_payment: last ? { number: last.payment_number, amount: round2(last.amount), date: last.created_at } : null,
    invoices,
    unapplied,
    totals: { open_invoices, unapplied: unapplied_total, balance: round2(open_invoices - unapplied_total), aging },
  };
}

// Account statement for a period: opening balance, every document in the
// period in date order with a running balance, closing balance. Debits are
// credit-sale invoices, legacy invoices and store credit spent at the till;
// credits are payments, credit notes and write-offs, each listing the
// invoices it was applied to. Built from the documents (not account_balance),
// so it always adds up. With the end date today, the aged open items
// (customerArDetail) go with it.
async function customerStatement(executor, customerId, { start = null, end = null, today = new Date().toLocaleDateString('en-CA') } = {}) {
  const detail = await customerArDetail(executor, customerId, { all: true, today });
  if (!detail) return null;
  const stmtEnd = end || today;
  const docs = [];
  for (const inv of detail.invoices) {
    if (inv.kind === 'store_credit') {
      docs.push({ date: inv.date, type: 'S', number: inv.number, description: 'Store credit used', reference: null, debit: inv.amount, credit: 0 });
    } else {
      docs.push({ date: inv.date, type: 'T', number: inv.number, description: inv.kind === 'legacy' ? 'Invoice (old system)' : 'Invoice',
        reference: inv.reference, due_date: inv.due_date, debit: inv.amount, credit: 0 });
    }
  }
  // Every credit document with the invoices it went against.
  const { rows: credits } = await executor.execute({
    sql: `SELECT ap.id, ap.payment_number, ap.payment_method, ap.reference, ap.created_at, ap.amount,
            (SELECT GROUP_CONCAT(t.transaction_number || ' ' || printf('%.2f', pa.amount), ', ') FROM payment_allocations pa JOIN transactions t ON t.id = pa.transaction_id WHERE pa.payment_id = ap.id) AS sales,
            (SELECT GROUP_CONCAT(li.invoice_number || ' ' || printf('%.2f', lia.amount), ', ') FROM legacy_invoice_allocations lia JOIN ar_legacy_invoices li ON li.id = lia.legacy_invoice_id WHERE lia.payment_id = ap.id) AS legacy
          FROM account_payments ap WHERE ap.customer_id = ? ORDER BY ap.created_at, ap.id`,
    args: [customerId],
  });
  const label = { writeoff: 'Write-off', credit_note: 'Credit note' };
  for (const c of credits) {
    const applied = [c.legacy, c.sales].filter(Boolean).join(', ');
    docs.push({ date: String(c.created_at).slice(0, 10), type: c.payment_method === 'writeoff' ? 'W' : c.payment_method === 'credit_note' ? 'C' : 'P',
      number: c.payment_number, description: label[c.payment_method] || `Payment — ${String(c.payment_method || '').replace(/_/g, ' ')}`,
      reference: c.reference || null, applied_to: applied || null, debit: 0, credit: round2(c.amount) });
  }
  docs.sort((a, b) => a.date.localeCompare(b.date) || (b.debit - a.debit) || a.number.localeCompare(b.number));
  const net = d => d.debit - d.credit;
  const opening = round2(docs.filter(d => start && d.date < start).reduce((s, d) => s + net(d), 0));
  let running = opening;
  const lines = docs.filter(d => (!start || d.date >= start) && d.date <= stmtEnd).map(d => ({ ...d, balance: (running = round2(running + net(d))) }));
  return {
    customer: detail.customer,
    last_payment: detail.last_payment,
    period: { start, end: stmtEnd },
    opening,
    lines,
    totals: { debits: round2(lines.reduce((s, d) => s + d.debit, 0)), credits: round2(lines.reduce((s, d) => s + d.credit, 0)), closing: running },
    // Aged open items only describe today, so they come with a statement to today.
    aging: stmtEnd >= today ? { as_of: today, ...detail.totals, invoices: detail.invoices.filter(i => i.kind !== 'store_credit' && i.balance_due > 0.005), unapplied_items: detail.unapplied } : null,
  };
}

module.exports = { customerArDetail, customerStatement };
