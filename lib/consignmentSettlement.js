// Consignment Phase 4 — settlement, invoice matching and the accounting feed.
//
// Settlement (CST-): made when Finance approves a month-end reconciliation —
// per item, what the supplier is owed for the month at the agreed costs
// (sales, layaways paid off, work-order parts, less returns, plus shop use
// and approved chargeable shortages/damage). Returns of earlier months'
// sales are listed as referenced adjustments (the original sale and month,
// decision A3).
//
// Invoice matching (F2): A/P enters the supplier's invoice line by line; each
// line is compared with the settlement on quantity, cost, tax and total, and
// any difference is flagged for Finance, who either corrects the settlement
// (it takes the invoice's figures) or approves the difference to Consignment
// Variance. Nothing goes to variance on its own. Once every flag is resolved,
// A/P accepts it: that raises the A/P bill (source 'consignment_settlement',
// obligation_amount = the settlement, variance_amount = what Finance
// approved), which is then paid through a payment request like any bill.
// Input GCT is only taken with a valid supplier tax invoice (F6). The
// invoice never changes stock.
//
// Postings (F1): the obligation is accrued as each sale qualifies, at the
// cost saved on the sale — queued here for RetailPOS Books with account
// roles Books maps in its Settings (F4).

const { nextNumber } = require('./nextNumber');
const { createBill, dueDateFor } = require('./payables');
const { storeOffsetModifier, storeToday } = require('./storeTime');
const { periodBounds } = require('./consignmentRecon');

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const round3 = n => Math.round((Number(n) || 0) * 1000) / 1000;
const err = (status, message) => Object.assign(new Error(message), { status });

const settlementLog = (ex, settlementId, action, employeeId, details) => ex.execute({
  sql: 'INSERT INTO consignment_settlement_log (settlement_id, action, details, employee_id) VALUES (?,?,?,?)',
  args: [settlementId, action, details ? JSON.stringify(details) : null, employeeId || null],
});

// ── Settlement ──────────────────────────────────────────────
// From an approved reconciliation; null when nothing is owed either way.
async function createSettlement(ex, reconId, employeeId) {
  const { rows: [r] } = await ex.execute({
    sql: `SELECT r.*, a.supplier_id, a.agreement_number FROM consignment_reconciliations r JOIN consignment_agreements a ON a.id = r.agreement_id WHERE r.id = ?`,
    args: [reconId],
  });
  if (!r) throw err(404, 'Reconciliation not found');
  const { rows: lines } = await ex.execute({
    sql: `SELECT l.*, COALESCE(p.tax_rate, 0) AS product_tax_rate FROM consignment_reconciliation_lines l JOIN products p ON p.id = l.product_id
          WHERE l.recon_id = ? AND l.line_type = 'stock'`,
    args: [r.id],
  });
  const byProduct = new Map();
  for (const l of lines) {
    if (!byProduct.has(l.product_id)) byProduct.set(l.product_id, {
      product_id: l.product_id, tax_rate: Number(l.product_tax_rate) || 0, sales_qty: 0, sales_value: 0, layaway_qty: 0, layaway_value: 0, work_order_qty: 0, work_order_value: 0,
      returns_qty: 0, returns_value: 0, prior_returns_qty: 0, prior_returns_value: 0, shop_use_qty: 0, shop_use_value: 0, chargeable_qty: 0, chargeable_value: 0, billable_qty: 0, billable_value: 0,
    });
    const s = byProduct.get(l.product_id);
    const add = (k, v, f = round3) => { s[k] = f(s[k] + (Number(v) || 0)); };
    add('sales_qty', l.pos_sales_qty); add('sales_value', l.pos_sales_value, round2);
    add('layaway_qty', l.layaway_qty); add('layaway_value', l.layaway_value, round2);
    add('work_order_qty', l.work_order_qty); add('work_order_value', l.work_order_value, round2);
    add('returns_qty', l.returns_qty); add('returns_value', l.returns_value, round2);
    add('prior_returns_qty', l.prior_returns_qty); add('prior_returns_value', l.prior_returns_value, round2);
    add('shop_use_qty', -Number(l.shop_use || 0)); add('shop_use_value', l.shop_use_value, round2);
    add('chargeable_qty', Number(l.approved_shortage_qty || 0) + Number(l.approved_damage_qty || 0));
    add('billable_qty', l.billable_qty); add('billable_value', l.billable_value, round2);
  }
  const items = [...byProduct.values()].filter(s => Math.abs(s.billable_qty) > 0.0005 || Math.abs(s.billable_value) >= 0.005 || s.prior_returns_qty);
  if (!items.length) return null;
  for (const s of items) {
    s.chargeable_value = round2(s.billable_value - (s.sales_value + s.layaway_value + s.work_order_value - s.returns_value - s.prior_returns_value + s.shop_use_value));
    s.expected_tax = round2(s.billable_value * s.tax_rate / 100);
  }

  // Returns this month of earlier months' sales, with what they refer to (A3).
  const { start, next } = periodBounds(r.period);
  const off = storeOffsetModifier();
  const { rows: adjustments } = await ex.execute({
    sql: `SELECT sr.id, sr.kind, sr.qty, sr.goods_condition, date(sr.created_at, '${off}') AS returned_on, ret.return_number, t.transaction_number AS sale_number,
            sa.qualified_on AS sale_qualified_on, sa.product_id, p.name AS product_name, round(sr.qty * COALESCE(sa.unit_cost, 0), 2) AS value
          FROM stock_lot_returns sr JOIN sale_lot_allocations sa ON sa.id = sr.allocation_id JOIN products p ON p.id = sa.product_id
          LEFT JOIN returns ret ON ret.id = sr.return_id LEFT JOIN transactions t ON t.id = sa.transaction_id
          WHERE sa.agreement_id = ? AND sa.owner = 'consignment' AND sa.qualified_on < ?
            AND datetime(sr.created_at, '${off}') >= ? AND datetime(sr.created_at, '${off}') < ? ORDER BY sr.id`,
    args: [r.agreement_id, start, `${start} 00:00:00`, `${next} 00:00:00`],
  });

  const subtotal = round2(items.reduce((t, s) => t + s.billable_value, 0));
  const tax = round2(items.reduce((t, s) => t + s.expected_tax, 0));
  const number = await nextNumber(ex, 'consignment_settlements', 'settlement_number', 'CST-', 6);
  const ins = await ex.execute({
    sql: `INSERT INTO consignment_settlements (settlement_number, recon_id, agreement_id, supplier_id, period, subtotal, expected_tax, total, adjustments_json, created_by)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [number, r.id, r.agreement_id, r.supplier_id, r.period, subtotal, tax, round2(subtotal + tax), JSON.stringify(adjustments), employeeId || null],
  });
  const id = Number(ins.lastInsertRowid);
  const cols = ['product_id', 'sales_qty', 'sales_value', 'layaway_qty', 'layaway_value', 'work_order_qty', 'work_order_value', 'returns_qty', 'returns_value', 'prior_returns_qty', 'prior_returns_value',
    'shop_use_qty', 'shop_use_value', 'chargeable_qty', 'chargeable_value', 'billable_qty', 'billable_value', 'tax_rate', 'expected_tax'];
  for (const s of items) {
    await ex.execute({ sql: `INSERT INTO consignment_settlement_lines (settlement_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`, args: [id, ...cols.map(c => s[c])] });
  }
  await settlementLog(ex, id, 'created', employeeId, { recon_number: r.recon_number });
  return id;
}

async function settlementTotals(ex, id) {
  const { rows: [t] } = await ex.execute({
    sql: 'SELECT COALESCE(SUM(billable_value), 0) AS v, COALESCE(SUM(expected_tax), 0) AS t FROM consignment_settlement_lines WHERE settlement_id = ?',
    args: [id],
  });
  await ex.execute({ sql: 'UPDATE consignment_settlements SET subtotal = ?, expected_tax = ?, total = ? WHERE id = ?', args: [round2(t.v), round2(t.t), round2(Number(t.v) + Number(t.t)), id] });
}

async function loadSettlement(ex, id) {
  const { rows: [s] } = await ex.execute({
    sql: `SELECT s.*, sp.name AS supplier_name, sp.supplier_number, a.agreement_number, a.payment_terms AS agreement_payment_terms, r.recon_number,
            b.bill_number, b.status AS bill_status, ce.first_name || ' ' || ce.last_name AS created_by_name
          FROM consignment_settlements s JOIN suppliers sp ON sp.id = s.supplier_id JOIN consignment_agreements a ON a.id = s.agreement_id
          JOIN consignment_reconciliations r ON r.id = s.recon_id LEFT JOIN ap_bills b ON b.id = s.bill_id LEFT JOIN employees ce ON ce.id = s.created_by WHERE s.id = ?`,
    args: [id],
  });
  if (!s) return null;
  s.adjustments = s.adjustments_json ? JSON.parse(s.adjustments_json) : [];
  delete s.adjustments_json;
  const { rows: lines } = await ex.execute({
    sql: `SELECT l.*, p.name AS product_name, p.sku, ce.first_name || ' ' || ce.last_name AS corrected_by_name FROM consignment_settlement_lines l JOIN products p ON p.id = l.product_id
          LEFT JOIN employees ce ON ce.id = l.corrected_by WHERE l.settlement_id = ? ORDER BY p.name`,
    args: [s.id],
  });
  s.lines = lines.map(l => ({ ...l, unit_cost: Math.abs(l.billable_qty) > 0.0005 ? round2(l.billable_value / l.billable_qty) : null }));
  const { rows: invoices } = await ex.execute({
    sql: `SELECT i.*, ee.first_name || ' ' || ee.last_name AS entered_by_name, ae.first_name || ' ' || ae.last_name AS accepted_by_name, b.bill_number
          FROM consignment_invoices i LEFT JOIN employees ee ON ee.id = i.entered_by LEFT JOIN employees ae ON ae.id = i.accepted_by LEFT JOIN ap_bills b ON b.id = i.bill_id
          WHERE i.settlement_id = ? ORDER BY i.id DESC`,
    args: [s.id],
  });
  for (const inv of invoices) {
    const { rows } = await ex.execute({
      sql: `SELECT l.*, p.name AS product_name, re.first_name || ' ' || re.last_name AS resolved_by_name FROM consignment_invoice_lines l JOIN products p ON p.id = l.product_id
            LEFT JOIN employees re ON re.id = l.resolved_by WHERE l.invoice_id = ? ORDER BY p.name`,
      args: [inv.id],
    });
    inv.lines = rows;
  }
  s.invoice = invoices.find(i => i.status !== 'rejected') || null;
  s.rejected_invoices = invoices.filter(i => i.status === 'rejected');
  const { rows: credits } = await ex.execute({
    sql: `SELECT id, payment_number, reference, payment_date, amount, tax_amount, status FROM ap_payments WHERE consignment_settlement_id = ? AND method = 'credit_note' ORDER BY id`,
    args: [s.id],
  });
  s.credit_notes = credits;
  const { rows: log } = await ex.execute({
    sql: `SELECT g.*, e.first_name || ' ' || e.last_name AS employee_name FROM consignment_settlement_log g LEFT JOIN employees e ON e.id = g.employee_id WHERE g.settlement_id = ? ORDER BY g.id`,
    args: [s.id],
  });
  s.log = log.map(g => ({ ...g, details: g.details ? JSON.parse(g.details) : null }));
  return s;
}

// ── Invoice matching ────────────────────────────────────────
const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// Works out each line's differences against the settlement as it stands.
function matchLine(il, sl) {
  const sQty = round3(sl?.billable_qty || 0), sVal = round2(sl?.billable_value || 0), sTax = round2(sl?.expected_tax || 0);
  const sUnit = Math.abs(sQty) > 0.0005 ? sVal / sQty : null;
  const qtyDiff = round3(il.qty - sQty);
  const valueDiff = round2(il.amount - sVal);
  const taxDiff = round2(il.tax_amount - sTax);
  const costDiff = sUnit != null && Math.abs(il.qty) > 0.0005 ? round2(il.unit_cost - sUnit) : 0;
  return {
    settlement_qty: sQty, settlement_value: sVal, settlement_tax: sTax, qty_diff: qtyDiff, value_diff: valueDiff, tax_diff: taxDiff, cost_diff: costDiff,
    flagged: Math.abs(qtyDiff) > 0.0005 || Math.abs(valueDiff) >= 0.01 || Math.abs(taxDiff) >= 0.01 || Math.abs(costDiff) >= 0.01 ? 1 : 0,
  };
}

async function liveSettlement(ex, id) {
  const { rows: [s] } = await ex.execute({ sql: 'SELECT * FROM consignment_settlements WHERE id = ?', args: [id] });
  if (!s) throw err(404, 'Settlement not found');
  if (s.status === 'cancelled') throw err(400, `${s.settlement_number} was cancelled when its month was reopened`);
  return s;
}

// { supplier_invoice_number, invoice_date, supplier_trn, tax_invoice, notes,
//   lines: [{ product_id, qty, unit_cost, tax_amount }] }
async function enterInvoice(ex, settlementId, body, employeeId) {
  const s = await liveSettlement(ex, settlementId);
  if (s.status !== 'open') throw err(400, `${s.settlement_number} already has the supplier's invoice entered — reject that one first to enter another`);
  const number = String(body.supplier_invoice_number || '').trim();
  if (!number) throw err(400, "Enter the supplier's invoice number");
  if (!isDay(body.invoice_date)) throw err(400, 'Enter the invoice date');
  const { rows: [dupBill] } = await ex.execute({
    sql: "SELECT bill_number FROM ap_bills WHERE supplier_id = ? AND status != 'void' AND lower(trim(vendor_invoice_number)) = lower(?)",
    args: [s.supplier_id, number],
  });
  if (dupBill) throw err(400, `Invoice ${number} from this supplier is already on bill ${dupBill.bill_number}`);
  const { rows: [dupInv] } = await ex.execute({
    sql: `SELECT cs.settlement_number FROM consignment_invoices i JOIN consignment_settlements cs ON cs.id = i.settlement_id
          WHERE cs.supplier_id = ? AND i.status != 'rejected' AND lower(trim(i.supplier_invoice_number)) = lower(?)`,
    args: [s.supplier_id, number],
  });
  if (dupInv) throw err(400, `Invoice ${number} from this supplier is already entered against ${dupInv.settlement_number}`);

  const { rows: sLines } = await ex.execute({ sql: 'SELECT * FROM consignment_settlement_lines WHERE settlement_id = ?', args: [s.id] });
  const { rows: agreementItems } = await ex.execute({ sql: 'SELECT product_id FROM consignment_agreement_items WHERE agreement_id = ?', args: [s.agreement_id] });
  const allowed = new Set([...agreementItems.map(i => Number(i.product_id)), ...sLines.map(l => Number(l.product_id))]);
  const entered = new Map();
  for (const raw of Array.isArray(body.lines) ? body.lines : []) {
    const pid = Number(raw.product_id);
    const qty = round3(raw.qty);
    const unit = round2(raw.unit_cost);
    const tax = round2(raw.tax_amount);
    if (!pid) continue;
    if (!allowed.has(pid)) throw err(400, "An invoice line is for an item that isn't on this agreement");
    if (entered.has(pid)) throw err(400, 'Enter each item once');
    if (!Number.isFinite(qty) || !Number.isFinite(unit) || unit < 0 || !Number.isFinite(tax)) throw err(400, 'Check the quantities, costs and GCT');
    entered.set(pid, { product_id: pid, qty, unit_cost: unit, amount: round2(qty * unit), tax_amount: tax });
  }
  if (!entered.size) throw err(400, "Enter the invoice's lines");
  // Settlement items the supplier didn't invoice show as a difference too.
  for (const l of sLines) if (!entered.has(Number(l.product_id))) entered.set(Number(l.product_id), { product_id: Number(l.product_id), qty: 0, unit_cost: 0, amount: 0, tax_amount: 0 });
  const bySettlement = new Map(sLines.map(l => [Number(l.product_id), l]));
  const lines = [...entered.values()].map(il => ({ ...il, ...matchLine(il, bySettlement.get(il.product_id)) }));
  const subtotal = round2(lines.reduce((t, l) => t + l.amount, 0));
  const tax = round2(lines.reduce((t, l) => t + l.tax_amount, 0));
  const flagged = lines.some(l => l.flagged);
  const status = flagged ? 'in_review' : 'matched';
  const ins = await ex.execute({
    sql: `INSERT INTO consignment_invoices (settlement_id, supplier_invoice_number, invoice_date, supplier_trn, tax_invoice, subtotal, tax_amount, total, status, notes, entered_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [s.id, number, body.invoice_date, String(body.supplier_trn || '').trim() || null, body.tax_invoice ? 1 : 0, subtotal, tax, round2(subtotal + tax), status, String(body.notes || '').trim() || null, employeeId || null],
  });
  const invoiceId = Number(ins.lastInsertRowid);
  const cols = ['product_id', 'qty', 'unit_cost', 'amount', 'tax_amount', 'settlement_qty', 'settlement_value', 'settlement_tax', 'qty_diff', 'cost_diff', 'value_diff', 'tax_diff', 'flagged'];
  for (const l of lines) {
    await ex.execute({ sql: `INSERT INTO consignment_invoice_lines (invoice_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`, args: [invoiceId, ...cols.map(c => l[c])] });
  }
  await ex.execute({ sql: 'UPDATE consignment_settlements SET status = ? WHERE id = ?', args: [status, s.id] });
  await settlementLog(ex, s.id, 'invoice_entered', employeeId, { invoice: number, total: round2(subtotal + tax), differences: lines.filter(l => l.flagged).length });
  return invoiceId;
}

async function activeInvoice(ex, settlementId) {
  const s = await liveSettlement(ex, settlementId);
  const { rows: [inv] } = await ex.execute({ sql: "SELECT * FROM consignment_invoices WHERE settlement_id = ? AND status != 'rejected' ORDER BY id DESC LIMIT 1", args: [s.id] });
  if (!inv) throw err(400, `No supplier invoice is entered against ${s.settlement_number}`);
  return { s, inv };
}

// Finance: { resolution: 'corrected' | 'variance', reason }.
async function resolveLine(ex, settlementId, lineId, body, employeeId) {
  const { s, inv } = await activeInvoice(ex, settlementId);
  if (inv.status !== 'in_review') throw err(400, 'This invoice has no differences waiting for Finance');
  const { rows: [l] } = await ex.execute({ sql: 'SELECT * FROM consignment_invoice_lines WHERE id = ? AND invoice_id = ?', args: [lineId, inv.id] });
  if (!l) throw err(404, 'Invoice line not found');
  if (!l.flagged) throw err(400, 'That line matches the settlement');
  if (l.resolution) throw err(400, 'That difference has already been resolved');
  const resolution = body.resolution;
  const reason = String(body.reason || '').trim();
  if (!['corrected', 'variance'].includes(resolution)) throw err(400, 'Choose: correct the settlement, or approve the difference to Consignment Variance');
  if (!reason) throw err(400, 'Give the reason');
  if (resolution === 'corrected') {
    // The settlement was wrong: its line takes the invoice's figures.
    const { rows: [sl] } = await ex.execute({ sql: 'SELECT * FROM consignment_settlement_lines WHERE settlement_id = ? AND product_id = ?', args: [s.id, l.product_id] });
    if (sl) {
      await ex.execute({
        sql: `UPDATE consignment_settlement_lines SET original_qty = COALESCE(original_qty, billable_qty), original_value = COALESCE(original_value, billable_value), original_tax = COALESCE(original_tax, expected_tax),
                billable_qty = ?, billable_value = ?, expected_tax = ?, corrected_by = ?, corrected_at = CURRENT_TIMESTAMP, correction_reason = ? WHERE id = ?`,
        args: [l.qty, l.amount, l.tax_amount, employeeId || null, reason, sl.id],
      });
    } else {
      await ex.execute({
        sql: `INSERT INTO consignment_settlement_lines (settlement_id, product_id, billable_qty, billable_value, expected_tax, original_qty, original_value, original_tax, corrected_by, corrected_at, correction_reason)
              VALUES (?,?,?,?,?,0,0,0,?,CURRENT_TIMESTAMP,?)`,
        args: [s.id, l.product_id, l.qty, l.amount, l.tax_amount, employeeId || null, reason],
      });
    }
    await settlementTotals(ex, s.id);
    await ex.execute({ sql: 'UPDATE consignment_invoice_lines SET settlement_qty = qty, settlement_value = amount, settlement_tax = tax_amount WHERE id = ?', args: [l.id] });
  }
  await ex.execute({
    sql: 'UPDATE consignment_invoice_lines SET resolution = ?, resolution_reason = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?',
    args: [resolution, reason, employeeId || null, l.id],
  });
  await settlementLog(ex, s.id, resolution === 'corrected' ? 'settlement_corrected' : 'variance_approved', employeeId, {
    line_id: l.id, product_id: l.product_id, qty_diff: l.qty_diff, value_diff: l.value_diff, tax_diff: l.tax_diff, reason,
  });
  const { rows: [open] } = await ex.execute({ sql: 'SELECT COUNT(*) AS n FROM consignment_invoice_lines WHERE invoice_id = ? AND flagged = 1 AND resolution IS NULL', args: [inv.id] });
  const { rows: [v] } = await ex.execute({ sql: "SELECT COALESCE(SUM(value_diff), 0) AS v FROM consignment_invoice_lines WHERE invoice_id = ? AND resolution = 'variance'", args: [inv.id] });
  const done = Number(open.n) === 0;
  await ex.execute({ sql: 'UPDATE consignment_invoices SET variance_amount = ?, status = ? WHERE id = ?', args: [round2(v.v), done ? 'matched' : 'in_review', inv.id] });
  if (done) await ex.execute({ sql: "UPDATE consignment_settlements SET status = 'matched' WHERE id = ?", args: [s.id] });
}

// A/P: the matched invoice becomes the A/P bill.
async function acceptInvoice(ex, settlementId, employeeId) {
  const { s, inv } = await activeInvoice(ex, settlementId);
  if (inv.status === 'accepted') {
    const { rows: [b] } = await ex.execute({ sql: 'SELECT bill_number FROM ap_bills WHERE id = ?', args: [inv.bill_id] });
    throw err(400, `Already accepted — it's A/P bill ${b?.bill_number || inv.bill_id}`);
  }
  if (inv.status !== 'matched') throw err(400, 'Finance has to resolve the differences first');
  if (!(inv.total > 0)) throw err(400, "Nothing to bill — the supplier owes Total Tools for this month; record their credit note in Payables instead");
  if (inv.tax_amount > 0.004 && !(inv.tax_invoice && inv.supplier_trn)) throw err(400, "The invoice charges GCT: input GCT can only be taken with a valid supplier tax invoice — tick it and enter the supplier's TRN, or reject the invoice");
  const { rows: [now] } = await ex.execute({ sql: 'SELECT subtotal FROM consignment_settlements WHERE id = ?', args: [s.id] });
  const obligation = round2(now.subtotal);
  const variance = round2(inv.variance_amount);
  if (Math.abs(round2(obligation + variance) - round2(inv.subtotal)) >= 0.01) throw err(400, "The invoice doesn't add up to the settlement plus the approved variance — reject it and enter it again");
  const { rows: [a] } = await ex.execute({
    sql: 'SELECT a.agreement_number, a.payment_terms, sp.payment_terms AS supplier_terms FROM consignment_agreements a JOIN suppliers sp ON sp.id = a.supplier_id WHERE a.id = ?',
    args: [s.agreement_id],
  });
  const billId = await createBill(ex, {
    supplier_id: s.supplier_id,
    vendor_invoice_number: inv.supplier_invoice_number,
    bill_date: inv.invoice_date,
    due_date: dueDateFor(a.payment_terms || a.supplier_terms, inv.invoice_date),
    amount: inv.total,
    tax_amount: inv.tax_amount,
    description: `Consignment settlement ${s.settlement_number} — ${a.agreement_number}, ${s.period}`,
    source: 'consignment_settlement',
    created_by: employeeId,
  });
  await ex.execute({ sql: 'UPDATE ap_bills SET consignment_settlement_id = ?, obligation_amount = ?, variance_amount = ? WHERE id = ?', args: [s.id, obligation, variance, billId] });
  await ex.execute({ sql: "UPDATE consignment_invoices SET status = 'accepted', accepted_by = ?, accepted_at = CURRENT_TIMESTAMP, bill_id = ? WHERE id = ?", args: [employeeId || null, billId, inv.id] });
  await ex.execute({ sql: "UPDATE consignment_settlements SET status = 'billed', bill_id = ? WHERE id = ?", args: [billId, s.id] });
  await settlementLog(ex, s.id, 'bill_created', employeeId, { bill_id: billId, invoice: inv.supplier_invoice_number, obligation, variance, tax: inv.tax_amount });
  return billId;
}

async function rejectInvoice(ex, settlementId, reason, employeeId) {
  const { s, inv } = await activeInvoice(ex, settlementId);
  if (inv.status === 'accepted') throw err(400, 'The invoice is already on an A/P bill — void the bill first');
  if (!String(reason || '').trim()) throw err(400, 'Give the reason');
  await ex.execute({ sql: "UPDATE consignment_invoices SET status = 'rejected', rejected_by = ?, rejected_at = CURRENT_TIMESTAMP, reject_reason = ? WHERE id = ?", args: [employeeId || null, String(reason).trim(), inv.id] });
  await ex.execute({ sql: "UPDATE consignment_settlements SET status = 'open' WHERE id = ?", args: [s.id] });
  await settlementLog(ex, s.id, 'invoice_rejected', employeeId, { invoice: inv.supplier_invoice_number, reason: String(reason).trim() });
}

// A settlement bill voided in Payables: the invoice goes back to matched,
// ready to be accepted again (or rejected).
async function afterBillVoid(ex, bill, employeeId) {
  if (!bill.consignment_settlement_id) return;
  await ex.execute({ sql: "UPDATE consignment_invoices SET status = 'matched', bill_id = NULL, accepted_by = NULL, accepted_at = NULL WHERE bill_id = ?", args: [bill.id] });
  await ex.execute({ sql: "UPDATE consignment_settlements SET status = 'matched', bill_id = NULL WHERE id = ? AND bill_id = ?", args: [bill.consignment_settlement_id, bill.id] });
  await settlementLog(ex, bill.consignment_settlement_id, 'bill_voided', employeeId, { bill_number: bill.bill_number });
}

// Reopening a month: refused while its settlement is on a live bill;
// otherwise the settlement (and any invoice entered) is cancelled — a new one
// is made when the month is approved again.
async function cancelForReopen(ex, reconId, reason, employeeId) {
  const { rows } = await ex.execute({ sql: "SELECT * FROM consignment_settlements WHERE recon_id = ? AND status != 'cancelled'", args: [reconId] });
  for (const s of rows) {
    if (s.bill_id) {
      const { rows: [b] } = await ex.execute({ sql: 'SELECT bill_number, status FROM ap_bills WHERE id = ?', args: [s.bill_id] });
      if (b && b.status !== 'void') throw err(400, `${s.settlement_number} is on A/P bill ${b.bill_number} — void that bill in Payables before reopening the month`);
    }
    await ex.execute({ sql: "UPDATE consignment_invoices SET status = 'rejected', reject_reason = 'Month reopened', rejected_by = ?, rejected_at = CURRENT_TIMESTAMP WHERE settlement_id = ? AND status != 'rejected'", args: [employeeId || null, s.id] });
    await ex.execute({ sql: "UPDATE consignment_settlements SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, cancel_reason = ? WHERE id = ?", args: [reason, s.id] });
    await settlementLog(ex, s.id, 'cancelled', employeeId, { reason });
  }
}

// ── Accounting feed for RetailPOS Books ─────────────────────
// Roles Books maps to accounts in its Settings (F4); 'inventory' uses the
// posting's inventory_account_code.
const ROLES = ['cost_of_sales', 'obligation', 'variance', 'chargeable', 'inventory'];

// Queues the accrual for every qualifying supplier-owned sale, paid-off
// layaway and work-order issue, and its reversal for every return/void —
// once each (source_key). Safe to run any time.
async function queueAccruals(ex) {
  const off = storeOffsetModifier();
  const accrual = (table, prefix, qtyExpr, refSql, joins) => ex.execute({
    sql: `INSERT OR IGNORE INTO consignment_postings (source_key, source_type, source_id, agreement_id, supplier_id, product_id, posting_date, debit_role, credit_role, amount, reference, memo)
          SELECT '${prefix}:' || x.id, '${prefix}', x.id, x.agreement_id, x.supplier_id, x.product_id, x.qualified_on, 'cost_of_sales', 'obligation',
                 round(${qtyExpr} * x.unit_cost, 2), ${refSql}, p.name
          FROM ${table} x JOIN products p ON p.id = x.product_id ${joins}
          WHERE x.owner = 'consignment' AND x.qualified_on IS NOT NULL AND x.unit_cost > 0 AND round(${qtyExpr} * x.unit_cost, 2) > 0`,
    args: [],
  });
  await accrual('sale_lot_allocations', 'sale', 'x.qty', 't.transaction_number', 'LEFT JOIN transactions t ON t.id = x.transaction_id');
  await accrual('layaway_lot_allocations', 'layaway', '(x.qty - x.released_qty)', 'lp.plan_number', 'LEFT JOIN layaway_plans lp ON lp.id = x.plan_id');
  await accrual('work_order_lot_allocations', 'wo', 'x.qty', 'w.wo_number', 'LEFT JOIN work_orders w ON w.id = x.work_order_id');
  await ex.execute({
    sql: `INSERT OR IGNORE INTO consignment_postings (source_key, source_type, source_id, agreement_id, supplier_id, product_id, posting_date, debit_role, credit_role, amount, reference, memo)
          SELECT 'return:' || r.id, 'return', r.id, sa.agreement_id, sa.supplier_id, sa.product_id, date(r.created_at, '${off}'), 'obligation', 'cost_of_sales',
                 round(r.qty * sa.unit_cost, 2), COALESCE(ret.return_number, t.transaction_number), p.name || ' (' || r.kind || ' of ' || COALESCE(t.transaction_number, '') || ')'
          FROM stock_lot_returns r JOIN sale_lot_allocations sa ON sa.id = r.allocation_id JOIN products p ON p.id = sa.product_id
          LEFT JOIN returns ret ON ret.id = r.return_id LEFT JOIN transactions t ON t.id = sa.transaction_id
          WHERE sa.owner = 'consignment' AND sa.qualified_on IS NOT NULL AND sa.unit_cost > 0 AND round(r.qty * sa.unit_cost, 2) > 0`,
    args: [],
  });
}

// At month-end approval: approved chargeable shortages/damage and shop use,
// against the obligation, dated the last day of the month.
async function queueReconPostings(ex, reconId, logId) {
  const { rows: [r] } = await ex.execute({
    sql: 'SELECT r.*, a.supplier_id FROM consignment_reconciliations r JOIN consignment_agreements a ON a.id = r.agreement_id WHERE r.id = ?',
    args: [reconId],
  });
  const { rows: [t] } = await ex.execute({
    sql: `SELECT COALESCE(SUM((approved_shortage_qty + approved_damage_qty) * COALESCE(unit_cost_end, 0)), 0) AS chargeable, COALESCE(SUM(shop_use_value), 0) AS shop_use
          FROM consignment_reconciliation_lines WHERE recon_id = ? AND line_type = 'stock'`,
    args: [reconId],
  });
  const { rows: [inv] } = await ex.execute({ sql: "SELECT value FROM settings WHERE key = 'shop_use_inventory_account'", args: [] });
  const day = periodBounds(r.period).last;
  const add = (kind, debit, amount, memo, invCode = null) => amount > 0.004 && ex.execute({
    sql: `INSERT OR IGNORE INTO consignment_postings (source_key, source_type, source_id, recon_id, agreement_id, supplier_id, posting_date, debit_role, credit_role, inventory_account_code, amount, reference, memo)
          VALUES (?,?,?,?,?,?,?,?,'obligation',?,?,?,?)`,
    args: [`${kind}:${reconId}:${logId}`, kind, reconId, reconId, r.agreement_id, r.supplier_id, day, debit, invCode, round2(amount), r.recon_number, memo],
  });
  await add('recon_chargeable', 'chargeable', Number(t.chargeable), `Shortages and damage chargeable to Total Tools, ${r.period}`);
  await add('recon_shop_use', 'inventory', Number(t.shop_use), `Supplier stock used in the shop, ${r.period}`, inv?.value || '1300');
}

// Reopening: each month-end entry not yet reversed gets its reversal.
async function reverseReconPostings(ex, reconId) {
  const { rows } = await ex.execute({ sql: 'SELECT * FROM consignment_postings WHERE recon_id = ? AND reverses_id IS NULL AND reversed = 0', args: [reconId] });
  for (const p of rows) {
    await ex.execute({
      sql: `INSERT OR IGNORE INTO consignment_postings (source_key, source_type, source_id, recon_id, agreement_id, supplier_id, posting_date, debit_role, credit_role, inventory_account_code, amount, reference, memo, reverses_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [`reverse:${p.id}`, 'reversal', p.id, reconId, p.agreement_id, p.supplier_id, storeToday(), p.credit_role, p.debit_role, p.inventory_account_code, p.amount, p.reference, `Reversal (month reopened): ${p.memo || ''}`, p.id],
    });
    await ex.execute({ sql: 'UPDATE consignment_postings SET reversed = 1 WHERE id = ?', args: [p.id] });
  }
}

module.exports = {
  createSettlement, loadSettlement, enterInvoice, resolveLine, acceptInvoice, rejectInvoice, afterBillVoid, cancelForReopen,
  queueAccruals, queueReconPostings, reverseReconPostings, ROLES,
};
