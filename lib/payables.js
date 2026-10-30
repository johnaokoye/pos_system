// Shared accounts-payable helpers — used by routes/payables.js and by PO
// receiving (routes/purchase-orders.js), which creates a bill automatically
// for each receipt when the vendor has Sync with A/P on.
const { nextNumber } = require('./nextNumber');

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

// Today as YYYY-MM-DD in the server's local time zone.
const today = () => new Date().toLocaleDateString('en-CA');

// Due date from a vendor's terms text: the first number in it is the day
// count ("Net 30", "N30", "30 days"); anything without one (COD, Prepaid,
// blank) is due on the bill date.
function dueDateFor(terms, billDate) {
  const m = String(terms || '').match(/\d+/);
  const d = new Date(`${billDate}T00:00:00`);
  d.setDate(d.getDate() + (m ? parseInt(m[0], 10) : 0));
  return d.toLocaleDateString('en-CA');
}

// SQL for a bill's paid amount — only allocations from payments that
// haven't been voided count.
const PAID_SQL = `(SELECT COALESCE(SUM(a.amount), 0) FROM ap_payment_allocations a
  JOIN ap_payments p ON p.id = a.payment_id AND p.status = 'posted' WHERE a.bill_id = b.id)`;

// SQL for a payment's amount not yet applied to any bill (alias p). Only
// advance payments (ap_payments.po_id) are ever left with some unapplied.
const UNAPPLIED_SQL = `(p.amount - (SELECT COALESCE(SUM(a.amount), 0) FROM ap_payment_allocations a WHERE a.payment_id = p.id))`;

// Whether receipts from this vendor should turn into bills automatically.
// "Not vouchered" is the vendor-level opt-out alongside Sync with A/P.
function autoBills(supplier) {
  return !!supplier && supplier.sync_ap !== 0 && supplier.voucher_default !== 'Not vouchered';
}

// tax_amount is the GCT included in amount (input tax).
async function createBill(executor, { supplier_id, vendor_invoice_number, po_id, branch_id, bill_date, due_date, amount, tax_amount, description, source = 'manual', created_by }) {
  const bill_number = await nextNumber(executor, 'ap_bills', 'bill_number', 'AP-', 6);
  const result = await executor.execute({
    sql: `INSERT INTO ap_bills (bill_number, supplier_id, vendor_invoice_number, po_id, branch_id, bill_date, due_date, amount, tax_amount, description, source, created_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [bill_number, supplier_id, vendor_invoice_number || null, po_id || null, branch_id || null, bill_date, due_date, round2(amount), round2(tax_amount), description || null, source, created_by || null],
  });
  if (po_id) await applyPoAdvances(executor, po_id);
  return Number(result.lastInsertRowid);
}

// Applies a PO's unapplied advance payments (from approved payment requests)
// to its open bills, oldest advance and oldest bill first. Runs whenever a
// bill for the PO is created and when an advance is paid, so an advance
// settles the PO's bills as they come in. Returns the amount applied.
async function applyPoAdvances(executor, poId) {
  const { rows: advances } = await executor.execute({
    sql: `SELECT p.id, ${UNAPPLIED_SQL} AS unapplied FROM ap_payments p
          WHERE p.po_id = ? AND p.status = 'posted' ORDER BY p.payment_date, p.id`,
    args: [poId],
  });
  const open = advances.map(a => ({ id: a.id, left: round2(a.unapplied) })).filter(a => a.left > 0);
  if (!open.length) return 0;
  const { rows: bills } = await executor.execute({
    sql: `SELECT b.id, b.amount - ${PAID_SQL} AS balance FROM ap_bills b
          WHERE b.po_id = ? AND b.status != 'void' ORDER BY b.bill_date, b.id`,
    args: [poId],
  });
  let applied = 0;
  for (const bill of bills) {
    let due = round2(bill.balance);
    for (const adv of open) {
      if (due <= 0) break;
      const take = round2(Math.min(due, adv.left));
      if (take <= 0) continue;
      await executor.execute({ sql: 'INSERT INTO ap_payment_allocations (payment_id, bill_id, amount) VALUES (?,?,?)', args: [adv.id, bill.id, take] });
      adv.left = round2(adv.left - take);
      due = round2(due - take);
      applied = round2(applied + take);
    }
  }
  return applied;
}

// What a PO has been received for vs. billed for so far. Received value is
// quantity received × the line's net unit cost (after vendor discount) plus
// that line's tax in proportion; billed
// excludes void bills. unbilled is what a new bill for this PO defaults to.
async function poBilling(executor, poId) {
  const { rows: [po] } = await executor.execute({ sql: 'SELECT id, currency, exchange_rate FROM purchase_orders WHERE id = ?', args: [poId] });
  if (!po) return null;
  // Bills are in base currency; a foreign-currency PO converts at its own rate
  const rate = po.currency ? Number(po.exchange_rate) || 0 : 1;
  // Each line's share of its discounted total and its own tax (lib/poLines.js).
  const { rows: [r] } = await executor.execute({
    sql: `SELECT COALESCE(SUM(CASE WHEN quantity_ordered > 0 THEN COALESCE(quantity_received, 0) * total / quantity_ordered ELSE 0 END), 0) AS goods,
                 COALESCE(SUM(CASE WHEN quantity_ordered > 0 THEN COALESCE(quantity_received, 0) * COALESCE(tax_amount, 0) / quantity_ordered ELSE 0 END), 0) AS tax
          FROM purchase_order_items WHERE po_id = ?`,
    args: [poId],
  });
  const goods = (Number(r.goods) || 0) * rate;
  const tax = (Number(r.tax) || 0) * rate;
  const { rows: [b] } = await executor.execute({
    sql: "SELECT COALESCE(SUM(amount), 0) AS v FROM ap_bills WHERE po_id = ? AND status != 'void'",
    args: [poId],
  });
  const { rows: [bt] } = await executor.execute({
    sql: "SELECT COALESCE(SUM(tax_amount), 0) AS v FROM ap_bills WHERE po_id = ? AND status != 'void'",
    args: [poId],
  });
  const received_value = round2(goods + tax);
  const billed = round2(b.v);
  const unbilled = round2(Math.max(0, received_value - billed));
  // The GCT in what's not yet billed, for a new bill's default.
  const unbilled_tax = unbilled > 0 ? round2(Math.min(unbilled, Math.max(0, tax - (Number(bt.v) || 0)))) : 0;
  return { received_value, billed, unbilled, unbilled_tax };
}

module.exports = { round2, today, dueDateFor, PAID_SQL, UNAPPLIED_SQL, autoBills, createBill, applyPoAdvances, poBilling };
